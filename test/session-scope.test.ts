import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertSessionScope,
  sessionScope,
  sessionScopeFromUid,
  sessionUidFromEnv,
  SessionScopeError,
  validateSessionScope,
} from "../src/lib/session-scope.js";
import { buildSpawnTicket, writeSpawn } from "../src/lib/spawn.js";
import { withHome, TEST_SESSION_ID, TEST_SESSION_UID, fakeEnv } from "./home.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("root agent tree session scope", () => {
  it("derives one immutable scope and rejects mutation", () => {
    const scope = sessionScope({ BATON_SESSION_ID: TEST_SESSION_ID });
    assert.equal(scope.session_uid, TEST_SESSION_UID);
    assert.throws(() => {
      (scope as { session_uid: string }).session_uid = "forged";
    }, TypeError);
    assert.equal(Object.isFrozen(scope), true);
    assert.deepEqual(sessionScopeFromUid(TEST_SESSION_UID), scope);
  });

  it("fails closed with a structured missing-session error", () => {
    assert.throws(() => sessionScope({ BATON_SESSION_ID: "  " }), (error: unknown) => {
      assert.ok(error instanceof SessionScopeError);
      assert.equal(error.code, "SESSION_SCOPE_REQUIRED");
      assert.equal(error.details.env_key, "BATON_SESSION_ID");
      assert.match(error.message, /BATON_SESSION_ID/);
      return true;
    });
  });

  it("rejects mismatched current identity without changing the expected scope", () => {
    const expected = sessionScope({ BATON_SESSION_ID: "root" });
    assert.throws(() => validateSessionScope(expected.session_uid, { BATON_SESSION_ID: "descendant-forged" }), (error: unknown) => {
      assert.ok(error instanceof SessionScopeError);
      assert.equal(error.code, "SESSION_SCOPE_MISMATCH");
      assert.equal(error.expected_session_uid, expected.session_uid);
      assert.equal(error.actual_session_uid, sessionUidFromEnv({ BATON_SESSION_ID: "descendant-forged" }));
      return true;
    });
    assert.doesNotThrow(() => assertSessionScope(expected.session_uid, expected));
  });

  it("prevents persisting a ticket under another session", () => withHome((home) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-session-scope-"));
    const rootEnv = fakeEnv(home, { BATON_SESSION_ID: "root" });
    const otherEnv = fakeEnv(home, { BATON_SESSION_ID: "other" });
    const ticket = buildSpawnTicket({
      cwd,
      env: rootEnv,
      description: "scope test",
      prompt: "scope test",
      modelId: "alpha/default",
      routeId: "alpha/default",
      taskKind: "concrete",
    });
    assert.throws(() => writeSpawn(cwd, ticket, otherEnv), (error: unknown) => {
      assert.ok(error instanceof SessionScopeError);
      assert.equal(error.code, "SESSION_SCOPE_MISMATCH");
      return true;
    });
  }));
});

