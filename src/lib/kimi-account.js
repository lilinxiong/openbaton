/**
 * Wire Grok custom models to the logged-in Kimi account token.
 * Reads ~/.opencodex/auth.json (injectable path/HOME). Refreshes the
 * OIDC access token when it expires within ~120s. Writes
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
export const KIMI_TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
export const KIMI_OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
export const REFRESH_SKEW_MS = 120_000;
export const EXPIRES_WRITE_SKEW_MS = 5 * 60 * 1000;
export const KIMI_REFRESH_ERROR = "KIMI_REFRESH_FAILED";

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

export class KimiRefreshError extends Error {
  constructor(message, extras = {}) {
    super(message);
    this.name = "KimiRefreshError";
    this.code = extras.code || KIMI_REFRESH_ERROR;
    if (extras.status != null) this.status = extras.status;
  }
}

export function isKimiAccountModel(id) {
  return KIMI_ACCOUNT_MODEL_IDS.has(String(id || "").trim());
}

function accountIdOf(account, fallback) {
  if (!account || typeof account !== "object") return fallback || "";
  const id = account.id || account.accountId || account.account_id;
  return id == null ? fallback || "" : String(id);
}

function credentialOf(account) {
  if (!account || typeof account !== "object") return {};
  if (account.credential && typeof account.credential === "object") return account.credential;
  return account;
}

function accessOf(account) {
  const cred = credentialOf(account);
  const access = cred.access || cred.access_token || cred.token;
  return access == null ? "" : String(access).trim();
}

function refreshOf(account) {
  const cred = credentialOf(account);
  const refresh = cred.refresh || cred.refresh_token;
  return refresh == null ? "" : String(refresh).trim();
}

function expiresOf(account) {
  const cred = credentialOf(account);
  const expires = cred.expires;
  if (expires == null || expires === "") return null;
  const n = Number(expires);
  return Number.isFinite(n) ? n : null;
}

function summarizeAccount(account, fallbackId) {
  const cred = credentialOf(account);
  return {
    id: accountIdOf(account, fallbackId),
    access: accessOf(account),
    refresh: refreshOf(account),
    expires: expiresOf(account),
    accountId: cred.accountId == null ? undefined : cred.accountId,
    source: cred.source == null ? undefined : cred.source,
  };
}

function listAccounts(kimi) {
  const raw = kimi && kimi.accounts;
  if (Array.isArray(raw)) {
    return raw
      .filter((a) => a && typeof a === "object")
      .map((a) => summarizeAccount(a));
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw).map(([key, a]) => summarizeAccount(a, key));
  }
  if (kimi && typeof kimi === "object") {
    const direct = summarizeAccount(kimi, "kimi");
    if (direct.access || direct.refresh) return [direct];
  }
  return [];
}

function readAuthStore(opts = {}) {
  const file = authStorePath(opts);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    return raw;
  } catch {
    return null;
  }
}

function pickActiveAccount(kimi) {
  if (!kimi || typeof kimi !== "object") return null;
  const accounts = listAccounts(kimi);
  if (!accounts.length) return null;
  const activeId = kimi.activeAccountId == null ? "" : String(kimi.activeAccountId);
  const active = activeId ? accounts.find((a) => a.id === activeId && a.access) : null;
  if (active) return active;
  return accounts.find((a) => a.access) || accounts[0] || null;
}

/**
 * Read the active Kimi account credential from the login store.
 * Never logs tokens.
 */
export function readKimiAccount(opts = {}) {
  const raw = readAuthStore(opts);
  if (!raw) return null;
  const account = pickActiveAccount(raw.kimi);
  return account || null;
}

/**
 * Read the active Kimi OAuth access token from the login store.
 * Returns the token string or null. Never logs it.
 */
export function readKimiAccountToken(opts = {}) {
  const account = readKimiAccount(opts);
  return account && account.access ? account.access : null;
}

export function hasKimiAccount(opts = {}) {
  return Boolean(readKimiAccountToken(opts));
}

export function tokenNeedsRefresh(expires, opts = {}) {
  const now = opts.now != null ? Number(opts.now) : Date.now();
  const skew = opts.skewMs != null ? Number(opts.skewMs) : REFRESH_SKEW_MS;
  if (expires == null || expires === "") return true;
  const exp = Number(expires);
  if (!Number.isFinite(exp)) return true;
  return exp <= now + (Number.isFinite(skew) ? skew : REFRESH_SKEW_MS);
}

function tokenUrlOf(opts = {}) {
  if (opts.tokenUrl) return String(opts.tokenUrl);
  const env = optsEnv(opts);
  if (env.BATON_KIMI_TOKEN_URL) return String(env.BATON_KIMI_TOKEN_URL);
  return KIMI_TOKEN_URL;
}

function refreshFailed(status) {
  const suffix = status != null ? ` (${status})` : "";
  return new KimiRefreshError(
    `Kimi account token refresh failed${suffix}. Sign in again: baton login kimi`,
    { code: KIMI_REFRESH_ERROR, status },
  );
}

/**
 * POST grant_type=refresh_token. Never includes tokens in thrown errors.
 */
export async function refreshKimiOidcToken(opts = {}) {
  const refreshToken = opts.refreshToken == null ? "" : String(opts.refreshToken).trim();
  if (!refreshToken) {
    throw new KimiRefreshError(
      "Kimi account has no refresh token. Sign in again: baton login kimi",
      { code: "KIMI_NO_REFRESH" },
    );
  }
  const url = tokenUrlOf(opts);
  const clientId = opts.clientId || KIMI_OAUTH_CLIENT_ID;
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const fetchImpl = opts.fetch || fetch;
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch {
    throw refreshFailed();
  }
  if (!res || !res.ok) {
    throw refreshFailed(res && res.status);
  }
  let data;
  try {
    data = typeof res.json === "function" ? await res.json() : JSON.parse(String(res.body || ""));
  } catch {
    throw new KimiRefreshError(
      "Kimi account token refresh failed (invalid response). Sign in again: baton login kimi",
      { code: "KIMI_REFRESH_INVALID" },
    );
  }
  const access = data && (data.access_token || data.access);
  if (!access) {
    throw new KimiRefreshError(
      "Kimi account token refresh failed (invalid response). Sign in again: baton login kimi",
      { code: "KIMI_REFRESH_INVALID" },
    );
  }
  const rotated = data.refresh_token || data.refresh;
  const nextRefresh = rotated == null || String(rotated).trim() === ""
    ? refreshToken
    : String(rotated);
  const expiresIn = Number(data.expires_in);
  const now = opts.now != null ? Number(opts.now) : Date.now();
  const ttlMs = Number.isFinite(expiresIn) ? expiresIn * 1000 : 900_000;
  return {
    access: String(access),
    refresh: String(nextRefresh),
    expires: now + ttlMs - EXPIRES_WRITE_SKEW_MS,
  };
}

function patchActiveCredential(raw, patch) {
  const kimi = raw.kimi;
  if (!kimi || typeof kimi !== "object") return false;
  const apply = (account) => {
    if (!account || typeof account !== "object") return false;
    if (!account.credential || typeof account.credential !== "object") {
      account.credential = {};
    }
    const cred = account.credential;
    cred.access = patch.access;
    if (patch.refresh) cred.refresh = patch.refresh;
    cred.expires = patch.expires;
    if (cred.accountId == null && account.id != null) cred.accountId = account.id;
    if (!cred.source) cred.source = "oauth";
    return true;
  };
  const activeId = kimi.activeAccountId == null ? "" : String(kimi.activeAccountId);
  const accounts = kimi.accounts;
  if (Array.isArray(accounts)) {
    const hit = (activeId && accounts.find((a) => accountIdOf(a) === activeId))
      || accounts.find((a) => accessOf(a) || refreshOf(a));
    return apply(hit);
  }
  if (accounts && typeof accounts === "object") {
    const hit = (activeId && accounts[activeId])
      || Object.values(accounts).find((a) => a && typeof a === "object");
    return apply(hit);
  }
  return apply(kimi);
}

export function writeKimiAccountCredential(patch, opts = {}) {
  const file = authStorePath(opts);
  const raw = readAuthStore(opts);
  if (!raw) {
    throw new KimiRefreshError(
      "Kimi account token refresh failed (no login store). Sign in again: baton login kimi",
      { code: "KIMI_NO_STORE" },
    );
  }
  if (!patchActiveCredential(raw, patch)) {
    throw new KimiRefreshError(
      "Kimi account token refresh failed (no login store). Sign in again: baton login kimi",
      { code: "KIMI_NO_STORE" },
    );
  }
  const body = JSON.stringify(raw, null, 2) + "\n";
  fs.writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/**
 * Refresh when the access token expires within ~120s, then write
 * ~/.baton/kimi-account.env. Writes new access+refresh+expires back
 * to the login store. Never returns the token to callers that print.
 */
export async function ensureFreshKimiAccount(opts = {}) {
  const account = readKimiAccount(opts);
  if (!account || (!account.access && !account.refresh)) {
    return { refreshed: false, wired: false, files: [] };
  }
  let cred = account;
  let refreshed = false;
  if (tokenNeedsRefresh(account.expires, opts)) {
    const next = await refreshKimiOidcToken({
      ...opts,
      refreshToken: account.refresh,
    });
    writeKimiAccountCredential(next, opts);
    cred = { ...account, ...next };
    refreshed = true;
  }
  const envFile = writeKimiAccountEnv(cred.access, opts);
  return {
    refreshed,
    wired: true,
    files: [envFile],
    expires: cred.expires,
  };
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
 * If the login store has a Kimi account, refresh if needed, write the
 * env file and Grok models. Returns { wired, refreshed, files } —
 * files are display paths, never the token.
 */
export async function wireKimiAccountToGrok(opts = {}) {
  const fresh = await ensureFreshKimiAccount(opts);
  if (!fresh.wired) return { wired: false, refreshed: false, files: [] };
  const grokEnv = ensureGrokEnvSource(opts);
  const grokConfig = upsertGrokKimiModels(opts);
  const env = optsEnv(opts);
  const cwd = opts.cwd;
  const envFile = fresh.files[0] || kimiAccountEnvPath(opts);
  return {
    wired: true,
    refreshed: Boolean(fresh.refreshed),
    files: [envFile, grokEnv, grokConfig].map((f) => displayHomePath(f, { cwd, env })),
  };
}
