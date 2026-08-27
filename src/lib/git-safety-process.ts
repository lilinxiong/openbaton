import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";

export type GitSafetyErrorCode =
  | "GIT_SAFETY_COMMAND_FAILED"
  | "GIT_SAFETY_SCALAR_LIMIT"
  | "GIT_SAFETY_STREAM_MALFORMED"
  | "GIT_BASELINE_RACED"
  | "GIT_AUDIT_RACED";

/** A structured, deliberately bounded failure from a Git safety command. */
export class GitSafetyError extends Error {
  readonly code: GitSafetyErrorCode;
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;

  constructor(options: {
    code?: GitSafetyErrorCode;
    command: string;
    message?: string;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    stderr?: string;
  }) {
    const code = options.code ?? "GIT_SAFETY_COMMAND_FAILED";
    const detail = options.message ?? `Git safety command failed: ${options.command}`;
    super(`${detail}${options.stderr ? `: ${options.stderr}` : ""}`);
    this.name = "GitSafetyError";
    this.code = code;
    this.command = options.command;
    this.exitCode = options.exitCode ?? null;
    this.signal = options.signal ?? null;
    this.stderr = options.stderr ?? "";
  }
}

export interface GitProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export interface GitProcessOptions {
  cwd: string;
  args: string[];
  signal?: AbortSignal;
  stderrLimit?: number;
  /** Delay before escalation when a cancelled child ignores SIGTERM. */
  killEscalationMs?: number;
  /** Called for each stdout chunk. A promise applies stream backpressure. */
  onStdout?: (chunk: Buffer) => void | Promise<void>;
  spawn?: typeof nodeSpawn;
}

export interface GitScalarOptions extends Omit<GitProcessOptions, "onStdout"> {
  /** Maximum number of bytes accepted from a command declared scalar. */
  scalarLimit?: number;
  /** Remove the single line terminator emitted by normal Git scalar commands. */
  trimTrailingNewline?: boolean;
}

function commandText(args: string[]): string {
  // Do not include environment or shell-expanded text in diagnostics.
  return `git ${args.map((arg) => JSON.stringify(arg)).join(" ")}`;
}

function tailAppend(current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>, limit: number): Buffer<ArrayBufferLike> {
  if (limit <= 0) return Buffer.alloc(0);
  if (chunk.length >= limit) return chunk.subarray(chunk.length - limit);
  const joined = Buffer.concat([current, chunk]);
  return joined.length > limit ? joined.subarray(joined.length - limit) : joined;
}

/**
 * Run Git without buffering its output. Both pipes are consumed concurrently;
 * stdout consumption is awaited, so a slow parser naturally back-pressures it.
 */
export async function runGitProcess(options: GitProcessOptions): Promise<GitProcessResult> {
  const requestedLimit = options.stderrLimit ?? 8192;
  const limit = Number.isFinite(requestedLimit) ? Math.max(0, Math.floor(requestedLimit)) : 8192;
  const escalationMs = Number.isFinite(options.killEscalationMs) ? Math.max(0, Math.floor(options.killEscalationMs!)) : 1000;
  const spawn = options.spawn ?? nodeSpawn;
  const command = commandText(options.args);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn("git", options.args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    } satisfies SpawnOptions) as ChildProcessWithoutNullStreams;
  } catch (cause) {
    // Spawn exceptions can contain environment-specific paths or credentials
    // from wrappers. Keep the stable command context, but never render cause
    // text as a diagnostic payload.
    void cause;
    throw new GitSafetyError({ command, message: `Unable to spawn ${command}` });
  }

  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let terminated = false;
  let escalationTimer: NodeJS.Timeout | undefined;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let primary: unknown;
  const fail = (cause: unknown) => { if (primary === undefined) primary = cause; };
  const terminate = () => {
    if (terminated) return;
    terminated = true;
    try {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      escalationTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGKILL"); } catch (cause) { fail(cause); }
        }
      }, escalationMs);
      escalationTimer.unref();
    } catch (cause) { fail(cause); }
  };
  const abort = () => { fail(new GitSafetyError({ command, message: `Git safety command aborted: ${command}`, stderr: stderr.toString("utf8") })); terminate(); };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });

  const close = new Promise<void>((resolve) => {
    child.once("error", () => {
      // Node may emit an asynchronous error before close. Error messages from
      // wrappers can contain cwd, environment, or credentials; retain only a
      // stable safety failure and let close remain the reap boundary.
      fail(new GitSafetyError({ command, message: `Git safety process error: ${command}` }));
      terminate();
    });
    child.once("close", (code, signal) => { exitCode = code; exitSignal = signal; resolve(); });
  });
  const drainStderr = (async () => {
    try { for await (const chunk of child.stderr) stderr = tailAppend(stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), limit); }
    catch (cause) { fail(cause); terminate(); }
  })();
  const drainStdout = (async () => {
    try {
      for await (const chunk of child.stdout) {
        if (options.onStdout) await options.onStdout(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    } catch (cause) { fail(cause); terminate(); }
  })();
  await close;
  if (escalationTimer) clearTimeout(escalationTimer);
  await Promise.allSettled([drainStdout, drainStderr]);
  options.signal?.removeEventListener("abort", abort);
  if (primary !== undefined) {
    if (primary instanceof GitSafetyError) throw primary;
    throw new GitSafetyError({ command, message: primary instanceof Error ? primary.message : String(primary), exitCode, signal: exitSignal, stderr: stderr.toString("utf8") });
  }
  if (exitCode !== 0 || exitSignal !== null) {
    throw new GitSafetyError({ command, exitCode, signal: exitSignal, stderr: stderr.toString("utf8") });
  }
  return { exitCode, signal: exitSignal, stderr: stderr.toString("utf8") };
}

/**
 * Collect the deliberately small output of a scalar Git command.
 *
 * Scalar commands have a contract, unlike streaming safety commands: output
 * beyond that contract is an error and is never truncated or reclassified as
 * a stream. The underlying runner still drains both pipes while the bounded
 * collector reports the violation.
 */
export async function collectGitScalar(options: GitScalarOptions): Promise<string> {
  const requestedLimit = options.scalarLimit ?? 64 * 1024;
  const limit = Number.isFinite(requestedLimit) ? Math.max(0, Math.floor(requestedLimit)) : 64 * 1024;
  let output = Buffer.alloc(0);
  await runGitProcess({
    ...options,
    onStdout: (chunk) => {
      if (output.length + chunk.length > limit) {
        throw new GitSafetyError({
          code: "GIT_SAFETY_SCALAR_LIMIT",
          command: commandText(options.args),
          message: `Scalar Git output exceeded ${limit} bytes`,
        });
      }
      output = Buffer.concat([output, chunk]);
    },
  });
  const value = output.toString("utf8");
  return options.trimTrailingNewline === false ? value : value.replace(/\r?\n$/, "");
}

export const streamGitProcess = runGitProcess;
