/**
 * baton login — consume account login. Browser/account sign-in only.
 * Do not ask anyone to paste a base URL or API key.
 */
import { loadConfig } from "../lib/config.js";
import {
  resolveOcx,
  resolveLoginProvider,
  engineMissingMessage,
  authProviderForCard,
  listOcxAccounts,
  loginOcxProvider,
  ocxFailureHint,
  MIMO_KEY_ONLY_MESSAGE,
} from "../lib/opencodex.js";
import type {
  OcxResolution,
  OcxResolver,
  OcxRunner,
  OcxRunResult,
} from "../lib/opencodex.js";
import { wireKimiAccountToGrok } from "../lib/kimi-account.js";
import type { CodedError, ModelCard, WritableLike } from "../types.js";

export interface RunLoginOptions {
  cwd?: string;
  stdout?: WritableLike;
  stderr?: WritableLike;
  env?: NodeJS.ProcessEnv;
  runner?: unknown;
  resolve?: unknown;
}

interface LoginEngine {
  cwd: string;
  stdout: WritableLike;
  stderr: WritableLike;
  env: NodeJS.ProcessEnv;
  runner?: OcxRunner;
  resolve?: OcxResolver;
  resolved: OcxResolution;
}

type FlagValue = string | boolean;
type FlagMap = Record<string, FlagValue>;

interface CardLoginResolution {
  provider?: string;
  error?: string;
}

function isResolver(value: unknown): value is OcxResolver {
  return typeof value === "function";
}

function isRunner(value: unknown): value is OcxRunner {
  return typeof value === "function";
}

function isCodedError(value: unknown): value is CodedError {
  return value instanceof Error;
}

export async function runLogin(args: string[], options: RunLoginOptions = {}): Promise<number> {
  const cwd = options.cwd || process.cwd();
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const env = options.env || process.env;
  const resolver = isResolver(options.resolve) ? options.resolve : resolveOcx;
  const runner = isRunner(options.runner) ? options.runner : undefined;
  const resolved = resolver({ env, cwd });
  if (!resolved) {
    stdout.write(`${engineMissingMessage()}\n`);
    return 2;
  }

  const flags = parseFlags(args);
  const provider = firstPositional(args);
  const engine: LoginEngine = { cwd, stdout, stderr, env, runner, resolve: resolver, resolved };

  if (flags.card != null) {
    if (flags.card === true || String(flags.card).trim() === "") {
      stdout.write("usage: baton login --card <id>\n");
      return 2;
    }
    const mapped = resolveCardForLogin(cwd, String(flags.card).trim(), env);
    if (mapped.error) {
      stdout.write(mapped.error + "\n");
      return 1;
    }
    return doLogin(mapped.provider || "", engine);
  }

  if (provider) return doLogin(provider, engine);
  return doList(engine);
}

async function doLogin(provider: string, engine: LoginEngine): Promise<number> {
  const { cwd, stdout, stderr, env, runner, resolve, resolved } = engine;
  const inheritStdio = stdout === process.stdout && stderr === process.stderr;
  let result: OcxRunResult;
  try {
    result = loginOcxProvider(provider, {
      cwd,
      env,
      runner,
      resolve,
      resolved,
      inheritStdio,
    });
  } catch (error: unknown) {
    if (isCodedError(error) && error.code === "OCX_MISSING") {
      stdout.write(error.message + "\n");
      return 2;
    }
    throw error;
  }
  if (result.status !== 0) {
    stdout.write(ocxFailureHint(result) + "\n");
    return 1;
  }
  if (resolveLoginProvider(provider).toLowerCase() === "kimi") {
    try {
      await wireKimiAccountToGrok({ env, cwd });
    } catch {
      // Login already succeeded; wiring is best-effort and must not print the token.
    }
  }
  if (!inheritStdio && result.stdout) {
    stdout.write(result.stdout.endsWith("\n") ? result.stdout : result.stdout + "\n");
  }
  return 0;
}

function doList(engine: LoginEngine): number {
  const { cwd, stdout, env, runner, resolve, resolved } = engine;
  let result: OcxRunResult;
  try {
    result = listOcxAccounts({ cwd, env, runner, resolve, resolved });
  } catch (error: unknown) {
    if (isCodedError(error) && error.code === "OCX_MISSING") {
      stdout.write(error.message + "\n");
      return 2;
    }
    throw error;
  }
  if (result.status !== 0) {
    stdout.write(ocxFailureHint(result) + "\n");
    return 1;
  }
  if (result.stdout) stdout.write(result.stdout.endsWith("\n") ? result.stdout : result.stdout + "\n");

  const cards = loadCards(cwd, env);
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

function loadCards(cwd: string, env: NodeJS.ProcessEnv): ModelCard[] {
  try {
    return loadConfig(cwd, { env }).models;
  } catch (error: unknown) {
    if (isCodedError(error) && error.code === "BATON_NOT_INITIALIZED") return [];
    throw error;
  }
}

export function resolveCardForLogin(cwd: string, cardId: string, env: NodeJS.ProcessEnv): CardLoginResolution {
  const cards = loadCards(cwd, env);
  const card = cards.find((candidate) => candidate.id === cardId);
  if (!card) {
    return { error: `blocked: unknown card "${cardId}". Set auth_provider or pass provider.` };
  }
  const mapped = authProviderForCard(card);
  if (mapped.keyOnly) return { error: "blocked: " + MIMO_KEY_ONLY_MESSAGE };
  if (!mapped.provider) {
    return { error: `blocked: card "${cardId}" has no account-login provider. Set auth_provider or pass provider.` };
  }
  return { provider: mapped.provider };
}

function parseFlags(args: string[]): FlagMap {
  const flags: FlagMap = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function firstPositional(args: string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith("--")) {
      if (args[index + 1] && !args[index + 1].startsWith("--")) index += 1;
      continue;
    }
    return args[index];
  }
  return "";
}
