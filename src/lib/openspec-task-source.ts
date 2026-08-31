/** OpenSpec implementation of the source-neutral rolling TaskSourceAdapter. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  OpenSpecError,
  type OpenSpecApplyInstructions,
  type OpenSpecApplyTask,
  type OpenSpecRunner,
  parseTasks,
  readTaskLedgerIdentity,
  resolveChangeDir,
  resolveOpenSpecApplyInstructions,
  writeTaskConclusionByNumber,
} from "./openspec.js";
import { withOwnedLock } from "./owned-lock.js";
import {
  fingerprintTaskManifestEntry,
  type TaskManifestEntry,
  type TaskManifestPage,
  type TaskSourceDescriptor,
} from "./rolling-plan.js";
import type {
  TaskSourceAdapter,
  TaskSourceDiagnostic,
  TaskSourceDiscoverRequest,
  TaskSourceReconcileRequest,
  TaskSourceReconciliation,
  TaskSourceRefreshRequest,
  TaskSourceResult,
} from "./task-source.js";

export interface OpenSpecTaskSourceSelection {
  change?: string;
  cwd?: string;
  cli?: string | null;
  runner?: OpenSpecRunner;
}

export interface OpenSpecTaskSourceAdapterOptions {
  cwd?: string;
  cli?: string | null;
  runner?: OpenSpecRunner;
}

export const OPENSPEC_TASK_SOURCE_ADAPTER_ID = "openspec" as const;
export const OPEN_SPEC_TASK_SOURCE_ADAPTER_ID = OPENSPEC_TASK_SOURCE_ADAPTER_ID;

const unavailableCodes = new Set([
  "NOT_FOUND", "TASKS_MISSING", "NO_CHANGE", "AMBIGUOUS_CHANGE", "EMPTY",
  "APPLY_INSTRUCTIONS_FAILED", "APPLY_INSTRUCTIONS_INVALID", "TASK_LEDGER_MISSING",
  "LEDGER_LOCKED", "TASK_LEDGER_CHANGED",
]);

function diagnostic(code: string, message: string): TaskSourceDiagnostic {
  return { code, message, severity: "warning" };
}

function unavailable<T>(operation: string, cause: unknown): TaskSourceResult<T> {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const code = error instanceof OpenSpecError && unavailableCodes.has(error.code)
    ? error.code
    : `${operation.toUpperCase()}_UNAVAILABLE`;
  return { ok: false, status: "unavailable", diagnostics: [diagnostic(code, `OpenSpec source is temporarily unavailable during ${operation}: ${error.message}`)] };
}

function selectionOf(source: TaskSourceDescriptor, options: OpenSpecTaskSourceAdapterOptions): OpenSpecTaskSourceSelection {
  const selection = source.selection && typeof source.selection === "object" && !Array.isArray(source.selection)
    ? source.selection as OpenSpecTaskSourceSelection
    : {};
  return {
    ...selection,
    cwd: selection.cwd || options.cwd,
    cli: selection.cli === undefined ? options.cli : selection.cli,
    runner: selection.runner || options.runner,
  };
}

function changeOf(source: TaskSourceDescriptor, options: OpenSpecTaskSourceAdapterOptions): { cwd: string; change: string; cli?: string | null; runner?: OpenSpecRunner } {
  const selection = selectionOf(source, options);
  const change = selection.change || (typeof source.source_ref === "string" ? source.source_ref : undefined);
  if (!selection.cwd || !change) throw new OpenSpecError("OpenSpec source requires cwd and selected change", "TASK_LEDGER_MISSING");
  return { cwd: path.resolve(selection.cwd), change, ...(selection.cli === undefined ? {} : { cli: selection.cli }), ...(selection.runner ? { runner: selection.runner } : {}) };
}

function applyMap(instructions: OpenSpecApplyInstructions): Map<string, OpenSpecApplyTask> {
  return new Map((instructions.applyTasks || []).map((task) => [task.number, task]));
}

function taskKey(change: string, number: string): string { return `openspec:${change}:${number}`; }

function fingerprintEntry(entry: TaskManifestEntry): string {
  // OpenSpec apply ids and ordinals are transient diagnostics, not source
  // identity. Keep them in the returned entry but exclude them from its
  // semantic fingerprint so CLI reallocation does not look like source drift.
  const semantic = { ...entry };
  delete semantic.apply_ordinal;
  if (semantic.metadata) {
    const metadata = { ...semantic.metadata };
    delete metadata.apply_id;
    delete metadata.apply_ordinal;
    semantic.metadata = metadata;
  }
  return fingerprintTaskManifestEntry(semantic);
}

function numberFromKey(key: string, change: string, sourceRef: unknown): string {
  const prefix = `openspec:${change}:`;
  if (key.startsWith(prefix)) return key.slice(prefix.length);
  if (/^[0-9]+(?:\.[0-9]+)*$/.test(key)) return key;
  if (sourceRef && typeof sourceRef === "object" && typeof (sourceRef as Record<string, unknown>).number === "string") return (sourceRef as Record<string, unknown>).number as string;
  throw new OpenSpecError(`OpenSpec task key is not a stable Markdown number: ${key}`, "TASK_NUMBER_MISSING");
}

function conclusionAt(text: string, line: number): string | null {
  const match = text.split(/\r?\n/)[line + 1]?.match(/^\s+- conclusion:\s*(.*)$/);
  return match ? match[1].trim() : null;
}

/** Reconstruct the pre-write bytes so an identical retry cannot bless an
 * unrelated edit that happens to reuse the same conclusion text. */
function previousWriteFingerprint(text: string, line: number, conclusion: string): string | null {
  const separator = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  if (line < 0 || line >= lines.length || conclusionAt(text, line) !== conclusion) return null;
  lines[line] = lines[line].replace(/^(\s*)- \[[xX]\]/, "$1- [ ]");
  lines.splice(line + 1, 1);
  return crypto.createHash("sha256").update(lines.join(separator), "utf8").digest("hex");
}

function cleanConclusion(value: string): string { return String(value || "").replace(/\s+/g, " ").trim(); }

function atomicWrite(file: string, value: string): void {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    const bytes = Buffer.from(value, "utf8");
    fs.writeSync(fd, bytes, 0, bytes.length, 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* best effort */ }
  }
}

export class OpenSpecTaskSourceAdapter implements TaskSourceAdapter {
  readonly id = OPENSPEC_TASK_SOURCE_ADAPTER_ID;
  readonly source_kind = "openspec" as const;
  private readonly options: OpenSpecTaskSourceAdapterOptions;

  constructor(options: OpenSpecTaskSourceAdapterOptions | string = {}) {
    this.options = typeof options === "string" ? { cwd: options } : options;
  }

  sourceDescriptor(selection?: unknown): TaskSourceDescriptor {
    return { schema_version: 1, source_kind: "openspec", adapter: this.id, ...(selection === undefined ? {} : { selection: structuredClone(selection) }) };
  }

  private instructions(source: TaskSourceDescriptor): OpenSpecApplyInstructions {
    const selected = changeOf(source, this.options);
    return resolveOpenSpecApplyInstructions(selected.cwd, selected.change, { cli: selected.cli, runner: selected.runner });
  }

  private entries(source: TaskSourceDescriptor, instructions: OpenSpecApplyInstructions): TaskManifestEntry[] {
    const selected = changeOf(source, this.options);
    const changeDir = resolveChangeDir(selected.cwd, selected.change);
    if (!changeDir) throw new OpenSpecError(`cannot resolve OpenSpec change: ${selected.change}`, "NO_CHANGE");
    const ledger = readTaskLedgerIdentity(instructions.taskLedger.path);
    const mapped = applyMap(instructions);
    const tasks = parseTasks(fs.readFileSync(ledger.path, "utf8"));
    return tasks.filter((task) => Boolean(task.number)).map((task, index) => {
      const apply = mapped.get(task.number);
      const sourceRef = { change: selected.change, number: task.number, tasks_path: ledger.path };
      const entry: TaskManifestEntry = {
        schema_version: 1,
        task_key: taskKey(selected.change, task.number),
        source_kind: "openspec",
        source_ref: sourceRef,
        display_id: task.number,
        title: task.description,
        source_fingerprint: ledger.sha256,
        source_state: task.status === "pending" ? "pending" : "complete",
        discovery_sequence: index,
        ...(apply?.applyOrdinal === undefined ? {} : { apply_ordinal: apply.applyOrdinal }),
        metadata: {
          ...(apply ? { apply_id: apply.applyId, apply_ordinal: apply.applyOrdinal, markdown_number: task.number } : { markdown_number: task.number }),
          section: task.section,
          status: task.status,
        },
      };
      entry.fingerprint = fingerprintEntry(entry);
      return entry;
    });
  }

  discover(request: TaskSourceDiscoverRequest): TaskSourceResult<TaskManifestPage> {
    try {
      const instructions = this.instructions(request.source);
      const all = this.entries(request.source, instructions);
      const offset = request.cursor == null || request.cursor === "" ? 0 : Number(request.cursor);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new OpenSpecError("OpenSpec discovery cursor is invalid", "APPLY_INSTRUCTIONS_INVALID");
      const entries = all.slice(offset, offset + request.limit);
      const next = offset + entries.length < all.length ? String(offset + entries.length) : null;
      return { ok: true, status: "available", value: { schema_version: 1, source: request.source, entries, cursor: request.cursor ?? null, next_cursor: next, has_more: next !== null }, diagnostics: [] };
    } catch (error) {
      if (error instanceof OpenSpecError && !unavailableCodes.has(error.code)) throw error;
      return unavailable("discovery", error);
    }
  }

  refresh(request: TaskSourceRefreshRequest): TaskSourceResult<readonly TaskManifestEntry[]> {
    try {
      const instructions = this.instructions(request.source);
      const all = new Map(this.entries(request.source, instructions).map((entry) => [entry.task_key, entry]));
      const result = request.task_keys.map((key) => {
        const entry = all.get(key);
        if (!entry) throw new OpenSpecError(`OpenSpec task not found: ${key}`, "TASK_ID_NOT_FOUND");
        return entry;
      });
      return { ok: true, status: "available", value: result, diagnostics: [] };
    } catch (error) {
      if (error instanceof OpenSpecError && !unavailableCodes.has(error.code) && error.code !== "TASK_LEDGER_MISSING") throw error;
      return unavailable("refresh", error);
    }
  }

  reconcile(request: TaskSourceReconcileRequest): TaskSourceResult<TaskSourceReconciliation> {
    try {
      const selected = changeOf(request.source, this.options);
      const number = numberFromKey(request.task_key, selected.change, request.source.source_ref);
      const changeDir = resolveChangeDir(selected.cwd, selected.change);
      if (!changeDir) throw new OpenSpecError(`cannot resolve OpenSpec change: ${selected.change}`, "NO_CHANGE");
      const ledgerPath = path.join(changeDir, "tasks.md");
      const lockPath = `${ledgerPath}.baton.lock`;
      const result = withOwnedLock(lockPath, () => {
        const before = readTaskLedgerIdentity(ledgerPath);
        const sourceText = fs.readFileSync(before.path, "utf8");
        const matches = parseTasks(sourceText).filter((task) => task.number === number);
        if (matches.length === 0) throw new OpenSpecError(`OpenSpec task number not found: ${number}`, "TASK_ID_NOT_FOUND");
        if (matches.length > 1) throw new OpenSpecError(`OpenSpec task number is ambiguous: ${number}`, "TASK_ID_AMBIGUOUS");
        const task = matches[0];
        const conclusion = cleanConclusion(request.conclusion);
        if (task.status === "done" && before.sha256 !== request.expected_source_fingerprint
          && previousWriteFingerprint(sourceText, task.line_index, conclusion) === request.expected_source_fingerprint) {
          return { task, identity: before };
        }
        if (before.sha256 !== request.expected_source_fingerprint) throw new OpenSpecError("OpenSpec task ledger changed during reconciliation", "TASK_LEDGER_CHANGED");
        if (task.status !== "pending") throw new OpenSpecError(`OpenSpec task is not pending: ${number}`, "TASK_WRITEBACK_FAILED");
        const updated = writeTaskConclusionByNumber(sourceText, number, conclusion);
        atomicWrite(before.path, updated);
        return { task, identity: readTaskLedgerIdentity(before.path) };
      }, { operation: "openspec-task-reconcile" });
      return { ok: true, status: "available", value: { task_key: request.task_key, source_fingerprint: result.identity.sha256, source_state: "complete", source_ref: { change: selected.change, number, tasks_path: result.identity.path }, conclusion: cleanConclusion(request.conclusion) }, diagnostics: [] };
    } catch (error) {
      if (error instanceof OpenSpecError && !["NOT_FOUND", "TASKS_MISSING", "NO_CHANGE", "EMPTY", "TASK_LEDGER_MISSING", "LEDGER_LOCKED", "TASK_LEDGER_CHANGED"].includes(error.code)) throw error;
      if ((error as NodeJS.ErrnoException).code === "LOCK_BUSY" || (error instanceof Error && error.message.startsWith("lock is busy:"))) return unavailable("reconciliation", new OpenSpecError("OpenSpec task ledger is locked", "LEDGER_LOCKED"));
      return unavailable("reconciliation", error);
    }
  }
}

export function createOpenSpecTaskSourceAdapter(options: OpenSpecTaskSourceAdapterOptions | string = {}): OpenSpecTaskSourceAdapter {
  return new OpenSpecTaskSourceAdapter(options);
}

export const OpenSpecAdapter = OpenSpecTaskSourceAdapter;
