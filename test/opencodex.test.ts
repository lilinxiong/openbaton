import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.js";
import {
  OCX_PACKAGE,
  engineMissingMessage,
  resolveOcx,
  runOcx,
} from "../src/lib/opencodex.js";

const FAKE_OCX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-ocx.sh");

function capture() {
  const chunks: string[] = [];
  return {
    write(value: unknown) { chunks.push(String(value)); },
    text() { return chunks.join(""); },
  };
}

describe("OpenCodex route-catalog command adapter", () => {
  it("resolves PATH, bundled runtime, then bunx", () => {
    const order: string[] = [];
    const pathHit = resolveOcx({
      env: {},
      findOnPath: () => { order.push("path"); return "/usr/bin/ocx"; },
      findBundled: () => { order.push("bundled"); return "/pkg/node_modules/.bin/ocx"; },
      bunxAvailable: () => { order.push("bunx"); return true; },
    });
    assert.equal(pathHit?.source, "path");
    assert.deepEqual(order, ["path"]);

    order.length = 0;
    const bundled = resolveOcx({
      env: {},
      findOnPath: () => { order.push("path"); return null; },
      findBundled: () => { order.push("bundled"); return "/pkg/node_modules/.bin/ocx"; },
      bunxAvailable: () => { order.push("bunx"); return true; },
    });
    assert.equal(bundled?.source, "bundled");
    assert.deepEqual(order, ["path", "bundled"]);

    order.length = 0;
    const viaBunx = resolveOcx({
      env: {},
      findOnPath: () => { order.push("path"); return null; },
      findBundled: () => { order.push("bundled"); return null; },
      bunxAvailable: () => { order.push("bunx"); return true; },
    });
    assert.equal(viaBunx?.source, "bunx");
    assert.deepEqual(viaBunx?.prefixArgs, ["--bun", OCX_PACKAGE]);
    assert.deepEqual(order, ["path", "bundled", "bunx"]);
  });

  it("finds the OpenCodex submodule before node_modules", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "baton-submod-"));
    const subBin = path.join(root, "opencodex", "bin");
    fs.mkdirSync(subBin, { recursive: true });
    const submodule = path.join(subBin, "ocx.mjs");
    fs.copyFileSync(FAKE_OCX, submodule);
    const npmBinDir = path.join(root, "node_modules", ".bin");
    fs.mkdirSync(npmBinDir, { recursive: true });
    fs.copyFileSync(FAKE_OCX, path.join(npmBinDir, "ocx"));
    const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "baton-empty-path-"));

    const hit = resolveOcx({
      env: { ...process.env, PATH: emptyPath },
      packageRoot: root,
      bunxAvailable: () => false,
    });
    assert.equal(hit?.source, "bundled");
    assert.equal(hit?.command, submodule);
  });

  it("forwards only the requested OpenCodex command shape", () => {
    const calls: string[][] = [];
    const result = runOcx(["models", "live", "--json"], {
      env: {},
      resolved: { source: "path", command: "/tmp/ocx", prefixArgs: [] },
      runner: ({ args }) => {
        calls.push(args.slice());
        return { status: 0, stdout: "[]\n", stderr: "", error: null };
      },
    });
    assert.equal(result.status, 0);
    assert.deepEqual(calls, [["models", "live", "--json"]]);
  });

  it("fails clearly when the OpenCodex catalog runtime is unavailable", () => {
    assert.throws(
      () => runOcx(["models", "live", "--json"], { resolve: () => null, env: {} }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { code?: string }).code, "OCX_MISSING");
        assert.equal(error.message, engineMissingMessage());
        assert.doesNotMatch(error.message, /login/i);
        return true;
      },
    );
  });

  it("exposes only the Codex host and no Baton login/alias surface", async () => {
    const out = capture();
    assert.equal(await run(["help"], { cwd: os.tmpdir(), stdout: out, stderr: capture() }), 0);
    assert.doesNotMatch(out.text(), /^\s*baton login\b|--tools|cards add/im);
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    for (const rel of ["SKILL.md", "README.md", "README.zh.md"]) {
      const text = fs.readFileSync(path.join(root, rel), "utf8");
      assert.doesNotMatch(text, /^\s*baton login\b|cards add|Claude Code, Cursor|Grok and Codex init|Grok \/ Codex.*init/im);
    }
  });
});
