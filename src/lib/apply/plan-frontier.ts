import {
  DEFAULT_ACCEPTED_GATE_STATES,
  DEFAULT_ACCEPTED_UNIT_STATES,
  DEFAULT_EXCLUDED_UNIT_STATES,
  buildDependencyMaps,
  isActiveOwnershipBlocking,
  isBetterCandidate,
  isLexEarlier,
  isRuntimeAccepted,
  isRuntimeExcluded,
  namespaceRelation,
  normalizeOwnershipFacts,
  normalizeScopeFacts,
  normalizedFactsFromPlanUnit,
  overlapPaths,
  ownershipNamespace,
  record,
  sortByPlanOrder,
  string
} from "./plan-scope.js";
import {
  ApplyExecutionPlan,
  ApplyPlanActiveOwnership,
  ApplyPlanConflictGraphOptions,
  ApplyPlanConflictGraphResult,
  ApplyPlanDependencyReadyOptions,
  ApplyPlanIndependentSetOptions,
  ApplyPlanIntegrationConflictRisk,
  ApplyPlanRuntimeState,
  ApplyPlanScopeFact,
  ApplyPlanSearchError,
  ApplyPlanUnit
} from "../apply-plan.js";
/**
 * Frontier/dependency analysis for apply execution plans. Split from
 * apply-plan.ts.
 */

export function deriveDependencyReadyUndispatchedUnits(plan: ApplyExecutionPlan, options: ApplyPlanDependencyReadyOptions = {}): string[] {
  const acceptedUnitStates = new Set(options.acceptedUnitStates?.length ? options.acceptedUnitStates : DEFAULT_ACCEPTED_UNIT_STATES);
  const acceptedGateStates = new Set(options.acceptedGateStates?.length ? options.acceptedGateStates : DEFAULT_ACCEPTED_GATE_STATES);
  const excludedUnitStates = new Set(options.excludedUnitStates?.length ? options.excludedUnitStates : DEFAULT_EXCLUDED_UNIT_STATES);
  const excludedUnitIds = new Set(options.excludedUnitIds || []);
  const { unitMap, gateMap } = buildDependencyMaps(plan);
  const gateReady = new Map<string, boolean>();
  const gateEvaluated = new Set<string>();

  const isGateAccepted = (gateId: string): boolean => {
    if (gateReady.has(gateId)) return gateReady.get(gateId)!;
    if (gateEvaluated.has(gateId)) return false;
    gateEvaluated.add(gateId);
    const gate = gateMap.get(gateId);
    if (!gate) return false;
    if (!isRuntimeAccepted(gate.runtime_state, acceptedGateStates)) return false;
    const dependsOn = gate.depends_on || [];
    const dependenciesAccepted = dependsOn.every((id) => unitMap.has(id)
      ? isRuntimeAccepted(unitMap.get(id)?.runtime_state, acceptedUnitStates)
      : isGateAccepted(id));
    const result = dependenciesAccepted && dependsOn.every((id) => {
      if (unitMap.has(id)) return isRuntimeAccepted(unitMap.get(id)?.runtime_state, acceptedUnitStates);
      return isGateAccepted(id);
    });
    gateReady.set(gateId, result);
    return result;
  };

  const ready: string[] = [];
  for (const unit of plan.units) {
    if (excludedUnitIds.has(unit.id)) continue;
    if (isRuntimeExcluded(unit.runtime_state, excludedUnitStates)) continue;
    const dependsOn = unit.depends_on || [];
    const readyByUnits = dependsOn.every((id) => {
      if (!unitMap.has(id)) return false;
      return isRuntimeAccepted(unitMap.get(id)?.runtime_state, acceptedUnitStates);
    });
    const readyByGate = (unit.parent_gate_ids || []).every((gateId) => isGateAccepted(gateId));
    if (readyByUnits && readyByGate) ready.push(unit.id);
  }
  return ready;
}

export function buildFrontierConflictGraph(plan: ApplyExecutionPlan, frontier: readonly string[], options: ApplyPlanConflictGraphOptions = {}): ApplyPlanConflictGraphResult {
  const stableOrder = options.stableOrder && options.stableOrder.length ? options.stableOrder : plan.units.map((unit) => unit.id);
  const declared = new Map<string, ApplyPlanScopeFact[]>();
  const explicit = options.declaredScopeFacts;
  const explicitMap = new Map<string, ApplyPlanScopeFact[]>();
  if (explicit instanceof Map) {
    for (const [unitId, facts] of explicit.entries()) explicitMap.set(unitId, [...facts]);
  } else if (Array.isArray(explicit)) {
    for (const fact of explicit) {
      const existing = explicitMap.get(fact.unit_id);
      if (existing) {
        existing.push(fact);
      } else {
        explicitMap.set(fact.unit_id, [fact]);
      }
    }
  }
  const unitMap = new Map(plan.units.map((unit) => [unit.id, unit]));

  for (const unitId of frontier) {
    const unit = unitMap.get(unitId);
    if (!unit) continue;
    const fromPlan = normalizedFactsFromPlanUnit(unit);
    const fromOverride = normalizeScopeFacts(unitId, explicitMap.get(unitId) || []);
    declared.set(unitId, fromOverride.length ? fromOverride : fromPlan);
  }

  const conflicts = new Map<string, Set<string>>();
  const integrationRisks: ApplyPlanIntegrationConflictRisk[] = [];
  for (const unitId of frontier) conflicts.set(unitId, new Set());
  for (let left = 0; left < frontier.length; left += 1) {
    for (let right = left + 1; right < frontier.length; right += 1) {
      const leftFacts = declared.get(frontier[left]) || [];
      const rightFacts = declared.get(frontier[right]) || [];
      const paths = overlapPaths(leftFacts, rightFacts);
      if (!paths.length) continue;
      const leftNamespace = ownershipNamespace(options.ownershipByUnit, frontier[left]);
      const rightNamespace = ownershipNamespace(options.ownershipByUnit, frontier[right]);
      const relation = namespaceRelation(leftNamespace, rightNamespace);
      if (relation === "different-repository") continue;
      if (relation === "cross-root") {
        const roots = [leftNamespace!.execution_root, rightNamespace!.execution_root].sort() as [string, string];
        integrationRisks.push({
          from: frontier[left], to: frontier[right], repository_id: leftNamespace!.repository_id,
          execution_roots: roots, paths,
        });
        continue;
      }
      conflicts.get(frontier[left])?.add(frontier[right]);
      conflicts.get(frontier[right])?.add(frontier[left]);
    }
  }
  const blockedByActiveOwnership = new Set<string>();
  const activeOwnership = options.activeOwnership || [];
  for (const unitId of frontier) {
    const unitFacts = declared.get(unitId) || [];
    for (const ownership of activeOwnership) {
      if (!isActiveOwnershipBlocking(ownership)) continue;
      const ownershipFacts = normalizeOwnershipFacts(ownership);
      const paths = overlapPaths(unitFacts, ownershipFacts);
      if (!paths.length) continue;
      const candidateNamespace = ownershipNamespace(options.ownershipByUnit, unitId);
      const ownerNamespace = ownership.repository_id && ownership.execution_root
        ? { repository_id: ownership.repository_id, execution_root: ownership.execution_root, ...(ownership.base_tree ? { base_tree: ownership.base_tree } : {}) }
        : undefined;
      const relation = namespaceRelation(candidateNamespace, ownerNamespace);
      if (relation === "different-repository") continue;
      if (relation === "cross-root") {
        const roots = [candidateNamespace!.execution_root, ownerNamespace!.execution_root].sort() as [string, string];
        integrationRisks.push({ from: unitId, to: ownership.key, repository_id: candidateNamespace!.repository_id, execution_roots: roots, paths });
        continue;
      }
      blockedByActiveOwnership.add(unitId);
    }
  }

  return {
    conflicts: new Map([...conflicts.entries()].map(([unitId, linked]) => [unitId, sortByPlanOrder([...linked], stableOrder)])),
    blockedByActiveOwnership,
    integration_conflict_risks: integrationRisks.sort((left, right) => left.from.localeCompare(right.from)
      || left.to.localeCompare(right.to) || left.repository_id.localeCompare(right.repository_id)
      || left.execution_roots.join("\0").localeCompare(right.execution_roots.join("\0"))
      || left.paths.join("\0").localeCompare(right.paths.join("\0"))),
  };
}

export function selectIndependentSet(frontier: readonly string[], conflictGraph: ReadonlyMap<string, readonly string[]>, options: ApplyPlanIndependentSetOptions = {}): string[] {
  const capacity = Math.max(0, Number.isFinite(options.capacity as number) ? Math.floor(options.capacity as number) : 0);
  if (!frontier.length || !capacity) return [];
  const criticalPathByUnit = options.criticalPathByUnit || {};
  const blockedByOption = new Set(options.excludedUnitIds || []);
  const order = [...frontier];
  const candidateUnits = order.filter((unitId) => !blockedByOption.has(unitId));
  const maxCapacity = Math.min(capacity, candidateUnits.length);
  if (maxCapacity === 0) return [];
  const candidateSet = new Set(candidateUnits);
  const adjacencySet = new Map<string, Set<string>>(
    candidateUnits.map((unitId) => [unitId, new Set((conflictGraph.get(unitId) || []).filter((target) => candidateSet.has(target)))]),
  );

  const canSelect = (unitId: string, chosen: ReadonlySet<string>) => {
    for (const existing of chosen) {
      if (adjacencySet.get(unitId)?.has(existing) || adjacencySet.get(existing)?.has(unitId)) return false;
    }
    return true;
  };

  const score = (ids: readonly string[]): number => ids.reduce((total, id) => {
    const value = criticalPathByUnit[id];
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
  const greedy: string[] = [];
  const greedySet = new Set<string>();
  for (const unitId of candidateUnits) {
    if (greedy.length >= maxCapacity) break;
    if (canSelect(unitId, greedySet)) { greedy.push(unitId); greedySet.add(unitId); }
  }
  let best: string[] = greedy;
  const chosenSet = new Set<string>();
  const configuredLimit = Number(options.maxSearchNodes);
  const maxSearchNodes = Number.isFinite(configuredLimit) && configuredLimit > 0 ? Math.floor(configuredLimit) : 1_000_000;
  let searchedNodes = 0;
  const backtrack = (startAt: number, chosen: string[]) => {
    searchedNodes += 1;
    if (searchedNodes > maxSearchNodes) throw new ApplyPlanSearchError(maxSearchNodes);
    if (isBetterCandidate(chosen, best, criticalPathByUnit, order)) best = [...chosen];
    const compatible = candidateUnits.slice(startAt).filter((unitId) => canSelect(unitId, chosenSet));
    const needed = Math.min(maxCapacity - chosen.length, compatible.length);
    const maximumCardinality = chosen.length + needed;
    if (maximumCardinality < best.length) return;
    if (maximumCardinality === best.length) {
      const optimisticScore = score(chosen) + compatible
        .map((id) => Number.isFinite(criticalPathByUnit[id]) ? criticalPathByUnit[id]! : 0)
        .sort((left, right) => right - left)
        .slice(0, needed)
        .reduce((total, value) => total + value, 0);
      const bestScore = score(best);
      if (optimisticScore < bestScore) return;
      if (optimisticScore === bestScore) {
        const lexLowerBound = sortByPlanOrder([...chosen, ...compatible.slice(0, needed)], order);
        if (!isLexEarlier(lexLowerBound, best, order)) return;
      }
    }
    if (startAt >= candidateUnits.length || chosen.length === maxCapacity) {
      return;
    }
    const next = candidateUnits[startAt]!;
    if (chosen.length < maxCapacity && canSelect(next, chosenSet)) {
      chosenSet.add(next);
      chosen.push(next);
      backtrack(startAt + 1, chosen);
      chosen.pop();
      chosenSet.delete(next);
    }
    backtrack(startAt + 1, chosen);
  };
  backtrack(0, []);
  return sortByPlanOrder(best, frontier);
}

export function deriveSafeReadyFrontier(plan: ApplyExecutionPlan, options: {
  capacity: number;
  acceptedUnitStates?: readonly ApplyPlanRuntimeState[];
  acceptedGateStates?: readonly ApplyPlanRuntimeState[];
  excludedUnitStates?: readonly ApplyPlanRuntimeState[];
  excludedUnitIds?: readonly string[];
  declaredScopeFacts?: ReadonlyMap<string, readonly ApplyPlanScopeFact[]> | readonly ApplyPlanScopeFact[];
  activeOwnership?: readonly ApplyPlanActiveOwnership[];
  criticalPathByUnit?: Record<string, number>;
}): string[] {
  const frontier = deriveDependencyReadyUndispatchedUnits(plan, {
    acceptedUnitStates: options.acceptedUnitStates,
    acceptedGateStates: options.acceptedGateStates,
    excludedUnitStates: options.excludedUnitStates,
    excludedUnitIds: options.excludedUnitIds,
  });
  const graph = buildFrontierConflictGraph(plan, frontier, { declaredScopeFacts: options.declaredScopeFacts, activeOwnership: options.activeOwnership, stableOrder: frontier });
  const remainingCritical = options.criticalPathByUnit || remainingCriticalPath(plan);
  return selectIndependentSet(frontier, graph.conflicts, {
    capacity: options.capacity,
    criticalPathByUnit: remainingCritical,
    excludedUnitIds: [...graph.blockedByActiveOwnership],
  });
}

export function graphCycle(nodes: string[], edges: Map<string, string[]>): string[] | null {
  const colour = new Map<string, number>(); const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    colour.set(node, 1); stack.push(node);
    for (const next of [...(edges.get(node) || [])].sort()) {
      if (colour.get(next) === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (!colour.get(next)) { const found = visit(next); if (found) return found; }
    }
    stack.pop(); colour.set(node, 2); return null;
  };
  for (const node of [...nodes].sort()) if (!colour.get(node)) { const found = visit(node); if (found) return found; }
  return null;
}

export function reachable(edges: Map<string, string[]>, from: string, target: string): boolean {
  const seen = new Set<string>(); const todo = [from];
  while (todo.length) { const current = todo.pop()!; if (current === target) return true; if (seen.has(current)) continue; seen.add(current); todo.push(...(edges.get(current) || [])); }
  return false;
}

export function criticalPath(plan: ApplyExecutionPlan): Record<string, number> {
  const validUnits = (Array.isArray(plan.units) ? plan.units : [])
    .filter((unit): unit is ApplyPlanUnit => record(unit) && string(unit.id));
  const units = new Map(validUnits.map((unit) => [unit.id, unit]));
  const done = new Set(validUnits.filter((unit) => unit.runtime_state === "succeeded").map((unit) => unit.id));
  const dependents = new Map<string, string[]>();
  for (const unit of validUnits) {
    for (const dependency of Array.isArray(unit.depends_on) ? unit.depends_on.filter(string) : []) {
      const linked = dependents.get(dependency);
      if (linked) linked.push(unit.id);
      else dependents.set(dependency, [unit.id]);
    }
  }
  const memo = new Map<string, number>();
  const distance = (id: string, visiting = new Set<string>()): number => {
    if (done.has(id)) return 0;
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const value = 1 + Math.max(0, ...(dependents.get(id) || []).map((dependent) => distance(dependent, new Set(visiting))));
    memo.set(id, value); return value;
  };
  return Object.fromEntries([...units.keys()].sort().map((id) => [id, distance(id)]));
}

export function remainingCriticalPath(plan: ApplyExecutionPlan): Record<string, number> { return criticalPath(plan); }
