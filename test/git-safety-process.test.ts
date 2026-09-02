import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "bun:test";
import { collectGitScalar, GitSafetyError, runGitProcess } from "../src/lib/git/safety-process.ts";

function fakeSpawn(options: { stdout?: string; stderr?: string; code?: number | null; signal?: NodeJS.Signals | null; throwOnSpawn?: boolean; asyncError?: string }) {
  return (() => {
    if (options.throwOnSpawn) throw new Error("token=should-not-be-rendered");
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough; stderr: PassThrough; exitCode: number | null; signalCode: NodeJS.Signals | null;
      kill: (signal: NodeJS.Signals) => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => true;
    queueMicrotask(() => {
      if (options.asyncError) child.emit("error", new Error(options.asyncError));
      if (options.stdout) child.stdout.end(Buffer.from(options.stdout)); else child.stdout.end();
      if (options.stderr) child.stderr.end(Buffer.from(options.stderr)); else child.stderr.end();
      child.exitCode = options.signal ? null : (options.code ?? 0);
      child.signalCode = options.signal ?? null;
      child.emit("close", child.exitCode, child.signalCode);
    });
    return child;
  }) as never;
}

describe("Git scalar process boundary", () => {
  it("returns a successful scalar and removes its line terminator", async () => {
    const value = await collectGitScalar({ cwd: "/private/checkout", args: ["rev-parse", "HEAD"], spawn: fakeSpawn({ stdout: "abc123\n" }) });
    assert.equal(value, "abc123");
  });

  it("rejects scalar contract overflow", async () => {
    await assert.rejects(
      collectGitScalar({ cwd: "/private/checkout", args: ["rev-parse", "HEAD"], scalarLimit: 3, spawn: fakeSpawn({ stdout: "abcd" }) }),
      (error: unknown) => error instanceof GitSafetyError && error.code === "GIT_SAFETY_SCALAR_LIMIT",
    );
  });

  it("reports spawn failures without rendering the cause or cwd", async () => {
    await assert.rejects(
      collectGitScalar({ cwd: "/private/secret-checkout", args: ["status"], spawn: fakeSpawn({ throwOnSpawn: true }) }),
      (error: unknown) => error instanceof GitSafetyError
        && error.code === "GIT_SAFETY_COMMAND_FAILED"
        && !error.message.includes("should-not-be-rendered")
        && !error.message.includes("secret-checkout"),
    );
  });

  it("renders asynchronous child errors without sensitive details and reaps at close", async () => {
    await assert.rejects(
      runGitProcess({ cwd: "/private/secret-checkout", args: ["status"], spawn: fakeSpawn({ asyncError: "cwd=/private/secret-checkout token=hidden" }) }),
      (error: unknown) => error instanceof GitSafetyError
        && error.code === "GIT_SAFETY_COMMAND_FAILED"
        && error.message.includes('git "status"')
        && !error.message.includes("secret-checkout")
        && !error.message.includes("hidden"),
    );
  });

  it("preserves non-zero exit status and bounded stderr", async () => {
    await assert.rejects(
      runGitProcess({ cwd: "/private/checkout", args: ["write-tree"], stderrLimit: 5, spawn: fakeSpawn({ code: 7, stderr: "0123456789" }) }),
      (error: unknown) => error instanceof GitSafetyError && error.exitCode === 7 && error.stderr === "56789",
    );
  });

  it("preserves signal termination as a safety failure", async () => {
    await assert.rejects(
      collectGitScalar({ cwd: "/private/checkout", args: ["symbolic-ref", "HEAD"], spawn: fakeSpawn({ signal: "SIGTERM" }) }),
      (error: unknown) => error instanceof GitSafetyError && error.signal === "SIGTERM",
    );
  });
});
