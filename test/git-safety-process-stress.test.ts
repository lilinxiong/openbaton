import { strict as assert } from "node:assert";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { describe, it } from "bun:test";
import { GitSafetyError, runGitProcess } from "../src/lib/git-safety-process.ts";
import { createGitIndexControlParser } from "../src/lib/git-index-control.ts";

type SpawnAdapter = NonNullable<Parameters<typeof runGitProcess>[0]["spawn"]>;

function childScript(script: string, observed?: { child?: ChildProcessWithoutNullStreams; closed?: boolean }): SpawnAdapter {
  return ((_command: string, _args: readonly string[], options: SpawnOptions) => {
    const child = nodeSpawn(process.env.BATON_TEST_NODE || "node", ["-e", script], options) as ChildProcessWithoutNullStreams;
    if (observed) {
      observed.child = child;
      child.once("close", () => { observed.closed = true; });
    }
    return child;
  }) as SpawnAdapter;
}

const base = { cwd: process.cwd(), args: ["stress-probe"] };

describe("Git process OS-pipe stress boundaries", () => {
  it("rejects partial stdout on exit 7 while retaining bounded metadata", async () => {
    const script = [
      "process.stdout.write('partial-record');",
      "process.stderr.write('diagnostic-tail');",
      "process.exitCode = 7;",
    ].join("");
    let partial = "";
    await assert.rejects(
      runGitProcess({ ...base, stderrLimit: 64, spawn: childScript(script), onStdout: (chunk) => { partial += chunk.toString(); } }),
      (error: unknown) => error instanceof GitSafetyError
        && error.exitCode === 7
        && error.signal === null
        && error.stderr === "diagnostic-tail"
        && partial === "partial-record",
    );
  });

  it("drains multi-MiB stderr while an awaited stdout callback backpressures", async () => {
    const script = [
      "const chunk = Buffer.alloc(64 * 1024, 120); let remaining = 16 * 1024 * 1024;",
      "function writeMore() { while (remaining > 0) { const n = Math.min(remaining, chunk.length); remaining -= n; if (!process.stderr.write(chunk.subarray(0, n))) return process.stderr.once('drain', writeMore); } process.stdout.write('complete'); }",
      "process.stdout.write('begin'); setTimeout(writeMore, 5);",
    ].join("");
    let callbacks = 0;
    let stdout = "";
    const result = await runGitProcess({
      ...base,
      stderrLimit: 97,
      spawn: childScript(script),
      onStdout: async (chunk) => {
        callbacks += 1;
        stdout += chunk.toString();
        if (callbacks === 1) await new Promise((resolve) => setTimeout(resolve, 40));
      },
    });
    assert.ok(callbacks >= 1);
    assert.match(stdout, /begin/);
    assert.match(stdout, /complete/);
    assert.equal(result.stderr.length, 97);
    assert.equal(result.stderr, String.fromCharCode(120).repeat(97));
  });

  it("reports a child that terminates itself with SIGTERM", async () => {
    const script = "process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000);";
    await assert.rejects(
      runGitProcess({ ...base, spawn: childScript(script) }),
      (error: unknown) => error instanceof GitSafetyError && error.exitCode === null && error.signal === "SIGTERM",
    );
  });

  it("escalates an aborting child from SIGTERM to SIGKILL and waits for close", async () => {
    const observed: { child?: ChildProcessWithoutNullStreams; closed?: boolean } = {};
    const controller = new AbortController();
    const script = "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);";
    let ready = false;
    const pending = runGitProcess({
      ...base,
      signal: controller.signal,
      killEscalationMs: 25,
      spawn: childScript(script, observed),
      onStdout: (chunk) => { if (chunk.toString().includes("ready")) { ready = true; controller.abort(); } },
    });
    await assert.rejects(pending, (error: unknown) => error instanceof GitSafetyError && /aborted/.test(error.message));
    assert.equal(ready, true);
    assert.equal(observed.closed, true);
    assert.equal(observed.child?.signalCode, "SIGKILL");
  });

  const runLarge = process.env.BATON_TEST_STREAM_128M === "1";
  (runLarge ? it : it.skip)("streams >128 MiB into the real incremental ls-files parser", async () => {
    const records = 4_300_000;
    const script = [
      `const total = ${records}; let i = 0;`,
      "function writeMore() { while (i < total) { const value = Buffer.from(`path-${i++}\\0  size: 0\\tflags: 0\\n`); if (!process.stdout.write(value)) return process.stdout.once('drain', writeMore); } }",
      "writeMore();",
    ].join("");
    const started = performance.now();
    const rssStart = process.memoryUsage().rss;
    let peakRss = rssStart;
    const rssSampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 25);
    let parsed = 0;
    let bytes = 0;
    const parser = createGitIndexControlParser(() => { parsed += 1; });
    try {
      await runGitProcess({ ...base, spawn: childScript(script), onStdout: async (chunk) => { bytes += chunk.byteLength; await parser.push(chunk); } });
      await parser.finish();
    } finally {
      clearInterval(rssSampler);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    const elapsed = performance.now() - started;
    const rssEnd = process.memoryUsage().rss;
    console.log(`128M stream bytes/records=${bytes}/${parsed} elapsedMs=${elapsed.toFixed(0)} rssStart/peak/end=${rssStart}/${peakRss}/${rssEnd}`);
    assert.equal(parsed, records);
    assert.ok(bytes > 128 * 1024 * 1024);
  }, 120000);
});
