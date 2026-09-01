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

export function openspecCliAvailable(env: NodeJS.ProcessEnv = process.env): string | null {
  const pathEnv = env.PATH || env.Path || "";
  const parts = pathEnv.split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32" ? ["openspec.cmd", "openspec.exe", "openspec"] : ["openspec"];
  for (const dir of parts) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // keep scanning
      }
    }
  }
  return null;
}

export function detectOpenSpecRoot(cwd: string): string | null {
  const config = path.join(cwd, "openspec", "config.yaml");
  const changes = path.join(cwd, "openspec", "changes");
  if (fs.existsSync(config) || fs.existsSync(changes)) {
    return path.join(cwd, "openspec");
  }
  return null;
}

export function resolveChangeDir(cwd: string, change: string | null | undefined): string | null {
  if (!change) return null;
  if (path.isAbsolute(change)) return change;
  if (change.startsWith("openspec/") || change.startsWith("openspec\\")) {
    return path.join(cwd, change);
  }
  return path.join(cwd, "openspec", "changes", change);
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

function applyTaskNumber(body: string): string {
  const text = String(body || "").trim();
  const match = text.match(/^([0-9]+(?:\.[0-9]+)*)\s+/);
  return match ? match[1] : "";
}

function applyOrdinal(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

function projectApplyTasks(parsedTasks: OpenSpecTask[], rawTasks: unknown): OpenSpecApplyTask[] {
  if (!Array.isArray(rawTasks)) throw new OpenSpecError("OpenSpec apply instructions missing tasks", "APPLY_INSTRUCTIONS_INVALID");
  const byNumber = new Map<string, OpenSpecTask>();
  for (const task of parsedTasks) {
    if (task.number) byNumber.set(task.number, task);
  }
  const mapped: OpenSpecApplyTask[] = [];
  const numbers = new Set<string>();
  const ids = new Map<string, string>();
  for (const raw of rawTasks) {
    if (!raw || typeof raw !== "object") throw new OpenSpecError("OpenSpec apply instructions returned malformed tasks", "APPLY_INSTRUCTIONS_INVALID");
    const value = raw as Record<string, unknown>;
    if (typeof value.id !== "string" && typeof value.id !== "number") throw new OpenSpecError("OpenSpec apply instructions returned malformed tasks", "APPLY_INSTRUCTIONS_INVALID");
    if (typeof value.description !== "string" || typeof value.done !== "boolean") throw new OpenSpecError("OpenSpec apply instructions returned malformed tasks", "APPLY_INSTRUCTIONS_INVALID");
    const number = applyTaskNumber(value.description);
    if (!number) throw new OpenSpecError(`OpenSpec task description has no Markdown task number: ${value.description}`, "TASK_NUMBER_MISSING");
    const task = byNumber.get(number);
    if (!task) throw new OpenSpecError(`OpenSpec task mapping has no Markdown entry: ${number}`, "TASK_MAPPING_MISSING");
    const explicitNumber = [value.number, value.task_number, value.markdown_number, value.markdownNumber]
      .find((item) => typeof item === "string" && item.trim()) as string | undefined;
    if (explicitNumber && explicitNumber.trim() !== number) throw new OpenSpecError(`OpenSpec task mapping is contradictory for apply id ${String(value.id)}`, "TASK_MAPPING_CONTRADICTORY");
    if (numbers.has(number)) throw new OpenSpecError(`OpenSpec task mapping is duplicated: ${number}`, "TASK_MAPPING_DUPLICATE");
    const id = String(value.id);
    const previous = ids.get(id);
    if (previous && previous !== number) throw new OpenSpecError(`OpenSpec apply id ${id} maps to both ${previous} and ${number}`, "TASK_MAPPING_CONTRADICTORY");
    ids.set(id, number);
    const explicitOrdinal = applyOrdinal(value.ordinal ?? value.apply_ordinal ?? value.applyOrdinal);
    const idOrdinal = applyOrdinal(value.id);
    if (explicitOrdinal !== undefined && idOrdinal !== undefined && explicitOrdinal !== idOrdinal) {
      throw new OpenSpecError(`OpenSpec apply ordinal contradicts apply id ${id}`, "TASK_MAPPING_CONTRADICTORY");
    }
    const ordinal = explicitOrdinal ?? idOrdinal;
    // The CLI and the Markdown ledger are two views of the same completion
    // state. Keep the mapping bidirectional so either side cannot silently
    // bless stale or partially updated task state.
    if (task.status === "pending" && value.done) throw new OpenSpecError(`OpenSpec task completion contradicts pending Markdown task: ${number}`, "TASK_MAPPING_CONTRADICTORY");
    if (task.status === "done" && !value.done) throw new OpenSpecError(`OpenSpec task completion contradicts completed Markdown task: ${number}`, "TASK_MAPPING_CONTRADICTORY");
    numbers.add(number);
    mapped.push({ number, description: task.description, section: task.section, status: task.status, done: value.done, applyId: id, apply_id: id, ...(ordinal === undefined ? {} : { applyOrdinal: ordinal, apply_ordinal: ordinal }) });
  }
  return mapped;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Bytes(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function pathIsWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function concretePath(candidate: unknown, projectRoot: string, changeRoot: string, label: string): string {
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new OpenSpecError(`OpenSpec returned an invalid context path: ${label}`, "CONTEXT_PATH_INVALID");
  }
  const resolved = path.resolve(candidate);
  // A context may be a change artifact or a project-level instruction, but it
  // must never escape the selected project. realpath also closes symlink escapes.
  let isFile = false;
  try {
    isFile = fs.existsSync(resolved) && fs.statSync(resolved).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    throw new OpenSpecError(`OpenSpec context file not found: ${resolved}`, "CONTEXT_FILE_MISSING");
  }
  let real = resolved;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    throw new OpenSpecError(`OpenSpec context file cannot be resolved: ${resolved}`, "CONTEXT_FILE_MISSING");
  }
  if (!pathIsWithin(real, projectRoot)) {
    throw new OpenSpecError(`OpenSpec context path is outside the project boundary: ${resolved}`, "CONTEXT_PATH_INVALID");
  }
  // Keep this explicit in the contract: changeRoot is checked by the caller,
  // while projectRoot is the outer boundary for project-level context files.
  void changeRoot;
  return resolved;
}

function defaultOpenSpecRunner(command: string, args: string[], cwd: string): OpenSpecCommandResult {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function selectedChangeName(cwd: string, requested: string | null | undefined): string {
  if (requested) return requested;
  const names = listChangeNames(cwd);
  if (names.length === 1) return names[0];
  if (names.length === 0) throw new OpenSpecError("no OpenSpec change found", "NO_CHANGE");
  throw new OpenSpecError(`multiple OpenSpec changes: ${names.join(", ")}`, "AMBIGUOUS_CHANGE");
}

/**
 * Resolve the OpenSpec-owned apply context through its CLI. This deliberately
 * does not infer workflow state: the CLI output and its tasks ledger remain
 * authoritative, while Baton only snapshots concrete files and task identity.
 */
export function resolveOpenSpecApplyInstructions(
  cwd: string,
  change: string,
  options?: Omit<OpenSpecApplyResolveOptions, "change">,
): OpenSpecApplyInstructions;
export function resolveOpenSpecApplyInstructions(
  cwd: string,
  options: OpenSpecApplyResolveOptions,
): OpenSpecApplyInstructions;
export function resolveOpenSpecApplyInstructions(
  cwd: string,
  changeOrOptions: string | OpenSpecApplyResolveOptions,
  suppliedOptions: Omit<OpenSpecApplyResolveOptions, "change"> = {},
): OpenSpecApplyInstructions {
  const options: OpenSpecApplyResolveOptions = typeof changeOrOptions === "string"
    ? { ...suppliedOptions, change: changeOrOptions }
    : changeOrOptions;
  const change = selectedChangeName(cwd, options.change);
  const cli = options.cli === undefined ? openspecCliAvailable() : options.cli;
  if (!cli) throw new OpenSpecError("OpenSpec CLI is not available", "NOT_FOUND");
  const runner = options.runner || defaultOpenSpecRunner;
  let commandResult: OpenSpecCommandResult;
  try {
    commandResult = runner(cli, ["instructions", "apply", "--change", change, "--json"], cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new OpenSpecError(`OpenSpec apply instructions failed: ${message}`, "APPLY_INSTRUCTIONS_FAILED");
  }
  if (!commandResult || commandResult.status !== 0) {
    const message = String(commandResult?.stderr || commandResult?.stdout || "").trim();
    throw new OpenSpecError(message || `openspec instructions apply exited ${commandResult?.status ?? "unknown"}`, "APPLY_INSTRUCTIONS_FAILED");
  }
  let raw: unknown;
  try {
    const stdout = typeof commandResult.stdout === "string" ? commandResult.stdout.trim() : "";
    if (!stdout) throw new Error("empty output");
    raw = JSON.parse(stdout);
  } catch {
    throw new OpenSpecError("OpenSpec apply instructions returned malformed JSON", "APPLY_INSTRUCTIONS_INVALID");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new OpenSpecError("OpenSpec apply instructions must be a JSON object", "APPLY_INSTRUCTIONS_INVALID");
  }
  const output = raw as Record<string, unknown>;
  const stringField = (key: string): string => {
    const value = output[key];
    if (typeof value !== "string" || !value.trim()) throw new OpenSpecError(`OpenSpec apply instructions missing ${key}`, "APPLY_INSTRUCTIONS_INVALID");
    return value;
  };
  const changeName = stringField("changeName");
  const schemaName = stringField("schemaName");
  const outputChangeRoot = stringField("changeDir");
  const instruction = stringField("instruction");
  if (changeName !== change) throw new OpenSpecError(`OpenSpec returned a different change: ${changeName}`, "APPLY_INSTRUCTIONS_INVALID");

  const projectRoot = fs.realpathSync(cwd);
  const expectedChangeRoot = resolveChangeDir(cwd, change);
  if (!expectedChangeRoot) throw new OpenSpecError(`cannot resolve OpenSpec change: ${change}`, "NO_CHANGE");
  const resolvedChangeRoot = path.resolve(outputChangeRoot);
  if (!fs.existsSync(resolvedChangeRoot)) {
    throw new OpenSpecError(`OpenSpec change root is outside the project boundary: ${resolvedChangeRoot}`, "CONTEXT_PATH_INVALID");
  }
  let expectedReal: string;
  let outputReal: string;
  try {
    expectedReal = fs.realpathSync(expectedChangeRoot);
    outputReal = fs.realpathSync(resolvedChangeRoot);
  } catch {
    throw new OpenSpecError(`OpenSpec change root cannot be resolved: ${resolvedChangeRoot}`, "CONTEXT_PATH_INVALID");
  }
  if (expectedReal !== outputReal || !pathIsWithin(outputReal, projectRoot)) {
    throw new OpenSpecError(`OpenSpec returned an unexpected change root: ${resolvedChangeRoot}`, "CONTEXT_PATH_INVALID");
  }

  const rawContext = output.contextFiles;
  if (!rawContext || typeof rawContext !== "object" || Array.isArray(rawContext)) {
    throw new OpenSpecError("OpenSpec apply instructions missing contextFiles", "CONTEXT_FILE_MISSING");
  }
  const contextFiles: OpenSpecContextFile[] = [];
  const seenPaths = new Set<string>();
  for (const artifact of Object.keys(rawContext as Record<string, unknown>).sort()) {
    const paths = (rawContext as Record<string, unknown>)[artifact];
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new OpenSpecError(`OpenSpec context artifact has no files: ${artifact}`, "CONTEXT_FILE_MISSING");
    }
    const resolvedPaths = paths.map((candidate) => concretePath(candidate, projectRoot, outputReal, artifact)).sort();
    for (const file of resolvedPaths) {
      if (seenPaths.has(file)) throw new OpenSpecError(`OpenSpec context file is duplicated: ${file}`, "CONTEXT_PATH_INVALID");
      seenPaths.add(file);
      contextFiles.push({ artifact, path: file, sha256: sha256Bytes(file) });
    }
  }
  if (contextFiles.length === 0) throw new OpenSpecError("OpenSpec apply instructions returned no context files", "CONTEXT_FILE_MISSING");
  const taskFiles = contextFiles.filter((file) => file.artifact === "tasks" || path.basename(file.path).toLowerCase() === "tasks.md");
  if (taskFiles.length !== 1 || !taskFiles[0] || !pathIsWithin(fs.realpathSync(taskFiles[0].path), outputReal)) {
    throw new OpenSpecError("OpenSpec apply instructions must return exactly one tasks ledger under the selected change", "TASK_LEDGER_MISSING");
  }
  const taskLedgerFile = taskFiles[0];
  const taskText = fs.readFileSync(taskLedgerFile.path, "utf8");
  const parsedTasks = parseTasks(taskText);
  if (parsedTasks.length === 0) throw new OpenSpecError(`no tasks found in ${taskLedgerFile.path}`, "EMPTY");
  const numbers = new Set<string>();
  for (const task of parsedTasks) {
    if (!task.number) {
      if (task.status === "pending") throw new OpenSpecError("OpenSpec pending task has no stable task number", "TASK_NUMBER_MISSING");
      continue;
    }
    if (numbers.has(task.number)) throw new OpenSpecError(`OpenSpec task number is ambiguous: ${task.number}`, "TASK_NUMBER_AMBIGUOUS");
    numbers.add(task.number);
  }
  const applyTasks = projectApplyTasks(parsedTasks, output.tasks);
  const applyByNumber = new Map(applyTasks.map((task) => [task.number, task]));
  const selectedTasks = parsedTasks
    .filter((task) => task.status === "pending")
    .map((task) => {
      const apply = applyByNumber.get(task.number);
      return {
        number: task.number,
        description: task.description,
        section: task.section,
        ...(apply ? { applyId: apply.applyId, apply_id: apply.apply_id, ...(apply.applyOrdinal === undefined ? {} : { applyOrdinal: apply.applyOrdinal, apply_ordinal: apply.apply_ordinal }) } : {}),
      };
    });
  const pendingTaskNumbers = selectedTasks.map((task) => task.number);
  const contextFileHashes: Record<string, string> = {};
  for (const file of contextFiles) contextFileHashes[file.path] = file.sha256;
  const operationGuidance = output.operationGuidance === undefined
    ? undefined
    : Array.isArray(output.operationGuidance) && output.operationGuidance.every((item) => typeof item === "string")
      ? output.operationGuidance as string[]
      : (() => { throw new OpenSpecError("OpenSpec operationGuidance must be a string array", "APPLY_INSTRUCTIONS_INVALID"); })();
  // apply id/ordinal are transient CLI diagnostics. They are retained on the
  // projection for observability, but must not invalidate the semantic task
  // snapshot when the CLI reallocates them.
  const fingerprintedSelectedTasks = selectedTasks.map(({ number, description, section }) => ({ number, description, section }));
  const selectedTaskSnapshotFingerprint = crypto.createHash("sha256").update(stableJson(fingerprintedSelectedTasks), "utf8").digest("hex");
  const taskLedger: OpenSpecTaskLedgerIdentity = { path: taskLedgerFile.path, identity: taskLedgerFile.path, sha256: taskLedgerFile.sha256, fingerprint: taskLedgerFile.sha256 };
  return {
    changeName,
    schema: schemaName,
    schemaName,
    changeRoot: outputReal,
    changeDir: outputReal,
    contextFiles,
    contextFileHashes,
    pendingTaskNumbers,
    selectedTaskNumbers: [...pendingTaskNumbers],
    selectedTasks,
    applyTasks,
    selectedTaskSnapshotFingerprint,
    selectedTaskFingerprint: selectedTaskSnapshotFingerprint,
    taskLedger,
    taskLedgerIdentity: taskLedger.identity,
    instruction,
    dynamicInstruction: instruction,
    ...(typeof output.context === "string" ? { context: output.context } : {}),
    ...(operationGuidance !== undefined ? { operationGuidance } : {}),
  };
}

export const readOpenSpecApplyInstructions = resolveOpenSpecApplyInstructions;

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
