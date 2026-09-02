/**
 * Shared micro-helpers for the compiled-apply CLI handler. Split from
 * compiled-apply-cli.ts (leaf module).
 */
import path from "node:path";
import { sessionScope } from "../spawn.js";
import { ApplyExecutionPlan } from "../apply-plan.js";
import {
  HostId,
  resolveRuntimeHost
} from "../hosts.js";
import type { CompiledApplyInvocation } from "../../cli.js";
import { CompiledApplyCliError } from "./compiled-cli.js";
import fs from "node:fs";

export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function sorted(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => text(value)).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

export function errorCode(error: unknown, fallback: string): string {
  return record(error) && typeof error.code === "string" && error.code.trim() ? error.code : fallback;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function coded(error: unknown, fallback: string): CompiledApplyCliError {
  const code = errorCode(error, fallback);
  const message = errorMessage(error);
  if (message.startsWith(`${code}:`)) return new CompiledApplyCliError(code, message);
  return new CompiledApplyCliError(code, `${code}: ${message}`);
}

export function requireHost(input: CompiledApplyInvocation): HostId {
  try {
    return resolveRuntimeHost({ cwd: input.cwd, env: input.env, explicitHost: input.host });
  } catch (error) {
    throw coded(error, "HOST_REQUIRED");
  }
}

export function requireSession(env: NodeJS.ProcessEnv): string {
  try {
    return sessionScope(env).session_uid;
  } catch (error) {
    throw coded(error, "SESSION_SCOPE_REQUIRED");
  }
}

export function canonicalChange(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  return normalized.split("/").filter(Boolean).at(-1) || normalized;
}

export function samePath(left: string, right: string, cwd: string): boolean {
  try {
    return fs.realpathSync(resolveInvocationPath(cwd, left)) === fs.realpathSync(resolveInvocationPath(cwd, right));
  } catch {
    return resolveInvocationPath(cwd, left) === resolveInvocationPath(cwd, right);
  }
}

export function resolveInvocationPath(cwd: string, value: string): string {
  return path.resolve(cwd, value);
}

export function requirePlan(input: CompiledApplyInvocation): ApplyExecutionPlan {
  if (typeof input.plan !== "string" || !input.plan.trim()) {
    throw new CompiledApplyCliError("COMPILED_APPLY_PLAN_REQUIRED", "COMPILED_APPLY_PLAN_REQUIRED: --plan-file did not provide a plan");
  }
  try {
    // The ingestion API performs the same validation.  Parsing here gives the
    // CLI a chance to resolve identity before any source capture occurs.
    return JSON.parse(input.plan) as ApplyExecutionPlan;
  } catch (error) {
    throw coded(error, "INVALID_JSON");
  }
}

export function planUnitReads(unit: ApplyExecutionPlan["units"][number]): string[] {
  const raw = unit as unknown as Record<string, unknown>;
  const values = [raw.read_context, raw.readContext, raw.read_paths, raw.readPaths, raw.read_inputs, raw.readInputs];
  return sorted(values.flatMap((value) => Array.isArray(value) ? value.map(String) : []));
}
