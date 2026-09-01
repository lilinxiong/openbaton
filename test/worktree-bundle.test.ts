import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { worktreeExecutionRootPath } from "../src/lib/paths.js";
import {
  parseChangeBundleManifest,
  readPersistedChangeBundleManifest,
  readPersistedWorktreeRecord,
  transitionPersistedWorktreeRecord,
  type WorktreeRecord,
} from "../src/lib/worktree-execution.js";
import { setupDetachedWorktree } from "../src/lib/worktree-setup.js";
import { createWorktreeChangeBundle } from "../src/lib/worktree-bundle.js";
import type { WorktreeAuditReceipt } from "../src/lib/worktree-audit.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function fixture(name: string): Promise<{ repo: string; execution: string; env: NodeJS.ProcessEnv; record: WorktreeRecord; receipt: WorktreeAuditReceipt }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `baton-bundle-${name}-`));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(repo, "file.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  const commonRaw = git(repo, ["rev-parse", "--git-common-dir"]);
  const common = fs.realpathSync(path.isAbsolute(commonRaw) ? commonRaw : path.resolve(repo, commonRaw));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const run = `run-${name}`;
  const unit = `unit-${name}`;
  const attempt = `attempt-${name}`;
  const execution = worktreeExecutionRootPath(repo, run, unit, attempt, env);
  const setup = await setupDetachedWorktree({
    repository_root: repo,
    repository_id: "c".repeat(64),
    git_common_dir: common,
    git_common_dir_identity: "d".repeat(64),
    execution_root: execution,
    run_id: run,
    unit_key: unit,
    unit_version: 1,
    attempt_id: attempt,
    env,
  });
  transitionPersistedWorktreeRecord(repo, run, unit, attempt, {
    idempotency_key: "native-active",
    phase: "native_execution",
    to_state: "worker_active",
    native_handle: `handle-${name}`,
    retention_reasons: ["live_native_handle"],
    recorded_at: "2026-09-01T00:00:01.000Z",
  }, env);
  const record = transitionPersistedWorktreeRecord(repo, run, unit, attempt, {
    idempotency_key: "native-terminal",
    phase: "native_execution",
    to_state: "terminal_awaiting_audit",
    native_handle: null,
    retention_reasons: ["pending_audit"],
    recorded_at: "2026-09-01T00:00:02.000Z",
  }, env);
  return {
    repo, execution, env, record,
    receipt: {
      receipt_id: `receipt-${name}`,
      repository_id: record.repository_id,
      git_common_dir_identity: record.git_common_dir_identity,
      execution_root: execution,
      base_tree: setup.base_tree,
      worktree_record_id: record.record_id,
      write_allowlist: ["file.txt"],
      allowed_operations: ["write"],
    },
  };
}

describe("immutable ChangeBundle v1", () => {
  it("persists a canonical ready bundle and replays the same fingerprint", async () => {
    const f = await fixture("roundtrip");
    fs.writeFileSync(path.join(f.execution, "file.txt"), "result\n");
    const first = await createWorktreeChangeBundle({
      record: f.record,
      receipt: f.receipt,
      terminal_conclusion: "Implemented the scoped result.",
      validation_summaries: ["focused tests passed"],
      created_at: "2026-09-01T00:00:03.000Z",
      env: f.env,
    });
    assert.equal(first.audit.accepted, true, JSON.stringify(first.audit.violations));
    assert.equal(first.bundle?.state, "ready_for_integration");
    assert.equal(first.record.lifecycle_state, "bundle_ready");
    assert.equal(first.record.bundle_id, first.bundle?.bundle_id);
    assert.match(String((first.bundle?.transport as any).internal_commit), /^[0-9a-f]{40,64}$/);
    assert.match(String((first.bundle?.transport as any).patch.sha256), /^[0-9a-f]{64}$/);
    assert.deepEqual(parseChangeBundleManifest(JSON.stringify(first.bundle)), first.bundle);
    assert.deepEqual(readPersistedChangeBundleManifest(f.repo, f.record.run_id, first.bundle!.bundle_id, f.env), first.bundle);

    const replay = await createWorktreeChangeBundle({
      record: f.record,
      receipt: f.receipt,
      terminal_conclusion: "A later worker string cannot rewrite the frozen bundle.",
      validation_summaries: ["different text is ignored on identity replay"],
      env: f.env,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.bundle?.fingerprint, first.bundle?.fingerprint);
    assert.equal(replay.bundle?.terminal_conclusion, "Implemented the scoped result.");
  });

  it("recovers deterministically when manifest publication crashes after the internal ref is frozen", async () => {
    const f = await fixture("crash");
    fs.writeFileSync(path.join(f.execution, "file.txt"), "result after crash\n");
    const originalRename = fs.renameSync;
    let failed = false;
    fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
      if (!failed && String(destination).includes(`${path.sep}bundles${path.sep}`) && String(destination).endsWith("manifest-v1.json")) {
        failed = true;
        throw new Error("simulated manifest crash");
      }
      return originalRename(source, destination);
    }) as typeof fs.renameSync;
    try {
      await assert.rejects(createWorktreeChangeBundle({
        record: f.record,
        receipt: f.receipt,
        terminal_conclusion: "crash boundary",
        env: f.env,
      }), /simulated manifest crash/);
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(failed, true);
    assert.equal(readPersistedWorktreeRecord(f.repo, f.record.run_id, f.record.unit_key, f.record.attempt_id, f.env).lifecycle_state, "terminal_awaiting_audit");
    const recovered = await createWorktreeChangeBundle({
      record: f.record,
      receipt: f.receipt,
      terminal_conclusion: "crash boundary",
      env: f.env,
    });
    assert.equal(recovered.bundle?.state, "ready_for_integration");
    assert.equal(recovered.record.lifecycle_state, "bundle_ready");
  });

  it("accepts a deterministic internal ref concurrently created by an identical freezer", async () => {
    const f = await fixture("ref-race");
    fs.writeFileSync(path.join(f.execution, "file.txt"), "result after ref race\n");
    let raced = false;
    const racingSpawn = ((command: string, args: readonly string[], options: Parameters<typeof nodeSpawn>[2]) => {
      if (!raced && args[0] === "update-ref" && String(args[1]).startsWith("refs/baton/change-bundles/")) {
        raced = true;
        execFileSync(command, [...args], { cwd: options?.cwd, env: options?.env as NodeJS.ProcessEnv, stdio: "ignore" });
      }
      return nodeSpawn(command, args, options);
    }) as typeof nodeSpawn;
    const result = await createWorktreeChangeBundle({
      record: f.record,
      receipt: f.receipt,
      terminal_conclusion: "identical concurrent freeze",
      env: f.env,
      spawn: racingSpawn,
    });
    assert.equal(raced, true);
    assert.equal(result.bundle?.state, "ready_for_integration");
  });

  it("does not create a bundle from worker false-success text when the tree is empty", async () => {
    const f = await fixture("false-success");
    const result = await createWorktreeChangeBundle({
      record: f.record,
      receipt: f.receipt,
      terminal_conclusion: "Everything succeeded.",
      env: f.env,
    });
    assert.equal(result.bundle, null);
    assert.equal(result.audit.accepted, false);
    assert.ok(result.audit.violations.some((item) => item.code === "E_EMPTY_RESULT"));
    assert.equal(result.record.lifecycle_state, "rejected");
  });
});
