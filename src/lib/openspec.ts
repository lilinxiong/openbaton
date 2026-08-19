/**
 * Consume OpenSpec. Do not reimplement it.
 *
 * OpenSpec owns breakdown and status (tasks.md checkboxes, CLI status).
 * baton only reads those artifacts and writes conclusions / checkbox flips
 * after a card-routed worker finishes.
 */
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
  | "TASK_WRITEBACK_FAILED";

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
  const replaced = line.replace(/^- \[[ ]\]/, "- [x]");
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
 * Prefer the OpenSpec CLI for status. Fall back to artifact presence only.
 * Never pretend baton is the status source of truth.
 */
export function readOpenSpecStatus(cwd: string): OpenSpecStatus {
  const cli = openspecCliAvailable();
  if (cli) {
    const result = spawnSync(cli, ["status"], { cwd, encoding: "utf8" });
    if (result.status === 0) {
      return { source: "openspec-cli", ok: true, text: result.stdout.trim() };
    }
    return {
      source: "openspec-cli",
      ok: false,
      text: (result.stderr || result.stdout || "").trim() || `openspec status exited ${result.status}`,
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
