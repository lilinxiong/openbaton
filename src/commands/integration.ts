import type { WritableLike } from "../types.js";
import { beginWorktreeIntegration } from "../lib/worktree-integration.js";

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

export type IntegrationCommandHandler = (input: IntegrationBeginInvocation) => unknown | Promise<unknown>;

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

function parse(args: readonly string[]): Omit<IntegrationBeginInvocation, "cwd" | "env"> {
  if (args[0] !== "begin") invalid("usage: baton integration begin --run RUN --repository-id SHA256 --bundle-id ID --expected-before-tree GIT_OBJECT [--order-override N] [--json]");
  const valueFlags = new Set(["run", "repository-id", "bundle-id", "expected-before-tree", "order-override"]);
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
  const expectedBeforeTree = required("expected-before-tree");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(runId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(bundleId)) {
    invalid("--run and --bundle-id must be stable identifiers");
  }
  if (!/^[0-9a-f]{64}$/u.test(repositoryId)) invalid("--repository-id must be sha256");
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

export const defaultIntegrationCommandHandler: IntegrationCommandHandler = (input) => beginWorktreeIntegration({
  repository_root: input.cwd,
  run_id: input.run_id,
  repository_id: input.repository_id,
  bundle_id: input.bundle_id,
  expected_before_tree: input.expected_before_tree,
  ...(input.order_override === null ? {} : { order_override: input.order_override }),
  env: input.env,
});

/** CLI transport for the parent-only begin boundary; cwd is always the target. */
export async function runIntegration(
  args: string[],
  options: IntegrationCommandOptions,
): Promise<number> {
  const invocation = { ...parse(args), cwd: options.cwd, env: options.env };
  const result = await (options.handler ?? defaultIntegrationCommandHandler)(invocation);
  if (invocation.json) options.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    const record = (result as { record?: { integration_id?: string; queue_position?: number; state?: string } })?.record;
    options.stdout.write(`integration ${record?.integration_id ?? "begun"}: ${record?.state ?? "integrating"} at queue position ${record?.queue_position ?? "unknown"}\n`);
  }
  return 0;
}
