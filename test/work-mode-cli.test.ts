import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { getCliAdapter } from "../src/adapters/registry.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { withHome, fakeEnv } from "./home.js";
import { configureCli } from "./configure.js";

it("explicit low-effort migration reaches the ticket without a runner or keyword context gate", async () => {
  await withHome(async (home) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-mode-cli-"));
    try {
      const env = fakeEnv(home);
      const catalog = await getCliAdapter("alpha", env).discoverModels({ env });
      configureCli(cwd, env, "alpha", ["alpha-model"]);
      publishRouteSnapshot(cwd, { models: catalog.models }, new Date(), { cli: "alpha", host: "alpha" });
      const output: string[] = [], errors: string[] = [];
      const code = await run(["spawn", "cross-module migration with known steps", "--host", "alpha", "--work-mode", "execution", "--model", "alpha-model", "--effort", "low", "--json"], {
        cwd, env, stdout: { write: (s) => { output.push(String(s)); return true; } }, stderr: { write: (s) => { errors.push(String(s)); return true; } },
      });
      assert.equal(code, 0, errors.join(""));
      const body = JSON.parse(output.join(""));
      assert.equal(body.tickets.length, 1);
      assert.equal(body.tickets[0].reasoning_effort, "low");
      assert.equal(body.tickets[0].routing_requirements.estimated_context_tokens, 0);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
});
