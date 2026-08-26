import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { findBinaryOnPath, isExecutableFile } from "../lib/executables.js";
import type { UnknownRecord } from "../types.js";
import type {
  CliAdapter,
  CliHostMetadata,
  CliModel,
  CliModelCatalog,
  CliRuntimeCapabilities,
  DiscoverCliModelsOptions,
} from "./contract.js";
import {
  codedError,
  mergeCliRuntimeCapabilities,
  normalizeCliRuntimeCapabilities,
  normalizeReasoningEfforts,
  normalizeServiceTiers,
  record,
  strings,
  terminate,
} from "./shared.js";

export const CODEX_HOST_METADATA: CliHostMetadata = {
  id: "codex",
  skillPath: ".codex/skills/baton/SKILL.md",
  defaultMaxConcurrent: 4,
  maxConcurrent: () => 4,
  isInvoking: (env = process.env) =>
    Boolean(String(env.CODEX_SANDBOX || env.CODEX_INTERNAL || "").trim()),
  guard: true,
  executionHandleKind: "task_name",
};

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

interface RpcResponse {
  id?: number;
  result?: UnknownRecord;
  error?: unknown;
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
    let capabilities: CliRuntimeCapabilities | undefined;
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
      else resolve({
        cli: "codex",
        version,
        models: normalizeCodexModels(models),
        ...(capabilities ? { capabilities } : {}),
      });
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
        capabilities = mergeCliRuntimeCapabilities(
          capabilities,
          normalizeCliRuntimeCapabilities(message.result),
        );
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
        capabilities = mergeCliRuntimeCapabilities(
          capabilities,
          normalizeCliRuntimeCapabilities(message.result),
        );
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
        clientInfo: { name: "openbaton", title: "OpenBaton", version: "0.2.0" },
      },
    });
  });
}

export const codexAdapter: CliAdapter = {
  id: "codex",
  host: CODEX_HOST_METADATA,
  resolveCommand: resolveCodexCommand,
  discoverModels: discoverCodexModels,
};
