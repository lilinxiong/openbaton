/**
 * Wire Grok custom models to the logged-in Kimi account token.
 * Reads ~/.opencodex/auth.json (injectable path/HOME). Writes
 * ~/.baton/kimi-account.env and upserts marked [model.*] blocks in
 * ~/.grok/config.toml. Never prints the token. Never writes api_key
 * inline. Never starts a proxy. Never edits ~/.codex/config.toml.
 */
import fs from "node:fs";
import path from "node:path";
import { hostHome, batonHomeDir, displayHomePath } from "./paths.js";

export const KIMI_ACCOUNT_ENV_NAME = "kimi-account.env";
export const KIMI_ACCOUNT_TOKEN_KEY = "KIMI_ACCOUNT_TOKEN";
export const BATON_KIMI_MODELS_MARK = "# baton-kimi-account-models";
export const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/v1";
export const GROK_ENV_SOURCE_LINE =
  `[ -f "$HOME/.baton/kimi-account.env" ] && . "$HOME/.baton/kimi-account.env"`;

export const KIMI_ACCOUNT_MODELS = [
  { id: "k3", context_window: 1048576 },
  { id: "k3-256k", context_window: 262144 },
  { id: "kimi-for-coding", context_window: 262144 },
  { id: "kimi-for-coding-highspeed", context_window: 262144 },
];

const KIMI_ACCOUNT_MODEL_IDS = new Set(KIMI_ACCOUNT_MODELS.map((m) => m.id));

function optsHome(opts = {}) {
  if (opts.home) return opts.home;
  return hostHome(opts.env);
}

function optsEnv(opts = {}) {
  const e = { ...(opts.env || process.env || {}) };
  if (opts.home) e.HOME = opts.home;
  return e;
}

export function authStorePath(opts = {}) {
  if (opts.authPath) return opts.authPath;
  const env = optsEnv(opts);
  if (env.OPENCODEX_HOME) return path.join(env.OPENCODEX_HOME, "auth.json");
  return path.join(optsHome(opts), ".opencodex", "auth.json");
}

export function kimiAccountEnvPath(opts = {}) {
  return path.join(batonHomeDir(optsEnv(opts)), KIMI_ACCOUNT_ENV_NAME);
}

export function grokEnvPath(opts = {}) {
  return path.join(optsHome(opts), ".grok", ".env");
}

export function grokConfigPath(opts = {}) {
  return path.join(optsHome(opts), ".grok", "config.toml");
}

function accountIdOf(account, fallback) {
  if (!account || typeof account !== "object") return fallback || "";
  const id = account.id || account.accountId || account.account_id;
  return id == null ? fallback || "" : String(id);
}

function accessOf(account) {
  if (!account || typeof account !== "object") return "";
  const cred = account.credential && typeof account.credential === "object"
    ? account.credential
    : account;
  const access = cred.access || cred.access_token || cred.token;
  return access == null ? "" : String(access).trim();
}

function listAccounts(kimi) {
  const raw = kimi && kimi.accounts;
  if (Array.isArray(raw)) {
    return raw
      .filter((a) => a && typeof a === "object")
      .map((a) => ({ id: accountIdOf(a), access: accessOf(a) }));
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw).map(([key, a]) => ({
      id: accountIdOf(a, key),
      access: accessOf(a),
    }));
  }
  const direct = accessOf(kimi);
  if (direct) return [{ id: accountIdOf(kimi, "kimi"), access: direct }];
  return [];
}

/**
 * Read the active Kimi OAuth access token from the login store.
 * Returns the token string or null. Never logs it.
 */
export function readKimiAccountToken(opts = {}) {
  const file = authStorePath(opts);
  if (!fs.existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const kimi = raw.kimi;
  if (!kimi || typeof kimi !== "object") return null;
  const accounts = listAccounts(kimi);
  if (!accounts.length) return null;
  const activeId = kimi.activeAccountId == null ? "" : String(kimi.activeAccountId);
  const active = activeId ? accounts.find((a) => a.id === activeId && a.access) : null;
  if (active) return active.access;
  const first = accounts.find((a) => a.access);
  return first ? first.access : null;
}

export function hasKimiAccount(opts = {}) {
  return Boolean(readKimiAccountToken(opts));
}

export function writeKimiAccountEnv(token, opts = {}) {
  const dest = kimiAccountEnvPath(opts);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const body = `${KIMI_ACCOUNT_TOKEN_KEY}=${token}\n`;
  fs.writeFileSync(dest, body, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(dest, 0o600);
  return dest;
}

export function ensureGrokEnvSource(opts = {}) {
  const dest = grokEnvPath(opts);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let text = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : "";
  if (text.includes("kimi-account.env")) return dest;
  if (text && !text.endsWith("\n")) text += "\n";
  text += GROK_ENV_SOURCE_LINE + "\n";
  fs.writeFileSync(dest, text, "utf8");
  return dest;
}

function isTableHeader(line) {
  return /^\[[^\]]+\]\s*$/.test(String(line || "").trim());
}

function ourModelTableId(line) {
  const m = String(line || "").trim().match(
    /^\[model\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9._+-]+))\]$/,
  );
  if (!m) return null;
  const id = m[1] || m[2] || m[3];
  return KIMI_ACCOUNT_MODEL_IDS.has(id) ? id : null;
}

function isMarkLine(line) {
  return String(line || "").trim() === BATON_KIMI_MODELS_MARK;
}

/** Remove a previous marked block and any leftover k3/kimi-for-coding tables. */
export function stripBatonKimiModelBlocks(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (isMarkLine(lines[i])) {
      i += 1;
      continue;
    }
    if (ourModelTableId(lines[i])) {
      i += 1;
      while (i < lines.length && !isTableHeader(lines[i]) && !isMarkLine(lines[i])) {
        i += 1;
      }
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }
  let joined = out.join("\n").replace(/\n{3,}/g, "\n\n");
  joined = joined.replace(/^\n+/, "").replace(/\s+$/, "");
  return joined;
}

export function renderKimiAccountModelBlocks() {
  const parts = [BATON_KIMI_MODELS_MARK];
  for (const m of KIMI_ACCOUNT_MODELS) {
    parts.push(
      `[model."${m.id}"]`,
      `model = "${m.id}"`,
      `base_url = "${KIMI_CODING_BASE_URL}"`,
      `name = "${m.id}"`,
      `env_key = "${KIMI_ACCOUNT_TOKEN_KEY}"`,
      `api_backend = "chat_completions"`,
      `context_window = ${m.context_window}`,
      "",
    );
  }
  return parts.join("\n").replace(/\n+$/, "\n");
}

export function upsertGrokKimiModels(opts = {}) {
  const dest = grokConfigPath(opts);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const prev = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : "";
  const kept = stripBatonKimiModelBlocks(prev);
  const block = renderKimiAccountModelBlocks();
  const body = kept ? `${kept}\n\n${block}` : block;
  const out = body.endsWith("\n") ? body : `${body}\n`;
  fs.writeFileSync(dest, out, "utf8");
  return dest;
}

/**
 * If the login store has a Kimi account, write the env file and Grok models.
 * Returns { wired, files } — files are display paths, never the token.
 */
export function wireKimiAccountToGrok(opts = {}) {
  const token = readKimiAccountToken(opts);
  if (!token) return { wired: false, files: [] };
  const envFile = writeKimiAccountEnv(token, opts);
  const grokEnv = ensureGrokEnvSource(opts);
  const grokConfig = upsertGrokKimiModels(opts);
  const env = optsEnv(opts);
  const cwd = opts.cwd;
  return {
    wired: true,
    files: [envFile, grokEnv, grokConfig].map((f) => displayHomePath(f, { cwd, env })),
  };
}
