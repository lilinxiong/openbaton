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

export const CURSOR_HOST_METADATA: CliHostMetadata = {
  id: "cursor",
  skillPath: ".cursor/skills/baton/SKILL.md",
  defaultMaxConcurrent: 4,
  maxConcurrentEnv: "CURSOR_MAX_CONCURRENT_SUBAGENTS",
  maxConcurrent: (env = process.env) => {
    const override = Number(String(env.CURSOR_MAX_CONCURRENT_SUBAGENTS || "").trim());
    if (Number.isFinite(override) && override > 0) return Math.floor(override);
    return 4;
  },
  isInvoking: (env = process.env) =>
    String(env.CURSOR_AGENT || "").trim() === "1"
    || Boolean(String(env.CURSOR_CONVERSATION_ID || "").trim()),
};

const CURSOR_MODEL_ID = /^[A-Za-z][A-Za-z0-9._:/-]*$/;

/** Resolve the Cursor Agent CLI by its dedicated binary name. */
export function resolveCursorCommand(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = String(env.BATON_CURSOR_PATH || "").trim();
  if (override) return isExecutableFile(override) ? override : null;
  return findBinaryOnPath("cursor-agent", env);
}

function cursorModelStub(id: string, extras: Partial<Pick<CliModel, "display_name" | "description" | "is_default">> = {}): CliModel {
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

/** Normalize JSON model payloads when the CLI emits them. */
export function normalizeCursorModels(value: unknown): CliModel[] {
  const envelope = record(value);
  const values = Array.isArray(value)
    ? value
    : Array.isArray(envelope?.data)
      ? envelope.data
      : envelope?.models;
  if (!Array.isArray(values)) throw new Error("Cursor models response must be an array or a data/models envelope");
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

function parseCursorModelLine(line: string): { id: string; display_name: string; is_default: boolean } | null {
  const match = line.trim().match(/^([A-Za-z][A-Za-z0-9._:/-]*)\s+-\s+(.+)$/);
  if (!match || !CURSOR_MODEL_ID.test(match[1])) return null;
  const id = match[1];
  let display = match[2].trim();
  const is_default = /\(\s*default\s*\)/i.test(display);
  display = display.replace(/\(\s*default\s*\)/gi, "").replace(/\(\s*current\s*\)/gi, "").trim();
  return { id, display_name: display || id, is_default };
}

/**
 * Parse `cursor-agent models` stdout. Official cursor-agent prints a text listing;
 * JSON is accepted when the CLI emits it. Login/prose lines are not model ids.
 */
export function parseCursorModelText(stdout: string): CliModel[] {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Cursor models text was empty");
  try {
    return normalizeCursorModels(JSON.parse(trimmed));
  } catch {
    /* Official cursor-agent prints a text listing, not JSON. */
  }
  const byId = new Map<string, CliModel>();
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^available models:?$/i.test(line)) continue;
    const parsed = parseCursorModelLine(line);
    if (!parsed) continue;
    const previous = byId.get(parsed.id);
    byId.set(parsed.id, cursorModelStub(parsed.id, {
      display_name: parsed.display_name,
      description: previous?.description || "",
      is_default: Boolean(previous?.is_default || parsed.is_default),
    }));
  }
  if (!byId.size) throw new Error("Cursor models text contained no model ids");
  return [...byId.values()];
}

function runCursorProcess(
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
      reject(codedError(`Cursor model discovery failed: ${error instanceof Error ? error.message : String(error)}`, "CURSOR_MODEL_DISCOVERY_FAILED"));
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
      finish(codedError("Cursor model discovery timed out", "CURSOR_MODEL_DISCOVERY_TIMEOUT"));
    }, timeoutMs ?? 15_000);
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("error", (error) => finish(codedError(`Cursor model discovery failed: ${error.message}`, "CURSOR_MODEL_DISCOVERY_FAILED")));
    child.on("exit", (code) => finish(undefined, code));
    child.stdin.end();
  });
}

/**
 * Discover exactly the models `cursor-agent models` reports. Baton never executes
 * work via `cursor-agent -p` or any other cursor-agent print/headless process.
 */
export async function discoverCursorModels({
  cwd,
  env = process.env,
  command,
  timeoutMs = 15_000,
  spawnImpl = spawn,
}: DiscoverCliModelsOptions = {}): Promise<CliModelCatalog> {
  const executable = String(command || resolveCursorCommand(env) || "").trim();
  if (!executable) throw codedError("Cursor Agent CLI is not available; install cursor-agent or set BATON_CURSOR_PATH", "CLI_NOT_AVAILABLE");
  const modelsRun = await runCursorProcess(executable, ["models"], { cwd, env, timeoutMs, spawnImpl });
  if (modelsRun.code !== 0) {
    const detail = (modelsRun.stderr || modelsRun.stdout).trim();
    throw codedError(
      `Cursor model discovery failed (${modelsRun.code ?? "unknown"})${detail ? `: ${detail}` : ""}`,
      "CURSOR_MODEL_DISCOVERY_FAILED",
    );
  }
  let models: CliModel[];
  try {
    models = parseCursorModelText(modelsRun.stdout);
  } catch (error) {
    throw codedError(error instanceof Error ? error.message : String(error), "CURSOR_MODEL_DISCOVERY_FAILED");
  }
  let version: string | null = null;
  try {
    const versionRun = await runCursorProcess(executable, ["--version"], { cwd, env, timeoutMs, spawnImpl });
    if (versionRun.code === 0) version = versionRun.stdout.trim().split(/\r?\n/)[0] || null;
  } catch {
    version = null;
  }
  return { cli: "cursor", version, models };
}

export const cursorAdapter: CliAdapter = {
  id: "cursor",
  host: CURSOR_HOST_METADATA,
  resolveCommand: resolveCursorCommand,
  discoverModels: discoverCursorModels,
};
