import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { BATON_DIR } from "./paths.js";

/** Project-local Baton runtime artifacts (.baton/...) are never worker changes or baseline dirt. */
export function isBatonRuntimePath(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const normalized = candidate.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized === BATON_DIR || normalized.startsWith(BATON_DIR + "/");
}

export type SafetyOperation = "write" | "create" | "delete" | "rename" | "chmod";

export interface GitBaseline {
  repo_root: string;
  head: string;
  branch: string;
  index_path: string;
  index_checksum: string | null;
  dirty_entries: StatusEntry[];
  captured_at: string;
}

export interface StatusEntry {
  code: string;
  path: string;
  original_path?: string;
}

export interface SafetyPolicy {
  write_allowlist: string[];
  allowed_operations: SafetyOperation[];
}

export interface SafetyViolation {
  code: string;
  path?: string;
  original_path?: string;
  operation?: SafetyOperation;
  message: string;
}

export interface SafetyVerdict {
  accepted: boolean;
  changes: Array<StatusEntry & { operation: SafetyOperation }>;
  violations: SafetyViolation[];
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`git safety command failed: git ${args.join(" ")}: ${message}`);
  }
}

function checksumFile(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function parsePorcelainV1Z(output: string): StatusEntry[] {
  const tokens = output.split("\0");
  const entries: StatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.length < 4) throw new Error("invalid git porcelain record");
    const code = token.slice(0, 2);
    const item: StatusEntry = { code, path: token.slice(3) };
    if (code.includes("R") || code.includes("C")) {
      const original = tokens[index + 1];
      if (!original) throw new Error("rename record missing original path");
      item.original_path = original;
      index += 1;
    }
    entries.push(item);
  }
  return entries;
}

export function captureBaseline(worktree: string, now: Date = new Date()): GitBaseline {
  const repoRoot = git(worktree, ["rev-parse", "--show-toplevel"]).trim();
  const head = git(repoRoot, ["rev-parse", "HEAD"]).trim();
  const branch = git(repoRoot, ["branch", "--show-current"]).trim();
  const indexRelative = git(repoRoot, ["rev-parse", "--git-path", "index"]).trim();
  const indexPath = path.isAbsolute(indexRelative) ? indexRelative : path.join(repoRoot, indexRelative);
  const dirtyEntries = parsePorcelainV1Z(git(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
    .filter((entry) => !isBatonRuntimePath(entry.path) && !isBatonRuntimePath(entry.original_path));
  return {
    repo_root: fs.realpathSync(repoRoot),
    head,
    branch,
    index_path: indexPath,
    index_checksum: checksumFile(indexPath),
    dirty_entries: dirtyEntries,
    captured_at: now.toISOString(),
  };
}

function globPattern(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..") || normalized === ".git" || normalized.startsWith(".git/")) {
    throw new Error(`invalid write allowlist entry: ${pattern}`);
  }
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") { source += ".*"; index += 1; }
    else if (char === "*") source += "[^/]*";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  if (normalized.endsWith("/")) source += ".*";
  return new RegExp(`^${source}$`);
}

export function pathAllowed(candidate: string, allowlist: string[]): boolean {
  const normalized = candidate.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..") || normalized === ".git" || normalized.startsWith(".git/")) return false;
  return allowlist.some((entry) => globPattern(entry).test(normalized));
}

function operationOf(entry: StatusEntry): SafetyOperation {
  if (entry.code === "??" || entry.code.includes("A")) return "create";
  if (entry.code.includes("R") || entry.code.includes("C")) return "rename";
  if (entry.code.includes("D")) return "delete";
  if (entry.code.includes("T")) return "chmod";
  return "write";
}

export function auditWorktree(worktree: string, baseline: GitBaseline, policy: SafetyPolicy): SafetyVerdict {
  const root = fs.realpathSync(git(worktree, ["rev-parse", "--show-toplevel"]).trim());
  const violations: SafetyViolation[] = [];
  if (root !== baseline.repo_root) violations.push({ code: "E_BASELINE_REPO_MISMATCH", message: "baseline belongs to another repository" });
  if (baseline.dirty_entries.length) violations.push({ code: "E_DIRTY_BASELINE", message: "write workers require a clean declared baseline" });
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  if (head !== baseline.head) violations.push({ code: "E_HEAD_MUTATION", message: "worker changed Git HEAD" });
  if (checksumFile(baseline.index_path) !== baseline.index_checksum) violations.push({ code: "E_INDEX_MUTATION", message: "worker changed the Git index" });

  const entries = parsePorcelainV1Z(git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
    .filter((entry) => !isBatonRuntimePath(entry.path) && !isBatonRuntimePath(entry.original_path));
  const modeChanged = new Set(
    git(root, ["diff", "--summary", "HEAD"]).split("\n")
      .map((line) => line.match(/^ mode change \d+ => \d+ (.+)$/)?.[1])
      .filter((item): item is string => Boolean(item)),
  );
  const changes = entries.map((entry) => ({ ...entry, operation: modeChanged.has(entry.path) ? "chmod" as const : operationOf(entry) }));
  for (const change of changes) {
    if (!pathAllowed(change.path, policy.write_allowlist) || (change.original_path && !pathAllowed(change.original_path, policy.write_allowlist))) {
      violations.push({ code: "E_OUT_OF_SCOPE_PATH", path: change.path, original_path: change.original_path, operation: change.operation, message: "changed path is outside the Receipt allowlist" });
      continue;
    }
    if (!policy.allowed_operations.includes(change.operation)) {
      violations.push({ code: "E_OUT_OF_SCOPE_OP", path: change.path, original_path: change.original_path, operation: change.operation, message: "change operation is not authorized" });
      continue;
    }
    const absolute = path.join(root, change.path);
    if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink()) {
      const resolved = fs.realpathSync(absolute);
      const relative = path.relative(root, resolved).replaceAll("\\", "/");
      if (relative.startsWith("../") || !pathAllowed(relative, policy.write_allowlist)) {
        violations.push({ code: "E_SYMLINK_ESCAPE", path: change.path, operation: change.operation, message: "symlink target escapes repository or Receipt scope" });
      }
    }
  }
  return { accepted: violations.length === 0, changes, violations };
}
