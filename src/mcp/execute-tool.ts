/**
 * Compact advanced-operation facade.
 *
 * Not an Operation and not inserted into the legacy catalog. The transport
 * supplies `dispatch`, which must be the same authorize-and-dispatch path a
 * direct call uses — including the target's scope check. This module never
 * calls `operation.handler`.
 */
import type { Operation } from '../core/operations.ts';
import type { ToolResult } from './dispatch.ts';
import {
  EXECUTE_TOOL_NAME,
  availabilityFor,
  compactCoreNames,
  isCompactControlName,
  operationDescriptor,
} from './presentation.ts';
import { filterOpsForSurface, type McpSurface } from './surface.ts';

const FACADE_KEYS = new Set(['name', 'arguments', 'schema_hash', '_meta', 'dry_run']);
const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface ExecuteToolRequest {
  name: string;
  arguments: Record<string, unknown>;
  schemaHash?: string;
  dryRun?: boolean;
  meta?: Record<string, unknown>;
}

export type FacadeErrorCode =
  | 'invalid_params'
  | 'operation_unavailable'
  | 'use_core_tool'
  | 'surface_required'
  | 'schema_changed'
  | 'dry_run_conflict';

export function facadeError(code: FacadeErrorCode, message: string, extra?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: code, message, ...extra }) }],
    isError: true,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate facade arguments before any target lookup. Does not echo hidden schemas. */
export function parseExecuteToolArgs(raw: unknown): { ok: true; request: ExecuteToolRequest } | { ok: false; result: ToolResult } {
  if (!isPlainObject(raw)) {
    return { ok: false, result: facadeError('invalid_params', 'execute_tool arguments must be an object with name and arguments.') };
  }
  for (const key of Object.keys(raw)) {
    if (POLLUTION_KEYS.has(key) || !FACADE_KEYS.has(key)) {
      return { ok: false, result: facadeError('invalid_params', 'execute_tool received an unsupported field. Pass name, arguments, and optional schema_hash.') };
    }
  }
  if (typeof raw.name !== 'string' || raw.name.length === 0 || raw.name.length > 128) {
    return { ok: false, result: facadeError('invalid_params', 'name must be the exact operation name returned by request_tools.') };
  }
  if (!isPlainObject(raw.arguments)) {
    return { ok: false, result: facadeError('invalid_params', 'arguments must be an object matching the selected operation schema.') };
  }
  for (const key of Object.keys(raw.arguments)) {
    if (POLLUTION_KEYS.has(key)) {
      return { ok: false, result: facadeError('invalid_params', 'arguments contain an unsupported field.') };
    }
  }
  if (raw.schema_hash !== undefined && (typeof raw.schema_hash !== 'string' || raw.schema_hash.length < 8 || raw.schema_hash.length > 128)) {
    return { ok: false, result: facadeError('invalid_params', 'schema_hash must be the fingerprint from request_tools.') };
  }
  if (raw.dry_run !== undefined && typeof raw.dry_run !== 'boolean') {
    return { ok: false, result: facadeError('invalid_params', 'dry_run must be a boolean.') };
  }
  if (raw._meta !== undefined && !isPlainObject(raw._meta)) {
    return { ok: false, result: facadeError('invalid_params', '_meta must be an object.') };
  }
  const nestedDry = raw.arguments.dry_run;
  if (raw.dry_run === true && nestedDry === false) {
    return { ok: false, result: facadeError('dry_run_conflict', 'Outer dry_run:true conflicts with arguments.dry_run:false. Remove the nested flag or preview both.') };
  }
  return {
    ok: true,
    request: {
      name: raw.name,
      arguments: raw.arguments,
      ...(typeof raw.schema_hash === 'string' ? { schemaHash: raw.schema_hash } : {}),
      ...(raw.dry_run === true || nestedDry === true ? { dryRun: true } : {}),
      ...(isPlainObject(raw._meta) ? { meta: raw._meta } : {}),
    },
  };
}

export interface ExecuteToolDispatch {
  /** Same path as a direct tools/call for this transport, aimed at the target. */
  dispatch(name: string, params: Record<string, unknown>): Promise<ToolResult>;
}

export interface ExecuteToolPolicy {
  operations: readonly Operation[];
  /** Surface-restricted names. Undefined means the full surface. */
  surfaceAllowed: ReadonlySet<string> | undefined;
  /** Caller-authorized names inside that surface (scope, fence, gates, locality). */
  authorizedTargets: ReadonlySet<string>;
  /** Names discovery would label requires_surface. Execution does not widen. */
  surfaceRequired: ReadonlyMap<string, 'starter' | 'full'>;
  strictParams: boolean;
}

/**
 * Run one advanced operation through the supplied dispatcher.
 * Core and control names are rejected after the visibility check so a hidden
 * core name stays indistinguishable from an unknown name.
 */
export async function runExecuteTool(
  raw: unknown,
  policy: ExecuteToolPolicy,
  transport: ExecuteToolDispatch,
): Promise<ToolResult> {
  const parsed = parseExecuteToolArgs(raw);
  if (!parsed.ok) return parsed.result;
  const { request } = parsed;

  const op = policy.operations.find(item => item.name === request.name);
  const onSurface = policy.surfaceAllowed === undefined || policy.surfaceAllowed.has(request.name);
  const authorized = onSurface && policy.authorizedTargets.has(request.name);

  if (!op || !authorized) {
    const required = policy.surfaceRequired.get(request.name);
    if (op && required && onSurface) {
      return facadeError(
        'surface_required',
        `This operation requires surface '${required}'. Persist it with request_tools if that is permitted, then retry. Presentation stays compact.`,
        { surface: required },
      );
    }
    return facadeError('operation_unavailable', 'That operation is not available.');
  }

  if (compactCoreNames().has(request.name) || isCompactControlName(request.name) || request.name === EXECUTE_TOOL_NAME) {
    return facadeError('use_core_tool', 'Use the existing core tool for that operation. execute_tool does not wrap core or control tools.');
  }

  if (request.schemaHash) {
    const current = operationDescriptor(op, policy.strictParams).schema_hash;
    if (current !== request.schemaHash) {
      return facadeError(
        'schema_changed',
        'The operation schema changed. Fetch a current descriptor with request_tools before retrying. Nothing was executed.',
      );
    }
  }

  const params: Record<string, unknown> = { ...request.arguments };
  if (request.dryRun) params.dry_run = true;
  if (request.meta) params._meta = request.meta;
  return transport.dispatch(request.name, params);
}

export type CompactCallPlan =
  | { action: 'legacy' }
  | { action: 'deny' }
  | { action: 'result'; result: ToolResult }
  | { action: 'forward'; name: string; params: Record<string, unknown> };

/**
 * Decide what a compact tools/call should do before the transport's existing
 * scope check and dispatch. `forward` rewrites the call onto the target so
 * the transport applies the target's checks, not the wrapper's.
 */
export function planCompactCall(opts: {
  presentation: 'legacy' | 'compact';
  requestedName: string;
  requestedParams: unknown;
  advertised: ReadonlySet<string>;
  policy: ExecuteToolPolicy;
}): CompactCallPlan {
  if (opts.presentation !== 'compact') return { action: 'legacy' };
  if (opts.requestedName === EXECUTE_TOOL_NAME) {
    if (!opts.advertised.has(EXECUTE_TOOL_NAME)) return { action: 'deny' };
    const parsed = parseExecuteToolArgs(opts.requestedParams);
    if (!parsed.ok) return { action: 'result', result: parsed.result };
    const request = parsed.request;
    const op = opts.policy.operations.find(item => item.name === request.name);
    const onSurface = opts.policy.surfaceAllowed === undefined || opts.policy.surfaceAllowed.has(request.name);
    const authorized = Boolean(op) && onSurface && opts.policy.authorizedTargets.has(request.name);
    if (!authorized) {
      const required = opts.policy.surfaceRequired.get(request.name);
      if (op && required) {
        return {
          action: 'result',
          result: facadeError(
            'surface_required',
            `This operation requires surface '${required}'. Persist it with request_tools if that is permitted, then retry. Presentation stays compact.`,
            { surface: required },
          ),
        };
      }
      return { action: 'result', result: facadeError('operation_unavailable', 'That operation is not available.') };
    }
    if (compactCoreNames().has(request.name) || isCompactControlName(request.name)) {
      return {
        action: 'result',
        result: facadeError('use_core_tool', 'Use the existing core tool for that operation. execute_tool does not wrap core or control tools.'),
      };
    }
    if (request.schemaHash && operationDescriptor(op!, opts.policy.strictParams).schema_hash !== request.schemaHash) {
      return {
        action: 'result',
        result: facadeError('schema_changed', 'The operation schema changed. Fetch a current descriptor with request_tools before retrying. Nothing was executed.'),
      };
    }
    const params: Record<string, unknown> = { ...request.arguments };
    if (request.dryRun) params.dry_run = true;
    if (request.meta) params._meta = request.meta;
    return { action: 'forward', name: request.name, params };
  }
  if (!opts.advertised.has(opts.requestedName)) return { action: 'deny' };
  return { action: 'legacy' };
}

export function buildExecutePolicy(opts: {
  operations: readonly Operation[];
  surface: McpSurface;
  ceiling: McpSurface;
  eligible: (op: Operation) => boolean;
  canSelfPersist: boolean;
  strictParams: boolean;
}): ExecuteToolPolicy {
  const onSurface = filterOpsForSurface([...opts.operations], opts.surface).filter(opts.eligible);
  const onCeiling = filterOpsForSurface([...opts.ceiling === 'full' ? opts.operations : opts.operations], opts.ceiling).filter(opts.eligible);
  const authorized = new Set(onSurface.map(op => op.name));
  const surfaceRequired = new Map<string, 'starter' | 'full'>();
  for (const op of onCeiling) {
    if (authorized.has(op.name)) continue;
    const availability = availabilityFor(op, {
      effective: opts.surface,
      ceiling: opts.ceiling,
      canSelfPersist: opts.canSelfPersist,
    });
    if (availability?.status === 'requires_surface') surfaceRequired.set(op.name, availability.surface);
  }
  const surfaced = filterOpsForSurface([...opts.operations], opts.surface);
  return {
    operations: opts.operations,
    surfaceAllowed: opts.surface === 'full' ? undefined : new Set(surfaced.map(op => op.name)),
    authorizedTargets: authorized,
    surfaceRequired,
    strictParams: opts.strictParams,
  };
}
