import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

it("runs the isolated native-parameter walkthrough without a paid worker", () => {
  const output = execFileSync("bun", ["samples/getting-started/walkthrough.mjs"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
  });
  assert.match(output, /native-only walkthrough ok \(simulated host; no worker executed\)/);
});
