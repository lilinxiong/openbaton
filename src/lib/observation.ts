/** Read-only accounting of host observations. Never estimates usage or runs agents. */
type Row = Record<string, unknown>;
const USAGE = ["input_tokens", "output_tokens", "total_tokens", "cached_input_tokens", "uncached_input_tokens"] as const;
type UsageKey = typeof USAGE[number];

function invalid(message: string): never { throw new Error(`OBSERVATION_INVALID: ${message}`); }
function row(value: unknown, label: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Row;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(`${label} must be a non-empty string`);
  return value as string;
}
function metric(value: unknown, label: string, integer = true): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) invalid(`${label} must be a non-negative ${integer ? "safe integer" : "number"} or null`);
  return value as number;
}
function optionalBoolean(value: unknown, label: string): boolean {
  if (value !== undefined && typeof value !== "boolean") invalid(`${label} must be boolean`);
  return value === true;
}
function sum(values: Array<number | null>): number | null {
  if (!values.length || values.some((value) => value === null)) return null;
  const result = (values as number[]).reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(result)) invalid("usage/count sum exceeds safe integer range");
  return result;
}

export function inspectObservation(value: unknown) {
  const input = row(value, "observation");
  if (input.schema_version !== 1 || input.kind !== "baton-task-observation") invalid("unsupported schema or kind");
  const source = row(input.source, "source");
  const run = row(input.run, "run");
  const revision = text(source.candidate_identifier, "source.candidate_identifier");
  const observedAt = text(input.observed_at, "observed_at");
  if (!Number.isFinite(Date.parse(observedAt))) invalid("observed_at must be a date-time");
  const workload = source.workload_id === undefined ? null : text(source.workload_id, "source.workload_id");
  if (typeof run.accepted !== "boolean") invalid("run.accepted must be boolean");
  const complete = optionalBoolean(run.tasks_complete, "run.tasks_complete");
  if (complete && run.id === undefined) invalid("run.id is required when run.tasks_complete is true");
  // Old incomplete snapshots have no computable usage, so timestamp fallback remains readable.
  const id = run.id === undefined ? `${revision}@${observedAt}` : text(run.id, "run.id");
  const usageAvailable = optionalBoolean(source.usage_available, "source.usage_available");
  if (!Array.isArray(input.tasks) || !input.tasks.length) invalid("tasks must be non-empty");
  const tasks = (input.tasks as unknown[]).map((value, index) => {
    const task = row(value, `tasks[${index}]`);
    const taskId = text(task.task_id, "task_id");
    if (task.role !== "root" && task.role !== "worker") invalid(`${taskId}: role must be root or worker`);
    const parent = task.parent_task_id === null ? null : text(task.parent_task_id, "parent_task_id");
    if ((task.role === "root") !== (parent === null)) invalid(`${taskId}: invalid root/parent relationship`);
    return { id: taskId, parent, usage: Object.fromEntries(USAGE.map((key) => [key, metric(task[key], `${taskId}.${key}`)])) as Record<UsageKey, number | null> };
  });
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (byId.size !== tasks.length) invalid("duplicate task_id; record cumulative usage once per native task, including its follow-ups");
  const roots = tasks.filter((task) => task.parent === null);
  if (roots.length !== 1) invalid("exactly one root is required");
  const children = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.parent === null) continue;
    if (!byId.has(task.parent)) invalid(`${task.id}: missing parent`);
    const list = children.get(task.parent) || [];
    list.push(task.id); children.set(task.parent, list);
  }
  const reachable = [roots[0].id];
  for (let index = 0; index < reachable.length; index += 1) reachable.push(...(children.get(reachable[index]) || []));
  if (reachable.length !== tasks.length) invalid("task parent graph contains a cycle");
  const usage = Object.fromEntries(USAGE.map((key) => {
    const reported = metric(run[key], `run.${key}`);
    const total = complete && usageAvailable ? sum(tasks.map((task) => task.usage[key])) : null;
    if (total !== null && reported !== null && total !== reported) invalid(`run.${key} disagrees with task totals`);
    return [key, total];
  })) as Record<UsageKey, number | null>;
  return {
    id, candidate_identifier: revision, workload_id: workload, accepted: run.accepted as boolean,
    tasks_complete: complete, task_count: tasks.length,
    tasks_with_total_tokens: tasks.filter((task) => task.usage.total_tokens !== null).length,
    elapsed_ms: metric(run.elapsed_ms, "run.elapsed_ms", false),
    retries: metric(run.retries, "run.retries"), upgrades: metric(run.upgrades, "run.upgrades"),
    ...usage,
  };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarizeObservations(values: unknown[]) {
  if (!values.length) invalid("at least one observation is required");
  const runs = values.map(inspectObservation);
  if (new Set(runs.map((run) => run.id)).size !== runs.length) invalid("duplicate run id; repeated observations would double-count usage");
  const groups = new Map<string, typeof runs>();
  for (const run of runs) {
    const key = JSON.stringify([run.candidate_identifier, run.workload_id]);
    const group = groups.get(key) || [];
    group.push(run); groups.set(key, group);
  }
  return {
    schema_version: 1,
    groups: [...groups.values()].map((group) => {
      const accepted = group.filter((run) => run.accepted).length;
      const elapsed = group.map((run) => run.elapsed_ms).filter((value): value is number => value !== null);
      const total = sum(group.map((run) => run.total_tokens));
      return {
        candidate_identifier: group[0].candidate_identifier, workload_id: group[0].workload_id,
        run_count: group.length, accepted_runs: accepted, acceptance_rate: accepted / group.length,
        elapsed_samples: elapsed.length, median_elapsed_ms: median(elapsed),
        runs_with_total_tokens: group.filter((run) => run.total_tokens !== null).length,
        total_tokens: total,
        // Includes failed runs: cheaper failures must not look like efficiency gains.
        tokens_per_accepted_run: total === null || !accepted ? null : total / accepted,
        retries: sum(group.map((run) => run.retries)), upgrades: sum(group.map((run) => run.upgrades)),
      };
    }),
    runs,
    notes: [
      "Usage totals require tasks_complete=true, usage_available=true and every task's reported metric. Missing is unknown, not zero.",
      "Complete runs require a stable host run id; reuse it across exports so repeated snapshots are rejected. Timestamp fallback for incomplete legacy snapshots cannot deduplicate them.",
      "Record cumulative usage once per native task, including follow-ups; new retry/upgrade tasks have unique ids.",
      "Elapsed time is host-observed wall time, not the sum of parallel task durations. Medians show available samples only.",
      "Compare identical workloads and acceptance criteria with repeated runs. This report does not rank models or infer savings.",
    ],
  };
}
