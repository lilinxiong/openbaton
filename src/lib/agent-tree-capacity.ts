import type { CliAdapter, CliHostMetadata, CliRuntimeCapabilities } from "../adapters/contract.js";
import type { Config } from "./config.js";
import { cliProfileForHost, reportedConcurrentLimit } from "./config.js";
import type { SessionScope, SessionUid } from "./session-scope.js";

/** A capacity source always has the same meaning: tree-local subagents, excluding the root. */
export type AgentTreeCapacitySourceKind = "host_limit" | "configured_policy" | "operation_limit";

export interface AgentTreeCapacitySource {
  readonly kind: AgentTreeCapacitySourceKind;
  readonly value: number;
  /** True when this source selected the effective minimum. */
  readonly applied: boolean;
}

export interface AgentTreeCapacityInput {
  readonly host?: Pick<CliAdapter, "host"> | CliHostMetadata;
  readonly hostLimit?: unknown;
  readonly capabilities?: CliRuntimeCapabilities | Record<string, unknown> | null;
  readonly config?: Config;
  readonly configuredPolicy?: unknown;
  /** Short aliases are accepted for callers that already use limit terminology. */
  readonly policyLimit?: unknown;
  readonly currentOperationLimit?: unknown;
  readonly operationLimit?: unknown;
  /** An explicit session scope is carried through snapshots, but never affects the limit. */
  readonly session?: SessionScope | SessionUid;
  readonly env?: NodeJS.ProcessEnv;
}

export interface EffectiveAgentTreeCapacity {
  readonly capacity: number | null;
  readonly host: string | null;
  readonly session_uid: SessionUid | null;
  readonly capacity_sources: readonly AgentTreeCapacitySource[];
  readonly unknown_sources: readonly AgentTreeCapacitySourceKind[];
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : undefined;
}

function sessionUid(value: AgentTreeCapacityInput["session"]): SessionUid | null {
  if (typeof value === "string") return value;
  return value?.session_uid || null;
}

function isAdapter(value: AgentTreeCapacityInput["host"]): value is Pick<CliAdapter, "host"> {
  return Boolean(value && "host" in value);
}

function hostId(host: AgentTreeCapacityInput["host"]): string | null {
  return isAdapter(host) ? host.host.id : host?.id || null;
}

function hostMetadata(host: AgentTreeCapacityInput["host"]): CliHostMetadata | undefined {
  return isAdapter(host) ? host.host : host;
}

function capabilityLimit(capabilities: AgentTreeCapacityInput["capabilities"]): unknown {
  if (!capabilities || typeof capabilities !== "object") return undefined;
  const values = capabilities as Record<string, unknown>;
  return values.max_concurrent_subagents
    ?? values.maxConcurrentSubagents
    ?? values.max_concurrent
    ?? values.maxConcurrent;
}

/**
 * Resolve the one effective per-root-tree subagent capacity.
 *
 * All usable inputs are positive integers and the result is the minimum of
 * those inputs. Consequently, whenever a host limit is known, the returned
 * capacity is mathematically bounded by that host limit. Invalid values are
 * treated as unknown and never widen the result.
 */
export function resolveAgentTreeCapacity(input: AgentTreeCapacityInput = {}): EffectiveAgentTreeCapacity {
  const metadata = hostMetadata(input.host);
  const id = hostId(input.host);
  const configuredHostLimit = input.config && id
    ? reportedConcurrentLimit(cliProfileForHost(input.config, id).max_concurrent)
    : undefined;
  const hostLimit = positiveInteger(input.hostLimit)
    ?? positiveInteger(capabilityLimit(input.capabilities))
    // A persisted live CLI value replaces the manifest fallback.
    ?? configuredHostLimit
    ?? (metadata ? positiveInteger(metadata.maxConcurrent(input.env)) : undefined)
    ?? (metadata ? positiveInteger(metadata.defaultMaxConcurrent) : undefined);
  const policy = positiveInteger(input.configuredPolicy ?? input.policyLimit)
    ?? (input.config && id && hostLimit === undefined
      ? positiveInteger(input.config.director.max_concurrent)
      : undefined);
  const operation = positiveInteger(input.currentOperationLimit ?? input.operationLimit);

  const candidates: Array<{ kind: AgentTreeCapacitySourceKind; value: number | undefined }> = [
    { kind: "host_limit", value: hostLimit },
    { kind: "configured_policy", value: policy },
    { kind: "operation_limit", value: operation },
  ];
  const known = candidates.filter((item): item is { kind: AgentTreeCapacitySourceKind; value: number } => item.value !== undefined);
  const capacity = known.length ? Math.min(...known.map((item) => item.value)) : null;
  return {
    capacity,
    host: hostId(input.host),
    session_uid: sessionUid(input.session),
    capacity_sources: known.map((item) => ({ ...item, applied: item.value === capacity })),
    unknown_sources: candidates.filter((item) => item.value === undefined).map((item) => item.kind),
  };
}

/** Descriptive alias for callers that need to emphasize the effective value. */
export const effectiveAgentTreeCapacity = resolveAgentTreeCapacity;
export const resolveEffectiveAgentTreeCapacity = resolveAgentTreeCapacity;
