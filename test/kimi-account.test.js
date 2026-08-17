import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";
import { withHome, fakeEnv } from "./home.js";
import {
  readKimiAccountToken,
  writeKimiAccountEnv,
  wireKimiAccountToGrok,
  kimiAccountEnvPath,
  grokConfigPath,
  GROK_ENV_SOURCE_LINE,
  KIMI_CODING_BASE_URL,
  KIMI_ACCOUNT_TOKEN_KEY,
  BATON_KIMI_MODELS_MARK,
} from "../src/lib/kimi-account.js";

const TOKEN = "test-kimi-access-token-not-for-prod";
const REFRESH = "test-kimi-refresh-token-not-for-prod";
const MODEL_IDS = ["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"];

function tmp(prefix = "baton-kimi-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function capture() {
  const chunks = [];
  return {
    chunks,
    write(s) { chunks.push(String(s)); },
    text() { return chunks.join(""); },
  };
}

function writeAuth(home, token = TOKEN, { map = false, active = "acc-1" } = {}) {
  const dir = path.join(home, ".opencodex");
  fs.mkdirSync(dir, { recursive: true });
  const cred = { access: token, refresh: REFRESH, expires: Date.now() + 3_600_000 };
  const account = { id: "acc-1", credential: cred };
  const kimi = map
    ? { activeAccountId: active, accounts: { "acc-1": { credential: cred } } }
    : { activeAccountId: active, accounts: [account] };
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ kimi }), "utf8");
}

function assertWired(home, token = TOKEN) {
  const envFile = path.join(home, ".baton", "kimi-account.env");
  assert.ok(fs.existsSync(envFile), "kimi-account.env");
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(envFile, "utf8"), `${KIMI_ACCOUNT_TOKEN_KEY}=${token}\n`);

  const grokEnv = fs.readFileSync(path.join(home, ".grok", ".env"), "utf8");
  assert.match(grokEnv, /kimi-account\.env/);
  assert.ok(grokEnv.includes(GROK_ENV_SOURCE_LINE));
  assert.doesNotMatch(grokEnv, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const cfg = fs.readFileSync(path.join(home, ".grok", "config.toml"), "utf8");
  assert.match(cfg, new RegExp(BATON_KIMI_MODELS_MARK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const id of MODEL_IDS) {
    assert.match(cfg, new RegExp(`\\[model\\."${id}"\\]`));
    assert.match(cfg, new RegExp(`model = "${id}"`));
    assert.match(cfg, new RegExp(`name = "${id}"`));
  }
  assert.match(cfg, /context_window = 1048576/);
  assert.match(cfg, /context_window = 262144/);
  assert.match(cfg, new RegExp(`base_url = "${KIMI_CODING_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(cfg, new RegExp(`env_key = "${KIMI_ACCOUNT_TOKEN_KEY}"`));
  assert.match(cfg, /api_backend = "chat_completions"/);
  assert.doesNotMatch(cfg, /api_key\s*=/);
  assert.doesNotMatch(cfg, /openai_base_url/);
  assert.doesNotMatch(cfg, /\[model\."grok/);
  assert.doesNotMatch(cfg, /\[model\.grok/);
  assert.doesNotMatch(cfg, /mimo/);
  assert.doesNotMatch(cfg, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

function assertNotWired(home) {
  assert.ok(!fs.existsSync(path.join(home, ".baton", "kimi-account.env")));
  assert.ok(!fs.existsSync(path.join(home, ".grok", "config.toml")));
}

describe("kimi-account lib", () => {
  it("reads the active account access token from an injectable HOME store", () => {
    const home = tmp("baton-kimi-store-");
    writeAuth(home);
    assert.equal(readKimiAccountToken({ home }), TOKEN);
    assert.equal(readKimiAccountToken({ env: { HOME: home } }), TOKEN);
  });

  it("reads accounts as a map and honors authPath", () => {
    const home = tmp("baton-kimi-map-");
    writeAuth(home, TOKEN, { map: true });
    assert.equal(readKimiAccountToken({ home }), TOKEN);
    const custom = path.join(home, "custom-auth.json");
    fs.writeFileSync(custom, JSON.stringify({
      kimi: {
        activeAccountId: "slot-b",
        accounts: [
          { id: "slot-a", credential: { access: "wrong-token" } },
          { id: "slot-b", credential: { access: TOKEN, refresh: REFRESH, expires: 1 } },
        ],
      },
    }), "utf8");
    assert.equal(readKimiAccountToken({ authPath: custom }), TOKEN);
  });

  it("returns null when the store has no kimi account", () => {
    const home = tmp("baton-kimi-empty-");
    assert.equal(readKimiAccountToken({ home }), null);
    fs.mkdirSync(path.join(home, ".opencodex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".opencodex", "auth.json"), "{}", "utf8");
    assert.equal(readKimiAccountToken({ home }), null);
  });

  it("writes kimi-account.env 0600 and upserts four Grok models without touching default", () => {
    const home = tmp("baton-kimi-wire-");
    writeAuth(home);
    fs.mkdirSync(path.join(home, ".grok"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".grok", "config.toml"),
      `[models]\ndefault = "grok-build"\nweb_search = "grok-4.6"\n\n[session]\nload_envrc = true\n`,
      "utf8",
    );
    const result = wireKimiAccountToGrok({ home });
    assert.equal(result.wired, true);
    assert.ok(result.files.every((f) => !String(f).includes(TOKEN)));
    assertWired(home);
    const cfg = fs.readFileSync(path.join(home, ".grok", "config.toml"), "utf8");
    assert.match(cfg, /\[models\]/);
    assert.match(cfg, /default = "grok-build"/);
    assert.match(cfg, /web_search = "grok-4.6"/);
    assert.match(cfg, /\[session\]/);
    assert.match(cfg, /load_envrc = true/);
    assert.doesNotMatch(cfg, /\[model\."grok-build"\]/);
    assert.doesNotMatch(cfg, /\[model\."grok-4.6"\]/);
  });

  it("upsert is idempotent and replaces a previous marked block", () => {
    const home = tmp("baton-kimi-upsert-");
    writeAuth(home);
    wireKimiAccountToGrok({ home });
    const first = fs.readFileSync(path.join(home, ".grok", "config.toml"), "utf8");
    fs.writeFileSync(
      path.join(home, ".grok", "config.toml"),
      first.replace("context_window = 1048576", "context_window = 1"),
      "utf8",
    );
    wireKimiAccountToGrok({ home });
    const again = fs.readFileSync(path.join(home, ".grok", "config.toml"), "utf8");
    assert.equal((again.match(/# baton-kimi-account-models/g) || []).length, 1);
    assert.equal((again.match(/\[model\."k3"\]/g) || []).length, 1);
    assert.match(again, /context_window = 1048576/);
    assert.doesNotMatch(again, /^context_window = 1$/m);
  });

  it("does not write when there is no kimi account", () => {
    const home = tmp("baton-kimi-nowire-");
    const result = wireKimiAccountToGrok({ home });
    assert.equal(result.wired, false);
    assertNotWired(home);
  });

  it("writeKimiAccountEnv uses mode 0600", () => {
    const home = tmp("baton-kimi-mode-");
    const dest = writeKimiAccountEnv(TOKEN, { home });
    assert.equal(dest, kimiAccountEnvPath({ home }));
    assert.equal(fs.statSync(dest).mode & 0o777, 0o600);
  });
});

describe("init --tools grok wires only when a kimi account exists", () => {
  it("does not write grok model tables or the env file without a kimi account", () => {
    withHome((home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      initProject(cwd, { tools: ["grok"], env });
      assert.ok(fs.existsSync(path.join(home, ".grok", "agents", "k3.md")));
      assertNotWired(home);
    });
  });

  it("wires env + four models when the login store already has a kimi account", () => {
    withHome((home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      writeAuth(home);
      const out = capture();
      const err = capture();
      const result = initProject(cwd, { tools: ["grok"], env });
      assertWired(home);
      assert.ok(result.created.some((f) => String(f).includes("kimi-account.env")));
      assert.ok(result.created.some((f) => String(f).includes("config.toml") && String(f).includes("grok")));
      const visible = JSON.stringify(result) + out.text() + err.text();
      assert.doesNotMatch(visible, new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.ok(!fs.existsSync(path.join(home, ".codex", "config.toml")));
    });
  });

  it("init --tools claude does not write grok config even if a kimi account exists", () => {
    withHome((home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      writeAuth(home);
      initProject(cwd, { tools: ["claude"], env });
      assert.ok(!fs.existsSync(path.join(home, ".grok")));
      assert.ok(!fs.existsSync(path.join(home, ".baton", "kimi-account.env")));
    });
  });
});

describe("baton login kimi wires Grok to the account token", () => {
  it("after a successful kimi login, writes env 0600 and the four models", async () => {
    await withHome(async (home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      const out = capture();
      const err = capture();
      const resolve = () => ({ source: "path", command: "/tmp/ocx", prefixArgs: [] });
      const runner = ({ args }) => {
        if (args[0] === "account" && args[1] === "login" && args[2] === "kimi") {
          writeAuth(home);
          return { status: 0, stdout: "login kimi\n", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "unexpected " + args.join(" ") };
      };
      const starts = [];
      const startProxy = () => {
        starts.push(true);
        return { status: 0, started: true };
      };
      const code = await run(["login", "kimi"], {
        cwd, stdout: out, stderr: err, env, resolve, runner, startProxy,
      });
      assert.equal(code, 0);
      assert.equal(starts.length, 0);
      assertWired(home);
      const visible = out.text() + err.text();
      assert.doesNotMatch(visible, new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(visible, new RegExp(REFRESH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.ok(!fs.existsSync(path.join(home, ".codex", "config.toml")));
      assert.doesNotMatch(fs.readFileSync(grokConfigPath({ home }), "utf8"), /openai_base_url/);
    });
  });

  it("login --card k3 also wires after a successful kimi login", async () => {
    await withHome(async (home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      initProject(cwd, { tools: ["claude"], env });
      const out = capture();
      const resolve = () => ({ source: "path", command: "/tmp/ocx", prefixArgs: [] });
      const runner = ({ args }) => {
        if (args[0] === "account" && args[1] === "login" && args[2] === "kimi") {
          writeAuth(home);
          return { status: 0, stdout: "login kimi\n", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "unexpected" };
      };
      const code = await run(["login", "--card", "k3"], {
        cwd, stdout: out, stderr: capture(), env, resolve, runner,
      });
      assert.equal(code, 0);
      assertWired(home);
      assert.doesNotMatch(out.text(), new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });
  });

  it("failed kimi login does not write the env file", async () => {
    await withHome(async (home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      const resolve = () => ({ source: "path", command: "/tmp/ocx", prefixArgs: [] });
      const runner = () => ({ status: 1, stdout: "", stderr: "login failed" });
      const code = await run(["login", "kimi"], {
        cwd, stdout: capture(), stderr: capture(), env, resolve, runner,
      });
      assert.equal(code, 1);
      assertNotWired(home);
    });
  });

  it("login grok does not write kimi-account files", async () => {
    await withHome(async (home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      const resolve = () => ({ source: "path", command: "/tmp/ocx", prefixArgs: [] });
      const runner = ({ args }) => {
        if (args[0] === "account" && args[1] === "login" && args[2] === "xai") {
          return { status: 0, stdout: "login xai\n", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "unexpected" };
      };
      const code = await run(["login", "grok"], {
        cwd, stdout: capture(), stderr: capture(), env, resolve, runner,
      });
      assert.equal(code, 0);
      assertNotWired(home);
    });
  });

  it("does not rewrite an existing ~/.codex/config.toml", async () => {
    await withHome(async (home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      const codexCfg = path.join(home, ".codex", "config.toml");
      fs.mkdirSync(path.dirname(codexCfg), { recursive: true });
      fs.writeFileSync(codexCfg, "model = \"gpt-5\"\n", "utf8");
      const resolve = () => ({ source: "path", command: "/tmp/ocx", prefixArgs: [] });
      const runner = ({ args }) => {
        if (args[0] === "account" && args[1] === "login") {
          writeAuth(home);
          return { status: 0, stdout: "login kimi\n", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "unexpected" };
      };
      const code = await run(["login", "kimi"], {
        cwd, stdout: capture(), stderr: capture(), env, resolve, runner,
      });
      assert.equal(code, 0);
      assert.equal(fs.readFileSync(codexCfg, "utf8"), "model = \"gpt-5\"\n");
    });
  });
});
