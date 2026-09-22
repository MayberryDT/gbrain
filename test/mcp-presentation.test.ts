import { describe, expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import { ALWAYS_INCLUDED_STARTER_OPS, STARTER_OPS, resolveDefaultClientSurfaceDetailed } from '../src/mcp/surface.ts';
import {
  classifyCompactRequest,
  compactAdvertisedNames,
  compactDiscoveryResponse,
  compactInstructions,
  projectAdvertisedTools,
  resolvePresentation,
  __resetPresentationCacheForTests,
  schemaFingerprint,
  operationDescriptor,
  EXECUTE_TOOL_NAME,
} from '../src/mcp/presentation.ts';
import { buildExecutePolicy, parseExecuteToolArgs, planCompactCall } from '../src/mcp/execute-tool.ts';
import { resolveMcpInstructions } from '../src/mcp/instructions.ts';
import { estimateTokens } from '../src/core/chunkers/token-estimate.ts';

function engineWith(values: Record<string, string | null>, fail = false) {
  return {
    async getConfig(key: string) {
      if (fail) throw new Error('db down');
      return values[key] ?? null;
    },
  };
}

describe('compact presentation', () => {
  test('legacy list does not gain execute_tool and compact full is core plus facade', () => {
    const eligible = operations.filter(op => !op.localOnly);
    const legacy = projectAdvertisedTools(eligible, { presentation: 'legacy', surface: 'full', strictParams: false });
    expect(legacy.some(tool => tool.name === EXECUTE_TOOL_NAME)).toBe(false);
    expect(legacy.length).toBe(eligible.length);

    const compact = projectAdvertisedTools(eligible, { presentation: 'compact', surface: 'full', strictParams: true });
    const names = compact.map(tool => tool.name).sort();
    const expected = [...ALWAYS_INCLUDED_STARTER_OPS, EXECUTE_TOOL_NAME].sort();
    expect(names).toEqual(expected);
    expect(compact.length).toBe(13);
    expect(compact.find(tool => tool.name === EXECUTE_TOOL_NAME)?.annotations?.readOnlyHint).toBe(false);
    const facade = compact.find(tool => tool.name === EXECUTE_TOOL_NAME);
    expect(JSON.stringify(facade)).not.toContain('get_page');
  });

  test('verbs stays the frozen verb subset and does not gain the facade', () => {
    const verbs = operations.filter(op => op.verb === true);
    const names = compactAdvertisedNames({ surface: 'verbs', eligibleOps: operations });
    expect(names.sort()).toEqual(verbs.map(op => op.name).sort());
    expect(names.includes(EXECUTE_TOOL_NAME)).toBe(false);
    expect(names.includes('request_tools')).toBe(false);
  });

  test('empty compact discovery stays an orientation, not a catalog', () => {
    const visible = operations.filter(op => !op.localOnly);
    const orientation = compactDiscoveryResponse({
      kind: 'orientation',
      visible,
      effective: 'full',
      ceiling: 'full',
      canSelfPersist: true,
      strictParams: false,
    });
    expect(orientation.mode).toBe('orientation');
    expect(orientation).not.toHaveProperty('matches');
    expect(JSON.stringify(orientation)).not.toContain('get_page');
    const tokens = estimateTokens(JSON.stringify(orientation));
    expect(tokens).toBeLessThan(1200);
  });

  test('search finds an advanced operation and paginates without leaking hidden names', () => {
    const visible = operations.filter(op => !op.localOnly);
    const advanced = visible.find(op => !STARTER_OPS.has(op.name));
    expect(advanced).toBeTruthy();
    const page = compactDiscoveryResponse({
      kind: 'search',
      visible,
      effective: 'starter',
      ceiling: 'full',
      canSelfPersist: true,
      strictParams: false,
      query: advanced!.name,
      area: '',
      limit: 6,
    }) as { matches: Array<{ name: string; availability: { status: string; surface?: string } }> };
    expect(page.matches[0]?.name).toBe(advanced!.name);
    expect(page.matches[0]?.availability).toEqual({ status: 'requires_surface', surface: 'full' });
    expect(page.matches.some(hit => hit.name === 'remember')).toBe(false);

    const hidden = compactDiscoveryResponse({
      kind: 'descriptors',
      visible: visible.filter(op => op.name !== 'get_page'),
      effective: 'full',
      ceiling: 'full',
      canSelfPersist: false,
      strictParams: true,
      tools: ['get_page', 'not_a_tool'],
    }) as { tools: unknown[] };
    expect(hidden.tools).toEqual([]);
  });

  test('descriptor hash matches the canonical tool def and mixed modes are rejected', () => {
    const op = operations.find(item => item.name === 'get_page');
    expect(op).toBeTruthy();
    const descriptor = operationDescriptor(op!, true);
    expect(descriptor.schema_hash).toBe(schemaFingerprint({
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      ...(descriptor.annotations ? { annotations: descriptor.annotations } : {}),
    }));
    expect(classifyCompactRequest({ surface: 'full', query: 'jobs' }).mode).toBe('invalid');
    expect(classifyCompactRequest({}).mode).toBe('orientation');
  });

  test('facade forwards an authorized advanced read and rejects core, stale hash, and nested dry-run', () => {
    const eligible = (op: { name: string }) => op.name === 'get_page' || ALWAYS_INCLUDED_STARTER_OPS.has(op.name);
    const policy = buildExecutePolicy({
      operations,
      surface: 'full',
      ceiling: 'full',
      eligible: op => eligible(op),
      canSelfPersist: false,
      strictParams: true,
    });
    const advertised = new Set(compactAdvertisedNames({
      surface: 'full',
      eligibleOps: operations.filter(op => eligible(op)),
    }));
    const forwarded = planCompactCall({
      presentation: 'compact',
      requestedName: EXECUTE_TOOL_NAME,
      requestedParams: { name: 'get_page', arguments: { slug: 'fixture' } },
      advertised,
      policy,
    });
    expect(forwarded).toEqual({ action: 'forward', name: 'get_page', params: { slug: 'fixture' } });

    const core = planCompactCall({
      presentation: 'compact',
      requestedName: EXECUTE_TOOL_NAME,
      requestedParams: { name: 'remember', arguments: {} },
      advertised,
      policy,
    });
    expect(core.action).toBe('result');

    const stale = planCompactCall({
      presentation: 'compact',
      requestedName: EXECUTE_TOOL_NAME,
      requestedParams: { name: 'get_page', arguments: { slug: 'fixture' }, schema_hash: 'deadbeefdeadbeef' },
      advertised,
      policy,
    });
    expect(stale.action).toBe('result');
    if (stale.action === 'result') expect(stale.result.isError).toBe(true);

    const conflict = parseExecuteToolArgs({ name: 'get_page', arguments: { dry_run: false }, dry_run: true });
    expect(conflict.ok).toBe(false);

    const denied = planCompactCall({
      presentation: 'compact',
      requestedName: 'get_page',
      requestedParams: {},
      advertised,
      policy,
    });
    expect(denied.action).toBe('deny');
  });

  test('presentation unset stays legacy and a failed read does not restore the large catalog', async () => {
    __resetPresentationCacheForTests();
    const unset = await resolvePresentation({ engine: engineWith({}), config: null });
    expect(unset).toMatchObject({ status: 'unset', value: 'legacy', degraded: false });

    __resetPresentationCacheForTests();
    const down = await resolvePresentation({ engine: engineWith({}, true), config: null, warn: () => {} });
    expect(down.value).toBe('compact');
    expect(down.degraded).toBe(true);

    __resetPresentationCacheForTests();
    const opted = await resolvePresentation({
      engine: engineWith({ 'mcp.presentation_clients': JSON.stringify({ 'omp-client': 'compact' }) }),
      config: null,
      clientId: 'omp-client',
    });
    expect(opted).toMatchObject({ status: 'valid', value: 'compact', provenance: 'client_override' });
    const other = await resolvePresentation({
      engine: engineWith({ 'mcp.presentation_clients': JSON.stringify({ 'omp-client': 'compact' }) }),
      config: null,
      clientId: 'other-client',
    });
    expect(other.value).toBe('legacy');
  });

  test('surface default failures are not treated as unset', async () => {
    const invalid = await resolveDefaultClientSurfaceDetailed(engineWith({
      'mcp.default_surface_dcr': 'nope',
    }), { mcp: { default_surface_dcr: 'starter' } } as never);
    expect(invalid.status).toBe('invalid');
    expect(invalid.value).toBe('starter');

    const down = await resolveDefaultClientSurfaceDetailed(engineWith({}, true), null);
    expect(down.status).toBe('unavailable');
    expect(down.value).toBeNull();

    const unset = await resolveDefaultClientSurfaceDetailed(engineWith({}), null);
    expect(unset.status).toBe('unset');
  });

  test('compact instructions stay under the proxy budget and legacy text is unchanged', () => {
    const compact = resolveMcpInstructions(null, {}, { presentation: 'compact' });
    expect(compact).toBe(compactInstructions());
    expect(estimateTokens(compact)).toBeLessThanOrEqual(600);
    expect(compact).not.toContain('get_page');
    const legacy = resolveMcpInstructions(null, {});
    expect(legacy).not.toContain('execute_tool');
  });
});
