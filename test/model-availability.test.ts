import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  accountScopeDigest,
  availabilityForRoute,
  claimRouteProbe,
  earliestQuotaResetAt,
  isConfirmedQuotaExhaustion,
  markRouteAvailable,
  markRouteExhausted,
  readModelAvailability,
  resetRouteAvailability,
} from "../src/lib/model-availability.js";
import { modelAvailabilityPath } from "../src/lib/paths.js";

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "baton-model-availability-"));
}

describe("durable model availability", () => {
  it("preserves concurrent updates from separate processes", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-availability-process-home-"));
    const env = { ...process.env, HOME: home };
    const cwd = workspace();
    const barrier = path.join(home, "start");
    const moduleUrl = new URL("../src/lib/model-availability.ts", import.meta.url).href;
    const childSource = `
      (async () => {
        const fs = await import("node:fs");
        while (!fs.existsSync(process.env.BATON_TEST_BARRIER)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        }
        const availability = await import(process.env.BATON_TEST_MODULE_URL);
        availability.markRouteExhausted(process.env.BATON_TEST_CWD, {
          host: "codex",
          routeId: process.env.BATON_TEST_ROUTE,
        }, { reason: "MODEL_QUOTA_EXHAUSTED", env: process.env });
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    const routes = ["spark", "luna", "mini", "longctx"];
    const children = routes.map((route) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", childSource], {
        cwd: process.cwd(),
        env: {
          ...env,
          BATON_TEST_BARRIER: barrier,
          BATON_TEST_MODULE_URL: moduleUrl,
          BATON_TEST_CWD: cwd,
          BATON_TEST_ROUTE: route,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      const errors: string[] = [];
      child.stderr.on("data", (chunk) => errors.push(String(chunk)));
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(errors.join("") || `child exited ${code}`)));
    }));
    fs.writeFileSync(barrier, "go\n");
    await Promise.all(children);
    assert.deepEqual(
      readModelAvailability(cwd, env).records.map((record) => record.route_id).sort(),
      [...routes].sort(),
    );
  });

  it("only classifies explicit quota evidence as durable exhaustion", () => {
    assert.equal(isConfirmedQuotaExhaustion({ errorCode: "MODEL_QUOTA_EXHAUSTED" }), true);
    assert.equal(isConfirmedQuotaExhaustion({ remainingPercent: 0 }), true);
    assert.equal(isConfirmedQuotaExhaustion({ errorCode: "UPSTREAM_429", message: "rate limited" }), false);
    assert.equal(isConfirmedQuotaExhaustion({ errorCode: "NETWORK_ERROR", message: "quota endpoint unavailable" }), false);
    assert.equal(earliestQuotaResetAt(["2026-08-26T01:00:00Z", "2026-08-26T00:30:00Z"]), "2026-08-26T00:30:00Z");
  });

  it("uses an opaque host-profile scope and persists exhaustion outside projects", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-availability-home-"));
    const env = { ...process.env, HOME: home };
    const firstProject = workspace();
    const secondProject = workspace();
    const now = new Date("2026-08-26T00:00:00Z");
    const record = markRouteExhausted(firstProject, {
      host: "codex",
      routeId: "gpt-5.3-codex-spark",
    }, { reason: "MODEL_QUOTA_EXHAUSTED", now, env });
    assert.equal(record.account_scope, accountScopeDigest("host-profile"));
    assert.equal(availabilityForRoute(secondProject, { host: "codex", routeId: record.route_id }, now, env).status, "exhausted");
    assert.equal(fs.statSync(modelAvailabilityPath(firstProject, env)).mode & 0o777, 0o600);
  });

  it("moves an exhausted route to one bounded-backoff probe owner", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-availability-probe-home-"));
    const env = { ...process.env, HOME: home };
    const cwd = workspace();
    const exhaustedAt = new Date("2026-08-26T00:00:00Z");
    markRouteExhausted(cwd, { host: "codex", routeId: "gpt-5.6-luna" }, {
      reason: "MODEL_QUOTA_EXHAUSTED", now: exhaustedAt, env,
    });
    const beforeDue = availabilityForRoute(cwd, { host: "codex", routeId: "gpt-5.6-luna" }, exhaustedAt, env);
    assert.equal(beforeDue.status, "exhausted");
    const dueAt = new Date("2026-08-26T00:15:00Z");
    assert.equal(availabilityForRoute(cwd, { host: "codex", routeId: "gpt-5.6-luna" }, dueAt, env).status, "probe_due");
    assert.equal(claimRouteProbe(cwd, { host: "codex", routeId: "gpt-5.6-luna" }, { owner: "one", now: dueAt, env }).claimed, true);
    assert.equal(claimRouteProbe(cwd, { host: "codex", routeId: "gpt-5.6-luna" }, { owner: "two", now: dueAt, env }).claimed, false);
    markRouteAvailable(cwd, { host: "codex", routeId: "gpt-5.6-luna" }, { now: dueAt, env });
    assert.equal(availabilityForRoute(cwd, { host: "codex", routeId: "gpt-5.6-luna" }, dueAt, env).status, "available");
  });

  it("grants at most one probe lease across competing processes", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-availability-probe-process-home-"));
    const env = { ...process.env, HOME: home };
    const cwd = workspace();
    const dueAt = "2026-08-26T00:15:00.000Z";
    markRouteExhausted(cwd, { host: "codex", routeId: "spark" }, {
      reason: "MODEL_QUOTA_EXHAUSTED",
      now: "2026-08-26T00:00:00.000Z",
      resetAt: dueAt,
      env,
    });
    const barrier = path.join(home, "probe-start");
    const moduleUrl = new URL("../src/lib/model-availability.ts", import.meta.url).href;
    const childSource = `
      (async () => {
        const fs = await import("node:fs");
        while (!fs.existsSync(process.env.BATON_TEST_BARRIER)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        }
        const availability = await import(process.env.BATON_TEST_MODULE_URL);
        const result = availability.claimRouteProbe(process.env.BATON_TEST_CWD, {
          host: "codex", routeId: "spark",
        }, { owner: process.env.BATON_TEST_OWNER, now: process.env.BATON_TEST_NOW, env: process.env });
        process.stdout.write(JSON.stringify({ claimed: result.claimed }));
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    const claim = (owner: string) => new Promise<boolean>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", childSource], {
        cwd: process.cwd(),
        env: {
          ...env,
          BATON_TEST_BARRIER: barrier,
          BATON_TEST_MODULE_URL: moduleUrl,
          BATON_TEST_CWD: cwd,
          BATON_TEST_OWNER: owner,
          BATON_TEST_NOW: dueAt,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const output: string[] = [];
      const errors: string[] = [];
      child.stdout.on("data", (chunk) => output.push(String(chunk)));
      child.stderr.on("data", (chunk) => errors.push(String(chunk)));
      child.once("error", reject);
      child.once("exit", (code) => code === 0
        ? resolve(Boolean(JSON.parse(output.join("")).claimed))
        : reject(new Error(errors.join("") || `child exited ${code}`)));
    });
    const contenders = [claim("process-a"), claim("process-b")];
    fs.writeFileSync(barrier, "go\n");
    const results = await Promise.all(contenders);
    assert.equal(results.filter(Boolean).length, 1);
  });

  it("resets only the requested route and leaves unrelated decisions intact", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-availability-reset-home-"));
    const env = { ...process.env, HOME: home };
    const cwd = workspace();
    const now = new Date("2026-08-26T00:00:00Z");
    markRouteExhausted(cwd, { host: "codex", routeId: "gpt-5.3-codex-spark" }, { now, env });
    markRouteExhausted(cwd, { host: "codex", routeId: "gpt-5.6-luna" }, { now, env });
    assert.equal(resetRouteAvailability(cwd, { host: "codex", routeId: "gpt-5.3-codex-spark" }, { env }), true);
    assert.equal(readModelAvailability(cwd, env).records.length, 1);
    assert.equal(availabilityForRoute(cwd, { host: "codex", routeId: "gpt-5.6-luna" }, now, env).status, "exhausted");
  });

  it("serializes interleaved mutations without dropping unrelated route records", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-availability-interleave-home-"));
    const env = { ...process.env, HOME: home };
    const cwd = workspace();
    const now = new Date("2026-08-26T00:00:00Z");
    markRouteExhausted(cwd, { host: "codex", routeId: "spark" }, { now, env });
    markRouteExhausted(cwd, { host: "codex", routeId: "luna" }, { now, env });
    markRouteAvailable(cwd, { host: "codex", routeId: "spark" }, { now, env });
    const store = readModelAvailability(cwd, env);
    assert.equal(store.records.length, 2);
    assert.equal(availabilityForRoute(cwd, { host: "codex", routeId: "spark" }, now, env).status, "available");
    assert.equal(availabilityForRoute(cwd, { host: "codex", routeId: "luna" }, now, env).status, "exhausted");
    assert.equal(fs.existsSync(`${modelAvailabilityPath(cwd, env)}.lock`), false);
  });
});
