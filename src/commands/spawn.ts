import { WritableLike } from "../types.js";
import {
  ApplyUnitScope,
  DEFAULT_WRITE_OPERATIONS,
  scopeRecord
} from "../lib/apply/scope.js";
import {
  nextSpawnIds,
  sessionUid
} from "../lib/spawn/store.js";
import { buildSelectionUnit } from "../lib/selection/unit.js";
import { cardsForAutomaticSelection } from "../lib/route-health.js";
import { withActivationLockAsync } from "../lib/activation.js";
import { reserveNext } from "../lib/dispatch.js";
import { printAutomaticRecommendation } from "./status.js";
import {
  approveRecommendedSelection,
  assertRecommendedSelectionAvailable
} from "./selection.js";
import {
  codingModelsForHost,
  directorOnlyClassification,
  resolvedCards,
  runtimeHost,
  validateClassificationContract
} from "../cli.js";
import {
  createSelectionProposal,
  selectionSourceFingerprint
} from "../lib/selection/proposals.js";
import {
  assertWriteScopesAvailable,
  materializeStandalonePlanAsync
} from "../lib/ticket-materialization.js";
import {
  StandalonePlan,
  planStandaloneSpawn
} from "../lib/spawn/build.js";
import {
  OpsResolution,
  authorizeCommitOpsPlanAsync,
  resolveOpsUnitDispatch
} from "../lib/ops/dispatch.js";
import {
  FlagMap,
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
  validateCommandArgs
} from "../cli-flags.js";
/**
 * `baton spawn` command: ticket creation plus optional dispatch reservation.
 * Split from cli.ts.
 */

export async function cmdSpawn(args: string[], cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv): Promise<number> {
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


export type SpawnReservation = Awaited<ReturnType<typeof reserveNext>>;

export async function maybeReserveQueuedSpawn(
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

export function withReservation<T extends Record<string, unknown>>(payload: T, reservation: SpawnReservation | null): T | (T & SpawnReservation) {
  if (!reservation) return payload;
  return { ...payload, reserved: reservation.reserved, blocked: reservation.blocked, snapshot: reservation.snapshot };
}

export function printReservation(stdout: WritableLike, reservation: SpawnReservation | null): void {
  if (!reservation) return;
  if (!reservation.reserved.length) stdout.write("reserved: none; ticket stays queued until dispatch next\n");
  for (const item of reservation.reserved) {
    stdout.write(`reserved ${item.ticket_id}: ${item.model}${item.mode === "commit-only" ? " (commit-only)" : ""}\n`);
  }
  for (const item of reservation.blocked) stdout.write(`blocked ${item.ticket_id}: ${item.code}\n`);
}

export function printDispatchIgnored(stdout: WritableLike, flags: FlagMap, createdTickets: boolean): void {
  if (flagOn(flags, "dispatch") && !createdTickets) {
    stdout.write("spawn --dispatch ignored; nothing queued to reserve\n");
  }
}
