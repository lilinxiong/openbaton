import crypto from "node:crypto";

export interface ConversationPromotion {
  schema_version: 1;
  source_hash: string;
  explicit: string[];
  inferred: string[];
  unresolved: string[];
  excluded: string[];
  ready_for_approval: boolean;
  requires_user_approval: true;
}

const EXPLICIT = /(?:按这个执行|转成\s*Goal|开始进入实施流程|开始执行|立即执行|implement this|execute this|promote to goal)/i;
const INFERRED = /(?:目标是|我希望|我需要|最终要|应该实现|需要完成|goal is|need to|want to)/i;
const EXCLUDED = /(?:不要|不允许|禁止|排除|不包含|do not|don't|must not|exclude)/i;
const UNRESOLVED = /(?:待确认|未确定|不确定|需要确认|\?|？|TBD|TODO)/i;

export function promoteConversation(text: string): ConversationPromotion {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
  const explicit = lines.filter((line) => EXPLICIT.test(line));
  const excluded = lines.filter((line) => EXCLUDED.test(line));
  const unresolved = lines.filter((line) => UNRESOLVED.test(line));
  const inferred = lines.filter((line) => !explicit.includes(line) && !excluded.includes(line) && INFERRED.test(line));
  return {
    schema_version: 1,
    source_hash: crypto.createHash("sha256").update(normalized).digest("hex"),
    explicit,
    inferred,
    unresolved,
    excluded,
    ready_for_approval: explicit.length > 0 && unresolved.length === 0,
    requires_user_approval: true,
  };
}
