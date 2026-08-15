import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";

function capture() {
  const chunks = [];
  return {
    chunks,
    write(s) {
      chunks.push(String(s));
    },
    text() {
      return chunks.join("");
    },
  };
}

describe("cli run()", () => {
  it("init + match + spawn in a temp cwd; no-match is blocked", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-"));
    const out = capture();
    const err = capture();

    const initCode = await run(["init", "--tools", "claude,grok"], { cwd, stdout: out, stderr: err });
    assert.equal(initCode, 0);
    assert.ok(fs.existsSync(path.join(cwd, ".baton", "config.toml")));
    assert.ok(fs.existsSync(path.join(cwd, ".claude/skills/baton/SKILL.md")));
    assert.ok(fs.existsSync(path.join(cwd, ".grok/skills/baton/SKILL.md")));

    const hitOut = capture();
    const hit = await run(["match", "code completion routine feature development"], { cwd, stdout: hitOut, stderr: capture() });
    assert.equal(hit, 0);
    assert.match(hitOut.text(), /kimi-for-coding/);

    const missOut = capture();
    const miss = await run(["match", "paint the barn purple"], { cwd, stdout: missOut, stderr: capture() });
    assert.equal(miss, 1);
    assert.match(missOut.text(), /blocked:/);

    const spawnOut = capture();
    const spawned = await run(["spawn", "code completion routine feature development"], { cwd, stdout: spawnOut, stderr: capture() });
    assert.equal(spawned, 0);
    assert.match(spawnOut.text(), /spawn spn-0001/);
    assert.match(spawnOut.text(), /kimi-for-coding/);
    assert.ok(fs.existsSync(path.join(cwd, ".baton", "spawns", "spn-0001.json")));
  });
});
