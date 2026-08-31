import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { run } from "../src/cli.js";
import { configureCli } from "./configure.js";
import { fakeEnv } from "./home.js";
import { getCliAdapter } from "../src/adapters/registry.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { markRouteExhausted } from "../src/lib/model-availability.js";
import { listSpawns } from "../src/lib/spawn.js";

function capture() {
  const chunks: string[] = [];
  return { write(value: unknown) { chunks.push(String(value)); return true; }, text() { return chunks.join(""); } };
}

async function command(argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string; compiledApplyHandler?: (input: unknown) => unknown | Promise<unknown> }) {
  const stdout = capture();
  const stderr = capture();
  const code = await run(argv, { ...options, stdout, stderr });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

function gitRepo(cwd: string): string {
  execFileSync("git", ["init"], { cwd });
  execFileSync("git", ["config", "user.email", "baton@test"], { cwd });
  execFileSync("git", ["config", "user.name", "Baton Test"], { cwd });
  fs.writeFileSync(path.join(cwd, "README.md"), "compiled cli test\n");
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-m", "initial"], { cwd });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

async function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-compiled-cli-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-compiled-cli-home-"));
  const env = fakeEnv(home, { BATON_SESSION_ID: `compiled-cli-${Date.now()}-${Math.random()}` });
  const revision = gitRepo(cwd);
  const changeDir = path.join(cwd, "openspec", "changes", "demo");
  fs.mkdirSync(changeDir, { recursive: true });
  const tasksPath = path.join(changeDir, "tasks.md");
  const proposalPath = path.join(changeDir, "proposal.md");
  fs.writeFileSync(tasksPath, "# Demo\n\n## Build\n\n- [ ] 1.1 implement the demo\n");
  fs.writeFileSync(proposalPath, "# Demo proposal\n");
  const payload = JSON.stringify({
    changeName: "demo",
    changeDir,
    schemaName: "spec-driven",
    contextFiles: { proposal: [proposalPath], tasks: [tasksPath] },
    instruction: "Continue with the pending tasks.",
    context: "test context",
    tasks: [{ id: "1", description: "1.1 implement the demo", done: false }],
  }).replaceAll("'", "'\"'\"'");
  const openspecBin = fs.mkdtempSync(path.join(os.tmpdir(), "baton-fake-openspec-"));
  const openspec = path.join(openspecBin, "openspec");
  fs.writeFileSync(openspec, `#!/bin/sh\nprintf '%s' '${payload}'\n`, { mode: 0o755 });
  fs.chmodSync(openspec, 0o755);
  env.PATH = `${openspecBin}${path.delimiter}${env.PATH || process.env.PATH || ""}`;

  const catalog = await getCliAdapter("alpha", env).discoverModels({ env });
  const model = catalog.models[0]?.id;
  if (!model) throw new Error("fixture adapter did not expose a model");
  configureCli(cwd, env, "alpha", [model]);
  publishRouteSnapshot(cwd, { models: catalog.models }, new Date(), { cli: "alpha", host: "alpha", env });

  const plan = {
    schema_version: 1 as const,
    identity: { plan_id: "run-cli", change_id: "demo" },
    source_snapshot: { repo_root: cwd, revision, tasks_path: tasksPath },
    selected_tasks: ["1.1"],
    units: [{ id: "unit-1", mode: "verification-only" as const, task_ids: ["1.1"], description: "verify demo", prompt: "verify demo", verification: ["read"] }],
  };
  return { cwd, env, tasksPath, plan, model, models: catalog.models };
}

describe("compiled apply CLI", () => {
  it("accepts a file/stdin initial plan, reports JSON/human status, and appends a successor", async () => {
    const f = await fixture();
    const file = path.join(f.cwd, "plan.json");
    fs.writeFileSync(file, JSON.stringify(f.plan));
    const initial = await command(["apply", "demo", "--host", "alpha", "--plan-file", file, "--dispatch", "--json"], f);
    assert.equal(initial.code, 0, initial.stderr || initial.stdout);
    const first = JSON.parse(initial.stdout);
    assert.equal(first.code, "COMPILED_APPLY_INITIAL_PERSISTED");
    assert.equal(first.run_id, "run-cli");
    assert.equal(first.revision, "1");

    const status = await command(["apply", "demo", "--host", "alpha", "--run", "run-cli", "--status", "--json"], f);
    assert.equal(status.code, 0, status.stderr || status.stdout);
    const report = JSON.parse(status.stdout);
    assert.equal(report.code, "COMPILED_APPLY_STATUS");
    assert.equal(report.source.valid, true);
    assert.deepEqual(report.safe_frontier_candidates, []);
    assert.equal(report.unit_lifecycle["unit-1"].status, "materialized");
    assert.equal(Array.isArray(report.model_routing[0].candidates), true);

    const human = await command(["apply", "demo", "--host", "alpha", "--run", "run-cli", "--status"], f);
    assert.equal(human.code, 0, human.stderr || human.stdout);
    assert.match(human.stdout, /compiled apply run-cli/);
    assert.match(human.stdout, /models unit-1:/);

    const successor = { ...f.plan, revision_lineage: { base: f.plan.source_snapshot.revision, parent: "1" } };
    const next = await command(["apply", "demo", "--host", "alpha", "--run", "run-cli", "--plan-file", "-", "--json"], { ...f, stdin: JSON.stringify(successor) });
    assert.equal(next.code, 0, next.stderr || next.stdout);
    const second = JSON.parse(next.stdout);
    assert.equal(second.code, "COMPILED_APPLY_SUCCESSOR_PERSISTED");
    assert.equal(second.revision, "2");
    assert.equal(second.parent.revision, "1");
  });

  it("reports a later source change against the frozen source identity", async () => {
    const f = await fixture();
    const initial = await command(["apply", "demo", "--host", "alpha", "--plan-file", "-", "--json"], { ...f, stdin: JSON.stringify(f.plan) });
    assert.equal(initial.code, 0, initial.stderr || initial.stdout);
    fs.appendFileSync(path.join(f.cwd, "openspec", "changes", "demo", "proposal.md"), "changed\n");
    const status = await command(["apply", "demo", "--host", "alpha", "--run", "run-cli", "--status", "--json"], f);
    assert.equal(status.code, 0, status.stderr || status.stdout);
    const report = JSON.parse(status.stdout);
    assert.equal(report.source.valid, false);
    assert.ok(report.source.differences.includes("fingerprint"));
  });

  it("resolves a relative task ledger against the invocation cwd", async () => {
    const f = await fixture();
    const relative = { ...f.plan, source_snapshot: { ...f.plan.source_snapshot, tasks_path: "openspec/changes/demo/tasks.md" } };
    const initial = await command(["apply", "demo", "--host", "alpha", "--plan-file", "-", "--json"], { ...f, stdin: JSON.stringify(relative) });
    assert.equal(initial.code, 0, initial.stderr || initial.stdout);
    const status = await command(["apply", "demo", "--host", "alpha", "--run", "run-cli", "--status", "--json"], f);
    assert.equal(status.code, 0, status.stderr || status.stdout);
    assert.equal(JSON.parse(status.stdout).source.valid, true);
  });

  it("keeps the injected handler boundary intact", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-compiled-injected-"));
    const env = fakeEnv(fs.mkdtempSync(path.join(os.tmpdir(), "baton-compiled-injected-home-")), { BATON_SESSION_ID: "compiled-injected" });
    let received: unknown;
    const result = await command(["apply", "demo", "--host", "alpha", "--plan-file", "-", "--json"], {
      cwd,
      env,
      stdin: "{\"injected\":true}",
      // run() preserves this exact handler rather than resolving OpenSpec.
      compiledApplyHandler: async (input) => { received = input; return { injected: true }; },
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), { injected: true });
    assert.equal((received as { plan?: string }).plan, "{\"injected\":true}");
  });

  it("accepts a parent gate and reconciles only through the explicit reconcile path", async () => {
    const f = await fixture();
    const gatePlan = {
      ...f.plan,
      identity: { plan_id: "run-gate", change_id: "demo" },
      units: [],
      parent_gates: [{ id: "gate-1", task_ids: ["1.1"] }],
    };
    const initial = await command(["apply", "demo", "--host", "alpha", "--plan-file", "-", "--json"], { ...f, stdin: JSON.stringify(gatePlan) });
    assert.equal(initial.code, 0, initial.stderr || initial.stdout);
    const accepted = await command(["apply", "demo", "--host", "alpha", "--run", "run-gate", "--accept-gate", "gate-1", "--text", "parent verification\u0000", "--json"], f);
    assert.equal(accepted.code, 0, accepted.stderr || accepted.stdout);
    const gate = JSON.parse(accepted.stdout);
    assert.equal(gate.code, "COMPILED_APPLY_GATE_ACCEPTED");
    assert.equal(gate.gate.evidence, "parent verification");
    assert.match(fs.readFileSync(f.tasksPath, "utf8"), /- \[ \] 1\.1/);

    const reconciled = await command(["apply", "demo", "--host", "alpha", "--run", "run-gate", "--reconcile", "--task", "1.1", "--json"], f);
    assert.equal(reconciled.code, 0, reconciled.stderr || reconciled.stdout);
    const body = JSON.parse(reconciled.stdout);
    assert.equal(body.code, "COMPILED_APPLY_RECONCILED");
    assert.deepEqual(body.task_ids, ["1.1"]);
    assert.equal(body.eligibility[0].eligible, true);
    assert.match(fs.readFileSync(f.tasksPath, "utf8"), /- \[x\] 1\.1/);
  });

  it("keeps a unit visible with every configured-route exclusion when no route qualifies", async () => {
    const f = await fixture();
    configureCli(f.cwd, f.env, "alpha", ["alpha/not-in-the-catalog"]);
    const result = await command(["apply", "demo", "--host", "alpha", "--plan-file", "-", "--dispatch", "--json"], { ...f, stdin: JSON.stringify(f.plan) });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const body = JSON.parse(result.stdout);
    assert.equal(body.frontier.code, "COMPILED_APPLY_FRONTIER_EMPTY");
    assert.deepEqual(body.frontier.selected, []);
    assert.equal(body.frontier.blocked.length, 1);
    assert.equal(body.frontier.blocked[0].exclusion_matrix.exclusions[0].model_id, "alpha/not-in-the-catalog");
    assert.equal(body.frontier.blocked[0].exclusion_matrix.exclusions[0].codes[0], "ROUTE_ABSENT_FROM_ACTIVE_CATALOG");
  });

  it("uses session-local exhaustion to progress to a later configured route and resets it for a new session", async () => {
    const f = await fixture();
    const spark = {
      id: "alpha/spark",
      route_id: "alpha/spark",
      provider: "alpha",
      description: "spark fixture",
      reasoning_efforts: [{ id: "high" }],
      default_reasoning_effort: "high",
      native: true,
    };
    publishRouteSnapshot(f.cwd, { models: [...f.models, spark] }, new Date(), { cli: "alpha", host: "alpha", env: f.env });
    configureCli(f.cwd, f.env, "alpha", ["alpha/spark", f.model]);
    markRouteExhausted(f.cwd, { host: "alpha", routeId: "alpha/spark" }, { env: f.env, resetAt: new Date(Date.now() + 60_000).toISOString() });
    const first = await command(["apply", "demo", "--host", "alpha", "--plan-file", "-", "--dispatch", "--json"], { ...f, stdin: JSON.stringify(f.plan) });
    assert.equal(first.code, 0, first.stderr || first.stdout);
    const firstBody = JSON.parse(first.stdout);
    assert.deepEqual(firstBody.frontier.selected, ["unit-1"]);
    assert.match(firstBody.frontier.materialized[0].model_id, new RegExp(`^${f.model.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`));
    assert.equal(firstBody.frontier.materialized[0].route_id, f.model);

    const newEnv = { ...f.env, BATON_SESSION_ID: `${f.env.BATON_SESSION_ID}-new` };
    const newPlan = { ...f.plan, identity: { plan_id: "run-new-session", change_id: "demo" } };
    const second = await command(["apply", "demo", "--host", "alpha", "--plan-file", "-", "--dispatch", "--json"], { cwd: f.cwd, env: newEnv, stdin: JSON.stringify(newPlan) });
    assert.equal(second.code, 0, second.stderr || second.stdout);
    const secondBody = JSON.parse(second.stdout);
    assert.equal(secondBody.frontier.materialized[0].route_id, "alpha/spark");
    const sessionTickets = listSpawns(f.cwd, newEnv).filter((ticket) => ticket.session_uid === secondBody.session_uid);
    assert.equal(sessionTickets.length, 1);
  });
});
