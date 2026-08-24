import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { findBinaryOnPath, isExecutableFile } from "../lib/executables.js";
import type {
  CliAdapter,
  CliHostMetadata,
  CliModel,
  CliModelCatalog,
  DiscoverCliModelsOptions,
} from "./contract.js";
import {
  codedError,
  normalizeReasoningEfforts,
  normalizeServiceTiers,
  record,
  strings,
  terminate,
} from "./shared.js";

export const GROK_HOST_METADATA: CliHostMetadata = {
  id: "grok",
  skillPath: ".grok/skills/baton/SKILL.md",
  defaultMaxConcurrent: 8,
  maxConcurrentEnv: "GROK_MAX_CONCURRENT_SUBAGENTS",
  maxConcurrent: (env = process.env) => {
    const override = Number(String(env.GROK_MAX_CONCURRENT_SUBAGENTS || "").trim());
    if (Number.isFinite(override) && override > 0) return Math.floor(override);
    return 8;
  },
  isInvoking: (env = process.env) =>
    String(env.GROK_AGENT || "").trim() === "1"
    || Boolean(String(env.GROK_SESSION_ID || "").trim()),
};

/** Resolve the official Grok Build binary, without inventing a fallback path. */
export function resolveGrokCommand(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = String(env.BATON_GROK_PATH || "").trim();
  if (override) return isExecutableFile(override) ? override : null;
  return findBinaryOnPath("grok", env);
}

const GROK_MODEL_ID = /^[A-Za-z][A-Za-z0-9._:/-]*$/;

function grokModelStub(id: string, extras: Partial<Pick<CliModel, "display_name" | "description" | "is_default">> = {}): CliModel {
  return {
    id,
    model: id,
    display_name: extras.display_name || id,
    description: extras.description || "",
    hidden: false,
    reasoning_efforts: [],
    default_reasoning_effort: null,
    input_modalities: [],
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    is_default: extras.is_default === true,
  };
}

/** Normalize `grok models` JSON without inventing models. */
export function normalizeGrokModels(value: unknown): CliModel[] {
  const envelope = record(value);
  const values = Array.isArray(value)
    ? value
    : Array.isArray(envelope?.data)
      ? envelope.data
      : envelope?.models;
  if (!Array.isArray(values)) throw new Error("Grok models response must be an array or a data/models envelope");
  const byId = new Map<string, CliModel>();
  for (const item of values) {
    const data = record(item);
    const id = String(data?.id ?? data?.model ?? (typeof item === "string" ? item : "")).trim();
    if (!id || data?.hidden === true) continue;
    byId.set(id, {
      id,
      model: String(data?.model || id).trim() || id,
      display_name: String(data?.displayName ?? data?.display_name ?? data?.name ?? id).trim() || id,
      description: String(data?.description || "").trim(),
      hidden: false,
      reasoning_efforts: normalizeReasoningEfforts(data?.supportedReasoningEfforts ?? data?.reasoning_efforts ?? data?.efforts),
      default_reasoning_effort: String(data?.defaultReasoningEffort ?? data?.default_reasoning_effort ?? "").trim() || null,
      input_modalities: strings(data?.inputModalities ?? data?.input_modalities),
      additional_speed_tiers: strings(data?.additionalSpeedTiers ?? data?.additional_speed_tiers),
      service_tiers: normalizeServiceTiers(data?.serviceTiers ?? data?.service_tiers ?? data?.tiers),
      default_service_tier: String(data?.defaultServiceTier ?? data?.default_service_tier ?? "").trim() || null,
      is_default: data?.isDefault === true || data?.is_default === true,
    });
  }
  return [...byId.values()];
}

function parseGrokModelEntry(text: string): { id: string; is_default: boolean; description: string } | null {
  const match = text.trim().match(/^([A-Za-z][A-Za-z0-9._:/-]*)(?:\s+\(([^)]*)\))?(?:\s+[—–-]\s+(.+))?\s*$/);
  if (!match || !GROK_MODEL_ID.test(match[1])) return null;
  const id = match[1];
  const note = (match[2] || "").trim();
  const rest = (match[3] || "").trim();
  const is_default = /\bdefault\b/i.test(note) || /\bdefault\b/i.test(rest);
  const description = rest || (note && !/\bdefault\b/i.test(note) ? note : "");
  return { id, is_default, description };
}

/**
 * Parse `grok models` stdout. Official grok prints a text listing; JSON is
 * accepted when the CLI emits it. Login/prose lines are not model ids.
 */
export function parseGrokModelText(stdout: string): CliModel[] {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Grok models text was empty");
  try {
    return normalizeGrokModels(JSON.parse(trimmed));
  } catch {
    /* Official grok prints a text listing, not JSON. */
  }
  const byId = new Map<string, CliModel>();
  let defaultId: string | null = null;
  let inAvailable = false;
  let availableHadContent = false;

  const add = (entry: { id: string; is_default: boolean; description: string }) => {
    const previous = byId.get(entry.id);
    byId.set(entry.id, grokModelStub(entry.id, {
      description: entry.description || previous?.description || "",
      is_default: Boolean(previous?.is_default || entry.is_default || entry.id === defaultId),
    }));
  };

  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      if (inAvailable && availableHadContent) inAvailable = false;
      continue;
    }
    const defaultMatch = line.match(/^default models?:\s+([A-Za-z][A-Za-z0-9._:/-]*)/i);
    if (defaultMatch) {
      defaultId = defaultMatch[1];
      continue;
    }
    if (/^available models:?$/i.test(line)) {
      inAvailable = true;
      availableHadContent = false;
      continue;
    }
    const listed = line.match(/^(?:[-*•+]|\d+[.)])\s+(.*)$/);
    const parsed = parseGrokModelEntry(listed?.[1] ?? (inAvailable ? line : ""));
    if (parsed) {
      add(parsed);
      if (inAvailable) availableHadContent = true;
      continue;
    }
    if (inAvailable) inAvailable = false;
  }

  if (defaultId) {
    const current = byId.get(defaultId);
    byId.set(defaultId, grokModelStub(defaultId, {
      description: current?.description || "",
      is_default: true,
    }));
  }
  if (!byId.size) throw new Error("Grok models text contained no model ids");
  return [...byId.values()];
}

function runGrokProcess(
  executable: string,
  args: string[],
  {
    cwd,
    env,
    timeoutMs,
    spawnImpl,
  }: DiscoverCliModelsOptions,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (spawnImpl || spawn)(executable, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      reject(codedError(`Grok model discovery failed: ${error instanceof Error ? error.message : String(error)}`, "GROK_MODEL_DISCOVERY_FAILED"));
      return;
    }
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    const finish = (error?: Error, code: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminate(child);
      if (error) reject(error);
      else resolve({ code, stdout: stdout.join(""), stderr: stderr.join("") });
    };
    const timer = setTimeout(() => {
      finish(codedError("Grok model discovery timed out", "GROK_MODEL_DISCOVERY_TIMEOUT"));
    }, timeoutMs ?? 15_000);
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("error", (error) => finish(codedError(`Grok model discovery failed: ${error.message}`, "GROK_MODEL_DISCOVERY_FAILED")));
    child.on("exit", (code) => finish(undefined, code));
    child.stdin.end();
  });
}

/**
 * Discover exactly the models `grok models` reports. Official grok has no
 * `--json` flag; parse JSON stdout if present, otherwise the text listing.
 * Baton never executes work via grok -p.
 */
export async function discoverGrokModels({
  cwd,
  env = process.env,
  command,
  timeoutMs = 15_000,
  spawnImpl = spawn,
}: DiscoverCliModelsOptions = {}): Promise<CliModelCatalog> {
  const executable = String(command || resolveGrokCommand(env) || "").trim();
  if (!executable) throw codedError("Grok CLI is not available; install grok or set BATON_GROK_PATH", "CLI_NOT_AVAILABLE");
  const modelsRun = await runGrokProcess(executable, ["models"], { cwd, env, timeoutMs, spawnImpl });
  if (modelsRun.code !== 0) {
    const detail = (modelsRun.stderr || modelsRun.stdout).trim();
    throw codedError(
      `Grok model discovery failed (${modelsRun.code ?? "unknown"})${detail ? `: ${detail}` : ""}`,
      "GROK_MODEL_DISCOVERY_FAILED",
    );
  }
  let models: CliModel[];
  try {
    models = parseGrokModelText(modelsRun.stdout);
  } catch (error) {
    throw codedError(error instanceof Error ? error.message : String(error), "GROK_MODEL_DISCOVERY_FAILED");
  }
  let version: string | null = null;
  try {
    const versionRun = await runGrokProcess(executable, ["version"], { cwd, env, timeoutMs, spawnImpl });
    if (versionRun.code === 0) version = versionRun.stdout.trim().split(/\r?\n/)[0] || null;
  } catch {
    version = null;
  }
  return { cli: "grok", version, models };
}

export const grokAdapter: CliAdapter = {
  id: "grok",
  host: GROK_HOST_METADATA,
  resolveCommand: resolveGrokCommand,
  discoverModels: discoverGrokModels,
};
