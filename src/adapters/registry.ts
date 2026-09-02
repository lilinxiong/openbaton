import type {
  CliAdapter,
  CliId,
} from "./contract.js";
import { discoverAdapters, type DiscoveredAdapter } from "./sdk.js";

function discovered(env: NodeJS.ProcessEnv = process.env): DiscoveredAdapter[] {
  return discoverAdapters(env);
}

/** The only source of truth for supported CLI adapters in this release. */
function toCliAdapter(adapter: DiscoveredAdapter): CliAdapter {
  const { manifest, directory } = adapter;
  // Schema-1 manifests may omit a concurrent quota. Missing is unknown, not a
  // guessed host limit; the director default applies until the catalog reports
  // a live CLI value. The root agent is never part of this count.
  const reported = manifest.quota.max_concurrent_subagents;
  const maxConcurrent = () => reported ?? Number.NaN;
  return {
    id: manifest.adapter.id,
    host: { id: manifest.adapter.id, skillPath: manifest.runtime_skill.destination,
      defaultMaxConcurrent: maxConcurrent(),
      ...(manifest.quota.max_depth === undefined ? {} : { defaultMaxDepth: manifest.quota.max_depth }),
      ...(manifest.native.exact_execution_root === undefined ? {} : { exactExecutionRoot: manifest.native.exact_execution_root }),
      maxConcurrent,
      isInvoking: (env = process.env) => Boolean(String(env[manifest.invocation.signal] || "").trim()),
      executionHandleKind: manifest.native.execution_handle_kind },
    resolveCommand: () => manifest.catalog.command.startsWith("/") ? manifest.catalog.command : `${directory}/${manifest.catalog.command}`,
    discoverModels: async (options = {}) => {
      const catalog = await adapter.discoverModels(options);
      const catalogCapabilities = { ...(catalog.capabilities || {}) } as Record<string, unknown>;
      // Exact-root support is a native adapter contract. A catalog subprocess
      // may report live quotas, but it cannot grant or override this capability.
      delete catalogCapabilities.exact_execution_root;
      const capabilities = {
        ...catalogCapabilities,
        ...(manifest.native.exact_execution_root === undefined ? {} : { exact_execution_root: manifest.native.exact_execution_root }),
      };
      return { cli: catalog.adapter_id, adapter_id: catalog.adapter_id, version: catalog.version, models: catalog.models.map((model) => ({
        id: model.id, model: model.model || model.id, display_name: model.display_name || model.id,
        description: model.description || "", hidden: model.hidden === true,
        reasoning_efforts: model.reasoning_efforts || [], default_reasoning_effort: model.default_reasoning_effort ?? null,
        input_modalities: model.input_modalities || [], additional_speed_tiers: model.additional_speed_tiers || [],
        service_tiers: model.service_tiers || [], default_service_tier: model.default_service_tier ?? null,
        is_default: model.is_default === true, ...model,
      })) as any,
        ...(Object.keys(capabilities).length ? { capabilities } : {}) } as any;
    },
  };
}

/** Public list, derived from the registry. */
export function listCliAdapters(env: NodeJS.ProcessEnv = process.env): readonly CliAdapter[] {
  return discovered(env).map(toCliAdapter);
}

export function cliIds(env: NodeJS.ProcessEnv = process.env): readonly CliId[] {
  return listCliAdapters(env).map((adapter) => adapter.id);
}

export function isCliId(value: string, env: NodeJS.ProcessEnv = process.env): value is CliId {
  return listCliAdapters(env).some((adapter) => adapter.id === value);
}

export function parseCliId(value: string, env: NodeJS.ProcessEnv = process.env): CliId {
  const cli = String(value || "").trim().toLowerCase();
  if (isCliId(cli, env)) return cli;
  throw new Error(`invalid CLI: ${value || "<empty>"} (expected ${listCliAdapters(env).map((a) => a.id).join("|") || "none"})`);
}

export function getCliAdapter(value: CliId | string, env: NodeJS.ProcessEnv = process.env): CliAdapter {
  const cli = String(value || "").trim().toLowerCase();
  const adapter = listCliAdapters(env).find((candidate) => candidate.id === cli);
  if (adapter) return adapter;
  throw new Error(`invalid CLI: ${value || "<empty>"} (expected ${listCliAdapters(env).map((a) => a.id).join("|") || "none"})`);
}

export function runtimeSkillSource(value: CliId | string, env: NodeJS.ProcessEnv = process.env): string {
  const found = discovered(env).find((candidate) => candidate.manifest.adapter.id === String(value).trim().toLowerCase());
  if (!found) throw new Error(`invalid CLI: ${value || "<empty>"}`);
  return `${found.directory}/${found.manifest.runtime_skill.source}`;
}

export type { CliAdapter, CliAdapterProvider, CliId } from "./contract.js";
