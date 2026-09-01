import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { collectGitScalar, GitSafetyError, runGitProcess, type GitProcessOptions } from "./git-safety-process.js";
import {
  consumeGitIndexControlV2,
  GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM,
  type GitIndexControlFingerprint,
} from "./git-index-control.js";
import {
  consumeModeChangeSummary,
  consumeLineRecords,
  consumePorcelainV1Z,
  consumeRefRecords,
  consumeReflogSummary,
  consumeStagedPaths,
  consumeUntrackedExists,
  type ReflogSummary,
  type StatusRecord,
} from "./git-record-consumers.js";

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
  return crypto.createHash("sha256").update(JSON.stringify({
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
  })).digest("hex");
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
  return crypto.createHash("sha256").update(JSON.stringify(refs)).digest("hex");
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
