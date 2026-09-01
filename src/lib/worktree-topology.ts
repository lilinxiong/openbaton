/**
 * Read-only Git topology discovery for isolated rolling execution.
 *
 * Every query is intentionally scalar and runs with optional Git locks
 * disabled. This module never creates a ref, index, worktree, or repository.
 */
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { RepositoryLocalUnitPart } from "./rolling-plan.js";

export const WORKTREE_TOPOLOGY_SCHEMA_VERSION = 1 as const;

export type RepositoryTopologyKind = "repository" | "linked-worktree" | "nested-repository" | "submodule";

export interface GitRepositoryIdentity {
  schema_version: typeof WORKTREE_TOPOLOGY_SCHEMA_VERSION;
  /** Stable for all linked worktrees backed by the same Git common directory. */
  repository_id: string;
  repository_root: string;
  repository_root_identity: string;
  git_dir: string;
  git_dir_identity: string;
  git_common_dir: string;
  git_common_dir_identity: string;
  object_format: string;
  topology_kind: RepositoryTopologyKind;
  is_linked_worktree: boolean;
  is_nested_repository: boolean;
  is_submodule: boolean;
  workspace_repository_root: string;
  superproject_root?: string;
}

export interface ResolvedRepositoryWritePath {
  declared_path: string;
  normalized_path: string;
  absolute_path: string;
  repository_relative_path: string;
  repository: GitRepositoryIdentity;
  endpoint: "path" | "rename-source" | "rename-target";
}

export interface RepositoryLocalTopologyPart extends RepositoryLocalUnitPart {
  git_common_dir_identity: string;
  repository_root: string;
  topology_kind: RepositoryTopologyKind;
}

export interface WorktreeTopologyResolution {
  schema_version: typeof WORKTREE_TOPOLOGY_SCHEMA_VERSION;
  workspace_root: string;
  workspace_repository_root: string;
  repositories: GitRepositoryIdentity[];
  write_paths: ResolvedRepositoryWritePath[];
  repository_parts: RepositoryLocalTopologyPart[];
  integration_order: string[];
  integration_gate_keys: string[];
  requires_repository_decomposition: boolean;
  requires_parent_integration_gate: boolean;
}

export interface RepositoryDecompositionDiagnostic {
  code: string;
  message: string;
  path?: string;
  refs?: string[];
}

export interface RepositoryDecompositionValidationResult {
  valid: boolean;
  diagnostics: RepositoryDecompositionDiagnostic[];
  topology?: WorktreeTopologyResolution;
}

export interface RepositoryDecompositionInput {
  write_paths: readonly string[];
  repository_parts?: readonly RepositoryLocalUnitPart[];
  integration_gate_keys?: readonly string[];
}

export type WorktreeTopologyErrorCode =
  | "WORKTREE_PATH_INVALID"
  | "WORKTREE_PATH_ESCAPE"
  | "WORKTREE_REPOSITORY_NOT_FOUND"
  | "WORKTREE_GIT_QUERY_FAILED"
  | "CROSS_REPOSITORY_RENAME"
  | "REPOSITORY_LOCAL_PARTS_REQUIRED"
  | "REPOSITORY_DECOMPOSITION_INVALID";

export class WorktreeTopologyError extends Error {
  readonly code: WorktreeTopologyErrorCode;
  readonly detail?: string;

  constructor(message: string, code: WorktreeTopologyErrorCode, detail?: string) {
    super(message);
    this.name = "WorktreeTopologyError";
    this.code = code;
    this.detail = detail;
  }
}

function sha(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalExisting(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch (cause) {
    throw new WorktreeTopologyError(`cannot resolve filesystem identity for ${value}`, "WORKTREE_PATH_INVALID", String(cause));
  }
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function potentialRealPath(value: string): { canonical: string; probe_dir: string } {
  let existing = value;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      throw new WorktreeTopologyError(`no existing ancestor for ${value}`, "WORKTREE_PATH_INVALID");
    }
    existing = parent;
  }
  const canonicalExistingPath = canonicalExisting(existing);
  const suffix = path.relative(existing, value);
  const canonical = path.resolve(canonicalExistingPath, suffix);
  let probe = fs.existsSync(canonical) ? canonical : path.dirname(canonical);
  while (!fs.existsSync(probe) || !fs.statSync(probe).isDirectory()) {
    const parent = path.dirname(probe);
    if (parent === probe) throw new WorktreeTopologyError(`no existing ancestor directory for ${value}`, "WORKTREE_PATH_INVALID");
    probe = parent;
  }
  return { canonical, probe_dir: canonicalExisting(probe) };
}

function scalarGit(cwd: string, args: readonly string[], optional = false): string | null {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    if (optional) return null;
    const detail = String(result.stderr || result.error || "").trim();
    throw new WorktreeTopologyError(
      `Git topology query failed in ${cwd}: git ${args.join(" ")}`,
      args.includes("--show-toplevel") ? "WORKTREE_REPOSITORY_NOT_FOUND" : "WORKTREE_GIT_QUERY_FAILED",
      detail,
    );
  }
  const value = String(result.stdout || "").trim();
  if (!value && !optional) {
    throw new WorktreeTopologyError(`Git topology query returned no value in ${cwd}`, "WORKTREE_GIT_QUERY_FAILED");
  }
  return value || null;
}

function absoluteGitPath(probeDir: string, value: string): string {
  const absolute = path.isAbsolute(value) ? value : path.resolve(probeDir, value);
  return canonicalExisting(absolute);
}

function repositoryRootAt(cwd: string): string {
  return absoluteGitPath(cwd, scalarGit(cwd, ["rev-parse", "--show-toplevel"])!);
}

function repositoryIdentity(probeDir: string, workspaceRepositoryRoot: string): GitRepositoryIdentity {
  const repositoryRoot = repositoryRootAt(probeDir);
  const gitDir = absoluteGitPath(probeDir, scalarGit(probeDir, ["rev-parse", "--absolute-git-dir"])!);
  let commonRaw = scalarGit(probeDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], true);
  if (!commonRaw) commonRaw = scalarGit(probeDir, ["rev-parse", "--git-common-dir"]);
  const gitCommonDir = absoluteGitPath(probeDir, commonRaw!);
  const objectFormat = scalarGit(probeDir, ["rev-parse", "--show-object-format"]) || "sha1";
  const superprojectRaw = scalarGit(probeDir, ["rev-parse", "--show-superproject-working-tree"], true);
  const superprojectRoot = superprojectRaw ? absoluteGitPath(probeDir, superprojectRaw) : undefined;
  const linked = gitDir !== gitCommonDir;
  const submodule = Boolean(superprojectRoot);
  const nested = !submodule && repositoryRoot !== workspaceRepositoryRoot && within(workspaceRepositoryRoot, repositoryRoot);
  const topologyKind: RepositoryTopologyKind = submodule
    ? "submodule"
    : nested
      ? "nested-repository"
      : linked
        ? "linked-worktree"
        : "repository";
  const commonIdentity = sha(gitCommonDir);
  return {
    schema_version: WORKTREE_TOPOLOGY_SCHEMA_VERSION,
    repository_id: sha(`${objectFormat}\u0000${gitCommonDir}`),
    repository_root: repositoryRoot,
    repository_root_identity: sha(repositoryRoot),
    git_dir: gitDir,
    git_dir_identity: sha(gitDir),
    git_common_dir: gitCommonDir,
    git_common_dir_identity: commonIdentity,
    object_format: objectFormat,
    topology_kind: topologyKind,
    is_linked_worktree: linked,
    is_nested_repository: nested,
    is_submodule: submodule,
    workspace_repository_root: workspaceRepositoryRoot,
    ...(superprojectRoot ? { superproject_root: superprojectRoot } : {}),
  };
}

function normalizeDeclaredPath(raw: string): { normalized: string; probe: string } {
  if (typeof raw !== "string" || !raw.trim() || /[\u0000-\u001f\u007f]/u.test(raw)) {
    throw new WorktreeTopologyError("write path must be a non-empty printable string", "WORKTREE_PATH_INVALID");
  }
  const slash = raw.trim().replaceAll("\\", "/");
  if (slash.startsWith("/") || /^[A-Za-z]:\//u.test(slash)) {
    throw new WorktreeTopologyError(`write path must be relative: ${raw}`, "WORKTREE_PATH_INVALID");
  }
  const normalized = path.posix.normalize(slash).replace(/^\.\//u, "");
  if (!normalized || normalized === ".." || normalized.startsWith("../")) {
    throw new WorktreeTopologyError(`write path escapes the workspace: ${raw}`, "WORKTREE_PATH_ESCAPE");
  }
  if (normalized.split("/").includes(".git")) {
    throw new WorktreeTopologyError(`Git control paths are not writable: ${raw}`, "WORKTREE_PATH_INVALID");
  }
  const wildcard = normalized.search(/[*?[]/u);
  const staticPrefix = wildcard < 0 ? normalized : normalized.slice(0, wildcard).replace(/\/+$/u, "");
  return { normalized, probe: staticPrefix || "." };
}

function splitDeclaredPath(raw: string): Array<{ value: string; endpoint: ResolvedRepositoryWritePath["endpoint"] }> {
  if (!raw.includes("->")) return [{ value: raw, endpoint: "path" }];
  const pieces = raw.split("->").map((value) => value.trim());
  if (pieces.length !== 2 || !pieces[0] || !pieces[1]) {
    throw new WorktreeTopologyError(`rename scope must contain one source and target: ${raw}`, "WORKTREE_PATH_INVALID");
  }
  return [
    { value: pieces[0], endpoint: "rename-source" },
    { value: pieces[1], endpoint: "rename-target" },
  ];
}

/** Resolve one path to the repository that literally owns it. */
export function resolveOwningRepository(cwd: string, declaredPath: string): ResolvedRepositoryWritePath {
  const workspaceRoot = canonicalExisting(cwd);
  const workspaceRepositoryRoot = repositoryRootAt(workspaceRoot);
  const parts = splitDeclaredPath(declaredPath);
  if (parts.length !== 1) {
    throw new WorktreeTopologyError("resolveOwningRepository accepts one path, not a rename pair", "WORKTREE_PATH_INVALID");
  }
  const { normalized, probe } = normalizeDeclaredPath(parts[0]!.value);
  const target = path.resolve(workspaceRepositoryRoot, probe);
  if (!within(workspaceRepositoryRoot, target)) {
    throw new WorktreeTopologyError(`write path escapes the workspace: ${declaredPath}`, "WORKTREE_PATH_ESCAPE");
  }
  const resolved = potentialRealPath(target);
  if (!within(workspaceRepositoryRoot, resolved.canonical)) {
    throw new WorktreeTopologyError(`write path escapes through a symlink: ${declaredPath}`, "WORKTREE_PATH_ESCAPE");
  }
  const repository = repositoryIdentity(resolved.probe_dir, workspaceRepositoryRoot);
  if (!within(repository.repository_root, resolved.canonical)) {
    throw new WorktreeTopologyError(`write path is outside its owning repository: ${declaredPath}`, "WORKTREE_PATH_ESCAPE");
  }
  return {
    declared_path: declaredPath,
    normalized_path: normalized,
    absolute_path: resolved.canonical,
    repository_relative_path: path.relative(repository.repository_root, resolved.canonical).replaceAll(path.sep, "/") || ".",
    repository,
    endpoint: parts[0]!.endpoint,
  };
}

function resolveEndpoint(cwd: string, declared: string, endpoint: ResolvedRepositoryWritePath["endpoint"]): ResolvedRepositoryWritePath {
  return { ...resolveOwningRepository(cwd, declared), declared_path: declared, endpoint };
}

function stablePartOrder(repositories: readonly GitRepositoryIdentity[]): GitRepositoryIdentity[] {
  const depth = (value: string) => value.split(path.sep).filter(Boolean).length;
  return [...repositories].sort((left, right) => {
    const leftSubmodule = left.is_submodule ? 0 : 1;
    const rightSubmodule = right.is_submodule ? 0 : 1;
    return leftSubmodule - rightSubmodule
      || depth(right.repository_root) - depth(left.repository_root)
      || left.repository_id.localeCompare(right.repository_id);
  });
}

/** Resolve and deterministically expose repository-local parts without guessing a parent gate. */
export function resolveWorktreeTopology(cwd: string, declaredPaths: readonly string[]): WorktreeTopologyResolution {
  if (!Array.isArray(declaredPaths) || declaredPaths.length === 0) {
    throw new WorktreeTopologyError("at least one write path is required", "WORKTREE_PATH_INVALID");
  }
  const workspaceRoot = canonicalExisting(cwd);
  const workspaceRepositoryRoot = repositoryRootAt(workspaceRoot);
  const resolved: ResolvedRepositoryWritePath[] = [];
  for (const declaredPath of declaredPaths) {
    const endpoints = splitDeclaredPath(declaredPath);
    const values = endpoints.map(({ value, endpoint }) => resolveEndpoint(cwd, value, endpoint));
    if (values.length === 2 && values[0]!.repository.repository_id !== values[1]!.repository.repository_id) {
      throw new WorktreeTopologyError(
        `rename scope crosses repositories: ${declaredPath}`,
        "CROSS_REPOSITORY_RENAME",
      );
    }
    for (const value of values) resolved.push({ ...value, declared_path: declaredPath });
  }

  const repositoriesById = new Map<string, GitRepositoryIdentity>();
  for (const value of resolved) repositoriesById.set(value.repository.repository_id, value.repository);
  const repositories = stablePartOrder([...repositoriesById.values()]);
  const parts: RepositoryLocalTopologyPart[] = repositories.map((repository, index) => {
    const writePaths = [...new Set(resolved
      .filter((value) => value.repository.repository_id === repository.repository_id)
      .map((value) => value.declared_path))];
    return {
      part_key: `repository-part-${index + 1}`,
      repository_id: repository.repository_id,
      write_paths: writePaths,
      depends_on: [],
      integration_order: index,
      git_common_dir_identity: repository.git_common_dir_identity,
      repository_root: repository.repository_root,
      topology_kind: repository.topology_kind,
    };
  });
  return {
    schema_version: WORKTREE_TOPOLOGY_SCHEMA_VERSION,
    workspace_root: workspaceRoot,
    workspace_repository_root: workspaceRepositoryRoot,
    repositories,
    write_paths: resolved,
    repository_parts: parts,
    integration_order: parts.map((part) => part.part_key),
    integration_gate_keys: [],
    requires_repository_decomposition: parts.length > 1,
    requires_parent_integration_gate: parts.length > 1,
  };
}

function diagnostic(
  diagnostics: RepositoryDecompositionDiagnostic[],
  code: string,
  message: string,
  pathName?: string,
  refs?: string[],
): void {
  diagnostics.push({ code, message, ...(pathName ? { path: pathName } : {}), ...(refs?.length ? { refs } : {}) });
}

/**
 * Fail closed for a multi-repository semantic unit unless its repository-local
 * parts and parent integration gates are explicit and exactly cover the scope.
 */
export function validateRepositoryLocalDecomposition(
  cwd: string,
  input: RepositoryDecompositionInput,
): RepositoryDecompositionValidationResult {
  let topology: WorktreeTopologyResolution;
  try {
    topology = resolveWorktreeTopology(cwd, input.write_paths);
  } catch (cause) {
    const error = cause as WorktreeTopologyError;
    return { valid: false, diagnostics: [{ code: error.code || "WORKTREE_TOPOLOGY_INVALID", message: error.message }] };
  }
  const diagnostics: RepositoryDecompositionDiagnostic[] = [];
  const proposed = input.repository_parts;
  if (topology.requires_repository_decomposition && (!Array.isArray(proposed) || proposed.length === 0)) {
    diagnostic(
      diagnostics,
      "REPOSITORY_LOCAL_PARTS_REQUIRED",
      "a unit spanning multiple Git repositories requires explicit repository-local parts",
      "repository_parts",
      topology.repositories.map((repository) => repository.repository_id),
    );
    return { valid: false, diagnostics, topology };
  }
  if (!proposed) return { valid: true, diagnostics, topology };

  const expectedPaths = new Map<string, string>();
  for (const value of topology.write_paths) {
    const current = expectedPaths.get(value.declared_path);
    if (current && current !== value.repository.repository_id) {
      diagnostic(diagnostics, "REPOSITORY_DECOMPOSITION_INVALID", `scope ${value.declared_path} has endpoints in different repositories`, "repository_parts", [value.declared_path]);
    } else expectedPaths.set(value.declared_path, value.repository.repository_id);
  }
  const partKeys = new Set<string>();
  const repositoryIds = new Set<string>();
  const claimedPaths = new Set<string>();
  const orderByKey = new Map<string, number>();
  for (const [index, part] of proposed.entries()) {
    const partPath = `repository_parts.${index}`;
    if (!part || typeof part !== "object") {
      diagnostic(diagnostics, "REPOSITORY_DECOMPOSITION_INVALID", "repository part must be an object", partPath);
      continue;
    }
    if (partKeys.has(part.part_key)) diagnostic(diagnostics, "REPOSITORY_DECOMPOSITION_INVALID", `duplicate part key ${part.part_key}`, `${partPath}.part_key`);
    partKeys.add(part.part_key);
    orderByKey.set(part.part_key, part.integration_order);
    if (repositoryIds.has(part.repository_id)) diagnostic(diagnostics, "REPOSITORY_DECOMPOSITION_INVALID", `repository ${part.repository_id} is split across multiple parts`, `${partPath}.repository_id`);
    repositoryIds.add(part.repository_id);
    if (!topology.repositories.some((repository) => repository.repository_id === part.repository_id)) {
      diagnostic(diagnostics, "REPOSITORY_DECOMPOSITION_INVALID", `unknown repository identity ${part.repository_id}`, `${partPath}.repository_id`, [part.repository_id]);
    }
    for (const declaredPath of part.write_paths || []) {
      if (claimedPaths.has(declaredPath)) diagnostic(diagnostics, "REPOSITORY_DECOMPOSITION_INVALID", `scope ${declaredPath} is claimed by multiple parts`, `${partPath}.write_paths`, [declaredPath]);
      claimedPaths.add(declaredPath);
      const expected = expectedPaths.get(declaredPath);
      if (!expected || expected !== part.repository_id) {
        diagnostic(diagnostics, "REPOSITORY_DECOMPOSITION_INVALID", `scope ${declaredPath} does not belong to repository ${part.repository_id}`, `${partPath}.write_paths`, [declaredPath, part.repository_id]);
      }
    }
  }
  for (const [declaredPath] of expectedPaths) if (!claimedPaths.has(declaredPath)) {
    diagnostic(diagnostics, "REPOSITORY_DECOMPOSITION_INVALID", `scope ${declaredPath} is not assigned to a repository part`, "repository_parts", [declaredPath]);
  }
  for (const [index, part] of proposed.entries()) {
    for (const dependency of part.depends_on || []) {
      if (!partKeys.has(dependency)) diagnostic(diagnostics, "REPOSITORY_DECOMPOSITION_INVALID", `unknown repository part dependency ${dependency}`, `repository_parts.${index}.depends_on`, [dependency]);
      else if ((orderByKey.get(dependency) ?? Number.MAX_SAFE_INTEGER) >= part.integration_order) {
        diagnostic(diagnostics, "REPOSITORY_DECOMPOSITION_INVALID", `part ${part.part_key} must follow dependency ${dependency}`, `repository_parts.${index}.integration_order`, [dependency, part.part_key]);
      }
    }
  }
  if (topology.requires_parent_integration_gate && (!Array.isArray(input.integration_gate_keys) || input.integration_gate_keys.length === 0)) {
    diagnostic(diagnostics, "INTEGRATION_GATE_REQUIRED", "multi-repository units require an explicit parent integration gate", "integration_gate_keys");
  }
  if (diagnostics.length === 0 && proposed) {
    const repositories = new Map(topology.repositories.map((repository) => [repository.repository_id, repository]));
    const repositoryParts = proposed
      .map((part): RepositoryLocalTopologyPart => {
        const repository = repositories.get(part.repository_id)!;
        return {
          ...part,
          git_common_dir_identity: repository.git_common_dir_identity,
          repository_root: repository.repository_root,
          topology_kind: repository.topology_kind,
        };
      })
      .sort((left, right) => left.integration_order - right.integration_order || left.part_key.localeCompare(right.part_key));
    topology = {
      ...topology,
      repository_parts: repositoryParts,
      integration_order: repositoryParts.map((part) => part.part_key),
      integration_gate_keys: [...new Set(input.integration_gate_keys || [])],
    };
  }
  return { valid: diagnostics.length === 0, diagnostics, topology };
}

export function assertRepositoryLocalDecomposition(cwd: string, input: RepositoryDecompositionInput): WorktreeTopologyResolution {
  const result = validateRepositoryLocalDecomposition(cwd, input);
  if (!result.valid) {
    throw new WorktreeTopologyError(
      result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; "),
      result.diagnostics.some((item) => item.code === "REPOSITORY_LOCAL_PARTS_REQUIRED")
        ? "REPOSITORY_LOCAL_PARTS_REQUIRED"
        : "REPOSITORY_DECOMPOSITION_INVALID",
    );
  }
  return result.topology!;
}

export const resolveRepositoryTopology = resolveWorktreeTopology;
export const resolveUnitRepositoryTopology = resolveWorktreeTopology;
export const validateRepositoryLocalUnitParts = validateRepositoryLocalDecomposition;
export const assertRepositoryLocalUnitParts = assertRepositoryLocalDecomposition;
