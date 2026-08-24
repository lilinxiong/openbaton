import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cliProfileForHost, loadConfig, normalizeConfig, saveConfig } from "../src/lib/config.js";
import { reserveNext, persistedCapacity } from "../src/lib/dispatch.js";
import { dispatchStatePath, spawnsDir } from "../src/lib/paths.js";
import { buildReadOnlyReceipt, writeReceipt } from "../src/lib/receipt.js";
import { publishRouteSnapshot, readRouteSnapshot } from "../src/lib/routes.js";
import { buildSpawnTicket, writeSpawn } from "../src/lib/spawn.js";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "baton-host-profiles-home-"));
process.env.HOME = HOME;

function project(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-host-profiles-"));
  saveConfig(cwd, {
    director: { max_concurrent: 4, max_depth: 1 },
    cli: {
      active: "grok",
      codex: { enabled: true, runner: "codex-model", longctx: "", subagent_models: ["codex-model"] },
      grok: { enabled: true, runner: "grok-model", longctx: "", subagent_models: ["grok-model"] },
    },
    ops: {},
  });
  return cwd;
}

function ticket(cwd: string, host: "codex" | "grok", id = `spn-${host}`) {
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
  it("keeps enabled Codex and Grok profiles independent of the legacy active default", () => {
    const cwd = project();
    const config = loadConfig(cwd);
    assert.equal(config.cli.active, "grok");
    assert.equal(cliProfileForHost(config, "codex").enabled, true);
    assert.deepEqual(cliProfileForHost(config, "codex").subagent_models, ["codex-model"]);
    assert.deepEqual(cliProfileForHost(config, "grok").subagent_models, ["grok-model"]);
  });

  it("isolates keyed route snapshots and accepts only a matching legacy snapshot", () => {
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
    const result = reserveNext(cwd, { capacity: 1, host: "codex" });
    assert.equal(result.reserved.length, 0);
    assert.equal(result.blocked[0]?.code, "CLI_CONFIG_DISABLED");
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

  it("keeps old config routes on Codex and does not leak them into Grok", () => {
    const config = normalizeConfig({
      ops: { runner: { route: "legacy-runner" }, longctx: { route: "legacy-longctx" } },
      cli: { active: "codex" },
    });
    assert.equal(config.cli.codex.runner, "legacy-runner");
    assert.equal(config.cli.codex.longctx, "legacy-longctx");
    assert.equal(config.cli.grok.runner, "");
    assert.equal(config.cli.grok.longctx, "");
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
    assert.ok(fs.existsSync(dispatchStatePath(cwd, process.env, "codex")));
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
