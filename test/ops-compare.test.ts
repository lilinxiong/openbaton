import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import type { CliId } from "../src/adapters/contract.js";
import { withHome, fakeEnv } from "./home.js";
import { configureCli } from "./configure.js";
import {
  COMPARE_UNITS,
  createFixtureWorkspace,
  runMechanicalCompare,
} from "../scripts/compare-mechanical-ops.ts";

function capture() {
  const chunks: string[] = [];
  return { write(value: unknown) { chunks.push(String(value)); return true; }, text() { return chunks.join(""); } };
}

const CLI_MODELS: Record<CliId, { runner: string; longctx: string; models: string[] }> = {
  grok: { runner: "grok-4.5", longctx: "grok-4.5", models: ["grok-4.5", "grok-4.6"] },
  codex: { runner: "gpt-5.4-mini", longctx: "gpt-5.5", models: ["gpt-5.4-mini", "gpt-5.5"] },
};

async function prepare(home: string, cli: CliId, labels: { runner: string; longctx: string }) {
  const env = fakeEnv(home, { BATON_HOST: cli });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `baton-compare-${cli}-`));
  assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
  const models = CLI_MODELS[cli];
  publishRouteSnapshot(cwd, { models: models.models.map((id) => ({ id })) }, new Date(), { cli, host: cli });
  configureCli(cwd, env, cli, models.models, { runner: labels.runner, longctx: labels.longctx, enabled: true });
  return { cwd, env, workspace: createFixtureWorkspace() };
}

function byKey(report: Awaited<ReturnType<typeof runMechanicalCompare>>) {
  return new Map(report.tasks.map((task) => [task.key, task]));
}

describe("mechanical ops baton vs direct comparison", () => {
  it("covers the same units used by the live coverage run", () => {
    assert.deepEqual(COMPARE_UNITS.map((unit) => unit.key), [
      "test", "build", "typecheck", "search", "summarize", "ordinary", "commit",
    ]);
  });

  for (const cli of ["grok", "codex"] as const) {
    it(`runs each unit through Baton and directly on ${cli}`, async () => {
      await withHome(async (home) => {
        const models = CLI_MODELS[cli];
        const { env, workspace } = await prepare(home, cli, models);
        const report = await runMechanicalCompare({ cwd: workspace, env, mode: "fixture", workspace });
        assert.equal(report.ok, true, JSON.stringify(report.tasks, null, 2));
        assert.equal(report.cli, cli);
        assert.equal(report.host, cli);
        const tasks = byKey(report);

        assert.equal(tasks.get("test")?.baton.kind, "ops-dispatch");
        assert.equal(tasks.get("test")?.baton.profile, "runner");
        assert.equal(tasks.get("test")?.baton.model, models.runner);
        assert.equal(tasks.get("build")?.baton.operation, "build");
        assert.equal(tasks.get("typecheck")?.baton.operation, "typecheck");
        assert.equal(tasks.get("search")?.baton.profile, "longctx");
        assert.equal(tasks.get("summarize")?.baton.operation, "summarize");
        assert.equal(tasks.get("ordinary")?.baton.kind, "subagent");
        assert.ok(models.models.includes(tasks.get("ordinary")?.baton.model || ""));
        assert.equal(tasks.get("commit")?.baton.kind, "ops-dispatch");
        assert.equal(tasks.get("commit")?.baton.operation, "git-commit");
        assert.equal(tasks.get("commit")?.baton.profile, "runner");
        assert.equal(tasks.get("commit")?.baton.model, models.runner);
        assert.equal(tasks.get("commit")?.direct.exit, 0);
        assert.equal(tasks.get("commit")?.baton.exit, 0);
        assert.ok(tasks.get("test")?.direct.exit === 0);
        assert.ok((tasks.get("test")?.baton.ticket_id || "").startsWith("spn-"));
        assert.ok((tasks.get("test")?.overhead_ms ?? -1) >= 0);
      });
    });
  }

  it("fails closed when classified mechanical routes are empty", async () => {
    await withHome(async (home) => {
      const { env, workspace } = await prepare(home, "grok", { runner: "", longctx: "" });
      await assert.rejects(
        () => runMechanicalCompare({ cwd: workspace, env, mode: "fixture", workspace }),
        /OPS_ROUTE_UNAVAILABLE: test: ops runner route is empty; classified work is not executable on the director/,
      );
    });
  });
});
