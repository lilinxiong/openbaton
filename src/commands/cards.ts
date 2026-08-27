import { buildRouteCandidates } from "../lib/routes.js";
import type { ModelCard } from "../types.js";

export interface ListCardsOptions {
  env?: NodeJS.ProcessEnv;
}

export function listCards(cwd: string, options: ListCardsOptions = {}): ModelCard[] {
  return buildRouteCandidates(cwd, options).map((candidate) => candidate.card);
}
