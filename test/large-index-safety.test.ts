import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "bun:test";
import { run } from "../src/cli.js";
import { configureCli } from "./configure.js";
import { fakeEnv, withHome, testTicketId } from "./home.js";
import { GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM } from "../src/lib/git-index-control.js";
import { runGitProcess } from "../src/lib/git-safety-process.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { receiptsDir, spawnsDir } from "../src/lib/paths.js";

const VIRTUAL_ENTRY_COUNT = 12_000;
const VIRTUAL_PREFIX = "virtual/large-index-entry-";
const INDEX_DEBUG_LIMIT = 1024 * 1024;
const ROUTE = "kimi/k3[1m]";

interface LargeIndexFixture {
  cwd: string;
  virtualPath: string;
  entryCount: number;
}

interface OutputCapture {
  write(value: unknown): boolean;
  text(): string;
}

function capture(): OutputCapture {
  const chunks: string[] = [];
  return {
    write(value: unknown) {
      chunks.push(String(value));
      return true;
    },
    text() {
      return chunks.join("");
    },
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function gitWithInput(cwd: string, args: string[], input: Buffer): string {
  return execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trimEnd();
}

/**
 * Build one committed tree from one blob and virtual index paths. Git's index
 * owns the entries, while skip-worktree keeps the corresponding worktree
 * directory absent. The only large materialization is the one bulk NUL input.
 */
function createLargeIndexFixture(): LargeIndexFixture {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-large-index-safety-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "validation@example.invalid");
  git(cwd, "config", "user.name", "Validation");

  const allowedPath = "allowed.txt";
  fs.writeFileSync(path.join(cwd, allowedPath), "BASE_ALLOWED\n", "utf8");
  git(cwd, "add", allowedPath);
  git(cwd, "commit", "-q", "-m", "baseline");

  const parent = git(cwd, "rev-parse", "HEAD");
  const blob = git(cwd, "rev-parse", `HEAD:${allowedPath}`);
  const virtualPaths = Array.from({ length: VIRTUAL_ENTRY_COUNT }, (_, index) =>
    `${VIRTUAL_PREFIX}${String(index).padStart(5, "0")}-abcdefghijklmnop.txt`);
  const indexInfo = Buffer.from([
    `100644 ${blob} 0\t${allowedPath}\0`,
    ...virtualPaths.map((relative) => `100644 ${blob} 0\t${relative}\0`),
  ].join(""), "utf8");
  gitWithInput(cwd, ["update-index", "--add", "-z", "--index-info"], indexInfo);
  gitWithInput(cwd, ["update-index", "--skip-worktree", "-z", "--stdin"], Buffer.from(`${virtualPaths.join("\0")}\0`, "utf8"));

  const tree = git(cwd, "write-tree");
  const commit = gitWithInput(cwd, ["commit-tree", tree, "-p", parent], Buffer.from("large index fixture\n\n", "utf8"));
  const branch = git(cwd, "symbolic-ref", "--quiet", "--short", "HEAD");
  git(cwd, "update-ref", `refs/heads/${branch}`, commit, parent);

  const gitDir = git(cwd, "rev-parse", "--git-dir");
  const indexPath = git(cwd, "rev-parse", "--git-path", "index");
  assert.equal(fs.existsSync(path.resolve(cwd, gitDir)), true);
  assert.equal(fs.existsSync(path.resolve(cwd, indexPath)), true);
  assert.equal(fs.existsSync(path.join(cwd, "virtual")), false);
  assert.equal(git(cwd, "status", "--short", "--untracked-files=all"), "");

  return {
    cwd,
    virtualPath: virtualPaths[virtualPaths.length - 1]!,
    entryCount: virtualPaths.length + 1,
  };
}

async function measureIndexDebugBytes(cwd: string): Promise<number> {
  let bytes = 0;
  try {
    await runGitProcess({
      cwd,
      args: ["ls-files", "--debug", "-z"],
      onStdout: (chunk) => {
        bytes += chunk.byteLength;
      },
    });
  } catch (error) {
    assert.doesNotMatch(error instanceof Error ? error.message : String(error), /ENOBUFS/i);
    throw error;
  }
  return bytes;
}

async function batonCommand(cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<{ code: number; text: string }> {
  const output = capture();
  try {
    const code = await run(args, { cwd, env, stdout: output, stderr: output });
    const text = output.text();
    assert.doesNotMatch(text, /ENOBUFS/i, `Baton output unexpectedly contains ENOBUFS: ${text}`);
    return { code, text };
  } catch (error) {
    const detail = `${output.text()}\n${error instanceof Error ? error.message : String(error)}`;
    assert.doesNotMatch(detail, /ENOBUFS/i, `Baton error unexpectedly contains ENOBUFS: ${detail}`);
    throw error;
  }
}

function readJson(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
}

describe("large streamed Git index safety", () => {
  it("captures, audits, recovers, and completes a large real index without ENOBUFS", async () => {
    await withHome(async (home) => {
      const startedAt = performance.now();
      const fixture = createLargeIndexFixture();
      const { cwd } = fixture;
      try {
        const debugBytes = await measureIndexDebugBytes(cwd);
        assert.ok(debugBytes > INDEX_DEBUG_LIMIT, `ls-files --debug -z measured ${debugBytes} bytes`);
        assert.equal(fs.existsSync(path.join(cwd, "virtual")), false);

        const env = fakeEnv(home);
        let result = await batonCommand(cwd, env, ["init"]);
        assert.equal(result.code, 0, result.text);
        configureCli(cwd, env, "alpha", [ROUTE]);
        publishRouteSnapshot(cwd, { models: [{ id: "k3[1m]", provider: "kimi" }] }, new Date(), {
          cli: "alpha",
          host: "alpha",
          env,
        });

        result = await batonCommand(cwd, env, [
          "spawn",
          "exercise a large streamed Git index",
          "--host",
          "alpha",
          "--classification",
          "implementation",
          "--write-path",
          "allowed.txt",
          "--write-ops",
          "write",
          "--json",
        ]);
        assert.equal(result.code, 0, result.text);
        const firstSpawn = JSON.parse(result.text) as { tickets: Array<{ id: string }> };
        assert.equal(firstSpawn.tickets[0]?.id, testTicketId("spn", 1));

        const firstTicketFile = path.join(spawnsDir(cwd, env), `${testTicketId("spn", 1)}.json`);
        const firstTicket = readJson(firstTicketFile);
        const firstReceiptFile = path.join(receiptsDir(cwd, env), `${firstTicket.receipt_id}.json`);
        const firstReceipt = readJson(firstReceiptFile);
        assert.equal(fs.existsSync(firstTicketFile), true);
        assert.equal(fs.existsSync(firstReceiptFile), true);
        assert.equal(firstReceipt.schema_version, 4);
        assert.equal(firstReceipt.baseline.index_control_algorithm, GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM);
        assert.equal(firstReceipt.baseline.index_control_entry_count, fixture.entryCount);
        assert.equal(typeof firstReceipt.baseline.index_control_checksum, "string");
        assert.equal(firstReceipt.baseline.dirty_entries.length, 0);

        result = await batonCommand(cwd, env, ["dispatch", "next", "--host", "alpha", "--capacity", "1", "--json"]);
        assert.equal(result.code, 0, result.text);
        const reserved = JSON.parse(result.text) as { reserved: Array<Record<string, any>> };
        assert.equal(reserved.reserved.length, 1);
        assert.equal(reserved.reserved[0]?.ticket_id, testTicketId("spn", 1));
        assert.equal(typeof reserved.reserved[0]?.reservation?.reservation_id, "string");
        assert.equal(readJson(firstTicketFile).status, "dispatching");

        result = await batonCommand(cwd, env, [
          "dispatch",
          "bind",
          testTicketId("spn", 1),
          "--host",
          "alpha",
          "--execution-handle",
          "alpha-task=large-index-worker-1",
          "--json",
        ]);
        assert.equal(result.code, 0, result.text);
        const bound = JSON.parse(result.text) as { ticket: Record<string, any> };
        assert.equal(bound.ticket.status, "running");
        assert.deepEqual(bound.ticket.execution_handle, {
          kind: "alpha-task",
          value: "large-index-worker-1",
          source: "manual",
        });

        git(cwd, "update-index", "--no-skip-worktree", "--", fixture.virtualPath);
        assert.equal(fs.existsSync(path.join(cwd, "virtual")), false);
        result = await batonCommand(cwd, env, [
          "dispatch",
          "complete",
          testTicketId("spn", 1),
          "--host",
          "alpha",
          "--execution-handle",
          "alpha-task=large-index-worker-1",
          "--text",
          "must reject index control mutation",
          "--json",
        ]);
        assert.equal(result.code, 0, result.text);
        const rejected = JSON.parse(result.text) as { ticket: Record<string, any> };
        assert.equal(rejected.ticket.status, "errored");
        assert.equal(rejected.ticket.error.code, "WRITE_SCOPE_VIOLATION");
        assert.equal(rejected.ticket.safety_verdict.accepted, false);
        assert.ok(rejected.ticket.safety_verdict.violations.some((item: { code: string }) => item.code === "E_INDEX_MUTATION"));
        assert.equal(rejected.ticket.conclusion, null);

        result = await batonCommand(cwd, env, ["dispatch", "recover", "--host", "alpha", "--json"]);
        assert.equal(result.code, 0, result.text);
        const recovery = JSON.parse(result.text) as { expired: string[]; resumable: unknown[]; needs_close: Array<Record<string, any>> };
        assert.deepEqual(recovery.expired, []);
        assert.deepEqual(recovery.resumable, []);
        assert.deepEqual(recovery.needs_close, [{
          ticket_id: testTicketId("spn", 1),
          execution_handle: {
            kind: "alpha-task",
            value: "large-index-worker-1",
            source: "manual",
          },
          host: "alpha",
        }]);

        result = await batonCommand(cwd, env, [
          "dispatch",
          "release",
          testTicketId("spn", 1),
          "--host",
          "alpha",
          "--execution-handle",
          "alpha-task=large-index-worker-1",
          "--json",
        ]);
        assert.equal(result.code, 0, result.text);
        const released = JSON.parse(result.text) as { ticket: Record<string, any>; snapshot: Record<string, any> };
        assert.ok(released.ticket.slot_released_at);
        assert.equal(released.snapshot.active, 0);
        assert.equal(released.snapshot.available, 1);

        gitWithInput(cwd, ["update-index", "--skip-worktree", "-z", "--stdin"], Buffer.from(`${fixture.virtualPath}\0`, "utf8"));
        assert.equal(fs.existsSync(path.join(cwd, "virtual")), false);
        assert.equal(git(cwd, "status", "--short", "--untracked-files=all"), "");

        result = await batonCommand(cwd, env, [
          "spawn",
          "complete an allowlisted large-index worktree change",
          "--host",
          "alpha",
          "--classification",
          "implementation",
          "--write-path",
          "allowed.txt",
          "--write-ops",
          "write",
          "--json",
        ]);
        assert.equal(result.code, 0, result.text);
        const secondSpawn = JSON.parse(result.text) as { tickets: Array<{ id: string }> };
        assert.equal(secondSpawn.tickets[0]?.id, testTicketId("spn", 2));
        const secondTicketFile = path.join(spawnsDir(cwd, env), `${testTicketId("spn", 2)}.json`);
        const secondTicket = readJson(secondTicketFile);
        const secondReceiptFile = path.join(receiptsDir(cwd, env), `${secondTicket.receipt_id}.json`);
        const secondReceipt = readJson(secondReceiptFile);
        assert.equal(secondReceipt.baseline.index_control_algorithm, GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM);
        assert.equal(secondReceipt.baseline.index_control_entry_count, fixture.entryCount);

        result = await batonCommand(cwd, env, ["dispatch", "next", "--host", "alpha", "--capacity", "1", "--json"]);
        assert.equal(result.code, 0, result.text);
        assert.equal(JSON.parse(result.text).reserved[0]?.ticket_id, testTicketId("spn", 2));
        result = await batonCommand(cwd, env, [
          "dispatch",
          "bind",
          testTicketId("spn", 2),
          "--host",
          "alpha",
          "--execution-handle",
          "alpha-task=large-index-worker-2",
          "--json",
        ]);
        assert.equal(result.code, 0, result.text);
        fs.appendFileSync(path.join(cwd, "allowed.txt"), "AUTHORIZED_WORKTREE_CHANGE\n", "utf8");

        result = await batonCommand(cwd, env, [
          "dispatch",
          "complete",
          testTicketId("spn", 2),
          "--host",
          "alpha",
          "--text",
          "allowlisted worktree change accepted",
          "--release",
          "--json",
        ]);
        assert.equal(result.code, 0, result.text);
        const completed = JSON.parse(result.text) as { ticket: Record<string, any>; snapshot: Record<string, any> };
        assert.equal(completed.ticket.status, "completed");
        assert.equal(completed.ticket.safety_verdict.accepted, true);
        assert.deepEqual(completed.ticket.safety_verdict.violations, []);
        assert.ok(completed.ticket.slot_released_at);
        assert.equal(completed.snapshot.active, 0);
        assert.equal(completed.snapshot.available, 1);
        assert.equal(fs.existsSync(path.join(cwd, "virtual")), false);
        assert.equal(fs.existsSync(spawnsDir(cwd, env)), true);
        assert.equal(fs.existsSync(receiptsDir(cwd, env)), true);
        assert.equal(fs.readdirSync(spawnsDir(cwd, env)).length, 2);
        assert.equal(fs.readdirSync(receiptsDir(cwd, env)).length, 2);

        const elapsedMs = Math.round(performance.now() - startedAt);
        process.stdout.write(`[large-index-safety] debug_bytes=${debugBytes} entry_count=${fixture.entryCount} duration_ms=${elapsedMs} evidence=v2-receipt,reservation,binding,index-rejection,recovery,release,allowlisted-completion\n`);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});
