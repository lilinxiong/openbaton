import type {
  CliAdapter,
  CliId,
  CliModelCatalog,
  CliModelDiscovery,
  DiscoverCliModelsOptions,
} from "./contract.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { grokAdapter } from "./grok.js";
import { claudeAdapter } from "./claude.js";
import { codedError } from "./shared.js";

/** The only source of truth for supported CLI adapters in this release. */
export const CLI_ADAPTERS = [codexAdapter, grokAdapter, cursorAdapter, claudeAdapter] as const;

/** Public compatibility list, now derived from the registry. */
export const CLI_IDS = CLI_ADAPTERS.map((adapter) => adapter.id) as readonly CliId[];

export function listCliAdapters(): readonly CliAdapter[] {
  return CLI_ADAPTERS;
}

export function isCliId(value: string): value is CliId {
  return (CLI_IDS as readonly string[]).includes(value);
}

export function parseCliId(value: string): CliId {
  const cli = String(value || "").trim().toLowerCase();
  if (isCliId(cli)) return cli;
  throw new Error(`invalid CLI: ${value || "<empty>"} (expected ${CLI_IDS.join("|")})`);
}

export function getCliAdapter(value: CliId | string): CliAdapter {
  const cli = String(value || "").trim().toLowerCase();
  const adapter = CLI_ADAPTERS.find((candidate) => candidate.id === cli);
  if (adapter) return adapter;
  throw new Error(`invalid CLI: ${value || "<empty>"} (expected ${CLI_IDS.join("|")})`);
}

/** Discover through the registered adapter while retaining the old call shape. */
export const discoverCliModels: CliModelDiscovery = async (
  cli,
  options?: DiscoverCliModelsOptions,
): Promise<CliModelCatalog> => {
  const adapter = CLI_ADAPTERS.find((candidate) => candidate.id === cli);
  if (!adapter) throw codedError(`unsupported CLI: ${cli}`, "CLI_NOT_SUPPORTED");
  return adapter.discoverModels(options);
};

export type { CliAdapter, CliId } from "./contract.js";
