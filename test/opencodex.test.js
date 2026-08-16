import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";
import { loadConfig } from "../src/lib/config.js";
import { authProviderForCard } from "../src/lib/opencodex.js";

const FAKE_OCX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-ocx.sh");

function capture() {
  const chunks = [];
  return {
    chunks,
    write(s) { chunks.push(String(s)); },
    text() { return chunks.join(""); },
  };
}

function fakeOcxEnv() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ocx-bin-"));
  const log = path.join(bin, "argv.log");
  const ocx = path.join(bin, "ocx");
  fs.copyFileSync(FAKE_OCX, ocx);
  fs.chmodSync(ocx, 0o755);
  return {
    log,
    env: { ...process.env, PATH: bin + path.delimiter + (process.env.PATH || ""), OCX_ARGV_LOG: log },
  };
}

function noOcxEnv() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "baton-no-ocx-"));
  return { env: { ...process.env, PATH: bin } };
}

function argvLog(log) {
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
}

function secretLikeFiles(dir) {
  const hits = [];
  function walk(d) {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/token|api[_-]?key|auth\\.json|secret|credential/i.test(name)) hits.push(p);
    }
  }
  walk(dir);
  return hits;
}

describe("opencodex account login consume", () => {
  it("blocks when ocx is missing and does not reimplement login", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ocx-"));
    const out = capture();
    const code = await run(["login", "kimi"], { cwd, stdout: out, stderr: capture(), env: noOcxEnv().env });
    assert.equal(code, 2);
    const t = out.text();
    assert.match(t, /blocked:/);
    assert.match(t, /consumed/);
    assert.match(t, /not reimplemented/);
    assert.ok(t.includes("@bitkyc08/" + "opencodex"));
    assert.match(t, /Do not paste/);
  });

  it("baton login kimi invokes ocx account login kimi", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ocx-"));
    const fake = fakeOcxEnv();
    const code = await run(["login", "kimi"], { cwd, stdout: capture(), stderr: capture(), env: fake.env });
    assert.equal(code, 0);
    assert.match(argvLog(fake.log), /account login kimi/);
  });

  it("baton login cursor invokes ocx account login cursor", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ocx-"));
    const fake = fakeOcxEnv();
    const code = await run(["login", "cursor"], { cwd, stdout: capture(), stderr: capture(), env: fake.env });
    assert.equal(code, 0);
    assert.match(argvLog(fake.log), /account login cursor/);
  });

  it("--card k3 resolves to kimi", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ocx-"));
    initProject(cwd, { tools: ["claude"] });
    const cfg = loadConfig(cwd);
    assert.equal(cfg.models.find((m) => m.id === "k3").auth_provider, "kimi");
    const fake = fakeOcxEnv();
    const code = await run(["login", "--card", "k3"], { cwd, stdout: capture(), stderr: capture(), env: fake.env });
    assert.equal(code, 0);
    assert.match(argvLog(fake.log), /account login kimi/);
  });

  it("--card kimi-for-coding resolves to kimi", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ocx-"));
    initProject(cwd, { tools: ["claude"] });
    const fake = fakeOcxEnv();
    const code = await run(["login", "--card", "kimi-for-coding"], { cwd, stdout: capture(), stderr: capture(), env: fake.env });
    assert.equal(code, 0);
    assert.match(argvLog(fake.log), /account login kimi/);
  });

  it("--card mimo-v2.5-pro is blocked as key-only", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ocx-"));
    initProject(cwd, { tools: ["claude"] });
    const cfg = loadConfig(cwd);
    assert.equal(cfg.models.find((m) => m.id === "mimo-v2.5-pro").auth_provider, undefined);
    const fake = fakeOcxEnv();
    const out = capture();
    const code = await run(["login", "--card", "mimo-v2.5-pro"], { cwd, stdout: out, stderr: capture(), env: fake.env });
    assert.equal(code, 1);
    assert.match(out.text(), /blocked:/);
    assert.match(out.text(), /API-key/);
    assert.match(out.text(), /Do not paste/);
    assert.equal(argvLog(fake.log), "");
  });

  it("unknown card is blocked", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ocx-"));
    initProject(cwd, { tools: ["claude"] });
    const fake = fakeOcxEnv();
    const out = capture();
    const code = await run(["login", "--card", "does-not-exist"], { cwd, stdout: out, stderr: capture(), env: fake.env });
    assert.equal(code, 1);
    assert.match(out.text(), /blocked:/);
    assert.match(out.text(), /unknown card/);
    assert.match(out.text(), /auth_provider or pass provider/);
    assert.equal(argvLog(fake.log), "");
  });

  it("writes no token or key file under the temp cwd", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ocx-"));
    initProject(cwd, { tools: ["claude"] });
    const fake = fakeOcxEnv();
    const code = await run(["login", "kimi"], { cwd, stdout: capture(), stderr: capture(), env: fake.env });
    assert.equal(code, 0);
    assert.deepEqual(secretLikeFiles(cwd), []);
  });

  it("baton login lists ocx accounts when fake ocx is present", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ocx-"));
    initProject(cwd, { tools: ["claude"] });
    const fake = fakeOcxEnv();
    const out = capture();
    const code = await run(["login"], { cwd, stdout: out, stderr: capture(), env: fake.env });
    assert.equal(code, 0);
    assert.match(argvLog(fake.log), /account list/);
    assert.match(out.text(), /kimi/);
    assert.match(out.text(), /k3/);
  });

  it("maps grok ids to xai and does not invent a cursor card", () => {
    assert.equal(authProviderForCard({ id: "grok-4.6" }).provider, "xai");
    assert.equal(authProviderForCard({ id: "cursor" }).provider, null);
  });
});
