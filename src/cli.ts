import { initProject } from "./commands/init.js";
import { updateProject } from "./commands/update.js";
import { listCards } from "./commands/cards.js";
import { runCapabilities } from "./commands/capabilities.js";
import { runDispatch } from "./commands/dispatch.js";
import { ensureRouteSnapshotFresh, runRoutes } from "./commands/routes.js";
import { runConversation } from "./commands/conversation.js";
import { runConfig } from "./commands/config.js";
import { printSelectionProposal, runSelection } from "./commands/selection.js";
import { loadConfig } from "./lib/config.js";
import { CardMatchError } from "./lib/cards.js";
import { listSpawns, persistStandalonePlan, planStandaloneSpawn } from "./lib/spawn.js";
import { concludeSpawn, formatTaskPrompt, resolveApplyChange } from "./lib/apply.js";
import { authorizeCommitOpsPlan, resolveOpsDispatch, resolveOpsUnitDispatch, type OpsResolution } from "./lib/ops-dispatch.js";
import { detectOpenSpecRoot, loadTasksFromChangeDir, readOpenSpecStatus } from "./lib/openspec.js";
import { buildRouteCandidates, readRouteSnapshot } from "./lib/routes.js";
import { artificialAnalysisDbPath } from "./lib/paths.js";
import { cardsForAutomaticSelection } from "./lib/route-health.js";
import { buildSelectionUnit, createSelectionProposal, listSelectionProposals, selectionSourceFingerprint } from "./lib/selection.js";
import { directorMayRun } from "./lib/hygiene.js";
import { FORBIDDEN_SUBAGENT_MODEL_FAMILIES, SUBAGENT_MODEL_POLICY_ID } from "./lib/model-policy.js";
import type { ModelCard } from "./types.js";
import type { OcxResolver, OcxRunner } from "./lib/opencodex.js";
import type { CodexBarResolver, CodexBarRunner } from "./lib/codexbar.js";
import type { CodedError, WritableLike } from "./types.js";

interface RunOptions {
  cwd?: string;
  stdout?: WritableLike;
  stderr?: WritableLike;
  env?: NodeJS.ProcessEnv;
  runner?: OcxRunner;
  resolve?: OcxResolver;
  codexBarRunner?: CodexBarRunner;
  codexBarResolve?: CodexBarResolver;
  fetchImpl?: typeof fetch;
}

type FlagValue = string | boolean;
type FlagMap = Record<string, FlagValue | FlagValue[]>;

export const VERSION = "0.1.0";

function resolvedCards(cwd: string, env: NodeJS.ProcessEnv, runner?: OcxRunner, resolve?: OcxResolver): ModelCard[] {
  ensureRouteSnapshotFresh({ cwd, stdout: { write() {} }, env, runner, resolve });
  return buildRouteCandidates(cwd, artificialAnalysisDbPath(cwd)).map((candidate) => candidate.card);
}

const HELP = `baton — director for multi-model work
既能独立，又能 1+1>2

Standalone: cards + native spawn + director context hygiene. Complete without OpenSpec.
Together: OpenSpec owns breakdown/status; baton owns who runs each task and keeps
the director context clean. Apply is multi-model, uncapped, card-routed execution
of OpenSpec tasks, with conclusions written back. Not a thin adapter.
Built-in subagent policy forbids every gpt-5.5, gpt-5.6-sol, and gpt-5.6-terra route/profile.

Usage:
  baton init [--force]                initialize Baton + Codex skill
  baton update                        refresh Codex skill + global config defaults
  baton routes refresh|status|candidates  refresh Baton once from synchronized OpenCodex state
  baton cards [--ranked|--unranked] [--provider ID] [--json]
  baton config [--runner ROUTE|-] [--longctx ROUTE|-]  choose global ops routes from OpenCodex (~/.baton/config.toml)
  baton match <text>                disclose preferred/candidate models without creating work
  baton spawn <request> [--unit KEY=TEXT ...] [--model ID]  route configured ops units; propose the remaining units once
  baton apply [change] [--route TASK=EXACT_ROUTE]  create an OpenSpec selection proposal
  baton selection show PROPOSAL
  baton selection render PROPOSAL --output PATH --task-label TASK=中文 [--assign TASK=ID]  return one Chinese current-conversation selector
  baton selection render-bundle --proposal SCOPE=WORKSPACE#PROPOSAL ... --output PATH  combine proposals into one Submit
  baton selection approve PROPOSAL --confirm [--model ID] [--route TASK=ID] [--provider ID]
  baton conclude <id> --text "..."  legacy schema-v1 conclusion only
  baton capabilities refresh --provider aa --key-file PATH
  baton capabilities status
  baton capabilities show ROUTE [--profile PROFILE]
  baton dispatch next --host codex --capacity N --json
  baton dispatch bind TICKET --agent-id ID --host codex --json
  baton dispatch defer TICKET --code AGENT_LIMIT_REACHED [--observed-capacity N] --json
  baton dispatch probe TICKET --agent-id ID --state pending_init|running|interrupted|shutdown|not_found --json
  baton dispatch progress TICKET --phase PHASE --text "short status" --json
  baton dispatch complete TICKET --text "short conclusion" --json
  baton dispatch release TICKET --agent-id ID --json
  baton dispatch fail|close TICKET --json
  baton dispatch timeout TICKET --probe-sequence N --json
  baton dispatch recover|status --json
  baton status                      director queue + OpenSpec status if present
  baton help | --help | -h
  baton version | --version | -v
`;

export async function run(argv: string[], {
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  runner,
  resolve,
  codexBarRunner,
  codexBarResolve,
  fetchImpl,
}: RunOptions = {}): Promise<number> {
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
        return await cmdInit(args, cwd, stdout, env);
      case "update":
        return cmdUpdate(cwd, stdout, env);
      case "cards":
        return cmdCards(args, cwd, stdout, env, runner, resolve);
      case "match":
        return cmdMatch(args, cwd, stdout, env, runner, resolve);
      case "config":
        return await runConfig(args, { cwd, stdout, env, runner, resolve, codexBarRunner, codexBarResolve });
      case "spawn":
        return await cmdSpawn(args, cwd, stdout, env, runner, resolve);
      case "apply":
        return await cmdApply(args, cwd, stdout, env, runner, resolve);
      case "selection":
        return runSelection(args, { cwd, stdout, cards: resolvedCards(cwd, env, runner, resolve) });
      case "conclude":
        return cmdConclude(args, cwd, stdout);
      case "capabilities":
        return await runCapabilities(args, { cwd, stdout, env, fetchImpl: fetchImpl || globalThis.fetch });
      case "dispatch":
        return runDispatch(args, { cwd, stdout, env });
      case "routes":
        return runRoutes(args, { cwd, stdout, env, runner, resolve, codexBarRunner, codexBarResolve });
      case "conversation":
        return runConversation(args, { stdout });
      case "status":
        return cmdStatus(cwd, stdout, env, runner, resolve);
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

async function cmdInit(args: string[], cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv): Promise<number> {
  const flags = parseFlags(args);
  const force = Boolean(flags.force) || args.includes("--force");
  if (flags.tools) throw new Error("--tools is not supported; Baton is Codex-only");
  const result = await initProject(cwd, { force, env });
  stdout.write(`initialized ${result.dir}\n`);
  for (const f of result.created) stdout.write(`  wrote ${f}\n`);
  for (const f of result.skipped) stdout.write(`  kept  ${f} (use --force to replace)\n`);
  stdout.write("\nNext: run `baton routes refresh`, inspect `baton cards --ranked`, then `baton spawn` or `baton apply`.\n");
  stdout.write("All executable route/profile IDs come from OpenCodex.\n");
  stdout.write("OpenSpec is optional. baton is complete without it.\n");
  return 0;
}

function cmdUpdate(cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv): number {
  const result = updateProject(cwd, { env });
  stdout.write("updated Baton global files\n");
  for (const a of result.actions) stdout.write(`  ${a}\n`);
  return 0;
}

function cmdCards(args: string[], cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv, runner?: OcxRunner, resolve?: OcxResolver): number {
  ensureRouteSnapshotFresh({ cwd, stdout, env, runner, resolve });
  if (args[0] === "add") throw new Error("cards add is not supported; use an exact OpenCodex route/profile ID");
  const flags = parseFlags(args);
  let models = listCards(cwd, { env });
  if (flags.ranked) models = models.filter((card) => card.capability?.ranked);
  if (flags.unranked) models = models.filter((card) => !card.capability?.ranked);
  const provider = stringFlag(flags, "provider");
  if (provider) models = models.filter((card) => card.provider === provider);
  if (flags.json) {
    stdout.write(`${JSON.stringify(models, null, 2)}\n`);
    return 0;
  }
  if (models.length === 0) {
    stdout.write("no OpenCodex routes. Run: baton routes refresh\n");
    return 0;
  }
  stdout.write(`cards: ${models.length}\n`);
  for (const m of models) stdout.write(`  ${m.id}${m.route_id ? ` → ${m.route_id}` : ""}${m.reasoning_effort ? ` @${m.reasoning_effort}` : ""}  [${m.executable ? (m.capability?.ranked ? "ranked" : "unranked") : "unavailable"}] — ${m.strengths}\n`);
  return 0;
}

function cmdMatch(args: string[], cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv, runner?: OcxRunner, resolve?: OcxResolver): number {
  const text = positionalText(args);
  if (!text) {
    throw new Error("usage: baton match <text>");
  }
  try {
    const cards = resolvedCards(cwd, env, runner, resolve);
    const unit = buildSelectionUnit({
      cwd, key: "preview", description: text, prompt: text, cards,
      automaticCards: cardsForAutomaticSelection(cwd, cards, text),
    });
    const flags = parseFlags(args);
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
      for (const exclusion of unit.policy_exclusions) {
        stdout.write(`  policy excluded ${exclusion.family}: ${exclusion.code} (${exclusion.card_count} cards/profiles)\n`);
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

async function cmdSpawn(args: string[], cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv, runner?: OcxRunner, resolve?: OcxResolver): Promise<number> {
  const flags = parseFlags(args);
  const text = positionalText(args);
  if (!text) throw new Error("usage: baton spawn <request> [--unit KEY=TEXT ...] [--model ID]");
  const allCards = resolvedCards(cwd, env, runner, resolve);
  const kindFlag = stringFlag(flags, "task-kind");
  if (kindFlag && kindFlag !== "concrete" && kindFlag !== "deliberative") {
    throw new Error("--task-kind must be concrete or deliberative");
  }
  const unitDefinitions = parseStandaloneUnits(multiFlag(flags, "unit"));
  const explicitModel = stringFlag(flags, "model") || null;
  const writePathsEarly = multiFlag(flags, "write-path").flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);
  if (unitDefinitions.length) {
    if (writePathsEarly.length) throw new Error("multi-unit standalone proposals are read-only; create separately scoped write proposals");
    const source = {
      source_shape: "multi-unit-v1",
      description: text,
      units: unitDefinitions,
    };
    const resolved = unitDefinitions.map((item, index) => ({
      item,
      index,
      ops: explicitModel
        ? { kind: "not-ops" } as OpsResolution
        : resolveOpsUnitDispatch(cwd, text, item.description, allCards, { env }),
    }));
    for (const { item, ops } of resolved) {
      if (ops.kind === "unavailable") throw new Error(`${item.key}: ${ops.reason}`);
    }
    const commitUnits = resolved.filter(({ ops }) => ops.kind !== "not-ops" && ops.action === "git-commit");
    if (commitUnits.length > 1) {
      throw new Error(`MULTIPLE_COMMIT_UNITS: one request may contain only one commit-only unit (${commitUnits.map(({ item }) => item.key).join(", ")})`);
    }

    const units = [];
    const dispatched = [];
    const local = [];
    const skipped = [];
    for (const { item, index, ops } of resolved) {
      if (ops.kind === "director") {
        local.push({ key: item.key, action: ops.action, reason: ops.reason });
        continue;
      }
      if (ops.kind === "empty-index") {
        skipped.push({ key: item.key, action: ops.action, reason: "empty index, nothing to commit" });
        continue;
      }
      if (ops.kind === "dispatch") {
        let planned = planStandaloneSpawn({
          description: item.description,
          prompt: `${text}\n\nWork unit ${item.key}: ${item.description}`,
          cards: allCards,
          explicitModel: ops.card.id,
          cwd,
          taskKind: ops.action === "git-commit" ? "concrete" : kindFlag === "deliberative" ? "deliberative" : "concrete",
          selectionApproval: ops.approval,
          forceDelegate: true,
        });
        if (ops.action === "git-commit") planned = authorizeCommitOpsPlan(cwd, planned);
        const ticket = persistStandalonePlan(cwd, planned);
        dispatched.push({ key: item.key, action: ops.action, profile: ops.profile, ticket });
        continue;
      }
      units.push(buildSelectionUnit({
        cwd,
        key: item.key,
        description: item.description,
        prompt: item.description,
        cards: allCards,
        automaticCards: cardsForAutomaticSelection(cwd, allCards, item.description),
        requestedModelId: explicitModel,
        directorLocal: directorMayRun(item.description),
        metadata: { request_index: index },
      }));
    }
    const proposal = units.length ? createSelectionProposal(cwd, {
      source: "standalone",
      units,
      sourceFingerprint: selectionSourceFingerprint(source),
      payload: source,
    }) : null;
    if (flags.json) {
      const handled = dispatched.length || local.length || skipped.length;
      stdout.write(`${JSON.stringify(proposal && !handled
        ? proposal
        : {
          proposal,
          dispatched: dispatched.map((item) => ({ key: item.key, action: item.action, profile: item.profile, ticket: item.ticket })),
          director_local: local,
          skipped,
        }, null, 2)}\n`);
    } else {
      for (const item of dispatched) {
        stdout.write(`ops-dispatch ${item.key}: ${item.profile} ${item.action}${item.action === "git-commit" ? " (commit-only)" : ""} → ${item.ticket.model_id} (${item.ticket.id})\n`);
      }
      for (const item of local) stdout.write(`director-local ${item.key}: ${item.action}; ${item.reason}\n`);
      for (const item of skipped) stdout.write(`ops-skip ${item.key}: ${item.action}; ${item.reason}\n`);
      if (proposal) printSelectionProposal(stdout, proposal);
    }
    return 0;
  }
  if (directorMayRun(text)) {
    stdout.write("director-local: tiny unit; no subagent model selection is needed\n");
    stdout.write(`unit: ${text}\n`);
    return 0;
  }
  if (!explicitModel && !writePathsEarly.length) {
    const ops = resolveOpsDispatch(cwd, text, allCards, { env });
    if (ops.kind === "director") {
      stdout.write(`director-local: ${ops.reason}\n`);
      stdout.write(`unit: ${text}\n`);
      return 0;
    }
    if (ops.kind === "empty-index") {
      stdout.write("ops: git-commit skipped; empty index, nothing to commit\n");
      stdout.write(`unit: ${text}\n`);
      return 0;
    }
    if (ops.kind === "unavailable") throw new Error(ops.reason);
    if (ops.kind === "dispatch") {
      let planned = planStandaloneSpawn({
        description: text,
        cards: allCards,
        explicitModel: ops.card.id,
        cwd,
        taskKind: ops.action === "git-commit" ? "concrete" : kindFlag === "deliberative" ? "deliberative" : "concrete",
        deliverable: stringFlag(flags, "deliverable") || null,
        doneWhen: stringFlag(flags, "done-when") || null,
        selectionApproval: ops.approval,
      });
      if (ops.action === "git-commit") planned = authorizeCommitOpsPlan(cwd, planned);
      const ticket = persistStandalonePlan(cwd, planned);
      stdout.write(`ops-dispatch: ${ops.profile} ${ops.action}${ops.action === "git-commit" ? " (commit-only)" : ""} → ${ops.card.id}\n`);
      stdout.write(`  ticket ${ticket.id}  wait for the worker conclusion (success or failure)\n`);
      if (flags.json) stdout.write(`${JSON.stringify(ticket, null, 2)}\n`);
      return 0;
    }
  }
  const writePaths = multiFlag(flags, "write-path").flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);
  const allowed = new Set(["write", "create", "delete", "rename", "chmod"]);
  const opsFlags = multiFlag(flags, "write-ops");
  const operations = (opsFlags.length ? opsFlags : ["write,create"]).flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);
  if (writePaths.length) {
    if (!operations.length || operations.some((item) => !allowed.has(item))) throw new Error("--write-ops must contain write,create,delete,rename,chmod");
  }
  const payload = {
    description: text,
    task_kind: kindFlag || null,
    deliverable: stringFlag(flags, "deliverable") || null,
    done_when: stringFlag(flags, "done-when") || null,
    write_paths: writePaths,
    write_operations: writePaths.length ? operations : [],
  };
  const unit = buildSelectionUnit({
    cwd, key: "standalone", description: text, prompt: text, cards: allCards,
    automaticCards: cardsForAutomaticSelection(cwd, allCards, text),
    requestedModelId: explicitModel,
  });
  const proposal = createSelectionProposal(cwd, {
    source: "standalone",
    units: [unit],
    sourceFingerprint: selectionSourceFingerprint(payload),
    payload,
  });
  if (flags.json) stdout.write(`${JSON.stringify(proposal, null, 2)}\n`);
  else printSelectionProposal(stdout, proposal);
  return 0;
}

async function cmdApply(args: string[], cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv, runner?: OcxRunner, resolve?: OcxResolver): Promise<number> {
  const flags = parseFlags(args);
  const change = firstPositionalArg(args);
  const cards = resolvedCards(cwd, env, runner, resolve);
  if (!detectOpenSpecRoot(cwd) && !change) {
    stdout.write("OpenSpec is not in this project. baton still works standalone:\n");
    stdout.write("  baton spawn \"explore the auth module\"\n");
    stdout.write("Create a change with OpenSpec when you want 1+1>2 apply.\n");
    return 2;
  }
  const routeAssignments = parseTaskRoutes(multiFlag(flags, "route"));
  const changeDir = resolveApplyChange(cwd, change);
  const tasks = loadTasksFromChangeDir(changeDir).tasks.filter((task) => task.status === "pending");
  const pendingNumbers = new Set(tasks.map((task) => task.number));
  for (const number of routeAssignments.keys()) {
    if (!pendingNumbers.has(number)) throw new Error(`--route task is not pending in this change: ${number}`);
  }
  const units = [];
  const dispatched = [];
  for (const task of tasks) {
    const prompt = formatTaskPrompt(task);
    const requested = routeAssignments.get(task.number) || null;
    let directorLocal = directorMayRun(task.description);
    if (!requested && !directorLocal) {
      const ops = resolveOpsDispatch(cwd, task.description, cards, { env });
      if (ops.kind === "unavailable") throw new Error(`${task.number}: ${ops.reason}`);
      if (ops.kind === "director" || ops.kind === "empty-index") directorLocal = true;
      else if (ops.kind === "dispatch") {
        let planned = planStandaloneSpawn({
          description: task.description,
          cards,
          explicitModel: ops.card.id,
          cwd,
          taskKind: "concrete",
          selectionApproval: ops.approval,
        });
        if (ops.action === "git-commit") planned = authorizeCommitOpsPlan(cwd, planned);
        const ticket = persistStandalonePlan(cwd, planned);
        dispatched.push({ number: task.number, ticket, action: ops.action, profile: ops.profile });
        continue;
      }
    }
    units.push(buildSelectionUnit({
      cwd,
      key: task.number,
      description: task.description,
      prompt,
      cards,
      automaticCards: cardsForAutomaticSelection(cwd, cards, prompt),
      requestedModelId: requested,
      directorLocal,
      metadata: { line_index: task.line_index, section: task.section },
    }));
  }
  for (const item of dispatched) {
    stdout.write(`ops-dispatch ${item.number}: ${item.profile} ${item.action} → ${item.ticket.model_id} (${item.ticket.id})\n`);
  }
  if (!units.length) {
    if (flags.json) stdout.write(`${JSON.stringify({ dispatched: dispatched.map((item) => item.ticket) }, null, 2)}\n`);
    return 0;
  }
  const taskSource = tasks.map((task) => ({ number: task.number, description: task.description, section: task.section }));
  const proposal = createSelectionProposal(cwd, {
    source: "openspec",
    units,
    sourceFingerprint: selectionSourceFingerprint(taskSource),
    payload: { change: change || changeDir.split(/[\\/]/).at(-1), change_dir: changeDir },
  });
  if (flags.json) {
    stdout.write(`${JSON.stringify(dispatched.length ? { proposal, dispatched: dispatched.map((item) => item.ticket) } : proposal, null, 2)}\n`);
  } else printSelectionProposal(stdout, proposal);
  return 0;
}

function cmdConclude(args: string[], cwd: string, stdout: WritableLike): number {
  const flags = parseFlags(args);
  const conclusion = stringFlag(flags, "text");
  const id = args.find((a) => !a.startsWith("-") && a !== conclusion);
  if (!id || !conclusion) throw new Error("usage: baton conclude <id> --text \"...\"");
  const result = concludeSpawn(cwd, id, conclusion);
  stdout.write(`concluded ${result.ticket.id}\n`);
  stdout.write(`  ${result.ticket.conclusion}\n`);
  if (result.openspecWritten) {
    stdout.write("  wrote conclusion back into OpenSpec tasks.md\n");
  }
  return 0;
}

function cmdStatus(cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv, runner?: OcxRunner, resolve?: OcxResolver): number {
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
  stdout.write("baton status\n");
  const cards = resolvedCards(cwd, env, runner, resolve);
  const rankedCards = cards.filter((card) => card.executable && card.capability?.ranked).length;
  const unrankedCards = cards.filter((card) => card.executable && !card.capability?.ranked).length;
  stdout.write(`  cards: ${cards.length} OpenCodex routes (${rankedCards} ranked, ${unrankedCards} unranked)\n`);
  stdout.write(`  model policy: ${SUBAGENT_MODEL_POLICY_ID}  forbidden ${FORBIDDEN_SUBAGENT_MODEL_FAMILIES.join(", ")}\n`);
  stdout.write(`  max_concurrent: ${cfg.director.max_concurrent} (queue beyond this; never refuse)\n`);
  const snapshot = readRouteSnapshot(cwd);
  const executableRoutes = snapshot?.routes.filter((route) => !route.disabled).length || 0;
  stdout.write(`  OpenCodex routes: ${executableRoutes}${snapshot ? ` snapshot=${snapshot.fingerprint}` : " (run baton routes refresh)"}\n`);
  const selections = listSelectionProposals(cwd);
  stdout.write(`  selections: ${selections.length}  pending ${selections.filter((item) => item.status === "pending_confirmation").length}  approved ${selections.filter((item) => item.status === "approved").length}\n`);
  const spawns = listSpawns(cwd);
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
