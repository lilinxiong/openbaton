import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";

function capture() {
  const chunks = [];
  return { write(value) { chunks.push(String(value)); }, text() { return chunks.join(""); } };
}

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-aa-cli-"));
  const keyFile = path.join(cwd, "aa.key");
  const mappings = path.join(cwd, "mappings.json");
  fs.writeFileSync(keyFile, "test-secret-key", { mode: 0o600 });
  fs.writeFileSync(mappings, JSON.stringify({ mappings: [{ routeId: "kimi/k3", aaSlug: "kimi-k3" }] }));
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      tier: "free",
      intelligence_index_version: 4.1,
      pagination: { page: 1, has_more: false },
      data: [{
        id: "aa-k3",
        slug: "kimi-k3",
        name: "Kimi K3 (max)",
        release_date: "2026-07-16",
        model_creator: { id: "kimi", name: "Kimi" },
        evaluations: {
          artificial_analysis_intelligence_index: 59.7,
          artificial_analysis_coding_index: 76.2,
          artificial_analysis_agentic_index: 54.3,
        },
        pricing: {},
        performance: {},
        artificial_analysis_intelligence_index_cost: {},
      }],
    }),
  });
  return { cwd, keyFile, mappings, fetchImpl };
}

describe("capabilities CLI", () => {
  it("refreshes an ignored local SQLite snapshot and queries an exact route", async () => {
    const { cwd, keyFile, mappings, fetchImpl } = fixture();
    const out = capture();
    const err = capture();
    const refresh = await run([
      "capabilities", "refresh", "--provider", "aa", "--key-file", keyFile,
      "--mappings", mappings, "--json",
    ], { cwd, stdout: out, stderr: err, fetchImpl, env: {} });
    assert.equal(refresh, 0, err.text());
    const summary = JSON.parse(out.text());
    assert.equal(summary.tier, "free");
    assert.equal(summary.modelCount, 1);
    assert.equal(summary.mappingCount, 1);
    assert.ok(fs.existsSync(summary.dbPath));
    assert.ok(fs.existsSync(summary.manifestPath));
    assert.doesNotMatch(out.text(), /test-secret-key/);

    const showOut = capture();
    const show = await run(["capabilities", "show", "kimi/k3", "--json"], {
      cwd, stdout: showOut, stderr: capture(), env: {}, fetchImpl,
    });
    assert.equal(show, 0);
    const capability = JSON.parse(showOut.text());
    assert.equal(capability.ranked, true);
    assert.equal(capability.model.coding_index, 76.2);
  });

  it("rejects a group-readable key file before making a request", async () => {
    const { cwd, keyFile, mappings } = fixture();
    fs.chmodSync(keyFile, 0o644);
    let called = false;
    const stderr = capture();
    const code = await run([
      "capabilities", "refresh", "--key-file", keyFile, "--mappings", mappings,
    ], {
      cwd,
      stdout: capture(),
      stderr,
      env: {},
      fetchImpl: async () => { called = true; throw new Error("must not run"); },
    });
    assert.equal(code, 1);
    assert.equal(called, false);
    assert.match(stderr.text(), /0600/);
    assert.doesNotMatch(stderr.text(), /test-secret-key/);
  });
});
