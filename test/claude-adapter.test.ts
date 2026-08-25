import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  CLAUDE_HOST_METADATA,
  claudeAdapter,
  normalizeClaudeModels,
  resolveClaudeCommand,
} from "../src/adapters/claude.js";
import { discoverClaudeModels } from "../src/adapters/claude.js";
import type { CodedError } from "../src/types.js";

/**
 * Sanitized capture of a real `list_models` control response from Claude Code
 * 2.1.241. No account identifiers, tokens, or paths are retained.
 */
const LIVE_LIST_MODELS = {
  models: [
    {
      value: "default",
      resolvedModel: "claude-opus-5[1m]",
      displayName: "Default (recommended)",
      description: "Use the default model (currently Opus 5 (1M context))",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAdaptiveThinking: true,
      supportsFastMode: true,
      supportsAutoMode: true,
    },
    {
      value: "opus[1m]",
      resolvedModel: "claude-opus-5[1m]",
      displayName: "Opus (1M context)",
      description: "Opus 5 with 1M context",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAdaptiveThinking: true,
      supportsFastMode: true,
      supportsAutoMode: true,
    },
    {
      value: "sonnet",
      resolvedModel: "claude-sonnet-5",
      displayName: "Sonnet",
      description: "Sonnet 5",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      value: "haiku",
      resolvedModel: "claude-haiku-4-5-20251001",
      displayName: "Haiku",
      description: "Haiku 4.5",
    },
  ],
};

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: EventEmitter;
  stdin: { write(chunk: string): void; end(): void };
  killed: boolean;
  kill(): void;
}

/** Discovery reads stdout through readline, so stdout must be a real stream. */
function baseChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

/**
 * Minimal stand-in for the Claude Code stream-json process. `respond` receives
 * the parsed control request and returns the lines to emit on stdout.
 */
function fakeClaude(respond: (request: Record<string, unknown>) => string[], version = "2.1.241 (Claude Code)") {
  return ((_: string, args: string[]) => {
    const child = baseChild();
    if (args[0] === "--version") {
      queueMicrotask(() => {
        child.stdout.write(`${version}\n`);
        child.emit("exit", 0);
      });
      return child;
    }
    child.stdin = {
      write(chunk: string) {
        const message = JSON.parse(chunk) as Record<string, unknown>;
        queueMicrotask(() => {
          for (const line of respond(message)) child.stdout.write(`${line}\n`);
        });
      },
      end() {},
    };
    return child;
  }) as typeof import("node:child_process").spawn;
}

function successLines(payload: unknown, requestId = "baton-list-models"): string[] {
  return [JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response: payload },
  })];
}

async function codeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return "NO_ERROR";
  } catch (error) {
    return (error as CodedError).code || "NO_CODE";
  }
}

describe("Claude Code adapter host metadata", () => {
  it("declares the verified skill path and concurrency facts", () => {
    assert.equal(claudeAdapter.id, "claude");
    assert.equal(CLAUDE_HOST_METADATA.id, "claude");
    assert.equal(CLAUDE_HOST_METADATA.skillPath, ".claude/skills/baton/SKILL.md");
    assert.equal(CLAUDE_HOST_METADATA.defaultMaxConcurrent, 20);
    assert.equal(CLAUDE_HOST_METADATA.maxConcurrentEnv, "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS");
    assert.equal(Object.hasOwn(claudeAdapter, "legacyOpsProfile"), false);
  });

  it("resolves the executable from PATH and honors an explicit override", () => {
    assert.equal(resolveClaudeCommand({ PATH: "" }), null);
    // A non-executable override must not silently fall back to PATH.
    assert.equal(resolveClaudeCommand({ BATON_CLAUDE_PATH: "/definitely/not/here/claude", PATH: "/usr/bin" }), null);
    assert.equal(resolveClaudeCommand({ BATON_CLAUDE_PATH: "/bin/sh" }), "/bin/sh");
  });
});

describe("Claude Code model normalization", () => {
  it("stores the canonical wire id from the live response shape", () => {
    const models = normalizeClaudeModels(LIVE_LIST_MODELS);
    assert.deepEqual(models.map((model) => model.id), [
      "claude-opus-5[1m]",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ]);
    const opus = models[0];
    assert.equal(opus.model, "claude-opus-5[1m]");
    assert.equal(opus.display_name, "Opus (1M context)");
    // The deferred `default` row contributes only the default marker.
    assert.equal(opus.is_default, true);
    assert.equal(models[1].is_default, false);
  });

  it("exposes only the effort metadata the host reports", () => {
    const models = normalizeClaudeModels(LIVE_LIST_MODELS);
    assert.deepEqual(models[1].reasoning_efforts.map((item) => item.id), ["low", "medium", "high", "xhigh", "max"]);
    // The host never reports a default effort, so none is invented.
    assert.equal(models[1].default_reasoning_effort, null);
    // Haiku omits supportsEffort, so no efforts are claimed for it.
    assert.deepEqual(models[2].reasoning_efforts, []);
    for (const model of models) {
      // The native child-agent call cannot express tiers or speed modes.
      assert.deepEqual(model.service_tiers, []);
      assert.deepEqual(model.additional_speed_tiers, []);
      assert.equal(model.default_service_tier, null);
      assert.equal(model.hidden, false);
    }
  });

  it("drops rows that are visible but not selectable, and dedupes by wire id", () => {
    const models = normalizeClaudeModels({
      models: [
        { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "first" },
        { value: "sonnet-alias", resolvedModel: "claude-sonnet-5", displayName: "Sonnet again", description: "second" },
        { value: "zdr-blocked", resolvedModel: "claude-blocked-1", displayName: "Blocked", description: "x", disabled: true },
        { value: "", resolvedModel: "", displayName: "junk", description: "" },
      ],
    });
    assert.deepEqual(models.map((model) => model.id), ["claude-sonnet-5"]);
    assert.equal(models[0].description, "second");
  });

  it("falls back to the row value when no resolvedModel is present", () => {
    const models = normalizeClaudeModels({
      models: [{ value: "claude-custom-1", displayName: "Custom", description: "" }],
    });
    assert.deepEqual(models.map((model) => model.id), ["claude-custom-1"]);
  });

  it("rejects a payload that is not a models array", () => {
    assert.throws(() => normalizeClaudeModels({ text: "Please run /login first" }), /models array/);
    assert.throws(() => normalizeClaudeModels("Current Claude models:"), /models array/);
  });
});

describe("Claude Code model discovery", () => {
  it("asks the host for its own catalog and reports the CLI version", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const catalog = await discoverClaudeModels({
      command: "/bin/claude",
      spawnImpl: fakeClaude((request) => {
        requests.push(request);
        return successLines(LIVE_LIST_MODELS);
      }),
    });
    assert.equal(catalog.cli, "claude");
    assert.equal(catalog.version, "2.1.241 (Claude Code)");
    assert.deepEqual(catalog.models.map((model) => model.id), [
      "claude-opus-5[1m]",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ]);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], {
      type: "control_request",
      request_id: "baton-list-models",
      request: { subtype: "list_models" },
    });
  });

  it("classifies a missing executable rather than guessing a path", async () => {
    assert.equal(
      await codeOf(discoverClaudeModels({ env: { PATH: "" }, spawnImpl: fakeClaude(() => []) })),
      "CLI_NOT_AVAILABLE",
    );
  });

  it("treats an empty successful catalog as a classified failure", async () => {
    assert.equal(
      await codeOf(discoverClaudeModels({
        command: "/bin/claude",
        spawnImpl: fakeClaude(() => successLines({ models: [] })),
      })),
      "CLAUDE_MODEL_DISCOVERY_FAILED",
    );
  });

  it("rejects login prose so friendly text cannot become model ids", async () => {
    assert.equal(
      await codeOf(discoverClaudeModels({
        command: "/bin/claude",
        spawnImpl: fakeClaude(() => successLines({ text: "Please run /login to authenticate." })),
      })),
      "CLAUDE_MODEL_DISCOVERY_FAILED",
    );
  });

  it("classifies a control-protocol error response", async () => {
    assert.equal(
      await codeOf(discoverClaudeModels({
        command: "/bin/claude",
        spawnImpl: fakeClaude(() => [JSON.stringify({
          type: "control_response",
          response: { subtype: "error", request_id: "baton-list-models", error: "not supported" },
        })]),
      })),
      "CLAUDE_MODEL_DISCOVERY_FAILED",
    );
  });

  it("ignores unrelated stream frames and responses for other request ids", async () => {
    const catalog = await discoverClaudeModels({
      command: "/bin/claude",
      spawnImpl: fakeClaude(() => [
        "not json at all",
        JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5" }),
        ...successLines(LIVE_LIST_MODELS, "someone-elses-request"),
        ...successLines(LIVE_LIST_MODELS),
      ]),
    });
    assert.deepEqual(catalog.models.map((model) => model.id), [
      "claude-opus-5[1m]",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ]);
  });

  it("classifies a timeout when the host never answers", async () => {
    assert.equal(
      await codeOf(discoverClaudeModels({
        command: "/bin/claude",
        timeoutMs: 20,
        spawnImpl: fakeClaude(() => []),
      })),
      "CLAUDE_MODEL_DISCOVERY_TIMEOUT",
    );
  });

  it("classifies an early exit with the host stderr detail", async () => {
    const spawnImpl = ((_: string, args: string[]) => {
      const child = baseChild();
      queueMicrotask(() => {
        if (args[0] !== "--version") child.stderr.emit("data", "authentication required");
        child.emit("exit", 1);
      });
      return child;
    }) as typeof import("node:child_process").spawn;
    try {
      await discoverClaudeModels({ command: "/bin/claude", spawnImpl });
      assert.fail("expected a classified discovery failure");
    } catch (error) {
      assert.equal((error as CodedError).code, "CLAUDE_MODEL_DISCOVERY_FAILED");
      assert.match((error as Error).message, /authentication required/);
    }
  });

  it("keeps the catalog usable when version detection fails", async () => {
    const spawnImpl = ((_: string, args: string[]) => {
      const child = baseChild();
      if (args[0] === "--version") {
        queueMicrotask(() => child.emit("error", new Error("version probe exploded")));
        return child;
      }
      child.stdin = {
        write() {
          queueMicrotask(() => {
            for (const line of successLines(LIVE_LIST_MODELS)) child.stdout.write(`${line}\n`);
          });
        },
        end() {},
      };
      return child;
    }) as typeof import("node:child_process").spawn;
    const catalog = await discoverClaudeModels({ command: "/bin/claude", spawnImpl });
    assert.equal(catalog.version, null);
    assert.equal(catalog.models.length, 3);
  });
});
