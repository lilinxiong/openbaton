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
