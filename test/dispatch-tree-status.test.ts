import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "bun:test";
import { run } from "../src/cli.js";
import { buildReadOnlyReceipt, writeReceipt } from "../src/lib/receipt.js";
import { buildSpawnTicket, nextSpawnId, writeSpawn, type SpawnTicket } from "../src/lib/spawn.js";
import { hostDispatchStatePath, spawnsDir } from "../src/lib/paths.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { configureCli } from "./configure.js";
import { fakeEnv, withHome } from "./home.js";

const HOST = "alpha";
const ROUTE = "alpha/alpha-model";

interface Capture {
  write(value: unknown): boolean;
  text(): string;
}

function capture(): Capture {
  const chunks: string[] = [];
  return {
    write(value: unknown) {
      chunks.push(String(value));
      return true;
    },
    text() {
      return chunks.join("");
    },
  };
}

async function cli(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[],
): Promise<{ code: number; text: string }> {
  const output = capture();
  const code = await run(args, { cwd, env, stdout: output, stderr: output });
  return { code, text: output.text() };
}

function setup(cwd: string, env: NodeJS.ProcessEnv): void {
  configureCli(cwd, env, HOST, [ROUTE]);
  publishRouteSnapshot(cwd, {
    models: [{
      id: "alpha-model",
      route_id: ROUTE,
      provider: HOST,
      reasoning_efforts: ["low"],
      default_reasoning_effort: "low",
    }],
  }, new Date("2026-08-27T00:00:00.000Z"), { cli: HOST, host: HOST, env });
}

function selection() {
  return {
    host: HOST,
    proposal_id: "proposal-dispatch-tree-status",
    approval_id: "approval-dispatch-tree-status",
    approved_at: "2026-08-27T00:00:00.000Z",
    confirmed_by: "baton-recommendation" as const,
    catalog_fingerprint: "dispatch-tree-status-catalog",
    recommended_model_id: ROUTE,
    selected_model_id: ROUTE,
    changed_by_user: false,
  };
}

function ticket(
  cwd: string,
  env: NodeJS.ProcessEnv,
  status: "queued" | "dispatching",
  offset: number,
): SpawnTicket {
  const now = new Date(Date.parse("2026-08-27T00:00:00.000Z") + offset * 1_000).toISOString();
  const id = nextSpawnId(cwd, "spn", env);
  const value = buildSpawnTicket({
    cwd,
    env,
    id,
    description: "dispatch tree status fixture",
    prompt: "dispatch tree status fixture",
    modelId: ROUTE,
    routeId: ROUTE,
    taskKind: "concrete",
    selection: selection(),
    targetHost: HOST,
    now,
  });
  const receipt = buildReadOnlyReceipt({
    ticketId: id,
    card: { id: ROUTE, route_id: ROUTE, provider: HOST, strengths: "fixture" },
    issuedAt: now,
    selection: value.selection,
    host: HOST,
  });
  value.receipt_id = receipt.receipt_id;
  if (status === "dispatching") {
    value.status = status;
    value.dispatch_host = HOST;
    value.dispatch_requested_at = now;
    value.attempt = 1;
    value.reservation_id = `reservation-${id}`;
    value.history.push({ event: "dispatch_reserved", at: now });
  }
  writeReceipt(cwd, receipt, env);
  writeSpawn(cwd, value, env);
  return value;
}

function newWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "baton-dispatch-tree-status-"));
}

describe("source CLI dispatch tree status", () => {
  it("keeps reservation, dispatch status, and grouped JSON/text status consistent", async () => withHome(async (home) => {
    const cwd = newWorkspace();
    const treeA = fakeEnv(home, { BATON_SESSION_ID: "status-tree-a" });
    const treeB = fakeEnv(home, { BATON_SESSION_ID: "status-tree-b" });
    setup(cwd, treeA);
    const activeA = [ticket(cwd, treeA, "dispatching", 0), ticket(cwd, treeA, "dispatching", 1)];
    const queuedB = ticket(cwd, treeB, "queued", 2);

    const reserved = await cli(cwd, treeB, ["dispatch", "next", "--host", HOST, "--json"]);
    assert.equal(reserved.code, 0, reserved.text);
    const reservation = JSON.parse(reserved.text) as {
      reserved: Array<{ ticket_id: string }>;
      snapshot: Record<string, any>;
    };
    assert.deepEqual(reservation.reserved.map((item) => item.ticket_id), [queuedB.id]);
    assert.equal(reservation.snapshot.host, HOST);
    assert.equal(typeof reservation.snapshot.session_uid, "string");
    assert.equal(reservation.snapshot.capacity, 2);
    assert.equal(reservation.snapshot.active, 1);
    assert.equal(reservation.snapshot.available, 1);
    assert.equal(Object.hasOwn(reservation.snapshot, "max_concurrent"), false);
    assert.equal(Object.hasOwn(reservation.snapshot, "planning_max_concurrent"), false);

    const dispatchStatus = await cli(cwd, treeB, ["dispatch", "status", "--host", HOST, "--json"]);
    assert.equal(dispatchStatus.code, 0, dispatchStatus.text);
    const status = JSON.parse(dispatchStatus.text) as Record<string, any>;
    assert.deepEqual(
      {
        host: status.host,
        session_uid: status.session_uid,
        capacity: status.capacity,
        capacity_sources: status.capacity_sources,
        active: status.active,
        available: status.available,
        queued: status.queued,
        dispatching: status.dispatching,
      },
      {
        host: reservation.snapshot.host,
        session_uid: reservation.snapshot.session_uid,
        capacity: reservation.snapshot.capacity,
        capacity_sources: reservation.snapshot.capacity_sources,
        active: reservation.snapshot.active,
        available: reservation.snapshot.available,
        queued: reservation.snapshot.queued,
        dispatching: reservation.snapshot.dispatching,
      },
    );
    assert.equal(Object.hasOwn(status, "max_concurrent"), false);
    assert.equal(Object.hasOwn(status, "planning_max_concurrent"), false);

    const workspaceJson = await cli(cwd, treeA, ["status", "--host", HOST, "--json"]);
    assert.equal(workspaceJson.code, 0, workspaceJson.text);
    const workspace = JSON.parse(workspaceJson.text) as { capacity_trees: Array<Record<string, any>> };
    assert.equal(workspace.capacity_trees.length, 2);
    const groupA = workspace.capacity_trees.find((group) => group.session_uid === activeA[0]!.session_uid);
    const groupB = workspace.capacity_trees.find((group) => group.session_uid === queuedB.session_uid);
    assert.ok(groupA);
    assert.ok(groupB);
    assert.deepEqual([groupA!.active, groupA!.available], [2, 0]);
    assert.deepEqual([groupB!.active, groupB!.available], [1, 1]);
    assert.equal(Object.hasOwn(groupA!, "max_concurrent"), false);
    assert.equal(Object.hasOwn(groupA!, "planning_max_concurrent"), false);
    assert.equal(Object.hasOwn(workspace as Record<string, unknown>, "available"), false);

    const workspaceText = await cli(cwd, treeA, ["status", "--host", HOST]);
    assert.equal(workspaceText.code, 0, workspaceText.text);
    assert.match(workspaceText.text, /capacity trees:/);
    assert.match(workspaceText.text, new RegExp(`session=${activeA[0]!.session_uid} capacity=2 active=2 available=0`));
    assert.match(workspaceText.text, new RegExp(`session=${queuedB.session_uid} capacity=2 active=1 available=1`));
  }));

  it("treats command capacity overrides as current-tree and non-persistent, ignoring legacy state", async () => withHome(async (home) => {
    const cwd = newWorkspace();
    const env = fakeEnv(home, { BATON_SESSION_ID: "override-tree" });
    setup(cwd, env);
    const active = ticket(cwd, env, "dispatching", 0);
    const legacy = hostDispatchStatePath(cwd, HOST, env);
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ host: HOST, capacity: 1 }), "utf8");

    const overridden = await cli(cwd, env, ["dispatch", "status", "--host", HOST, "--capacity", "1", "--json"]);
    assert.equal(overridden.code, 0, overridden.text);
    const overrideStatus = JSON.parse(overridden.text) as Record<string, any>;
    assert.equal(overrideStatus.capacity, 1);
    assert.equal(overrideStatus.active, 1);
    assert.equal(overrideStatus.available, 0);

    const canonical = await cli(cwd, env, ["dispatch", "status", "--host", HOST, "--json"]);
    assert.equal(canonical.code, 0, canonical.text);
    const canonicalStatus = JSON.parse(canonical.text) as Record<string, any>;
    assert.equal(canonicalStatus.capacity, 2);
    assert.equal(canonicalStatus.active, 1);
    assert.equal(canonicalStatus.available, 1);
    assert.equal(fs.existsSync(legacy), true);
    assert.equal(active.status, "dispatching");
  }));

  it("fails closed for missing session identity and reports unattributed active records", async () => withHome(async (home) => {
    const cwd = newWorkspace();
    const env = fakeEnv(home, { BATON_SESSION_ID: "valid-status-tree" });
    setup(cwd, env);
    const missingSession = fakeEnv(home, { BATON_SESSION_ID: "" });
    const missing = await cli(cwd, missingSession, ["dispatch", "status", "--host", HOST, "--json"]);
    assert.equal(missing.code, 1);
    assert.match(missing.text, /BATON_SESSION_ID is required/);

    fs.mkdirSync(spawnsDir(cwd, env), { recursive: true });
    const file = path.join(spawnsDir(cwd, env), "legacy-active.json");
    fs.writeFileSync(file, JSON.stringify({
      id: "legacy-active",
      status: "dispatching",
      target_host: HOST,
      execution_handle: null,
    }), "utf8");

    const status = await cli(cwd, env, ["status", "--host", HOST, "--json"]);
    assert.equal(status.code, 0, status.text);
    const payload = JSON.parse(status.text) as { compatibility_blockers: Array<Record<string, any>> };
    assert.deepEqual(payload.compatibility_blockers, [{
      code: "UNATTRIBUTED_ACTIVE_RECORD",
      file: path.relative(cwd, file).replaceAll("\\", "/"),
      ticket_id: "legacy-active",
      status: "dispatching",
      host: HOST,
      reason: "active record has no valid root-agent-tree session_uid; reconciliation is required",
    }]);

    const text = await cli(cwd, env, ["status", "--host", HOST]);
    assert.equal(text.code, 0, text.text);
    assert.match(text.text, /UNATTRIBUTED_ACTIVE_RECORD legacy-active status=dispatching/);

    const blocked = await cli(cwd, env, ["dispatch", "next", "--host", HOST, "--json"]);
    assert.equal(blocked.code, 1);
    assert.match(blocked.text, /unattributed active records require reconciliation/);
  }));
});
