import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";
import { loadConfig } from "../src/lib/config.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { withHome } from "./home.js";
import {
  authProviderForCard,
  resolveOcx,
  engineMissingMessage,
  isProxyDown,
  ocxFailureHint,
  sanitizeEngineOutput,
  ENGINE_START_FAILURE_MESSAGE,
  ENGINE_UNREACHABLE_HINT,
  OCX_PACKAGE,
} from "../src/lib/opencodex.js";

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
  it("missing PATH ocx is not a hard fail when resolver can resolve", async () => {
    await withHome(async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ocx-"));
    const calls = [];
    const resolve = () => ({ source: "npx", command: "npx", prefixArgs: ["-y", OCX_PACKAGE] });
    const runner = ({ command, prefixArgs, args }) => {
      calls.push({ command, prefixArgs, args });
      return { status: 0, stdout: "login kimi\n", stderr: "" };
    };
    const code = await run(["login", "kimi"], {
      cwd, stdout: capture(), stderr: capture(), env: noOcxEnv().env, resolve, runner,
    });
    assert.equal(code, 0);
    const login = calls.find((c) => c.args[0] === "account" && c.args[1] === "login");
    assert.ok(login);
    assert.deepEqual(login.args, ["account", "login", "kimi"]);
    assert.equal(login.command, "npx");
    assert.deepEqual(login.prefixArgs, ["-y", OCX_PACKAGE]);
    });
  });

  it("when the engine cannot be resolved, does not tell the user to install ocx", async () => {
    await withHome(async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ocx-"));
    const out = capture();
    const code = await run(["login", "kimi"], {
      cwd, stdout: out, stderr: capture(), env: noOcxEnv().env, resolve: () => null,
    });
    assert.equal(code, 2);
    const t = out.text();
    assert.match(t, /blocked:/);
    assert.match(t, /login engine/);
    assert.match(t, /consumed/);
    assert.match(t, /not reimplemented/);
    assert.match(t, /Do not paste/);
    assert.doesNotMatch(t, /OpenCodex is not on PATH/);
    assert.doesNotMatch(t, /Install:/);
    assert.equal(t.trim(), engineMissingMessage());
    });
  });

  it("resolver tries PATH then bundled then npx", () => {
    const order = [];
    const pathHit = resolveOcx({
      env: {},
      findOnPath: () => { order.push("path"); return "/usr/bin/ocx"; },
      findBundled: () => { order.push("bundled"); return "/pkg/node_modules/.bin/ocx"; },
      npxAvailable: () => { order.push("npx"); return true; },
    });
    assert.equal(pathHit.source, "path");
    assert.equal(pathHit.command, "/usr/bin/ocx");
    assert.deepEqual(order, ["path"]);

    order.length = 0;
    const bundled = resolveOcx({
      env: {},
      findOnPath: () => { order.push("path"); return null; },
      findBundled: () => { order.push("bundled"); return "/pkg/node_modules/.bin/ocx"; },
      npxAvailable: () => { order.push("npx"); return true; },
    });
    assert.equal(bundled.source, "bundled");
    assert.equal(bundled.command, "/pkg/node_modules/.bin/ocx");
    assert.deepEqual(order, ["path", "bundled"]);

    order.length = 0;
    const viaNpx = resolveOcx({
      env: {},
      findOnPath: () => { order.push("path"); return null; },
      findBundled: () => { order.push("bundled"); return null; },
      npxAvailable: () => { order.push("npx"); return true; },
    });
    assert.equal(viaNpx.source, "npx");
    assert.deepEqual(viaNpx.prefixArgs, ["-y", OCX_PACKAGE]);
    assert.deepEqual(order, ["path", "bundled", "npx"]);

    const none = resolveOcx({
      env: {},
      findOnPath: () => null,
      findBundled: () => null,
      npxAvailable: () => false,
    });
    assert.equal(none, null);
  });

  it("resolver finds the OpenCodex git submodule before node_modules", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "baton-submod-"));
    const subBin = path.join(root, "opencodex", "bin");
    fs.mkdirSync(subBin, { recursive: true });
    const submodule = path.join(subBin, "ocx.mjs");
    fs.copyFileSync(FAKE_OCX, submodule);
    const binDir = path.join(root, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    const npmBin = path.join(binDir, "ocx");
    fs.copyFileSync(FAKE_OCX, npmBin);
    fs.chmodSync(npmBin, 0o755);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "baton-empty-path-"));
    const hit = resolveOcx({
      env: { ...process.env, PATH: empty },
      packageRoot: root,
      npxAvailable: () => false,
    });
    assert.equal(hit.source, "bundled");
    assert.equal(hit.command, submodule);
  });

  it("resolver finds bundled ocx next to baton when PATH is empty", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "baton-bundled-"));
    const binDir = path.join(root, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    const bundled = path.join(binDir, "ocx");
    fs.copyFileSync(FAKE_OCX, bundled);
    fs.chmodSync(bundled, 0o755);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "baton-empty-path-"));
    const hit = resolveOcx({
      env: { ...process.env, PATH: empty },
      packageRoot: root,
      npxAvailable: () => false,
    });
    assert.equal(hit.source, "bundled");
    assert.equal(hit.command, bundled);
  });

  it("does not start a proxy when list/login fails because it is down", async () => {
    await withHome(async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ocx-"));
    const starts = [];
    const calls = [];
    const resolve = () => ({ source: "path", command: "/tmp/ocx", prefixArgs: [] });
    const runner = ({ args }) => {
      calls.push(args.slice());
      if (args[0] === "account" && args[1] === "list") {
        return { status: 1, stdout: "", stderr: "proxy is down: connection refused" };
      }
      if (args[0] === "account" && args[1] === "login") {
        return { status: 1, stdout: "", stderr: "proxy is down: connection refused" };
      }
      return { status: 1, stdout: "", stderr: "unexpected " + args.join(" ") };
    };
    const startProxy = (opts) => {
      starts.push(opts);
      return { status: 0, started: true, method: "service" };
    };
    const loginOut = capture();
    const loginCode = await run(["login", "kimi"], {
      cwd, stdout: loginOut, stderr: capture(), env: noOcxEnv().env, resolve, runner, startProxy,
    });
    assert.equal(loginCode, 1);
    assert.equal(starts.length, 0);
    assert.ok(calls.every((a) => a[0] === "account"));
    assert.ok(!calls.some((a) => a[0] === "ensure" || a[0] === "start" || (a[0] === "service" && a[1] === "start")));
    assert.doesNotMatch(loginOut.text(), /ocx/i);
    assert.match(loginOut.text(), /should not require a local proxy|not used that way/i);

    starts.length = 0;
    calls.length = 0;
    const listOut = capture();
    const listCode = await run(["login"], {
      cwd, stdout: listOut, stderr: capture(), env: noOcxEnv().env, resolve, runner, startProxy,
    });
    assert.equal(listCode, 1);
    assert.equal(starts.length, 0);
    assert.ok(!calls.some((a) => a[0] === "ensure" || a[0] === "start" || (a[0] === "service" && a[1] === "start")));
    assert.doesNotMatch(listOut.text(), /ocx/i);
    assert.match(listOut.text(), /should not require a local proxy|not used that way/i);
    });
  });

  it("isProxyDown detects refused proxy and not a generic failure", () => {
    assert.equal(isProxyDown({ status: 1, stderr: "proxy is down: connection refused" }), true);
    assert.equal(isProxyDown({ status: 1, error: { code: "ECONNREFUSED", message: "connect" } }), true);
    assert.equal(isProxyDown({ status: 1, stderr: "Error: Proxy is not running. Start it with: ocx start" }), true);
    assert.equal(isProxyDown({ status: 1, stderr: "Start it with: ocx start" }), true);
    assert.equal(isProxyDown({ status: 1, stderr: "unexpected: account foo" }), false);
    assert.equal(isProxyDown({ status: 0, stdout: "ok" }), false);
  });

  it("does not leak ocx when login fails because the proxy is down", async () => {
    await withHome(async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ocx-"));
    const resolve = () => ({ source: "path", command: "/tmp/ocx", prefixArgs: [] });
    const runner = () => ({
      status: 1,
      stdout: "",
      stderr: "Error: Proxy is not running. Start it with: ocx start",
    });
    const starts = [];
    const startProxy = () => {
      starts.push(true);
      return { status: 0, started: true, method: "ensure" };
    };
    const out = capture();
    const err = capture();
    const code = await run(["login", "kimi"], {
      cwd, stdout: out, stderr: err, env: noOcxEnv().env, resolve, runner, startProxy,
      proxyWaitMs: 0, proxyPollMs: 0,
    });
    assert.equal(code, 1);
    assert.equal(starts.length, 0);
    const visible = out.text() + err.text();
    assert.doesNotMatch(visible, /ocx/i);
    assert.match(visible, /login engine/i);
    assert.match(visible, /baton login/);
    assert.match(visible, /should not require a local proxy|not used that way/i);
    assert.doesNotMatch(visible, /start (it|the proxy|a proxy)/i);
    assert.equal(visible.trim(), ocxFailureHint({
      status: 1,
      stderr: "Error: Proxy is not running. Start it with: ocx start",
    }));
    });
  });

  it("does not start a proxy or wait when list/login reports the proxy is down", async () => {
    await withHome(async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ocx-"));
    const calls = [];
    let lists = 0;
    const resolve = () => ({ source: "path", command: "/tmp/ocx", prefixArgs: [] });
    const runner = ({ args, inheritStdio }) => {
      calls.push({ args: args.slice(), inheritStdio: Boolean(inheritStdio) });
      if (args[0] === "account" && args[1] === "list") {
        lists += 1;
        return { status: 1, stdout: "", stderr: "Error: Proxy is not running. Start it with: ocx start" };
      }
      if (args[0] === "account" && args[1] === "login") {
        return { status: 1, stdout: "", stderr: "Error: Proxy is not running. Start it with: ocx start" };
      }
      return { status: 1, stdout: "", stderr: "unexpected " + args.join(" ") };
    };
    const starts = [];
    const startProxy = () => {
      starts.push(lists);
      return { status: 0, started: true, method: "ensure" };
    };
    const out = capture();
    const code = await run(["login", "kimi"], {
      cwd, stdout: out, stderr: capture(), env: noOcxEnv().env,
      resolve, runner, startProxy, proxyWaitMs: 1000, proxyPollMs: 0,
    });
    assert.equal(code, 1);
    assert.equal(starts.length, 0);
    assert.ok(lists <= 1, "must not poll list until a proxy is up");
    assert.ok(!calls.some((c) => c.args[0] === "ensure" || c.args[0] === "start" || (c.args[0] === "service" && c.args[1] === "start")));
    const login = calls.find((c) => c.args[0] === "account" && c.args[1] === "login");
    assert.ok(login);
    assert.deepEqual(login.args, ["account", "login", "kimi"]);
    assert.doesNotMatch(out.text(), /ocx/i);
    assert.match(out.text(), /should not require a local proxy|not used that way/i);
    });
  });

  it("ocxFailureHint never passes through raw engine CLI names", () => {
    const hint = ocxFailureHint({
      status: 1,
      stderr: "Error: Proxy is not running. Start it with: ocx start",
    });
    assert.doesNotMatch(hint, /ocx/i);
    assert.match(hint, /login engine/);
    assert.match(hint, /baton login/);
    assert.equal(hint, ENGINE_START_FAILURE_MESSAGE + "\n" + ENGINE_UNREACHABLE_HINT);
    const cleaned = sanitizeEngineOutput("Error: Proxy is not running. Start it with: ocx start");
    assert.doesNotMatch(cleaned, /ocx/i);
    assert.doesNotMatch(cleaned, /Start it with/i);
    assert.match(cleaned, /should not require a local proxy/);
  });

  it("baton login kimi invokes ocx account login kimi", async () => {
    await withHome(async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ocx-"));
    const fake = fakeOcxEnv();
    const code = await run(["login", "kimi"], { cwd, stdout: capture(), stderr: capture(), env: fake.env });
    assert.equal(code, 0);
    assert.match(argvLog(fake.log), /account login kimi/);
    });
  });

  it("baton login cursor invokes ocx account login cursor", async () => {
    await withHome(async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ocx-"));
    const fake = fakeOcxEnv();
    const code = await run(["login", "cursor"], { cwd, stdout: capture(), stderr: capture(), env: fake.env });
    assert.equal(code, 0);
    assert.match(argvLog(fake.log), /account login cursor/);
    });
  });

  it("baton login grok aliases to ocx account login xai", async () => {
    await withHome(async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ocx-"));
    const fake = fakeOcxEnv();
    const code = await run(["login", "grok"], { cwd, stdout: capture(), stderr: capture(), env: fake.env });
    assert.equal(code, 0);
    assert.match(argvLog(fake.log), /account login xai/);
    });
  });

  it("--card k3 resolves to kimi", async () => {
    await withHome(async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ocx-"));
    initProject(cwd, { tools: ["claude"] });
    publishRouteSnapshot(cwd, { models: [{ id: "k3[1m]", provider: "kimi" }] });
    const cfg = loadConfig(cwd);
    assert.equal(cfg.models.find((m) => m.id === "k3").auth_provider, "kimi");
    const fake = fakeOcxEnv();
    const code = await run(["login", "--card", "k3"], { cwd, stdout: capture(), stderr: capture(), env: fake.env });
    assert.equal(code, 0);
    assert.match(argvLog(fake.log), /account login kimi/);
    });
  });

  it("--card kimi-for-coding resolves to kimi", async () => {
    await withHome(async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ocx-"));
    initProject(cwd, { tools: ["claude"] });
    publishRouteSnapshot(cwd, { models: [{ id: "kimi-k2.7-code-highspeed", provider: "kimi" }] });
    const fake = fakeOcxEnv();
    const code = await run(["login", "--card", "kimi-for-coding"], { cwd, stdout: capture(), stderr: capture(), env: fake.env });
    assert.equal(code, 0);
    assert.match(argvLog(fake.log), /account login kimi/);
    });
  });

  it("--card mimo-v2.5-pro is blocked as key-only", async () => {
    await withHome(async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ocx-"));
    initProject(cwd, { tools: ["claude"] });
    publishRouteSnapshot(cwd, { models: [{ id: "mimo-v2.5-pro", provider: "mimo" }] });
    const fake = fakeOcxEnv();
    const out = capture();
    const code = await run(["login", "--card", "mimo-v2.5-pro"], { cwd, stdout: out, stderr: capture(), env: fake.env });
    assert.equal(code, 1);
    assert.match(out.text(), /blocked:/);
    assert.match(out.text(), /API-key/);
    assert.match(out.text(), /Do not paste/);
    assert.equal(argvLog(fake.log), "");
    });
  });

  it("unknown card is blocked", async () => {
    await withHome(async () => {
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
  });

  it("writes no token or key file under the temp cwd", async () => {
    await withHome(async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ocx-"));
    initProject(cwd, { tools: ["claude"] });
    const fake = fakeOcxEnv();
    const code = await run(["login", "kimi"], { cwd, stdout: capture(), stderr: capture(), env: fake.env });
    assert.equal(code, 0);
    assert.deepEqual(secretLikeFiles(cwd), []);
    });
  });

  it("baton login lists ocx accounts when fake ocx is present", async () => {
    await withHome(async () => {
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
  });

  it("maps grok ids to xai and does not invent a cursor card", () => {
    assert.equal(authProviderForCard({ id: "grok-4.6" }).provider, "xai");
    assert.equal(authProviderForCard({ id: "cursor" }).provider, null);
  });

  it("help and docs do not tell the user to install ocx", async () => {
    const out = capture();
    const code = await run(["help"], { cwd: os.tmpdir(), stdout: out, stderr: capture() });
    assert.equal(code, 0);
    const help = out.text();
    assert.match(help, /baton login <provider>/);
    assert.match(help, /sign in with a browser/);
    assert.doesNotMatch(help, /ocx account login/);
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    for (const rel of ["SKILL.md", "README.md", "README.zh.md"]) {
      const text = fs.readFileSync(path.join(root, rel), "utf8");
      assert.doesNotMatch(text, /you must have ocx/i);
      assert.doesNotMatch(text, /If `ocx` is missing/);
      assert.doesNotMatch(text, /Install OpenCodex/);
    }
  });
});
