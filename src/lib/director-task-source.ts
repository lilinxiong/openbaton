/**
 * The source adapter used for work which is planned by the director itself.
 *
 * This adapter intentionally has no OpenSpec (or repository) dependency.  A
 * task id is the source identity supplied by the caller; the rolling protocol
 * derives the Baton identity from that id and keeps the description as source
 * data.  Completion is kept in this adapter's in-memory state.  A caller may
 * opt in to source writeback by supplying a reconcile callback.
 */
import {
  deriveTaskKey,
  fingerprintTaskManifestEntry,
  fingerprintTaskSourceDescriptor,
  type TaskManifestEntry,
  type TaskManifestPage,
  type TaskSourceDescriptor,
} from "./rolling-plan.js";
import {
  TaskSourceAdapterError,
  type TaskSourceAdapter,
  type TaskSourceAvailableResult,
  type TaskSourceDiagnosticsRequest,
  type TaskSourceDiagnostic,
  type TaskSourceDiscoverRequest,
  type TaskSourceReconcileRequest,
  type TaskSourceReconcileResult,
  type TaskSourceReconciliation,
  type TaskSourceRefreshRequest,
  type TaskSourceResult,
  type TaskSourceUnavailableResult,
} from "./task-source.js";

export const DIRECTOR_TASK_SOURCE_ADAPTER_ID = "director" as const;

export interface DirectorTaskDefinition {
  /** A stable id supplied by the director.  It is never allocated by Baton. */
  id: string;
  description: string;
  title?: string;
  /** Optional opaque source identity.  The id remains the stable key input. */
  source_ref?: unknown;
  metadata?: Record<string, unknown>;
}

export interface DirectorReconcileCallbackRequest {
  source: TaskSourceDescriptor;
  task_key: string;
  task_id: string;
  description: string;
  conclusion: string;
  expected_source_fingerprint: string;
  entry: TaskManifestEntry;
}

export type DirectorReconcileCallback = (
  request: DirectorReconcileCallbackRequest,
) =>
  /** Resolving void is an explicit successful writeback acknowledgement. */
  | void
  | TaskManifestEntry
  | { task_key: string; source_fingerprint: string; source_state: "complete" | "pending" | "unavailable"; source_ref: unknown; conclusion?: string }
  | TaskSourceResult<TaskManifestEntry>
  | Promise<
      | void
      | TaskManifestEntry
      | { task_key: string; source_fingerprint: string; source_state: "complete" | "pending" | "unavailable"; source_ref: unknown; conclusion?: string }
      | TaskSourceResult<TaskManifestEntry>
    >;

export interface DirectorTaskSourceOptions {
  adapter?: string;
  tasks?: readonly DirectorTaskDefinition[];
  reconcile?: DirectorReconcileCallback;
  /** Explicit aliases make the opt-in nature clear for direct API callers. */
  reconcileCallback?: DirectorReconcileCallback;
  onReconcile?: DirectorReconcileCallback;
}

type StoredDefinition = {
  definition: DirectorTaskDefinition;
  fingerprint: string;
  /** Retained only to detect a caller mutating a supplied descriptor in place. */
  original?: DirectorTaskDefinition;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function localDiagnostic(code: string, message: string, refs?: string[]): TaskSourceDiagnostic {
  return { code, message, ...(refs?.length ? { refs } : {}) };
}

function localUnavailable<T>(diagnostic: TaskSourceDiagnostic): TaskSourceUnavailableResult<T> {
  return { ok: false, status: "unavailable", diagnostics: [diagnostic] };
}

function error(code: string, message: string, diagnostics: readonly TaskSourceDiagnostic[] = []): TaskSourceAdapterError {
  return new TaskSourceAdapterError(code, message, diagnostics.length ? diagnostics : [localDiagnostic(code, message)]);
}

function normalizeDefinition(input: DirectorTaskDefinition): DirectorTaskDefinition {
  if (!input || typeof input !== "object") throw error("INVALID_DEFINITION", "director task definition must be an object");
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id || !ID.test(id)) throw error("INVALID_ID", `director task id ${String(input.id)} is not a stable identity`);
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (!description) throw error("INVALID_DESCRIPTION", `director task ${id} requires a non-empty description`);
  const title = input.title === undefined ? description : typeof input.title === "string" ? input.title.trim() : "";
  if (!title) throw error("INVALID_TITLE", `director task ${id} requires a non-empty title`);
  if (Object.prototype.hasOwnProperty.call(input, "source_ref") && (input.source_ref === null || input.source_ref === undefined)) {
    throw error("INVALID_SOURCE_REF", `director task ${id} source_ref must be non-null when supplied`);
  }
  if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata))) {
    throw error("INVALID_METADATA", `director task ${id} metadata must be an object`);
  }
  return structuredClone({
    id,
    description,
    title,
    ...(Object.prototype.hasOwnProperty.call(input, "source_ref") ? { source_ref: structuredClone(input.source_ref) } : {}),
    ...(input.metadata === undefined ? {} : { metadata: structuredClone(input.metadata) }),
  });
}

function definitionFingerprint(definition: DirectorTaskDefinition): string {
  return fingerprintTaskSourceDescriptor({
    id: definition.id,
    description: definition.description,
    title: definition.title,
    source_ref: definition.source_ref === undefined ? definition.id : definition.source_ref,
    ...(definition.metadata === undefined ? {} : { metadata: definition.metadata }),
  });
}

function callbackResult(value: unknown): value is TaskSourceResult<unknown> {
  return Boolean(value && typeof value === "object" && ((value as { status?: unknown }).status === "available" || (value as { status?: unknown }).status === "unavailable"));
}

/** A standalone, deterministic implementation of the shared task-source contract. */
export class DirectorTaskSourceAdapter implements TaskSourceAdapter {
  readonly id: string;
  readonly source_kind = "director" as const;

  private readonly definitions: StoredDefinition[] = [];
  private readonly byId = new Map<string, StoredDefinition>();
  private readonly byTaskKey = new Map<string, StoredDefinition>();
  private readonly completed = new Map<string, { conclusion: string; source_fingerprint: string }>();
  private readonly localDiagnostics: TaskSourceDiagnostic[] = [];
  private readonly reconcileCallback?: DirectorReconcileCallback;

  constructor(tasks?: readonly DirectorTaskDefinition[], options?: DirectorTaskSourceOptions);
  constructor(options?: DirectorTaskSourceOptions);
  constructor(tasksOrOptions: readonly DirectorTaskDefinition[] | DirectorTaskSourceOptions = [], maybeOptions: DirectorTaskSourceOptions = {}) {
    const isTaskList = Array.isArray(tasksOrOptions);
    const tasks = isTaskList ? tasksOrOptions : (tasksOrOptions as DirectorTaskSourceOptions).tasks || [];
    const options = isTaskList ? maybeOptions : tasksOrOptions as DirectorTaskSourceOptions;
    this.id = options.adapter?.trim() || DIRECTOR_TASK_SOURCE_ADAPTER_ID;
    if (!ID.test(this.id)) throw error("INVALID_ADAPTER", "director adapter id must be a stable identity");
    this.reconcileCallback = options.reconcile || options.reconcileCallback || options.onReconcile;
    this.appendDefinitions(tasks);
  }

  /** Append-only growth is safe for outstanding cursors: existing indexes do not move. */
  appendTasks(tasks: readonly DirectorTaskDefinition[]): this {
    const normalized = tasks.map(normalizeDefinition);
    const seen = new Set<string>();
    for (const definition of normalized) {
      if (seen.has(definition.id)) throw error("DUPLICATE_ID", `director task id ${definition.id} is duplicated`);
      seen.add(definition.id);
      if (this.byId.has(definition.id)) {
        const existing = this.byId.get(definition.id)!;
        if (existing.fingerprint !== definitionFingerprint(definition)) throw error("CHANGED_DEFINITION", `director task ${definition.id} changed after registration`);
        throw error("DUPLICATE_ID", `director task id ${definition.id} is duplicated`);
      }
    }
    for (const [index, definition] of normalized.entries()) this.store(definition, tasks[index]);
    return this;
  }

  addTasks(tasks: readonly DirectorTaskDefinition[]): this { return this.appendTasks(tasks); }

  /** Replace is intentionally strict: changing an existing id is a source drift error. */
  setTasks(tasks: readonly DirectorTaskDefinition[]): this {
    const normalized = tasks.map(normalizeDefinition);
    const incoming = new Map(normalized.map((item) => [item.id, item]));
    for (const existing of this.definitions) {
      const next = incoming.get(existing.definition.id);
      if (next && definitionFingerprint(next) !== existing.fingerprint) throw error("CHANGED_DEFINITION", `director task ${next.id} changed after registration`);
      if (!next) throw error("CHANGED_DEFINITION", `director task ${existing.definition.id} was removed after registration`);
    }
    this.appendDefinitions(normalized.filter((item) => !this.byId.has(item.id)));
    return this;
  }

  replaceTasks(tasks: readonly DirectorTaskDefinition[]): this { return this.setTasks(tasks); }

  taskDefinitions(): readonly DirectorTaskDefinition[] { return this.definitions.map((item) => structuredClone(item.definition)); }

  completedTaskKeys(): readonly string[] { return [...this.completed.keys()].sort(); }

  isComplete(taskKey: string): boolean { return this.completed.has(taskKey); }

  sourceDescriptor(selection?: unknown): TaskSourceDescriptor {
    return { schema_version: 1, source_kind: "director", adapter: this.id, ...(selection === undefined ? {} : { selection: structuredClone(selection) }) };
  }

  private appendDefinitions(tasks: readonly DirectorTaskDefinition[]): void {
    // Validate the whole incoming batch first so a duplicate cannot leave a partial append.
    const seen = new Set<string>();
    for (const raw of tasks) {
      const definition = normalizeDefinition(raw);
      if (seen.has(definition.id) || this.byId.has(definition.id)) {
        throw error("DUPLICATE_ID", `director task id ${definition.id} is duplicated`);
      }
      seen.add(definition.id);
    }
    for (const raw of tasks) this.store(normalizeDefinition(raw), raw);
  }

  private store(definition: DirectorTaskDefinition, original?: DirectorTaskDefinition): void {
    const stored = { definition, fingerprint: definitionFingerprint(definition), original };
    this.definitions.push(stored);
    this.byId.set(definition.id, stored);
    this.byTaskKey.set(deriveTaskKey("director", definition.id), stored);
  }

  private checkDefinitions(): TaskSourceDiagnostic | undefined {
    for (const stored of this.definitions) {
      try {
        const current = normalizeDefinition(stored.original || stored.definition);
        if (definitionFingerprint(current) !== stored.fingerprint) {
          return localDiagnostic("CHANGED_DEFINITION", `director task ${current.id} changed after discovery`, [current.id]);
        }
      } catch (cause) {
        const message = cause instanceof TaskSourceAdapterError ? cause.message : String(cause);
        return localDiagnostic("CHANGED_DEFINITION", `director task definition changed after discovery: ${message}`);
      }
    }
    return undefined;
  }

  private entry(stored: StoredDefinition, sequence: number): TaskManifestEntry {
    const definition = stored.definition;
    const taskKey = deriveTaskKey("director", definition.id);
    const complete = this.completed.get(taskKey);
    const value: TaskManifestEntry = {
      schema_version: 1,
      task_key: taskKey,
      source_kind: "director",
      source_ref: structuredClone(definition.source_ref === undefined ? definition.id : definition.source_ref),
      display_id: definition.id,
      title: definition.title || definition.description,
      source_fingerprint: stored.fingerprint,
      source_state: complete ? "complete" : "pending",
      discovery_sequence: sequence,
      ...(definition.metadata === undefined ? {} : { metadata: structuredClone(definition.metadata) }),
    };
    return { ...value, fingerprint: fingerprintTaskManifestEntry(value) };
  }

  async discover(request: TaskSourceDiscoverRequest): Promise<TaskManifestPage | TaskSourceResult<TaskManifestPage>> {
    const changed = this.checkDefinitions();
    if (changed) return this.fail("discover", changed);
    const cursor = request.cursor === undefined || request.cursor === null ? 0 : this.parseCursor(request.cursor);
    if (cursor === undefined) return localUnavailable<TaskManifestPage>(this.lastDiagnostic());
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) return this.fail("discover", localDiagnostic("INVALID_LIMIT", "director discovery limit must be a positive integer"));
    const end = Math.min(cursor + request.limit, this.definitions.length);
    const entries = this.definitions.slice(cursor, end).map((item, index) => this.entry(item, cursor + index));
    const hasMore = end < this.definitions.length;
    const page: TaskManifestPage = {
      schema_version: 1,
      source: structuredClone(request.source),
      entries,
      cursor: request.cursor ?? null,
      next_cursor: hasMore ? String(end) : null,
      has_more: hasMore,
    };
    return { ok: true, status: "available", value: { ...page, fingerprint: fingerprintTaskSourceDescriptor(page) }, diagnostics: [] };
  }

  async refresh(request: TaskSourceRefreshRequest): Promise<readonly TaskManifestEntry[] | TaskSourceResult<readonly TaskManifestEntry[]>> {
    const changed = this.checkDefinitions();
    if (changed) return this.fail("refresh", changed);
    const entries: TaskManifestEntry[] = [];
    const seen = new Set<string>();
    for (const taskKey of request.task_keys) {
      if (seen.has(taskKey)) return this.fail("refresh", localDiagnostic("DUPLICATE_ID", `director task ${taskKey} was requested more than once`, [taskKey]));
      seen.add(taskKey);
      const stored = this.byTaskKey.get(taskKey);
      if (!stored) return this.fail("refresh", localDiagnostic("UNKNOWN_TASK", `director task ${taskKey} is unknown`, [taskKey]));
      entries.push(this.entry(stored, this.definitions.indexOf(stored)));
    }
    return { ok: true, status: "available", value: entries, diagnostics: [] };
  }

  async reconcile(request: TaskSourceReconcileRequest): Promise<TaskSourceReconciliation | TaskManifestEntry | TaskSourceReconcileResult> {
    const changed = this.checkDefinitions();
    if (changed) return this.fail("reconcile", changed);
    const stored = this.byTaskKey.get(request.task_key);
    if (!stored) return this.fail("reconcile", localDiagnostic("UNKNOWN_TASK", `director task ${request.task_key} is unknown`, [request.task_key]));
    if (stored.fingerprint !== request.expected_source_fingerprint) {
      return this.fail("reconcile", localDiagnostic("FINGERPRINT_MISMATCH", `director task ${stored.definition.id} source fingerprint changed`, [stored.definition.id]));
    }
    const entry = this.entry(stored, this.definitions.indexOf(stored));
    const prior = this.completed.get(request.task_key);
    if (prior) return this.localReconciliation(request, entry, prior.conclusion);

    if (this.reconcileCallback) {
      try {
        const raw = await this.reconcileCallback({
          source: structuredClone(request.source),
          task_key: request.task_key,
          task_id: stored.definition.id,
          description: stored.definition.description,
          conclusion: request.conclusion,
          expected_source_fingerprint: request.expected_source_fingerprint,
          entry,
        });
        if (callbackResult(raw) && raw.status === "unavailable") return raw as TaskSourceUnavailableResult<never>;
        if (callbackResult(raw) && raw.status === "available") {
          const value = raw.value as { source_state?: unknown };
          if (value.source_state === "complete") this.completed.set(request.task_key, { conclusion: request.conclusion, source_fingerprint: stored.fingerprint });
          return raw as TaskSourceReconcileResult;
        }
        if (raw === undefined) {
          this.completed.set(request.task_key, { conclusion: request.conclusion, source_fingerprint: stored.fingerprint });
          return this.localReconciliation(request, entry, request.conclusion);
        }
        if (raw && typeof raw === "object") {
          const value = raw as TaskManifestEntry | TaskSourceReconciliation;
          if (value.source_state === "complete") this.completed.set(request.task_key, { conclusion: request.conclusion, source_fingerprint: stored.fingerprint });
          if (value.source_state === "unavailable") return localUnavailable<TaskSourceReconciliation>(localDiagnostic("RECONCILIATION_UNAVAILABLE", `director reconciliation callback did not complete task ${stored.definition.id}`));
          return { ok: true, status: "available", value, diagnostics: [] };
        }
        return this.fail("reconcile", localDiagnostic("RECONCILIATION_UNAVAILABLE", `director reconciliation callback returned an unsupported result for task ${stored.definition.id}`, [stored.definition.id]));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return this.fail("reconcile", localDiagnostic("RECONCILIATION_UNAVAILABLE", `director reconciliation callback failed: ${message}`));
      }
    }
    this.completed.set(request.task_key, { conclusion: request.conclusion, source_fingerprint: stored.fingerprint });
    return this.localReconciliation(request, this.entry(stored, this.definitions.indexOf(stored)), request.conclusion);
  }

  diagnostics(_request: TaskSourceDiagnosticsRequest): readonly TaskSourceDiagnostic[] { return this.localDiagnostics.slice(); }

  private localReconciliation(request: TaskSourceReconcileRequest, entry: TaskManifestEntry, conclusion: string): TaskSourceAvailableResult<TaskSourceReconciliation> {
    return { ok: true, status: "available", value: { task_key: request.task_key, source_fingerprint: entry.source_fingerprint, source_state: "complete", source_ref: structuredClone(entry.source_ref), conclusion }, diagnostics: [] };
  }

  private parseCursor(cursor: string): number | undefined {
    if (!/^0$|^[1-9][0-9]*$/.test(cursor)) {
      this.record(localDiagnostic("INVALID_CURSOR", `director cursor ${cursor} is not a canonical page cursor`));
      return undefined;
    }
    const value = Number(cursor);
    if (!Number.isSafeInteger(value) || value > this.definitions.length) {
      this.record(localDiagnostic("INVALID_CURSOR", `director cursor ${cursor} is outside the current manifest`));
      return undefined;
    }
    return value;
  }

  private fail<T>(operation: string, diagnostic: TaskSourceDiagnostic): TaskSourceUnavailableResult<T> {
    this.record({ ...diagnostic, refs: [...(diagnostic.refs || []), operation] });
    return localUnavailable<T>(diagnostic);
  }

  private lastDiagnostic(): TaskSourceDiagnostic {
    return this.localDiagnostics.at(-1) || localDiagnostic("ADAPTER_FAILURE", "director task source operation failed");
  }

  private record(diagnostic: TaskSourceDiagnostic): void { this.localDiagnostics.push(diagnostic); }
}

export function createDirectorTaskSourceAdapter(
  tasksOrOptions: readonly DirectorTaskDefinition[] | DirectorTaskSourceOptions = [],
  options?: DirectorTaskSourceOptions,
): DirectorTaskSourceAdapter {
  return new DirectorTaskSourceAdapter(tasksOrOptions as readonly DirectorTaskDefinition[] & DirectorTaskSourceOptions, options);
}


// Keep this import visible to declaration emit consumers that use the adapter
// as a concrete implementation of the shared contract.
