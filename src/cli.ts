import { initProject } from "./commands/init.js";
import { updateProject } from "./commands/update.js";
import { runCapabilities } from "./commands/capabilities.js";
import { runDispatch } from "./commands/dispatch.js";
import { runRoutes } from "./commands/routes.js";
import { runConversation } from "./commands/conversation.js";
import { runHost } from "./commands/host.js";
import { cliPromptChoices, runConfig } from "./commands/config.js";
import { GUARD_HOSTS, runGuard } from "./commands/guard.js";
import {
  approveRecommendedSelection,
  assertRecommendedSelectionAvailable,
  runSelection,
  type SelectionApprovalOutput,
} from "./commands/selection.js";
import {
  cliProfileForHost,
  configuredSubagentModelsForHost,
  effectiveMaxConcurrentForHost,
  effectiveMaxDepthForHost,
  loadConfig,
} from "./lib/config.js";
import { CardMatchError } from "./lib/cards.js";
import { persistedCapacity, reserveNext } from "./lib/dispatch.js";
import { detectInvokingHost, parseHostId, resolveRuntimeHost } from "./lib/hosts.js";
import { listSpawns, persistStandalonePlan, planStandaloneSpawn, type StandalonePlan } from "./lib/spawn.js";
import { formatTaskPrompt, resolveApplyChange } from "./lib/apply.js";
import { applyTaskId, planApplyWaves } from "./lib/apply-waves.js";
import { parseApplyUnitScopes, scopeRecord } from "./lib/apply-scope.js";
import { APPLY_WRITE_CONFLICT, findBatchWriteConflicts, findInFlightWriteConflicts } from "./lib/apply-batch.js";
import { authorizeCommitOpsPlan, resolveOpsDispatch, resolveOpsUnitDispatch, type OpsResolution } from "./lib/ops-dispatch.js";
import { normalizeAgentTaskClassification } from "./lib/ops-task.js";
import { detectOpenSpecRoot, loadTasksFromChangeDir, readOpenSpecStatus } from "./lib/openspec.js";
import { buildWriteReceipt, readReceipt } from "./lib/receipt.js";
import { captureBaseline, type SafetyOperation } from "./lib/safety.js";
import { buildRouteCandidates, readRouteSnapshot } from "./lib/routes.js";
import { artificialAnalysisDbPath } from "./lib/paths.js";
import { cardsForAutomaticSelection } from "./lib/route-health.js";
import {
  buildSelectionUnit,
  createSelectionProposal,
  listSelectionProposals,
  selectionSourceFingerprint,
  type SelectionProposal,
} from "./lib/selection.js";
import { directorMayRun } from "./lib/hygiene.js";
import { CLI_IDS, parseCliId } from "./adapters/registry.js";
import type { CliAdapterProvider, CliId } from "./adapters/contract.js";
import { createTerminalPrompt, isInteractiveIo, type SelectPrompt } from "./lib/prompt.js";
import type { ModelCard } from "./types.js";
import type { CodedError, WritableLike } from "./types.js";

const APPLY_SECTION_ORDER = "APPLY_SECTION_ORDER";

interface RunOptions {
  cwd?: string;
  stdout?: WritableLike;
  stderr?: WritableLike;
  stdin?: NodeJS.ReadableStream | string;
  env?: NodeJS.ProcessEnv;
  adapterProvider?: CliAdapterProvider;
  fetchImpl?: typeof fetch;
  prompt?: SelectPrompt;
}

type FlagValue = string | boolean;
type FlagMap = Record<string, FlagValue | FlagValue[]>;

export const VERSION = "0.2.0";

function resolvedCards(cwd: string, env: NodeJS.ProcessEnv, host: ReturnType<typeof parseHostId>): ModelCard[] {
  const cfg = loadConfig(cwd, { env });
  const profile = cliProfileForHost(cfg, host);
  const allowed = new Set(configuredSubagentModelsForHost(cfg, host));
  if (!allowed.size) return [];
  const snapshot = readRouteSnapshot(cwd, { host, env });
  if (!snapshot || snapshot.cli !== host || !profile.enabled) return [];
  return buildRouteCandidates(cwd, artificialAnalysisDbPath(cwd), { host, env })
    .map((candidate) => candidate.card)
    .filter((card) => card.route_id && allowed.has(card.route_id));
}

function runtimeHost(flags: FlagMap, cwd: string, env: NodeJS.ProcessEnv): ReturnType<typeof parseHostId> {
  return resolveRuntimeHost({ cwd, env, explicitHost: stringFlag(flags, "host") });
}

function batonProfileEnabled(cwd: string, env: NodeJS.ProcessEnv, host: ReturnType<typeof parseHostId>): boolean {
  try {
    return cliProfileForHost(loadConfig(cwd, { env }), host).enabled;
  } catch {
    return false;
  }
}

function directorOnlyClassification(classification: ReturnType<typeof normalizeAgentTaskClassification>): boolean {
  return classification?.kind === "discussion" || classification?.kind === "analysis";
}

function validateClassificationContract(
  hostEnabled: boolean,
  classification: ReturnType<typeof normalizeAgentTaskClassification>,
  unitDefinitions: Array<{ key: string; description: string }>,
  unitClassifications: Map<string, ReturnType<typeof normalizeAgentTaskClassification>>,
  unitOperations: Map<string, string>,
): void {
  const knownUnits = new Set(unitDefinitions.map((item) => item.key));
  for (const key of [...unitClassifications.keys(), ...unitOperations.keys()]) {
    if (!knownUnits.has(key)) throw new Error(`CLASSIFICATION_UNIT_UNKNOWN: ${key} is not a declared --unit`);
  }
  if (!hostEnabled) return;
  if (!unitDefinitions.length) {
    if (!classification) throw new Error("CLASSIFICATION_REQUIRED: enabled Baton host requires a director classification before ticket creation");
    return;
  }
  for (const unit of unitDefinitions) {
    const unitClassification = unitClassifications.get(unit.key) || null;
    if (!classification && !unitClassification) {
      throw new Error(`CLASSIFICATION_REQUIRED: enabled Baton host requires a classification for unit ${unit.key} before ticket creation`);
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
const HOSTS = CLI_IDS.join("|");

const HELP = `baton — CLI-neutral director for ${CLI_IDS.join(", ")}
既能独立，又能 1+1>2

Standalone: cards + native spawn + mechanical ops + director context hygiene. Complete without OpenSpec.
Together: OpenSpec owns breakdown/status; baton owns who runs each task and keeps
the director context clean. Apply is multi-model, uncapped, card-routed execution
of OpenSpec tasks, with conclusions written back. Not a thin adapter.
The selected CLI owns model visibility; Baton routes only within the configured candidate set.
Interactive init/config use arrow-key select; space toggles CLIs and subagent models.

Usage:
  baton init [--force] [--cli ${HOSTS}]  initialize Baton + host skills
  baton update                        refresh host skills + global config defaults
  baton guard status|install|hook [--host ${GUARD_HOSTS.join("|")}]  inspect/install a host guard or serve hook stdin
  baton models refresh|status|candidates [--host ${HOSTS}]  inspect/refresh one CLI model catalog
  baton cards [--host ${HOSTS}] [--ranked|--unranked] [--provider ID] [--json]
  baton host detect [--json]               resolve invoking host from runtime signals
  baton config [--cli ${HOSTS}] [--runner MODEL|-] [--longctx MODEL|-]
               [--subagent-model MODEL|all] [--enable|--disable]
  baton match <text> [--host ${HOSTS}]  disclose preferred/candidate models without creating work
  baton spawn <request> [--host ${HOSTS}] [--unit KEY=TEXT ...] [--classification mechanical|long-context|implementation|analysis|discussion|general] [--operation LABEL]
               [--unit-classification KEY=CLASS ...] [--unit-operation KEY=LABEL ...] [--dispatch]
               director classification is authoritative; operation is free-form audit metadata
  baton apply [change] [--host ${HOSTS}]  plan the ready OpenSpec wave (no tickets)
  baton apply [change] [--host ${HOSTS}] --dispatch --unit ID --write-path PATH --unit ID --write-path PATH|--read-only
               director-scoped dispatch of the order-ready subset; --dispatch without --unit is rejected
  baton capabilities refresh --provider aa --key-file PATH
  baton capabilities status
  baton capabilities show ROUTE [--profile PROFILE]
  baton dispatch next --host HOST --capacity N --json
  baton dispatch bind TICKET [--agent-id ID] [--task-name CODEX_TASK_NAME] --host HOST --json
  baton dispatch defer TICKET --host HOST --code AGENT_LIMIT_REACHED [--observed-capacity N] --json
  baton dispatch probe TICKET --host HOST --agent-id ID --state pending_init|running|interrupted|shutdown|not_found --json
  baton dispatch progress TICKET --host HOST --phase PHASE --text "short status" --json
  baton dispatch complete TICKET --host HOST --text "short conclusion" [--release] --json
  baton dispatch release TICKET --host HOST --agent-id ID --json
  baton dispatch fail|close TICKET --host HOST [--release] --json
  baton dispatch timeout TICKET --host HOST --probe-sequence N [--release] --json
  baton dispatch recover --host HOST --json
  baton dispatch status --host HOST --json
  baton status [--host ${HOSTS}]  director queue + OpenSpec status if present
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
  fetchImpl,
  prompt,
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
        return cmdUpdate(cwd, stdout, env);
      case "guard":
        return runGuard(args, { cwd, stdout, stderr, env, stdin: injectedStdin });
      case "cards":
        return cmdCards(args, cwd, stdout, env);
      case "match":
        return cmdMatch(args, cwd, stdout, env);
      case "config":
        return await runConfig(args, { cwd, stdout, stdin: streamStdin, env, adapterProvider, prompt });
      case "spawn":
        return await cmdSpawn(args, cwd, stdout, env);
      case "apply":
        return await cmdApply(args, cwd, stdout, env);
      case "selection":
        return runSelection(args, { cwd, stdout, cards: resolvedCards(cwd, env, runtimeHost(parseFlags(args), cwd, env)), env, host: runtimeHost(parseFlags(args), cwd, env) });
      case "conclude":
        throw new Error("LEGACY_CLI_SURFACE_REMOVED: use the host dispatch lifecycle to complete tickets");
      case "capabilities":
        return await runCapabilities(args, { cwd, stdout, env, fetchImpl: fetchImpl || globalThis.fetch });
      case "dispatch":
        return runDispatch(args, { cwd, stdout, env });
      case "routes":
      case "models":
        return await runRoutes(args, { cwd, stdout, env, adapterProvider, host: runtimeHost(parseFlags(args), cwd, env) });
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
  const flags = parseFlags(args);
  const force = Boolean(flags.force) || args.includes("--force");
  if (flags.tools) throw new Error(`--tools is not supported; baton init installs the ${CLI_IDS.join(", ")} host skills`);
  const cliFlag = stringFlag(flags, "cli");
  let clis: CliId[] | undefined;
  if (cliFlag) clis = [parseCliId(cliFlag)];
  else if (prompt || isInteractiveIo(stdin, stdout)) {
    const ask = prompt || createTerminalPrompt({ stdin, stdout, env });
    let initial: CliId[] = [];
    try {
      const detected = detectInvokingHost(env);
      if (detected) initial = [detected];
    } catch { /* ambiguous runtime hosts: no preselection */ }
    clis = await ask.multiSelect({
      message: "Select CLI",
      choices: cliPromptChoices(),
      initial,
      required: true,
    });
    if (!clis.length) throw new Error("select at least one CLI");
  }
  const result = await initProject(cwd, { force, cli: clis?.[0], env });
  stdout.write(`initialized ${result.dir}\n`);
  for (const f of result.created) stdout.write(`  wrote ${f}\n`);
  for (const f of result.skipped) stdout.write(`  kept  ${f} (use --force to replace)\n`);
  if (clis?.length) {
    stdout.write(`  cli: ${clis.join(", ")}\n`);
  }
  for (const item of result.guards) {
    const label = item.host === "claude" ? "Claude Code" : item.host === "grok" ? "Grok" : "Codex";
    stdout.write(`  ${label} guard: ${item.action} at ${item.display_path}\n`);
  }
  stdout.write("  Trust it in Codex: open `/hooks`, review the Baton-owned entries, and trust them.\n");
  stdout.write("  Note: specialized tool paths may opt out of the default Codex hook path.\n");
  stdout.write("  Claude Code applies user settings hooks without a trust prompt; review them with `/hooks`.\n");
  stdout.write("  Grok global hooks apply without a trust prompt; review them with `/hooks`.\n");
  if (clis?.length && !cliFlag) {
    stdout.write("\n");
    return runConfig([], { cwd, stdout, stdin, env, adapterProvider, prompt, clis });
  }
  stdout.write("\nNext: run `baton config`; choose CLIs, their runner/longctx labels, and the subagent candidate models.\n");
  stdout.write("Model visibility comes from the selected CLI. Later routing is automatic.\n");
  stdout.write("OpenSpec is optional. baton is complete without it.\n");
  return 0;
}

function cmdUpdate(cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv): number {
  const result = updateProject(cwd, { env });
  stdout.write("updated Baton global files\n");
  for (const a of result.actions) stdout.write(`  ${a}\n`);
  stdout.write("  Trust the Codex guard in Codex: open `/hooks` and review/trust the Baton-owned entries.\n");
  stdout.write("  Note: specialized tool paths may opt out of the default Codex hook path.\n");
  stdout.write("  Grok global hooks apply without a trust prompt; review them with `/hooks`.\n");
  return 0;
}

function cmdCards(args: string[], cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv): number {
  if (args[0] === "add") throw new Error("cards add is not supported; configure exact CLI model ids with `baton config`");
  const flags = parseFlags(args);
  const host = runtimeHost(flags, cwd, env);
  let models = resolvedCards(cwd, env, host);
  if (flags.ranked) models = models.filter((card) => card.capability?.ranked);
  if (flags.unranked) models = models.filter((card) => !card.capability?.ranked);
  const provider = stringFlag(flags, "provider");
  if (provider) models = models.filter((card) => card.provider === provider);
  if (flags.json) {
    stdout.write(`${JSON.stringify(models, null, 2)}\n`);
    return 0;
  }
  if (models.length === 0) {
    stdout.write("no enabled subagent models. Run: baton config\n");
    return 0;
  }
  stdout.write(`cards: ${models.length}\n`);
  for (const m of models) stdout.write(`  ${m.id}${m.route_id ? ` → ${m.route_id}` : ""}${m.reasoning_effort ? ` @${m.reasoning_effort}` : ""}  [${m.executable ? (m.capability?.ranked ? "ranked" : "unranked") : "unavailable"}] — ${m.strengths}\n`);
  return 0;
}

function cmdMatch(args: string[], cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv): number {
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
      automaticCards: cardsForAutomaticSelection(cwd, cards, text, host),
    });
    if (flags.json) stdout.write(`${JSON.stringify(unit, null, 2)}\n`);
    else {
      stdout.write(`preferred: ${unit.recommended_model_id || "none"} (${unit.recommendation_reason})\n`);
      for (const candidate of unit.candidates.filter((item) => item.selectable)) {
        const aa = candidate.aa_scores;
        const quota = candidate.quota.status === "unknown"
          ? `unknown (${candidate.quota.reason})`
          : candidate.quota.windows.map((item) => `${item.label} remaining ${item.remaining_percent.toFixed(2)}%`).join("; ");
        stdout.write(`  candidate ${candidate.model_id}: ${candidate.strengths}\n`);
        stdout.write(`    task score ${candidate.task_score ?? "unranked"}; AA intelligence=${aa.intelligence ?? "unknown"}, coding=${aa.coding ?? "unknown"}, agentic=${aa.agentic ?? "unknown"}; quota ${quota}; callable=yes\n`);
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
  const flags = parseFlags(args);
  const host = runtimeHost(flags, cwd, env);
  const text = positionalText(args);
  if (!text) throw new Error("usage: baton spawn <request> [--unit KEY=TEXT ...] [--dispatch]");
  const allCards = resolvedCards(cwd, env, host);
  const hostEnabled = batonProfileEnabled(cwd, env, host);
  const removedSpawnFlags = ["task-kind", "deliverable", "done-when"];
  const removedSpawnFlag = removedSpawnFlags.find((key) => Object.hasOwn(flags, key));
  if (removedSpawnFlag) throw new Error(`LEGACY_CLI_SURFACE_REMOVED: --${removedSpawnFlag} is not part of the structured spawn contract`);
  const removedClassificationFlags = [
    "execution", "execution-class", "kind", "class", "category", "task-class",
    "mechanical", "long-context", "longctx", "operation-label", "action", "op",
  ];
  const removedClassificationFlag = removedClassificationFlags.find((key) => Object.hasOwn(flags, key));
  if (removedClassificationFlag) throw new Error(`LEGACY_CLI_SURFACE_REMOVED: --${removedClassificationFlag} is not part of the structured classification contract`);
  const classificationFlag = parseClassificationFlags(flags);
  const unitClassifications = parseClassificationAssignments(multiFlag(flags, "unit-classification"), "--unit-classification");
  const unitOperations = parseOperationAssignments(multiFlag(flags, "unit-operation"), "--unit-operation");
  const declaredUnitDefinitions = parseStandaloneUnits(multiFlag(flags, "unit"));
  // A single request is the one-unit form of the canonical multi-unit proposal.
  const unitDefinitions = declaredUnitDefinitions.length
    ? declaredUnitDefinitions
    : [{ key: "standalone", description: text }];
  const writePathsEarly = multiFlag(flags, "write-path").flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);
  const allowedWriteOperations = new Set<SafetyOperation>(["write", "create", "delete", "rename", "chmod"]);
  const writeOpsFlags = multiFlag(flags, "write-ops");
  const writeOperationsEarly = (writeOpsFlags.length ? writeOpsFlags : ["write,create"])
    .flatMap((item) => item.split(","))
    .map((item) => item.trim())
    .filter(Boolean) as SafetyOperation[];
  if (writePathsEarly.length && (!writeOperationsEarly.length || writeOperationsEarly.some((item) => !allowedWriteOperations.has(item)))) {
    throw new Error("--write-ops must contain write,create,delete,rename,chmod");
  }
  validateClassificationContract(hostEnabled, classificationFlag.value, unitDefinitions, unitClassifications, unitOperations);
  if (stringFlag(flags, "model")) {
    throw new Error("MODEL_SELECTION_REMOVED: --model is not supported; configure cli.<id>.subagent_models and let Baton route automatically");
  }
  const explicitModel = null;
  if (unitDefinitions.length) {
    if (writePathsEarly.length && unitDefinitions.length > 1) {
      throw new Error("multi-unit standalone proposals are read-only; create separately scoped write proposals");
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
    const commitUnits = resolved.filter(({ ops }) => ops.kind === "dispatch" && ops.commit_only === true);
    if (commitUnits.length > 1) {
      throw new Error(`MULTIPLE_COMMIT_UNITS: one request may contain only one commit-only unit (${commitUnits.map(({ item }) => item.key).join(", ")})`);
    }
    const blockedReasons: string[] = [];
    for (const { item, ops } of resolved) {
      if (ops.kind === "blocked") blockedReasons.push(`${item.key}: ${ops.reason}`);
    }
    if (blockedReasons.length) throw new Error(`OPS_ROUTE_UNAVAILABLE: ${blockedReasons.join("; ")}`);

    const units = [];
    const dispatched = [];
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
        });
        if (!writePathsEarly.length && ops.commit_only === true) planned = authorizeCommitOpsPlan(cwd, planned);
        planned = materializeStandaloneWriteScope(cwd, planned, writePathsEarly, writeOperationsEarly);
        const ticket = persistStandalonePlan(cwd, planned);
        dispatched.push({ key: item.key, operation: ops.operation || null, profile: ops.profile, ticket });
        continue;
      }
      const unitClassification = unitClassifications.get(item.key) || (classificationFlag.present ? classificationFlag.value : null);
      const directorLocal = directorOnlyClassification(unitClassification)
        || (!hostEnabled && !classificationFlag.present)
        || (!hostEnabled && directorMayRun(item.description));
      if (directorLocal) {
        local.push({ key: item.key, kind: "director-local", operation: null, reason: "tiny unit; no subagent model selection is needed" });
        continue;
      }
      units.push(buildSelectionUnit({
        cwd,
        host,
        key: item.key,
        description: item.description,
        prompt: item.description,
        cards: allCards,
        automaticCards: cardsForAutomaticSelection(cwd, allCards, item.description, host),
        requestedModelId: explicitModel,
        directorLocal: false,
        metadata: {
          request_index: index,
          classification: unitClassification?.kind || classificationFlag.value?.kind || null,
          operation: unitOperations.get(item.key) || classificationFlag.value?.operation || null,
        },
      }));
    }
    assertRecommendedSelectionAvailable(units);
    const proposal = units.length ? createSelectionProposal(cwd, {
      source: "standalone",
      host,
      units,
      sourceFingerprint: selectionSourceFingerprint(source),
      payload: source,
    }) : null;
    const approval = proposal ? approveRecommendedSelection({ cwd, proposal, cards: allCards, env }) : null;
    const createdTickets = dispatched.length > 0 || Boolean(approval?.tickets.length);
    const reservation = maybeReserveQueuedSpawn(cwd, env, flags, createdTickets);
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

async function cmdApply(args: string[], cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv): Promise<number> {
  const flags = parseFlags(args);
  const host = runtimeHost(flags, cwd, env);
  const change = firstPositionalArg(args);
  if (multiFlag(flags, "route").length) {
    throw new Error("MODEL_SELECTION_REMOVED: --route is not supported; configure cli.<id>.subagent_models and let Baton route automatically");
  }
  const cards = resolvedCards(cwd, env, host);
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
  const overlay = planApplyWaves(pending);
  const orderReadyIds = new Set(overlay.order_ready?.task_ids || []);
  const wavePayload = { waves: overlay.waves, ready_wave: overlay.ready, order_ready: overlay.order_ready };
  if (!dispatch) {
    if (flags.json) stdout.write(`${JSON.stringify(wavePayload, null, 2)}\n`);
    else printApplyWaves(stdout, overlay);
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
    if (!orderReadyIds.has(applyTaskId(task))) {
      const err = new Error(`${APPLY_SECTION_ORDER}: section order is not satisfied`) as CodedError;
      err.code = APPLY_SECTION_ORDER;
      throw err;
    }
  }
  const pairwise = findBatchWriteConflicts(scopes);
  if (pairwise.length) {
    const err = new Error(`${APPLY_WRITE_CONFLICT}: write sets intersect`) as CodedError;
    err.code = APPLY_WRITE_CONFLICT;
    throw err;
  }
  const liveStatuses = new Set(["reserved", "dispatching", "running"]);
  const inflight = listSpawns(cwd)
    .filter((ticket) => liveStatuses.has(ticket.status))
    .filter((ticket) => (ticket.target_host || ticket.dispatch_host || ticket.host) === host)
    .map((ticket) => {
      const write_allowlist = ticket.receipt_id
        ? readReceipt(cwd, ticket.receipt_id).scope.write_allowlist
        : null;
      return {
        id: ticket.id,
        status: ticket.status,
        mode: ticket.mode,
        read_only: ticket.read_only,
        write_allowlist,
      };
    });
  const inflightConflicts = findInFlightWriteConflicts(scopes, inflight);
  if (inflightConflicts.length) {
    const err = new Error(`${APPLY_WRITE_CONFLICT}: write sets intersect`) as CodedError;
    err.code = APPLY_WRITE_CONFLICT;
    throw err;
  }
  // Scope keys use the stable synthetic `line-N` id for unnumbered tasks.
  // Matching against task.number (the empty string in that case) silently
  // dropped otherwise validated pending tasks before ticket creation.
  const tasks = pending.filter((task) => orderReadyIds.has(applyTaskId(task)) && scopes.has(applyTaskId(task)));
  const units = [];
  for (const task of tasks) {
    const prompt = formatTaskPrompt(task);
    units.push(buildSelectionUnit({
      cwd,
      host,
      key: task.number,
      description: task.description,
      prompt,
      cards,
      automaticCards: cardsForAutomaticSelection(cwd, cards, prompt, host),
      requestedModelId: null,
      // An explicitly scoped OpenSpec unit is an executable implementation
      // request.  Its prose must never reclassify it as a tiny director edit.
      directorLocal: false,
      metadata: { line_index: task.line_index, section: task.section, classification: "implementation" },
    }));
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
  });
  const approval = approveRecommendedSelection({ cwd, proposal, cards, env });
  const createdTickets = Boolean(approval?.tickets.length);
  const reservation = maybeReserveQueuedSpawn(cwd, env, flags, createdTickets);
  if (flags.json) {
    stdout.write(`${JSON.stringify(withReservation({ selection_mode: "baton-recommendation", ...approval, ...wavePayload }, reservation), null, 2)}\n`);
  } else {
    printApplyWaves(stdout, overlay);
    printAutomaticRecommendation(stdout, proposal, approval);
    printReservation(stdout, reservation);
    printDispatchIgnored(stdout, flags, createdTickets);
  }
  return 0;
}

function cmdStatus(args: string[], cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv): number {
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
  stdout.write("baton status\n");
  const cards = resolvedCards(cwd, env, host);
  const rankedCards = cards.filter((card) => card.executable && card.capability?.ranked).length;
  const unrankedCards = cards.filter((card) => card.executable && !card.capability?.ranked).length;
  stdout.write(`  cards: ${cards.length} configured CLI model/effort candidates (${rankedCards} ranked, ${unrankedCards} unranked)\n`);
  stdout.write("  model selection: automatic (no runtime confirmation UI)\n");
  const cliProfile = cliProfileForHost(cfg, host);
  stdout.write(`  cli: ${host} (${cliProfile.enabled ? "enabled" : "disabled"})\n`);
  stdout.write(`  max_concurrent: ${effectiveMaxConcurrentForHost(cfg, host, env)} (queue beyond this; never refuse)\n`);
  stdout.write(`  max_depth: ${effectiveMaxDepthForHost(cfg, host)}\n`);
  const snapshot = readRouteSnapshot(cwd, { host, env });
  const executableRoutes = snapshot?.routes.filter((route) => !route.disabled).length || 0;
  stdout.write(`  CLI models: ${executableRoutes}${snapshot ? ` snapshot=${snapshot.fingerprint}` : " (run baton config)"}\n`);
  const selections = listSelectionProposals(cwd).filter((item) => !item.host || item.host === host);
  stdout.write(`  selections: ${selections.length}  pending ${selections.filter((item) => item.status === "pending_confirmation").length}  approved ${selections.filter((item) => item.status === "approved").length}\n`);
  const spawns = listSpawns(cwd).filter((s) => (s.target_host || s.dispatch_host || s.host) === host);
  const running = spawns.filter((s) => s.status === "running").length;
  const queued = spawns.filter((s) => s.status === "queued").length;
  const dispatching = spawns.filter((s) => s.status === "dispatching").length;
  const terminal = spawns.filter((s) => ["completed", "errored", "timed_out", "closed", "done"].includes(s.status)).length;
  stdout.write(`  spawns: ${spawns.length}  dispatching ${dispatching}  running ${running}  queued ${queued}  terminal ${terminal}\n`);
  for (const s of spawns) {
    const extra = s.conclusion ? ` → ${s.conclusion}` : s.progress ? ` → ${s.progress.phase}: ${s.progress.summary}` : "";
    const worker = s.agent_id ? ` agent=${s.agent_id}` : "";
    const kind = s.work_unit?.kind ? ` ${s.work_unit.kind}` : "";
    stdout.write(`    ${s.id}  ${s.status}${kind}  ${s.model_id || "director"}${worker}  ${s.description}${extra}\n`);
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
    stdout.write(`  ${unit.key}: ${selected} (score=${candidate?.task_score ?? "fallback"}; effort=${unit.target_reasoning_effort}; context=${unit.estimated_context_tokens}${speed})\n`);
  }
  for (const ticket of output.tickets) stdout.write(`  ticket ${ticket.id} queued; dispatch remains host-owned\n`);
}

function materializeStandaloneWriteScope(
  cwd: string,
  planned: StandalonePlan,
  writePaths: string[],
  writeOperations: SafetyOperation[],
): StandalonePlan {
  if (planned.director_local === true || !writePaths.length) return planned;
  planned.receipt = buildWriteReceipt({
    base: planned.receipt,
    baseline: captureBaseline(cwd),
    writeAllowlist: writePaths,
    allowedOperations: writeOperations,
  });
  planned.ticket.mode = "write";
  planned.ticket.read_only = false;
  planned.ticket.receipt_id = planned.receipt.receipt_id;
  return planned;
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

type SpawnReservation = ReturnType<typeof reserveNext>;

function maybeReserveQueuedSpawn(
  cwd: string,
  env: NodeJS.ProcessEnv,
  flags: FlagMap,
  createdTickets: boolean,
): SpawnReservation | null {
  if (!flagOn(flags, "dispatch") || !createdTickets) return null;
  const cfg = loadConfig(cwd, { env });
  const host = runtimeHost(flags, cwd, env);
  const capacityFlag = stringFlag(flags, "capacity");
  return reserveNext(cwd, {
    capacity: capacityFlag != null ? Number(capacityFlag) : (persistedCapacity(cwd, host) ?? effectiveMaxConcurrentForHost(cfg, host, env)),
    host,
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

function printApplyWaves(stdout: WritableLike, overlay: ReturnType<typeof planApplyWaves>): void {
  if (!overlay.waves.length) {
    stdout.write("apply waves: none\n");
    return;
  }
  const ready = overlay.ready;
  stdout.write(`apply waves: ${overlay.waves.length} remaining; ready wave ${ready?.index ?? "-"} (${ready?.parallel ? "parallel" : "serial"}) ${(ready?.task_ids || []).join(", ")}\n`);
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

function parseTaskRoutes(values: string[]): Map<string, string> {
  const routes = new Map<string, string>();
  for (const value of values) {
    const index = value.indexOf("=");
    const number = index > 0 ? value.slice(0, index).trim() : "";
    const route = index > 0 ? value.slice(index + 1).trim() : "";
    if (!number || !route) throw new Error("--route must use TASK=EXACT_ROUTE[@PROFILE]");
    if (routes.has(number)) throw new Error(`duplicate --route assignment: ${number}`);
    routes.set(number, route);
  }
  return routes;
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
