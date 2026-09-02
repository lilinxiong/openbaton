import {
  CodedError,
  WritableLike
} from "../types.js";
import {
  CompiledApplyHandler,
  codingModelsForHost,
  resolvedCards,
  runtimeHost
} from "../cli.js";
import { detectOpenSpecRoot } from "../lib/openspec-cli.js";
import {
  parseApplyUnitScopes,
  scopeRecord
} from "../lib/apply-scope.js";
import {
  formatTaskPrompt,
  resolveApplyChange
} from "../lib/apply.js";
import { loadTasksFromChangeDir } from "../lib/openspec.js";
import { applyTaskId } from "../lib/task-id.js";
import { buildSelectionUnit } from "../lib/selection-unit.js";
import { cardsForAutomaticSelection } from "../lib/route-health.js";
import { withActivationLockAsync } from "../lib/activation.js";
import {
  maybeReserveQueuedSpawn,
  printDispatchIgnored,
  printReservation,
  withReservation
} from "./spawn.js";
import { printAutomaticRecommendation } from "./status.js";
import {
  approveRecommendedSelection,
  assertRecommendedSelectionAvailable
} from "./selection.js";
import {
  cmdCompiledApply,
  hasCompiledApplyFlag
} from "./compiled-apply.js";
import {
  createSelectionProposal,
  selectionSourceFingerprint
} from "../lib/selection-proposals.js";
import {
  firstPositionalArg,
  flagOn,
  parseFlags,
  validateCommandArgs
} from "../cli-flags.js";
/**
 * `baton apply` command. Split from cli.ts.
 */

export async function cmdApply(
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
