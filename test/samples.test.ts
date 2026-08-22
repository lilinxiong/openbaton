import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { inferWorkUnitKind } from "../src/lib/work-unit.js";
import { openspecCliAvailable, parseTasks } from "../src/lib/openspec.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const samples = path.join(root, "samples");
const standalone = path.join(samples, "standalone");
const withOpenSpec = path.join(samples, "openspec");

describe("built-in Baton capability samples", () => {
  it("embeds two complete paths with trigger-neutral requests", () => {
    assert.ok(!fs.existsSync(path.join(standalone, "openspec")));
    assert.ok(fs.existsSync(path.join(withOpenSpec, "openspec", "changes", "incident-audit", "tasks.md")));
    for (const dir of [standalone, withOpenSpec]) {
      for (const name of ["README.md", "REQUEST.txt", "incidents.json", "policy.json"]) {
        assert.ok(fs.existsSync(path.join(dir, name)), `${path.basename(dir)}/${name}`);
      }
      const request = fs.readFileSync(path.join(dir, "REQUEST.txt"), "utf8");
      assert.doesNotMatch(request, /baton|subagent|dispatch|openspec|route|model|provider/i);
    }
  });

  it("uses identical business inputs and has a stable answer oracle", () => {
    const standaloneData = readJson(path.join(standalone, "incidents.json"));
    const openspecData = readJson(path.join(withOpenSpec, "incidents.json"));
    const policy = readJson(path.join(standalone, "policy.json"));
    assert.deepEqual(openspecData, standaloneData);
    assert.deepEqual(readJson(path.join(withOpenSpec, "policy.json")), policy);

    const incidents = standaloneData.incidents;
    assert.equal(incidents.length, 6);
    assert.deepEqual(countBy(incidents, "severity"), { sev1: 2, sev2: 2, sev3: 2 });
    assert.deepEqual(countBy(incidents, "status"), { resolved: 3, open: 3 });

    const cutoff = Date.parse(standaloneData.cutoff_at);
    const ackBreaches: string[] = [];
    const resolutionBreaches: string[] = [];
    for (const incident of incidents) {
      const target = policy.severity_sla_minutes[incident.severity];
      const opened = Date.parse(incident.opened_at);
      const ackEnd = incident.acknowledged_at ? Date.parse(incident.acknowledged_at) : cutoff;
      const resolutionEnd = incident.resolved_at ? Date.parse(incident.resolved_at) : cutoff;
      if (minutes(opened, ackEnd) > target.acknowledge) ackBreaches.push(incident.id);
      if (minutes(opened, resolutionEnd) > target.resolve) resolutionBreaches.push(incident.id);
    }
    assert.deepEqual(ackBreaches, ["INC-103", "INC-105", "INC-106"]);
    assert.deepEqual(resolutionBreaches, ["INC-101", "INC-103"]);

    const duplicates = new Map<string, string[]>();
    for (const incident of incidents) {
      const key = `${incident.service}/${incident.owner}`;
      duplicates.set(key, [...(duplicates.get(key) || []), incident.id]);
    }
    assert.deepEqual(Object.fromEntries(duplicates), {
      "payments/team-alpha": ["INC-101", "INC-103"],
      "auth/team-beta": ["INC-102", "INC-105"],
      "search/team-gamma": ["INC-104", "INC-106"],
    });
    assert.deepEqual(validateRecords(incidents, policy), []);
  });

  it("defines four concrete tasks and one checkpointed deliberative task", () => {
    const tasksText = fs.readFileSync(path.join(withOpenSpec, "openspec", "changes", "incident-audit", "tasks.md"), "utf8");
    const tasks = parseTasks(tasksText);
    assert.deepEqual(tasks.map((task) => task.number), ["1.1", "1.2", "1.3", "1.4", "2.1"]);
    assert.deepEqual(tasks.map((task) => inferWorkUnitKind(task.description)), [
      "concrete", "concrete", "concrete", "concrete", "deliberative",
    ]);
  });

  it("verifies CLI-owned candidates and recommendation-only approval without a selector", () => {
    const verifier = fs.readFileSync(path.join(samples, "verify.mjs"), "utf8");
    const bundleVerifier = fs.readFileSync(path.join(samples, "verify-bundle.mjs"), "utf8");
    const verifierSuite = `${verifier}\n${bundleVerifier}`;
    for (const marker of [
      "pending_confirmation",
      "source_shape",
      "confirmed_by",
      "changed_by_user",
      "recommended_model_id",
      "automatic_eligible",
      "requires_manual_choice",
      "baton-recommendation",
      "configured-cli-subagent-allowlist-v1",
      "cli-models.json",
      'snapshot.source === "cli"',
      'snapshot.cli === "codex"',
      "reasoning_efforts",
      "service_tier",
    ]) assert.match(verifierSuite, new RegExp(marker));
    const expected = fs.readFileSync(path.join(samples, "EXPECTED.md"), "utf8");
    assert.match(expected, /one proposal containing all of its units/i);
    assert.match(expected, /no selector or user confirmation/i);
    assert.match(expected, /Mini and Spark remain eligible/i);
    const instructions = fs.readFileSync(path.join(samples, "README.md"), "utf8");
    assert.match(instructions, /no runtime model picker or confirmation step/i);
    assert.match(instructions, /comes directly from Codex `model\/list`/i);
    assert.match(instructions, /runner.*longctx.*labels only/is);
    assert.doesNotMatch(instructions, /selection render|one Submit|manual selector/i);
  });

  it("strict-validates the embedded OpenSpec change when OpenSpec is available", { skip: !openspecCliAvailable() }, () => {
    const result = spawnSync("openspec", ["validate", "incident-audit", "--strict", "--no-interactive"], {
      cwd: withOpenSpec,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
});

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function countBy(items: Array<Record<string, string>>, key: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item[key]] = (counts[item[key]] || 0) + 1;
  return counts;
}

function minutes(start: number, end: number): number {
  return (end - start) / 60_000;
}

function validateRecords(incidents: Array<Record<string, unknown>>, policy: Record<string, any>): string[] {
  const errors: string[] = [];
  const severities = new Set(Object.keys(policy.severity_sla_minutes));
  const statuses = new Set(policy.allowed_statuses);
  for (const incident of incidents) {
    const id = String(incident.id || "unknown");
    for (const field of policy.required_fields) if (!(field in incident)) errors.push(`${id}:missing:${field}`);
    if (!severities.has(String(incident.severity))) errors.push(`${id}:severity`);
    if (!statuses.has(String(incident.status))) errors.push(`${id}:status`);
    const opened = Date.parse(String(incident.opened_at));
    for (const field of ["acknowledged_at", "resolved_at"]) {
      const value = incident[field];
      if (value != null && Date.parse(String(value)) < opened) errors.push(`${id}:ordering:${field}`);
    }
    if (incident.status === "resolved" && incident.resolved_at == null) errors.push(`${id}:resolved-without-time`);
    if (incident.status === "open" && incident.resolved_at != null) errors.push(`${id}:open-with-resolution`);
  }
  return errors;
}
