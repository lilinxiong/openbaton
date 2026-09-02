/** Conservative recovery, visibility, retention, and cleanup for isolated roots. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { collectGitScalar, GitSafetyError, runGitProcess, type GitProcessOptions } from "./git-safety-process.js";
import {
  bundleManifestPath,
  integrationRecordPath,
  rollingRunBundlesDir,
  rollingRunIntegrationsDir,
  rollingRunSnapshotsDir,
  rollingRunWorktreesDir,
  rollingRunsDir,
  snapshotManifestPath,
  worktreeExecutionRootPath,
  worktreeRecordPath,
} from "./paths.js";
import {
  CLEANUP_STATE_SCHEMA_VERSION,
  WorktreeExecutionError,
  parseChangeBundleManifest,
  parseIntegrationRecord,
  parseSnapshotManifest,
  readPersistedChangeBundleManifest,
  readPersistedIntegrationRecord,
  readPersistedWorktreeRecord,
  transitionPersistedWorktreeRecord,
  type ChangeBundleManifest,
  type IntegrationRecord,
  type RetentionReason,
  type WorktreeRecord,
} from "./worktree-execution.js";
import { resolveOwningRepository } from "./worktree-topology.js";
import { sha256Hex } from "./json-utils.js";
import { deriveWorktreeRetentionReasons } from "./worktree-lifecycle-cleanup.js";
import {
  listPersistedWorktreeRecords,
  readBundle,
  readIntegration
} from "./worktree-lifecycle-records.js";
import {
  MAX_CHANGED_PATHS,
  boundedOutput,
  canonicalPotentialPath,
  nativeLiveness,
  registeredWorktreeRoots,
  rootState,
  ticketFor,
  timestamp,
  within
} from "./worktree-lifecycle-common.js";

export type WorktreeLifecycleErrorCode =
  | "WORKTREE_LIFECYCLE_IDENTITY_MISMATCH"
  | "WORKTREE_CLEANUP_RETAINED"
  | "WORKTREE_CLEANUP_NOT_READY"
  | "WORKTREE_CLEANUP_FAILED";

export class WorktreeLifecycleError extends Error {
  readonly code: WorktreeLifecycleErrorCode;
  readonly detail?: Record<string, unknown>;
  constructor(message: string, code: WorktreeLifecycleErrorCode, detail?: Record<string, unknown>) {
    super(message);
    this.name = "WorktreeLifecycleError";
    this.code = code;
    this.detail = detail;
  }
}

export interface WorktreeLifecycleDiagnostic {
  code: string;
  message: string;
  record_id?: string;
  path?: string;
}

export interface WorktreeStatusTicket {
  status: string;
  slot_released_at?: string;
  liveness?: { state?: string } | null;
  rolling_unit_lineage?: { run_id?: string; unit_key?: string; unit_version?: number } | null;
}

export interface WorktreeDiffSummary {
  changed_paths: string[];
  total_changed_paths: number;
  additions: number;
  deletions: number;
  binary_files: number;
  truncated: boolean;
}

export interface WorktreeIsolationStatus {
  record_id: string;
  unit_ref: string;
  attempt_id: string;
  repository_id: string;
  repository_root: string;
  git_common_dir_identity: string;
  execution_root: string;
  base_tree: string;
  setup_state: WorktreeRecord["setup_state"];
  lifecycle_state: WorktreeRecord["lifecycle_state"];
  native_liveness: "none" | "running" | "terminal" | "missing" | "unknown";
  root_state: "absent" | "directory" | "symlink" | "other";
  registration_state: "registered" | "missing" | "mismatch";
  diff: WorktreeDiffSummary;
  audit_state: "not_started" | "pending" | "accepted" | "rejected";
  bundle: null | { bundle_id: string; state: string; fingerprint: string; result_tree: string };
  integration: null | { integration_id: string; state: string; queue_position: number; after_tree?: string; conflicts: IntegrationRecord["conflicts"] };
  retention_reasons: RetentionReason[];
  cleanup: WorktreeRecord["cleanup"];
  diagnostics: WorktreeLifecycleDiagnostic[];
}

export interface WorktreeRunIsolationStatus {
  run_id: string;
  units: WorktreeIsolationStatus[];
  unit_status: Record<string, WorktreeIsolationStatus[]>;
  orphan_diagnostics: WorktreeLifecycleDiagnostic[];
}

export interface WorktreeRecoveryResult {
  run_id: string;
  repaired_record_ids: string[];
  status: WorktreeRunIsolationStatus;
}

export interface WorktreeCleanupEligibilityInput {
  cwd: string;
  run_id: string;
  unit_key: string;
  attempt_id: string;
  env?: NodeJS.ProcessEnv;
  release_downstream_base?: boolean;
  discard_rejected_evidence?: boolean;
  release_user_retention?: boolean;
  terminal_ticket_released?: boolean;
  spawn?: GitProcessOptions["spawn"];
  at?: string | number | Date;
}

export interface WorktreeCleanupInput extends WorktreeCleanupEligibilityInput {}

export interface WorktreeCleanupResult {
  record: WorktreeRecord;
  replayed: boolean;
  removed_worktree: boolean;
  removed_internal_ref: string | null;
  removed_snapshot_ids: string[];
}

const EMPTY_DIFF: WorktreeDiffSummary = { changed_paths: [], total_changed_paths: 0, additions: 0, deletions: 0, binary_files: 0, truncated: false };

/** Recompute conservative reasons from durable lifecycle and release facts. */


async function currentDiff(record: WorktreeRecord, spawn?: GitProcessOptions["spawn"]): Promise<WorktreeDiffSummary> {
  if (rootState(record.execution_root) !== "directory") return { ...EMPTY_DIFF };
  const status = await boundedOutput(record.execution_root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], spawn);
  const fields = status.bytes.toString("utf8").split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    const value = field.length > 3 ? field.slice(3) : field;
    paths.push(value);
    if (field.slice(0, 2).includes("R") || field.slice(0, 2).includes("C")) index += 1;
  }
  const numstat = await boundedOutput(record.execution_root, ["diff", "--numstat", "-z", record.base_tree, "--"], spawn);
  let additions = 0; let deletions = 0; let binaryFiles = 0;
  for (const field of numstat.bytes.toString("utf8").split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t/u.exec(field);
    if (!match) continue;
    if (match[1] === "-" || match[2] === "-") binaryFiles += 1;
    else { additions += Number(match[1]); deletions += Number(match[2]); }
  }
  const unique = [...new Set(paths)].sort();
  return {
    changed_paths: unique.slice(0, MAX_CHANGED_PATHS),
    total_changed_paths: unique.length,
    additions,
    deletions,
    binary_files: binaryFiles,
    truncated: status.truncated || numstat.truncated || unique.length > MAX_CHANGED_PATHS,
  };
}

async function statusForRecord(
  cwd: string,
  record: WorktreeRecord,
  env: NodeJS.ProcessEnv | undefined,
  tickets: readonly WorktreeStatusTicket[],
  registry: Set<string>,
  spawn?: GitProcessOptions["spawn"],
): Promise<WorktreeIsolationStatus> {
  const diagnostics: WorktreeLifecycleDiagnostic[] = [];
  const state = rootState(record.execution_root);
  const canonicalRoot = canonicalPotentialPath(record.execution_root);
  const registered = registry.has(canonicalRoot);
  let registrationState: WorktreeIsolationStatus["registration_state"] = registered ? "registered" : "missing";
  if (state === "directory") {
    try {
      const owner = resolveOwningRepository(record.execution_root, ".").repository;
      if (owner.repository_id !== record.repository_id || owner.git_common_dir_identity !== record.git_common_dir_identity) {
        registrationState = "mismatch";
        diagnostics.push({ code: "WORKTREE_IDENTITY_MISMATCH", message: "execution root repository identity differs from its record", record_id: record.record_id, path: record.execution_root });
      }
    } catch (error) {
      registrationState = "mismatch";
      diagnostics.push({ code: "WORKTREE_IDENTITY_UNREADABLE", message: error instanceof Error ? error.message : String(error), record_id: record.record_id, path: record.execution_root });
    }
  }
  if (state === "directory" && !registered) diagnostics.push({ code: "WORKTREE_REGISTRATION_MISSING", message: "execution root exists but Git has no matching worktree registration", record_id: record.record_id, path: record.execution_root });
  if (state === "absent" && registered) diagnostics.push({ code: "WORKTREE_ROOT_MISSING", message: "Git registration exists but the execution root is absent", record_id: record.record_id, path: record.execution_root });
  let bundle: ChangeBundleManifest | null = null; let integration: IntegrationRecord | null = null;
  try { bundle = readBundle(cwd, record, env); }
  catch (error) { diagnostics.push({ code: "BUNDLE_RECORD_INVALID", message: error instanceof Error ? error.message : String(error), record_id: record.record_id }); }
  try { integration = readIntegration(cwd, record, env); }
  catch (error) { diagnostics.push({ code: "INTEGRATION_RECORD_INVALID", message: error instanceof Error ? error.message : String(error), record_id: record.record_id }); }
  if (record.bundle_id && !bundle) diagnostics.push({ code: "BUNDLE_RECORD_MISSING", message: "worktree references a missing bundle manifest", record_id: record.record_id });
  if (record.integration_id && !integration) diagnostics.push({ code: "INTEGRATION_RECORD_MISSING", message: "worktree references a missing integration record", record_id: record.record_id });
  if (bundle && record.lifecycle_state !== "cleaned" && typeof bundle.transport.internal_ref === "string" && typeof bundle.transport.internal_commit === "string") {
    const expectedRef = `refs/baton/change-bundles/${bundle.bundle_id}`;
    if (bundle.transport.internal_ref !== expectedRef) diagnostics.push({ code: "BUNDLE_INTERNAL_REF_INVALID", message: "bundle internal ref is outside its exact namespace", record_id: record.record_id });
    else {
      try {
        const object = await collectGitScalar({ cwd: record.repository_root, args: ["rev-parse", "--verify", expectedRef], spawn });
        if (object !== bundle.transport.internal_commit) diagnostics.push({ code: "BUNDLE_INTERNAL_REF_DRIFT", message: "bundle internal ref points to another object", record_id: record.record_id });
      } catch { diagnostics.push({ code: "BUNDLE_INTERNAL_REF_MISSING", message: "bundle internal reachability ref is missing", record_id: record.record_id }); }
    }
  }
  let diff = { ...EMPTY_DIFF };
  try { diff = await currentDiff(record, spawn); }
  catch (error) { diagnostics.push({ code: "WORKTREE_DIFF_UNAVAILABLE", message: error instanceof Error ? error.message : String(error), record_id: record.record_id }); }
  const ticket = ticketFor(record, tickets);
  const retention = deriveWorktreeRetentionReasons(record, { terminal_ticket_released: Boolean(ticket?.slot_released_at) });
  const auditState = record.lifecycle_state === "rejected" ? "rejected"
    : bundle ? "accepted"
      : record.lifecycle_state === "terminal_awaiting_audit" ? "pending" : "not_started";
  return {
    record_id: record.record_id,
    unit_ref: `${record.unit_key}@${record.unit_version}`,
    attempt_id: record.attempt_id,
    repository_id: record.repository_id,
    repository_root: record.repository_root,
    git_common_dir_identity: record.git_common_dir_identity,
    execution_root: record.execution_root,
    base_tree: record.base_tree,
    setup_state: record.setup_state,
    lifecycle_state: record.lifecycle_state,
    native_liveness: nativeLiveness(record, tickets),
    root_state: state,
    registration_state: registrationState,
    diff,
    audit_state: auditState,
    bundle: bundle ? { bundle_id: bundle.bundle_id, state: bundle.state || bundle.safety_verdict, fingerprint: bundle.fingerprint, result_tree: bundle.result_tree } : null,
    integration: integration ? { integration_id: integration.integration_id, state: integration.state, queue_position: integration.queue_position, ...(integration.after_tree ? { after_tree: integration.after_tree } : {}), conflicts: integration.conflicts } : null,
    retention_reasons: retention,
    cleanup: record.cleanup,
    diagnostics,
  };
}

/** Read both execution truth and integration truth without inspecting file contents. */
export async function collectWorktreeRunStatus(input: {
  cwd: string;
  run_id: string;
  env?: NodeJS.ProcessEnv;
  tickets?: readonly WorktreeStatusTicket[];
  spawn?: GitProcessOptions["spawn"];
}): Promise<WorktreeRunIsolationStatus> {
  const root = fs.realpathSync(input.cwd);
  const listed = listPersistedWorktreeRecords(root, input.run_id, input.env);
  const repositories = new Map<string, Set<string>>();
  for (const record of listed.records) if (!repositories.has(record.repository_root)) {
    try { repositories.set(record.repository_root, await registeredWorktreeRoots(record.repository_root, input.spawn)); }
    catch (error) { listed.diagnostics.push({ code: "WORKTREE_REGISTRY_UNAVAILABLE", message: error instanceof Error ? error.message : String(error), path: record.repository_root }); repositories.set(record.repository_root, new Set()); }
  }
  if (!repositories.has(root)) {
    try { repositories.set(root, await registeredWorktreeRoots(root, input.spawn)); }
    catch { repositories.set(root, new Set()); }
  }
  const units: WorktreeIsolationStatus[] = [];
  for (const record of listed.records) units.push(await statusForRecord(root, record, input.env, input.tickets || [], repositories.get(record.repository_root) || new Set(), input.spawn));
  const recordedRoots = new Set(listed.records.map((record) => canonicalPotentialPath(record.execution_root)));
  const ownedRoot = canonicalPotentialPath(rollingRunWorktreesDir(root, input.run_id, input.env));
  for (const roots of repositories.values()) for (const registered of roots) {
    if (within(ownedRoot, registered) && !recordedRoots.has(canonicalPotentialPath(registered))) listed.diagnostics.push({ code: "ORPHAN_WORKTREE_REGISTRATION", message: "Baton namespace contains an unrecorded Git worktree", path: registered });
  }
  const unitStatus: Record<string, WorktreeIsolationStatus[]> = {};
  for (const status of units) (unitStatus[status.unit_ref] ||= []).push(status);
  let workspaceBundles: ChangeBundleManifest[] = [];
  let workspaceBundleInventoryComplete = true;
  try { workspaceBundles = allWorkspaceBundles(root, input.env); }
  catch (error) {
    workspaceBundleInventoryComplete = false;
    listed.diagnostics.push({ code: "WORKSPACE_BUNDLE_INVENTORY_INVALID", message: error instanceof Error ? error.message : String(error) });
  }
  for (const [repositoryRoot] of repositories) {
    try {
      const refs = await boundedOutput(repositoryRoot, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/baton/change-bundles"], input.spawn);
      if (refs.truncated) listed.diagnostics.push({ code: "INTERNAL_REF_SUMMARY_TRUNCATED", message: "Baton internal ref inventory exceeded its bounded payload", path: repositoryRoot });
      const repositoryId = resolveOwningRepository(repositoryRoot, ".").repository.repository_id;
      const identities = new Map(workspaceBundles.filter((bundle) => bundle.repository_id === repositoryId)
        .filter((bundle) => typeof bundle.transport.internal_ref === "string" && typeof bundle.transport.internal_commit === "string")
        .map((bundle) => [String(bundle.transport.internal_ref), String(bundle.transport.internal_commit)]));
      for (const line of refs.bytes.toString("utf8").split(/\r?\n/u).filter(Boolean)) {
        const separator = line.lastIndexOf(" "); const ref = line.slice(0, separator); const object = line.slice(separator + 1);
        if (!identities.has(ref)) {
          if (workspaceBundleInventoryComplete) listed.diagnostics.push({ code: "ORPHAN_INTERNAL_REF", message: "Baton internal ref has no immutable bundle manifest", path: ref });
        } else if (identities.get(ref) !== object) listed.diagnostics.push({ code: "BUNDLE_INTERNAL_REF_DRIFT", message: "Baton internal ref differs from its bundle manifest", path: ref });
      }
    } catch (error) { listed.diagnostics.push({ code: "INTERNAL_REF_INVENTORY_UNAVAILABLE", message: error instanceof Error ? error.message : String(error), path: repositoryRoot }); }
  }
  return { run_id: input.run_id, units, unit_status: unitStatus, orphan_diagnostics: listed.diagnostics };
}

function allBundles(cwd: string, runId: string, env?: NodeJS.ProcessEnv): ChangeBundleManifest[] {
  const directory = rollingRunBundlesDir(cwd, runId, env);
  if (!fs.existsSync(directory)) return [];
  const result: ChangeBundleManifest[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = bundleManifestPath(cwd, runId, entry.name, env);
    if (fs.existsSync(file)) result.push(parseChangeBundleManifest(fs.readFileSync(file, "utf8")));
  }
  return result;
}

function allWorkspaceBundles(cwd: string, env?: NodeJS.ProcessEnv): ChangeBundleManifest[] {
  const directory = rollingRunsDir(cwd, env);
  if (!fs.existsSync(directory)) return [];
  const result: ChangeBundleManifest[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) result.push(...allBundles(cwd, entry.name, env));
  }
  return result;
}

function allIntegrations(cwd: string, runId: string, env?: NodeJS.ProcessEnv): IntegrationRecord[] {
  const directory = rollingRunIntegrationsDir(cwd, runId, env);
  if (!fs.existsSync(directory)) return [];
  const result: IntegrationRecord[] = [];
  for (const repository of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!repository.isDirectory()) continue;
    const repositoryDir = path.join(directory, repository.name);
    for (const entry of fs.readdirSync(repositoryDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = integrationRecordPath(cwd, runId, repository.name, entry.name, env);
      if (fs.existsSync(file)) result.push(parseIntegrationRecord(fs.readFileSync(file, "utf8")));
    }
  }
  return result;
}

function allSnapshots(cwd: string, runId: string, env?: NodeJS.ProcessEnv): ReturnType<typeof parseSnapshotManifest>[] {
  const directory = rollingRunSnapshotsDir(cwd, runId, env);
  if (!fs.existsSync(directory)) return [];
  const result: ReturnType<typeof parseSnapshotManifest>[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = snapshotManifestPath(cwd, runId, entry.name, env);
    if (fs.existsSync(file)) result.push(parseSnapshotManifest(fs.readFileSync(file, "utf8")));
  }
  return result;
}

async function verifyRecoverableSetup(record: WorktreeRecord, spawn?: GitProcessOptions["spawn"]): Promise<void> {
  if (rootState(record.execution_root) !== "directory") throw new Error("execution root is not a directory");
  const headTree = await collectGitScalar({ cwd: record.execution_root, args: ["rev-parse", "HEAD^{tree}"], spawn });
  const indexTree = await collectGitScalar({ cwd: record.execution_root, args: ["write-tree"], spawn });
  const branch = await collectGitScalar({ cwd: record.execution_root, args: ["branch", "--show-current"], spawn });
  const commonRaw = await collectGitScalar({ cwd: record.execution_root, args: ["rev-parse", "--path-format=absolute", "--git-common-dir"], spawn });
  const common = fs.realpathSync(path.isAbsolute(commonRaw) ? commonRaw : path.resolve(record.execution_root, commonRaw));
  const status = await boundedOutput(record.execution_root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], spawn);
  if (headTree !== record.base_tree || indexTree !== record.base_tree || branch !== "" || common !== fs.realpathSync(record.git_common_dir) || status.bytes.length > 0 || status.truncated) throw new Error("registered root does not match the immutable setup identity");
}

/** Reconcile only exact, durable identities; ambiguous state becomes a diagnostic. */
export async function recoverWorktreeRun(input: {
  cwd: string;
  run_id: string;
  env?: NodeJS.ProcessEnv;
  tickets?: readonly WorktreeStatusTicket[];
  spawn?: GitProcessOptions["spawn"];
  at?: string | number | Date;
}): Promise<WorktreeRecoveryResult> {
  const root = fs.realpathSync(input.cwd);
  const listed = listPersistedWorktreeRecords(root, input.run_id, input.env);
  const repaired: string[] = [];
  const recoveryDiagnostics: WorktreeLifecycleDiagnostic[] = [];
  let bundles: ChangeBundleManifest[] = []; let integrations: IntegrationRecord[] = []; let snapshots: ReturnType<typeof parseSnapshotManifest>[] = [];
  try { bundles = allBundles(root, input.run_id, input.env); }
  catch (error) { recoveryDiagnostics.push({ code: "BUNDLE_INVENTORY_INVALID", message: error instanceof Error ? error.message : String(error) }); }
  try { integrations = allIntegrations(root, input.run_id, input.env); }
  catch (error) { recoveryDiagnostics.push({ code: "INTEGRATION_INVENTORY_INVALID", message: error instanceof Error ? error.message : String(error) }); }
  try { snapshots = allSnapshots(root, input.run_id, input.env); }
  catch (error) { recoveryDiagnostics.push({ code: "SNAPSHOT_INVENTORY_INVALID", message: error instanceof Error ? error.message : String(error) }); }
  for (const snapshot of snapshots) {
    try { await collectGitScalar({ cwd: snapshot.source_root, args: ["cat-file", "-e", `${snapshot.snapshot_tree}^{tree}`], spawn: input.spawn }); }
    catch (error) { recoveryDiagnostics.push({ code: "SNAPSHOT_OBJECT_MISSING", message: error instanceof Error ? error.message : String(error), path: snapshotManifestPath(root, input.run_id, snapshot.snapshot_id, input.env) }); }
  }
  for (const initial of listed.records) {
    let record = initial;
    try {
      const registry = await registeredWorktreeRoots(record.repository_root, input.spawn);
      const canonical = canonicalPotentialPath(record.execution_root);
      if (record.lifecycle_state === "preparing" && registry.has(canonical) && record.setup_state !== "verified" && record.setup_state !== "failed") {
        if (record.setup_state === "planned") record = transitionPersistedWorktreeRecord(root, record.run_id, record.unit_key, record.attempt_id, { idempotency_key: "recovery-setup-registering", phase: "setup", to_state: "preparing", setup_state: "registering", recorded_at: timestamp(input.at) }, input.env);
        if (record.setup_state === "registering") record = transitionPersistedWorktreeRecord(root, record.run_id, record.unit_key, record.attempt_id, { idempotency_key: "recovery-setup-registered", phase: "setup", to_state: "preparing", setup_state: "registered", recorded_at: timestamp(input.at) }, input.env);
        await verifyRecoverableSetup(record, input.spawn);
        if (record.setup_state === "registered") record = transitionPersistedWorktreeRecord(root, record.run_id, record.unit_key, record.attempt_id, { idempotency_key: "recovery-setup-verified", phase: "setup", to_state: "preparing", setup_state: "verified", recorded_at: timestamp(input.at) }, input.env);
      }
      const ticket = ticketFor(record, input.tickets || []);
      if (record.lifecycle_state === "preparing"
        && record.setup_state === "verified"
        && ticket?.slot_released_at
        && !ticket.liveness
        && ["completed", "errored", "timed_out", "closed"].includes(ticket.status)) {
        record = transitionPersistedWorktreeRecord(root, record.run_id, record.unit_key, record.attempt_id, {
          idempotency_key: `recovery-native-aborted-${record.record_id}`,
          phase: "native_execution",
          to_state: "rejected",
          native_handle: null,
          retention_reasons: ["rejected_result_evidence"],
          recorded_at: timestamp(input.at),
        }, input.env);
      }
      if (record.lifecycle_state === "worker_active"
        && ticket
        && ["completed", "errored", "timed_out", "closed"].includes(ticket.status)) {
        record = transitionPersistedWorktreeRecord(root, record.run_id, record.unit_key, record.attempt_id, {
          idempotency_key: `recovery-native-terminal-${record.record_id}`,
          phase: "native_execution",
          to_state: "terminal_awaiting_audit",
          native_handle: record.native_handle,
          retention_reasons: ["pending_audit", ...(ticket.slot_released_at ? [] : ["terminal_unreleased_ticket" as const])],
          recorded_at: timestamp(input.at),
        }, input.env);
      }
      const matchingBundles = bundles.filter((bundle) => bundle.unit_key === record.unit_key && bundle.unit_version === record.unit_version && bundle.attempt_id === record.attempt_id && bundle.repository_id === record.repository_id);
      if (record.lifecycle_state === "terminal_awaiting_audit" && !record.bundle_id && matchingBundles.length === 1) {
        const bundle = matchingBundles[0]!;
        record = transitionPersistedWorktreeRecord(root, record.run_id, record.unit_key, record.attempt_id, { idempotency_key: `recovery-bundle:${bundle.bundle_id}`, phase: "bundling", to_state: "bundle_ready", bundle_id: bundle.bundle_id, retention_reasons: ["ready_bundle"], recorded_at: timestamp(input.at) }, input.env);
      }
      const matchingIntegrations = integrations.filter((integration) => integration.bundle_id === record.bundle_id && integration.repository_id === record.repository_id);
      if (!record.integration_id && record.lifecycle_state === "bundle_ready" && matchingIntegrations.length === 1 && matchingIntegrations[0]!.state !== "queued") {
        const integration = matchingIntegrations[0]!;
        record = transitionPersistedWorktreeRecord(root, record.run_id, record.unit_key, record.attempt_id, { idempotency_key: `recovery-integration:${integration.integration_id}`, phase: "integration", to_state: "integrating", integration_id: integration.integration_id, retention_reasons: ["active_integration"], recorded_at: timestamp(input.at) }, input.env);
      }
      const integration = integrations.find((item) => item.integration_id === record.integration_id);
      if (integration && record.lifecycle_state === "integrating" && integration.state === "awaiting_parent_resolution") record = transitionPersistedWorktreeRecord(root, record.run_id, record.unit_key, record.attempt_id, { idempotency_key: `recovery-conflict:${integration.integration_id}`, phase: "conflict", to_state: "awaiting_parent_resolution", retention_reasons: ["unresolved_conflict"], recorded_at: timestamp(input.at) }, input.env);
      if (integration && (record.lifecycle_state === "integrating" || record.lifecycle_state === "awaiting_parent_resolution") && (integration.state === "integrated" || integration.state === "accepted")) record = transitionPersistedWorktreeRecord(root, record.run_id, record.unit_key, record.attempt_id, { idempotency_key: `recovery-integrated:${integration.integration_id}`, phase: "integration", to_state: "integrated", retention_reasons: ["downstream_base_dependency"], recorded_at: timestamp(input.at) }, input.env);
      if (integration && record.lifecycle_state === "integrated" && integration.state === "accepted") record = transitionPersistedWorktreeRecord(root, record.run_id, record.unit_key, record.attempt_id, { idempotency_key: `recovery-accepted:${integration.integration_id}`, phase: "acceptance", to_state: "accepted", retention_reasons: ["downstream_base_dependency"], recorded_at: timestamp(input.at) }, input.env);
      if (record.fingerprint !== initial.fingerprint) repaired.push(record.record_id);
    } catch (error) {
      recoveryDiagnostics.push({ code: "WORKTREE_RECOVERY_BLOCKED", message: error instanceof Error ? error.message : String(error), record_id: initial.record_id, path: initial.execution_root });
    }
  }
  const status = await collectWorktreeRunStatus(input);
  status.orphan_diagnostics.push(...recoveryDiagnostics);
  return { run_id: input.run_id, repaired_record_ids: [...new Set(repaired)].sort(), status };
}


/** Persist cleanup eligibility only after all conservative reasons are discharged. */

export { deriveWorktreeRetentionReasons, markWorktreeCleanupEligible, cleanupWorktreeAttempt } from "./worktree-lifecycle-cleanup.js";
export { listPersistedWorktreeRecords } from "./worktree-lifecycle-records.js";
