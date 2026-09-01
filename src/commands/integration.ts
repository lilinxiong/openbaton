import type { WritableLike } from "../types.js";
import { applyWorktreeIntegration, beginWorktreeIntegration } from "../lib/worktree-integration.js";

export interface IntegrationBeginInvocation {
  operation: "begin";
  cwd: string;
  env: NodeJS.ProcessEnv;
  run_id: string;
  repository_id: string;
  bundle_id: string;
  expected_before_tree: string;
  order_override: number | null;
  json: boolean;
}

export interface IntegrationApplyInvocation {
  operation: "apply";
  cwd: string;
  env: NodeJS.ProcessEnv;
  run_id: string;
  repository_id: string;
  bundle_id: string;
  idempotency_key: string | null;
  json: boolean;
}

export type IntegrationCommandInvocation = IntegrationBeginInvocation | IntegrationApplyInvocation;
export type IntegrationCommandHandler = (input: IntegrationCommandInvocation) => unknown | Promise<unknown>;
type ParsedIntegrationInvocation =
  | Omit<IntegrationBeginInvocation, "cwd" | "env">
  | Omit<IntegrationApplyInvocation, "cwd" | "env">;

interface IntegrationCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: WritableLike;
  handler?: IntegrationCommandHandler;
}

type Coded = Error & { code?: string };

function invalid(message: string): never {
  const error = new Error(message) as Coded;
  error.code = "INTEGRATION_INPUT_INVALID";
  throw error;
}

function parse(args: readonly string[]): ParsedIntegrationInvocation {
  const operation = args[0];
  if (operation !== "begin" && operation !== "apply") {
    invalid("usage: baton integration begin|apply --run RUN --repository-id SHA256 --bundle-id ID [operation options] [--json]");
  }
  const valueFlags = new Set(operation === "begin"
    ? ["run", "repository-id", "bundle-id", "expected-before-tree", "order-override"]
    : ["run", "repository-id", "bundle-id", "idempotency-key"]);
  const seen = new Map<string, string>();
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--json") {
      if (json) invalid("duplicate --json");
      json = true;
      continue;
    }
    if (!token.startsWith("--")) invalid(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!valueFlags.has(key)) invalid(`unknown option: ${token}`);
    if (seen.has(key)) invalid(`duplicate ${token}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || !value.trim()) invalid(`${token} requires a value`);
    seen.set(key, value.trim());
    index += 1;
  }
  const required = (key: string): string => seen.get(key) ?? invalid(`--${key} is required`);
  const runId = required("run");
  const repositoryId = required("repository-id");
  const bundleId = required("bundle-id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(runId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(bundleId)) {
    invalid("--run and --bundle-id must be stable identifiers");
  }
  if (!/^[0-9a-f]{64}$/u.test(repositoryId)) invalid("--repository-id must be sha256");
  if (operation === "apply") {
    const idempotencyKey = seen.get("idempotency-key") ?? null;
    if (idempotencyKey !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(idempotencyKey)) {
      invalid("--idempotency-key must be a stable identifier");
    }
    return {
      operation,
      run_id: runId,
      repository_id: repositoryId,
      bundle_id: bundleId,
      idempotency_key: idempotencyKey,
      json,
    };
  }
  const expectedBeforeTree = required("expected-before-tree");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(expectedBeforeTree)) invalid("--expected-before-tree must be a Git object id");
  const orderRaw = seen.get("order-override");
  const orderOverride = orderRaw === undefined ? null : Number(orderRaw);
  if (orderOverride !== null && (!Number.isSafeInteger(orderOverride) || orderOverride < 0)) {
    invalid("--order-override must be a non-negative integer");
  }
  return {
    operation: "begin",
    run_id: runId,
    repository_id: repositoryId,
    bundle_id: bundleId,
    expected_before_tree: expectedBeforeTree,
    order_override: orderOverride,
    json,
  };
}

export const defaultIntegrationCommandHandler: IntegrationCommandHandler = (input) => input.operation === "begin"
  ? beginWorktreeIntegration({
    repository_root: input.cwd,
    run_id: input.run_id,
    repository_id: input.repository_id,
    bundle_id: input.bundle_id,
    expected_before_tree: input.expected_before_tree,
    ...(input.order_override === null ? {} : { order_override: input.order_override }),
    env: input.env,
  })
  : applyWorktreeIntegration({
    repository_root: input.cwd,
    run_id: input.run_id,
    repository_id: input.repository_id,
    bundle_id: input.bundle_id,
    ...(input.idempotency_key === null ? {} : { idempotency_key: input.idempotency_key }),
    env: input.env,
  });

/** CLI transport for parent-only integration boundaries; cwd is always the target. */
export async function runIntegration(
  args: string[],
  options: IntegrationCommandOptions,
): Promise<number> {
  const invocation = { ...parse(args), cwd: options.cwd, env: options.env };
  const result = await (options.handler ?? defaultIntegrationCommandHandler)(invocation);
  if (invocation.json) options.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    const record = (result as { record?: { integration_id?: string; queue_position?: number; state?: string } })?.record;
    options.stdout.write(`integration ${record?.integration_id ?? invocation.operation}: ${record?.state ?? "integrating"} at queue position ${record?.queue_position ?? "unknown"}\n`);
  }
  return 0;
}
