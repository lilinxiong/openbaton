/**
 * Source-neutral task discovery and reconciliation boundary.
 *
 * Adapters own source semantics.  The registry only validates the shared wire
 * documents, bounds discovery, routes calls, and turns a temporarily
 * unavailable source into a local result.  In particular, selection and
 * source_ref are never inspected or normalised here.
 */
import {
  assertTaskManifestPage,
  assertTaskSourceDescriptor,
  validateTaskManifestEntry,
  validateTaskSourceDescriptor,
  type RollingDiagnostic,
  type RollingSourceKind,
  type TaskManifestEntry,
  type TaskManifestPage,
  type TaskSourceDescriptor,
} from "./rolling-plan.js";

export const DEFAULT_TASK_SOURCE_PAGE_LIMIT = 100 as const;

export type TaskSourceDiagnosticSeverity = "info" | "warning" | "error";

/** Diagnostics are deliberately source-neutral; source-specific details may
 * be carried in refs and are not interpreted by Baton. */
export interface TaskSourceDiagnostic extends RollingDiagnostic {
  severity?: TaskSourceDiagnosticSeverity;
}

export type TaskSourceAdapterErrorCode =
  | "INVALID_DESCRIPTOR"
  | "UNKNOWN_ADAPTER"
  | "DUPLICATE_ADAPTER"
  | "INVALID_ADAPTER"
  | "INVALID_PAGE"
  | "INVALID_ENTRY"
  | "DISCOVERY_UNAVAILABLE"
  | "REFRESH_UNAVAILABLE"
  | "RECONCILIATION_UNAVAILABLE"
  | "DIAGNOSTICS_UNAVAILABLE"
  | "ADAPTER_FAILURE"
  | string;

export class TaskSourceAdapterError extends Error {
  readonly code: TaskSourceAdapterErrorCode;
  readonly diagnostics: readonly TaskSourceDiagnostic[];

  constructor(code: TaskSourceAdapterErrorCode, message: string, diagnostics: readonly TaskSourceDiagnostic[] = []) {
    super(message);
    this.name = "TaskSourceAdapterError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export interface TaskSourceDiscoverRequest {
  source: TaskSourceDescriptor;
  cursor?: string | null;
  /** The registry guarantees this is a positive integer <= its page limit. */
  limit: number;
}

export interface TaskSourceRefreshRequest {
  source: TaskSourceDescriptor;
  task_keys: readonly string[];
}

export interface TaskSourceReconcileRequest {
  source: TaskSourceDescriptor;
  task_key: string;
  conclusion: string;
  expected_source_fingerprint: string;
}

export interface TaskSourceBatchReconcileItem {
  task_key: string;
  conclusion: string;
  expected_source_fingerprint: string;
  expected_source_state: TaskManifestEntry["source_state"];
}

export interface TaskSourceBatchReconcileRequest {
  source: TaskSourceDescriptor;
  items: readonly TaskSourceBatchReconcileItem[];
}

export interface TaskSourceDiagnosticsRequest {
  source: TaskSourceDescriptor;
  operation?: "discover" | "refresh" | "reconcile";
}

export interface TaskSourceReconciliation {
  task_key: string;
  source_fingerprint: string;
  source_state: "complete" | "pending" | "unavailable";
  /** The adapter may return the current opaque identity after writeback. */
  source_ref: unknown;
  conclusion?: string;
}

export interface TaskSourceAvailableResult<T> {
  readonly ok: true;
  readonly status: "available";
  readonly value: T;
  readonly diagnostics: readonly TaskSourceDiagnostic[];
}

export interface TaskSourceUnavailableResult<T = never> {
  readonly ok: false;
  readonly status: "unavailable";
  readonly value?: T;
  readonly diagnostics: readonly TaskSourceDiagnostic[];
}

/** A source outage is data local to one operation, not a registry exception. */
export type TaskSourceResult<T> = TaskSourceAvailableResult<T> | TaskSourceUnavailableResult<T>;
export type TaskSourceOperationResult<T> = TaskSourceResult<T>;
export type TaskSourceDiscoveryResult = TaskSourceResult<TaskManifestPage>;
export type TaskSourceRefreshResult = TaskSourceResult<readonly TaskManifestEntry[]>;
export type TaskSourceReconcileResult = TaskSourceResult<TaskSourceReconciliation | TaskManifestEntry>;
export type TaskSourceBatchReconcileResult = TaskSourceResult<readonly (TaskSourceReconciliation | TaskManifestEntry)[]>;
export type TaskSourceDiagnosticsResult = TaskSourceResult<readonly TaskSourceDiagnostic[]>;

/**
 * Implementations may return a typed TaskSourceResult, or the successful wire
 * value directly.  Direct values keep tiny adapters ergonomic; the registry
 * wraps them in an available result before returning to callers.
 */
export interface TaskSourceAdapter {
  readonly id: string;
  readonly source_kind: RollingSourceKind;
  discover(request: TaskSourceDiscoverRequest): Promise<TaskManifestPage | TaskSourceDiscoveryResult> | TaskManifestPage | TaskSourceDiscoveryResult;
  refresh(request: TaskSourceRefreshRequest): Promise<readonly TaskManifestEntry[] | TaskSourceRefreshResult> | readonly TaskManifestEntry[] | TaskSourceRefreshResult;
  reconcile(request: TaskSourceReconcileRequest): Promise<TaskSourceReconciliation | TaskManifestEntry | TaskSourceReconcileResult> | TaskSourceReconciliation | TaskManifestEntry | TaskSourceReconcileResult;
  /** Optional atomic multi-task writeback for sources whose task identities
   * share one mutable container fingerprint, such as one OpenSpec tasks.md. */
  reconcile_batch?(request: TaskSourceBatchReconcileRequest): Promise<readonly (TaskSourceReconciliation | TaskManifestEntry)[] | TaskSourceBatchReconcileResult> | readonly (TaskSourceReconciliation | TaskManifestEntry)[] | TaskSourceBatchReconcileResult;
  diagnostics?(request: TaskSourceDiagnosticsRequest): Promise<readonly TaskSourceDiagnostic[] | TaskSourceDiagnosticsResult> | readonly TaskSourceDiagnostic[] | TaskSourceDiagnosticsResult;
}

export interface TaskSourceAdapterRegistryOptions {
  max_page_size?: number;
  /** camelCase is accepted for callers using the TypeScript API directly. */
  maxPageSize?: number;
}

function diagnostic(code: string, message: string, refs?: string[]): TaskSourceDiagnostic {
  return { code, message, ...(refs && refs.length ? { refs } : {}) };
}

function unavailable<T>(code: TaskSourceAdapterErrorCode, message: string, cause?: unknown): TaskSourceUnavailableResult<T> {
  const suffix = cause instanceof Error && cause.message ? `: ${cause.message}` : "";
  return { ok: false, status: "unavailable", diagnostics: [diagnostic(code, `${message}${suffix}`)] };
}

function available<T>(value: T, diagnostics: readonly TaskSourceDiagnostic[] = []): TaskSourceAvailableResult<T> {
  return { ok: true, status: "available", value, diagnostics };
}

function isResult(value: unknown): value is TaskSourceResult<unknown> {
  return Boolean(value && typeof value === "object" && ((value as { status?: unknown }).status === "available" || (value as { status?: unknown }).status === "unavailable"));
}

function operationError(code: TaskSourceAdapterErrorCode, message: string, cause?: unknown): TaskSourceAdapterError {
  const suffix = cause instanceof Error && cause.message ? `: ${cause.message}` : "";
  return new TaskSourceAdapterError(code, `${message}${suffix}`, [diagnostic(code, `${message}${suffix}`)]);
}

function adapterId(adapter: TaskSourceAdapter): string {
  return typeof adapter.id === "string" ? adapter.id.trim() : "";
}

function validateAdapter(adapter: TaskSourceAdapter): void {
  if (!adapter || !adapterId(adapter) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(adapterId(adapter))) {
    throw operationError("INVALID_ADAPTER", "task source adapter id must be a stable non-empty identity");
  }
  if (!adapter.source_kind || typeof adapter.source_kind !== "string") {
    throw operationError("INVALID_ADAPTER", `adapter ${adapterId(adapter)} must declare source_kind`);
  }
  if (typeof adapter.discover !== "function" || typeof adapter.refresh !== "function" || typeof adapter.reconcile !== "function") {
    throw operationError("INVALID_ADAPTER", `adapter ${adapterId(adapter)} must implement discover, refresh, and reconcile`);
  }
}

function sourceFor(adapter: TaskSourceAdapter, source: TaskSourceDescriptor): TaskSourceDescriptor {
  try {
    const value = assertTaskSourceDescriptor(source);
    if (value.adapter !== adapter.id) {
      throw operationError("INVALID_DESCRIPTOR", `source adapter ${value.adapter} does not match ${adapter.id}`);
    }
    if (value.source_kind !== adapter.source_kind) {
      throw operationError("INVALID_DESCRIPTOR", `source kind ${value.source_kind} does not match adapter ${adapter.id}`);
    }
    return value;
  } catch (error) {
    if (error instanceof TaskSourceAdapterError) throw error;
    const diagnostics = (error as { diagnostics?: readonly RollingDiagnostic[] }).diagnostics || [];
    throw new TaskSourceAdapterError("INVALID_DESCRIPTOR", "invalid task source descriptor", diagnostics);
  }
}

function limitOf(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1) throw operationError("INVALID_DESCRIPTOR", "discovery limit must be a positive integer");
  return Math.min(value, maximum);
}

function validatePage(page: TaskManifestPage, adapter: TaskSourceAdapter, maximum: number): TaskManifestPage {
  try {
    const value = assertTaskManifestPage(page);
    if (value.source.adapter !== adapter.id || value.source.source_kind !== adapter.source_kind) {
      throw operationError("INVALID_PAGE", `manifest source does not match adapter ${adapter.id}`);
    }
    if (value.entries.length > maximum) throw operationError("INVALID_PAGE", `manifest page exceeds bounded limit ${maximum}`);
    return value;
  } catch (error) {
    if (error instanceof TaskSourceAdapterError) throw error;
    const diagnostics = (error as { diagnostics?: readonly RollingDiagnostic[] }).diagnostics || [];
    throw new TaskSourceAdapterError("INVALID_PAGE", "adapter returned an invalid manifest page", diagnostics);
  }
}

function validateEntries(entries: readonly TaskManifestEntry[], adapter: TaskSourceAdapter): readonly TaskManifestEntry[] {
  const out: TaskManifestEntry[] = [];
  for (const entry of entries) {
    const result = validateTaskManifestEntry(entry);
    if (!result.valid) throw new TaskSourceAdapterError("INVALID_ENTRY", `adapter ${adapter.id} returned an invalid manifest entry`, result.diagnostics);
    if (entry.source_kind !== adapter.source_kind) throw operationError("INVALID_ENTRY", `manifest entry source kind does not match adapter ${adapter.id}`);
    out.push(entry);
  }
  return out;
}

function validateReconciliation(value: unknown, adapter: TaskSourceAdapter): TaskSourceReconciliation | TaskManifestEntry {
  const manifest = validateTaskManifestEntry(value);
  if (manifest.valid) return validateEntries([value as TaskManifestEntry], adapter)[0]!;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw operationError("INVALID_ENTRY", `adapter ${adapter.id} returned an invalid reconciliation`);
  }
  const item = value as Record<string, unknown>;
  const allowed = new Set(["task_key", "source_fingerprint", "source_state", "source_ref", "conclusion"]);
  const valid = Object.keys(item).every((key) => allowed.has(key))
    && typeof item.task_key === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(item.task_key)
    && typeof item.source_fingerprint === "string" && /^[0-9a-f]{64}$/u.test(item.source_fingerprint)
    && ["complete", "pending", "unavailable"].includes(String(item.source_state))
    && Object.hasOwn(item, "source_ref")
    && (item.conclusion === undefined || typeof item.conclusion === "string");
  if (!valid) throw operationError("INVALID_ENTRY", `adapter ${adapter.id} returned an invalid reconciliation`);
  return value as TaskSourceReconciliation;
}

function validateReconciliations(value: unknown, adapter: TaskSourceAdapter): readonly (TaskSourceReconciliation | TaskManifestEntry)[] {
  if (!Array.isArray(value)) throw operationError("INVALID_ENTRY", `adapter ${adapter.id} returned an invalid reconciliation batch`);
  return value.map((item) => validateReconciliation(item, adapter));
}

/** Deterministic registry for source adapters. Each registry owns its map. */
export class TaskSourceAdapterRegistry {
  private readonly adapters = new Map<string, TaskSourceAdapter>();
  readonly max_page_size: number;

  constructor(adapters: readonly TaskSourceAdapter[] = [], options: TaskSourceAdapterRegistryOptions = {}) {
    const configured = options.max_page_size ?? options.maxPageSize ?? DEFAULT_TASK_SOURCE_PAGE_LIMIT;
    if (!Number.isSafeInteger(configured) || configured < 1) throw operationError("INVALID_ADAPTER", "max page size must be a positive integer");
    this.max_page_size = configured;
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: TaskSourceAdapter): this {
    validateAdapter(adapter);
    const id = adapterId(adapter);
    if (this.adapters.has(id)) throw operationError("DUPLICATE_ADAPTER", `task source adapter ${id} is already registered`);
    this.adapters.set(id, adapter);
    return this;
  }

  unregister(id: string): boolean { return this.adapters.delete(String(id).trim()); }
  has(id: string): boolean { return this.adapters.has(String(id).trim()); }
  ids(): readonly string[] { return [...this.adapters.keys()].sort(); }
  list(): readonly TaskSourceAdapter[] { return this.ids().map((id) => this.adapters.get(id) as TaskSourceAdapter); }
  listAdapters(): readonly TaskSourceAdapter[] { return this.list(); }

  get(id: string): TaskSourceAdapter {
    const adapter = this.adapters.get(String(id).trim());
    if (!adapter) throw operationError("UNKNOWN_ADAPTER", `unknown task source adapter ${id}`);
    return adapter;
  }

  validateDescriptor(source: unknown): ReturnType<typeof validateTaskSourceDescriptor> {
    // Keep this method as a direct typed facade over the shared protocol
    // validator; registry lookup is intentionally separate from validation.
    return validateTaskSourceDescriptor(source);
  }

  private resolve(source: TaskSourceDescriptor): TaskSourceAdapter {
    const adapter = this.get(source.adapter);
    sourceFor(adapter, source);
    return adapter;
  }

  async discover(source: TaskSourceDescriptor, options: { cursor?: string | null; limit?: number } | string | null = {}): Promise<TaskSourceDiscoveryResult> {
    const adapter = this.resolve(source);
    let requestOptions: { cursor?: string | null; limit?: number };
    if (typeof options === "string" || options === null) requestOptions = { cursor: options as string | null };
    else requestOptions = options;
    const request: TaskSourceDiscoverRequest = { source: sourceFor(adapter, source), cursor: requestOptions.cursor, limit: limitOf(requestOptions.limit, this.max_page_size) };
    try {
      const raw = await adapter.discover(request);
      if (isResult(raw)) {
        if (raw.status === "unavailable") return raw as TaskSourceUnavailableResult<TaskManifestPage>;
        return available(validatePage(raw.value, adapter, request.limit), raw.diagnostics);
      }
      return available(validatePage(raw as TaskManifestPage, adapter, request.limit));
    } catch (error) {
      if (error instanceof TaskSourceAdapterError && error.code === "INVALID_PAGE") throw error;
      return unavailable("DISCOVERY_UNAVAILABLE", `task source ${adapter.id} is temporarily unavailable during discovery`, error);
    }
  }

  async refresh(source: TaskSourceDescriptor, taskKeys: readonly string[]): Promise<TaskSourceRefreshResult> {
    const adapter = this.resolve(source);
    const request: TaskSourceRefreshRequest = { source: sourceFor(adapter, source), task_keys: [...taskKeys] };
    try {
      const raw = await adapter.refresh(request);
      if (isResult(raw)) {
        if (raw.status === "unavailable") return raw as TaskSourceUnavailableResult<readonly TaskManifestEntry[]>;
        return available(validateEntries(raw.value as readonly TaskManifestEntry[], adapter), raw.diagnostics);
      }
      return available(validateEntries(raw as readonly TaskManifestEntry[], adapter));
    } catch (error) {
      if (error instanceof TaskSourceAdapterError && error.code === "INVALID_ENTRY") throw error;
      return unavailable("REFRESH_UNAVAILABLE", `task source ${adapter.id} is temporarily unavailable during refresh`, error);
    }
  }

  async reconcile(source: TaskSourceDescriptor, taskKey: string, conclusion: string, expectedSourceFingerprint: string): Promise<TaskSourceReconcileResult> {
    const adapter = this.resolve(source);
    const request: TaskSourceReconcileRequest = { source: sourceFor(adapter, source), task_key: taskKey, conclusion, expected_source_fingerprint: expectedSourceFingerprint };
    try {
      const raw = await adapter.reconcile(request);
      if (isResult(raw)) {
        if (raw.status === "unavailable") return raw as TaskSourceUnavailableResult<TaskSourceReconciliation | TaskManifestEntry>;
        return available(validateReconciliation(raw.value, adapter), raw.diagnostics);
      }
      return available(validateReconciliation(raw, adapter));
    } catch (error) {
      if (error instanceof TaskSourceAdapterError && error.code === "INVALID_ENTRY") throw error;
      return unavailable("RECONCILIATION_UNAVAILABLE", `task source ${adapter.id} is temporarily unavailable during reconciliation`, error);
    }
  }

  async reconcileBatch(source: TaskSourceDescriptor, items: readonly TaskSourceBatchReconcileItem[]): Promise<TaskSourceBatchReconcileResult> {
    const adapter = this.resolve(source);
    const normalized = items.map((item) => ({ ...item }));
    if (normalized.length === 0) return available([]);
    if (!adapter.reconcile_batch) {
      if (normalized.length !== 1) {
        return unavailable("BATCH_RECONCILIATION_UNAVAILABLE", `task source ${adapter.id} does not support atomic batch reconciliation`);
      }
      const item = normalized[0]!;
      const result = await this.reconcile(source, item.task_key, item.conclusion, item.expected_source_fingerprint);
      return result.ok
        ? available([result.value], result.diagnostics)
        : { ok: false, status: "unavailable", diagnostics: result.diagnostics };
    }
    const request: TaskSourceBatchReconcileRequest = { source: sourceFor(adapter, source), items: normalized };
    try {
      const raw = await adapter.reconcile_batch(request);
      if (isResult(raw)) {
        if (raw.status === "unavailable") return raw as TaskSourceUnavailableResult<readonly (TaskSourceReconciliation | TaskManifestEntry)[]>;
        return available(validateReconciliations(raw.value, adapter), raw.diagnostics);
      }
      return available(validateReconciliations(raw, adapter));
    } catch (error) {
      if (error instanceof TaskSourceAdapterError && error.code === "INVALID_ENTRY") throw error;
      return unavailable("RECONCILIATION_UNAVAILABLE", `task source ${adapter.id} is temporarily unavailable during batch reconciliation`, error);
    }
  }

  async diagnostics(source: TaskSourceDescriptor, operation?: TaskSourceDiagnosticsRequest["operation"]): Promise<TaskSourceDiagnosticsResult> {
    const adapter = this.resolve(source);
    if (!adapter.diagnostics) return available([]);
    try {
      const raw = await adapter.diagnostics({ source: sourceFor(adapter, source), ...(operation ? { operation } : {}) });
      if (isResult(raw)) return raw as TaskSourceDiagnosticsResult;
      return available(raw as readonly TaskSourceDiagnostic[]);
    } catch (error) {
      return unavailable("DIAGNOSTICS_UNAVAILABLE", `task source ${adapter.id} diagnostics are temporarily unavailable`, error);
    }
  }
}

/** Convenient factory for callers that do not need to retain the class name. */
export function createTaskSourceAdapterRegistry(adapters: readonly TaskSourceAdapter[] = [], options?: TaskSourceAdapterRegistryOptions): TaskSourceAdapterRegistry {
  return new TaskSourceAdapterRegistry(adapters, options);
}

