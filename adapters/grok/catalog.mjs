#!/usr/bin/env node

/**
 * Grok's picker catalog adapter.
 *
 * This file intentionally has no dependency on Baton internals. It is an
 * executable package boundary: stdout is one normalized JSON catalog and all
 * agent diagnostics stay on stderr. Grok's ACP `initialize` payload is the
 * authority for picker-visible model ids and optional metadata.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export const ADAPTER_ID = "grok";
export const CATALOG_TIMEOUT_MS = 30000;
export const AGENT_ARGS = ["agent", "--no-leader", "stdio"];

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function text(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
}

function normalizeReasoningEfforts(value) {
  if (!Array.isArray(value)) return [];
  const byId = new Map();
  for (const item of value) {
    const row = record(item);
    const id = text(row?.id ?? row?.value ?? row?.reasoningEffort ?? row?.reasoning_effort);
    if (!id) continue;
    byId.set(id, { id, description: text(row?.description ?? row?.label) });
  }
  return [...byId.values()];
}

function positiveLimit(value) {
  if (typeof value === "string" && value.trim()) value = Number(value.trim());
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return undefined;
  return value;
}

/** Read only a CLI-reported concurrent limit. Missing or invalid values stay unknown. */
export function concurrentSubagentsFromInitialize(result) {
  const root = record(result);
  if (!root) return undefined;
  const meta = record(root._meta) || {};
  const caps = record(root.agentCapabilities) || record(root.agent_capabilities) || {};
  const capsMeta = record(caps._meta) || {};
  const sources = [
    caps,
    capsMeta,
    record(capsMeta["x.ai/capabilities"]),
    meta,
    record(meta.subagents),
    record(meta.capabilities),
    record(root.capabilities),
  ];
  for (const source of sources) {
    if (!source) continue;
    const limit = positiveLimit(
      source.max_concurrent_subagents
      ?? source.maxConcurrentSubagents
      ?? source.max_concurrent
      ?? source.maxConcurrent,
    );
    if (limit !== undefined) return limit;
  }
  return undefined;
}

function defaultReasoningEffort(efforts, meta) {
  if (Array.isArray(efforts)) {
    for (const item of efforts) {
      const row = record(item);
      if (row && (row.default === true || row.is_default === true || row.isDefault === true)) {
        const id = text(row.id ?? row.value);
        if (id) return id;
      }
    }
  }
  return text(meta?.reasoningEffort ?? meta?.reasoning_effort ?? meta?.defaultReasoningEffort ?? meta?.default_reasoning_effort) || null;
}

function hiddenRow(row, meta) {
  return row.hidden === true || meta?.hidden === true;
}

/**
 * Normalize the exact picker-visible rows returned by Grok ACP initialize.
 * `availableModels` is the live catalog; hidden rows are not selectable.
 */
export function normalizeGrokModels(value, currentModelId = null) {
  const envelope = record(value);
  const rows = Array.isArray(value)
    ? value
    : envelope?.availableModels ?? envelope?.available_models ?? envelope?.data;
  if (!Array.isArray(rows)) throw new Error("Grok initialize response must contain an availableModels array");
  const selected = text(currentModelId ?? envelope?.currentModelId ?? envelope?.current_model_id);
  const byId = new Map();
  for (const item of rows) {
    const row = record(item);
    if (!row) continue;
    const meta = record(row._meta) || {};
    const id = text(row.modelId ?? row.model_id ?? row.id ?? row.model);
    if (!id || hiddenRow(row, meta)) continue;
    const reasoningSource = row.supportedReasoningEfforts ?? row.reasoning_efforts ?? meta.reasoningEfforts ?? meta.reasoning_efforts;
    byId.set(id, {
      // Retain picker fields that this adapter does not interpret. The
      // normalized fields below are the public contract, while unknown
      // metadata remains available to callers that need it.
      ...row,
      id,
      model: text(row.model, id) || id,
      display_name: text(row.name ?? row.displayName ?? row.display_name, id) || id,
      description: text(row.description ?? meta.description),
      hidden: false,
      reasoning_efforts: normalizeReasoningEfforts(reasoningSource),
      default_reasoning_effort: defaultReasoningEffort(reasoningSource, { ...meta, ...row }),
      input_modalities: stringList(row.inputModalities ?? row.input_modalities ?? meta.inputModalities ?? meta.input_modalities),
      additional_speed_tiers: stringList(row.additionalSpeedTiers ?? row.additional_speed_tiers ?? meta.additionalSpeedTiers ?? meta.additional_speed_tiers),
      service_tiers: [],
      default_service_tier: text(row.defaultServiceTier ?? row.default_service_tier ?? meta.defaultServiceTier) || null,
      is_default: row.isDefault === true || row.is_default === true || id === selected,
    });
  }
  return [...byId.values()];
}

function executable(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function pathCandidates(env) {
  const raw = text(env.PATH);
  const names = process.platform === "win32" ? ["grok.exe", "grok.cmd", "grok"] : ["grok"];
  if (!raw) return [];
  return raw.split(path.delimiter).filter(Boolean).flatMap((dir) => names.map((name) => path.resolve(dir, name)));
}

function grokHome(env) {
  const explicit = text(env.GROK_HOME);
  if (explicit) return path.resolve(explicit);
  const home = text(env.HOME || env.USERPROFILE);
  return home ? path.join(home, ".grok") : "";
}

/**
 * Resolve Grok in a stable order: explicit override, PATH entries in order,
 * then the known user-install locations. An invalid explicit override is a
 * hard failure rather than an invitation to silently use another binary.
 */
export function resolveGrokCommand(env = process.env) {
  const override = text(env.BATON_GROK_PATH);
  if (override) {
    const resolved = path.resolve(override);
    return executable(resolved) ? resolved : null;
  }
  for (const candidate of pathCandidates(env)) if (executable(candidate)) return candidate;
  const home = grokHome(env);
  const known = home ? [
    path.join(home, "bin", "grok"),
    path.join(home, "bin", "grok.exe"),
    path.join(home, "bin", "agent"),
  ] : [];
  return known.find(executable) || null;
}

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function modelStateFromInitialize(result) {
  const root = record(result);
  if (!root) return null;
  const meta = record(root._meta) || {};
  return record(meta.modelState) || record(meta.model_state) || record(root.modelState) || record(root.model_state) || root;
}

function catalogSpawnEnv(env) {
  const next = { ...env };
  // Catalog discovery is a fresh ACP client. Do not inherit the invoking
  // TUI session identity or attach to its leader.
  delete next.GROK_SESSION_ID;
  delete next.GROK_AGENT;
  return next;
}

function runAgentCatalog(executablePath, { cwd, env, timeoutMs = CATALOG_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executablePath, AGENT_ARGS, {
        cwd,
        env: catalogSpawnEnv(env || process.env),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new Error(`GROK_CATALOG_SPAWN_FAILED: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const lines = readline.createInterface({ input: child.stdout });
    const stderr = [];
    let settled = false;
    const requestId = 1;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      try { child.stdin.end(); } catch { /* already closed */ }
      if (!child.killed) child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value);
    };
    const fail = (message) => finish(new Error(message));
    const timer = setTimeout(() => fail("GROK_CATALOG_TIMEOUT: agent initialize timed out"), timeoutMs);

    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.once("error", (error) => fail(`GROK_CATALOG_FAILED: ${error.message}`));
    child.once("close", (code) => {
      if (settled) return;
      const detail = stderr.join("").trim();
      const auth = /auth|login|unauthor/i.test(detail) ? "authentication failed" : `agent exited before initialize (${code ?? "unknown"})`;
      fail(`GROK_CATALOG_FAILED: ${auth}${detail ? `: ${detail}` : ""}`);
    });
    lines.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message;
      try { message = JSON.parse(trimmed); } catch {
        // ACP is JSON-RPC NDJSON. Prose, banners, and login text are not a catalog.
        return;
      }
      const response = record(message);
      if (!response) return;
      if (response.id !== requestId) return;
      if (response.error) {
        const err = record(response.error);
        const messageText = text(err?.message) || JSON.stringify(response.error);
        const auth = /auth|login|unauthor/i.test(messageText);
        fail(`GROK_CATALOG_FAILED: ${auth ? "authentication failed: " : "initialize failed: "}${messageText}`);
        return;
      }
      const result = record(response.result);
      const meta = record(result?._meta) || {};
      const state = modelStateFromInitialize(result);
      const cursor = text(state?.nextCursor ?? state?.next_cursor);
      if (cursor) {
        fail("GROK_CATALOG_INVALID: initialize catalog pagination is incomplete");
        return;
      }
      try {
        const models = normalizeGrokModels(state, state?.currentModelId ?? state?.current_model_id ?? meta.currentModelId);
        if (!models.length) {
          fail("GROK_CATALOG_INVALID: initialize returned no picker-visible models");
          return;
        }
        const concurrent = concurrentSubagentsFromInitialize(result);
        finish(null, {
          adapter_id: ADAPTER_ID,
          version: text(meta.agentVersion ?? meta.agent_version ?? result?.agentVersion) || null,
          models,
          ...(concurrent === undefined ? {} : { capabilities: { max_concurrent_subagents: concurrent } }),
        });
      } catch (error) {
        fail(`GROK_CATALOG_INVALID: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    send(child, {
      jsonrpc: "2.0",
      id: requestId,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientInfo: { name: "openbaton-grok-adapter", title: "OpenBaton Grok adapter", version: "1.0.0" },
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      },
    });
  });
}

export async function discoverGrokCatalog({ cwd = process.cwd(), env = process.env, command, timeoutMs } = {}) {
  const executablePath = command ? path.resolve(command) : resolveGrokCommand(env);
  if (!executablePath || !executablePath.trim()) throw new Error("GROK_CLI_NOT_AVAILABLE: install Grok or set BATON_GROK_PATH");
  return runAgentCatalog(executablePath, { cwd, env, timeoutMs });
}

// macOS exposes /var as a symlink to /private/var. Compare canonical paths so
// a package copied into a temporary HOME is executable from Bun, Node, and a
// directly invoked shebang alike.
const invokedPath = process.argv[1] ? (() => {
  try { return fs.realpathSync(process.argv[1]); } catch { return path.resolve(process.argv[1]); }
})() : "";
const modulePath = (() => {
  try { return fs.realpathSync(new URL(import.meta.url)); } catch { return fileURLToPath(import.meta.url); }
})();

if (invokedPath === modulePath) {
  discoverGrokCatalog({ cwd: process.cwd(), env: process.env })
    .then((catalog) => process.stdout.write(`${JSON.stringify(catalog)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
