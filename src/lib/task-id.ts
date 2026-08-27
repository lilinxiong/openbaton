import type { OpenSpecTask } from "./openspec.js";

/** Stable identifier shared by CLI task scoping and model selection. */
export function applyTaskId(task: Pick<OpenSpecTask, "number" | "line_index">): string {
  return task.number || `line-${task.line_index}`;
}
