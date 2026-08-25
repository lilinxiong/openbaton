import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HOST_IDS = ["codex", "grok", "cursor"];

export function hostRouteSnapshotName(host) {
  return `cli-models-${String(host).trim().toLowerCase()}.json`;
}

export function userHome(env = process.env) {
  return env.HOME || os.homedir();
}

export function batonHome(env = process.env) {
  return path.join(userHome(env), ".baton");
}

export function hostRouteSnapshotPath(home, host) {
  return path.join(batonHome({ HOME: home }), "cache", hostRouteSnapshotName(host));
}

export function readRouteSnapshot(home, host) {
  const keyed = hostRouteSnapshotPath(home, host);
  if (!fs.existsSync(keyed)) return null;
  try {
    const snapshot = JSON.parse(fs.readFileSync(keyed, "utf8"));
    if (snapshot.schema_version !== 5 || snapshot.source !== "cli" || typeof snapshot.cli !== "string") return null;
    return snapshot.cli === host ? snapshot : null;
  } catch {
    return null;
  }
}

function detectInvokingHostFromEnv(env) {
  const explicit = String(env.BATON_HOST || "").trim().toLowerCase();
  if (explicit) return explicit;
  const matches = [];
  if (String(env.CURSOR_AGENT || "").trim() === "1" || String(env.CURSOR_CONVERSATION_ID || "").trim()) {
    matches.push("cursor");
  }
  if (String(env.CODEX_SANDBOX || env.CODEX_INTERNAL || "").trim()) matches.push("codex");
  if (String(env.GROK_AGENT || "").trim() === "1" || String(env.GROK_SESSION_ID || "").trim()) matches.push("grok");
  if (matches.length > 1) {
    fail(`ambiguous invoking host: ${matches.join(", ")} (set BATON_HOST to disambiguate)`);
  }
  return matches[0] || null;
}

function detectInvokingHostViaBaton() {
  const result = spawnSync("baton", ["host", "detect", "--json"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const index = result.stdout.indexOf("{");
  if (index < 0) return null;
  try {
    const payload = JSON.parse(result.stdout.slice(index));
    return payload.invoking || payload.resolved || null;
  } catch {
    return null;
  }
}

export function inferHostFromTickets(tickets) {
  const hosts = new Set();
  for (const ticket of tickets) {
    const value = ticket.target_host || ticket.dispatch_host || ticket.host || ticket.selection?.host;
    if (value) hosts.add(String(value).trim().toLowerCase());
  }
  if (hosts.size === 1) return [...hosts][0];
  if (hosts.size > 1) fail(`tickets disagree on target_host: ${[...hosts].join(", ")}`);
  return null;
}

export function resolveInvokingHost({ explicitHost, env = process.env, tickets = [] } = {}) {
  const normalized = String(explicitHost || "").trim().toLowerCase();
  if (normalized) {
    if (!HOST_IDS.includes(normalized)) fail(`invalid host: ${normalized} (expected ${HOST_IDS.join("|")})`);
    return normalized;
  }
  const fromEnv = detectInvokingHostFromEnv(env) || detectInvokingHostViaBaton();
  const fromTickets = inferHostFromTickets(tickets);
  if (fromEnv && fromTickets && fromEnv !== fromTickets) {
    fail(`invoking host ${fromEnv} does not match ticket target_host ${fromTickets}`);
  }
  const host = fromEnv || fromTickets;
  if (!host) {
    fail("could not determine invoking host; pass --host codex|grok|cursor or set BATON_HOST");
  }
  return host;
}

function fail(message) {
  throw new Error(String(message).trim());
}
