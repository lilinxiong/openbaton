/**
 * Compatibility facade for the pre-registry CLI model API.
 *
 * New code should depend on `src/adapters`; these exports remain stable for
 * existing command and library consumers.
 */
export {
  CLI_IDS,
  listCliAdapters,
  isCliId,
  parseCliId,
  getCliAdapter,
  discoverCliModels,
} from "../adapters/registry.js";

export {
  discoverCodexModels,
  normalizeCodexModels,
  resolveCodexCommand,
} from "../adapters/codex.js";

export {
  discoverGrokModels,
  normalizeGrokModels,
  parseGrokModelText,
  resolveGrokCommand,
} from "../adapters/grok.js";

export type {
  CliAdapter,
  CliHostMetadata,
  CliId,
  CliModel,
  CliModelCatalog,
  CliModelDiscovery,
  CliReasoningEffort,
  CliServiceTier,
  DiscoverCliModelsOptions,
} from "../adapters/contract.js";
