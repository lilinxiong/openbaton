import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { findBinaryOnPath, isExecutableFile } from "./executables.js";
import type { CodedError, UnknownRecord } from "../types.js";

export const CLI_IDS = ["codex", "grok"] as const;
export type CliId = (typeof CLI_IDS)[number];

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

export interface CliModelCatalog {
  cli: CliId;
  version: string | null;
  models: CliModel[];
}

export interface DiscoverCliModelsOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
}

export type CliModelDiscovery = (
  cli: CliId,
  options?: DiscoverCliModelsOptions,
) => Promise<CliModelCatalog>;

/** Resolve the selected Codex CLI, with the desktop bundle as a fallback. */
export function resolveCodexCommand(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = String(env.BATON_CODEX_PATH || "").trim();
  if (override) return isExecutableFile(override) ? override : null;
  const onPath = findBinaryOnPath("codex", env);
  if (onPath) return onPath;
  const home = String(env.HOME || env.USERPROFILE || "").trim();
  const bundled = [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    ...(home ? [
      path.join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
      path.join(home, "Applications", "Codex.app", "Contents", "Resources", "codex"),
    ] : []),
  ];
  return bundled.find(isExecutableFile) || null;
}

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

function normalizeReasoningEfforts(value: unknown): CliReasoningEffort[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, CliReasoningEffort>();
  for (const item of value) {
    const data = record(item);
    const id = String(data?.reasoningEffort ?? data?.reasoning_effort ?? data?.id ?? item ?? "").trim();
    if (!id) continue;
    byId.set(id, {
      id,
      description: String(data?.description || "").trim(),
    });
  }
  return [...byId.values()];
}

function normalizeServiceTiers(value: unknown): CliServiceTier[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, CliServiceTier>();
  for (const item of value) {
    const data = record(item);
    const id = String(data?.id ?? item ?? "").trim();
    if (!id) continue;
    byId.set(id, {
      id,
      name: String(data?.name || id).trim(),
      description: String(data?.description || "").trim(),
    });
  }
  return [...byId.values()];
}

/** Normalize the picker-visible `model/list` payload without inventing models. */
export function normalizeCodexModels(value: unknown): CliModel[] {
  const envelope = record(value);
  const values = Array.isArray(value) ? value : envelope?.data;
  if (!Array.isArray(values)) throw new Error("Codex model/list response must contain a data array");
  const byId = new Map<string, CliModel>();
  for (const item of values) {
    const data = record(item);
    if (!data) continue;
    const id = String(data.id ?? data.model ?? "").trim();
    if (!id || data.hidden === true) continue;
    byId.set(id, {
      id,
      model: String(data.model || id).trim() || id,
      display_name: String(data.displayName ?? data.display_name ?? id).trim() || id,
      description: String(data.description || "").trim(),
      hidden: false,
      reasoning_efforts: normalizeReasoningEfforts(data.supportedReasoningEfforts ?? data.reasoning_efforts),
      default_reasoning_effort: String(data.defaultReasoningEffort ?? data.default_reasoning_effort ?? "").trim() || null,
      input_modalities: strings(data.inputModalities ?? data.input_modalities),
      additional_speed_tiers: strings(data.additionalSpeedTiers ?? data.additional_speed_tiers),
      service_tiers: normalizeServiceTiers(data.serviceTiers ?? data.service_tiers),
      default_service_tier: String(data.defaultServiceTier ?? data.default_service_tier ?? "").trim() || null,
      is_default: data.isDefault === true || data.is_default === true,
    });
  }
  return [...byId.values()];
}

function codedError(message: string, code: string): CodedError {
  const error = new Error(message) as CodedError;
  error.code = code;
  return error;
}

interface RpcResponse {
  id?: number;
  result?: UnknownRecord;
  error?: unknown;
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  child.stdin.end();
  if (!child.killed) child.kill("SIGTERM");
}

/**
 * Discover exactly what the local Codex picker exposes. The app-server
 * handshake and model/list pagination follow the public Codex protocol.
 */
export async function discoverCodexModels({
  cwd,
  env = process.env,
  command,
  timeoutMs = 15_000,
  spawnImpl = spawn,
}: DiscoverCliModelsOptions = {}): Promise<CliModelCatalog> {
  const executable = String(command || resolveCodexCommand(env) || "").trim();
  if (!executable) throw codedError("Codex CLI is not available; install Codex or set BATON_CODEX_PATH", "CLI_NOT_AVAILABLE");
  return await new Promise<CliModelCatalog>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnImpl(executable, ["app-server"], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      reject(codedError(`Codex model discovery failed: ${error instanceof Error ? error.message : String(error)}`, "CODEX_MODEL_DISCOVERY_FAILED"));
      return;
    }

    const lines = readline.createInterface({ input: child.stdout });
    const stderr: string[] = [];
    const models: CliModel[] = [];
    let requestId = 1;
    let version: string | null = null;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      terminate(child);
      if (error) reject(error);
      else resolve({ cli: "codex", version, models: normalizeCodexModels(models) });
    };
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const requestPage = (cursor?: string) => {
      requestId += 1;
      send({
        method: "model/list",
        id: requestId,
        params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) },
      });
    };
    const timer = setTimeout(() => {
      finish(codedError("Codex model discovery timed out", "CODEX_MODEL_DISCOVERY_TIMEOUT"));
    }, timeoutMs);

    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("error", (error) => finish(codedError(`Codex model discovery failed: ${error.message}`, "CODEX_MODEL_DISCOVERY_FAILED")));
    child.on("exit", (code) => {
      if (settled) return;
      const detail = stderr.join("").trim();
      finish(codedError(
        `Codex app-server exited before model/list completed (${code ?? "unknown"})${detail ? `: ${detail}` : ""}`,
        "CODEX_MODEL_DISCOVERY_FAILED",
      ));
    });
    lines.on("line", (line) => {
      let message: RpcResponse;
      try { message = JSON.parse(line) as RpcResponse; } catch { return; }
      if (message.id === 0) {
        if (message.error) {
          finish(codedError(`Codex initialize failed: ${JSON.stringify(message.error)}`, "CODEX_MODEL_DISCOVERY_FAILED"));
          return;
        }
        version = String(message.result?.userAgent || "").trim() || null;
        send({ method: "initialized", params: {} });
        requestPage();
        return;
      }
      if (message.id !== requestId) return;
      if (message.error) {
        finish(codedError(`Codex model/list failed: ${JSON.stringify(message.error)}`, "CODEX_MODEL_DISCOVERY_FAILED"));
        return;
      }
      try {
        models.push(...normalizeCodexModels(message.result));
      } catch (error) {
        finish(codedError(error instanceof Error ? error.message : String(error), "CODEX_MODEL_DISCOVERY_FAILED"));
        return;
      }
      const cursor = String(message.result?.nextCursor ?? message.result?.next_cursor ?? "").trim();
      if (cursor) requestPage(cursor);
      else finish();
    });

    send({
      method: "initialize",
      id: 0,
      params: {
        clientInfo: { name: "openbaton", title: "OpenBaton", version: "0.1.0" },
      },
    });
  });
}

/** Resolve the official Grok Build binary, without inventing a fallback path. */
export function resolveGrokCommand(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = String(env.BATON_GROK_PATH || "").trim();
  if (override) return isExecutableFile(override) ? override : null;
  return findBinaryOnPath("grok", env);
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

function parseGrokModelText(stdout: string): CliModel[] {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Grok models text was empty");
  try {
    return normalizeGrokModels(JSON.parse(trimmed));
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof Error && /envelope|array/.test(error.message))) {
      /* keep scanning text */
    }
  }
  const byId = new Map<string, CliModel>();
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const stripped = line.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "");
    const token = stripped.split(/\s+/)[0]?.replace(/[,:;]+$/, "") || "";
    if (!/^[A-Za-z][A-Za-z0-9._:/-]*$/.test(token)) continue;
    if (["available", "models", "model", "name", "id", "default"].includes(token.toLowerCase())) continue;
    if (byId.has(token)) continue;
    byId.set(token, {
      id: token,
      model: token,
      display_name: token,
      description: "",
      hidden: false,
      reasoning_efforts: [],
      default_reasoning_effort: null,
      input_modalities: [],
      additional_speed_tiers: [],
      service_tiers: [],
      default_service_tier: null,
      is_default: /\bdefault\b/i.test(stripped),
    });
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
 * Discover exactly the models `grok models` reports. Prefer --json, then
 * parse text ids. Baton never executes work via grok -p.
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
  const jsonRun = await runGrokProcess(executable, ["models", "--json"], { cwd, env, timeoutMs, spawnImpl });
  let models: CliModel[] | null = null;
  if (jsonRun.code === 0) {
    try {
      models = normalizeGrokModels(JSON.parse(jsonRun.stdout));
    } catch {
      models = null;
    }
  }
  if (!models) {
    const textRun = await runGrokProcess(executable, ["models"], { cwd, env, timeoutMs, spawnImpl });
    if (textRun.code !== 0) {
      const detail = (textRun.stderr || textRun.stdout || jsonRun.stderr || jsonRun.stdout).trim();
      throw codedError(
        `Grok model discovery failed (${textRun.code ?? "unknown"})${detail ? `: ${detail}` : ""}`,
        "GROK_MODEL_DISCOVERY_FAILED",
      );
    }
    try {
      models = parseGrokModelText(textRun.stdout);
    } catch (error) {
      throw codedError(error instanceof Error ? error.message : String(error), "GROK_MODEL_DISCOVERY_FAILED");
    }
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

export const discoverCliModels: CliModelDiscovery = async (cli, options) => {
  if (cli === "codex") return discoverCodexModels(options);
  if (cli === "grok") return discoverGrokModels(options);
  throw codedError(`unsupported CLI: ${cli}`, "CLI_NOT_SUPPORTED");
};
