import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSpawnTicket, nextSpawnId, nextSpawnIds, sessionUid, sessionTicketId, writeSpawn, listSpawns, readSpawn, validateSpawnTicketLineage } from "../src/lib/spawn.js";
import { receiptsDir, spawnsDir } from "../src/lib/paths.js";
import { run } from "../src/cli.js";
import { withHome, TEST_SESSION_ID, TEST_SESSION_UID, testTicketId, fakeEnv } from "./home.js";

function ticket(cwd: string, env: NodeJS.ProcessEnv, id?: string) {
  return buildSpawnTicket({ cwd, env, id, description: "session test", prompt: "session test", modelId: "alpha/default", routeId: "alpha/default", taskKind: "concrete" });
}

describe("session-scoped ticket ids", () => {
  it("hashes identity and increments contiguously per session", () => withHome((home) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-session-"));
    const env1 = fakeEnv(home, { BATON_SESSION_ID: "one" });
    const env2 = fakeEnv(home, { BATON_SESSION_ID: "two" });
    const a = ticket(cwd, env1, nextSpawnId(cwd, "spn", env1));
    const b = ticket(cwd, env2, nextSpawnId(cwd, "spn", env2));
    writeSpawn(cwd, a, env1);
    writeSpawn(cwd, b, env2);
    assert.equal(a.session_ordinal, 1);
    assert.equal(b.session_ordinal, 1);
    assert.notEqual(a.session_uid, b.session_uid);
    const a2 = ticket(cwd, env1, nextSpawnId(cwd, "spn", env1));
    assert.equal(a2.session_ordinal, 2);
    assert.equal(nextSpawnId(cwd, "os", env1), `os-${a.session_uid}-0002`);
    const osTicket = ticket(cwd, env1, nextSpawnId(cwd, "os", env1));
    assert.equal(osTicket.session_ordinal, 2);
    writeSpawn(cwd, osTicket, env1);
    assert.deepEqual(nextSpawnIds(cwd, "spn", 3, env1), [testTicketId("spn", 3, a.session_uid), testTicketId("spn", 4, a.session_uid), testTicketId("spn", 5, a.session_uid)]);
  }));

  it("rejects missing identity before writing", () => withHome((home) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-session-missing-"));
    const env = fakeEnv(home, { BATON_SESSION_ID: "" });
    assert.throws(() => nextSpawnId(cwd, "spn", env), /BATON_SESSION_ID/);
    assert.equal(fs.existsSync(spawnsDir(cwd, env)), false);
  }));

  it("ignores historical records in listing and rejects exact reads", () => withHome((home) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-session-old-"));
    const env = fakeEnv(home);
    fs.mkdirSync(spawnsDir(cwd, env), { recursive: true });
    const old = testTicketId("spn", 1);
    fs.writeFileSync(path.join(spawnsDir(cwd, env), `${old}.json`), JSON.stringify({ id: old, schema_version: 7 }));
    assert.deepEqual(listSpawns(cwd, env), []);
    assert.throws(() => readSpawn(cwd, old, env), (e: any) => e.code === "TICKET_FORMAT_UNSUPPORTED");
  }));

  it("CLI spawn with missing identity leaves no artifacts", async () => withHome(async (home) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-session-cli-missing-"));
    const env = fakeEnv(home, { BATON_SESSION_ID: "" });
    const sink = { write() { return true; } };
    await run(["spawn", "do work", "--host", "alpha", "--json"], { cwd, env, stdout: sink, stderr: sink });
    assert.equal(fs.existsSync(spawnsDir(cwd, env)), false);
    assert.equal(fs.existsSync(receiptsDir(cwd, env)), false);
  }));

  it("keeps helper output stable", () => {
    assert.equal(sessionUid({ BATON_SESSION_ID: TEST_SESSION_ID }), TEST_SESSION_UID);
    assert.equal(sessionTicketId("spn", TEST_SESSION_UID, 1), testTicketId("spn", 1));
  });

  it("round-trips compiled apply lineage and leaves manual tickets legacy-compatible", () => withHome((home) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-session-compiled-"));
    const env = fakeEnv(home, { BATON_SESSION_ID: "compiled" });
    const id = nextSpawnId(cwd, "spn", env);
    const compiled = buildSpawnTicket({
      cwd, env, id, description: "verify", prompt: "verify", modelId: "alpha/default", routeId: "alpha/default", taskKind: "concrete",
      compiledApplyLineage: { run_id: "run-1", plan_revision: "2", plan_fingerprint: "fp-1", unit_id: "unit-1", task_refs: ["1.1", "1.2"], mode: "verification-only" },
    });
    assert.equal(compiled.work_unit.schema_version, 2);
    assert.equal(validateSpawnTicketLineage(compiled), null);
    assert.equal(Object.isFrozen(compiled.compiled_apply_lineage), true);
    assert.equal(Object.isFrozen(compiled.compiled_apply_lineage?.task_refs), true);
    writeSpawn(cwd, compiled, env);
    assert.deepEqual(readSpawn(cwd, id, env).compiled_apply_lineage, compiled.compiled_apply_lineage);
    const manual = ticket(cwd, env, nextSpawnId(cwd, "spn", env));
    assert.equal(manual.compiled_apply_lineage, undefined);
    assert.equal(validateSpawnTicketLineage(manual), null);
  }));
});
