import { buildRouteCandidates } from "../lib/routes.js";
import { artificialAnalysisDbPath } from "../lib/paths.js";
import type { ModelCard } from "../types.js";

export interface ListCardsOptions {
  env?: NodeJS.ProcessEnv;
}

export function listCards(cwd: string, _options: ListCardsOptions = {}): ModelCard[] {
  return buildRouteCandidates(cwd, artificialAnalysisDbPath(cwd)).map((candidate) => candidate.card);
}
