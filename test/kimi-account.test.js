import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";
import { withHome, fakeEnv } from "./home.js";
import http from "node:http";
import {
  readKimiAccountToken,
  writeKimiAccountEnv,
  wireKimiAccountToGrok,
  ensureFreshKimiAccount,
  kimiAccountEnvPath,
  grokConfigPath,
  authStorePath,
  GROK_ENV_SOURCE_LINE,
  KIMI_CODING_BASE_URL,
  KIMI_ACCOUNT_TOKEN_KEY,
  BATON_KIMI_MODELS_MARK,
  KIMI_OAUTH_CLIENT_ID,
  EXPIRES_WRITE_SKEW_MS,
  KimiRefreshError,
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

function writeAuth(home, token = TOKEN, { map = false, active = "acc-1", expires = Date.now() + 3_600_000, refresh = REFRESH, extra = {} } = {}) {
  const dir = path.join(home, ".opencodex");
  fs.mkdirSync(dir, { recursive: true });
  const cred = { access: token, refresh, expires, accountId: "acc-1", source: "oauth", ...extra };
  const account = { id: "acc-1", credential: cred };
  const kimi = map
    ? { activeAccountId: active, accounts: { "acc-1": { credential: cred } } }
    : { activeAccountId: active, accounts: [account] };
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ kimi }), "utf8");
}

const NEXT_ACCESS = "rotated-kimi-access-token-not-for-prod";
const NEXT_REFRESH = "rotated-kimi-refresh-token-not-for-prod";

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertNoSecrets(text, extras = []) {
  const visible = String(text);
  for (const secret of [TOKEN, REFRESH, NEXT_ACCESS, NEXT_REFRESH, ...extras]) {
    assert.doesNotMatch(visible, new RegExp(escapeRe(secret)));
  }
}

function readStore(home) {
  return JSON.parse(fs.readFileSync(path.join(home, ".opencodex", "auth.json"), "utf8"));
}

function startTokenServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const rec = {
        method: req.method,
        url: req.url,
        contentType: req.headers["content-type"] || "",
        params: Object.fromEntries(new URLSearchParams(raw)),
      };
      requests.push(rec);
      const out = handler(rec) || {};
      const status = out.status || 200;
      const body = out.body == null ? "" : (typeof out.body === "string" ? out.body : JSON.stringify(out.body));
      res.writeHead(status, { "Content-Type": out.contentType || "application/json" });
      res.end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/api/oauth/token`,
        requests,
        close: () => new Promise((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
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

  it("writes kimi-account.env 0600 and upserts four Grok models without touching default", async () => {
    const home = tmp("baton-kimi-wire-");
    writeAuth(home);
    fs.mkdirSync(path.join(home, ".grok"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".grok", "config.toml"),
      `[models]\ndefault = "grok-build"\nweb_search = "grok-4.6"\n\n[session]\nload_envrc = true\n`,
      "utf8",
    );
    const result = await wireKimiAccountToGrok({ home });
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

  it("upsert is idempotent and replaces a previous marked block", async () => {
    const home = tmp("baton-kimi-upsert-");
    writeAuth(home);
    await wireKimiAccountToGrok({ home });
    const first = fs.readFileSync(path.join(home, ".grok", "config.toml"), "utf8");
    fs.writeFileSync(
      path.join(home, ".grok", "config.toml"),
      first.replace("context_window = 1048576", "context_window = 1"),
      "utf8",
    );
    await wireKimiAccountToGrok({ home });
    const again = fs.readFileSync(path.join(home, ".grok", "config.toml"), "utf8");
    assert.equal((again.match(/# baton-kimi-account-models/g) || []).length, 1);
    assert.equal((again.match(/\[model\."k3"\]/g) || []).length, 1);
    assert.match(again, /context_window = 1048576/);
    assert.doesNotMatch(again, /^context_window = 1$/m);
  });

  it("does not write when there is no kimi account", async () => {
    const home = tmp("baton-kimi-nowire-");
    const result = await wireKimiAccountToGrok({ home });
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
  it("does not write grok model tables or the env file without a kimi account", async () => {
    await withHome(async (home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      await initProject(cwd, { tools: ["grok"], env });
      assert.ok(fs.existsSync(path.join(home, ".grok", "agents", "k3.md")));
      assertNotWired(home);
    });
  });

  it("wires env + four models when the login store already has a kimi account", async () => {
    await withHome(async (home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      writeAuth(home);
      const out = capture();
      const err = capture();
      const result = await initProject(cwd, { tools: ["grok"], env });
      assertWired(home);
      assert.ok(result.created.some((f) => String(f).includes("kimi-account.env")));
      assert.ok(result.created.some((f) => String(f).includes("config.toml") && String(f).includes("grok")));
      const visible = JSON.stringify(result) + out.text() + err.text();
      assert.doesNotMatch(visible, new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.ok(!fs.existsSync(path.join(home, ".codex", "config.toml")));
    });
  });

  it("init --tools claude does not write grok config even if a kimi account exists", async () => {
    await withHome(async (home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      writeAuth(home);
      await initProject(cwd, { tools: ["claude"], env });
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

describe("kimi OIDC refresh", () => {
  it("expired access token refreshes, rotates refresh, writes store 0600 and env 0600", async () => {
    const now = 1_700_000_000_000;
    const server = await startTokenServer(() => ({
      status: 200,
      body: { access_token: NEXT_ACCESS, refresh_token: NEXT_REFRESH, expires_in: 900 },
    }));
    try {
      const home = tmp("baton-kimi-expired-");
      writeAuth(home, TOKEN, { expires: now - 1_000 });
      const result = await wireKimiAccountToGrok({ home, tokenUrl: server.url, now });
      assert.equal(result.wired, true);
      assert.equal(result.refreshed, true);
      assert.equal(server.requests.length, 1);
      const req = server.requests[0];
      assert.equal(req.method, "POST");
      assert.match(req.contentType, /application\/x-www-form-urlencoded/);
      assert.equal(req.params.grant_type, "refresh_token");
      assert.equal(req.params.client_id, KIMI_OAUTH_CLIENT_ID);
      assert.equal(req.params.refresh_token, REFRESH);
      assertWired(home, NEXT_ACCESS);
      const store = readStore(home);
      assert.equal(store.kimi.activeAccountId, "acc-1");
      const cred = store.kimi.accounts[0].credential;
      assert.equal(cred.access, NEXT_ACCESS);
      assert.equal(cred.refresh, NEXT_REFRESH);
      assert.equal(cred.expires, now + 900_000 - EXPIRES_WRITE_SKEW_MS);
      assert.equal(cred.accountId, "acc-1");
      assert.equal(cred.source, "oauth");
      const authFile = authStorePath({ home });
      assert.equal(fs.statSync(authFile).mode & 0o777, 0o600);
      const raw = fs.readFileSync(authFile, "utf8");
      assert.equal(raw, JSON.stringify(store, null, 2) + "\n");
      assert.ok(result.files.every((f) => !String(f).includes(TOKEN)));
      assert.ok(result.files.every((f) => !String(f).includes(NEXT_ACCESS)));
    } finally {
      await server.close();
    }
  });

  it("unexpired access token does not call the token endpoint", async () => {
    const now = 1_700_000_000_000;
    const server = await startTokenServer(() => {
      throw new Error("token endpoint should not be called");
    });
    try {
      const home = tmp("baton-kimi-fresh-");
      writeAuth(home, TOKEN, { expires: now + 3_600_000 });
      const before = fs.readFileSync(path.join(home, ".opencodex", "auth.json"), "utf8");
      const result = await wireKimiAccountToGrok({ home, tokenUrl: server.url, now });
      assert.equal(result.wired, true);
      assert.equal(result.refreshed, false);
      assert.equal(server.requests.length, 0);
      assert.equal(fs.readFileSync(path.join(home, ".opencodex", "auth.json"), "utf8"), before);
      assertWired(home, TOKEN);
    } finally {
      await server.close();
    }
  });

  it("token expiring within 120s is refreshed", async () => {
    const now = 1_700_000_000_000;
    const server = await startTokenServer(() => ({
      status: 200,
      body: { access_token: NEXT_ACCESS, refresh_token: NEXT_REFRESH, expires_in: 900 },
    }));
    try {
      const home = tmp("baton-kimi-skew-");
      writeAuth(home, TOKEN, { expires: now + 60_000 });
      const result = await ensureFreshKimiAccount({ home, tokenUrl: server.url, now });
      assert.equal(result.refreshed, true);
      assert.equal(server.requests.length, 1);
      assert.equal(readKimiAccountToken({ home }), NEXT_ACCESS);
    } finally {
      await server.close();
    }
  });

  it("401 refresh is a clean error and does not leak tokens or rewrite the store", async () => {
    const now = 1_700_000_000_000;
    const server = await startTokenServer(() => ({
      status: 401,
      body: {
        error: "invalid_grant",
        error_description: `leaked ${REFRESH} ${TOKEN}`,
        refresh_token: REFRESH,
        access_token: TOKEN,
      },
    }));
    try {
      const home = tmp("baton-kimi-401-");
      writeAuth(home, TOKEN, { expires: now - 1 });
      const before = fs.readFileSync(path.join(home, ".opencodex", "auth.json"), "utf8");
      await assert.rejects(
        () => wireKimiAccountToGrok({ home, tokenUrl: server.url, now }),
        (err) => {
          assert.ok(err instanceof KimiRefreshError);
          assert.equal(err.status, 401);
          assert.match(err.message, /401/);
          assert.match(err.message, /baton login kimi/);
          assertNoSecrets(err.message);
          assertNoSecrets(err.stack || "");
          return true;
        },
      );
      assert.equal(fs.readFileSync(path.join(home, ".opencodex", "auth.json"), "utf8"), before);
      assert.ok(!fs.existsSync(path.join(home, ".baton", "kimi-account.env")));
      assert.equal(server.requests.length, 1);
    } finally {
      await server.close();
    }
  });

  it("spawn refreshes an expired token before the k3 ticket and never prints it", async () => {
    const now = Date.now();
    const server = await startTokenServer(() => ({
      status: 200,
      body: { access_token: NEXT_ACCESS, refresh_token: NEXT_REFRESH, expires_in: 900 },
    }));
    try {
      await withHome(async (home) => {
        const cwd = tmp();
        const env = fakeEnv(home, { BATON_KIMI_TOKEN_URL: server.url });
        writeAuth(home, TOKEN, { expires: now + 3_600_000 });
        await initProject(cwd, { tools: ["grok"], env });
        writeAuth(home, TOKEN, { expires: now - 1_000 });
        const out = capture();
        const err = capture();
        const code = await run(["spawn", "flagship Kimi K3 large repo refactor"], {
          cwd, stdout: out, stderr: err, env,
        });
        assert.equal(code, 0);
        assert.match(out.text(), /k3/);
        assert.equal(server.requests.length, 1);
        assert.equal(readKimiAccountToken({ home }), NEXT_ACCESS);
        assert.equal(fs.readFileSync(path.join(home, ".baton", "kimi-account.env"), "utf8"), `${KIMI_ACCOUNT_TOKEN_KEY}=${NEXT_ACCESS}\n`);
        assertNoSecrets(out.text() + err.text());
      });
    } finally {
      await server.close();
    }
  });
});
