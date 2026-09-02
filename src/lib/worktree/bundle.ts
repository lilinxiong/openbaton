import crypto from "node:crypto";
import {
  collectGitScalar,
  GitSafetyError,
  runGitProcess,
  type GitProcessOptions,
} from "../git/safety-process.js";
import {
  CHANGE_BUNDLE_MANIFEST_SCHEMA_VERSION,
  WorktreeExecutionError,
  assertWorktreeRecord,
  fingerprintWorktreeRuntimeRecord,
  persistChangeBundleManifest,
  readPersistedChangeBundleManifest,
  readPersistedWorktreeRecord,
  transitionPersistedWorktreeRecord,
  type ChangeBundleManifest,
  type WorktreeRecord,
} from "../worktree-execution.js";
import {
  auditTerminalWorktree,
  type TerminalWorktreeAuditInput,
  type TerminalWorktreeAuditResult,
  type WorktreeAuditReceipt,
} from "./audit.js";

export type WorktreeBundleErrorCode =
  | "CHANGE_BUNDLE_INPUT_INVALID"
  | "CHANGE_BUNDLE_IDENTITY_CONFLICT"
  | "CHANGE_BUNDLE_INTERNAL_REF_CONFLICT"
  | "CHANGE_BUNDLE_STATE_INVALID";

export class WorktreeBundleError extends Error {
  readonly code: WorktreeBundleErrorCode;
  constructor(message: string, code: WorktreeBundleErrorCode) {
    super(message);
    this.name = "WorktreeBundleError";
    this.code = code;
  }
}

export interface CreateWorktreeChangeBundleInput extends Omit<TerminalWorktreeAuditInput, "receipt"> {
  receipt: WorktreeAuditReceipt;
  audit?: TerminalWorktreeAuditResult;
  terminal_conclusion: string;
  validation_summaries?: readonly string[];
  created_at?: string | number | Date;
  env?: NodeJS.ProcessEnv;
  /** Tests and dry-run callers may opt out; production defaults to durable state. */
  persist_lifecycle?: boolean;
}

export interface WorktreeChangeBundleResult {
  audit: TerminalWorktreeAuditResult;
  bundle: ChangeBundleManifest | null;
  record: WorktreeRecord;
  replayed: boolean;
}

function timestamp(value: string | number | Date | undefined, fallback: string): string {
  const date = value === undefined ? new Date(fallback) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new WorktreeBundleError("bundle created_at is invalid", "CHANGE_BUNDLE_INPUT_INVALID");
  return date.toISOString();
}

function boundedText(value: string, label: string, limit: number): string {
  if (typeof value !== "string" || !value.trim()) throw new WorktreeBundleError(`${label} is required`, "CHANGE_BUNDLE_INPUT_INVALID");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > limit) throw new WorktreeBundleError(`${label} exceeds ${limit} bytes`, "CHANGE_BUNDLE_INPUT_INVALID");
  return value;
}

function validationSummaries(values: readonly string[] | undefined): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 64) throw new WorktreeBundleError("validation_summaries must contain at most 64 entries", "CHANGE_BUNDLE_INPUT_INVALID");
  return [...new Set(values.map((value) => boundedText(value, "validation summary", 2048)))].sort();
}

function bundleIdentity(record: WorktreeRecord, receiptId: string, resultTree: string): string {
  return fingerprintWorktreeRuntimeRecord({
    schema_version: CHANGE_BUNDLE_MANIFEST_SCHEMA_VERSION,
    run_id: record.run_id,
    unit_key: record.unit_key,
    unit_version: record.unit_version,
    attempt_id: record.attempt_id,
    receipt_id: receiptId,
    repository_id: record.repository_id,
    git_common_dir_identity: record.git_common_dir_identity,
    base_tree: record.base_tree,
    result_tree: resultTree,
  });
}

async function optionalObject(cwd: string, value: string, spawn?: GitProcessOptions["spawn"]): Promise<string | null> {
  try { return await collectGitScalar({ cwd, args: ["rev-parse", "--verify", value], spawn }); }
  catch (error) {
    if (error instanceof GitSafetyError && (error.exitCode === 1 || error.exitCode === 128)) return null;
    throw error;
  }
}

async function patchIdentity(cwd: string, baseTree: string, resultTree: string, spawn?: GitProcessOptions["spawn"]): Promise<{ format: string; sha256: string; bytes: number }> {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  await runGitProcess({
    cwd,
    args: ["diff-tree", "--no-commit-id", "-r", "-p", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "-M", "-C", baseTree, resultTree],
    spawn,
    onStdout(chunk) { hash.update(chunk); bytes += chunk.length; },
  });
  return { format: "git-binary-patch", sha256: hash.digest("hex"), bytes };
}

async function freezeInternalCommit(
  record: WorktreeRecord,
  audit: TerminalWorktreeAuditResult,
  bundleId: string,
  spawn?: GitProcessOptions["spawn"],
): Promise<{ internal_base_commit: string; internal_commit: string; internal_ref: string }> {
  const resultTree = audit.result_tree!;
  const internalRef = `refs/baton/change-bundles/${bundleId}`;
  const existing = await optionalObject(record.execution_root, internalRef, spawn);
  const deterministicEnvironment: NodeJS.ProcessEnv = {
    GIT_AUTHOR_NAME: "OpenBaton",
    GIT_AUTHOR_EMAIL: "openbaton@invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "OpenBaton",
    GIT_COMMITTER_EMAIL: "openbaton@invalid",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  const baseCommit = await collectGitScalar({
    cwd: record.execution_root,
    args: ["commit-tree", record.base_tree, "-m", `OpenBaton immutable base ${record.base_tree}`],
    env: deterministicEnvironment,
    spawn,
  });
  const commit = await collectGitScalar({
    cwd: record.execution_root,
    args: ["commit-tree", resultTree, "-p", baseCommit, "-m", `OpenBaton ChangeBundle ${bundleId}`],
    env: deterministicEnvironment,
    spawn,
  });
  if (existing !== null && existing !== commit) {
    throw new WorktreeBundleError("Baton-owned bundle ref points to another immutable commit", "CHANGE_BUNDLE_INTERNAL_REF_CONFLICT");
  }
  if (existing === null) {
    try {
      await runGitProcess({ cwd: record.execution_root, args: ["update-ref", internalRef, commit, "0".repeat(commit.length)], spawn });
    } catch (cause) {
      const raced = await optionalObject(record.execution_root, internalRef, spawn);
      if (raced !== commit) {
        if (raced !== null) throw new WorktreeBundleError("Baton-owned bundle ref points to another immutable commit", "CHANGE_BUNDLE_INTERNAL_REF_CONFLICT");
        throw cause;
      }
    }
  }
  return { internal_base_commit: baseCommit, internal_commit: commit, internal_ref: internalRef };
}

function sameImmutableBundleIdentity(bundle: ChangeBundleManifest, record: WorktreeRecord, receiptId: string, resultTree: string): boolean {
  return bundle.run_id === record.run_id
    && bundle.unit_key === record.unit_key
    && bundle.unit_version === record.unit_version
    && bundle.attempt_id === record.attempt_id
    && bundle.receipt_id === receiptId
    && bundle.repository_id === record.repository_id
    && bundle.git_common_dir_identity === record.git_common_dir_identity
    && bundle.base_tree === record.base_tree
    && bundle.result_tree === resultTree;
}

function readExistingBundle(record: WorktreeRecord, bundleId: string, resultTree: string, receiptId: string, env?: NodeJS.ProcessEnv): ChangeBundleManifest | null {
  try {
    const existing = readPersistedChangeBundleManifest(record.repository_root, record.run_id, bundleId, env);
    if (!sameImmutableBundleIdentity(existing, record, receiptId, resultTree)) {
      throw new WorktreeBundleError("persisted bundle identity differs from the audited terminal result", "CHANGE_BUNDLE_IDENTITY_CONFLICT");
    }
    return existing;
  } catch (error) {
    if (error instanceof WorktreeExecutionError && error.code === "WORKTREE_RECORD_MISSING") return null;
    throw error;
  }
}

function transitionRejected(input: CreateWorktreeChangeBundleInput, record: WorktreeRecord, audit: TerminalWorktreeAuditResult): WorktreeRecord {
  if (input.persist_lifecycle === false) return record;
  let current: WorktreeRecord;
  try { current = readPersistedWorktreeRecord(record.repository_root, record.run_id, record.unit_key, record.attempt_id, input.env); }
  catch (error) {
    if (error instanceof WorktreeExecutionError && error.code === "WORKTREE_RECORD_MISSING") return record;
    throw error;
  }
  if (current.lifecycle_state === "rejected") return current;
  if (current.lifecycle_state !== "terminal_awaiting_audit") throw new WorktreeBundleError("rejected audit cannot advance the current worktree lifecycle", "CHANGE_BUNDLE_STATE_INVALID");
  const verdictId = fingerprintWorktreeRuntimeRecord({ result_tree: audit.result_tree, violations: audit.violations, total: audit.total_violation_count });
  return transitionPersistedWorktreeRecord(record.repository_root, record.run_id, record.unit_key, record.attempt_id, {
    idempotency_key: `audit-rejected:${verdictId}`,
    phase: "audit",
    to_state: "rejected",
    retention_reasons: ["rejected_result_evidence"],
    recorded_at: record.updated_at,
  }, input.env);
}

function transitionReady(input: CreateWorktreeChangeBundleInput, record: WorktreeRecord, bundle: ChangeBundleManifest): WorktreeRecord {
  if (input.persist_lifecycle === false) return record;
  let current: WorktreeRecord;
  try { current = readPersistedWorktreeRecord(record.repository_root, record.run_id, record.unit_key, record.attempt_id, input.env); }
  catch (error) {
    if (error instanceof WorktreeExecutionError && error.code === "WORKTREE_RECORD_MISSING") return record;
    throw error;
  }
  if (current.lifecycle_state === "bundle_ready" && current.bundle_id === bundle.bundle_id) return current;
  if (current.lifecycle_state !== "terminal_awaiting_audit") throw new WorktreeBundleError("bundle cannot advance the current worktree lifecycle", "CHANGE_BUNDLE_STATE_INVALID");
  return transitionPersistedWorktreeRecord(record.repository_root, record.run_id, record.unit_key, record.attempt_id, {
    idempotency_key: `bundle-ready:${bundle.bundle_id}`,
    phase: "bundling",
    to_state: "bundle_ready",
    bundle_id: bundle.bundle_id,
    retention_reasons: ["ready_bundle"],
    recorded_at: bundle.created_at,
  }, input.env);
}

/** Audit, freeze, persist, and make one canonical ChangeBundle v1 ready. */
export async function createWorktreeChangeBundle(input: CreateWorktreeChangeBundleInput): Promise<WorktreeChangeBundleResult> {
  const record = assertWorktreeRecord(input.record);
  const audit = input.audit ?? await auditTerminalWorktree(input);
  if (!audit.accepted || audit.result_tree === null || audit.non_text_facts === null) {
    return { audit, bundle: null, record: transitionRejected(input, record, audit), replayed: false };
  }
  const terminalConclusion = boundedText(input.terminal_conclusion, "terminal_conclusion", 8192);
  const summaries = validationSummaries(input.validation_summaries);
  if (input.persist_lifecycle !== false) {
    let current: WorktreeRecord | null = null;
    try { current = readPersistedWorktreeRecord(record.repository_root, record.run_id, record.unit_key, record.attempt_id, input.env); }
    catch (error) {
      if (!(error instanceof WorktreeExecutionError && error.code === "WORKTREE_RECORD_MISSING")) throw error;
    }
    if (current?.bundle_id) {
      const frozen = readPersistedChangeBundleManifest(record.repository_root, record.run_id, current.bundle_id, input.env);
      if (!sameImmutableBundleIdentity(frozen, record, input.receipt.receipt_id, audit.result_tree)) {
        throw new WorktreeBundleError("audited terminal result differs from the attempt's already frozen bundle", "CHANGE_BUNDLE_IDENTITY_CONFLICT");
      }
      const restored = await freezeInternalCommit(record, audit, frozen.bundle_id, input.spawn);
      if (frozen.transport.internal_commit !== restored.internal_commit
        || frozen.transport.internal_ref !== restored.internal_ref
        || frozen.transport.internal_base_commit !== restored.internal_base_commit) {
        throw new WorktreeBundleError("persisted bundle transport differs from its deterministic immutable commits", "CHANGE_BUNDLE_IDENTITY_CONFLICT");
      }
      return { audit, bundle: frozen, record: current, replayed: true };
    }
    if (current && current.lifecycle_state !== "terminal_awaiting_audit") {
      throw new WorktreeBundleError("worktree lifecycle cannot freeze another bundle", "CHANGE_BUNDLE_STATE_INVALID");
    }
  }
  const identity = bundleIdentity(record, input.receipt.receipt_id, audit.result_tree);
  const bundleId = `bundle-${identity}`;
  const existing = readExistingBundle(record, bundleId, audit.result_tree, input.receipt.receipt_id, input.env);
  if (existing) {
    const restored = await freezeInternalCommit(record, audit, bundleId, input.spawn);
    if (existing.transport.internal_commit !== restored.internal_commit
      || existing.transport.internal_ref !== restored.internal_ref
      || existing.transport.internal_base_commit !== restored.internal_base_commit) {
      throw new WorktreeBundleError("persisted bundle transport differs from its deterministic immutable commits", "CHANGE_BUNDLE_IDENTITY_CONFLICT");
    }
    return { audit, bundle: existing, record: transitionReady(input, record, existing), replayed: true };
  }

  const internal = await freezeInternalCommit(record, audit, bundleId, input.spawn);
  const patch = await patchIdentity(record.execution_root, record.base_tree, audit.result_tree, input.spawn);
  const unsigned: Omit<ChangeBundleManifest, "fingerprint"> = {
    schema_version: CHANGE_BUNDLE_MANIFEST_SCHEMA_VERSION,
    bundle_id: bundleId,
    run_id: record.run_id,
    unit_key: record.unit_key,
    unit_version: record.unit_version,
    attempt_id: record.attempt_id,
    receipt_id: input.receipt.receipt_id,
    repository_id: record.repository_id,
    git_common_dir_identity: record.git_common_dir_identity,
    base_tree: record.base_tree,
    result_tree: audit.result_tree,
    operations: audit.operations,
    changed_paths: audit.changed_paths,
    non_text_facts: audit.non_text_facts,
    transport: { schema_version: 1, kind: "git-tree-internal-commit", ...internal, patch },
    validation_summaries: summaries,
    terminal_conclusion: terminalConclusion,
    safety_verdict: "safe",
    state: "ready_for_integration",
    retention_reasons: ["ready_bundle"],
    created_at: timestamp(input.created_at, record.updated_at),
  };
  const bundle = { ...unsigned, fingerprint: "" } as ChangeBundleManifest;
  bundle.fingerprint = fingerprintWorktreeRuntimeRecord(bundle);
  const persisted = persistChangeBundleManifest(record.repository_root, record.run_id, bundle, input.env);
  return { audit, bundle: persisted, record: transitionReady(input, record, persisted), replayed: false };
}

