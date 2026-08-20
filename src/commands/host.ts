import {
  normalizeProviderQuotas,
  readHostCapabilitySnapshot,
  writeHostCapabilitySnapshot,
  type ProviderQuotaDisclosure,
} from "../lib/host-capabilities.js";
import {
  queryCodexBarFallback,
  resolveCodexBar,
  type CodexBarResolver,
  type CodexBarRunner,
} from "../lib/codexbar.js";
import { resolveOcx, runOcx, type OcxResolver, type OcxRunner } from "../lib/opencodex.js";
import { readRouteSnapshot } from "../lib/routes.js";
import type { WritableLike } from "../types.js";

interface HostCommandOptions {
  cwd: string;
  stdout: WritableLike;
  env?: NodeJS.ProcessEnv;
  runner?: OcxRunner;
  resolve?: OcxResolver;
  codexBarRunner?: CodexBarRunner;
  codexBarResolve?: CodexBarResolver;
}

function repeated(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== `--${name}`) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${name} requires an exact OpenCodex route id`);
    values.push(value.trim());
    index += 1;
  }
  return values;
}

function profileAssignments(values: string[], models: string[]): Record<string, string[]> {
  const profiles: Record<string, string[]> = Object.fromEntries(models.map((model) => [model, []]));
  for (const value of values) {
    const split = value.indexOf("=");
    const model = split > 0 ? value.slice(0, split).trim() : "";
    const efforts = split > 0 ? value.slice(split + 1).split(",").map((item) => item.trim()).filter(Boolean) : [];
    if (!model || !efforts.length) throw new Error(`invalid --profile assignment: ${value}; expected EXACT_ROUTE=EFFORT[,EFFORT...]`);
    if (!models.includes(model)) throw new Error(`--profile route was not declared with --model: ${model}`);
    profiles[model].push(...efforts);
  }
  for (const model of models) profiles[model] = [...new Set(profiles[model])].sort();
  return profiles;
}

export function runHost(args: string[], {
  cwd,
  stdout,
  env = process.env,
  runner,
  resolve,
  codexBarRunner,
  codexBarResolve,
}: HostCommandOptions): number {
  const sub = args[0] || "status";
  if (sub === "status") {
    const snapshot = readHostCapabilitySnapshot(cwd);
    stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return snapshot ? 0 : 1;
  }
  if (sub !== "sync") throw new Error("usage: baton host sync --model EXACT_ROUTE [--profile EXACT_ROUTE=EFFORT,...] | baton host status");

  const models = repeated(args.slice(1), "model").flatMap((value) => value.split(",").map((item) => item.trim()).filter(Boolean));
  if (!models.length) throw new Error("usage: baton host sync --model EXACT_ROUTE [--profile EXACT_ROUTE=EFFORT,...]");
  const profiles = profileAssignments(repeated(args.slice(1), "profile"), models);

  let quotaCatalog: unknown = null;
  let quotaRefreshError: string | null = null;
  try {
    const resolved = (resolve || resolveOcx)({ cwd, env });
    if (!resolved) throw new Error("OpenCodex quota command is unavailable");
    const result = runOcx(["provider", "quota", "--json"], { cwd, env, runner, resolved });
    if (result.status !== 0) throw new Error(`OpenCodex quota refresh failed (${result.status})`);
    quotaCatalog = JSON.parse(result.stdout);
  } catch (error) {
    quotaRefreshError = error instanceof Error ? error.message : String(error);
  }

  const catalog = readRouteSnapshot(cwd);
  const providers = [...new Set((catalog?.routes || [])
    .filter((route) => !route.disabled && models.includes(route.route_id))
    .map((route) => route.provider)
    .filter(Boolean))].sort();
  const openCodexQuota = new Map(normalizeProviderQuotas(quotaCatalog).map((item) => [item.provider, item]));
  const missingProviders = providers.filter((provider) => openCodexQuota.get(provider)?.status !== "reported");
  const quotaFallbacks: ProviderQuotaDisclosure[] = [];
  if (missingProviders.length) {
    const command = (codexBarResolve || resolveCodexBar)({ cwd, env });
    for (const provider of missingProviders) {
      const fallback = queryCodexBarFallback(provider, { cwd, env, command, runner: codexBarRunner });
      if (fallback) quotaFallbacks.push(fallback);
    }
  }

  const snapshot = writeHostCapabilitySnapshot(cwd, {
    advertisedModels: models,
    advertisedProfiles: profiles,
    quotaCatalog,
    quotaFallbacks,
    quotaRefreshError,
  });
  const live = new Set((catalog?.routes || []).filter((route) => !route.disabled).map((route) => route.route_id));
  const effective = snapshot.advertised_models.filter((model) => live.has(model));
  const hostOnly = snapshot.advertised_models.filter((model) => !live.has(model));
  const effectiveProfiles = Object.fromEntries((catalog?.routes || [])
    .filter((route) => !route.disabled && effective.includes(route.route_id))
    .map((route) => [route.route_id, (snapshot.advertised_profiles[route.route_id] || []).filter((profile) => route.reasoning_efforts.includes(profile))]));
  stdout.write(`${JSON.stringify({
    snapshot,
    effective_models: effective,
    host_only_models: hostOnly,
    effective_profiles: effectiveProfiles,
    note: "effective models/profiles are the exact intersection of current Codex spawn capabilities and executable OpenCodex routes",
  }, null, 2)}\n`);
  return effective.length ? 0 : 1;
}
