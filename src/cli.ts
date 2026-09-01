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
import { parseApplyUnitScopes, scopeRecord, DEFAULT_WRITE_OPERATIONS, WRITE_OPERATIONS, type ApplyUnitScope } from "./lib/apply-scope.js";
import { authorizeCommitOpsPlanAsync, resolveOpsDispatch, resolveOpsUnitDispatch, type OpsResolution } from "./lib/ops-dispatch.js";
import { normalizeAgentTaskClassification } from "./lib/ops-task.js";
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
import { defaultCompiledApplyHandler } from "./lib/compiled-apply-cli.js";
import { runRollingRun, type RollingRunHandler } from "./commands/run.js";
import { runIntegration, type IntegrationCommandHandler } from "./commands/integration.js";


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

type FlagValue = string | boolean;
type FlagMap = Record<string, FlagValue | FlagValue[]>;

async function readStdinLine(stream: NodeJS.ReadableStream, output: WritableLike): Promise<string> {
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

function resolvedCards(cwd: string, env: NodeJS.ProcessEnv, host: ReturnType<typeof parseHostId>): ModelCard[] {
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

function codingModelsForHost(cwd: string, env: NodeJS.ProcessEnv, host: CliId): string[] {
  return [...configuredCodingModelsForHost(loadConfig(cwd, { env }), host)];
}

function formatExecutionHandle(handle: unknown): string | null {
  if (!handle) return null;
  if (typeof handle === "object" && !Array.isArray(handle)) {
    const value = handle as Record<string, unknown>;
    if (typeof value.kind === "string" && typeof value.value === "string") return `${value.kind}:${value.value}`;
  }
  return typeof handle === "string" ? handle : String(handle);
}

function runtimeHost(flags: FlagMap, cwd: string, env: NodeJS.ProcessEnv): ReturnType<typeof parseHostId> {
  return resolveRuntimeHost({ cwd, env, explicitHost: stringFlag(flags, "host") });
}

function directorOnlyClassification(classification: ReturnType<typeof normalizeAgentTaskClassification>): boolean {
  return classification?.kind === "discussion" || classification?.kind === "analysis";
}

function validateClassificationContract(
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

async function cmdSpawn(args: string[], cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv): Promise<number> {
  validateCommandArgs(args, {
    value: ["host", "unit", "classification", "operation", "unit-classification", "unit-operation", "write-path", "write-ops", "capacity"],
    boolean: ["dispatch", "json", "read-only"],
    positional: "allow",
  });
  const flags = parseFlags(args);
  const host = runtimeHost(flags, cwd, env);
  const text = positionalText(args);
  if (!text) throw new Error("usage: baton spawn <request> [--unit KEY=TEXT ...] [--dispatch]");
  const allCards = resolvedCards(cwd, env, host);
  const codingModels = codingModelsForHost(cwd, env, host);
  const classificationFlag = parseClassificationFlags(flags);
  const unitClassifications = parseClassificationAssignments(multiFlag(flags, "unit-classification"), "--unit-classification");
  const unitOperations = parseOperationAssignments(multiFlag(flags, "unit-operation"), "--unit-operation");
  const declaredUnitDefinitions = parseStandaloneUnits(multiFlag(flags, "unit"));
  // A single request is the one-unit form of the canonical multi-unit proposal.
  const unitDefinitions = declaredUnitDefinitions.length
    ? declaredUnitDefinitions
    : [{ key: "standalone", description: text }];
  const standaloneScopes = parseStandaloneWriteScopes(args, unitDefinitions);
  const writePathsEarly = standaloneScopes.globalPaths;
  const writeOperationsEarly = standaloneScopes.globalOperations;
  validateClassificationContract(classificationFlag.value, unitDefinitions, unitClassifications, unitOperations);
  const explicitModel = null;
  if (unitDefinitions.length) {
    if (writePathsEarly.length && unitDefinitions.length > 1) {
      throw new Error("TASK_SCOPE_REQUIRED: multi-unit standalone writes require per-unit --unit KEY=TASK --write-path PATH declarations");
    }
    const source = {
      source_shape: "multi-unit-v1",
      description: text,
      units: unitDefinitions,
      classification: classificationFlag.value?.kind || null,
      operation: classificationFlag.value?.operation || null,
      unit_classifications: Object.fromEntries([...unitClassifications.entries()].map(([key, value]) => [key, value?.kind || null])),
      unit_operations: Object.fromEntries(unitOperations.entries()),
      write_paths: writePathsEarly,
      write_operations: writePathsEarly.length ? writeOperationsEarly : [],
      ...(standaloneScopes.unitScopes.size ? { unit_scopes: scopeRecord(standaloneScopes.unitScopes) } : {}),
    };
    const resolved = unitDefinitions.map((item, index) => ({
      item,
      index,
      ops: explicitModel
        ? { kind: "not-ops" } as OpsResolution
        : resolveOpsUnitDispatch(cwd, text, item.description, allCards, {
          env,
          host,
          ...(classificationFlag.present ? { classification: classificationFlag.value } : {}),
          ...(unitClassifications.has(item.key) ? { unitClassification: unitClassifications.get(item.key) } : {}),
          ...(unitOperations.has(item.key) ? { operation: unitOperations.get(item.key) } : {}),
        }),
    }));
    const blockedReasons: string[] = [];
    for (const { item, ops } of resolved) {
      if (ops.kind === "blocked") blockedReasons.push(`${item.key}: ${ops.reason}`);
    }
    if (blockedReasons.length) throw new Error(`OPS_ROUTE_UNAVAILABLE: ${blockedReasons.join("; ")}`);

    const units = [];
    const dispatched = [];
    const standaloneIds = nextSpawnIds(cwd, "spn", unitDefinitions.length, env);
    const pendingDispatches: Array<{ key: string; operation: string | null; profile: string; planned: Extract<StandalonePlan, { director_local: false }>; scope?: ApplyUnitScope }> = [];
    const local = [];
    const skipped = [];
    for (const { item, index, ops } of resolved) {
      if (ops.kind === "director") {
        local.push({ key: item.key, operation: ops.operation || null, reason: ops.reason });
        continue;
      }
      if (ops.kind === "empty-index") {
        skipped.push({ key: item.key, operation: ops.operation || null, reason: "empty index, nothing to commit" });
        continue;
      }
      if (ops.kind === "dispatch") {
        let planned = planStandaloneSpawn({
          description: item.description,
          prompt: `${text}\n\nWork unit ${item.key}: ${item.description}\n\n[Baton structured execution]\nclassification: ${ops.classification || "mechanical"}\noperation: ${ops.operation || "(unspecified)"}`,
          cards: allCards,
          explicitModel: ops.card.id,
          cwd,
          taskKind: "concrete",
          selectionApproval: ops.approval,
          host,
          forceDelegate: true,
          env,
          id: standaloneIds[index],
        });
        if (planned.director_local === true) throw new Error(`ops dispatch unexpectedly stayed on the director: ${item.key}`);
        const delegated = planned;
        const itemScope = standaloneScopes.unitScopes.get(item.key)
          || (writePathsEarly.length ? { mode: "write" as const, write_paths: writePathsEarly, allowed_operations: writeOperationsEarly } : undefined);
        if (!writePathsEarly.length && ops.commit_only === true) await authorizeCommitOpsPlanAsync(cwd, delegated);
        pendingDispatches.push({ key: item.key, operation: ops.operation || null, profile: ops.profile, planned: delegated, scope: itemScope });
        continue;
      }
      const unitClassification = unitClassifications.get(item.key) || (classificationFlag.present ? classificationFlag.value : null);
      const directorLocal = directorOnlyClassification(unitClassification);
      if (directorLocal) {
        local.push({ key: item.key, kind: "director-local", operation: null, reason: "tiny unit; no Coding model selection is needed" });
        continue;
      }
      const unit = buildSelectionUnit({
        cwd,
        host,
        key: item.key,
        description: item.description,
        prompt: item.description,
        cards: allCards,
        automaticCards: cardsForAutomaticSelection(cwd, allCards, item.description, host, env),
        codingModels,
        probeRouteIds: [],
        env,
        requestedModelId: explicitModel,
        directorLocal: false,
        metadata: {
          request_index: index,
          classification: unitClassification?.kind || classificationFlag.value?.kind || null,
          operation: unitOperations.get(item.key) || classificationFlag.value?.operation || null,
        },
      });
      units.push(unit);
    }
    if (pendingDispatches.length) {
      await withActivationLockAsync(cwd, env, async () => {
        const sameWaveScopes = [
          ...pendingDispatches
            .filter((item) => item.scope?.mode === "write")
            .map((item) => ({ key: item.key, write_paths: item.scope!.write_paths })),
          ...units
            .map((unit) => ({ key: unit.key, scope: standaloneScopes.unitScopes.get(unit.key) }))
            .filter((item): item is { key: string; scope: ApplyUnitScope } => item.scope?.mode === "write")
            .map((item) => ({ key: item.key, write_paths: item.scope.write_paths })),
        ];
        assertWriteScopesAvailable(cwd, sameWaveScopes, env);
        for (const { key, operation, profile, planned, scope } of pendingDispatches) {
          await materializeStandalonePlanAsync(cwd, planned, {
            env,
            ...(scope?.mode === "write" ? {
              writeAllowlist: scope.write_paths,
              allowedOperations: scope.allowed_operations || [...DEFAULT_WRITE_OPERATIONS],
            } : {}),
          });
          dispatched.push({ key, operation, profile, ticket: planned.ticket });
        }
      }, { host, scope: "both" });
    }
    assertRecommendedSelectionAvailable(units);
    const proposal = units.length ? createSelectionProposal(cwd, {
      source: "standalone",
      host,
      units,
      sourceFingerprint: selectionSourceFingerprint(source),
      payload: source,
      env,
    }) : null;
    const approval = proposal ? await withActivationLockAsync(cwd, env, async () => {
      return await approveRecommendedSelection({ cwd, proposal, cards: allCards, env });
    }, { host, scope: "both" }) : null;
    const createdTickets = dispatched.length > 0 || Boolean(approval?.tickets.length);
    const reservation = await maybeReserveQueuedSpawn(cwd, env, flags, createdTickets);
    if (flags.json) {
      const handled = dispatched.length || local.length || skipped.length;
      const payload = proposal && !handled
        ? { selection_mode: "baton-recommendation", ...approval! }
        : {
          ...(approval ? { selection_mode: "baton-recommendation", recommendation: approval } : { proposal }),
          dispatched: dispatched.map((item) => ({ key: item.key, operation: item.operation, profile: item.profile, ticket: item.ticket })),
          director_local: local,
          skipped,
        };
      stdout.write(`${JSON.stringify(withReservation(payload, reservation), null, 2)}\n`);
    } else {
      for (const item of dispatched) {
        stdout.write(`ops-dispatch ${item.key}: ${item.profile}${item.operation ? `/${item.operation}` : ""}${item.ticket.mode === "commit-only" ? " (commit-only)" : ""} → ${item.ticket.model_id} (${item.ticket.id})\n`);
      }
      for (const item of local) stdout.write(`director-local ${item.key}${item.operation ? `: ${item.operation}` : ""}; ${item.reason}\n`);
      for (const item of skipped) stdout.write(`ops-skip ${item.key}${item.operation ? `: ${item.operation}` : ""}; ${item.reason}\n`);
      if (proposal && approval) printAutomaticRecommendation(stdout, proposal, approval);
      printReservation(stdout, reservation);
      printDispatchIgnored(stdout, flags, createdTickets);
    }
    return 0;
  }
}

const COMPILED_APPLY_FLAGS = new Set(["plan-file", "run", "status", "accept-gate", "text", "reconcile", "task"]);

function hasCompiledApplyFlag(args: string[]): boolean {
  return args.some((arg) => arg.startsWith("--") && COMPILED_APPLY_FLAGS.has(arg.slice(2)));
}

function compiledApplyError(message: string): CodedError {
  const error = new Error(message) as CodedError;
  error.code = "COMPILED_APPLY_INVALID";
  return error;
}

function safeCompiledScalar(raw: string | undefined, flag: string, allowStdin = false): string {
  if (raw === undefined || raw.startsWith("--")) throw compiledApplyError(`--${flag} requires a value`);
  const value = raw.trim();
  if (!value) throw compiledApplyError(`--${flag} requires a non-empty value`);
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw compiledApplyError(`--${flag} contains unsafe control characters`);
  if (!allowStdin && value === "-") throw compiledApplyError(`--${flag} contains an unsafe value`);
  return value;
}

/** Gate evidence is sanitized by the parent acceptance API.  Preserve the
 * original text here so multiline evidence can be normalized at that single
 * ownership boundary instead of being rejected by argument parsing. */
function safeCompiledText(raw: string | undefined): string {
  if (raw === undefined || raw.startsWith("--")) throw compiledApplyError("--text requires a value");
  const value = raw.trim();
  if (!value) throw compiledApplyError("--text requires a non-empty value");
  return value;
}

function compiledApplyFlagValue(args: string[], key: string): string | undefined {
  const marker = `--${key}`;
  for (let index = 0; index < args.length; index += 1) if (args[index] === marker) return args[index + 1];
  return undefined;
}

function parseCompiledApplyInvocation(args: string[], cwd: string, env: NodeJS.ProcessEnv): CompiledApplyInvocation {
  // Keep this allowlist separate from the legacy parser: compiled flags are a
  // new protocol, while manual apply retains its established grammar.
  validateCommandArgs(args, {
    value: ["host", "plan-file", "run", "accept-gate", "text", "task"],
    boolean: ["dispatch", "json", "status", "reconcile", "unit", "write-path", "write-ops", "read-only"],
    positional: "single",
  });

  const singletonFlags = new Set(["host", "plan-file", "run", "status", "accept-gate", "text", "reconcile", "task", "dispatch", "json"]);
  const seen = new Set<string>();
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (!singletonFlags.has(key)) continue;
    if (seen.has(key)) throw compiledApplyError(`duplicate --${key}`);
    seen.add(key);
  }

  const scope = ["unit", "write-path", "write-ops", "read-only"].find((key) => args.includes(`--${key}`));
  if (scope) throw compiledApplyError(`compiled apply forbids manual scope --${scope}`);

  const planFileRaw = compiledApplyFlagValue(args, "plan-file");
  const runRaw = compiledApplyFlagValue(args, "run");
  const gateRaw = compiledApplyFlagValue(args, "accept-gate");
  const textRaw = compiledApplyFlagValue(args, "text");
  const taskRaw = compiledApplyFlagValue(args, "task");
  const planFile = planFileRaw === undefined ? null : safeCompiledScalar(planFileRaw, "plan-file", true);
  const run = runRaw === undefined ? null : safeCompiledScalar(runRaw, "run");
  const gate = gateRaw === undefined ? null : safeCompiledScalar(gateRaw, "accept-gate");
  const text = textRaw === undefined ? null : safeCompiledText(textRaw);
  const task = taskRaw === undefined ? null : safeCompiledScalar(taskRaw, "task");
  const status = args.includes("--status");
  const reconcile = args.includes("--reconcile");
  const changeRaw = firstPositionalArg(args);
  const change = changeRaw === null ? null : safeCompiledScalar(changeRaw, "change");
  const modeCount = Number(planFile !== null) + Number(status) + Number(gate !== null) + Number(reconcile);
  if (modeCount !== 1) throw compiledApplyError("compiled apply requires exactly one operation: --plan-file, --status, --accept-gate, or --reconcile");
  if (planFile !== null && (status || gate !== null || reconcile)) throw compiledApplyError("compiled apply operation modes are mutually exclusive");
  if (status && (gate !== null || reconcile) || gate !== null && reconcile) throw compiledApplyError("compiled apply operation modes are mutually exclusive");
  if ((status || gate !== null || reconcile) && !run) throw compiledApplyError("--run is required for compiled run operations");
  if (text !== null && gate === null) throw compiledApplyError("--text only accompanies --accept-gate");
  if (gate !== null && text === null) throw compiledApplyError("--accept-gate requires --text SUMMARY");
  if (task !== null && !reconcile) throw compiledApplyError("--task only accompanies --reconcile");
  if (args.includes("--dispatch") && planFile === null) throw compiledApplyError("--dispatch only accompanies --plan-file");

  const hostRaw = compiledApplyFlagValue(args, "host");
  const host = hostRaw === undefined ? null : safeCompiledScalar(hostRaw, "host");
  const mode: CompiledApplyMode = planFile !== null ? (run ? "successor" : "initial") : status ? "status" : gate !== null ? "accept-gate" : "reconcile";
  const operation: CompiledApplyOperation = mode === "status" ? "status" : mode === "accept-gate" ? "accept-gate" : mode === "reconcile" ? "reconcile" : "plan";
  return {
    operation, mode, change, run, run_id: run, plan_file: planFile, plan: null,
    dispatch: args.includes("--dispatch"), status, accept_gate: gate, text, reconcile, task,
    json: args.includes("--json"), host, cwd, env,
  };
}

async function readCompiledPlan(planFile: string, cwd: string, stdin: NodeJS.ReadableStream, injectedStdin: string | undefined): Promise<string> {
  if (planFile !== "-") return fs.readFileSync(path.isAbsolute(planFile) ? planFile : path.resolve(cwd, planFile), "utf8");
  if (injectedStdin !== undefined) return injectedStdin;
  const chunks: string[] = [];
  for await (const chunk of stdin as AsyncIterable<Uint8Array | string>) chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  return chunks.join("");
}

function writeCompiledHandlerResult(stdout: WritableLike, result: unknown): void {
  if (result === undefined) return;
  if (typeof result === "string") {
    stdout.write(result.endsWith("\n") ? result : `${result}\n`);
    return;
  }
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function cmdCompiledApply(
  args: string[], cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv,
  stdin: NodeJS.ReadableStream, injectedStdin: string | undefined, handler?: CompiledApplyHandler,
): Promise<number> {
  const invocation = parseCompiledApplyInvocation(args, cwd, env);
  const input = invocation.plan_file === null
    ? invocation
    : { ...invocation, plan: await readCompiledPlan(invocation.plan_file, cwd, stdin, injectedStdin) };
  // Keep the injectable boundary for tests and embedding callers.  Normal
  // CLI use gets the production protocol handler only when no override was
  // supplied.
  const result = await (handler || defaultCompiledApplyHandler)(input);
  writeCompiledHandlerResult(stdout, result);
  return 0;
}

async function cmdApply(
  args: string[],
  cwd: string,
  stdout: WritableLike,
  env: NodeJS.ProcessEnv,
  stdin: NodeJS.ReadableStream,
  injectedStdin: string | undefined,
  compiledApplyHandler?: CompiledApplyHandler,
): Promise<number> {
  if (hasCompiledApplyFlag(args)) {
    return await cmdCompiledApply(args, cwd, stdout, env, stdin, injectedStdin, compiledApplyHandler);
  }
  validateCommandArgs(args, {
    value: ["host", "unit", "write-path", "write-ops", "capacity"],
    boolean: ["dispatch", "json", "read-only"],
    positional: "single",
  });
  const flags = parseFlags(args);
  const host = runtimeHost(flags, cwd, env);
  const change = firstPositionalArg(args);
  const cards = resolvedCards(cwd, env, host);
  const codingModels = codingModelsForHost(cwd, env, host);
  if (!detectOpenSpecRoot(cwd) && !change) {
    stdout.write("OpenSpec is not in this project. baton still works standalone:\n");
    stdout.write("  baton spawn \"explore the auth module\"\n");
    stdout.write("Create a change with OpenSpec when you want 1+1>2 apply.\n");
    return 2;
  }
  const scopes = parseApplyUnitScopes(args);
  const dispatch = flagOn(flags, "dispatch");
  const changeDir = resolveApplyChange(cwd, change);
  const pending = loadTasksFromChangeDir(changeDir).tasks.filter((task) => task.status === "pending");
  const scopedTaskIds = pending.map(applyTaskId);
  const taskPayload = { pending_tasks: scopedTaskIds };
  if (!dispatch) {
    if (flags.json) stdout.write(`${JSON.stringify(taskPayload, null, 2)}\n`);
    else stdout.write(`pending OpenSpec tasks: ${scopedTaskIds.join(", ") || "none"}\n`);
    return 0;
  }
  if (!scopes.size) {
    const err = new Error("TASK_SCOPE_REQUIRED: pass --unit ID with --write-path PATH or --read-only") as CodedError;
    err.code = "TASK_SCOPE_REQUIRED";
    throw err;
  }
  const pendingById = new Map(pending.map((task) => [applyTaskId(task), task]));
  for (const unitId of scopes.keys()) {
    const task = pendingById.get(unitId) || pending.find((item) => item.number === unitId);
    if (!task) {
      const err = new Error("TASK_SCOPE_REQUIRED: scoped units are not pending tasks") as CodedError;
      err.code = "TASK_SCOPE_REQUIRED";
      throw err;
    }
  }
  // Scope keys use the stable synthetic `line-N` id for unnumbered tasks.
  // Matching against task.number (the empty string in that case) silently
  // dropped otherwise validated pending tasks before ticket creation.
  const tasks = pending.filter((task) => scopes.has(applyTaskId(task)));
  const units = [];
  for (const task of tasks) {
    const prompt = formatTaskPrompt(task);
    const unit = buildSelectionUnit({
      cwd,
      host,
      key: task.number,
      description: task.description,
      prompt,
      cards,
      automaticCards: cardsForAutomaticSelection(cwd, cards, prompt, host, env),
      codingModels,
      probeRouteIds: [],
      env,
      requestedModelId: null,
      // An explicitly scoped OpenSpec unit is an executable implementation
      // request.  Its prose must never reclassify it as a tiny director edit.
      directorLocal: false,
      metadata: { line_index: task.line_index, section: task.section, classification: "implementation" },
    });
    units.push(unit);
  }
  const taskSource = pending.map((task) => ({ number: task.number, description: task.description, section: task.section }));
  assertRecommendedSelectionAvailable(units);
  const proposal = createSelectionProposal(cwd, {
    source: "openspec",
    host,
    units,
    sourceFingerprint: selectionSourceFingerprint(taskSource),
    payload: {
      change: change || changeDir.split(/[\\/]/).at(-1),
      change_dir: changeDir,
      unit_scopes: scopeRecord(scopes),
    },
    env,
  });
  const approval = await withActivationLockAsync(cwd, env, async () => {
    return await approveRecommendedSelection({ cwd, proposal, cards, env });
  }, { host, scope: "both" });
  const createdTickets = Boolean(approval?.tickets.length);
  const reservation = await maybeReserveQueuedSpawn(cwd, env, flags, createdTickets);
  if (flags.json) {
    stdout.write(`${JSON.stringify(withReservation({ selection_mode: "baton-recommendation", ...approval, ...taskPayload }, reservation), null, 2)}\n`);
  } else {
    stdout.write(`pending OpenSpec tasks: ${scopedTaskIds.join(", ") || "none"}\n`);
    printAutomaticRecommendation(stdout, proposal, approval);
    printReservation(stdout, reservation);
    printDispatchIgnored(stdout, flags, createdTickets);
  }
  return 0;
}

function cmdStatus(args: string[], cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv): number {
  validateCommandArgs(args, { value: ["host"], boolean: ["json"], positional: "none" });
  sessionUid(env);
  const flags = parseFlags(args);
  let cfg = null;
  try {
    cfg = loadConfig(cwd, { env });
  } catch (cause: unknown) {
    const err = cause instanceof Error ? cause as CodedError : new Error(String(cause)) as CodedError;
    if (err.code === "BATON_NOT_INITIALIZED") {
      stdout.write("baton is not initialized. Run: baton init\n");
      return 2;
    }
    throw err;
  }
  const host = runtimeHost(flags, cwd, env);
  const cards = resolvedCards(cwd, env, host);
  const executableCards = cards.filter((card) => card.executable).length;
  const cliProfile = cliProfileForHost(cfg, host);
  const snapshot = readRouteSnapshot(cwd, { host, env });
  const executableRoutes = snapshot?.routes.filter((route) => !route.disabled).length || 0;
  const selections = listSelectionProposals(cwd, env).filter((item) => !item.host || item.host === host);
  // General status keeps the complete workspace ticket inventory. Capacity
  // itself is reported separately below, grouped by (host, session_uid).
  const spawns = listSpawns(cwd, env);
  const capacityTrees = dispatchWorkspaceCapacitySnapshots(cwd, { env });
  const compatibilityBlockers = dispatchCompatibilityBlockers(cwd, env);
  const running = spawns.filter((s) => s.status === "running").length;
  const queued = spawns.filter((s) => s.status === "queued").length;
  const dispatching = spawns.filter((s) => s.status === "dispatching").length;
  const terminal = spawns.filter((s) => ["completed", "errored", "timed_out", "closed", "done"].includes(s.status)).length;
  const configuredDispatchRoutes = [...new Set([...
    cliProfile.coding_models,
    cliProfile.runner,
    cliProfile.longctx,
  ].filter(Boolean))];
  const availableDispatchRoutes = configuredDispatchRoutes.filter((routeId) =>
    snapshot?.routes.some((route) => route.route_id === routeId && !route.disabled));
  const coreDispatchReady = Boolean(snapshot && availableDispatchRoutes.length > 0);
  const coreDispatchReason = !snapshot
    ? "ROUTE_SNAPSHOT_MISSING"
    : !availableDispatchRoutes.length ? "CONFIGURED_ROUTES_UNAVAILABLE" : "READY";
  const codingAvailability = cliProfile.coding_models.map((routeId) => {
    const state = availabilityForRoute(cwd, { host, routeId }, new Date(), env);
    const catalogRoute = snapshot?.routes.find((route) => route.route_id === routeId);
    const eligibility = !snapshot
      ? { eligible: false, code: "ROUTE_SNAPSHOT_MISSING", reason: "run baton config to capture the active CLI model catalog" }
      : !catalogRoute
        ? { eligible: false, code: "ROUTE_NOT_IN_ACTIVE_CATALOG", reason: "route is not present in the captured active CLI model catalog" }
        : catalogRoute.disabled
          ? { eligible: false, code: "ROUTE_DISABLED", reason: "route is disabled in the captured active CLI model catalog" }
          : state.status === "exhausted"
            ? { eligible: false, code: "DURABLE_QUOTA_EXHAUSTED", reason: state.reason || "quota is durably exhausted" }
            : state.status === "probe_due"
              ? {
                eligible: false,
                code: state.probe_available ? "PROBE_DUE" : "PROBE_LEASE_HELD",
                reason: state.probe_available
                  ? "route is recoverable by one dispatch-side probe lease"
                  : "route is waiting for the current probe lease to complete or expire",
              }
              : { eligible: true, code: "AVAILABLE", reason: "route is present, enabled, and not durably exhausted" };
    return {
      route_id: routeId,
      availability_scope: "host-profile",
      eligible: eligibility.eligible,
      eligibility_code: eligibility.code,
      eligibility_reason: eligibility.reason,
      status: state.status,
      reason: state.reason,
      next_probe_at: state.next_probe_at,
      probe_available: state.probe_available,
    };
  });
  const codingDispatchReady = codingAvailability.some((route) => route.eligible);
  const codingDispatchReason = codingDispatchReady ? "READY" : "CODING_MODELS_EXHAUSTED";
  const spawnOutput = spawns.map((s) => ({
    id: s.id,
    status: s.status,
    model_id: s.model_id,
    execution_handle: s.execution_handle ? formatExecutionHandle(s.execution_handle) : null,
  }));
  if (flags.json) {
    stdout.write(`${JSON.stringify({
      host,
      core_dispatch_ready: coreDispatchReady,
      core_dispatch_reason: coreDispatchReason,
      coding_dispatch_ready: codingDispatchReady,
      coding_dispatch_reason: codingDispatchReason,
      coding_models: codingAvailability,
      cards: { total: cards.length, executable: executableCards },
      max_depth: effectiveMaxDepthForHost(cfg, host),
      capacity_trees: capacityTrees,
      compatibility_blockers: compatibilityBlockers,
      cli_models: { executable: executableRoutes, snapshot: snapshot?.fingerprint || null },
      selections: {
        total: selections.length,
        pending: selections.filter((item) => item.status === "pending_confirmation").length,
        approved: selections.filter((item) => item.status === "approved").length,
      },
      spawns: { total: spawns.length, dispatching, running, queued, terminal, tickets: spawnOutput },
      openspec: readOpenSpecStatus(cwd),
    }, null, 2)}\n`);
    return 0;
  }
  stdout.write("baton status\n");
  stdout.write(`  core dispatch: ${coreDispatchReady ? "ready" : "not-ready"} (${coreDispatchReason})\n`);
  stdout.write(`  Coding priority: ${cliProfile.coding_models.length ? cliProfile.coding_models.join(" > ") : "(none)"} (${codingDispatchReason})\n`);
  for (const route of codingAvailability) stdout.write(`    ${route.route_id}: ${route.status}; ${route.eligibility_code} (${route.eligibility_reason})${route.next_probe_at ? `; probe ${route.next_probe_at}` : ""}\n`);
  stdout.write(`  cards: ${cards.length} configured CLI model/effort candidates (${executableCards} executable)\n`);
  stdout.write("  model selection: automatic (no runtime confirmation UI)\n");
  stdout.write(`  cli: ${host}\n`);
  stdout.write(`  max_depth: ${effectiveMaxDepthForHost(cfg, host)}\n`);
  stdout.write("  capacity trees:\n");
  stdout.write("    scope: per host + session_uid; root excluded; descendants share one pool\n");
  for (const tree of capacityTrees) {
    const sources = tree.capacity_sources.length
      ? tree.capacity_sources.map((source) => `${source.kind}=${source.value}${source.applied ? "*" : ""}`).join(",")
      : "unknown";
    stdout.write(`    ${tree.host} session=${tree.session_uid} capacity=${tree.capacity ?? "unknown"} active=${tree.active} available=${tree.available ?? "unknown"} sources=${sources}\n`);
  }
  if (compatibilityBlockers.length) {
    stdout.write("  compatibility blockers:\n");
    for (const blocker of compatibilityBlockers) {
      stdout.write(`    ${blocker.code} ${blocker.ticket_id || blocker.file} status=${blocker.status || "unknown"}: ${blocker.reason}\n`);
    }
  }
  stdout.write(`  CLI models: ${executableRoutes}${snapshot ? ` snapshot=${snapshot.fingerprint}` : " (run baton config)"}\n`);
  stdout.write(`  selections: ${selections.length}  pending ${selections.filter((item) => item.status === "pending_confirmation").length}  approved ${selections.filter((item) => item.status === "approved").length}\n`);
  stdout.write(`  spawns: ${spawns.length}  dispatching ${dispatching}  running ${running}  queued ${queued}  terminal ${terminal}\n`);
  for (const s of spawns) {
    const extra = s.conclusion ? ` → ${s.conclusion}` : s.progress ? ` → ${s.progress.phase}: ${s.progress.summary}` : "";
    const kind = s.work_unit?.kind ? ` ${s.work_unit.kind}` : "";
    const handle = s.execution_handle ? ` execution_handle=${formatExecutionHandle(s.execution_handle)}` : "";
    stdout.write(`    ${s.id}  ${s.status}${kind}  ${s.model_id || "director"}${handle}  ${s.description}${extra}\n`);
  }
  const os = readOpenSpecStatus(cwd);
  stdout.write(`  openspec (${os.source}): ${os.text}\n`);
  return 0;
}

function printAutomaticRecommendation(stdout: WritableLike, proposal: SelectionProposal, output: SelectionApprovalOutput): void {
  stdout.write(`auto-approved ${proposal.id} by Baton recommendation\n`);
  for (const unit of proposal.units) {
    if (unit.director_local) {
      stdout.write(`  ${unit.key}: director-local\n`);
      continue;
    }
    const selected = output.approvals.find((approval) => approval.key === unit.key)?.selected_model_id || unit.recommended_model_id;
    const candidate = unit.candidates.find((item) => item.model_id === selected);
    const speed = candidate?.speed_optimized
      ? `; fast=${candidate.service_tier || "model"} via ${candidate.speed_signals.join("+")}`
      : "";
    stdout.write(`  ${unit.key}: ${selected} (score=${candidate?.task_score ?? "none"}; effort=${unit.target_reasoning_effort}; context=${unit.estimated_context_tokens}${speed})\n`);
  }
  for (const ticket of output.tickets) stdout.write(`  ticket ${ticket.id} queued; dispatch remains host-owned\n`);
}

function parseFlags(args: string[]): FlagMap {
  const flags: FlagMap = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      i += 1;
      rememberFlag(flags, key, next);
    } else {
      rememberFlag(flags, key, true);
    }
  }
  return flags;
}

type PositionalPolicy = "allow" | "single" | "none";

/** Parse only the current command grammar; unknown options must reach the ordinary parser error. */
function validateCommandArgs(
  args: string[],
  {
    value = [],
    boolean = [],
    positional = "allow",
  }: { value?: readonly string[]; boolean?: readonly string[]; positional?: PositionalPolicy },
): void {
  const valueFlags = new Set(value);
  const booleanFlags = new Set(boolean);
  let positionalCount = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positionalCount += 1;
      if (positional === "none") throw new Error(`unexpected argument: ${arg}`);
      if (positional === "single" && positionalCount > 1) throw new Error(`unexpected argument: ${arg}`);
      continue;
    }
    const key = arg.slice(2);
    if (!key || (!valueFlags.has(key) && !booleanFlags.has(key))) throw new Error(`unknown option: ${arg}`);
    if (valueFlags.has(key)) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
    }
  }
}

interface ClassificationFlags {
  present: boolean;
  value: ReturnType<typeof normalizeAgentTaskClassification>;
}

/** Parse the director-owned structured execution contract from CLI flags. */
function parseClassificationFlags(flags: FlagMap): ClassificationFlags {
  const rawFlag = stringFlag(flags, "classification");
  const operation = stringFlag(flags, "operation");
  const present = rawFlag !== undefined || operation !== undefined;
  if (!present) return { present: false, value: null };
  if (rawFlag === undefined) throw new Error("--operation requires --classification mechanical|long-context|implementation|analysis|discussion|general");
  let raw: unknown = rawFlag;
  const trimmed = rawFlag.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      raw = JSON.parse(trimmed);
    } catch {
      throw new Error("--classification must be a class name or JSON object with kind");
    }
  }
  const normalized = normalizeAgentTaskClassification(raw);
  if (!normalized) throw new Error("--classification must be mechanical, long-context, implementation, analysis, discussion, or general");
  return {
    present: true,
    value: operation === undefined ? normalized : { ...normalized, operation: operation.trim() || null },
  };
}

function parseClassificationAssignments(values: string[], flagName: string): Map<string, ReturnType<typeof normalizeAgentTaskClassification>> {
  const result = new Map<string, ReturnType<typeof normalizeAgentTaskClassification>>();
  for (const value of values) {
    const index = value.indexOf("=");
    const key = index > 0 ? value.slice(0, index).trim() : "";
    const classification = index > 0 ? value.slice(index + 1).trim() : "";
    if (!key || !classification) throw new Error(`${flagName} must use KEY=mechanical|long-context|implementation|analysis|discussion|general`);
    if (result.has(key)) throw new Error(`duplicate ${flagName} assignment: ${key}`);
    const parsed = normalizeAgentTaskClassification(classification);
    if (!parsed) throw new Error(`${flagName} must use KEY=mechanical|long-context|implementation|analysis|discussion|general`);
    result.set(key, parsed);
  }
  return result;
}

function parseOperationAssignments(values: string[], flagName: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const value of values) {
    const index = value.indexOf("=");
    const key = index > 0 ? value.slice(0, index).trim() : "";
    const operation = index > 0 ? value.slice(index + 1).trim() : "";
    if (!key || !operation) throw new Error(`${flagName} must use KEY=LABEL`);
    if (result.has(key)) throw new Error(`duplicate ${flagName} assignment: ${key}`);
    result.set(key, operation);
  }
  return result;
}

function stringFlag(flags: FlagMap, key: string): string | undefined {
  const value = flags[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i -= 1) {
      if (typeof value[i] === "string") return value[i] as string;
    }
  }
  return undefined;
}

function rememberFlag(flags: FlagMap, key: string, value: FlagValue): void {
  const prev = flags[key];
  if (prev === undefined) flags[key] = value;
  else if (Array.isArray(prev)) prev.push(value);
  else flags[key] = [prev, value];
}

function flagOn(flags: FlagMap, key: string): boolean {
  const value = flags[key];
  if (value === true || value === "true") return true;
  if (Array.isArray(value)) return value.some((item) => item === true || item === "true");
  return false;
}

type SpawnReservation = Awaited<ReturnType<typeof reserveNext>>;

async function maybeReserveQueuedSpawn(
  cwd: string,
  env: NodeJS.ProcessEnv,
  flags: FlagMap,
  createdTickets: boolean,
): Promise<SpawnReservation | null> {
  if (!flagOn(flags, "dispatch") || !createdTickets) return null;
  // Use the same environment-derived tree identity as ticket creation before
  // refilling the dispatch reservation.
  sessionUid(env);
  const host = runtimeHost(flags, cwd, env);
  const capacityFlag = stringFlag(flags, "capacity");
  return await reserveNext(cwd, {
    capacity: capacityFlag != null ? Number(capacityFlag) : undefined,
    host,
    env,
  });
}

function withReservation<T extends Record<string, unknown>>(payload: T, reservation: SpawnReservation | null): T | (T & SpawnReservation) {
  if (!reservation) return payload;
  return { ...payload, reserved: reservation.reserved, blocked: reservation.blocked, snapshot: reservation.snapshot };
}

function printReservation(stdout: WritableLike, reservation: SpawnReservation | null): void {
  if (!reservation) return;
  if (!reservation.reserved.length) stdout.write("reserved: none; ticket stays queued until dispatch next\n");
  for (const item of reservation.reserved) {
    stdout.write(`reserved ${item.ticket_id}: ${item.model}${item.mode === "commit-only" ? " (commit-only)" : ""}\n`);
  }
  for (const item of reservation.blocked) stdout.write(`blocked ${item.ticket_id}: ${item.code}\n`);
}

function printDispatchIgnored(stdout: WritableLike, flags: FlagMap, createdTickets: boolean): void {
  if (flagOn(flags, "dispatch") && !createdTickets) {
    stdout.write("spawn --dispatch ignored; nothing queued to reserve\n");
  }
}

/** All values of a repeatable flag, in order. Comma-separated values are split by callers. */
function multiFlag(flags: FlagMap, key: string): string[] {
  const value = flags[key];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function parseStandaloneUnits(values: string[]): Array<{ key: string; description: string }> {
  const units: Array<{ key: string; description: string }> = [];
  const keys = new Set<string>();
  for (const value of values) {
    const index = value.indexOf("=");
    const key = index > 0 ? value.slice(0, index).trim() : "";
    const description = index > 0 ? value.slice(index + 1).trim() : "";
    if (!key || !description) throw new Error("--unit must use KEY=BUSINESS_TASK");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(key)) throw new Error(`invalid --unit key: ${key}`);
    if (keys.has(key)) throw new Error(`duplicate --unit key: ${key}`);
    keys.add(key);
    units.push({ key, description });
  }
  return units;
}

interface StandaloneWriteScopeFlags {
  globalPaths: string[];
  globalOperations: SafetyOperation[];
  unitScopes: Map<string, ApplyUnitScope>;
}

/** Parse standalone write declarations while retaining each unit's boundary.
 * The one-unit form keeps the historical global flags. For multiple units,
 * --unit KEY=TASK selects the unit for following --write-path/--write-ops;
 * KEY=PATH/KEY=OPS assignment forms are accepted as an order-independent
 * convenience for callers constructing argv programmatically. */
function parseStandaloneWriteScopes(args: string[], units: Array<{ key: string; description: string }>): StandaloneWriteScopeFlags {
  const known = new Set(units.map((unit) => unit.key));
  const globalPaths: string[] = [];
  const globalOperations: SafetyOperation[] = [];
  const unitScopes = new Map<string, ApplyUnitScope>();
  let explicitGlobalOperations = false;
  let current: string | null = null;
  const operationsFor = (raw: string): SafetyOperation[] => {
    const values = raw.split(",").map((item) => item.trim()).filter(Boolean) as SafetyOperation[];
    if (!values.length || values.some((item) => !WRITE_OPERATIONS.includes(item))) {
      throw new Error("--write-ops must contain write,create,delete,rename,chmod");
    }
    return [...new Set(values)];
  };
  const scopeFor = (key: string): ApplyUnitScope => {
    let scope = unitScopes.get(key);
    if (!scope) {
      scope = { mode: "write", write_paths: [] };
      unitScopes.set(key, scope);
    }
    return scope;
  };
  const assignment = (value: string, kind: "path" | "ops"): { key: string; value: string } | null => {
    const index = value.indexOf("=");
    if (index <= 0 || !known.has(value.slice(0, index).trim())) return null;
    return { key: value.slice(0, index).trim(), value: value.slice(index + 1).trim() };
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--unit") {
      const raw = args[index + 1];
      if (raw) {
        const key = raw.slice(0, raw.indexOf("=")).trim();
        if (known.has(key)) current = key;
        index += 1;
      }
      continue;
    }
    if (arg !== "--write-path" && arg !== "--write-ops") continue;
    const raw = args[index + 1];
    if (raw === undefined || raw.startsWith("--")) continue;
    index += 1;
    const kind = arg === "--write-path" ? "path" : "ops";
    const parsed = assignment(raw, kind);
    const key = units.length > 1 ? (parsed?.key || current) : null;
    const value = parsed?.value || raw;
    if (key && known.has(key)) {
      const scope = scopeFor(key);
      if (kind === "path") {
        for (const item of value.split(",").map((part) => part.trim()).filter(Boolean)) {
          if (!scope.write_paths.includes(item)) scope.write_paths.push(item);
        }
      } else {
        scope.allowed_operations = [...new Set([...(scope.allowed_operations || []), ...operationsFor(value)])];
      }
    } else if (kind === "path") {
      for (const item of value.split(",").map((part) => part.trim()).filter(Boolean)) if (item) globalPaths.push(item);
    } else {
      explicitGlobalOperations = true;
      globalOperations.push(...operationsFor(value));
    }
  }
  if (!globalOperations.length) globalOperations.push(...DEFAULT_WRITE_OPERATIONS);
  if (explicitGlobalOperations && !globalPaths.length) {
    throw new Error("TASK_SCOPE_REQUIRED: write operations require --write-path");
  }
  for (const scope of unitScopes.values()) {
    if (!scope.write_paths.length) {
      throw new Error("TASK_SCOPE_REQUIRED: per-unit write operations require --write-path");
    }
    if (!scope.allowed_operations?.length) scope.allowed_operations = [...DEFAULT_WRITE_OPERATIONS];
  }
  return { globalPaths, globalOperations: [...new Set(globalOperations)], unitScopes };
}

function firstPositionalArg(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      if (args[i + 1] && !args[i + 1].startsWith("--")) i += 1;
      continue;
    }
    return args[i];
  }
  return null;
}

function positionalText(args: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      if (args[i + 1] && !args[i + 1].startsWith("--")) i += 1;
      continue;
    }
    parts.push(args[i]);
  }
  return parts.join(" ").trim();
}
