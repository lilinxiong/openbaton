import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cliProfileForHost, loadConfig, normalizeConfig, saveConfig } from "../src/lib/config.js";
import { reserveNext, persistedCapacity } from "../src/lib/dispatch.js";
import { hostDispatchStatePath, spawnsDir } from "../src/lib/paths.js";
import { buildReadOnlyReceipt, writeReceipt } from "../src/lib/receipt.js";
import { publishRouteSnapshot, readRouteSnapshot } from "../src/lib/routes.js";
import { buildSpawnTicket, writeSpawn } from "../src/lib/spawn.js";
import { parseDispatchReservationEnvelope } from "../src/lib/dispatch-reservation.js";
import { HOST_IDS, type HostId } from "../src/lib/hosts.js";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "baton-host-profiles-home-"));
process.env.HOME = HOME;

function project(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-host-profiles-"));
  saveConfig(cwd, {
    director: { max_concurrent: 4, max_depth: 1 },
    cli: {
      codex: { enabled: true, runner: "codex-model", longctx: "", coding_models: ["codex-model"], guard_mode: "enforce" },
      grok: { enabled: true, runner: "grok-model", longctx: "", coding_models: ["grok-model"], guard_mode: "enforce" },
      cursor: { enabled: true, runner: "cursor-model", longctx: "", coding_models: ["cursor-model"], guard_mode: "off" },
      claude: { enabled: true, runner: "claude-model", longctx: "", coding_models: ["claude-model"], guard_mode: "enforce" },
    },
  });
  return cwd;
}

function ticket(cwd: string, host: HostId, id = `spn-${host}`) {
  const route = `${host}/model`;
  const snapshot = readRouteSnapshot(cwd, { host })!;
  const selection = {
    host,
    proposal_id: "sel-host",
    approval_id: `approval-${id}`,
    approved_at: new Date().toISOString(),
    confirmed_by: "baton-recommendation" as const,
    catalog_fingerprint: snapshot.fingerprint,
    recommended_model_id: route,
    selected_model_id: route,
    changed_by_user: false,
  };
  const planned = buildSpawnTicket({
    id,
    description: "implement a host-scoped feature",
    prompt: "implement a host-scoped feature",
    modelId: route,
    routeId: route,
    taskKind: "concrete",
    targetHost: host,
    selection,
  });
  const receipt = buildReadOnlyReceipt({
    ticketId: id,
    card: { id: route, route_id: route, strengths: "", provider: host },
    selection,
    host,
    issuedAt: planned.created_at,
  });
  planned.receipt_id = receipt.receipt_id;
  writeReceipt(cwd, receipt);
  writeSpawn(cwd, planned);
  return planned;
}

describe("host-scoped profiles", () => {
  it("emits the same opaque reservation envelope for every registered CLI", () => {
    const cwd = project();
    for (const host of HOST_IDS) {
      const route = `${host}/model`;
      publishRouteSnapshot(cwd, { models: [{ id: route, namespaced: route }] }, new Date(), { cli: host, host });
      const config = loadConfig(cwd);
      config.cli[host].enabled = true;
      config.cli[host].coding_models = [route];
      saveConfig(cwd, config);
      const planned = ticket(cwd, host, `zly-${host}`);

      const result = reserveNext(cwd, { capacity: 1, host });
      assert.equal(result.reserved.length, 1);
      const [reserved] = result.reserved;
      assert.equal(reserved.ticket_id, planned.id);
      assert.equal(reserved.reservation.host, host);
      assert.deepEqual(parseDispatchReservationEnvelope(reserved.prompt), reserved.reservation);
      assert.deepEqual(parseDispatchReservationEnvelope(reserved.description), reserved.reservation);
    }
  });

  it("keeps enabled Codex and Grok profiles independent without a global default CLI", () => {
    const cwd = project();
    const config = loadConfig(cwd);
    assert.equal(Object.hasOwn(config.cli, "active"), false);
    assert.equal(cliProfileForHost(config, "codex").enabled, true);
    assert.deepEqual(cliProfileForHost(config, "codex").coding_models, ["codex-model"]);
    assert.deepEqual(cliProfileForHost(config, "grok").coding_models, ["grok-model"]);
  });

  it("isolates current host-keyed route snapshots", () => {
    const cwd = project();
    publishRouteSnapshot(cwd, { models: [{ id: "codex/model", namespaced: "codex/model" }] }, new Date(), { cli: "codex", host: "codex" });
    publishRouteSnapshot(cwd, { models: [{ id: "grok/model", namespaced: "grok/model" }] }, new Date(), { cli: "grok", host: "grok" });
    assert.equal(readRouteSnapshot(cwd, { host: "codex" })?.cli, "codex");
    assert.equal(readRouteSnapshot(cwd, { host: "grok" })?.cli, "grok");
    assert.equal(readRouteSnapshot(cwd, { host: "codex" })?.routes[0]?.route_id, "codex/model");
  });

  it("rejects a disabled host without falling back to the other enabled host", () => {
    const cwd = project();
    publishRouteSnapshot(cwd, { models: [{ id: "codex/model", namespaced: "codex/model" }] }, new Date(), { cli: "codex", host: "codex" });
    publishRouteSnapshot(cwd, { models: [{ id: "grok/model", namespaced: "grok/model" }] }, new Date(), { cli: "grok", host: "grok" });
    const config = loadConfig(cwd);
    config.cli.codex.enabled = false;
    saveConfig(cwd, config);
    ticket(cwd, "codex");
    assert.throws(
      () => reserveNext(cwd, { capacity: 1, host: "codex" }),
      (error: unknown) => (error as { code?: string }).code === "ACTIVATION_DISABLED"
        || (error as { code?: string }).code === "CLI_CONFIG_DISABLED",
    );
  });

  it("rejects explicit reservation/bind host mismatch before dispatch", () => {
    const cwd = project();
    publishRouteSnapshot(cwd, { models: [{ id: "codex/model", namespaced: "codex/model" }] }, new Date(), { cli: "codex", host: "codex" });
    publishRouteSnapshot(cwd, { models: [{ id: "grok/model", namespaced: "grok/model" }] }, new Date(), { cli: "grok", host: "grok" });
    ticket(cwd, "codex");
    const result = reserveNext(cwd, { capacity: 1, host: "grok" });
    assert.equal(result.reserved.length, 0);
    assert.equal(result.blocked[0]?.code, "HOST_MISMATCH");
  });

  it("does not read legacy ops routes or synthesize an unselected profile", () => {
    const config = normalizeConfig({
      ops: { runner: { route: "legacy-runner" }, longctx: { route: "legacy-longctx" } },
      cli: { active: "codex" },
    });
    assert.equal(Object.hasOwn(config.cli, "active"), false);
    assert.equal(config.cli.codex, undefined);
    assert.equal(config.cli.grok, undefined);
    assert.deepEqual(cliProfileForHost(config, "grok"), {
      enabled: false,
      runner: "",
      longctx: "",
      coding_models: [], guard_mode: "off",
    });
  });

  it("persists capacity separately for each host", () => {
    const cwd = project();
    publishRouteSnapshot(cwd, { models: [{ id: "codex/model", namespaced: "codex/model" }] }, new Date(), { cli: "codex", host: "codex" });
    publishRouteSnapshot(cwd, { models: [{ id: "grok/model", namespaced: "grok/model" }] }, new Date(), { cli: "grok", host: "grok" });
    ticket(cwd, "codex", "spn-codex");
    ticket(cwd, "grok", "spn-grok");
    reserveNext(cwd, { capacity: 2, host: "codex" });
    reserveNext(cwd, { capacity: 5, host: "grok" });
    assert.equal(persistedCapacity(cwd, "codex"), 2);
    assert.equal(persistedCapacity(cwd, "grok"), 5);
    assert.ok(fs.existsSync(hostDispatchStatePath(cwd, "codex", process.env)));
    assert.ok(fs.existsSync(path.join(spawnsDir(cwd), "spn-codex.json")));
  });

  it("keeps commit-only exclusivity global while ordinary capacity stays host-scoped", () => {
    const cwd = project();
    publishRouteSnapshot(cwd, { models: [{ id: "codex/model", namespaced: "codex/model" }] }, new Date(), { cli: "codex", host: "codex" });
    publishRouteSnapshot(cwd, { models: [{ id: "grok/model", namespaced: "grok/model" }] }, new Date(), { cli: "grok", host: "grok" });
    const commit = ticket(cwd, "codex", "spn-commit");
    commit.mode = "commit-only";
    commit.read_only = false;
    commit.status = "running";
    commit.agent_id = "agent-codex";
    commit.host = "codex";
    writeSpawn(cwd, commit);
    const ordinary = ticket(cwd, "grok", "spn-grok");
    const result = reserveNext(cwd, { capacity: 1, host: "grok" });
    assert.deepEqual(result.reserved, []);
    assert.deepEqual(result.blocked, []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), `${ordinary.id}.json`), "utf8")).status, "queued");
  });
});

describe("Claude Code host tickets", () => {
  function snapshots(cwd: string): void {
    publishRouteSnapshot(cwd, { models: [{ id: "codex/model", namespaced: "codex/model" }] }, new Date(), { cli: "codex", host: "codex" });
    publishRouteSnapshot(cwd, { models: [{ id: "grok/model", namespaced: "grok/model" }] }, new Date(), { cli: "grok", host: "grok" });
    publishRouteSnapshot(cwd, { models: [{ id: "claude/model", namespaced: "claude/model" }] }, new Date(), { cli: "claude", host: "claude" });
  }

  it("reserves its own ticket and retains the immutable host", () => {
    const cwd = project();
    snapshots(cwd);
    // Allow the exact route this ticket carries, so reservation can succeed.
    const config = loadConfig(cwd);
    config.cli.claude.coding_models = ["claude/model"];
    saveConfig(cwd, config);
    const planned = ticket(cwd, "claude", "spn-claude-ok");
    const result = reserveNext(cwd, { capacity: 1, host: "claude" });
    assert.equal(result.reserved.length, 1);
    assert.equal(result.reserved[0].ticket_id, planned.id);
    const stored = JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), `${planned.id}.json`), "utf8"));
    assert.equal(stored.status, "dispatching");
    assert.equal(stored.dispatch_host, "claude");
    assert.equal(stored.target_host, "claude");
  });

  it("returns a host mismatch instead of letting another host consume the ticket", () => {
    const cwd = project();
    snapshots(cwd);
    const planned = ticket(cwd, "claude", "spn-claude-foreign");
    for (const host of ["codex", "grok"] as const) {
      const result = reserveNext(cwd, { capacity: 1, host });
      assert.equal(result.reserved.length, 0);
      assert.equal(result.blocked[0]?.code, "HOST_MISMATCH");
    }
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), `${planned.id}.json`), "utf8")).status,
      "queued",
    );
  });

  it("fails closed when its own profile is disabled rather than borrowing another", () => {
    const cwd = project();
    snapshots(cwd);
    const config = loadConfig(cwd);
    config.cli.claude.enabled = false;
    saveConfig(cwd, config);
    ticket(cwd, "claude", "spn-claude-disabled");
    assert.throws(
      () => reserveNext(cwd, { capacity: 1, host: "claude" }),
      (error: unknown) => (error as { code?: string }).code === "ACTIVATION_DISABLED"
        || (error as { code?: string }).code === "CLI_CONFIG_DISABLED",
    );
  });

  it("persists its capacity separately from the other hosts", () => {
    const cwd = project();
    snapshots(cwd);
    ticket(cwd, "codex", "spn-codex-cap");
    ticket(cwd, "claude", "spn-claude-cap");
    reserveNext(cwd, { capacity: 2, host: "codex" });
    reserveNext(cwd, { capacity: 20, host: "claude" });
    assert.equal(persistedCapacity(cwd, "codex"), 2);
    assert.equal(persistedCapacity(cwd, "claude"), 20);
    assert.ok(fs.existsSync(hostDispatchStatePath(cwd, "claude", process.env)));
  });

  it("defers a queued ticket at capacity without changing its model", () => {
    const cwd = project();
    snapshots(cwd);
    const config = loadConfig(cwd);
    config.cli.claude.coding_models = ["claude/model"];
    saveConfig(cwd, config);
    const running = ticket(cwd, "claude", "spn-claude-running");
    running.status = "running";
    running.agent_id = "a1c6c5645da14e434";
    running.host = "claude";
    writeSpawn(cwd, running);
    const queued = ticket(cwd, "claude", "spn-claude-queued");
    // Capacity is already consumed by the running child.
    const result = reserveNext(cwd, { capacity: 1, host: "claude" });
    assert.equal(result.reserved.length, 0);
    const stored = JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), `${queued.id}.json`), "utf8"));
    assert.equal(stored.status, "queued");
    assert.equal(stored.model_id, queued.model_id);
    assert.equal(stored.error, null);
  });
});
