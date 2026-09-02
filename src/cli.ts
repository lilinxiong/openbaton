import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "./commands/init.js";
import { updateProject } from "./commands/update.js";
import { runDispatch } from "./commands/dispatch.js";
import { runRoutes } from "./commands/routes.js";
import { runConversation } from "./commands/conversation.js";
import { runHost } from "./commands/host.js";
import { cliPromptChoices, runConfig } from "./commands/config.js";
import { runUninstall } from "./commands/uninstall.js";
import {
  approveRecommendedSelection,
  assertRecommendedSelectionAvailable,
  type SelectionApprovalOutput,
} from "./commands/selection.js";
import {
  cliProfileForHost,
  configuredCodingModelsForHost,
  effectiveMaxDepthForHost,
  loadConfig,
} from "./lib/config.js";
import { CardMatchError } from "./lib/cards.js";
import { dispatchCompatibilityBlockers, dispatchWorkspaceCapacitySnapshots, reserveNext } from "./lib/dispatch.js";
import { detectInvokingHost, parseHostId, resolveRuntimeHost } from "./lib/hosts.js";
import { listSpawns, nextSpawnIds, planStandaloneSpawn, sessionUid, type StandalonePlan } from "./lib/spawn.js";
import { formatTaskPrompt, resolveApplyChange } from "./lib/apply.js";
import { applyTaskId } from "./lib/task-id.js";
import { parseApplyUnitScopes, scopeRecord, DEFAULT_WRITE_OPERATIONS, WRITE_OPERATIONS, type ApplyUnitScope } from "./lib/apply/scope.js";
import { authorizeCommitOpsPlanAsync, resolveOpsDispatch, resolveOpsUnitDispatch, type OpsResolution } from "./lib/ops/dispatch.js";
import { normalizeAgentTaskClassification } from "./lib/ops/task.js";
import { detectOpenSpecRoot, loadTasksFromChangeDir, readOpenSpecStatus } from "./lib/openspec.js";
import { type SafetyOperation } from "./lib/safety.js";
import { assertWriteScopesAvailable, materializeStandalonePlanAsync } from "./lib/ticket-materialization.js";
import { buildRouteCandidates, readRouteSnapshot } from "./lib/routes.js";
import { cardsForAutomaticSelection } from "./lib/route-health.js";
import { availabilityForRoute } from "./lib/model-availability.js";
import { withActivationLockAsync } from "./lib/activation.js";
import {
  buildSelectionUnit,
  createSelectionProposal,
  listSelectionProposals,
  selectionSourceFingerprint,
  type SelectionProposal,
} from "./lib/selection.js";
import { cliIds, parseCliId } from "./adapters/registry.js";
import type { CliAdapterProvider, CliId } from "./adapters/contract.js";
import { createTerminalPrompt, isInteractiveIo, type SelectPrompt } from "./lib/prompt.js";
import type { ModelCard } from "./types.js";
import type { CodedError, WritableLike } from "./types.js";
import { defaultCompiledApplyHandler } from "./lib/apply/compiled-cli.js";
import { runRollingRun, type RollingRunHandler } from "./commands/run.js";
import {
  firstPositionalArg,
  flagOn,
  multiFlag,
  parseClassificationAssignments,
  parseClassificationFlags,
  parseFlags,
  parseOperationAssignments,
  parseStandaloneUnits,
  parseStandaloneWriteScopes,
  positionalText,
  stringFlag,
  validateCommandArgs,
  type FlagMap,
} from "./cli-flags.js";
import { runIntegration, type IntegrationCommandHandler } from "./commands/integration.js";
import { cmdSpawn } from "./commands/spawn.js";
import { cmdApply } from "./commands/apply.js";
import { cmdStatus } from "./commands/status.js";
import { cmdCompiledApply } from "./commands/compiled-apply.js";

interface RunOptions {
  cwd?: string;
  stdout?: WritableLike;
  stderr?: WritableLike;
  stdin?: NodeJS.ReadableStream | string;
  env?: NodeJS.ProcessEnv;
  adapterProvider?: CliAdapterProvider;
  prompt?: SelectPrompt;
  /** Injectable boundary for the director-compiled apply protocol. */
  compiledApplyHandler?: CompiledApplyHandler;
  /** Injectable boundary for the source-neutral rolling-run protocol. */
  rollingRunHandler?: RollingRunHandler;
  /** Injectable parent integration admission boundary. */
  integrationHandler?: IntegrationCommandHandler;
}

export type CompiledApplyOperation = "plan" | "status" | "accept-gate" | "reconcile";
export type CompiledApplyMode = "initial" | "successor" | "status" | "accept-gate" | "reconcile";

/**
 * Parsed compiled-apply input.  The CLI deliberately owns only argument
 * validation and transport; persistence, scheduling, and ticket creation stay
 * behind this narrow injectable boundary.
 */
export interface CompiledApplyInvocation {
  operation: CompiledApplyOperation;
  mode: CompiledApplyMode;
  change: string | null;
  run: string | null;
  run_id: string | null;
  plan_file: string | null;
  plan: string | null;
  dispatch: boolean;
  status: boolean;
  accept_gate: string | null;
  text: string | null;
  reconcile: boolean;
  task: string | null;
  json: boolean;
  host: string | null;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type CompiledApplyHandler = (input: CompiledApplyInvocation) => unknown | Promise<unknown>;

export async function readStdinLine(stream: NodeJS.ReadableStream, output: WritableLike): Promise<string> {
  const lineReader = readline.createInterface({
    input: stream as NodeJS.ReadableStream,
    output: output as unknown as NodeJS.WritableStream,
    terminal: false,
  });
  return await new Promise<string>((resolve) => {
    lineReader.question("", (answer) => {
      lineReader.close();
      resolve(answer);
    });
  });
}

export const VERSION = "1.0.0";

export function resolvedCards(cwd: string, env: NodeJS.ProcessEnv, host: ReturnType<typeof parseHostId>): ModelCard[] {
  const cfg = loadConfig(cwd, { env });
  const profile = cliProfileForHost(cfg, host);
  const allowed = new Set(configuredCodingModelsForHost(cfg, host));
  if (!allowed.size) return [];
  const snapshot = readRouteSnapshot(cwd, { host, env });
  if (!snapshot || snapshot.cli !== host) return [];
  return buildRouteCandidates(cwd, { host, env })
    .map((candidate) => candidate.card)
    .filter((card) => card.route_id && allowed.has(card.route_id));
}

export function codingModelsForHost(cwd: string, env: NodeJS.ProcessEnv, host: CliId): string[] {
  return [...configuredCodingModelsForHost(loadConfig(cwd, { env }), host)];
}

export function formatExecutionHandle(handle: unknown): string | null {
  if (!handle) return null;
  if (typeof handle === "object" && !Array.isArray(handle)) {
    const value = handle as Record<string, unknown>;
    if (typeof value.kind === "string" && typeof value.value === "string") return `${value.kind}:${value.value}`;
  }
  return typeof handle === "string" ? handle : String(handle);
}

export function runtimeHost(flags: FlagMap, cwd: string, env: NodeJS.ProcessEnv): ReturnType<typeof parseHostId> {
  return resolveRuntimeHost({ cwd, env, explicitHost: stringFlag(flags, "host") });
}

export function directorOnlyClassification(classification: ReturnType<typeof normalizeAgentTaskClassification>): boolean {
  return classification?.kind === "discussion" || classification?.kind === "analysis";
}

export function validateClassificationContract(
  classification: ReturnType<typeof normalizeAgentTaskClassification>,
  unitDefinitions: Array<{ key: string; description: string }>,
  unitClassifications: Map<string, ReturnType<typeof normalizeAgentTaskClassification>>,
  unitOperations: Map<string, string>,
): void {
  const knownUnits = new Set(unitDefinitions.map((item) => item.key));
  for (const key of [...unitClassifications.keys(), ...unitOperations.keys()]) {
    if (!knownUnits.has(key)) throw new Error(`CLASSIFICATION_UNIT_UNKNOWN: ${key} is not a declared --unit`);
  }
  if (!unitDefinitions.length) {
    if (!classification) throw new Error("CLASSIFICATION_REQUIRED: Baton requires a director classification before ticket creation");
    return;
  }
  for (const unit of unitDefinitions) {
    const unitClassification = unitClassifications.get(unit.key) || null;
    if (!classification && !unitClassification) {
      throw new Error(`CLASSIFICATION_REQUIRED: Baton requires a classification for unit ${unit.key} before ticket creation`);
    }
    if (classification && unitClassification && classification.kind !== unitClassification.kind) {
      throw new Error(`CLASSIFICATION_CONFLICT: request=${classification.kind} unit=${unit.key}:${unitClassification.kind}`);
    }
    if (unitOperations.has(unit.key) && !classification && !unitClassification) {
      throw new Error(`CLASSIFICATION_REQUIRED: operation for unit ${unit.key} has no classification`);
    }
  }
}

/** Host list shown in usage text, derived from the adapter registry. */
const HOSTS = cliIds().join("|");

const HELP = `baton — CLI-neutral director for discovered adapters
既能独立，又能 1+1>2

Standalone: cards + native spawn + mechanical ops + director context hygiene. Complete without OpenSpec.
Together: OpenSpec owns breakdown/status; baton owns who runs each task and keeps
the director context clean. Apply is multi-model, root-tree-capacity-bounded,
card-routed execution of OpenSpec tasks, with conclusions written back. Not a
thin adapter.
The selected CLI owns model visibility; Baton routes only within the configured candidate set.
Interactive init/config use arrow-key select; space toggles CLIs and ordered Coding models.

Usage:
  baton init [--force] [--cli ${HOSTS}]  initialize Baton + host skills
  baton update                        refresh shared runtime files and adapter packages
  baton models refresh|status|candidates [--host ${HOSTS}]  inspect/refresh one CLI model catalog
  baton models reset ROUTE --host ${HOSTS} [--json]           clear one durable quota decision
  baton cards [--host ${HOSTS}] [--provider ID] [--json]
  baton host detect [--json]               resolve invoking host from runtime signals
  baton config [--cli ${HOSTS}] [--runner MODEL|-] [--longctx MODEL|-]
               [--coding-model MODEL|all]
  baton uninstall [--host ${HOSTS}] [--dry-run]
  baton uninstall --clean [--dry-run] [--yes]
  baton match <text> [--host ${HOSTS}]  disclose preferred/candidate models without creating work
  baton spawn <request> [--host ${HOSTS}] [--unit KEY=TEXT ...] [--classification mechanical|long-context|implementation|analysis|discussion|general] [--operation LABEL]
               [--unit-classification KEY=CLASS ...] [--unit-operation KEY=LABEL ...] [--dispatch]
               director classification is authoritative; operation is free-form audit metadata
  baton apply [change] [--host ${HOSTS}]  plan the ready OpenSpec wave (no tickets)
  baton apply [change] [--host ${HOSTS}] --dispatch --unit ID --write-path PATH --unit ID --write-path PATH|--read-only
               director-scoped dispatch of the order-ready subset; --dispatch without --unit is rejected
  baton apply [change] --host ${HOSTS} --plan-file PATH|- [--dispatch]
               submit a director-compiled initial plan (compiled handler)
  baton apply [change] --host ${HOSTS} --run RUN --status [--json]
  baton apply [change] --host ${HOSTS} --run RUN --accept-gate GATE --text SUMMARY [--json]
  baton apply [change] --host ${HOSTS} --run RUN --reconcile [--task NUMBER] [--json]
  baton apply [change] --host ${HOSTS} --run RUN --plan-file PATH|- [--dispatch]
               submit a director-compiled successor plan (compiled handler)
  baton run start --host ${HOSTS} [--worktree-mode isolated-worktree|shared-worktree] --source-file PATH|- [--plan-delta-file PATH|-] [--run-id RUN] [--dispatch] [--json]
               create a source-neutral rolling v2 run; writing units default to isolated worktrees
  baton run RUN --append-plan PATH|- [--dispatch] [--json]
  baton run RUN --status [--json]
  baton run RUN --accept-gate GATE@VERSION --text SUMMARY [--dispatch] [--json]
  baton run RUN --seal-task TASK --seal-file PATH|- [--json]
  baton run RUN --reconcile [--task TASK] [--json]
  baton run RUN --freeze-unit UNIT --attempt ATTEMPT --text SUMMARY [--validation SUMMARY] [--allow-noop] [--json]
               parent-audit one terminal isolated root and freeze its immutable ChangeBundle v1
  baton run RUN --cleanup-unit UNIT --attempt ATTEMPT [--release-downstream-base] [--discard-rejected-evidence] [--release-user-retention] [--json]
               remove only an exact eligible worktree and its disposable Baton reachability artifacts
  baton integration begin --run RUN --repository-id SHA256 --bundle-id ID --expected-before-tree GIT_OBJECT [--order-override N] [--json]
               admit the current cwd to the repository queue; does not apply a bundle
  baton integration apply --run RUN --repository-id SHA256 --bundle-id ID [--idempotency-key ID] [--json]
               merge the admitted bundle in isolated Git object plumbing; does not mutate the caller checkout
  baton integration resolve --run RUN --repository-id SHA256 --bundle-id ID --resolved-tree GIT_OBJECT --conclusion TEXT [--idempotency-key ID] [--json]
               audit and freeze a parent resolution without rewriting the worker bundle
  baton integration accept --run RUN --repository-id SHA256 --bundle-id ID --conclusion TEXT [--idempotency-key ID] [--json]
               apply the frozen result to the caller and accept matching rolling integration gates
  baton dispatch next --host HOST [--capacity N] --json
  baton dispatch bind TICKET --execution-handle KIND=VALUE [--repository-id SHA256 --git-common-dir-identity SHA256 --execution-root ABSOLUTE_PATH --base-tree GIT_OBJECT --worktree-record-id ID] --host HOST --json
  baton dispatch defer TICKET --host HOST --code AGENT_LIMIT_REACHED [--observed-capacity N] --json
  baton dispatch probe TICKET --host HOST --execution-handle KIND=VALUE [--repository-id SHA256 --git-common-dir-identity SHA256 --execution-root ABSOLUTE_PATH --base-tree GIT_OBJECT --worktree-record-id ID] --state pending_init|running|interrupted|shutdown|not_found --json
  baton dispatch progress TICKET --host HOST --phase PHASE --text "short status" --json
  baton dispatch complete TICKET --host HOST --text "short conclusion" [--release] --json
  baton dispatch release TICKET --host HOST [--execution-handle KIND=VALUE [--repository-id SHA256 --git-common-dir-identity SHA256 --execution-root ABSOLUTE_PATH --base-tree GIT_OBJECT --worktree-record-id ID]] --json
  baton dispatch fail|close TICKET --host HOST [--release] --json
  baton dispatch timeout TICKET --host HOST --probe-sequence N [--release] --json
  baton dispatch recover --host HOST --json
  baton dispatch status --host HOST [--capacity N] --json
  dispatch capacity is per (host, BATON_SESSION_ID) root-agent tree: the root
  is excluded, direct and nested descendants share one limit, and
  capacity_sources reports host/policy/operation provenance; max_depth is separate
  workspace safety/locks and host-profile model quota retain their broader scopes
  Apply/queue planning metadata is separate from runtime capacity; status JSON
  keeps workspace ticket inventory under spawns and tree capacity under
  capacity_trees (there is no aggregate workspace available value)
  baton status [--host ${HOSTS}] [--json]  Coding routes, queue + OpenSpec status
  baton help | --help | -h
  baton version | --version | -v
`;

export async function run(argv: string[], {
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
  env = process.env,
  adapterProvider,
  prompt,
  compiledApplyHandler,
  rollingRunHandler,
  integrationHandler,
}: RunOptions = {}): Promise<number> {
  const streamStdin = typeof stdin === "string" ? process.stdin : stdin;
  const injectedStdin = typeof stdin === "string" ? stdin : undefined;
  const args = argv.slice();
  const cmd = args.shift() || "help";

  try {
    switch (cmd) {
      case "help":
      case "--help":
      case "-h":
        stdout.write(HELP);
        return 0;
      case "version":
      case "--version":
      case "-v":
        stdout.write(`baton ${VERSION}\n`);
        return 0;
      case "init":
        return await cmdInit(args, cwd, stdout, env, streamStdin, prompt, adapterProvider);
      case "update":
        validateCommandArgs(args, { positional: "none" });
        return cmdUpdate(cwd, stdout, env);
      case "cards":
        return cmdCards(args, cwd, stdout, env);
      case "match":
        return cmdMatch(args, cwd, stdout, env);
      case "config":
        return await runConfig(args, { cwd, stdout, stdin: streamStdin, env, adapterProvider, prompt });
      case "uninstall":
        return await runUninstall(args, { cwd, stdout, env, interactive: injectedStdin !== undefined || isInteractiveIo(streamStdin, stdout), confirm: async () => {
          if (injectedStdin !== undefined) return /^y(?:es)?$/i.test(injectedStdin.trim());
          if (!isInteractiveIo(streamStdin, stdout)) return false;
          (args.includes("--json") ? stderr : stdout).write("Clean all Baton state after active tickets drain? [y/N] ");
          const input = await readStdinLine(streamStdin, stderr);
          return /^y(?:es)?$/i.test(input.trim());
        } });
      case "spawn":
        return await cmdSpawn(args, cwd, stdout, env);
      case "apply":
        return await cmdApply(args, cwd, stdout, env, streamStdin, injectedStdin, compiledApplyHandler);
      case "run":
        return await runRollingRun(args, { cwd, stdout, stdin: streamStdin, injectedStdin, env, handler: rollingRunHandler });
      case "integration":
        return await runIntegration(args, { cwd, stdout, env, handler: integrationHandler });
      case "dispatch":
        return await runDispatch(args, { cwd, stdout, env });
      case "models":
        return await runRoutes(args, { cwd, stdout, env, adapterProvider });
      case "host":
        return runHost(args, { cwd, stdout, env });
      case "conversation":
        return runConversation(args, { stdout });
      case "status":
        return cmdStatus(args, cwd, stdout, env);
      default:
        stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
        return 2;
    }
  } catch (cause: unknown) {
    const err = cause instanceof Error ? cause as CodedError : new Error(String(cause)) as CodedError;
    stderr.write(`${err.message}\n`);
    return err.code === "BATON_NOT_INITIALIZED" ? 2 : 1;
  }
}

async function cmdInit(
  args: string[],
  cwd: string,
  stdout: WritableLike,
  env: NodeJS.ProcessEnv,
  stdin: NodeJS.ReadableStream,
  prompt?: SelectPrompt,
  adapterProvider?: CliAdapterProvider,
): Promise<number> {
  validateCommandArgs(args, { value: ["cli"], boolean: ["force"], positional: "none" });
  const flags = parseFlags(args);
  const force = Boolean(flags.force) || args.includes("--force");
  const cliFlag = stringFlag(flags, "cli");
  let clis: CliId[] | undefined;
  // initProject installs bundled adapters before validating an explicit
  // adapter, so a fresh home can use the same `--cli` form as an initialized
  // home.  Resolve the id again after installation for output only.
  if (cliFlag) clis = [cliFlag.trim().toLowerCase() as CliId];
  else if (prompt || isInteractiveIo(stdin, stdout)) {
    const ask = prompt || createTerminalPrompt({ stdin, stdout, env });
    let initial: CliId[] = [];
    try {
      const detected = detectInvokingHost(env);
      if (detected) initial = [detected];
    } catch { /* ambiguous runtime hosts: no preselection */ }
    clis = await ask.multiSelect({
      message: "Select CLI",
      choices: cliPromptChoices(env),
      initial,
      required: true,
    });
    if (!clis.length) throw new Error("select at least one CLI");
  }
  const result = await initProject(cwd, { force, cli: cliFlag, env });
  if (cliFlag) clis = [parseCliId(cliFlag, env)];
  stdout.write(`initialized ${result.dir}\n`);
  for (const f of result.created) stdout.write(`  wrote ${f}\n`);
  for (const f of result.skipped) stdout.write(`  kept  ${f} (use --force to replace)\n`);
  if (clis?.length) {
    stdout.write(`  cli: ${clis.join(", ")}\n`);
  }
  if (clis?.length && !cliFlag) {
    stdout.write("\n");
    return runConfig([], { cwd, stdout, stdin, env, adapterProvider, prompt, clis });
  }
  stdout.write("\nNext: run `baton config`; choose CLIs, their runner/longctx labels, and ordered Coding models.\n");
  stdout.write("Model visibility comes from the selected CLI. Later routing is automatic.\n");
  stdout.write("OpenSpec is optional. baton is complete without it.\n");
  return 0;
}

function cmdUpdate(cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv): number {
  const result = updateProject(cwd, { env });
  stdout.write("updated Baton global files\n");
  for (const a of result.actions) stdout.write(`  ${a}\n`);
  return 0;
}

function cmdCards(args: string[], cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv): number {
  validateCommandArgs(args, { value: ["host", "provider"], boolean: ["json"], positional: "none" });
  const flags = parseFlags(args);
  const host = runtimeHost(flags, cwd, env);
  let models = resolvedCards(cwd, env, host);
  const provider = stringFlag(flags, "provider");
  if (provider) models = models.filter((card) => card.provider === provider);
  if (flags.json) {
    stdout.write(`${JSON.stringify(models, null, 2)}\n`);
    return 0;
  }
  if (models.length === 0) {
    stdout.write("no Coding models are configured. Run: baton config\n");
    return 0;
  }
  stdout.write(`cards: ${models.length}\n`);
  for (const m of models) stdout.write(`  ${m.id}${m.route_id ? ` → ${m.route_id}` : ""}${m.reasoning_effort ? ` @${m.reasoning_effort}` : ""}  [${m.executable ? "available" : "unavailable"}] — ${m.strengths}\n`);
  return 0;
}

function cmdMatch(args: string[], cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv): number {
  validateCommandArgs(args, { value: ["host"], boolean: ["json"], positional: "allow" });
  const flags = parseFlags(args);
  const text = positionalText(args);
  if (!text) {
    throw new Error("usage: baton match <text>");
  }
  try {
    const host = runtimeHost(flags, cwd, env);
    const cards = resolvedCards(cwd, env, host);
    const unit = buildSelectionUnit({
      cwd, host, key: "preview", description: text, prompt: text, cards,
      automaticCards: cardsForAutomaticSelection(cwd, cards, text, host, env),
      codingModels: codingModelsForHost(cwd, env, host),
      env,
    });
    assertRecommendedSelectionAvailable([unit]);
    if (flags.json) stdout.write(`${JSON.stringify(unit, null, 2)}\n`);
    else {
      stdout.write(`preferred: ${unit.recommended_model_id || "none"} (${unit.recommendation_reason})\n`);
      for (const candidate of unit.candidates.filter((item) => item.selectable)) {
        const quota = candidate.quota.status === "unknown"
          ? `unknown (${candidate.quota.reason})`
          : candidate.quota.windows.map((item) => `${item.label} remaining ${item.remaining_percent.toFixed(2)}%`).join("; ");
        stdout.write(`  candidate ${candidate.model_id}: ${candidate.strengths}\n`);
        stdout.write(`    task score ${candidate.task_score ?? "none"}; catalog evidence=active CLI; quota ${quota}; callable=yes\n`);
      }
    }
    return 0;
  } catch (err) {
    if (err instanceof CardMatchError) {
      stdout.write(`blocked: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

