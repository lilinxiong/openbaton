export type WorkUnitKind = "concrete" | "deliberative";
export type CoordinationMode = "terminal-only" | "checkpointed";

export interface WorkUnitContract {
  schema_version: 1;
  kind: WorkUnitKind;
  objective: string;
  deliverable: string;
  done_when: string;
}

export interface CoordinationPolicy {
  mode: CoordinationMode;
  progress_interval_ms: number | null;
}

export interface CompileWorkUnitOptions {
  kind: WorkUnitKind;
  deliverable?: string | null;
  doneWhen?: string | null;
}

export function compileWorkUnit(description: unknown, options: CompileWorkUnitOptions): WorkUnitContract {
  const objective = String(description || "").trim();
  if (!objective) throw new Error("work unit objective is required");
  const kind = options?.kind;
  if (kind !== "concrete" && kind !== "deliberative") {
    throw new Error("work unit kind is required and must be concrete or deliberative");
  }
  const deliverable = options?.deliverable || null;
  const doneWhen = options?.doneWhen || null;
  return {
    schema_version: 1,
    kind,
    objective,
    deliverable: String(deliverable || "").trim() || (kind === "concrete"
      ? "the requested bounded result plus concise verification evidence"
      : "an evidence-backed recommendation or decision input"),
    done_when: String(doneWhen || "").trim() || (kind === "concrete"
      ? "the requested result is produced and the relevant verification boundary is reported"
      : "the question is resolved, or a blocker/decision is returned to the director"),
  };
}

export function coordinationFor(unit: WorkUnitContract): CoordinationPolicy {
  return unit.kind === "deliberative"
    ? { mode: "checkpointed", progress_interval_ms: 60_000 }
    : { mode: "terminal-only", progress_interval_ms: null };
}

export function buildWorkerPrompt(basePrompt: string, unit: WorkUnitContract, coordination: CoordinationPolicy): string {
  const lines = [
    String(basePrompt || unit.objective).trim(),
    "",
    "[Baton work unit]",
    `kind: ${unit.kind}`,
    `deliverable: ${unit.deliverable}`,
    `done when: ${unit.done_when}`,
  ];
  if (coordination.mode === "checkpointed") {
    lines.push(
      "coordination: checkpointed",
      "Send a brief progress update when the phase changes and before any long wait.",
      "Use only: phase, current result, next step, blocker/decision needed. Do not send tool logs or hidden reasoning.",
    );
  } else {
    lines.push("coordination: terminal-only; return one short conclusion when complete.");
  }
  lines.push("Do not spawn child agents.");
  return lines.join("\n");
}
