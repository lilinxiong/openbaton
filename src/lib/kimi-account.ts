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
import type { UnknownRecord } from "../types.js";

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

export interface KimiAccountModel {
  id: string;
  context_window: number;
}

export const KIMI_ACCOUNT_MODELS: KimiAccountModel[] = [
  { id: "k3", context_window: 1048576 },
  { id: "k3-256k", context_window: 262144 },
  { id: "kimi-for-coding", context_window: 262144 },
  { id: "kimi-for-coding-highspeed", context_window: 262144 },
];

const KIMI_ACCOUNT_MODEL_IDS = new Set<string>(KIMI_ACCOUNT_MODELS.map((model) => model.id));

export interface KimiAccountOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  authPath?: string;
  now?: number;
  skewMs?: number;
  tokenUrl?: string;
  clientId?: string;
  refreshToken?: string;
  fetch?: KimiFetch;
  cwd?: string;
}

export interface KimiTokenResponse {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  body?: unknown;
}

export type KimiFetch = (url: string, init: RequestInit) => Promise<KimiTokenResponse>;

export interface KimiAccount {
  id: string;
  access: string;
  refresh: string;
  expires: number | null;
  accountId?: unknown;
  source?: unknown;
}

export interface KimiTokenRefreshResult {
  access: string;
  refresh: string;
  expires: number;
}

export interface EnsureFreshKimiResult {
  refreshed: boolean;
  wired: boolean;
  files: string[];
  expires?: number | null;
}

export interface WireKimiResult {
  wired: boolean;
  refreshed: boolean;
  files: string[];
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function optsHome(options: KimiAccountOptions = {}): string {
  if (options.home) return options.home;
  return hostHome(options.env);
}

function optsEnv(options: KimiAccountOptions = {}): NodeJS.ProcessEnv {
  const env = { ...(options.env || process.env) };
  if (options.home) env.HOME = options.home;
  return env;
}

export function authStorePath(options: KimiAccountOptions = {}): string {
  if (options.authPath) return options.authPath;
  const env = optsEnv(options);
  if (env.OPENCODEX_HOME) return path.join(env.OPENCODEX_HOME, "auth.json");
  return path.join(optsHome(options), ".opencodex", "auth.json");
}

export function kimiAccountEnvPath(options: KimiAccountOptions = {}): string {
  return path.join(batonHomeDir(optsEnv(options)), KIMI_ACCOUNT_ENV_NAME);
}

export function grokEnvPath(options: KimiAccountOptions = {}): string {
  return path.join(optsHome(options), ".grok", ".env");
}

export function grokConfigPath(options: KimiAccountOptions = {}): string {
  return path.join(optsHome(options), ".grok", "config.toml");
}

export interface KimiRefreshErrorOptions {
  code?: string;
  status?: number;
}

export class KimiRefreshError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(message: string, extras: KimiRefreshErrorOptions = {}) {
    super(message);
    this.name = "KimiRefreshError";
    this.code = extras.code || KIMI_REFRESH_ERROR;
    if (extras.status != null) this.status = extras.status;
  }
}

export function isKimiAccountModel(id: unknown): boolean {
  return KIMI_ACCOUNT_MODEL_IDS.has(stringValue(id).trim());
}

function accountIdOf(account: unknown, fallback = ""): string {
  if (!isRecord(account)) return fallback;
  const id = account.id ?? account.accountId ?? account.account_id;
  return id == null ? fallback : stringValue(id);
}

function credentialOf(account: unknown): UnknownRecord {
  if (!isRecord(account)) return {};
  return isRecord(account.credential) ? account.credential : account;
}

function accessOf(account: unknown): string {
  const credential = credentialOf(account);
  return stringValue(credential.access ?? credential.access_token ?? credential.token).trim();
}

function refreshOf(account: unknown): string {
  const credential = credentialOf(account);
  return stringValue(credential.refresh ?? credential.refresh_token).trim();
}

function expiresOf(account: unknown): number | null {
  const expires = credentialOf(account).expires;
  if (expires == null || expires === "") return null;
  const number = Number(expires);
  return Number.isFinite(number) ? number : null;
}

function summarizeAccount(account: unknown, fallbackId?: string): KimiAccount {
  const credential = credentialOf(account);
  return {
    id: accountIdOf(account, fallbackId || ""),
    access: accessOf(account),
    refresh: refreshOf(account),
    expires: expiresOf(account),
    accountId: credential.accountId,
    source: credential.source,
  };
}

function listAccounts(kimi: unknown): KimiAccount[] {
  const raw = isRecord(kimi) ? kimi.accounts : undefined;
  if (Array.isArray(raw)) {
    return raw.filter(isRecord).map((account) => summarizeAccount(account));
  }
  if (isRecord(raw)) {
    return Object.entries(raw).map(([key, account]) => summarizeAccount(account, key));
  }
  if (isRecord(kimi)) {
    const direct = summarizeAccount(kimi, "kimi");
    if (direct.access || direct.refresh) return [direct];
  }
  return [];
}

function readAuthStore(options: KimiAccountOptions = {}): UnknownRecord | null {
  const file = authStorePath(options);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function pickActiveAccount(kimi: unknown): KimiAccount | null {
  if (!isRecord(kimi)) return null;
  const accounts = listAccounts(kimi);
  if (!accounts.length) return null;
  const activeId = stringValue(kimi.activeAccountId);
  const active = activeId ? accounts.find((account) => account.id === activeId && account.access) : undefined;
  return active || accounts.find((account) => account.access) || accounts[0] || null;
}

/** Read the active Kimi account credential from the login store. */
export function readKimiAccount(options: KimiAccountOptions = {}): KimiAccount | null {
  const raw = readAuthStore(options);
  if (!raw) return null;
  return pickActiveAccount(raw.kimi);
}

/** Read the active Kimi OAuth access token from the login store. Never logs it. */
export function readKimiAccountToken(options: KimiAccountOptions = {}): string | null {
  const account = readKimiAccount(options);
  return account?.access || null;
}

export function hasKimiAccount(options: KimiAccountOptions = {}): boolean {
  return Boolean(readKimiAccountToken(options));
}

export function tokenNeedsRefresh(expires: number | null | undefined, options: KimiAccountOptions = {}): boolean {
  const now = options.now != null ? Number(options.now) : Date.now();
  const skew = options.skewMs != null ? Number(options.skewMs) : REFRESH_SKEW_MS;
  if (expires == null || expires === undefined) return true;
  if (!Number.isFinite(expires)) return true;
  return expires <= now + (Number.isFinite(skew) ? skew : REFRESH_SKEW_MS);
}

function tokenUrlOf(options: KimiAccountOptions = {}): string {
  if (options.tokenUrl) return options.tokenUrl;
  const env = optsEnv(options);
  if (env.BATON_KIMI_TOKEN_URL) return env.BATON_KIMI_TOKEN_URL;
  return KIMI_TOKEN_URL;
}

function refreshFailed(status?: number): KimiRefreshError {
  const suffix = status != null ? ` (${status})` : "";
  return new KimiRefreshError(
    `Kimi account token refresh failed${suffix}. Sign in again: baton login kimi`,
    { code: KIMI_REFRESH_ERROR, status },
  );
}

function invalidRefreshResponse(): KimiRefreshError {
  return new KimiRefreshError(
    "Kimi account token refresh failed (invalid response). Sign in again: baton login kimi",
    { code: "KIMI_REFRESH_INVALID" },
  );
}

/** POST grant_type=refresh_token. Never includes tokens in thrown errors. */
export async function refreshKimiOidcToken(options: KimiAccountOptions = {}): Promise<KimiTokenRefreshResult> {
  const refreshToken = stringValue(options.refreshToken).trim();
  if (!refreshToken) {
    throw new KimiRefreshError(
      "Kimi account has no refresh token. Sign in again: baton login kimi",
      { code: "KIMI_NO_REFRESH" },
    );
  }
  const body = new URLSearchParams({
    client_id: options.clientId || KIMI_OAUTH_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const fetchImpl: KimiFetch = options.fetch || (globalThis.fetch as KimiFetch);
  let response: KimiTokenResponse;
  try {
    response = await fetchImpl(tokenUrlOf(options), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch {
    throw refreshFailed();
  }
  if (!response.ok) throw refreshFailed(response.status);

  let data: unknown;
  try {
    data = typeof response.json === "function"
      ? await response.json()
      : typeof response.body === "string" ? JSON.parse(response.body) : response.body;
  } catch {
    throw invalidRefreshResponse();
  }
  if (!isRecord(data)) throw invalidRefreshResponse();

  const access = stringValue(data.access_token ?? data.access).trim();
  if (!access) throw invalidRefreshResponse();
  const rotated = stringValue(data.refresh_token ?? data.refresh).trim();
  const nextRefresh = rotated || refreshToken;
  const expiresIn = Number(data.expires_in);
  const now = options.now != null ? Number(options.now) : Date.now();
  const ttlMs = Number.isFinite(expiresIn) ? expiresIn * 1000 : 900_000;
  return { access, refresh: nextRefresh, expires: now + ttlMs - EXPIRES_WRITE_SKEW_MS };
}

function patchActiveCredential(raw: UnknownRecord, patch: KimiTokenRefreshResult): boolean {
  const kimi = raw.kimi;
  if (!isRecord(kimi)) return false;
  const apply = (account: unknown): boolean => {
    if (!isRecord(account)) return false;
    let credential: UnknownRecord;
    if (isRecord(account.credential)) {
      credential = account.credential;
    } else {
      credential = {};
      account.credential = credential;
    }
    credential.access = patch.access;
    if (patch.refresh) credential.refresh = patch.refresh;
    credential.expires = patch.expires;
    if (credential.accountId == null && account.id != null) credential.accountId = account.id;
    if (!credential.source) credential.source = "oauth";
    return true;
  };
  const activeId = stringValue(kimi.activeAccountId);
  const accounts = kimi.accounts;
  if (Array.isArray(accounts)) {
    const hit = (activeId && accounts.find((account) => accountIdOf(account) === activeId))
      || accounts.find((account) => accessOf(account) || refreshOf(account));
    return apply(hit);
  }
  if (isRecord(accounts)) {
    const hit = (activeId ? accounts[activeId] : undefined)
      || Object.values(accounts).find((account) => isRecord(account));
    return apply(hit);
  }
  return apply(kimi);
}

export function writeKimiAccountCredential(
  patch: KimiTokenRefreshResult,
  options: KimiAccountOptions = {},
): string {
  const file = authStorePath(options);
  const raw = readAuthStore(options);
  if (!raw || !patchActiveCredential(raw, patch)) {
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

/** Refresh an expiring account and write the account env file. Never returns a token to callers that print. */
export async function ensureFreshKimiAccount(options: KimiAccountOptions = {}): Promise<EnsureFreshKimiResult> {
  const account = readKimiAccount(options);
  if (!account || (!account.access && !account.refresh)) {
    return { refreshed: false, wired: false, files: [] };
  }
  let credential = account;
  let refreshed = false;
  if (tokenNeedsRefresh(account.expires, options)) {
    const next = await refreshKimiOidcToken({ ...options, refreshToken: account.refresh });
    writeKimiAccountCredential(next, options);
    credential = { ...account, ...next };
    refreshed = true;
  }
  const envFile = writeKimiAccountEnv(credential.access, options);
  return { refreshed, wired: true, files: [envFile], expires: credential.expires };
}

export function writeKimiAccountEnv(token: string, options: KimiAccountOptions = {}): string {
  const dest = kimiAccountEnvPath(options);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `${KIMI_ACCOUNT_TOKEN_KEY}=${token}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(dest, 0o600);
  return dest;
}

export function ensureGrokEnvSource(options: KimiAccountOptions = {}): string {
  const dest = grokEnvPath(options);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let text = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : "";
  if (text.includes("kimi-account.env")) return dest;
  if (text && !text.endsWith("\n")) text += "\n";
  fs.writeFileSync(dest, text + GROK_ENV_SOURCE_LINE + "\n", "utf8");
  return dest;
}

function isTableHeader(line: string): boolean {
  return /^\[[^\]]+\]\s*$/.test(line.trim());
}

function ourModelTableId(line: string): string | null {
  const match = line.trim().match(/^\[model\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9._+-]+))\]$/);
  if (!match) return null;
  const id = match[1] || match[2] || match[3];
  return id && KIMI_ACCOUNT_MODEL_IDS.has(id) ? id : null;
}

function isMarkLine(line: string): boolean {
  return line.trim() === BATON_KIMI_MODELS_MARK;
}

/** Remove a previous marked block and remaining k3/kimi-for-coding tables. */
export function stripBatonKimiModelBlocks(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    if (isMarkLine(lines[index])) {
      index += 1;
      continue;
    }
    if (ourModelTableId(lines[index])) {
      index += 1;
      while (index < lines.length && !isTableHeader(lines[index]) && !isMarkLine(lines[index])) index += 1;
      continue;
    }
    out.push(lines[index]);
    index += 1;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\s+$/, "");
}

export function renderKimiAccountModelBlocks(): string {
  const parts: string[] = [BATON_KIMI_MODELS_MARK];
  for (const model of KIMI_ACCOUNT_MODELS) {
    parts.push(
      `[model."${model.id}"]`,
      `model = "${model.id}"`,
      `base_url = "${KIMI_CODING_BASE_URL}"`,
      `name = "${model.id}"`,
      `env_key = "${KIMI_ACCOUNT_TOKEN_KEY}"`,
      `api_backend = "chat_completions"`,
      `context_window = ${model.context_window}`,
      "",
    );
  }
  return parts.join("\n").replace(/\n+$/, "\n");
}

export function upsertGrokKimiModels(options: KimiAccountOptions = {}): string {
  const dest = grokConfigPath(options);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const previous = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : "";
  const kept = stripBatonKimiModelBlocks(previous);
  const block = renderKimiAccountModelBlocks();
  const body = kept ? `${kept}\n\n${block}` : block;
  fs.writeFileSync(dest, body.endsWith("\n") ? body : `${body}\n`, "utf8");
  return dest;
}

/** Wire a logged-in Kimi account to Grok. Returned files are display paths, never the token. */
export async function wireKimiAccountToGrok(options: KimiAccountOptions = {}): Promise<WireKimiResult> {
  const fresh = await ensureFreshKimiAccount(options);
  if (!fresh.wired) return { wired: false, refreshed: false, files: [] };
  const grokEnv = ensureGrokEnvSource(options);
  const grokConfig = upsertGrokKimiModels(options);
  const env = optsEnv(options);
  const envFile = fresh.files[0] || kimiAccountEnvPath(options);
  return {
    wired: true,
    refreshed: Boolean(fresh.refreshed),
    files: [envFile, grokEnv, grokConfig].map((file) => displayHomePath(file, { cwd: options.cwd, env })),
  };
}
