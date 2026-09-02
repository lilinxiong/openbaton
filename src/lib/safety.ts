import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fingerprintGitIndexControlRecords, GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM } from "./git/index-control.js";
import {
  captureStableSafetyFacts,
  type GitSafetyFacts,
  type StableGitSafetyFacts,
  type StableGitSafetyFactsOptions,
} from "./git/safety-facts.js";
import { isRuntimeTurnDiffRef } from "./git/record-consumers.js";
import { collectGitScalar, type GitProcessOptions } from "./git/safety-process.js";
import { sha256Hex } from "./json-utils.js";

export type SafetyOperation = "write" | "create" | "delete" | "rename" | "chmod";

export interface GitBaseline {
  repo_root: string;
  head: string;
  branch: string;
  /** Attached branch ref, when the baseline was captured on a branch. */
  branch_ref: string;
  index_path: string;
  /** Semantic tree represented by the staged index. */
  index_tree: string;
  /** Semantic index-entry control flags; stat-cache bytes are deliberately omitted. */
  index_control_checksum: string;
  /** Optional version marker for the framed index-control fingerprint. */
  index_control_algorithm: string;
  /** Number of index-control records covered by the versioned fingerprint. */
  index_control_entry_count?: number;
  /** Complete refs and HEAD reflog captured for ordinary worker audits. */
  refs: string[];
  head_reflog_count: number;
  head_reflog_checksum: string;
  dirty_entries: StatusEntry[];
  /** Content fingerprint of each dirty path so incremental writes can keep pre-existing dirt. */
  dirty_checksums: Record<string, string>;
  captured_at: string;
}

export interface CommitBaseline {
  repo_root: string;
  head: string;
  branch: string;
  branch_ref: string;
  staged_tree: string;
  /** Semantic index-entry control flags; stat-cache bytes are deliberately omitted. */
  staged_index_control_checksum: string;
  /** Optional version marker for the framed index-control fingerprint. */
  staged_index_control_algorithm: string;
  /** Number of index-control records covered by the versioned fingerprint. */
  staged_index_control_entry_count?: number;
  staged_paths: string[];
  refs: string[];
  head_reflog_count: number;
  head_reflog_checksum: string;
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
  /** Allowlists of overlapping write tickets. Dirt on those paths is their audit, not this one. */
  peer_write_allowlists?: string[][];
  /**
   * Linked isolated roots share one common refs namespace with the parent.
   * Parent-owned integration may advance it while this root remains active;
   * root-local HEAD, branch, reflog, index, and path checks stay strict.
   */
  shared_refs?: "strict" | "parent-owned";
}

export interface SafetyViolation {
  code: string;
  path?: string;
  original_path?: string;
  operation?: SafetyOperation | "copy";
  message: string;
}

export interface SafetyVerdict {
  accepted: boolean;
  changes: Array<StatusEntry & { operation: SafetyOperation }>;
  violations: SafetyViolation[];
}

export interface CommitSafetyViolation {
  code: string;
  message: string;
}

export interface CommitSafetyVerdict {
  accepted: boolean;
  committed: boolean;
  commit: {
    id: string;
    parent: string;
    tree: string;
    subject: string;
  } | null;
  violations: CommitSafetyViolation[];
}

/** Narrow injection surface for Promise-based stable safety APIs. */
export interface AsyncSafetyOptions {
  spawn?: GitProcessOptions["spawn"];
  collectFacts?: StableGitSafetyFactsOptions["collectFacts"];
  collectToken?: StableGitSafetyFactsOptions["collectToken"];
}

export class CommitBaselineError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "CommitBaselineError";
    this.code = code;
  }
}

export type IndexControlBaselineErrorCode =
  | "INDEX_CONTROL_ALGORITHM_UNSUPPORTED"
  | "INDEX_CONTROL_BASELINE_INVALID";


export * from "./safety/baseline.js";
export * from "./safety/audit.js";
