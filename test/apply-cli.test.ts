import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { spawnsDir } from "../src/lib/paths.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { withHome, fakeEnv } from "./home.js";
import { configureCodex } from "./configure.js";

function capture() {
  const chunks: string[] = [];
  return { write(value: unknown) { chunks.push(String(value)); return true; }, text() { return chunks.join(""); } };
}

async function command(argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  const stdout = capture();
  const stderr = capture();
  const code = await run(argv, { ...options, stdout, stderr });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe("baton apply waves", () => {
  it("reserves only the ready disjoint-path wave and leaves tasks.md text unchanged", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-apply-cli-"));
      const env = fakeEnv(home);
      assert.equal((await command(["init"], { cwd, env })).code, 0);
      configureCodex(cwd, env, ["kimi/k3[1m]"]);
      publishRouteSnapshot(cwd, { models: [{ id: "k3[1m]", provider: "kimi" }] }, new Date(), { cli: "codex", host: "codex" });
      const changeDir = path.join(cwd, "openspec", "changes", "wave-demo");
      fs.mkdirSync(changeDir, { recursive: true });
      const tasksPath = path.join(changeDir, "tasks.md");
      const original = `# Wave demo

## 1. Config schema

- [ ] 1.1 implement src/lib/config.ts types
- [ ] 1.2 implement src/lib/hosts.ts detection

## 2. Host resolution

- [ ] 2.1 implement src/cli.ts help
`;
      fs.writeFileSync(tasksPath, original);
      const result = await command(["apply", "wave-demo", "--host", "codex", "--dispatch", "--json", "--capacity", "4"], { cwd, env });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      const body = JSON.parse(result.stdout);
      assert.deepEqual(body.ready_wave.task_ids, ["1.1", "1.2"]);
      assert.equal(body.ready_wave.parallel, true);
      assert.deepEqual(body.waves[1].task_ids, ["2.1"]);
      const ticketFiles = fs.readdirSync(spawnsDir(cwd)).filter((name) => name.endsWith(".json"));
      assert.equal(ticketFiles.length, 2);
      assert.equal(body.reserved.length, 2);
      assert.equal(fs.readFileSync(tasksPath, "utf8"), original);
    });
  });
});
