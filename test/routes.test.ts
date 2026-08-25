import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runRoutes } from "../src/commands/routes.js";
import { emptyConfig, saveConfig } from "../src/lib/config.js";
import {
  buildRouteCandidates,
  normalizeRouteCatalog,
  publishRouteSnapshot,
  readRouteSnapshot,
  routeSnapshotSchemaVersion,
} from "../src/lib/routes.js";
import { routeSnapshotPath } from "../src/lib/paths.js";
import { withHome, fakeEnv } from "./home.js";

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "baton-routes-"));
}

function sink() {
  const chunks: string[] = [];
  return { write(value: unknown) { chunks.push(String(value)); }, text() { return chunks.join(""); } };
}

const MODELS = [
  {
    id: "gpt-5.4-mini",
    display_name: "5.4 Mini",
    description: "Small, fast and cost-efficient coding model",
    reasoning_efforts: [{ id: "low" }, { id: "high" }],
    default_reasoning_effort: "low",
    additional_speed_tiers: ["fast"],
    service_tiers: [],
  },
  {
    id: "gpt-5.3-codex-spark",
    display_name: "5.3 Codex Spark",
    description: "Ultra-fast coding model",
    reasoning_efforts: [{ id: "medium" }],
    default_reasoning_effort: "medium",
  },
];

describe("CLI model catalog snapshot", () => {
  it("publishes schema 5 with CLI provenance and stable generations", () => withHome(() => {
    const cwd = workspace();
    const first = publishRouteSnapshot(cwd, { models: MODELS }, new Date("2026-08-22T00:00:00Z"), {
      cli: "codex",
      engineVersion: "codex-cli 0.148.0",
    });
    assert.equal(first.changed, true);
    assert.equal(first.snapshot.schema_version, 5);
    assert.equal(first.snapshot.source, "cli");
    assert.equal(first.snapshot.cli, "codex");
    assert.equal(first.snapshot.generation, 1);
    assert.equal(first.snapshot.routes.length, 2);

    const same = publishRouteSnapshot(cwd, { models: [...MODELS].reverse() }, new Date("2026-08-23T00:00:00Z"), {
      cli: "codex",
      engineVersion: "codex-cli 0.148.0",
    });
    assert.equal(same.changed, false);
    assert.equal(same.snapshot.generation, 1);

    const changed = publishRouteSnapshot(cwd, { models: MODELS.slice(0, 1) }, new Date(), {
      cli: "codex",
      engineVersion: "codex-cli 0.148.0",
    });
    assert.equal(changed.snapshot.generation, 2);
    assert.equal(routeSnapshotSchemaVersion(cwd), 5);
    assert.ok(routeSnapshotPath(cwd).endsWith(path.join("cache", "cli-models.json")));
    assert.ok(!fs.existsSync(path.join(cwd, ".baton")));
  }));

  it("preserves Codex descriptions, efforts, defaults and speed metadata", () => {
    const routes = normalizeRouteCatalog({ models: MODELS });
    const mini = routes.find((route) => route.route_id === "gpt-5.4-mini")!;
    const spark = routes.find((route) => route.route_id === "gpt-5.3-codex-spark")!;
    assert.equal(mini.display_name, "5.4 Mini");
    assert.deepEqual(mini.reasoning_efforts, ["high", "low"]);
    assert.equal(mini.default_reasoning_effort, "low");
    assert.deepEqual(mini.additional_speed_tiers, ["fast"]);
    assert.equal(mini.supports_service_tier, true);
    assert.equal(spark.supports_service_tier, true, "the CLI description is valid speed metadata");
  });

  it("refreshes only through the active CLI adapter", async () => {
    await withHome(async (home) => {
      const cwd = workspace();
      const env = fakeEnv(home);
      saveConfig(cwd, emptyConfig(), { env });
      const calls: string[] = [];
      const stdout = sink();
      const code = await runRoutes(["refresh", "--host", "codex"], {
        cwd,
        env,
        stdout,
        discover: async (cli) => {
          calls.push(cli);
          return { cli: "codex", version: "codex-cli test", models: MODELS.map((model) => ({
            id: model.id,
            model: model.id,
            display_name: model.display_name,
            description: model.description,
            hidden: false,
            reasoning_efforts: (model.reasoning_efforts || []).map((effort) => ({ id: effort.id, description: "" })),
            default_reasoning_effort: model.default_reasoning_effort || null,
            input_modalities: [],
            additional_speed_tiers: model.additional_speed_tiers || [],
            service_tiers: [],
            default_service_tier: null,
            is_default: false,
          })) };
        },
      });
      assert.equal(code, 0);
      assert.deepEqual(calls, ["codex"]);
      const output = JSON.parse(stdout.text());
      assert.equal(output.snapshot.cli, "codex");
      assert.deepEqual(output.snapshot.routes.map((route: { route_id: string }) => route.route_id), [
        "gpt-5.3-codex-spark",
        "gpt-5.4-mini",
      ]);
    });
  });

  it("creates every CLI-supported effort card even without benchmark data", () => withHome(() => {
    const cwd = workspace();
    publishRouteSnapshot(cwd, { models: MODELS }, new Date(), { cli: "codex" });
    const cards = buildRouteCandidates(cwd, path.join(cwd, "missing.sqlite3")).map((item) => item.card);
    assert.ok(cards.some((card) => card.id === "gpt-5.4-mini"));
    assert.ok(cards.some((card) => card.id === "gpt-5.4-mini@low"));
    assert.ok(cards.some((card) => card.id === "gpt-5.4-mini@high"));
    assert.ok(cards.some((card) => card.id === "gpt-5.3-codex-spark@medium"));
    assert.ok(cards.every((card) => card.executable));
  }));

  it("rejects malformed and legacy snapshots", () => withHome(() => {
    assert.throws(() => normalizeRouteCatalog({ nope: true }), /model catalog/);
    const cwd = workspace();
    const file = routeSnapshotPath(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema_version: 4, routes: [], provider_quotas: [] }));
    assert.equal(readRouteSnapshot(cwd), null);
  }));
});
