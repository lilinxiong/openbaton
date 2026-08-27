import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
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
  normalizeCliRuntimeCapabilities,
  record,
  terminate,
} from "./shared.js";

/**
 * Claude Code exposes a native concurrency ceiling of 20 child agents and a
 * recognizable backpressure error once that cap is reached.
 */
export const CLAUDE_HOST_METADATA: CliHostMetadata = {
  id: "claude",
  skillPath: ".claude/skills/baton/SKILL.md",
  defaultMaxConcurrent: 20,
  maxConcurrentEnv: "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS",
  maxConcurrent: (env = process.env) => {
    const override = Number(String(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS || "").trim());
    if (Number.isFinite(override) && override > 0) return Math.floor(override);
    return 20;
  },
  executionHandleKind: "agent_id",
};

/** Resolve the installed Claude Code executable, without inventing a fallback path. */
export function resolveClaudeCommand(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = String(env.BATON_CLAUDE_PATH || "").trim();
  if (override) return isExecutableFile(override) ? override : null;
  return findBinaryOnPath("claude", env);
}

/**
 * The `default` picker row is a deferred alias: its target changes with the
 * account tier and settings cascade. Baton dispatches exact models only, so the
 * row contributes its default marker and never becomes a selectable model.
 */
const CLAUDE_DEFERRED_MODEL_VALUE = "default";

function effortLevels(value: unknown): CliModel["reasoning_efforts"] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, { id: string; description: string }>();
  for (const item of value) {
    const id = String(item || "").trim();
    if (!id) continue;
    byId.set(id, { id, description: "" });
  }
  return [...byId.values()];
}

/**
 * Normalize the `list_models` payload. Claude Code reports each row's canonical
 * wire model id in `resolvedModel`; that exact id is what an agent definition
 * can pin, so it is the model id Baton stores. Rows marked `disabled` are
 * visible but not selectable in the host, so they are excluded here.
 */
export function normalizeClaudeModels(value: unknown): CliModel[] {
  const envelope = record(value);
  const values = Array.isArray(value) ? value : envelope?.models;
  if (!Array.isArray(values)) throw new Error("Claude list_models response must contain a models array");
  const byId = new Map<string, CliModel>();
  let defaultId = "";
  for (const item of values) {
    const data = record(item);
    if (!data) continue;
    const rowValue = String(data.value ?? "").trim();
    const resolved = String(data.resolvedModel ?? data.resolved_model ?? "").trim();
    const id = resolved || rowValue;
    if (!id) continue;
    if (rowValue === CLAUDE_DEFERRED_MODEL_VALUE) {
      // Keep only the honest default marker from the deferred row.
      if (resolved) defaultId = resolved;
      continue;
    }
    if (data.disabled === true) continue;
    byId.set(id, {
      id,
      model: id,
      display_name: String(data.displayName ?? data.display_name ?? id).trim() || id,
      description: String(data.description || "").trim(),
      hidden: false,
      reasoning_efforts: data.supportsEffort === true
        ? effortLevels(data.supportedEffortLevels ?? data.supported_effort_levels)
        : [],
      // Claude Code reports which effort levels exist, never which one is the
      // model's default. Guessing one here would invent dispatch metadata.
      default_reasoning_effort: null,
      input_modalities: [],
      // The native child-agent call cannot express fast mode or a service
      // tier, so no speed/tier metadata is claimed for this host.
      additional_speed_tiers: [],
      service_tiers: [],
      default_service_tier: null,
      is_default: false,
    });
  }
  if (defaultId) {
    const current = byId.get(defaultId);
    if (current) byId.set(defaultId, { ...current, is_default: true });
  }
  return [...byId.values()];
}

interface ControlResponse {
  type?: unknown;
  subtype?: unknown;
  response?: UnknownRecord;
}

function runClaudeVersion(
  executable: string,
  { cwd, env, timeoutMs, spawnImpl }: DiscoverCliModelsOptions,
): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (spawnImpl || spawn)(executable, ["--version"], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
    } catch {
      resolve(null);
      return;
    }
    const stdout: string[] = [];
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminate(child);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs ?? 15_000);
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", () => { /* version detection must not fail discovery */ });
    child.on("error", () => finish(null));
    child.on("exit", (code) => finish(code === 0 ? stdout.join("").trim().split(/\r?\n/)[0] || null : null));
    child.stdin.end();
  });
}

/**
 * Discover exactly the models the Claude Code picker exposes. The SDK control
 * protocol `list_models` request is the host's own catalog authority: the
 * worker's provider, settings cascade, and enforcement policy decide the rows.
 * Baton never executes work through `claude -p`; this is discovery only.
 */
export async function discoverClaudeModels({
  cwd,
  env = process.env,
  command,
  timeoutMs = 15_000,
  spawnImpl = spawn,
}: DiscoverCliModelsOptions = {}): Promise<CliModelCatalog> {
  const executable = String(command || resolveClaudeCommand(env) || "").trim();
  if (!executable) throw codedError("Claude Code CLI is not available; install claude or set BATON_CLAUDE_PATH", "CLI_NOT_AVAILABLE");
  const discovered = await new Promise<{
    models: CliModel[];
    capabilities?: CliRuntimeCapabilities;
  }>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnImpl(executable, [
        "-p",
        "--verbose",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
      ], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      reject(codedError(`Claude model discovery failed: ${error instanceof Error ? error.message : String(error)}`, "CLAUDE_MODEL_DISCOVERY_FAILED"));
      return;
    }

    const lines = readline.createInterface({ input: child.stdout });
    const stderr: string[] = [];
    let settled = false;
    const finish = (error?: Error, value?: {
      models: CliModel[];
      capabilities?: CliRuntimeCapabilities;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      terminate(child);
      if (error) reject(error);
      else resolve(value || { models: [] });
    };
    const timer = setTimeout(() => {
      finish(codedError("Claude model discovery timed out", "CLAUDE_MODEL_DISCOVERY_TIMEOUT"));
    }, timeoutMs);

    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("error", (error) => finish(codedError(`Claude model discovery failed: ${error.message}`, "CLAUDE_MODEL_DISCOVERY_FAILED")));
    child.on("exit", (code) => {
      if (settled) return;
      const detail = stderr.join("").trim();
      finish(codedError(
        `Claude Code exited before list_models completed (${code ?? "unknown"})${detail ? `: ${detail}` : ""}`,
        "CLAUDE_MODEL_DISCOVERY_FAILED",
      ));
    });
    lines.on("line", (line) => {
      let message: ControlResponse;
      try { message = JSON.parse(line) as ControlResponse; } catch { return; }
      if (message.type !== "control_response") return;
      const response = record(message.response);
      if (!response || response.request_id !== "baton-list-models") return;
      if (response.subtype !== "success") {
        finish(codedError(`Claude list_models failed: ${JSON.stringify(response.error ?? response.subtype)}`, "CLAUDE_MODEL_DISCOVERY_FAILED"));
        return;
      }
      try {
        const capabilities = normalizeCliRuntimeCapabilities(response.response);
        finish(undefined, {
          models: normalizeClaudeModels(response.response),
          ...(capabilities ? { capabilities } : {}),
        });
      } catch (error) {
        finish(codedError(error instanceof Error ? error.message : String(error), "CLAUDE_MODEL_DISCOVERY_FAILED"));
      }
    });

    child.stdin.write(`${JSON.stringify({
      type: "control_request",
      request_id: "baton-list-models",
      request: { subtype: "list_models" },
    })}\n`);
  });
  if (!discovered.models.length) {
    throw codedError("Claude list_models returned no selectable models", "CLAUDE_MODEL_DISCOVERY_FAILED");
  }
  const version = await runClaudeVersion(executable, { cwd, env, timeoutMs, spawnImpl });
  return {
    cli: "claude",
    version,
    models: discovered.models,
    ...(discovered.capabilities ? { capabilities: discovered.capabilities } : {}),
  };
}

export const claudeAdapter: CliAdapter = {
  id: "claude",
  host: CLAUDE_HOST_METADATA,
  resolveCommand: resolveClaudeCommand,
  discoverModels: discoverClaudeModels,
};
