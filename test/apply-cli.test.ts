import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { receiptsDir, spawnsDir } from "../src/lib/paths.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { getCliAdapter } from "../src/adapters/registry.js";
import { withHome, fakeEnv, testTicketId } from "./home.js";
import { configureCli } from "./configure.js";
import { parseDispatchReservationEnvelope } from "../src/lib/dispatch-reservation.js";

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

function gitRepo(cwd: string): void {
  execFileSync("git", ["init"], { cwd });
  execFileSync("git", ["config", "user.email", "baton@test"], { cwd });
  execFileSync("git", ["config", "user.name", "Baton Test"], { cwd });
  fs.writeFileSync(path.join(cwd, "README.md"), "demo\n");
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-m", "init"], { cwd });
}

async function configureManifestHost(cwd: string, env: NodeJS.ProcessEnv, host: "alpha" | "beta"): Promise<void> {
  const catalog = await getCliAdapter(host, env).discoverModels({ env });
  const model = catalog.models[0]?.id;
  if (!model) throw new Error(`${host} manifest catalog returned no models`);
  configureCli(cwd, env, host, [model]);
  publishRouteSnapshot(cwd, { models: catalog.models }, new Date(), { cli: host, host });
}

describe("baton apply orchestration", () => {
  it("plans without tickets; scoped dispatch writes only director paths", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-apply-cli-"));
      const env = fakeEnv(home);
      assert.equal((await command(["init"], { cwd, env })).code, 0);
      gitRepo(cwd);
      await configureManifestHost(cwd, env, "alpha");
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

      const planned = await command(["apply", "wave-demo", "--host", "alpha", "--json"], { cwd, env });
      assert.equal(planned.code, 0, planned.stderr || planned.stdout);
      const plan = JSON.parse(planned.stdout);
      assert.deepEqual(plan.pending_tasks, ["1.1", "1.2", "2.1"]);
      assert.equal(fs.existsSync(spawnsDir(cwd)), false);

      const unscoped = await command(["apply", "wave-demo", "--host", "alpha", "--dispatch", "--json"], { cwd, env });
      assert.equal(unscoped.code, 1);
      assert.match(unscoped.stderr, /TASK_SCOPE_REQUIRED/);
      assert.equal(fs.existsSync(spawnsDir(cwd)), false);

      const result = await command([
        "apply", "wave-demo", "--host", "alpha", "--dispatch", "--json", "--capacity", "4",
        "--unit", "1.1", "--write-path", "src/lib/config.ts", "--write-ops", "write,delete",
        "--unit", "1.2", "--write-path", "src/lib/hosts.ts", "--write-ops", "create",
      ], { cwd, env });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      const body = JSON.parse(result.stdout);
      assert.deepEqual(body.pending_tasks, ["1.1", "1.2", "2.1"]);
      const ticketFiles = fs.readdirSync(spawnsDir(cwd)).filter((name) => name.endsWith(".json"));
      assert.equal(ticketFiles.length, 2);
      assert.equal(body.reserved.length, 2);
      // Apply's queue/planning path must consume the deliberately breaking
      // tree-local dispatch snapshot contract, never a workspace max field.
      assert.equal(body.snapshot.scope, undefined);
      assert.equal(body.snapshot.host, "alpha");
      assert.equal(typeof body.snapshot.session_uid, "string");
      assert.equal(Array.isArray(body.snapshot.capacity_sources), true);
      assert.equal(typeof body.snapshot.active, "number");
      assert.equal(typeof body.snapshot.available, "number");
      assert.equal(Object.hasOwn(body.snapshot, "max_concurrent"), false);
      assert.equal(Object.hasOwn(body.snapshot, "planning_max_concurrent"), false);
      assert.deepEqual(body.reserved.map((item: { ticket_id: string }) => item.ticket_id), [testTicketId("os", 1), testTicketId("os", 2)]);
      for (const reserved of body.reserved) {
        assert.deepEqual(parseDispatchReservationEnvelope(reserved.prompt), reserved.reservation);
        assert.deepEqual(parseDispatchReservationEnvelope(reserved.description), reserved.reservation);
      }
      assert.equal(fs.readFileSync(tasksPath, "utf8"), original);
      for (const name of ticketFiles) {
        const ticket = JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), name), "utf8"));
        assert.equal(ticket.mode, "write");
        assert.equal(ticket.read_only, false);
        assert.equal(ticket.work_unit.kind, "concrete");
        assert.equal(typeof ticket.routing_requirements?.required_reasoning_effort, "string");
        assert.equal(typeof ticket.routing_requirements?.estimated_context_tokens, "number");
        const receipt = JSON.parse(fs.readFileSync(path.join(receiptsDir(cwd), `${ticket.receipt_id}.json`), "utf8"));
        assert.equal(receipt.execution.mode, "write");
        assert.ok(receipt.scope.write_allowlist.length);
        assert.equal(receipt.baseline.index_control_algorithm, "git-index-control-framed-sha256-v2");
        assert.equal(typeof receipt.baseline.index_control_entry_count, "number");
      }
      assert.deepEqual(body.tickets.map((ticket: { receipt_id: string }) => JSON.parse(
        fs.readFileSync(path.join(receiptsDir(cwd), `${ticket.receipt_id}.json`), "utf8"),
      ).scope.allowed_operations), [["write", "delete"], ["create"]]);
    });
  });

  it("dispatches Unify tasks as write when the director supplies paths", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-apply-unify-"));
      const env = fakeEnv(home);
      assert.equal((await command(["init"], { cwd, env })).code, 0);
      gitRepo(cwd);
      await configureManifestHost(cwd, env, "alpha");
      const changeDir = path.join(cwd, "openspec", "changes", "unify-demo");
      fs.mkdirSync(changeDir, { recursive: true });
      fs.writeFileSync(path.join(changeDir, "tasks.md"), `# Unify

## 1. Shared adapter dispatch

- [ ] 1.1 Unify adapter dispatch on ticket presence
`);
      const result = await command([
        "apply", "unify-demo", "--host", "alpha", "--dispatch", "--json",
        "--unit", "1.1", "--write-path", "src/lib/adapter-dispatch.ts",
      ], { cwd, env });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      const body = JSON.parse(result.stdout);
      assert.equal(body.tickets[0].work_unit.kind, "concrete");
      assert.equal(body.tickets[0].mode, "write");
      const receipt = JSON.parse(fs.readFileSync(path.join(receiptsDir(cwd), `${body.tickets[0].receipt_id}.json`), "utf8"));
      assert.deepEqual(receipt.scope.write_allowlist, ["src/lib/adapter-dispatch.ts"]);
    });
  });

  it("keeps director --read-only tickets off the write allowlist", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-apply-ro-"));
      const env = fakeEnv(home);
      assert.equal((await command(["init"], { cwd, env })).code, 0);
      await configureManifestHost(cwd, env, "alpha");
      const changeDir = path.join(cwd, "openspec", "changes", "ro-demo");
      fs.mkdirSync(changeDir, { recursive: true });
      fs.writeFileSync(path.join(changeDir, "tasks.md"), `# Ro

## 1. Inspect

- [ ] 1.1 review src/lib/adapter-dispatch.ts
`);
      const result = await command([
        "apply", "ro-demo", "--host", "alpha", "--dispatch", "--json",
        "--unit", "1.1", "--read-only",
      ], { cwd, env });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      const body = JSON.parse(result.stdout);
      assert.equal(body.tickets[0].mode, "read-only");
      const receipt = JSON.parse(fs.readFileSync(path.join(receiptsDir(cwd), `${body.tickets[0].receipt_id}.json`), "utf8"));
      assert.deepEqual(receipt.scope.write_allowlist, []);
      assert.deepEqual(receipt.scope.allowed_operations, ["read"]);
    });
  });

  it("lets the director explicitly dispatch a later same-section task", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-apply-order-ready-"));
      const env = fakeEnv(home);
      assert.equal((await command(["init"], { cwd, env })).code, 0);
      gitRepo(cwd);
      await configureManifestHost(cwd, env, "alpha");
      const changeDir = path.join(cwd, "openspec", "changes", "shared-split");
      fs.mkdirSync(changeDir, { recursive: true });
      fs.writeFileSync(path.join(changeDir, "tasks.md"), `# Shared split

## 1. Config

- [ ] 1.1 update the configuration ownership in src/lib/config.ts
- [ ] 1.2 retain route labels in src/lib/config.ts
`);
      const planned = await command(["apply", "shared-split", "--host", "alpha", "--json"], { cwd, env });
      assert.equal(planned.code, 0, planned.stderr || planned.stdout);
      const plan = JSON.parse(planned.stdout);
      assert.deepEqual(plan.pending_tasks, ["1.1", "1.2"]);

      const result = await command([
        "apply", "shared-split", "--host", "alpha", "--dispatch", "--json",
        "--unit", "1.2", "--write-path", "src/lib/hosts.ts",
      ], { cwd, env });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      const body = JSON.parse(result.stdout);
      assert.equal(body.tickets.length, 1);
      const ticketFiles = fs.readdirSync(spawnsDir(cwd)).filter((name) => name.endsWith(".json"));
      assert.equal(ticketFiles.length, 1);
      const ticket = JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), ticketFiles[0]), "utf8"));
      assert.equal(ticket.mode, "write");
      const receipt = JSON.parse(fs.readFileSync(path.join(receiptsDir(cwd), `${ticket.receipt_id}.json`), "utf8"));
      assert.deepEqual(receipt.scope.write_allowlist, ["src/lib/hosts.ts"]);
    });
  });

  it("lets the director explicitly dispatch a later-section task", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-apply-section-order-"));
      const env = fakeEnv(home);
      assert.equal((await command(["init"], { cwd, env })).code, 0);
      gitRepo(cwd);
      await configureManifestHost(cwd, env, "alpha");
      const changeDir = path.join(cwd, "openspec", "changes", "section-order");
      fs.mkdirSync(changeDir, { recursive: true });
      fs.writeFileSync(path.join(changeDir, "tasks.md"), `# Section order

## 1. Config schema

- [ ] 1.1 implement src/lib/config.ts types

## 2. Host resolution

- [ ] 2.1 implement src/cli.ts help
`);
      const result = await command([
        "apply", "section-order", "--host", "alpha", "--dispatch", "--json",
        "--unit", "2.1", "--write-path", "src/cli.ts",
      ], { cwd, env });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      const body = JSON.parse(result.stdout);
      assert.equal(body.tickets.length, 1);
    });
  });

  it("rejects overlapping write decisions before creating any ticket", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-apply-write-conflict-"));
      const env = fakeEnv(home);
      assert.equal((await command(["init"], { cwd, env })).code, 0);
      gitRepo(cwd);
      await configureManifestHost(cwd, env, "alpha");
      const changeDir = path.join(cwd, "openspec", "changes", "write-conflict");
      fs.mkdirSync(changeDir, { recursive: true });
      fs.writeFileSync(path.join(changeDir, "tasks.md"), `# Write conflict

## 1. Config schema

- [ ] 1.1 implement src/lib/config.ts types
- [ ] 1.2 implement src/lib/hosts.ts detection
`);
      const result = await command([
        "apply", "write-conflict", "--host", "alpha", "--dispatch", "--json",
        "--unit", "1.1", "--write-path", "src/lib/config.ts",
        "--unit", "1.2", "--write-path", "src/lib/config.ts",
      ], { cwd, env });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /WRITE_SCOPE_CONFLICT/);
      assert.equal(fs.existsSync(spawnsDir(cwd)), false);
      assert.equal(fs.existsSync(receiptsDir(cwd)), false);
    });
  });

  it("completes two parallel write tickets without treating sibling files as out of scope", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-apply-parallel-complete-"));
      const env = fakeEnv(home);
      assert.equal((await command(["init"], { cwd, env })).code, 0);
      gitRepo(cwd);
      fs.mkdirSync(path.join(cwd, "src", "lib"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "src", "lib", "config.ts"), "config\n");
      fs.writeFileSync(path.join(cwd, "src", "lib", "hosts.ts"), "hosts\n");
      execFileSync("git", ["add", "src/lib/config.ts", "src/lib/hosts.ts"], { cwd });
      execFileSync("git", ["commit", "-m", "paths"], { cwd });
      await configureManifestHost(cwd, env, "alpha");
      const changeDir = path.join(cwd, "openspec", "changes", "parallel-complete");
      fs.mkdirSync(changeDir, { recursive: true });
      fs.writeFileSync(path.join(changeDir, "tasks.md"), `# Parallel complete

## 1. Config schema

- [ ] 1.1 implement src/lib/config.ts types
- [ ] 1.2 implement src/lib/hosts.ts detection
`);
      const result = await command([
        "apply", "parallel-complete", "--host", "alpha", "--dispatch", "--json", "--capacity", "4",
        "--unit", "1.1", "--write-path", "src/lib/config.ts",
        "--unit", "1.2", "--write-path", "src/lib/hosts.ts",
      ], { cwd, env });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      const body = JSON.parse(result.stdout);
      const ids = body.tickets.map((ticket: { id: string }) => ticket.id);
      assert.equal(ids.length, 2);
      assert.equal((await command(["dispatch", "bind", ids[0], "--execution-handle", "alpha-task=apply-a", "--host", "alpha", "--json"], { cwd, env })).code, 0);
      assert.equal((await command(["dispatch", "bind", ids[1], "--execution-handle", "alpha-task=apply-b", "--host", "alpha", "--json"], { cwd, env })).code, 0);
      fs.appendFileSync(path.join(cwd, "src", "lib", "config.ts"), "A\n");
      fs.appendFileSync(path.join(cwd, "src", "lib", "hosts.ts"), "B\n");
      const first = await command(["dispatch", "complete", ids[0], "--host", "alpha", "--text", "unit one done", "--json"], { cwd, env });
      assert.equal(first.code, 0, first.stderr || first.stdout);
      const firstTicket = JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), `${ids[0]}.json`), "utf8"));
      assert.equal(firstTicket.status, "completed", JSON.stringify(firstTicket.error));
      const second = await command(["dispatch", "complete", ids[1], "--host", "alpha", "--text", "unit two done", "--json"], { cwd, env });
      assert.equal(second.code, 0, second.stderr || second.stdout);
      const secondTicket = JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), `${ids[1]}.json`), "utf8"));
      assert.equal(secondTicket.status, "completed", JSON.stringify(secondTicket.error));
    });
  });

});
