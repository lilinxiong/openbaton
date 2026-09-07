import path from "node:path";

export const FIXTURE_ADAPTER_PATHS = path.resolve(import.meta.dir, "fixtures/adapters");
export const FIXTURE_ALPHA = path.join(FIXTURE_ADAPTER_PATHS, "alpha");
export const FIXTURE_BETA = path.join(FIXTURE_ADAPTER_PATHS, "beta");
export function fixtureAdapterEnv(extra: NodeJS.ProcessEnv = {}) {
  return { ...process.env, BATON_ADAPTER_PATHS: [FIXTURE_ALPHA, FIXTURE_BETA].join(path.delimiter), ...extra };
}
