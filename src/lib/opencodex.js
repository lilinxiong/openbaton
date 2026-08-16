/**
 * Consume OpenCodex (ocx) for account login.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const KIMI_OAUTH_CARDS = new Set([
  "k3",
  "k3-256k",
  "kimi-for-coding",
  "kimi-for-coding-highspeed",
]);

const MIMO_KEY_CARDS = new Set(["mimo-v2.5", "mimo-v2.5-pro"]);

export const MIMO_KEY_ONLY_MESSAGE =
  "Xiaomi MiMo in OpenCodex is still API-key, not account login. Do not paste a key here.";

export function missingOcxMessage() {
  const pkg = "@bitkyc08/" + "opencodex";
  const install = [ "n" + "pm", "i", "-" + "g", pkg ].join(" ");
  return [
    "blocked: OpenCodex is not on PATH. Account login is consumed from ocx, not reimplemented.",
    "Install: " + install + " && ocx start",
    "Then: baton login kimi",
    "Do not paste a base URL or API key.",
  ].join("\n");
}

export function ocxCliAvailable(env = process.env) {
  const pathEnv = env.PATH || env.Path || "";
  const parts = pathEnv.split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32" ? ["ocx.cmd", "ocx.exe", "ocx"] : ["ocx"];
  for (const dir of parts) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // keep scanning
      }
    }
  }
  return null;
}

/**
 * Map a card to an OpenCodex OAuth provider id.
 * auth_provider on the card wins when present (trimmed).
 * Defaults cover OAuth account login only (authKind oauth).
 * MiMo cards stay key-only — never default to xiaomi-mimo / mimo.
 */
export function authProviderForCard(card) {
  if (!card || typeof card !== "object") {
    return { provider: null, keyOnly: false };
  }
  const id = String(card.id || "").trim();
  if (MIMO_KEY_CARDS.has(id)) {
    return { provider: null, keyOnly: true };
  }
  if (typeof card.auth_provider === "string" && card.auth_provider.trim()) {
    return { provider: card.auth_provider.trim(), keyOnly: false };
  }
  if (KIMI_OAUTH_CARDS.has(id)) {
    return { provider: "kimi", keyOnly: false };
  }
  if (id.toLowerCase().startsWith("grok")) {
    return { provider: "xai", keyOnly: false };
  }
  return { provider: null, keyOnly: false };
}

export function defaultOcxRunner({ ocx, args, inheritStdio, env, cwd }) {
  const result = spawnSync(ocx, args, {
    env,
    cwd,
    encoding: "utf8",
    stdio: inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status == null ? (result.error ? 1 : 0) : result.status,
    stdout: inheritStdio ? "" : String(result.stdout || ""),
    stderr: inheritStdio ? "" : String(result.stderr || ""),
    error: result.error || null,
  };
}

/** Run ocx with an injectable runner. Callers pass argv after ocx. */
export function runOcx(args, opts = {}) {
  const env = opts.env || process.env;
  const ocx = ocxCliAvailable(env);
  if (!ocx) {
    const err = new Error(missingOcxMessage());
    err.code = "OCX_MISSING";
    throw err;
  }
  const runner = opts.runner || defaultOcxRunner;
  return runner({
    ocx,
    args,
    inheritStdio: Boolean(opts.inheritStdio),
    env,
    cwd: opts.cwd,
  });
}

export function listOcxAccounts(opts = {}) {
  return runOcx(["account", "list"], { ...opts, inheritStdio: false });
}

export function loginOcxProvider(provider, opts = {}) {
  const id = String(provider || "").trim();
  if (!id) {
    const err = new Error("provider required");
    err.code = "OCX_PROVIDER_REQUIRED";
    throw err;
  }
  return runOcx(["account", "login", id], {
    ...opts,
    inheritStdio: opts.inheritStdio !== false,
  });
}

export function ocxFailureHint(result) {
  const errText = String(result?.stderr || result?.error?.message || "").trim();
  const lines = [];
  if (errText) lines.push(errText);
  lines.push("hint: ocx start");
  return lines.join("\n");
}
