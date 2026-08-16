/**
 * baton login — consume account login. Browser/account sign-in only.
 * Do not ask anyone to paste a base URL or API key.
 */
import { loadConfig } from "../lib/config.js";
import {
  resolveOcx,
  engineMissingMessage,
  authProviderForCard,
  listOcxAccounts,
  loginOcxProvider,
  ocxFailureHint,
  MIMO_KEY_ONLY_MESSAGE,
} from "../lib/opencodex.js";

export function runLogin(args, { cwd, stdout, stderr, env = process.env, runner, resolve, startProxy } = {}) {
  const resolved = (resolve || resolveOcx)({ env, cwd });
  if (!resolved) {
    stdout.write(`${engineMissingMessage()}\n`);
    return 2;
  }

  const flags = parseFlags(args);
  const provider = firstPositional(args);
  const engine = { cwd, stdout, stderr, env, runner, resolve, resolved, startProxy };

  if (flags.card != null) {
    if (flags.card === true || String(flags.card).trim() === "") {
      stdout.write("usage: baton login --card <id>\n");
      return 2;
    }
    const mapped = resolveCardForLogin(cwd, String(flags.card).trim());
    if (mapped.error) {
      stdout.write(mapped.error + "\n");
      return 1;
    }
    return doLogin(mapped.provider, engine);
  }

  if (provider) {
    return doLogin(provider, engine);
  }

  return doList(engine);
}

function doLogin(provider, { cwd, stdout, stderr, env, runner, resolve, resolved, startProxy }) {
  const inheritStdio = stdout === process.stdout && stderr === process.stderr;
  let result;
  try {
    result = loginOcxProvider(provider, {
      cwd, env, runner, resolve, resolved, startProxy, inheritStdio,
    });
  } catch (err) {
    if (err.code === "OCX_MISSING") {
      stdout.write(err.message + "\n");
      return 2;
    }
    throw err;
  }
  if (result.status !== 0) {
    stdout.write(ocxFailureHint(result) + "\n");
    return 1;
  }
  if (!inheritStdio && result.stdout) {
    stdout.write(result.stdout.endsWith("\n") ? result.stdout : result.stdout + "\n");
  }
  return 0;
}

function doList({ cwd, stdout, env, runner, resolve, resolved, startProxy }) {
  let result;
  try {
    result = listOcxAccounts({ cwd, env, runner, resolve, resolved, startProxy });
  } catch (err) {
    if (err.code === "OCX_MISSING") {
      stdout.write(err.message + "\n");
      return 2;
    }
    throw err;
  }
  if (result.status !== 0) {
    stdout.write(ocxFailureHint(result) + "\n");
    return 1;
  }
  if (result.stdout) {
    stdout.write(result.stdout.endsWith("\n") ? result.stdout : result.stdout + "\n");
  }
  const cards = loadCards(cwd);
  if (cards.length) {
    stdout.write("\ncard -> provider\n");
    for (const card of cards) {
      const mapped = authProviderForCard(card);
      if (mapped.keyOnly) {
        stdout.write("  " + card.id + "  (OpenCodex API-key; not account login)\n");
      } else if (mapped.provider) {
        stdout.write("  " + card.id + "  " + mapped.provider + "\n");
      } else {
        stdout.write("  " + card.id + "  (none)\n");
      }
    }
  }
  return 0;
}

function loadCards(cwd) {
  try {
    return loadConfig(cwd).models;
  } catch (err) {
    if (err.code === "BATON_NOT_INITIALIZED") return [];
    throw err;
  }
}

export function resolveCardForLogin(cwd, cardId) {
  const cards = loadCards(cwd);
  const card = cards.find((c) => c.id === cardId);
  if (!card) {
    return { error: "blocked: unknown card \"" + cardId + "\". Set auth_provider or pass provider." };
  }
  const mapped = authProviderForCard(card);
  if (mapped.keyOnly) {
    return { error: "blocked: " + MIMO_KEY_ONLY_MESSAGE };
  }
  if (!mapped.provider) {
    return { error: "blocked: card \"" + cardId + "\" has no account-login provider. Set auth_provider or pass provider." };
  }
  return { provider: mapped.provider };
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function firstPositional(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      if (args[i + 1] && !args[i + 1].startsWith("--")) i += 1;
      continue;
    }
    return args[i];
  }
  return "";
}
