import {
  PlanDelta,
  TaskManifestEntry,
  TaskSourceDescriptor,
  fingerprintPlanDelta,
  fingerprintTaskManifestEntry
} from "./rolling-plan.js";
import { createOpenSpecTaskSourceAdapter } from "./openspec-task-source.js";
import { createDirectorTaskSourceAdapter } from "./director-task-source.js";
import {
  RollingControlError,
  directorTasks,
  hash
} from "./rolling-control.js";
import {
  TaskSourceAdapterRegistry,
  TaskSourceDiagnostic,
  createTaskSourceAdapterRegistry
} from "./task-source.js";
/**
 * Task-source registry and manifest discovery/diff for rolling control.
 * Split from rolling-control.ts.
 */

export function rollingTaskSourceRegistry(cwd: string, source: TaskSourceDescriptor): TaskSourceAdapterRegistry {
  if (source.source_kind === "openspec") {
    return createTaskSourceAdapterRegistry([createOpenSpecTaskSourceAdapter({ cwd })]);
  }
  if (source.source_kind === "director") {
    return createTaskSourceAdapterRegistry([
      createDirectorTaskSourceAdapter(directorTasks(source), { adapter: source.adapter }),
    ]);
  }
  throw new RollingControlError(`unsupported rolling source kind ${source.source_kind}`, "ROLLING_SOURCE_UNSUPPORTED");
}

export async function discoverRollingTaskManifest(
  cwd: string,
  source: TaskSourceDescriptor,
  registry: TaskSourceAdapterRegistry = rollingTaskSourceRegistry(cwd, source),
): Promise<{ entries: TaskManifestEntry[]; diagnostics: readonly TaskSourceDiagnostic[]; complete: boolean }> {
  const entries: TaskManifestEntry[] = [];
  const diagnostics: TaskSourceDiagnostic[] = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  do {
    const result = await registry.discover(source, { cursor, limit: registry.max_page_size });
    diagnostics.push(...result.diagnostics);
    if (!result.ok) return { entries, diagnostics, complete: false };
    entries.push(...result.value.entries);
    const next = result.value.next_cursor ?? null;
    if (next !== null) {
      if (seenCursors.has(next)) throw new RollingControlError("task source repeated a discovery cursor", "ROLLING_DISCOVERY_CURSOR_CYCLE", diagnostics);
      seenCursors.add(next);
    }
    cursor = next;
  } while (cursor !== null);
  return { entries, diagnostics, complete: true };
}


export function manifestDiff(
  accepted: readonly TaskManifestEntry[],
  discovered: readonly TaskManifestEntry[],
): { additions: TaskManifestEntry[]; refreshes: TaskManifestEntry[] } {
  const current = new Map(accepted.map((entry) => [entry.task_key, entry]));
  const additions: TaskManifestEntry[] = [];
  const refreshes: TaskManifestEntry[] = [];
  for (const entry of discovered) {
    const prior = current.get(entry.task_key);
    if (!prior) additions.push(entry);
    else if (fingerprintTaskManifestEntry(prior) !== fingerprintTaskManifestEntry(entry)) refreshes.push(entry);
  }
  return { additions, refreshes };
}

export function mergeManifest(delta: PlanDelta, additions: readonly TaskManifestEntry[], refreshes: readonly TaskManifestEntry[]): PlanDelta {
  const copy = structuredClone(delta) as PlanDelta;
  const local = new Set([...(copy.manifest_additions || []), ...(copy.manifest_refreshes || [])].map((entry) => entry.task_key));
  const nextAdditions = [...(copy.manifest_additions || []), ...additions.filter((entry) => !local.has(entry.task_key))];
  const nextRefreshes = [...(copy.manifest_refreshes || []), ...refreshes.filter((entry) => !local.has(entry.task_key))];
  if (nextAdditions.length) copy.manifest_additions = nextAdditions;
  else delete copy.manifest_additions;
  if (nextRefreshes.length) copy.manifest_refreshes = nextRefreshes;
  else delete copy.manifest_refreshes;
  delete copy.fingerprint;
  copy.fingerprint = fingerprintPlanDelta(copy);
  return copy;
}

export function manifestDelta(entries: readonly TaskManifestEntry[], sequence: number): PlanDelta {
  const value: PlanDelta = {
    schema_version: 1,
    delta_id: `manifest-${hash(entries.map((entry) => [entry.task_key, fingerprintTaskManifestEntry(entry)])).slice(0, 24)}`,
    prepared_from_append_sequence: sequence,
    manifest_additions: [...entries],
    unit_versions: [],
    gate_versions: [],
    task_coverage: [],
  };
  value.fingerprint = fingerprintPlanDelta(value);
  return value;
}
