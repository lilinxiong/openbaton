export type WorkUnitKind = "concrete" | "deliberative";
export type CoordinationMode = "terminal-only" | "checkpointed";

export interface WorkUnitContract {
  schema_version: 1;
  kind: WorkUnitKind;
  objective: string;
  deliverable: string;
  done_when: string;
  classification: "explicit" | "inferred";
}

export interface CoordinationPolicy {
  mode: CoordinationMode;
  progress_interval_ms: number | null;
}

export interface CompileWorkUnitOptions {
  kind?: WorkUnitKind | null;
  deliverable?: string | null;
  doneWhen?: string | null;
}

const CONCRETE = /\b(implement|fix|edit|add|remove|rename|migrate|refactor|run|build|test|update|write|create|delete|verify|document|ship|change)\b|(?:实现|修复|修改|新增|添加|删除|重命名|迁移|重构|运行|构建|测试|更新|写入|创建|验证|落地)/i;
const DELIBERATIVE = /\b(explore|investigate|analy[sz]e|analysis|architecture|design|plan|strategy|research|reason|think|evaluate|assess|compare|brainstorm|review|triage)\b|(?:梳理|分析|架构|设计|方案|计划|策略|调研|研究|推理|思考|评估|比较|讨论|排查|探索|复盘|审查)/i;

function firstMatch(text: string, pattern: RegExp): number {
  const match = pattern.exec(text);
  return match?.index ?? -1;
}

/**
 * Prefer bounded execution units. Anything ambiguous is treated as deliberative,
 * because silently running it as terminal-only work would strand the director.
 */
export function inferWorkUnitKind(description: unknown): WorkUnitKind {
  const text = String(description || "").trim();
  const concrete = firstMatch(text, CONCRETE);
  const deliberative = firstMatch(text, DELIBERATIVE);
  if (concrete >= 0 && (deliberative < 0 || concrete <= deliberative)) return "concrete";
  return "deliberative";
}

export function compileWorkUnit(description: unknown, options: CompileWorkUnitOptions = {}): WorkUnitContract {
  const objective = String(description || "").trim();
  if (!objective) throw new Error("work unit objective is required");
  const explicitKind = options.kind || null;
  const kind = explicitKind || inferWorkUnitKind(objective);
  return {
    schema_version: 1,
    kind,
    objective,
    deliverable: String(options.deliverable || "").trim() || (kind === "concrete"
      ? "the requested bounded result plus concise verification evidence"
      : "an evidence-backed recommendation or decision input"),
    done_when: String(options.doneWhen || "").trim() || (kind === "concrete"
      ? "the requested result is produced and the relevant verification boundary is reported"
      : "the question is resolved, or a blocker/decision is returned to the director"),
    classification: explicitKind ? "explicit" : "inferred",
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
