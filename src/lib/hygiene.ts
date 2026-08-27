/**
 * Director context hygiene: the parent only receives short conclusions.
 * Tool dumps, traces, and worker transcripts stay in the child.
 */

export const MAX_CONCLUSION_CHARS = 800;
export const MAX_PROGRESS_CHARS = 400;

const TOOL_DUMP_MARKERS = [
  /tool[_ ]?(call|result|output)/i,
  /function_call/i,
  /<\/?(tool|function|invoke)/i,
  /\{"role":\s*"(tool|function)"/i,
  /```tool/,
];

export function looksLikeToolDump(text: unknown): boolean {
  const s = String(text || "");
  if (s.length > 4000) return true;
  return TOOL_DUMP_MARKERS.some((re) => re.test(s));
}

export type ConclusionResult = { ok: true; conclusion: string } | { ok: false; error: string };

export function sanitizeConclusion(text: unknown): ConclusionResult {
  let s = String(text || "").trim();
  if (!s) {
    return { ok: false, error: "empty conclusion" };
  }
  if (looksLikeToolDump(s)) {
    return {
      ok: false,
      error: "refusing to put a tool dump in the director context. Summarize the outcome in a few sentences.",
    };
  }
  if (s.length > MAX_CONCLUSION_CHARS) {
    s = s.slice(0, MAX_CONCLUSION_CHARS - 1).trimEnd() + "…";
  }
  return { ok: true, conclusion: s };
}

export function sanitizeProgress(text: unknown): ConclusionResult {
  const cleaned = sanitizeConclusion(text);
  if (!cleaned.ok) return cleaned;
  if (cleaned.conclusion.length <= MAX_PROGRESS_CHARS) return cleaned;
  return {
    ok: true,
    conclusion: cleaned.conclusion.slice(0, MAX_PROGRESS_CHARS - 1).trimEnd() + "…",
  };
}
