import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyConfig, saveConfig } from "../src/lib/config.js";
import {
  detectInvokingHost,
  detectInvokingHosts,
  inferHostFromTickets,
  resolveRuntimeHost,
} from "../src/lib/hosts.js";

describe("invoking host resolution", () => {
  it("detects Cursor from runtime signals", () => {
    assert.deepEqual(detectInvokingHosts({ CURSOR_AGENT: "1" }), ["cursor"]);
    assert.equal(detectInvokingHost({ CURSOR_CONVERSATION_ID: "abc" }), "cursor");
  });

  it("honors BATON_HOST over runtime signals", () => {
    assert.equal(detectInvokingHost({ BATON_HOST: "grok", CURSOR_AGENT: "1" }), "grok");
  });

  it("fails closed with HOST_REQUIRED when no runtime signal is present", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-host-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-host-cwd-"));
    const env = { HOME: home };
    const cfg = emptyConfig();
    cfg.cli.grok = { enabled: true, runner: "", longctx: "", subagent_models: [] };
    saveConfig(cwd, cfg, { env });
    assert.throws(
      () => resolveRuntimeHost({ cwd, env }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /HOST_REQUIRED/);
        assert.match(error.message, /--host/);
        assert.match(error.message, /BATON_HOST/);
        return true;
      },
    );
  });

  it("resolves a unique runtime detection signal without a configured default", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-host-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-host-cwd-"));
    const env = { HOME: home };
    const cfg = emptyConfig();
    cfg.cli.codex = { enabled: true, runner: "", longctx: "", subagent_models: [] };
    saveConfig(cwd, cfg, { env });
    assert.equal(resolveRuntimeHost({ cwd, env: { ...env, CURSOR_AGENT: "1" } }), "cursor");
  });

  it("infers a single ticket host when runtime detection is unavailable", () => {
    assert.equal(inferHostFromTickets([{ target_host: "cursor" }, { target_host: "cursor" }]), "cursor");
    assert.equal(inferHostFromTickets([{ target_host: "codex" }, { target_host: "cursor" }]), null);
  });
});
