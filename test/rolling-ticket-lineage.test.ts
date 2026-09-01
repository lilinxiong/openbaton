import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSpawnTicket,
  listSpawns,
  normalizeSpawnTicket,
  readSpawn,
  validateSpawnTicketLineage,
  writeSpawn,
} from "../src/lib/spawn.js";
import { spawnsDir } from "../src/lib/paths.js";
import { compileRollingWorkUnit } from "../src/lib/work-unit.js";
import { fakeEnv, withHome } from "./home.js";

const fingerprint = "a".repeat(64);
const patchLineage = {
  schema_version: 1 as const,
  run_id: "rolling-run",
  unit_key: "unit-ticket",
  unit_version: 4,
  unit_fingerprint: fingerprint,
  task_keys: ["task-a", "task-b"],
  mode: "patch-only" as const,
};
const verificationLineage = { ...patchLineage, mode: "verification-only" as const };

function ticket(cwd: string, env: NodeJS.ProcessEnv, lineage = patchLineage) {
  return buildSpawnTicket({
    cwd,
    env,
    description: "carry rolling ticket lineage",
    prompt: "carry rolling ticket lineage",
    modelId: "alpha/default",
    routeId: "alpha/default",
    taskKind: "concrete",
    rollingUnitLineage: lineage,
    deliverable: "the rolling ticket",
    doneWhen: "the rolling ticket is persisted",
    readContext: ["src/lib/spawn.ts"],
    writePaths: lineage.mode === "patch-only" ? ["src/lib/spawn.ts"] : [],
    allowedOperations: lineage.mode === "patch-only" ? ["write"] : [],
    completionCriteria: ["lineage is preserved"],
    permittedValidation: ["npm run check"],
  });
}

describe("rolling spawn-ticket lineage", () => {
  it("constructs schema-3 tickets and preserves the exact lineage in the prompt", () => withHome((home) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-ticket-"));
    const env = fakeEnv(home, { BATON_SESSION_ID: "rolling-ticket-construction" });
    try {
      const built = ticket(cwd, env);
      assert.equal(built.work_unit.schema_version, 3);
      assert.deepEqual(built.rolling_unit_lineage, patchLineage);
      assert.deepEqual((built.work_unit as any).rolling_unit_lineage, patchLineage);
      assert.ok(built.prompt.includes(`rolling_unit_lineage: ${JSON.stringify(patchLineage)}`));
      assert.equal(validateSpawnTicketLineage(built), null);
      assert.equal(Object.isFrozen(built.rolling_unit_lineage), true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }));

  it("compiles and validates an explicit rolling work unit", () => withHome((home) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-ticket-unit-"));
    const env = fakeEnv(home, { BATON_SESSION_ID: "rolling-ticket-unit" });
    try {
      const unit = compileRollingWorkUnit({
        schema_version: 3,
        kind: "concrete",
        objective: "verify the rolling unit",
        deliverable: "verification evidence",
        done_when: "the evidence is reported",
        mode: "verification-only",
        rolling_unit_lineage: verificationLineage,
        read_context: ["src/lib/spawn.ts"],
        write_paths: [],
        allowed_operations: [],
        completion_criteria: ["the check passes"],
        permitted_validation: ["npm run check"],
        coordination: "terminal-only",
      });
      const built = buildSpawnTicket({
        cwd,
        env,
        description: "verify the rolling unit",
        prompt: "verify the rolling unit",
        modelId: "alpha/default",
        taskKind: "concrete",
        rollingWorkUnit: unit,
      });
      assert.deepEqual(built.work_unit, unit);
      assert.deepEqual(built.rolling_unit_lineage, verificationLineage);
      assert.equal(built.mode, "read-only");
      assert.equal(built.read_only, true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }));

  it("fails closed on missing, mismatched, or mutually exclusive lineage", () => withHome((home) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-ticket-invalid-"));
    const env = fakeEnv(home, { BATON_SESSION_ID: "rolling-ticket-invalid" });
    try {
      const built = ticket(cwd, env);
      assert.throws(() => normalizeSpawnTicket({ ...built, rolling_unit_lineage: { ...patchLineage, unit_version: 5 } }), /lineage mismatch|not normalized/);
      assert.throws(() => normalizeSpawnTicket({ ...built, rolling_unit_lineage: undefined }), /requires rolling unit lineage/);
      assert.throws(() => normalizeSpawnTicket({ ...built, work_unit: { ...built.work_unit, rolling_unit_lineage: { ...patchLineage, unit_version: 5 } } }), /lineage mismatch/);
      assert.throws(() => normalizeSpawnTicket({ ...built, work_unit: { ...built.work_unit, schema_version: 1 }, rolling_unit_lineage: patchLineage }), /requires a rolling work unit/);
      assert.throws(() => buildSpawnTicket({
        cwd, env, description: "mixed", prompt: "mixed", modelId: "alpha/default", taskKind: "concrete",
        rollingUnitLineage: patchLineage,
        compiledApplyLineage: { run_id: "r", plan_revision: "1", plan_fingerprint: "p", unit_id: "u", task_refs: ["t"], mode: "patch-only" },
      }), /mutually exclusive/);
      assert.throws(() => buildSpawnTicket({
        cwd, env, description: "mixed", prompt: "mixed", modelId: "alpha/default", taskKind: "concrete",
        rollingUnitLineage: patchLineage,
        runId: "compiled-input",
      }), /mutually exclusive/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }));

  it("round-trips read/write normalization and keeps legacy tickets accepted", () => withHome((home) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-ticket-roundtrip-"));
    const env = fakeEnv(home, { BATON_SESSION_ID: "rolling-ticket-roundtrip" });
    try {
      const built = ticket(cwd, env);
      writeSpawn(cwd, built, env);
      assert.deepEqual(readSpawn(cwd, built.id, env).rolling_unit_lineage, patchLineage);
      assert.equal(listSpawns(cwd, env).length, 1);
      const manual = buildSpawnTicket({ cwd, env, description: "legacy manual", prompt: "legacy manual", modelId: "alpha/default", taskKind: "concrete" });
      assert.equal(manual.rolling_unit_lineage, undefined);
      assert.equal(validateSpawnTicketLineage(manual), null);
      const compiled = buildSpawnTicket({
        cwd, env, description: "legacy compiled", prompt: "legacy compiled", modelId: "alpha/default", taskKind: "concrete",
        compiledApplyLineage: { run_id: "r", plan_revision: "1", plan_fingerprint: "p", unit_id: "u", task_refs: ["t"], mode: "verification-only" },
      });
      assert.equal(compiled.work_unit.schema_version, 2);
      assert.equal(compiled.rolling_unit_lineage, undefined);
      assert.equal(validateSpawnTicketLineage(compiled), null);
      const file = path.join(spawnsDir(cwd, env), `${built.id}.json`);
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      raw.rolling_unit_lineage.unit_version = 99;
      fs.writeFileSync(file, JSON.stringify(raw));
      assert.throws(() => readSpawn(cwd, built.id, env), (error: any) => error.code === "TICKET_FORMAT_UNSUPPORTED");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }));

  it("rejects tampered persisted schema-3 work-unit and execution-mode contracts", () => withHome((home) => {
    const cases = [
      {
        name: "unknown schema-3 work-unit field",
        mutate: (raw: any) => { raw.work_unit.unexpected = true; },
      },
      {
        name: "malformed patch scope",
        mutate: (raw: any) => { raw.work_unit.write_paths = []; },
      },
      {
        name: "malformed work-unit mode",
        mutate: (raw: any) => { raw.work_unit.mode = "unsupported"; },
      },
      {
        name: "ticket mode and read_only mismatch",
        mutate: (raw: any) => { raw.mode = "write"; raw.read_only = true; },
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `baton-rolling-ticket-tamper-${index}-`));
      const env = fakeEnv(home, { BATON_SESSION_ID: `rolling-ticket-tamper-${index}` });
      try {
        const built = ticket(cwd, env);
        writeSpawn(cwd, built, env);
        const file = path.join(spawnsDir(cwd, env), `${built.id}.json`);
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        testCase.mutate(raw);
        fs.writeFileSync(file, JSON.stringify(raw));
        assert.throws(() => readSpawn(cwd, built.id, env), (error: any) => error.code === "TICKET_FORMAT_UNSUPPORTED");
        assert.deepEqual(listSpawns(cwd, env), [], testCase.name);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    }
  }));
});
