import { spawn } from "node:child_process";

/**
 * The adapters that are part of this release. The registry owns the runtime
 * list; keeping the id type here lets each adapter implement the contract
 * without importing the registry back into itself.
 */
export const REGISTERED_CLI_IDS = ["codex", "grok", "cursor", "claude"] as const;
export type CliId = (typeof REGISTERED_CLI_IDS)[number];

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

/** Optional scheduling limits reported by the CLI discovery surface itself. */
export interface CliRuntimeCapabilities {
  max_concurrent?: number;
  max_depth?: number;
}

/**
 * The opaque handle returned by a host's native child-spawn API.  This is
 * deliberately separate from host lifecycle metadata: some hosts return a
 * usable task handle while never exposing a child-agent diagnostic id.
 */
export type NativeExecutionHandleKind = "task_name" | "agent_id" | "session_id" | "task_id" | "opaque";

export interface CliModelCatalog {
  cli: CliId;
  version: string | null;
  models: CliModel[];
  /** Missing values are unknown and must fall back to director defaults. */
  capabilities?: CliRuntimeCapabilities;
  /** Flat aliases accepted from adapter implementations. */
  max_concurrent?: number;
  max_depth?: number;
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
  /** Native host concurrency ceiling before environment overrides. */
  defaultMaxConcurrent: number;
  /** Optional environment variable used by the host to override its cap. */
  maxConcurrentEnv?: string;
  /** Resolve the cap exactly as the host exposes it to Baton. */
  maxConcurrent: (env?: NodeJS.ProcessEnv) => number;
  /** Return true when this host appears to be the current invoking runtime. */
  isInvoking?: (env?: NodeJS.ProcessEnv) => boolean;
  /** Kind of handle returned by this host's native child execution API. */
  executionHandleKind: NativeExecutionHandleKind;
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
