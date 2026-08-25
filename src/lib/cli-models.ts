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
  discoverCursorModels,
  normalizeCursorModels,
  parseCursorModelText,
  resolveCursorCommand,
} from "../adapters/cursor.js";

export {
  discoverGrokModels,
  normalizeGrokModels,
  parseGrokModelText,
  resolveGrokCommand,
} from "../adapters/grok.js";

export {
  discoverClaudeModels,
  normalizeClaudeModels,
  resolveClaudeCommand,
} from "../adapters/claude.js";

export type {
  CliAdapter,
  CliHostMetadata,
  CliId,
  CliModel,
  CliModelCatalog,
  CliModelDiscovery,
  CliReasoningEffort,
  CliRuntimeCapabilities,
  CliServiceTier,
  DiscoverCliModelsOptions,
} from "../adapters/contract.js";
