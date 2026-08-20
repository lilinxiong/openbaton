import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findBinaryOnPath } from "./opencodex.js";
import type { ProviderQuotaDisclosure, QuotaWindow } from "./host-capabilities.js";

export interface CodexBarRunResult {
  status: number;
  stdout: string;
  stderr: string;
  error: Error | null;
}

export interface CodexBarRunnerInput {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export type CodexBarRunner = (input: CodexBarRunnerInput) => CodexBarRunResult;
export type CodexBarResolver = (options: { env: NodeJS.ProcessEnv; cwd: string }) => string | null;

export interface QueryCodexBarQuotaOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  command: string;
  runner?: CodexBarRunner;
  now?: Date | string | number;
}

export interface QueryCodexBarGuiQuotaOptions {
  env?: NodeJS.ProcessEnv;
  now?: Date | string | number;
  snapshot?: unknown | null;
}

export interface QueryCodexBarFallbackOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  command: string | null;
  runner?: CodexBarRunner;
  now?: Date | string | number;
  snapshot?: unknown | null;
}

const CODEXBAR_TIMEOUT_MS = 15_000;

function isExecutableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** PATH first, then the standard per-machine/per-user macOS app helper. */
export function resolveCodexBar({ env = process.env }: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): string | null {
  const pathHit = findBinaryOnPath("codexbar", env) || findBinaryOnPath("CodexBar", env);
  if (pathHit) return pathHit;
  if (process.platform !== "darwin") return null;
  const userHome = env.HOME || os.homedir();
  for (const candidate of [
    "/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI",
    path.join(userHome, "Applications", "CodexBar.app", "Contents", "Helpers", "CodexBarCLI"),
  ]) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export function codexBarProviderId(provider: string): string | null {
  const id = String(provider || "").trim().toLowerCase();
  if (id === "openai") return "codex";
  return /^[a-z0-9][a-z0-9-]*$/.test(id) ? id : null;
}

export function defaultCodexBarRunner(input: CodexBarRunnerInput): CodexBarRunResult {
  const result = spawnSync(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    encoding: "utf8",
    timeout: input.timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status == null ? (result.error ? 1 : 0) : result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: result.error ? result.error as Error : null,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedPercent(value: unknown): number | null {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, number));
}

function isoTimestamp(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    const millis = value < 1_000_000_000_000 ? value * 1_000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeSource(value: unknown): string {
  const source = String(value || "").trim().toLowerCase();
  return /^[a-z0-9._-]{1,32}$/.test(source) ? source : "auto";
}

function durationLabel(minutes: unknown): string | null {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value === 300) return "5 hour";
  if (value === 1_440) return "Daily";
  if (value === 10_080) return "Weekly";
  if (value >= 40_000 && value <= 46_000) return "Monthly";
  if (value % 1_440 === 0) return `${value / 1_440} day`;
  if (value % 60 === 0) return `${value / 60} hour`;
  return `${value} minute`;
}

function normalizedWindow(name: string, label: string, value: unknown): QuotaWindow | null {
  const rate = record(value);
  const used = boundedPercent(rate?.usedPercent);
  if (used == null) return null;
  return {
    name,
    label,
    used_percent: used,
    remaining_percent: Math.max(0, 100 - used),
    resets_at: isoTimestamp(rate?.resetsAt),
  };
}

function windowsFromUsage(usage: Record<string, unknown>): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  for (const slot of ["primary", "secondary", "tertiary"] as const) {
    const rate = record(usage[slot]);
    if (!rate) continue;
    const duration = durationLabel(rate.windowMinutes);
    const label = duration ? `${slot[0].toUpperCase()}${slot.slice(1)} · ${duration}` : `${slot[0].toUpperCase()}${slot.slice(1)}`;
    const item = normalizedWindow(slot, label, rate);
    if (item) windows.push(item);
  }
  if (Array.isArray(usage.extraRateWindows)) {
    for (let index = 0; index < usage.extraRateWindows.length; index += 1) {
      const extra = record(usage.extraRateWindows[index]);
      const rate = record(extra?.window);
      if (!rate) continue;
      const duration = durationLabel(rate.windowMinutes);
      const label = duration ? `Extra ${index + 1} · ${duration}` : `Extra ${index + 1}`;
      const item = normalizedWindow(`extra_${index + 1}`, label, rate);
      if (item) windows.push(item);
    }
  }
  return windows;
}

function fallbackObservedAt(now: Date | string | number): string {
  const date = now instanceof Date ? now : new Date(now);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function unknownQuota(provider: string, codexBarProvider: string, observedAt: string, reason: string, source = "auto"): ProviderQuotaDisclosure {
  return {
    provider,
    label: provider,
    status: "unknown",
    source: `codexbar:${codexBarProvider}:${safeSource(source)}`,
    observed_at: observedAt,
    windows: [],
    reason,
    reverse_engineered: false,
  };
}

/**
 * Extract quota windows only. Account email/id, login method, cookies, credits,
 * and every other CodexBar field are intentionally ignored.
 */
export function normalizeCodexBarQuota(
  provider: string,
  codexBarProvider: string,
  value: unknown,
  now: Date | string | number = new Date(),
): ProviderQuotaDisclosure {
  const observedAt = fallbackObservedAt(now);
  const entries = (Array.isArray(value) ? value : [value]).map(record).filter((item): item is Record<string, unknown> => item !== null);
  const reported = entries.map((entry) => ({ entry, usage: record(entry.usage) }))
    .filter((item): item is { entry: Record<string, unknown>; usage: Record<string, unknown> } => item.usage !== null)
    .map(({ entry, usage }) => ({ entry, usage, windows: windowsFromUsage(usage) }))
    .filter((item) => item.windows.length > 0);
  if (reported.length > 1) return unknownQuota(provider, codexBarProvider, observedAt, "CODEXBAR_MULTIPLE_ACCOUNTS");
  if (reported.length === 0) {
    const source = String(entries[0]?.source || "auto");
    const reason = entries.some((entry) => record(entry.error)) ? "CODEXBAR_PROVIDER_UNAVAILABLE" : "CODEXBAR_QUOTA_NOT_REPORTED";
    return unknownQuota(provider, codexBarProvider, observedAt, reason, source);
  }
  const { entry, usage, windows } = reported[0];
  return {
    provider,
    label: provider,
    status: "reported",
    source: `codexbar:${codexBarProvider}:${safeSource(entry.source)}`,
    observed_at: isoTimestamp(usage.updatedAt) || observedAt,
    windows,
    reason: null,
    reverse_engineered: false,
  };
}

export function queryCodexBarQuota(provider: string, options: QueryCodexBarQuotaOptions): ProviderQuotaDisclosure | null {
  const codexBarProvider = codexBarProviderId(provider);
  if (!codexBarProvider) return null;
  const env = options.env || process.env;
  const runner = options.runner || defaultCodexBarRunner;
  const observedAt = fallbackObservedAt(options.now || new Date());
  const result = runner({
    command: options.command,
    args: [
      "usage", "--provider", codexBarProvider,
      "--format", "json", "--json-only", "--no-color",
      "--web-timeout", "10",
    ],
    cwd: options.cwd,
    env,
    timeoutMs: CODEXBAR_TIMEOUT_MS,
  });
  if (result.status !== 0 || result.error) {
    return unknownQuota(provider, codexBarProvider, observedAt, result.error ? "CODEXBAR_QUERY_FAILED" : "CODEXBAR_PROVIDER_UNAVAILABLE");
  }
  try {
    return normalizeCodexBarQuota(provider, codexBarProvider, JSON.parse(result.stdout), options.now || new Date());
  } catch {
    return unknownQuota(provider, codexBarProvider, observedAt, "CODEXBAR_INVALID_JSON");
  }
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || os.homedir();
}

function guiProviderKey(provider: string): string | null {
  const id = codexBarProviderId(provider);
  return id ? id.replace(/-/g, "") : null;
}

function safeLabel(value: unknown, fallback: string): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 64 || text.includes("@")) return fallback;
  return text;
}

function safeWindowName(value: unknown, fallback: string): string {
  const id = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(id) ? id : fallback;
}

function reportedQuota(
  provider: string,
  codexBarProvider: string,
  source: string,
  observedAt: string,
  windows: QuotaWindow[],
): ProviderQuotaDisclosure {
  return {
    provider,
    label: provider,
    status: "reported",
    source: `codexbar:${codexBarProvider}:${safeSource(source)}`,
    observed_at: observedAt,
    windows,
    reason: null,
    reverse_engineered: false,
  };
}

function windowsFromGuiEntry(entry: Record<string, unknown>): QuotaWindow[] {
  const rows = Array.isArray(entry.usageRows) ? entry.usageRows : [];
  if (!rows.length) return windowsFromUsage(entry);
  const windows: QuotaWindow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = record(rows[index]);
    if (!row) continue;
    const id = String(row.id || "").trim();
    const slot = record(id ? entry[id] : null) || record(row.window);
    const used = boundedPercent(slot?.usedPercent)
      ?? (Number.isFinite(Number(row.percentLeft)) ? boundedPercent(100 - Number(row.percentLeft)) : null);
    if (used == null) continue;
    const name = safeWindowName(id, `row_${index + 1}`);
    windows.push({
      name,
      label: safeLabel(row.title, name),
      used_percent: used,
      remaining_percent: Math.max(0, 100 - used),
      resets_at: isoTimestamp(slot?.resetsAt ?? row.resetsAt),
    });
  }
  return windows;
}

function findGuiEntry(snapshot: unknown, guiKey: string): Record<string, unknown> | null {
  const root = record(snapshot);
  const entries = Array.isArray(root?.entries) ? root.entries : [];
  for (const item of entries) {
    const entry = record(item);
    const provider = String(entry?.provider || "").trim().toLowerCase().replace(/-/g, "");
    if (entry && provider === guiKey) return entry;
  }
  return null;
}

/** Newest CodexBar menu-bar/widget snapshot under the user Library group container. */
export function loadCodexBarGuiSnapshot({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}): unknown | null {
  const groupRoot = path.join(homeDir(env), "Library", "Group Containers");
  let names: fs.Dirent[] = [];
  try {
    names = fs.readdirSync(groupRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = names
    .filter((item) => item.isDirectory() && (item.name.endsWith(".com.steipete.codexbar") || item.name === "com.steipete.codexbar"))
    .map((item) => path.join(groupRoot, item.name, "widget-snapshot.json"))
    .filter((file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const file of files) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
  }
  return null;
}

export function normalizeCodexBarGuiQuota(
  provider: string,
  snapshot: unknown,
  now: Date | string | number = new Date(),
): ProviderQuotaDisclosure | null {
  const codexBarProvider = codexBarProviderId(provider);
  const guiKey = guiProviderKey(provider);
  if (!codexBarProvider || !guiKey) return null;
  const entry = findGuiEntry(snapshot, guiKey);
  if (!entry) return null;
  const windows = windowsFromGuiEntry(entry);
  if (!windows.length) return null;
  const root = record(snapshot);
  const observedAt = isoTimestamp(entry.updatedAt) || isoTimestamp(root?.generatedAt) || fallbackObservedAt(now);
  return reportedQuota(provider, codexBarProvider, "widget", observedAt, windows);
}

function quotaFromCodexBarHistory(
  provider: string,
  options: { env?: NodeJS.ProcessEnv; now?: Date | string | number } = {},
): ProviderQuotaDisclosure | null {
  const codexBarProvider = codexBarProviderId(provider);
  const guiKey = guiProviderKey(provider);
  if (!codexBarProvider || !guiKey) return null;
  const file = path.join(
    homeDir(options.env || process.env),
    "Library", "Application Support", "com.steipete.codexbar", "history", `${guiKey}.json`,
  );
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const root = record(value);
  const groups = Array.isArray(root?.unscoped) ? root.unscoped : [];
  const windows: QuotaWindow[] = [];
  let observedAt: string | null = null;
  for (let index = 0; index < groups.length; index += 1) {
    const group = record(groups[index]);
    const entries = Array.isArray(group?.entries) ? group.entries : [];
    const last = record(entries[entries.length - 1]);
    const used = boundedPercent(last?.usedPercent);
    if (!last || used == null) continue;
    const name = safeWindowName(group?.name, `window_${index + 1}`);
    const duration = durationLabel(group?.windowMinutes);
    windows.push({
      name,
      label: duration || name,
      used_percent: used,
      remaining_percent: Math.max(0, 100 - used),
      resets_at: isoTimestamp(last.resetsAt),
    });
    observedAt = isoTimestamp(last.capturedAt) || observedAt;
  }
  if (!windows.length) return null;
  return reportedQuota(provider, codexBarProvider, "history", observedAt || fallbackObservedAt(options.now || new Date()), windows);
}

/** Informational GUI-matching quota: widget snapshot first, then local history. */
export function queryCodexBarGuiQuota(provider: string, options: QueryCodexBarGuiQuotaOptions = {}): ProviderQuotaDisclosure | null {
  const snapshot = options.snapshot === undefined ? loadCodexBarGuiSnapshot({ env: options.env }) : options.snapshot;
  const fromWidget = snapshot == null ? null : normalizeCodexBarGuiQuota(provider, snapshot, options.now);
  if (fromWidget) return fromWidget;
  return quotaFromCodexBarHistory(provider, { env: options.env, now: options.now });
}

export function queryCodexBarFallback(provider: string, options: QueryCodexBarFallbackOptions): ProviderQuotaDisclosure | null {
  const gui = queryCodexBarGuiQuota(provider, { env: options.env, now: options.now, snapshot: options.snapshot });
  if (gui?.status === "reported") return gui;
  if (!options.command) return null;
  return queryCodexBarQuota(provider, {
    cwd: options.cwd,
    env: options.env,
    command: options.command,
    runner: options.runner,
    now: options.now,
  });
}
