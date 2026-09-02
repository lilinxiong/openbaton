/**
 * OpenSpec apply-instruction resolution. Split from openspec.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "./json-utils.js";
import {
  defaultOpenSpecRunner,
  openspecCliAvailable,
  resolveChangeDir
} from "./openspec-cli.js";
import {
  OpenSpecApplyInstructions,
  OpenSpecApplyResolveOptions,
  OpenSpecApplyTask,
  OpenSpecCommandResult,
  OpenSpecContextFile,
  OpenSpecError,
  OpenSpecTask,
  OpenSpecTaskLedgerIdentity,
  applyOrdinal,
  applyTaskNumber,
  listChangeNames,
  parseTasks
} from "./openspec.js";

export function projectApplyTasks(parsedTasks: OpenSpecTask[], rawTasks: unknown): OpenSpecApplyTask[] {
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

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Bytes(file: string): string {
  return sha256Hex(fs.readFileSync(file));
}

export function pathIsWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function concretePath(candidate: unknown, projectRoot: string, changeRoot: string, label: string): string {
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


export function selectedChangeName(cwd: string, requested: string | null | undefined): string {
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
  const selectedTaskSnapshotFingerprint = sha256Hex(stableJson(fingerprintedSelectedTasks));
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
