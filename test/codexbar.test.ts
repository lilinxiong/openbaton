import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  codexBarProviderId,
  normalizeCodexBarQuota,
  queryCodexBarQuota,
  resolveCodexBar,
} from "../src/lib/codexbar.js";
import { mergeProviderQuotaFallbacks, unknownProviderQuota } from "../src/lib/host-capabilities.js";

describe("CodexBar quota fallback", () => {
  it("maps OpenCodex provider ids and discovers a callable CLI on PATH", () => {
    assert.equal(codexBarProviderId("openai"), "codex");
    assert.equal(codexBarProviderId("alibaba-token-plan"), "alibaba-token-plan");
    assert.equal(codexBarProviderId("bad/provider"), null);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baton-codexbar-bin-"));
    const cli = path.join(dir, "codexbar");
    fs.writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    assert.equal(resolveCodexBar({ env: { PATH: dir, HOME: dir } }), cli);
  });

  it("normalizes usage windows without retaining account or authentication fields", () => {
    const quota = normalizeCodexBarQuota("openai", "codex", [{
      provider: "codex",
      source: "oauth",
      accountEmail: "private@example.invalid",
      usage: {
        updatedAt: "2026-08-20T01:02:03Z",
        accountEmail: "private@example.invalid",
        loginMethod: "secret-login",
        identity: { accountID: "secret-account", accountEmail: "private@example.invalid" },
        secondary: { usedPercent: 90, windowMinutes: 10_080, resetsAt: "2026-08-24T00:00:00Z" },
        extraRateWindows: [{ title: "5 hour", id: "private-window-id", window: { usedPercent: 5, windowMinutes: 300, resetsAt: "2026-08-20T05:00:00Z" } }],
      },
    }], "2026-08-20T00:00:00Z");
    assert.equal(quota.provider, "openai");
    assert.equal(quota.status, "reported");
    assert.equal(quota.source, "codexbar:codex:oauth");
    assert.equal(quota.observed_at, "2026-08-20T01:02:03.000Z");
    assert.deepEqual(quota.windows.map((item) => [item.name, item.remaining_percent, item.resets_at]), [
      ["secondary", 10, "2026-08-24T00:00:00.000Z"],
      ["extra_1", 95, "2026-08-20T05:00:00.000Z"],
    ]);
    const persisted = JSON.stringify(quota);
    for (const secret of ["private@example.invalid", "secret-login", "secret-account", "private-window-id"]) {
      assert.doesNotMatch(persisted, new RegExp(secret));
    }
  });

  it("fails soft for provider errors, ambiguous accounts, invalid JSON, and query failure", () => {
    const providerError = normalizeCodexBarQuota("alibaba-token-plan", "alibaba-token-plan", [{
      provider: "alibabatokenplan", source: "auto", error: { message: "contains private browser details" },
    }], "2026-08-20T00:00:00Z");
    assert.equal(providerError.status, "unknown");
    assert.equal(providerError.reason, "CODEXBAR_PROVIDER_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(providerError), /private browser details/);

    const multiple = normalizeCodexBarQuota("openai", "codex", [
      { usage: { primary: { usedPercent: 1 } } },
      { usage: { primary: { usedPercent: 2 } } },
    ], "2026-08-20T00:00:00Z");
    assert.equal(multiple.reason, "CODEXBAR_MULTIPLE_ACCOUNTS");

    const invalid = queryCodexBarQuota("openai", {
      cwd: os.tmpdir(), command: "codexbar", now: "2026-08-20T00:00:00Z",
      runner: () => ({ status: 0, stdout: "not-json", stderr: "", error: null }),
    });
    assert.equal(invalid?.reason, "CODEXBAR_INVALID_JSON");

    const failed = queryCodexBarQuota("openai", {
      cwd: os.tmpdir(), command: "codexbar", now: "2026-08-20T00:00:00Z",
      runner: () => ({ status: 1, stdout: "", stderr: "private failure", error: new Error("timeout") }),
    });
    assert.equal(failed?.reason, "CODEXBAR_QUERY_FAILED");
    assert.doesNotMatch(JSON.stringify(failed), /private failure|timeout/);
  });

  it("invokes the machine-readable provider-specific command with a bounded timeout", () => {
    let input = null;
    const quota = queryCodexBarQuota("cursor", {
      cwd: "/tmp", command: "/Applications/CodexBarCLI", now: "2026-08-20T00:00:00Z",
      runner: (value) => {
        input = value;
        return { status: 0, stdout: JSON.stringify([{ provider: "cursor", source: "web", usage: { primary: { usedPercent: 25 } } }]), stderr: "", error: null };
      },
    });
    assert.equal(quota?.windows[0].remaining_percent, 75);
    assert.deepEqual(input.args, [
      "usage", "--provider", "cursor", "--format", "json", "--json-only", "--no-color", "--web-timeout", "10",
    ]);
    assert.equal(input.timeoutMs, 15_000);
  });

  it("never overwrites reported OpenCodex quota but replaces an absent or unknown provider", () => {
    const openCodex = normalizeCodexBarQuota("openai", "codex", [{
      source: "web", usage: { primary: { usedPercent: 20 } },
    }], "2026-08-20T00:00:00Z");
    openCodex.source = "chatgpt:wham";
    const codexBarOpenAI = normalizeCodexBarQuota("openai", "codex", [{
      source: "web", usage: { primary: { usedPercent: 80 } },
    }], "2026-08-20T00:00:00Z");
    const codexBarAlibaba = normalizeCodexBarQuota("alibaba-token-plan", "alibaba-token-plan", [{
      source: "web", usage: { primary: { usedPercent: 25 } },
    }], "2026-08-20T00:00:00Z");
    const merged = mergeProviderQuotaFallbacks([
      openCodex,
      unknownProviderQuota("alibaba-token-plan", "2026-08-20T00:00:00Z"),
    ], [codexBarOpenAI, codexBarAlibaba]);
    assert.equal(merged.find((item) => item.provider === "openai")?.source, "chatgpt:wham");
    assert.equal(merged.find((item) => item.provider === "openai")?.windows[0].remaining_percent, 80);
    assert.equal(merged.find((item) => item.provider === "alibaba-token-plan")?.source, "codexbar:alibaba-token-plan:web");
  });
});
