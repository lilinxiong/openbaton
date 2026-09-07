import { describe, it } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const script = path.join(repoRoot, "scripts", "measure_efficiency.mjs");

function writeSource(root: string, batched: boolean, omitAcceptance = false): void {
  const source = path.join(root, "src");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "cli.ts"), `
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function handoff(brief: any) {
  return {
    host: "alpha", model_id: "alpha-model", reasoning_effort: "high",
    prompt: ${omitAcceptance} ? brief.goal : [brief.goal, ...brief.acceptance, ...brief.constraints].join("\\n"),
    fork_context: false, spawned: false, scope: brief.scope, mode: brief.mode, work_mode: "execution",
  };
}
export async function run(argv: string[], options: any) {
  const manifest = JSON.parse(fs.readFileSync(path.join(process.env.BATON_ADAPTER_PATHS!, "adapter.json"), "utf8"));
  childProcess.execFileSync(path.join(process.env.BATON_ADAPTER_PATHS!, manifest.catalog.command), [], { env: process.env });
  const briefsIndex = argv.indexOf("--briefs");
  const briefIndex = argv.indexOf("--brief");
  if (${batched} && briefsIndex >= 0) {
    const briefs = JSON.parse(fs.readFileSync(argv[briefsIndex + 1], "utf8"));
    options.stdout.write(JSON.stringify({ handoffs: briefs.map(handoff) }));
    return 0;
  }
  if (!${batched} && briefIndex >= 0) {
    options.stdout.write(JSON.stringify(handoff(JSON.parse(fs.readFileSync(argv[briefIndex + 1], "utf8")))));
    return 0;
  }
  options.stderr.write("unsupported brief form");
  return 1;
}
`);
}

describe("efficiency measurement harness", () => {
  it("compares isolated repeated and batched source invocations without token estimates", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "baton-efficiency-test-"));
    try {
      const baseline = path.join(root, "baseline");
      const candidate = path.join(root, "candidate");
      writeSource(baseline, false);
      writeSource(candidate, true);
      const json = path.join(root, "report.json");
      const markdown = path.join(root, "report.md");
      const result = childProcess.spawnSync(process.execPath, [script,
        "--baseline", baseline, "--candidate", candidate,
        "--repeats", "1", "--warmups", "0", "--brief-budget-chars", "200",
        "--baseline-id", "fixture-baseline", "--candidate-id", "fixture-candidate",
        "--json", json, "--markdown", markdown,
      ], { encoding: "utf8", cwd: repoRoot, timeout: 30_000 });
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(fs.readFileSync(json, "utf8"));
      assert.equal(report.metadata.token_estimate, null);
      assert.equal(report.metadata.sources.baseline.identifier, "fixture-baseline");
      assert.equal(report.metadata.runtime_skill_code_points.baseline["SKILL.md"], null);
      assert.equal(report.scenarios.length, 2);
      const one = report.scenarios.find((row: any) => row.handoff_count === 1);
      const four = report.scenarios.find((row: any) => row.handoff_count === 4);
      assert.equal(one.baseline.catalog_invocation_count, 1);
      assert.equal(one.candidate.catalog_invocation_count, 1);
      assert.equal(four.baseline.manifest_read_count, 4);
      assert.equal(four.candidate.manifest_read_count, 1);
      assert.equal(four.baseline.catalog_invocation_count, 4);
      assert.equal(four.candidate.catalog_invocation_count, 1);
      assert.deepEqual(four.parity, { selection_and_acceptance: "passed", prompt_text_equality: "not_required" });
      assert.match(fs.readFileSync(markdown, "utf8"), /Character counts are Unicode code points/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a zero shared brief budget before it starts a source process", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "baton-efficiency-invalid-"));
    try {
      const result = childProcess.spawnSync(process.execPath, [script,
        "--baseline", root, "--candidate", root, "--brief-budget-chars", "0",
      ], { encoding: "utf8", cwd: repoRoot });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /brief-budget-chars must be a positive integer/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails behavioral comparison when a candidate drops required acceptance text", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "baton-efficiency-parity-"));
    try {
      const baseline = path.join(root, "baseline");
      const candidate = path.join(root, "candidate");
      writeSource(baseline, false);
      writeSource(candidate, true, true);
      const result = childProcess.spawnSync(process.execPath, [script,
        "--baseline", baseline, "--candidate", candidate, "--repeats", "1", "--warmups", "0",
      ], { encoding: "utf8", cwd: repoRoot, timeout: 30_000 });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /PROMPT_ACCEPTANCE_FAILED/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
