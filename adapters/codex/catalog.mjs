#!/usr/bin/env node

/**
 * Codex's picker catalog adapter.
 *
 * This file intentionally has no dependency on Baton internals.  It is an
 * executable package boundary: stdout is one normalized JSON catalog and all
 * app-server diagnostics stay on stderr.  The app-server itself remains the
 * authority for model ids and optional picker metadata.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export const ADAPTER_ID = "codex";
export const CATALOG_TIMEOUT_MS = 30000;
export const APP_SERVER_ARGS = ["app-server", "--stdio"];

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
    const id = text(row?.reasoningEffort ?? row?.reasoning_effort ?? row?.id);
    if (!id) continue;
    byId.set(id, { id, description: text(row?.description) });
  }
  return [...byId.values()];
}

function normalizeServiceTiers(value) {
  if (!Array.isArray(value)) return [];
  const byId = new Map();
  for (const item of value) {
    const row = record(item);
    const id = text(row?.id);
    if (!id) continue;
    byId.set(id, {
      id,
      name: text(row?.name, id) || id,
      description: text(row?.description),
    });
  }
  return [...byId.values()];
}

/** Normalize the exact visible rows returned by Codex `model/list`. */
export function normalizeCodexModels(value) {
  const envelope = record(value);
  const rows = Array.isArray(value) ? value : envelope?.data;
  if (!Array.isArray(rows)) throw new Error("Codex model/list response must contain a data array");
  const byId = new Map();
  for (const item of rows) {
    const row = record(item);
    if (!row) continue;
    const id = text(row.id ?? row.model);
    if (!id || row.hidden === true) continue;
    // The last occurrence is retained, matching the picker payload's exact
    // id semantics while making malformed duplicate pages deterministic.
    byId.set(id, {
      // Retain app-server fields that this adapter does not interpret. The
      // normalized fields below are the public contract, while unknown picker
      // metadata remains available to callers that need it.
      ...row,
      id,
      model: text(row.model, id) || id,
      display_name: text(row.displayName ?? row.display_name, id) || id,
      description: text(row.description),
      hidden: false,
      reasoning_efforts: normalizeReasoningEfforts(row.supportedReasoningEfforts ?? row.reasoning_efforts),
      default_reasoning_effort: text(row.defaultReasoningEffort ?? row.default_reasoning_effort) || null,
      input_modalities: stringList(row.inputModalities ?? row.input_modalities),
      additional_speed_tiers: stringList(row.additionalSpeedTiers ?? row.additional_speed_tiers),
      service_tiers: normalizeServiceTiers(row.serviceTiers ?? row.service_tiers),
      default_service_tier: text(row.defaultServiceTier ?? row.default_service_tier) || null,
      is_default: row.isDefault === true || row.is_default === true,
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
  const names = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
  if (!raw) return [];
  return raw.split(path.delimiter).filter(Boolean).flatMap((dir) => names.map((name) => path.resolve(dir, name)));
}

/**
 * Resolve Codex in a stable order: explicit override, PATH entries in order,
 * then the known desktop bundle locations. An invalid explicit override is a
 * hard failure rather than an invitation to silently use another binary.
 */
export function resolveCodexCommand(env = process.env) {
  const override = text(env.BATON_CODEX_PATH);
  if (override) {
    const resolved = path.resolve(override);
    return executable(resolved) ? resolved : null;
  }
  for (const candidate of pathCandidates(env)) if (executable(candidate)) return candidate;
  const home = text(env.HOME || env.USERPROFILE);
  const bundleCandidates = [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    ...(home ? [
      path.join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
      path.join(home, "Applications", "Codex.app", "Contents", "Resources", "codex"),
    ] : []),
  ];
  return bundleCandidates.find(executable) || null;
}


function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function runAppServer(executable, { cwd, env, timeoutMs = CATALOG_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, APP_SERVER_ARGS, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new Error(`CODEX_CATALOG_SPAWN_FAILED: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const lines = readline.createInterface({ input: child.stdout });
    const stderr = [];
    const models = [];
    let requestId = 0;
    let expectedId = null;
    let version = null;
    let settled = false;
    let pageCount = 0;

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
    const timer = setTimeout(() => fail("CODEX_CATALOG_TIMEOUT: app-server model/list timed out"), timeoutMs);

    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.once("error", (error) => fail(`CODEX_CATALOG_FAILED: ${error.message}`));
    child.once("close", (code) => {
      if (settled) return;
      const detail = stderr.join("").trim();
      fail(`CODEX_CATALOG_FAILED: app-server exited before model/list (${code ?? "unknown"})${detail ? `: ${detail}` : ""}`);
    });
    lines.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const response = record(message);
      if (!response) return;
      if (response.id === 0) {
        if (response.error) {
          fail(`CODEX_CATALOG_FAILED: initialize failed: ${JSON.stringify(response.error)}`);
          return;
        }
        const result = record(response.result);
        version = text(result?.userAgent) || null;
        send(child, { method: "initialized", params: {} });
        requestId += 1;
        expectedId = requestId;
        send(child, { method: "model/list", id: requestId, params: { limit: 100, includeHidden: false } });
        return;
      }
      if (response.id !== expectedId) return;
      if (response.error) {
        fail(`CODEX_CATALOG_FAILED: model/list failed: ${JSON.stringify(response.error)}`);
        return;
      }
      const result = record(response.result);
      try {
        models.push(...normalizeCodexModels(result));
      } catch (error) {
        fail(`CODEX_CATALOG_INVALID: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const cursor = text(result?.nextCursor ?? result?.next_cursor);
      if (cursor) {
        pageCount += 1;
        if (pageCount > 1000) {
          fail("CODEX_CATALOG_INVALID: pagination exceeded 1000 pages");
          return;
        }
        requestId += 1;
        expectedId = requestId;
        send(child, { method: "model/list", id: requestId, params: { limit: 100, includeHidden: false, cursor } });
      } else {
        const normalized = normalizeCodexModels(models);
        if (!normalized.length) {
          fail("CODEX_CATALOG_INVALID: model/list returned no picker-visible models");
          return;
        }
        finish(null, { adapter_id: ADAPTER_ID, version, models: normalized });
      }
    });

    send(child, {
      method: "initialize",
      id: 0,
      params: {
        clientInfo: { name: "openbaton-codex-adapter", title: "OpenBaton Codex adapter", version: "0.2.0" },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

export async function discoverCodexCatalog({ cwd = process.cwd(), env = process.env, command, timeoutMs } = {}) {
  const executable = command ? path.resolve(command) : resolveCodexCommand(env);
  if (!executable || !executable.trim()) throw new Error("CODEX_CLI_NOT_AVAILABLE: install Codex or set BATON_CODEX_PATH");
  return runAppServer(executable, { cwd, env, timeoutMs });
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
  discoverCodexCatalog({ cwd: process.cwd(), env: process.env })
    .then((catalog) => process.stdout.write(`${JSON.stringify(catalog)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
