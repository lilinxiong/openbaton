import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promoteConversation } from "../src/lib/conversation.js";

describe("Conversation-to-Goal promotion", () => {
  it("extracts explicit, inferred, unresolved, and excluded without activating a Goal", () => {
    const result = promoteConversation([
      "目标是实现动态多 subagent director。",
      "按这个执行。",
      "不要使用 provider-specific route。",
      "部署范围需要确认？",
    ].join("\n"));
    assert.equal(result.explicit.length, 1);
    assert.equal(result.inferred.length, 1);
    assert.equal(result.excluded.length, 1);
    assert.equal(result.unresolved.length, 1);
    assert.equal(result.ready_for_approval, false);
    assert.equal(result.requires_user_approval, true);
  });

  it("is ready for one approval only after explicit promotion with no unresolved item", () => {
    const result = promoteConversation("我需要完成 Receipt gate。\n开始进入实施流程。\n不要 push。");
    assert.equal(result.ready_for_approval, true);
    assert.equal(result.requires_user_approval, true);
    assert.match(result.source_hash, /^[a-f0-9]{64}$/);
  });

  it("does not promote ordinary discussion", () => {
    const result = promoteConversation("我们先讨论一下这个架构。\n看起来可能可行。");
    assert.equal(result.explicit.length, 0);
    assert.equal(result.ready_for_approval, false);
  });
});
