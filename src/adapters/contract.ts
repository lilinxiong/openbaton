import { spawn } from "node:child_process";
import path from "node:path";

/**
 * The adapters that are part of this release. The registry owns the runtime
 * list; keeping the id type here lets each adapter implement the contract
 * without importing the registry back into itself.
 */
/** Adapter ids are supplied by validated manifests at runtime. */
export type CliId = string;

export interface CliReasoningEffort {
  id: string;
  description: string;
}

export interface CliServiceTier {
  id: string;
  name: string;
  description: string;
}

export interface CliModel {
  id: string;
  model: string;
  display_name: string;
  description: string;
  hidden: boolean;
  reasoning_efforts: CliReasoningEffort[];
  default_reasoning_effort: string | null;
  input_modalities: string[];
  additional_speed_tiers: string[];
  service_tiers: CliServiceTier[];
  default_service_tier: string | null;
  is_default: boolean;
}

/**
 * Optional scheduling limits reported by the CLI discovery surface itself.
 *
 * `max_concurrent_subagents` is the maximum number of simultaneously active
 * descendants in one root-agent tree. The root agent is not included. This
 * is deliberately not a total-agent, process, model, or workspace count.
 *
 * Adapter responses may use older spellings, but they are normalized to this
 * public shape by `normalizeCliRuntimeCapabilities` before reaching callers.
 */
export interface CliRuntimeCapabilities {
  max_concurrent_subagents?: number;
  max_depth?: number;
  /** True only when native spawn can honor and acknowledge an exact root. */
  exact_execution_root?: boolean;
}

/**
 * The opaque handle returned by a host's native child-spawn API.  This is
 * deliberately separate from host lifecycle metadata: some hosts return a
 * usable task handle while never exposing a child-agent diagnostic id.
 */
export type NativeExecutionHandleKind = string;

/** Adapter-neutral identity for one isolated, immutable-base execution root. */
export interface ExactExecutionRootIdentity {
  repository_id: string;
  git_common_dir_identity: string;
  execution_root: string;
  base_tree: string;
  worktree_record_id: string;
}

/** Capability advertised by an adapter that can honor an exact workspace. */
export interface ExactExecutionRootCapability {
  exact_execution_root: true;
}

/** Exact-root input passed to a native child-spawn implementation. */
export type ExactExecutionRootRequest = ExactExecutionRootIdentity;

/** Exact-root identity acknowledged by the native child-spawn result. */
export type ExactExecutionRootAcknowledgement = ExactExecutionRootIdentity;

const SHA256_IDENTITY = /^[0-9a-f]{64}$/u;
const GIT_OBJECT_IDENTITY = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const RECORD_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const EXACT_ROOT_FIELDS = [
  "repository_id",
  "git_common_dir_identity",
  "execution_root",
  "base_tree",
  "worktree_record_id",
] as const;
export const EXACT_EXECUTION_ROOT_IDENTITY_FIELDS: readonly (keyof ExactExecutionRootIdentity)[] = EXACT_ROOT_FIELDS;

/**
 * Validate the complete wire identity without consulting a provider or Git.
 * Physical root verification remains a spawn-time responsibility.
 */
export function normalizeExactExecutionRootIdentity(value: unknown): ExactExecutionRootIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("EXACT_EXECUTION_ROOT_MALFORMED: identity must be an object");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !(EXACT_ROOT_FIELDS as readonly string[]).includes(key))) {
    throw new Error("EXACT_EXECUTION_ROOT_UNKNOWN_FIELD: identity contains an unknown field");
  }
  if (EXACT_ROOT_FIELDS.some((field) => !Object.hasOwn(input, field))) {
    throw new Error("EXACT_EXECUTION_ROOT_PARTIAL: all identity fields are required");
  }
  if (typeof input.repository_id !== "string" || !SHA256_IDENTITY.test(input.repository_id)
    || typeof input.git_common_dir_identity !== "string" || !SHA256_IDENTITY.test(input.git_common_dir_identity)) {
    throw new Error("EXACT_EXECUTION_ROOT_IDENTITY_INVALID: repository identities must be lowercase SHA-256 hex");
  }
  if (typeof input.base_tree !== "string" || !GIT_OBJECT_IDENTITY.test(input.base_tree)) {
    throw new Error("EXACT_EXECUTION_ROOT_BASE_TREE_INVALID: base_tree must be a lowercase Git object id");
  }
  if (typeof input.worktree_record_id !== "string" || !RECORD_IDENTITY.test(input.worktree_record_id)) {
    throw new Error("EXACT_EXECUTION_ROOT_RECORD_ID_INVALID: worktree_record_id must be a stable identity");
  }
  if (typeof input.execution_root !== "string" || input.execution_root !== input.execution_root.trim()
    || !path.isAbsolute(input.execution_root) || path.normalize(input.execution_root) !== input.execution_root) {
    throw new Error("EXACT_EXECUTION_ROOT_PATH_NONCANONICAL: execution_root must be a canonical absolute path");
  }
  return Object.freeze({
    repository_id: input.repository_id,
    git_common_dir_identity: input.git_common_dir_identity,
    execution_root: input.execution_root,
    base_tree: input.base_tree,
    worktree_record_id: input.worktree_record_id,
  });
}

/** Extract an all-or-nothing exact-root identity from a larger wire record. */
export function extractExactExecutionRootIdentity(value: unknown): ExactExecutionRootIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const present = EXACT_ROOT_FIELDS.filter((field) => Object.hasOwn(input, field));
  if (present.length === 0) return undefined;
  if (present.length !== EXACT_ROOT_FIELDS.length) {
    throw new Error("EXACT_EXECUTION_ROOT_PARTIAL: all identity fields are required");
  }
  return normalizeExactExecutionRootIdentity(Object.fromEntries(EXACT_ROOT_FIELDS.map((field) => [field, input[field]])));
}

export function sameExactExecutionRootIdentity(left: unknown, right: unknown): boolean {
  try {
    const a = extractExactExecutionRootIdentity(left);
    const b = extractExactExecutionRootIdentity(right);
    return a === undefined && b === undefined
      ? true
      : a !== undefined && b !== undefined && EXACT_ROOT_FIELDS.every((field) => a[field] === b[field]);
  } catch {
    return false;
  }
}

export interface CliModelCatalog {
  cli: CliId;
  /** Manifest protocol identity, retained alongside the cli identifier. */
  adapter_id?: string;
  version: string | null;
  models: CliModel[];
  /** Missing values remain unknown; the director applies its generic limits. */
  capabilities?: CliRuntimeCapabilities;
}

export interface DiscoverCliModelsOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
}

/** Host-specific facts needed by the director and host skill installer. */
export interface CliHostMetadata {
  /** Host id persisted on dispatch tickets. */
  id: CliId;
  /** Skill path relative to the user's home directory. */
  skillPath: string;
  /** Native per-root-tree subagent ceiling before environment overrides. */
  defaultMaxConcurrent: number;
  /** Manifest-reported nesting ceiling when the host exposes one. */
  defaultMaxDepth?: number;
  /** Optional environment variable used by the host to override its cap. */
  maxConcurrentEnv?: string;
  /** Resolve the per-root-tree subagent cap exactly as the host exposes it to Baton. */
  maxConcurrent: (env?: NodeJS.ProcessEnv) => number;
  /** Return true when this host appears to be the current invoking runtime. */
  isInvoking?: (env?: NodeJS.ProcessEnv) => boolean;
  /** Kind of handle returned by this host's native child execution API. */
  executionHandleKind: NativeExecutionHandleKind;
  /** Missing/false adapters remain eligible only for shared compatibility. */
  exactExecutionRoot?: boolean;
}

/**
 * First-class boundary for one supported CLI. Discovery and host metadata
 * live together so callers do not need CLI-specific switches scattered across
 * config, host installation, and route refresh code.
 */
export interface CliAdapter {
  readonly id: CliId;
  readonly host: CliHostMetadata;
  readonly resolveCommand: (env?: NodeJS.ProcessEnv) => string | null;
  readonly discoverModels: (options?: DiscoverCliModelsOptions) => Promise<CliModelCatalog>;
}

/**
 * Resolve the selected host's adapter.  Commands depend on this boundary so
 * tests can provide a current adapter without reintroducing a cross-host
 * discovery function.
 */
export type CliAdapterProvider = (cli: CliId) => Pick<CliAdapter, "discoverModels">;
