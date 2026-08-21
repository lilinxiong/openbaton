import type { OpsAction } from "./ops-config.js";

const CODING_OR_DESIGN = /\b(implement|implementation|fix|bug|refactor|migrate|rewrite|debug|design|architecture|plan|scheme|why|investigate|explore)\b|(?:实现|修复|补测试|写测试|改配置|方案|设计|架构|为什么|排查|探索)/i;
const TEST = /(?:^|\b)((?:bun|npm|pnpm|yarn|cargo|go|make)\s+test|bun test|pytest|run (?:the )?(?:unit |all )?tests?|跑(?:一下)?测试|运行测试|跑单测|跑单元测试)(?:\b|$)/i;
const BUILD = /(?:^|[\s[(])(?:[$/])?build-(?:app|bazel|cmake)\b|(?:^|\b)((?:bun|npm|pnpm|yarn)\s+run\s+build|make(?:\s+all)?|构建(?:项目|一下)?|编译)(?:\b|$)/i;
const LINT = /(?:^|\b)(lint|eslint|prettier\s+--check|跑(?:一下)?lint)(?:\b|$)/i;
const TYPECHECK = /(?:^|\b)(typecheck|tsc(?:\s+--noEmit)?|bun\s+run\s+check|类型检查)(?:\b|$)/i;
const SEARCH = /(?:^|\b)(rg\b|ripgrep|\bgrep\b|仓库检索|检索|find references|搜(?:索)?)/i;
const DIGEST = /(?:消化|(?:summarize|digest).*(?:log|output|coverage|artifact)|看(?:一下)?(?:这份)?(?:日志|产物|coverage))/i;
const GIT_SUMMARIZE = /(?:^|\b)(git\s+(?:status|log|diff)|git\s*摘要|暂存区摘要|commit message|写(?:一个)?\s*commit(?: message)?|提交说明|根据\s*staged.*(?:message|说明)|已暂存.*(?:message|说明))/i;
const GIT_COMMIT = /(?:^|\b)git\s+commit(?:\s|$)|\bcommit\s+(?:the\s+)?staged(?:\s+changes?)?\b|(?:^|[，,。.!！?？\s])(?:请)?提交(?:吧|已暂存(?:的)?(?:改动|修改|文件)?|这些改动)(?:$|[，,。.!！?？\s])|把已暂存.*提交/i;
const NO_COMMIT = /(?:不要|不允许|禁止)提交|(?:do not|don't|never)\s+commit/i;

const MAX_OPS_CHARS = 160;

function firstIndex(text: string, pattern: RegExp): number {
  const match = pattern.exec(text);
  return match ? match.index : -1;
}

/**
 * Fail-closed: mixed coding/design, long/ambiguous text, or multiple ops
 * actions stay off the mechanical path.
 */
export function inferOpsAction(description: unknown): OpsAction | null {
  const text = String(description || "").trim();
  if (!text || text.length > MAX_OPS_CHARS) return null;
  if (CODING_OR_DESIGN.test(text)) return null;
  if (NO_COMMIT.test(text)) return null;
  const hits = ([
    ["test", TEST],
    ["build", BUILD],
    ["lint", LINT],
    ["typecheck", TYPECHECK],
    ["search", SEARCH],
    ["digest", DIGEST],
    ["git-summarize", GIT_SUMMARIZE],
    ["git-commit", GIT_COMMIT],
  ] as const).map(([action, pattern]) => ({ action, index: firstIndex(text, pattern) }))
    .filter((item) => item.index >= 0);
  if (hits.length !== 1) return null;
  return hits[0].action;
}
