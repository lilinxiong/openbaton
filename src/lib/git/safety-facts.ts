import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectGitScalar, GitSafetyError, runGitProcess, type GitProcessOptions } from "./safety-process.js";
import {
  consumeGitIndexControlV2,
  GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM,
  type GitIndexControlFingerprint,
} from "./index-control.js";
import {
  consumeModeChangeSummary,
  consumeLineRecords,
  consumeNulRecords,
  consumePorcelainV1Z,
  consumeRefRecords,
  consumeReflogSummary,
  consumeStagedPaths,
  consumeUntrackedExists,
  type ReflogSummary,
  type StatusRecord,
} from "./record-consumers.js";
import { sha256Hex } from "../json-utils.js";

export interface GitSafetyFacts {
  head: string;
  branch: string;
  branchRef: string;
  refs: string[];
  reflog: ReflogSummary;
  /** First reflog record, retained only for the exact one-commit audit. */
  reflogFirst?: string;
  /** Checksum of all reflog records except the newest record. */
  reflogPriorChecksum?: string;
  stagedTree: string;
  stagedPaths: string[];
  dirtyEntries: StatusRecord[];
  untrackedExists: boolean;
  modeChangedPaths: Set<string>;
  indexControl: GitIndexControlFingerprint;
  /** Additional bounded facts needed by baseline/audit mapping. */
  indexPath?: string;
  gitOperation?: string | null;
  commit?: { id: string; parent: string; parentCount?: number; tree: string; subject: string };
}

/** The compact repository identity checked before a facts pass is accepted. */
export interface GitSafetyStabilityToken {
  head: string;
  /** Empty when HEAD is detached. */
  branchRef: string;
  /** SHA-256(JSON.stringify(filtered, ordered refs)). */
  refsDigest: string;
  reflog: ReflogSummary;
  stagedTree: string;
  indexControl: GitIndexControlFingerprint;
}

/** Canonical digest of every caller-owned control fact used by setup. */
export function fingerprintGitSafetyStabilityToken(token: GitSafetyStabilityToken): string {
  return sha256Hex(JSON.stringify({
    head: token.head,
    branchRef: token.branchRef,
    refsDigest: token.refsDigest,
    reflog: { count: token.reflog.count, checksum: token.reflog.checksum },
    stagedTree: token.stagedTree,
    indexControl: {
      algorithm: token.indexControl.algorithm,
      checksum: token.indexControl.checksum,
      entryCount: token.indexControl.entryCount,
    },
  }));
}

export function assertGitSafetyStabilityTokenUnchanged(
  before: GitSafetyStabilityToken,
  after: GitSafetyStabilityToken,
): void {
  if (!sameStabilityToken(before, after)) {
    throw new GitSafetyError({
      code: "GIT_BASELINE_RACED",
      command: "git worktree caller control invariance",
      message: "Git caller control facts changed during isolated worktree setup",
    });
  }
}

export interface StableGitSafetyFacts extends GitSafetyFacts {
  stabilityToken: GitSafetyStabilityToken;
}

export type GitTreeChangeOperation = "write" | "create" | "delete" | "rename" | "copy" | "chmod";

/** One lossless raw-tree delta. Object ids and modes are authoritative. */
export interface GitTreeChangeFact {
  status: "A" | "C" | "D" | "M" | "R" | "T";
  score?: number;
  operation: GitTreeChangeOperation;
  path: string;
  original_path?: string;
  old_mode: string;
  new_mode: string;
  old_object: string;
  new_object: string;
  binary: boolean;
}

/** A stable terminal filesystem image plus its immutable base-to-result facts. */
export interface StableGitTerminalTreeFacts {
  baseTree: string;
  resultTree: string;
  changes: GitTreeChangeFact[];
  binaryPaths: string[];
  symlinkPaths: string[];
  gitlinkPaths: string[];
  modeChangedPaths: string[];
  baseIndexControl: GitIndexControlFingerprint;
  terminal: StableGitSafetyFacts;
}

export interface StableGitTerminalTreeOptions extends GitSafetyFactsOptions {
  collectFacts?: StableGitSafetyFactsOptions["collectFacts"];
  collectToken?: StableGitSafetyFactsOptions["collectToken"];
}

export type GitSafetyFactsOptions = {
  indexControlAlgorithm?: typeof GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM;
  spawn?: GitProcessOptions["spawn"];
};

export type GitSafetyObservationPurpose = "baseline" | "audit";

export interface StableGitSafetyFactsOptions extends GitSafetyFactsOptions {
  purpose?: GitSafetyObservationPurpose;
  /** Injectable complete-pass collector, primarily for deterministic tests. */
  collectFacts?: (repoRoot: string, options: GitSafetyFactsOptions) => Promise<GitSafetyFacts>;
  /** Injectable fresh-token collector, primarily for deterministic tests. */
  collectToken?: (repoRoot: string, options: GitSafetyFactsOptions) => Promise<GitSafetyStabilityToken>;
}

type FactConsumer<T> = (chunks: AsyncIterable<Buffer>) => Promise<T>;

type Ack = { resolve: () => void; reject: (error: unknown) => void };

/** Low-level injectable streamed fact boundary used by safety collectors and tests. */
export async function streamGitSafetyFact<T>(
  cwd: string,
  args: string[],
  consume: FactConsumer<T>,
  spawn?: GitProcessOptions["spawn"],
  env?: NodeJS.ProcessEnv,
): Promise<T> {
  let consumer: Promise<T> | undefined;
  let slot: { chunk: Buffer; ack: Ack } | undefined;
  let wake: (() => void) | undefined;
  let ended = false;
  let consumerFailure: unknown;
  const abortController = new AbortController();
  const chunks = (async function* (): AsyncGenerator<Buffer> {
    for (;;) {
      if (slot) {
        const current = slot;
        yield current.chunk;
        current.ack.resolve();
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  })();
  consumer = Promise.resolve(consume(chunks));
  // A malformed or otherwise failed consumer must unblock the producer so the
  // shared runner can terminate and reap a child that pauses after stdout.
  void consumer.then(() => {
    if (!ended) {
      consumerFailure = new Error("Git safety consumer ended before draining stdout");
      ended = true;
      slot?.ack.reject(consumerFailure);
      abortController.abort();
      wake?.();
    }
  }, (error) => {
    consumerFailure = error;
    ended = true;
    slot?.ack.reject(error);
    abortController.abort();
    wake?.();
  });
  try {
    await runGitProcess({
      cwd,
      args,
      spawn,
      env,
      signal: abortController.signal,
      onStdout: (chunk) => {
        if (consumerFailure !== undefined) return Promise.reject(consumerFailure);
        if (slot) return Promise.reject(new Error("Git safety consumer did not advance"));
        return new Promise<void>((resolve, reject) => {
          slot = { chunk: Buffer.from(chunk), ack: { resolve: () => { slot = undefined; resolve(); }, reject } };
          wake?.();
          wake = undefined;
        });
      },
    });
    ended = true;
    wake?.();
    return await consumer;
  } catch (error) {
    ended = true;
    slot?.ack.reject(consumerFailure ?? error);
    wake?.();
    await consumer.catch(() => undefined);
    throw consumerFailure ?? error;
  }
}

async function optionalScalar(cwd: string, args: string[], spawn?: GitProcessOptions["spawn"]): Promise<string | null> {
  try { return await collectGitScalar({ cwd, args, spawn }); }
  catch (error) {
    if (error instanceof GitSafetyError && error.exitCode === 1) return null;
    throw error;
  }
}

function selectIndexControlAlgorithm(options: GitSafetyFactsOptions): typeof GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM {
  const selectedAlgorithm = options.indexControlAlgorithm ?? GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM;
  if (selectedAlgorithm !== GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM) {
    throw new TypeError(`Unsupported index control algorithm: ${String(selectedAlgorithm)}`);
  }
  return selectedAlgorithm;
}

function refsDigest(refs: readonly string[]): string {
  return sha256Hex(JSON.stringify(refs));
}

/** Derive the token without rereading Git; only compact facts are retained. */
export function deriveGitSafetyStabilityToken(facts: GitSafetyFacts): GitSafetyStabilityToken {
  return {
    head: facts.head,
    branchRef: facts.branchRef,
    refsDigest: refsDigest(facts.refs),
    reflog: { count: facts.reflog.count, checksum: facts.reflog.checksum },
    stagedTree: facts.stagedTree,
    indexControl: {
      algorithm: facts.indexControl.algorithm,
      checksum: facts.indexControl.checksum,
      entryCount: facts.indexControl.entryCount,
    },
  };
}

function sameStabilityToken(left: GitSafetyStabilityToken, right: GitSafetyStabilityToken): boolean {
  return left.head === right.head
    && left.branchRef === right.branchRef
    && left.refsDigest === right.refsDigest
    && left.reflog.count === right.reflog.count
    && left.reflog.checksum === right.reflog.checksum
    && left.stagedTree === right.stagedTree
    && left.indexControl.algorithm === right.indexControl.algorithm
    && left.indexControl.checksum === right.indexControl.checksum
    && left.indexControl.entryCount === right.indexControl.entryCount;
}

async function collectStableToken(repoRoot: string, options: GitSafetyFactsOptions): Promise<GitSafetyStabilityToken> {
  const selectedAlgorithm = selectIndexControlAlgorithm(options);
  const { spawn } = options;
  // Keep this pass in the same sequential order and use the exact same
  // scalar/stream consumers as collectGitSafetyFacts. A fresh invocation also
  // guarantees fresh parser, hash, and accumulator state on every retry.
  const head = await collectGitScalar({ cwd: repoRoot, args: ["rev-parse", "HEAD"], spawn });
  const branchRef = await optionalScalar(repoRoot, ["symbolic-ref", "-q", "HEAD"], spawn);
  const refs = await streamGitSafetyFact(repoRoot, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs"],
    consumeRefRecords, spawn);
  const reflog = await streamGitSafetyFact(repoRoot, ["reflog", "show", "--format=%H%x00%gs", "HEAD"], consumeReflogSummary, spawn);
  const stagedTree = await collectGitScalar({ cwd: repoRoot, args: ["write-tree"], spawn });
  const indexControl = await streamGitSafetyFact<GitIndexControlFingerprint>(
    repoRoot,
    ["ls-files", "--debug", "-z"],
    (chunks) => consumeGitIndexControlV2(chunks),
    spawn,
  );
  return { head, branchRef: branchRef ?? "", refsDigest: refsDigest(refs), reflog, stagedTree, indexControl };
}

async function collectGitOperation(repoRoot: string, spawn?: GitProcessOptions["spawn"]): Promise<string | null> {
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-apply", "rebase-merge", "sequencer"]) {
    const relative = await collectGitScalar({ cwd: repoRoot, args: ["rev-parse", "--git-path", name], spawn });
    const location = path.isAbsolute(relative) ? relative : path.join(repoRoot, relative);
    if (fs.existsSync(location)) return name;
  }
  return null;
}

async function collectHeadCommit(repoRoot: string, spawn?: GitProcessOptions["spawn"]): Promise<{ id: string; parent: string; parentCount: number; tree: string; subject: string }> {
  const fields = (await collectGitScalar({
    cwd: repoRoot,
    args: ["show", "-s", "--format=%H%x00%P%x00%T%x00%s", "HEAD"],
    spawn,
  })).split("\0");
  const parents = (fields[1] || "").split(" ").filter(Boolean);
  return { id: fields[0] || "", parent: parents[0] || "", parentCount: parents.length, tree: fields[2] || "", subject: fields[3] || "" };
}

async function consumeReflogWithFirst(chunks: AsyncIterable<Buffer>): Promise<{ summary: ReflogSummary; first: string | undefined; priorChecksum: string }> {
  const hash = crypto.createHash("sha256");
  const priorHash = crypto.createHash("sha256");
  hash.update("[");
  priorHash.update("[");
  let count = 0;
  let first: string | undefined;
  await consumeLineRecords(chunks, (record) => {
    const line = record.toString("utf8");
    if (!line) return;
    if (first === undefined) first = line;
    if (count > 0) hash.update(",");
    hash.update(JSON.stringify(line));
    if (count > 1) priorHash.update(",");
    if (count > 0) priorHash.update(JSON.stringify(line));
    count += 1;
  });
  hash.update("]");
  priorHash.update("]");
  return { summary: { count, checksum: hash.digest("hex") }, first, priorChecksum: priorHash.digest("hex") };
}

/** Collect one size-bounded set of Git facts; all unbounded outputs are streamed. */
export async function collectGitSafetyFacts(
  repoRoot: string,
  options: GitSafetyFactsOptions = {},
): Promise<GitSafetyFacts> {
  const selectedAlgorithm = selectIndexControlAlgorithm(options);
  const { spawn } = options;
  // Keep the observation pass single-flight: status and write-tree may both
  // refresh the index, and parallel children can self-contend on index.lock.
  const head = await collectGitScalar({ cwd: repoRoot, args: ["rev-parse", "HEAD"], spawn });
  const branch = await collectGitScalar({ cwd: repoRoot, args: ["branch", "--show-current"], spawn });
  const branchRef = await optionalScalar(repoRoot, ["symbolic-ref", "-q", "HEAD"], spawn);
  const refs = await streamGitSafetyFact(repoRoot, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs"],
    consumeRefRecords, spawn);
  const reflogWithFirst = await streamGitSafetyFact(repoRoot, ["reflog", "show", "--format=%H%x00%gs", "HEAD"], consumeReflogWithFirst, spawn);
  const reflog = reflogWithFirst.summary;
  const stagedTree = await collectGitScalar({ cwd: repoRoot, args: ["write-tree"], spawn });
  const stagedPaths = await streamGitSafetyFact(repoRoot, ["diff", "--cached", "--name-only", "-z"], consumeStagedPaths, spawn);
  const dirtyEntries = await streamGitSafetyFact(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], consumePorcelainV1Z, spawn);
  const untrackedExists = await streamGitSafetyFact(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"], consumeUntrackedExists, spawn);
  const modeChangedPaths = await streamGitSafetyFact(repoRoot, ["diff", "--summary", "HEAD"], consumeModeChangeSummary, spawn);
  const indexControl = await streamGitSafetyFact<GitIndexControlFingerprint>(
    repoRoot,
    ["ls-files", "--debug", "-z"],
    (chunks) => consumeGitIndexControlV2(chunks),
    spawn,
  );
  const indexRelative = await collectGitScalar({ cwd: repoRoot, args: ["rev-parse", "--git-path", "index"], spawn });
  const indexPath = path.isAbsolute(indexRelative) ? indexRelative : path.join(repoRoot, indexRelative);
  const gitOperation = await collectGitOperation(repoRoot, spawn);
  const commit = await collectHeadCommit(repoRoot, spawn);
  return {
    head, branch, branchRef: branchRef ?? "", refs, reflog, stagedTree,
    stagedPaths, dirtyEntries, untrackedExists, modeChangedPaths, indexControl,
    indexPath, gitOperation, commit, reflogFirst: reflogWithFirst.first, reflogPriorChecksum: reflogWithFirst.priorChecksum,
  };
}

function raceError(purpose: GitSafetyObservationPurpose): GitSafetyError {
  const code = purpose === "audit" ? "GIT_AUDIT_RACED" : "GIT_BASELINE_RACED";
  return new GitSafetyError({
    code,
    command: "git safety stable observation",
    message: `Git safety ${purpose} observation raced twice`,
  });
}

/**
 * Capture a complete facts pass and validate it against an independently
 * collected token. On a mismatch the entire pass is discarded and repeated
 * exactly once. Collection/parse failures propagate unchanged.
 */
export async function captureStableSafetyFacts(
  repoRoot: string,
  options: StableGitSafetyFactsOptions = {},
): Promise<StableGitSafetyFacts> {
  const { purpose = "baseline", collectFacts = collectGitSafetyFacts, collectToken = collectStableToken, ...factsOptions } = options;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const facts = await collectFacts(repoRoot, factsOptions);
    const expected = deriveGitSafetyStabilityToken(facts);
    const actual = await collectToken(repoRoot, factsOptions);
    if (sameStabilityToken(expected, actual)) return { ...facts, stabilityToken: expected };
  }
  throw raceError(purpose);
}

function malformedTreeFacts(message: string): GitSafetyError {
  return new GitSafetyError({
    code: "GIT_SAFETY_STREAM_MALFORMED",
    command: "git diff-tree --raw -z",
    message,
  });
}

function operationForTreeStatus(status: GitTreeChangeFact["status"], oldMode: string, newMode: string): GitTreeChangeOperation {
  if (status === "A") return "create";
  if (status === "D") return "delete";
  if (status === "R") return "rename";
  if (status === "C") return "copy";
  if (status === "T" || oldMode !== newMode) return "chmod";
  return "write";
}

/** Parse `git diff-tree --raw -z` incrementally without aggregate buffering. */
export async function consumeGitRawTreeChanges(chunks: AsyncIterable<Buffer>): Promise<GitTreeChangeFact[]> {
  const changes: GitTreeChangeFact[] = [];
  let metadata: Omit<GitTreeChangeFact, "path" | "original_path" | "binary"> | undefined;
  let paths: string[] = [];
  await consumeNulRecords(chunks, (record) => {
    if (!metadata) {
      const value = record.toString("utf8");
      const match = value.match(/^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([ACDMRT])(\d*)$/u);
      if (!match) throw malformedTreeFacts("Git returned a malformed raw tree-change record");
      const status = match[5] as GitTreeChangeFact["status"];
      const oldMode = match[1]!;
      const newMode = match[2]!;
      metadata = {
        status,
        ...(match[6] ? { score: Number.parseInt(match[6], 10) } : {}),
        operation: operationForTreeStatus(status, oldMode, newMode),
        old_mode: oldMode,
        new_mode: newMode,
        old_object: match[3]!,
        new_object: match[4]!,
      };
      paths = [];
      return;
    }
    paths.push(record.toString("utf8"));
    const expected = metadata.status === "R" || metadata.status === "C" ? 2 : 1;
    if (paths.length < expected) return;
    if (paths.some((item) => !item)) throw malformedTreeFacts("Git returned an empty raw tree-change path");
    changes.push({
      ...metadata,
      path: paths[expected - 1]!,
      ...(expected === 2 ? { original_path: paths[0]! } : {}),
      binary: false,
    });
    metadata = undefined;
    paths = [];
  });
  if (metadata) throw malformedTreeFacts("Git returned an incomplete raw tree-change record");
  return changes;
}

/** Parse `git diff-tree --numstat -z --no-renames` and retain only binary paths. */
export async function consumeGitBinaryPaths(chunks: AsyncIterable<Buffer>): Promise<string[]> {
  const paths = new Set<string>();
  await consumeNulRecords(chunks, (record) => {
    const first = record.indexOf(0x09);
    const second = first < 0 ? -1 : record.indexOf(0x09, first + 1);
    if (first < 0 || second < 0 || second === record.length - 1) {
      throw malformedTreeFacts("Git returned a malformed numstat record");
    }
    const added = record.subarray(0, first).toString("ascii");
    const deleted = record.subarray(first + 1, second).toString("ascii");
    const pathname = record.subarray(second + 1).toString("utf8");
    if ((added === "-") !== (deleted === "-") || (added !== "-" && (!/^\d+$/u.test(added) || !/^\d+$/u.test(deleted)))) {
      throw malformedTreeFacts("Git returned invalid numstat counters");
    }
    if (added === "-") paths.add(pathname);
  });
  return [...paths].sort();
}

function terminalSurfaceFingerprint(facts: StableGitSafetyFacts): string {
  return sha256Hex(JSON.stringify({
    head: facts.head,
    branch: facts.branch,
    branch_ref: facts.branchRef,
    staged_tree: facts.stagedTree,
    staged_paths: facts.stagedPaths,
    dirty_entries: facts.dirtyEntries,
    untracked_exists: facts.untrackedExists,
    mode_changed_paths: [...facts.modeChangedPaths].sort(),
    git_operation: facts.gitOperation ?? null,
    commit: facts.commit ?? null,
    stability_token: facts.stabilityToken,
  }));
}

async function materializeVisibleResultTree(
  repoRoot: string,
  baseTree: string,
  indexFile: string,
  spawn?: GitProcessOptions["spawn"],
): Promise<string> {
  const env = { GIT_INDEX_FILE: indexFile };
  await runGitProcess({ cwd: repoRoot, args: ["read-tree", baseTree], env, spawn });
  await runGitProcess({ cwd: repoRoot, args: ["add", "-A", "--", "."], env, spawn });
  return collectGitScalar({ cwd: repoRoot, args: ["write-tree"], env, spawn });
}

async function collectBaseIndexControl(
  repoRoot: string,
  baseTree: string,
  indexFile: string,
  spawn?: GitProcessOptions["spawn"],
): Promise<GitIndexControlFingerprint> {
  const env = { GIT_INDEX_FILE: indexFile };
  await runGitProcess({ cwd: repoRoot, args: ["read-tree", baseTree], env, spawn });
  return streamGitSafetyFact(
    repoRoot,
    ["ls-files", "--debug", "-z"],
    (chunks) => consumeGitIndexControlV2(chunks),
    spawn,
    env,
  );
}

/**
 * Freeze the visible terminal root twice through independent alternate indexes.
 * The tree is returned only when both complete captures and all control facts
 * agree, so a concurrent writer cannot produce a mixed-time accepted bundle.
 */
export async function captureStableGitTerminalTree(
  repoRoot: string,
  immutableBase: string,
  options: StableGitTerminalTreeOptions = {},
): Promise<StableGitTerminalTreeFacts> {
  const root = fs.realpathSync(repoRoot);
  const baseTree = await collectGitScalar({ cwd: root, args: ["rev-parse", `${immutableBase}^{tree}`], spawn: options.spawn });
  const stableOptions: StableGitSafetyFactsOptions = {
    purpose: "audit",
    spawn: options.spawn,
    collectFacts: options.collectFacts,
    collectToken: options.collectToken,
    indexControlAlgorithm: options.indexControlAlgorithm,
  };
  const before = await captureStableSafetyFacts(root, stableOptions);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "baton-terminal-audit-"));
  try {
    const firstTree = await materializeVisibleResultTree(root, baseTree, path.join(temporaryRoot, "index-first"), options.spawn);
    const baseIndexControl = await collectBaseIndexControl(root, baseTree, path.join(temporaryRoot, "index-base"), options.spawn);
    const middle = await captureStableSafetyFacts(root, stableOptions);
    const secondTree = await materializeVisibleResultTree(root, baseTree, path.join(temporaryRoot, "index-second"), options.spawn);
    const after = await captureStableSafetyFacts(root, stableOptions);
    if (firstTree !== secondTree
      || terminalSurfaceFingerprint(before) !== terminalSurfaceFingerprint(middle)
      || terminalSurfaceFingerprint(middle) !== terminalSurfaceFingerprint(after)) {
      throw new GitSafetyError({
        code: "GIT_AUDIT_RACED",
        command: "git safety stable terminal tree",
        message: "Git terminal worktree changed during the complete audit",
      });
    }
    const changes = await streamGitSafetyFact(
      root,
      ["diff-tree", "--no-commit-id", "-r", "--raw", "-z", "--no-abbrev", "-M", "-C", "--find-copies-harder", baseTree, secondTree],
      consumeGitRawTreeChanges,
      options.spawn,
    );
    const binaryPaths = await streamGitSafetyFact(
      root,
      ["diff-tree", "--no-commit-id", "-r", "--numstat", "-z", "--no-renames", baseTree, secondTree],
      consumeGitBinaryPaths,
      options.spawn,
    );
    const binary = new Set(binaryPaths);
    for (const change of changes) change.binary = binary.has(change.path) || Boolean(change.original_path && binary.has(change.original_path));
    return {
      baseTree,
      resultTree: secondTree,
      changes,
      binaryPaths,
      symlinkPaths: changes.filter((change) => change.old_mode === "120000" || change.new_mode === "120000")
        .flatMap((change) => [change.original_path, change.path].filter((item): item is string => Boolean(item))).filter((item, index, all) => all.indexOf(item) === index).sort(),
      gitlinkPaths: changes.filter((change) => change.old_mode === "160000" || change.new_mode === "160000")
        .flatMap((change) => [change.original_path, change.path].filter((item): item is string => Boolean(item))).filter((item, index, all) => all.indexOf(item) === index).sort(),
      modeChangedPaths: changes.filter((change) => change.old_mode !== change.new_mode
        && change.old_mode !== "000000" && change.new_mode !== "000000").map((change) => change.path).sort(),
      baseIndexControl,
      terminal: after,
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
