import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "bun:test";
import { ProbeEvidence } from "../adapters/codex/test-subagents.mjs";
import { discoverAdapters } from "../src/adapters/sdk.js";

function probe(count = 6, failure = true, error = "collab spawn failed: agent thread limit reached") {
  const p = new ProbeEvidence();
  p.accept({ type: "thread.started", thread_id: "root" });
  for (let n = 1; n <= count; n++) call(p, `spawn${n}`, "spawn_agent", "completed", [`child${n}`]);
  if (failure) call(p, "failure", "spawn_agent", "failed", []);
  for (let n = 1; n <= count; n++) call(p, `close${n}`, "close_agent", "completed", [`child${n}`]);
  p.accept({ type: "item.completed", item: { id: "answer", type: "agent_message",
    text: JSON.stringify({ capacity: count, stop_reason: failure ? "limit" : "ceiling", error }) } });
  p.accept({ type: "turn.completed" });
  return p;
}

function call(p: ProbeEvidence, id: string, tool: string, status: string, ids: string[]) {
  p.accept({ type: "item.completed", item: { id, type: "collab_tool_call", tool, status,
    sender_thread_id: "root", receiver_thread_ids: ids } });
}

describe("native capacity evidence", () => {
  it("requires a boundary and fully closed native agents", () => {
    assert.deepEqual(probe().result(), { adapter_id: "codex", capacity: 6, ceiling_reached: false });
    const p = probe();
    p.open.add("unclosed");
    assert.throws(() => p.result(), /cleanup/);
  });
  it("reports twenty as a lower bound", () => {
    assert.deepEqual(probe(20, false).result(), { adapter_id: "codex", capacity: 20, ceiling_reached: true });
    assert.throws(() => probe(6, false).result(), /boundary/);
  });
  it("does not treat authentication or model failures as capacity", () => {
    assert.throws(() => probe(6, true, "invalid model").result(), /boundary/);
    assert.throws(() => probe(0).result(), /evidence/);
  });
  it("rejects invented answers, missing completion and false counts", () => {
    const p = new ProbeEvidence();
    p.receipt = { capacity: 6, stop_reason: "limit", error: "agent thread limit reached" };
    p.completed = true;
    assert.throws(() => p.result(), /evidence/);
    const actual = probe();
    actual.receipt.capacity = 12;
    assert.throws(() => actual.result(), /evidence/);
    actual.receipt.capacity = 6;
    actual.completed = false;
    assert.throws(() => actual.result(), /evidence/);
  });
  it("rejects creation after closing or after a failed spawn", () => {
    const p = probe();
    call(p, "extra", "spawn_agent", "completed", ["extra"]);
    assert.throws(() => p.result(), /boundary/);
  });
  it("rejects nested agents and non-probe tools", () => {
    const p = probe();
    p.accept({ type: "item.completed", item: { id: "nested", type: "collab_tool_call",
      tool: "spawn_agent", status: "completed", sender_thread_id: "child1", receiver_thread_ids: ["grandchild"] } });
    assert.throws(() => p.result(), /nested/);
    const q = probe();
    q.accept({ type: "item.completed", item: { id: "shell", type: "command_execution" } });
    assert.throws(() => q.result(), /non-probe/);
  });
});

async function withAdapter(code: string, run: (test: NonNullable<ReturnType<typeof discoverAdapters>[number]["testSubagents"]>) => Promise<void>, timeout = 2000) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "baton-capacity-adapter-"));
  const manifest = JSON.parse(fs.readFileSync(new URL("./fixtures/adapters/alpha/adapter.json", import.meta.url), "utf8"));
  // Use a real child process so cancellation/exit handling is exercised.
  manifest.subagent_test = { command: process.execPath, args: ["-e", code], timeout_ms: timeout };
  fs.writeFileSync(path.join(directory, "adapter.json"), JSON.stringify(manifest));
  try {
    const adapter = discoverAdapters({ ...process.env, BATON_ADAPTER_PATHS: directory })[0];
    await run(adapter.testSubagents!);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

describe("adapter capacity test process", () => {
  it("accepts a bounded result from the selected adapter", async () => {
    await withAdapter('console.log(JSON.stringify({adapter_id:"alpha",capacity:6,ceiling_reached:false}))', async (test) => {
      assert.deepEqual(await test(), { capacity: 6, ceiling_reached: false });
    });
  });
  it("rejects foreign, unbounded and contradictory results", async () => {
    for (const result of [
      { adapter_id: "beta", capacity: 6, ceiling_reached: false },
      { adapter_id: "alpha", capacity: 21, ceiling_reached: true },
      { adapter_id: "alpha", capacity: 6, ceiling_reached: true },
    ]) {
      await withAdapter(`console.log(${JSON.stringify(JSON.stringify(result))})`, async (test) => {
        await assert.rejects(test(), /SUBAGENT_TEST_INVALID/);
      });
    }
  });
  it("bounds a hung adapter and honours abort", async () => {
    await withAdapter("setInterval(()=>{},1000)", async (test) => {
      await assert.rejects(test(), /SUBAGENT_TEST_TIMEOUT/);
    }, 100);
    await withAdapter("setInterval(()=>{},1000)", async (test) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 100);
      try { await assert.rejects(test({ signal: controller.signal }), /SUBAGENT_TEST_CANCELLED/); }
      finally { clearTimeout(timer); }
    });
  });
});
