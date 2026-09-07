import fs from "node:fs";
import path from "node:path";
import type { CliAdapterProvider, CliId, CliModel } from "../adapters/contract.js";
import {
  createCliAdapterRegistrySnapshot,
  getCliAdapter,
  type CliAdapterRegistrySnapshot,
} from "../adapters/registry.js";
import { cliProfileForHost, loadConfig } from "./config.js";
import { batonHomeDir } from "./paths.js";

export type WorkMode = "execution" | "implementation" | "investigation";
export type NativeResultStatus = "completed" | "blocked" | "failed";

export interface NativeModelRequirements {
  workMode?: WorkMode;
  model?: string | null;
  effort?: string | null;
  contextTokens?: number;
  unavailableModels?: string[];
  serviceTier?: string | null;
}

export interface NativeSelectionOptions extends NativeModelRequirements {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  host?: string | null;
  adapterProvider?: CliAdapterProvider;
}

export interface NativeSelection {
  host: CliId;
  model_id: string;
  work_mode: WorkMode;
  reasoning_effort?: string;
  service_tier?: string;
  context_tokens?: number;
  context_capacity: number | "unknown";
  disclosures: string[];
}

export interface NativeResultRecord {
  cwd: string;
  host: CliId;
  model: string;
  native_handle: string;
  status: NativeResultStatus;
  result: string;
  timestamp: string;
}

function nativeSnapshot(
  env: NodeJS.ProcessEnv,
  snapshot?: CliAdapterRegistrySnapshot,
): CliAdapterRegistrySnapshot {
  return snapshot || createCliAdapterRegistrySnapshot(env);
}

function parseNativeHost(
  value: string,
  snapshot: CliAdapterRegistrySnapshot,
): CliId {
  const host = String(value || "").trim().toLowerCase();
  if (snapshot.adapters.some((adapter) => adapter.host.id === host)) return host;
  throw new Error(`invalid host: ${value || "<empty>"} (expected ${snapshot.adapters.map((adapter) => adapter.id).join("|") || "none"})`);
}

export function resolveNativeHost(
  explicitHost: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  snapshot?: CliAdapterRegistrySnapshot,
): CliId {
  const registry = nativeSnapshot(env, snapshot);
  const explicit = explicitHost ? parseNativeHost(explicitHost, registry) : null;
  const declared = String(env.BATON_HOST || "").trim();
  const batonHost = declared ? parseNativeHost(declared, registry) : null;
  const signals = registry.adapters
    .filter((adapter) => adapter.host.isInvoking?.(env))
    .map((adapter) => adapter.host.id);
  const observed = [...new Set([...(batonHost ? [batonHost] : []), ...signals])];
  if (observed.length > 1) {
    throw new Error(`HOST_MISMATCH: invocation signals disagree (${observed.join(", ")})`);
  }
  if (explicit && observed[0] && explicit !== observed[0]) {
    throw new Error(`HOST_MISMATCH: --host ${explicit} cannot run inside ${observed[0]}`);
  }
  const host = explicit || observed[0];
  if (!host) throw new Error("HOST_REQUIRED: pass --host or set BATON_HOST");
  return host;
}

function positiveContext(model: CliModel): number | null {
  const raw = model as CliModel & Record<string, unknown>;
  const fields = [
    raw.context_tokens, raw.contextTokens, raw.context_window, raw.contextWindow,
    raw.max_input_tokens, raw.maxInputTokens,
  ];
  for (const value of fields) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  }
  return null;
}

function modePriority(profile: ReturnType<typeof cliProfileForHost>, mode: WorkMode): string[] {
  const configured = mode === "execution"
    ? profile.execution_models
    : mode === "implementation"
      ? profile.implementation_models
      : profile.investigation_models;
  return configured || [];
}

function supportedEfforts(model: CliModel): string[] {
  return model.reasoning_efforts.map((item) => item.id);
}

function supportedTiers(model: CliModel): string[] {
  return model.service_tiers.map((item) => item.id);
}

export async function selectNativeModel(options: NativeSelectionOptions): Promise<NativeSelection> {
  return (await selectNativeModels(options, [options]))[0];
}

/** One command-scoped discovery; every request keeps its own selection constraints. */
export async function selectNativeModels(
  options: NativeSelectionOptions,
  requests: readonly NativeModelRequirements[],
): Promise<NativeSelection[]> {
  if (!requests.length) return [];
  const env = options.env || process.env;
  const snapshot = createCliAdapterRegistrySnapshot(env);
  const host = resolveNativeHost(options.host, env, snapshot);
  const profile = cliProfileForHost(loadConfig(options.cwd, { env }), host);
  if (!profile.enabled) throw new Error(`HOST_PROFILE_DISABLED: ${host}`);
  const priorities = requests.map((request) => {
    const mode = request.workMode || "execution";
    if (!(["execution", "implementation", "investigation"] as string[]).includes(mode)) {
      throw new Error(`INVALID_WORK_MODE: ${mode}`);
    }
    if (request.contextTokens !== undefined && (!Number.isSafeInteger(request.contextTokens) || request.contextTokens < 1)) {
      throw new Error("INVALID_CONTEXT_TOKENS: expected a positive integer");
    }
    const priority = [...new Set(modePriority(profile, mode))];
    if (!priority.length) throw new Error(`NO_MODE_MODELS: ${host} has no ${mode} models configured`);
    if (request.model && !priority.includes(request.model)) throw new Error(`MODEL_NOT_ALLOWED: ${request.model}`);
    return priority;
  });

  const provider = options.adapterProvider || ((id: CliId) => getCliAdapter(id, env, snapshot));
  const catalog = await provider(host).discoverModels({ cwd: options.cwd, env });
  if ((catalog.cli && catalog.cli !== host) || (catalog.adapter_id && catalog.adapter_id !== host)) {
    throw new Error(`CATALOG_HOST_MISMATCH: requested ${host}, received ${catalog.cli || catalog.adapter_id}`);
  }
  const visible = new Map(catalog.models.filter((item) => !item.hidden).map((item) => [item.id, item]));
  return requests.map((request, index) => selectFromCatalog(host, visible, priorities[index], request));
}

function selectFromCatalog(
  host: CliId,
  visible: ReadonlyMap<string, CliModel>,
  priority: string[],
  options: NativeModelRequirements,
): NativeSelection {
  const mode = options.workMode || "execution";
  const allowed = new Set(priority);
  const unavailable = new Set(options.unavailableModels || []);

  if (options.model) {
    if (!allowed.has(options.model)) throw new Error(`MODEL_NOT_ALLOWED: ${options.model}`);
    if (!visible.has(options.model)) throw new Error(`MODEL_NOT_IN_CATALOG: ${options.model}`);
    if (unavailable.has(options.model)) throw new Error(`MODEL_UNAVAILABLE: ${options.model}`);
  }
  const ids = options.model ? [options.model] : priority;
  const candidates = ids
    .filter((id) => allowed.has(id) && visible.has(id) && !unavailable.has(id))
    .map((id) => visible.get(id)!)
    .filter((item) => !options.effort || supportedEfforts(item).includes(options.effort))
    .filter((item) => !options.serviceTier || supportedTiers(item).includes(options.serviceTier));
  const model = candidates.find((item) => {
    const capacity = positiveContext(item);
    return options.contextTokens === undefined || capacity === null || capacity >= options.contextTokens;
  });
  if (!model) {
    if (options.model && options.effort && !supportedEfforts(visible.get(options.model)!).includes(options.effort)) {
      throw new Error(`EFFORT_UNSUPPORTED: ${options.model} does not support ${options.effort}`);
    }
    if (options.model && options.serviceTier && !supportedTiers(visible.get(options.model)!).includes(options.serviceTier)) {
      throw new Error(`SERVICE_TIER_UNSUPPORTED: ${options.model} does not support ${options.serviceTier}`);
    }
    throw new Error("NO_ELIGIBLE_MODEL: configured catalog models were excluded");
  }

  const disclosures: string[] = [];
  const efforts = supportedEfforts(model);
  let effort: string | undefined;
  if (options.effort) {
    if (!efforts.includes(options.effort)) throw new Error(`EFFORT_UNSUPPORTED: ${model.id} does not support ${options.effort}`);
    effort = options.effort;
  } else {
    disclosures.push("effort not specified by caller; host default applies");
  }

  const tiers = supportedTiers(model);
  let tier: string | undefined;
  if (options.serviceTier) {
    if (!tiers.includes(options.serviceTier)) throw new Error(`SERVICE_TIER_UNSUPPORTED: ${model.id} does not support ${options.serviceTier}`);
    tier = options.serviceTier;
  }

  const capacity = positiveContext(model);
  if (options.contextTokens !== undefined && capacity === null) {
    disclosures.push("context capacity unknown; request was not excluded");
  }
  return {
    host,
    model_id: model.id,
    work_mode: mode,
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(tier ? { service_tier: tier } : {}),
    ...(options.contextTokens === undefined ? {} : { context_tokens: options.contextTokens }),
    context_capacity: capacity ?? "unknown",
    disclosures,
  };
}

export function resultsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(batonHomeDir(env), "results.jsonl");
}

export function appendNativeResult(
  input: Omit<NativeResultRecord, "cwd" | "timestamp"> & { cwd: string },
  env: NodeJS.ProcessEnv = process.env,
): NativeResultRecord {
  if (!(["completed", "blocked", "failed"] as string[]).includes(input.status)) {
    throw new Error(`INVALID_RESULT_STATUS: ${input.status}`);
  }
  if (!input.model.trim() || !input.native_handle.trim() || !input.result.trim()) {
    throw new Error("INVALID_RESULT: model, native handle, and result text are required");
  }
  if (input.result.length > 20_000) throw new Error("INVALID_RESULT: result text must be at most 20000 characters");
  const record: NativeResultRecord = { ...input, cwd: path.resolve(input.cwd), timestamp: new Date().toISOString() };
  const file = resultsPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  return record;
}

/** Read backwards using bytes so UTF-8 code points may safely span chunks. */
function* reverseLines(file: string): Generator<string> {
  const fd = fs.openSync(file, "r");
  try {
    let position = fs.fstatSync(fd).size;
    let pending = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(position, 64 * 1024);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        const count = fs.readSync(fd, chunk, read, length - read, position + read);
        if (!count) throw new Error("RESULT_HISTORY_CHANGED: file shortened during read");
        read += count;
      }
      const bytes = Buffer.concat([chunk, pending]);
      let end = bytes.length;
      for (let index = bytes.length - 1; index >= 0; index -= 1) {
        if (bytes[index] !== 10) continue;
        if (index + 1 < end) yield bytes.toString("utf8", index + 1, end);
        end = index;
      }
      pending = Buffer.from(bytes.subarray(0, end));
    }
    if (pending.length) yield pending.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function recentNativeResults(
  cwd: string,
  host: CliId,
  env: NodeJS.ProcessEnv = process.env,
  limit = 20,
  nativeHandle?: string,
): NativeResultRecord[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("INVALID_RESULT_LIMIT: expected a positive integer");
  const file = resultsPath(env);
  if (!fs.existsSync(file)) return [];
  const resolvedCwd = path.resolve(cwd);
  const records: NativeResultRecord[] = [];
  for (const line of reverseLines(file)) {
    try {
      const item = JSON.parse(line) as NativeResultRecord;
      if (!item || item.cwd !== resolvedCwd || item.host !== host) continue;
      if (typeof item.result !== "string" || typeof item.native_handle !== "string"
        || typeof item.model !== "string" || typeof item.timestamp !== "string"
        || !["completed", "blocked", "failed"].includes(item.status)) continue;
      if (nativeHandle !== undefined && item.native_handle !== nativeHandle) continue;
      records.push(item);
      if (records.length === limit) break;
    } catch { /* Ignore a partial or foreign line; append-only history remains readable. */ }
  }
  return records;
}

export function summarizeNativeResult(record: NativeResultRecord): NativeResultRecord & { result_truncated?: true } {
  let end = 0;
  let chars = 0;
  for (const char of record.result) {
    if (chars === 240) return { ...record, result: record.result.slice(0, end), result_truncated: true };
    end += char.length;
    chars += 1;
  }
  return record;
}
