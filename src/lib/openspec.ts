/**
 * Consume OpenSpec. Do not reimplement it.
 *
 * OpenSpec owns breakdown and status (tasks.md checkboxes, CLI status).
 * baton only reads those artifacts and writes conclusions / checkbox flips
 * after a card-routed worker finishes.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sha256Hex } from "./json-utils.js";
import { sha256Bytes } from "./openspec-apply.js";
import {
  detectOpenSpecRoot,
  openspecCliAvailable
} from "./openspec-cli.js";

export type OpenSpecTaskStatus = "pending" | "done" | "skipped";

export type OpenSpecErrorCode =
  | "OPENSPEC"
  | "NOT_FOUND"
  | "TASKS_MISSING"
  | "EMPTY"
  | "NO_CHANGE"
  | "AMBIGUOUS_CHANGE"
  | "TASK_ID_NOT_FOUND"
  | "TASK_ID_AMBIGUOUS"
  | "TASK_WRITEBACK_FAILED"
  | "APPLY_INSTRUCTIONS_FAILED"
  | "APPLY_INSTRUCTIONS_INVALID"
  | "CONTEXT_FILE_MISSING"
  | "CONTEXT_PATH_INVALID"
  | "TASK_LEDGER_MISSING"
  | "TASK_NUMBER_MISSING"
  | "TASK_NUMBER_AMBIGUOUS"
  | "TASK_MAPPING_MISSING"
  | "TASK_MAPPING_DUPLICATE"
  | "TASK_MAPPING_CONTRADICTORY"
  | "TASK_LEDGER_CHANGED"
  | "LEDGER_LOCKED";

export type OpenSpecConclusion = string;

export interface OpenSpecTask {
  section: string;
  number: string;
  description: string;
  status: OpenSpecTaskStatus;
  line_index: number;
}

export interface OpenSpecChange {
  tasksPath: string;
  text: string;
  tasks: OpenSpecTask[];
}

export type OpenSpecWritebackResult = string | null;

export type OpenSpecSource = "openspec-cli" | "artifacts" | "none";

export interface OpenSpecStatus {
  source: OpenSpecSource;
  ok: boolean;
  text: string;
}

export interface OpenSpecCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type OpenSpecRunner = (command: string, args: string[], cwd: string) => OpenSpecCommandResult;

/** A concrete artifact path returned by OpenSpec, together with its byte hash. */
export interface OpenSpecContextFile {
  artifact: string;
  path: string;
  sha256: string;
}

/** The identity of the canonical tasks ledger for a selected change. */
export interface OpenSpecTaskLedgerIdentity {
  path: string;
  /** The path is the ledger identity; content changes are represented by sha256. */
  identity: string;
  sha256: string;
  fingerprint?: string;
}

/** Read the current identity of an OpenSpec task ledger without invoking the
 * CLI.  Reconciliation uses this immediately before its atomic write. */
export function readTaskLedgerIdentity(tasksPath: string): OpenSpecTaskLedgerIdentity {
  if (!fs.existsSync(tasksPath)) throw new OpenSpecError(`OpenSpec task ledger not found: ${tasksPath}`, "TASK_LEDGER_MISSING");
  const resolved = path.resolve(tasksPath);
  const sha256 = sha256Bytes(resolved);
  return { path: resolved, identity: resolved, sha256, fingerprint: sha256 };
}

export interface OpenSpecSelectedTask {
  number: string;
  description: string;
  section: string;
  /** OpenSpec's transient apply identity; never used for reconciliation. */
  applyId?: string;
  apply_id?: string;
  /** OpenSpec's transient ordinal; never used for reconciliation. */
  applyOrdinal?: number;
  apply_ordinal?: number;
}

/** A validated mapping between one CLI task and one Markdown task number. */
export interface OpenSpecApplyTask {
  number: string;
  description: string;
  section: string;
  status: OpenSpecTaskStatus;
  done: boolean;
  applyId: string;
  apply_id: string;
  applyOrdinal?: number;
  apply_ordinal?: number;
}

/**
 * Read-only, typed projection of `openspec instructions apply --json`.
 * OpenSpec remains the owner of workflow state; this value is only a source
 * snapshot for a Baton plan and never writes or derives OpenSpec state.
 */
export interface OpenSpecApplyInstructions {
  changeName: string;
  schema: string;
  schemaName: string;
  changeRoot: string;
  /** Alias retained for parity with the OpenSpec CLI field. */
  changeDir: string;
  /** Concrete paths in deterministic artifact/path order. */
  contextFiles: OpenSpecContextFile[];
  contextFileHashes: Record<string, string>;
  pendingTaskNumbers: string[];
  /** Alias useful to plan consumers that call this a selected-task set. */
  selectedTaskNumbers: string[];
  selectedTasks: OpenSpecSelectedTask[];
  /** All mapped Markdown tasks, including completed tasks when the CLI returns them. */
  applyTasks?: OpenSpecApplyTask[];
  selectedTaskSnapshotFingerprint: string;
  selectedTaskFingerprint: string;
  taskLedger: OpenSpecTaskLedgerIdentity;
  taskLedgerIdentity: string;
  instruction: string;
  /** Alias retaining the distinction from static schema instructions. */
  dynamicInstruction: string;
  context?: string;
  operationGuidance?: string[];
}

export interface OpenSpecApplyResolveOptions {
  change?: string | null;
  cli?: string | null;
  runner?: OpenSpecRunner;
}

export class OpenSpecError extends Error {
  readonly code: OpenSpecErrorCode;

  constructor(message: string, code: OpenSpecErrorCode = "OPENSPEC") {
    super(message);
    this.name = "OpenSpecError";
    this.code = code;
  }
}

export function parseTasks(tasksMd: string): OpenSpecTask[] {
  const tasks: OpenSpecTask[] = [];
  let section = "";
  const lines = String(tasksMd || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("## ")) {
      section = trimmed.slice(3).trim();
      continue;
    }
    const m = trimmed.match(/^- \[([ xX-])\]\s+(.+)$/);
    if (!m) continue;
    const mark = m[1];
    const status = mark === " " ? "pending" : mark === "-" ? "skipped" : "done";
    const { number, description } = splitTaskNumber(m[2]);
    tasks.push({
      section,
      number,
      description,
      status,
      line_index: i,
    });
  }
  return tasks;
}

function splitTaskNumber(body: string): Pick<OpenSpecTask, "number" | "description"> {
  const text = body.trim();
  const space = text.indexOf(" ");
  if (space > 0) {
    const prefix = text.slice(0, space);
    if (prefix && /^[\d.]+$/.test(prefix)) {
      return { number: prefix, description: text.slice(space + 1).trim() };
    }
  }
  return { number: "", description: text };
}

export function applyTaskNumber(body: string): string {
  const text = String(body || "").trim();
  const match = text.match(/^([0-9]+(?:\.[0-9]+)*)\s+/);
  return match ? match[1] : "";
}

export function applyOrdinal(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

export function loadTasksFromChangeDir(changeDir: string): OpenSpecChange {
  if (!fs.existsSync(changeDir) || !fs.statSync(changeDir).isDirectory()) {
    throw new OpenSpecError(`OpenSpec change directory not found: ${changeDir}`, "NOT_FOUND");
  }
  const tasksPath = path.join(changeDir, "tasks.md");
  if (!fs.existsSync(tasksPath)) {
    throw new OpenSpecError(
      `tasks.md not found under ${changeDir}. baton will not invent a breakdown — create or update the change with OpenSpec.`,
      "TASKS_MISSING",
    );
  }
  const text = fs.readFileSync(tasksPath, "utf8");
  const tasks = parseTasks(text);
  if (tasks.length === 0) {
    throw new OpenSpecError(`no tasks found in ${tasksPath}`, "EMPTY");
  }
  return { tasksPath, text, tasks };
}

/**
 * Flip a checkbox and append a short conclusion as a child bullet.
 * Status remains the OpenSpec checkbox — baton does not keep a parallel ledger.
 */
export function writeTaskConclusion(
  tasksMd: string,
  lineIndex: number,
  conclusion: OpenSpecConclusion,
): OpenSpecWritebackResult {
  const lines = String(tasksMd).split(/\r?\n/);
  if (lineIndex < 0 || lineIndex >= lines.length) return null;
  const line = lines[lineIndex];
  const replaced = line.replace(/^(\s*)- \[[ ]\]/, "$1- [x]");
  if (replaced === line) return null;
  lines[lineIndex] = replaced;
  const indent = `${leadingWhitespace(line)}  - conclusion: ${singleLine(conclusion)}`;
  const already = lineIndex + 1 < lines.length && /^\s+- conclusion:/.test(lines[lineIndex + 1]);
  if (already) lines[lineIndex + 1] = indent;
  else lines.splice(lineIndex + 1, 0, indent);
  return lines.join("\n");
}

export function writeTaskConclusionByNumber(tasksMd: string, number: string, conclusion: OpenSpecConclusion): string {
  const matches = parseTasks(tasksMd).filter((task) => task.number === number);
  if (matches.length === 0) throw new OpenSpecError(`OpenSpec task number not found: ${number}`, "TASK_ID_NOT_FOUND");
  if (matches.length > 1) throw new OpenSpecError(`OpenSpec task number is ambiguous: ${number}`, "TASK_ID_AMBIGUOUS");
  const updated = writeTaskConclusion(tasksMd, matches[0].line_index, conclusion);
  if (updated == null) throw new OpenSpecError(`OpenSpec task writeback failed: ${number}`, "TASK_WRITEBACK_FAILED");
  return updated;
}

/**
 * Apply several task conclusions to one source snapshot.  Line positions are
 * resolved from the original parse and edits are made bottom-up, so this is
 * suitable for a parent-owned failure-atomic ledger write.  Existing done
 * tasks are left untouched and duplicate/missing numbers fail closed.
 */
export function writeTaskConclusions(tasksMd: string, conclusions: ReadonlyMap<string, OpenSpecConclusion> | Record<string, OpenSpecConclusion>): string {
  const entries = conclusions instanceof Map ? [...conclusions.entries()] : Object.entries(conclusions);
  if (entries.length === 0) return String(tasksMd);
  const tasks = parseTasks(tasksMd);
  const byNumber = new Map<string, OpenSpecTask>();
  for (const task of tasks) {
    if (!task.number) continue;
    if (byNumber.has(task.number)) throw new OpenSpecError(`OpenSpec task number is ambiguous: ${task.number}`, "TASK_ID_AMBIGUOUS");
    byNumber.set(task.number, task);
  }
  const seen = new Set<string>();
  const resolved = entries.map(([number, conclusion]) => {
    if (seen.has(number)) throw new OpenSpecError(`OpenSpec task number is ambiguous: ${number}`, "TASK_ID_AMBIGUOUS");
    seen.add(number);
    const task = byNumber.get(number);
    if (!task) throw new OpenSpecError(`OpenSpec task number not found: ${number}`, "TASK_ID_NOT_FOUND");
    if (task.status !== "pending") throw new OpenSpecError(`OpenSpec task is not pending: ${number}`, "TASK_WRITEBACK_FAILED");
    return { task, conclusion };
  }).sort((left, right) => right.task.line_index - left.task.line_index);
  let result = String(tasksMd);
  for (const { task, conclusion } of resolved) {
    const next = writeTaskConclusion(result, parseTasks(result).find((item) => item.number === task.number)?.line_index ?? -1, conclusion);
    if (next === null) throw new OpenSpecError(`OpenSpec task writeback failed: ${task.number}`, "TASK_WRITEBACK_FAILED");
    result = next;
  }
  const completed = new Map(parseTasks(result).map((task) => [task.number, task.status]));
  for (const [number] of entries) {
    if (completed.get(number) !== "done") throw new OpenSpecError(`OpenSpec task writeback failed: ${number}`, "TASK_WRITEBACK_FAILED");
  }
  return result;
}

function leadingWhitespace(line: string): string {
  const m = line.match(/^\s*/);
  return m ? m[0] : "";
}

function singleLine(text: OpenSpecConclusion): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export function listChangeNames(cwd: string): string[] {
  const dir = path.join(cwd, "openspec", "changes");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => fs.existsSync(path.join(dir, name, "tasks.md")));
}

/**
 * Use the OpenSpec CLI when available; otherwise report the local artifacts.
 * Never pretend baton is the status source of truth.
 */
export function readOpenSpecStatus(
  cwd: string,
  options: { cli?: string | null; runner?: OpenSpecRunner } = {},
): OpenSpecStatus {
  const cli = options.cli === undefined ? openspecCliAvailable() : options.cli;
  if (cli) {
    const runner = options.runner || ((command: string, args: string[], workingDirectory: string) => {
      const result = spawnSync(command, args, { cwd: workingDirectory, encoding: "utf8" });
      return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
    });
    const result = runner(cli, ["status"], cwd);
    if (result.status === 0) {
      return { source: "openspec-cli", ok: true, text: result.stdout.trim() };
    }
    const failure = (result.stderr || result.stdout || "").trim();
    if (/--change/.test(failure)) {
      const names = listChangeNames(cwd);
      if (names.length === 1) {
        const scoped = runner(cli, ["status", "--change", names[0]], cwd);
        const scopedText = scoped.status === 0 ? scoped.stdout : (scoped.stderr || scoped.stdout);
        return {
          source: "openspec-cli",
          ok: scoped.status === 0,
          text: (scopedText || "").trim() || `openspec status --change ${names[0]} exited ${scoped.status}`,
        };
      }
      const listing = runner(cli, ["list"], cwd);
      if (listing.status === 0) {
        return {
          source: "openspec-cli",
          ok: true,
          text: listing.stdout.trim() || (names.length ? `OpenSpec changes: ${names.join(", ")}` : "No OpenSpec changes."),
        };
      }
    }
    return {
      source: "openspec-cli",
      ok: false,
      text: failure || `openspec status exited ${result.status}`,
    };
  }
  const root = detectOpenSpecRoot(cwd);
  if (!root) {
    return { source: "none", ok: false, text: "OpenSpec not present. baton still works standalone." };
  }
  const names = listChangeNames(cwd);
  return {
    source: "artifacts",
    ok: true,
    text: names.length
      ? `OpenSpec changes (from artifacts, CLI not in PATH): ${names.join(", ")}`
      : "OpenSpec root present; no change with tasks.md.",
  };
}

export * from "./openspec-cli.js";
export { resolveOpenSpecApplyInstructions, readOpenSpecApplyInstructions } from "./openspec-apply.js";
