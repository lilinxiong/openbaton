#!/usr/bin/env bun
/**
 * Offline, reproducible comparison of repeated `spawn --brief` calls with a
 * batched `spawn --briefs` call. This intentionally measures only observable
 * characters and local process work; it never estimates tokens or starts a
 * native worker.
 */
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_REPEATS = 5;
const DEFAULT_WARMUPS = 1;
const DEFAULT_BRIEF_BUDGET = 1_200;

function fail(message) { throw new Error(`EFFICIENCY_MEASUREMENT_INVALID: ${message}`); }

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) fail(`unknown argument ${name}`);
    if (["--help", "--h"].includes(name)) return { help: true };
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${name} requires a value`);
    if (![
      "--baseline", "--candidate", "--repeats", "--warmups", "--brief-budget-chars",
      "--json", "--markdown", "--baseline-id", "--candidate-id", "--bun",
    ].includes(name)) fail(`unknown option ${name}`);
    if (values.has(name)) fail(`${name} may be supplied once`);
    values.set(name, value);
    index += 1;
  }
  const integer = (name, fallback) => {
    const value = values.get(name);
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || (name === "--repeats" && parsed < 1)) fail(`${name} must be a positive integer`);
    return parsed;
  };
  const requiredPath = (name) => {
    const value = values.get(name);
    if (!value) fail(`${name} is required`);
    const resolved = path.resolve(value);
    if (!fs.existsSync(resolved)) fail(`${name} does not exist: ${resolved}`);
    return resolved;
  };
  const briefBudgetChars = integer("--brief-budget-chars", DEFAULT_BRIEF_BUDGET);
  if (briefBudgetChars < 1) fail("--brief-budget-chars must be a positive integer");
  return {
    baseline: requiredPath("--baseline"),
    candidate: requiredPath("--candidate"),
    repeats: integer("--repeats", DEFAULT_REPEATS),
    warmups: integer("--warmups", DEFAULT_WARMUPS),
    briefBudgetChars,
    json: values.get("--json") ? path.resolve(values.get("--json")) : null,
    markdown: values.get("--markdown") ? path.resolve(values.get("--markdown")) : null,
    baselineId: values.get("--baseline-id") || null,
    candidateId: values.get("--candidate-id") || null,
    bun: values.get("--bun") || process.env.BUN_EXE || process.execPath,
  };
}

function help() {
  return `Usage: bun scripts/measure_efficiency.mjs --baseline PATH --candidate PATH [options]

Compares 1 and 4 handoffs with fixture adapters in temporary HOME directories.
The baseline receives repeated --brief calls; the candidate receives --briefs.

Options:
  --repeats N                 Timed repetitions (default: ${DEFAULT_REPEATS})
  --warmups N                 Untimed repetitions (default: ${DEFAULT_WARMUPS})
  --brief-budget-chars N      Candidate shared-brief budget (default: ${DEFAULT_BRIEF_BUDGET})
  --baseline-id ID            Source identifier recorded in metadata
  --candidate-id ID           Source identifier recorded in metadata
  --bun PATH                  Bun executable (default: current runtime)
  --json PATH                 Write the JSON report to PATH
  --markdown PATH             Also write a compact Markdown report to PATH
`;
}

function codePoints(value) { return Array.from(value).length; }
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function gitRef(root) {
  const result = childProcess.spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}
function version(command, args) {
  const result = childProcess.spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}
function runtimeSkillCodePoints(root) {
  const files = ["SKILL.md", "adapters/codex/runtime/SKILL.md", "adapters/grok/runtime/SKILL.md"];
  return Object.fromEntries(files.map((relative) => {
    const file = path.join(root, relative);
    return [relative, fs.existsSync(file) ? codePoints(fs.readFileSync(file, "utf8")) : null];
  }));
}
function ensureParent(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function shellQuote(value) { return `'${String(value).replaceAll("'", `'"'"'`)}'`; }
function originalCommand(options) {
  const args = [process.execPath, fileURLToPath(import.meta.url), "--baseline", options.baseline, "--candidate", options.candidate,
    "--repeats", String(options.repeats), "--warmups", String(options.warmups), "--brief-budget-chars", String(options.briefBudgetChars)];
  if (options.baselineId) args.push("--baseline-id", options.baselineId);
  if (options.candidateId) args.push("--candidate-id", options.candidateId);
  args.push("--bun", options.bun);
  return args.map(shellQuote).join(" ");
}

function writeHelper(root) {
  const helper = path.join(root, "invoke-source.mjs");
  fs.writeFileSync(helper, `
import fs from "node:fs";
let manifestReads = 0;
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function (...args) {
  if (String(args[0]).endsWith("adapter.json")) manifestReads += 1;
  return originalReadFileSync.apply(this, args);
};
const module = await import(process.argv[2]);
const out = []; const err = [];
const code = await module.run(process.argv.slice(3), {
  cwd: process.env.BATON_MEASURE_CWD,
  env: process.env,
  stdout: { write: (text) => out.push(String(text)) },
  stderr: { write: (text) => err.push(String(text)) },
});
process.stdout.write(JSON.stringify({ code, stdout: out.join(""), stderr: err.join(""), manifest_reads: manifestReads }));
`, "utf8");
  return helper;
}

function writeFixtureAdapter(root, bun) {
  const adapter = path.join(root, "adapter");
  fs.cpSync(path.join(REPO_ROOT, "test", "fixtures", "adapters", "alpha"), adapter, { recursive: true });
  const manifestPath = path.join(adapter, "adapter.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const catalog = path.join(adapter, "catalog-count.mjs");
  manifest.catalog.command = bun;
  manifest.catalog.args = [catalog];
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(catalog, `
import fs from "node:fs";
fs.appendFileSync(process.env.BATON_MEASURE_CATALOG_LOG, "catalog\\n");
process.stdout.write(JSON.stringify({ adapter_id: "alpha", version: "efficiency-fixture-1", models: [{ id: "alpha-model", model: "alpha-model", display_name: "Alpha", description: "fixture", hidden: false, reasoning_efforts: [{ id: "high", description: "high" }], default_reasoning_effort: "high", input_modalities: ["text"], additional_speed_tiers: [], service_tiers: [], default_service_tier: null, is_default: true }] }));
`, "utf8");
  return adapter;
}

function writeConfig(home) {
  fs.mkdirSync(path.join(home, ".baton"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, ".baton", "config.toml"), `schema_version = 4\n\n[cli.alpha]\nenabled = true\nexecution_models = ["alpha-model"]\n`, { mode: 0o600 });
}

function briefs(count) {
  const fixtures = [
    ["Trace the selection flow", "src/lib/native.ts"],
    ["Check adapter discovery", "src/adapters/sdk.ts"],
    ["Review brief validation", "src/lib/brief.ts"],
    ["Inspect CLI output", "src/cli.ts"],
  ];
  return fixtures.slice(0, count).map(([goal, scope], index) => ({
    goal,
    decisions: [`Task ${index + 1} has an independent scope`],
    scope: [scope],
    acceptance: ["Return bounded findings"],
    context: ["Offline fixture measurement"],
    constraints: ["Do not write repository files"],
    mode: "read-only",
  }));
}

function entryModule(source) {
  const file = path.join(source, "src", "cli.ts");
  if (!fs.existsSync(file)) fail(`source does not contain src/cli.ts: ${source}`);
  return pathToFileURL(file).href;
}

function invoke({ source, helper, home, adapter, project, catalogLog, bun, args }) {
  const catalogBefore = fs.existsSync(catalogLog) ? fs.readFileSync(catalogLog, "utf8").split("\n").filter(Boolean).length : 0;
  const started = performance.now();
  const child = childProcess.spawnSync(bun, [helper, entryModule(source), ...args], {
    cwd: project,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      BATON_ADAPTER_PATHS: adapter,
      BATON_MEASURE_CWD: project,
      BATON_MEASURE_CATALOG_LOG: catalogLog,
      BATON_HOST: "",
      ALPHA_HOST: "",
      BETA_HOST: "",
    },
    timeout: 30_000,
  });
  const elapsedMs = performance.now() - started;
  if (child.error?.code === "ETIMEDOUT") throw new Error("SOURCE_SUBPROCESS_TIMEOUT: command exceeded 30000ms");
  if (child.status !== 0) throw new Error(`SOURCE_SUBPROCESS_FAILED: ${child.stderr.trim() || child.error || child.status}`);
  let wrapper;
  try { wrapper = JSON.parse(child.stdout); } catch { throw new Error(`SOURCE_WRAPPER_INVALID: ${child.stdout}`); }
  if (wrapper.code !== 0) throw new Error(`SOURCE_COMMAND_FAILED: ${wrapper.stderr || wrapper.stdout}`);
  let payload;
  try { payload = JSON.parse(wrapper.stdout); } catch { throw new Error(`SOURCE_COMMAND_NON_JSON: ${wrapper.stdout}`); }
  const catalogAfter = fs.existsSync(catalogLog) ? fs.readFileSync(catalogLog, "utf8").split("\n").filter(Boolean).length : 0;
  return { elapsedMs, wrapper, payload, output: wrapper.stdout, catalogInvocations: catalogAfter - catalogBefore };
}

function normalize(payload, expectedCount) {
  const handoffs = Array.isArray(payload) ? payload : Array.isArray(payload?.handoffs) ? payload.handoffs : [payload];
  if (handoffs.length !== expectedCount) throw new Error(`PARITY_HANDOFF_COUNT: expected ${expectedCount}, received ${handoffs.length}`);
  return handoffs.map((handoff) => ({
    host: handoff.host,
    model_id: handoff.model_id,
    reasoning_effort: handoff.reasoning_effort || null,
    service_tier: handoff.service_tier || null,
    fork_context: handoff.fork_context,
    spawned: handoff.spawned,
    mode: handoff.mode,
    work_mode: handoff.work_mode,
    scope: handoff.scope,
    prompt_accepted: typeof handoff.prompt === "string" && handoff.prompt.length > 0,
  }));
}

function assertPromptAcceptance(payload, sourceBriefs) {
  const handoffs = Array.isArray(payload?.handoffs) ? payload.handoffs : Array.isArray(payload) ? payload : [payload];
  for (const [index, brief] of sourceBriefs.entries()) {
    const prompt = handoffs[index]?.prompt;
    if (typeof prompt !== "string") throw new Error(`PROMPT_ACCEPTANCE_FAILED: handoff ${index + 1} has no prompt`);
    for (const required of [brief.goal, ...brief.acceptance, ...brief.constraints]) {
      if (!prompt.includes(required)) throw new Error(`PROMPT_ACCEPTANCE_FAILED: handoff ${index + 1} omitted required brief content`);
    }
  }
}

function assertParity(baseline, candidate, sourceBriefs) {
  const keys = ["host", "model_id", "reasoning_effort", "service_tier", "fork_context", "spawned", "mode", "work_mode", "scope", "prompt_accepted"];
  const left = normalize(baseline, candidate.handoffCount);
  const right = normalize(candidate.payload, candidate.handoffCount);
  for (let index = 0; index < left.length; index += 1) {
    for (const key of keys) {
      if (JSON.stringify(left[index][key]) !== JSON.stringify(right[index][key])) {
        throw new Error(`BEHAVIORAL_PARITY_FAILED: handoff ${index + 1} differs at ${key}`);
      }
    }
  }
  assertPromptAcceptance(baseline, sourceBriefs);
  assertPromptAcceptance(candidate.payload, sourceBriefs);
  return { selection_and_acceptance: "passed", prompt_text_equality: "not_required" };
}

function measureScenario(options, handoffCount) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baton-efficiency-"));
  try {
    const home = path.join(root, "home"); const project = path.join(root, "project");
    fs.mkdirSync(home); fs.mkdirSync(project); writeConfig(home);
    const adapter = writeFixtureAdapter(root, options.bun); const helper = writeHelper(root);
    const catalogLog = path.join(root, "catalog.log");
    const sourceBriefs = briefs(handoffCount);
    const baselineBriefPaths = sourceBriefs.map((brief, index) => {
      const file = path.join(root, `baseline-${index}.json`); fs.writeFileSync(file, JSON.stringify(brief)); return file;
    });
    const candidateBriefs = path.join(root, "candidate-briefs.json");
    fs.writeFileSync(candidateBriefs, JSON.stringify(sourceBriefs));
    const baselineRun = () => {
      const rows = baselineBriefPaths.map((brief) => invoke({ source: options.baseline, helper, home, adapter, project, catalogLog, bun: options.bun, args: ["spawn", "--brief", brief, "--host", "alpha", "--work-mode", "execution", "--effort", "high", "--json"] }));
      return { elapsedMs: rows.reduce((total, row) => total + row.elapsedMs, 0), manifestReads: rows.reduce((total, row) => total + row.wrapper.manifest_reads, 0), catalogInvocations: rows.reduce((total, row) => total + row.catalogInvocations, 0), outputChars: rows.reduce((total, row) => total + codePoints(row.output), 0), promptChars: rows.reduce((total, row) => total + codePoints(row.payload.prompt || ""), 0), payload: rows.map((row) => row.payload) };
    };
    const candidateRun = () => {
      const row = invoke({ source: options.candidate, helper, home, adapter, project, catalogLog, bun: options.bun, args: ["spawn", "--briefs", candidateBriefs, "--brief-budget-chars", String(options.briefBudgetChars), "--host", "alpha", "--work-mode", "execution", "--effort", "high", "--json"] });
      return { elapsedMs: row.elapsedMs, manifestReads: row.wrapper.manifest_reads, catalogInvocations: row.catalogInvocations, outputChars: codePoints(row.output), promptChars: normalize(row.payload, handoffCount).reduce((total, item) => total + codePoints(Array.isArray(row.payload.handoffs) ? row.payload.handoffs.find((handoff) => handoff.scope === item.scope).prompt : row.payload.prompt), 0), payload: row.payload, handoffCount };
    };
    const runPair = () => {
      const before = baselineRun();
      const after = candidateRun();
      const parity = assertParity(before.payload, after, sourceBriefs);
      return { before, after, parity };
    };
    for (let index = 0; index < options.warmups; index += 1) runPair();
    const baseline = []; const candidate = [];
    let parity;
    for (let index = 0; index < options.repeats; index += 1) {
      const pair = runPair();
      baseline.push(pair.before); candidate.push(pair.after); parity = pair.parity;
    }
    const aggregate = (rows, name) => ({
      median_elapsed_ms: median(rows.map((row) => row.elapsedMs)),
      manifest_read_count: median(rows.map((row) => row.manifestReads)),
      catalog_invocation_count: median(rows.map((row) => row.catalogInvocations)),
      output_character_count: median(rows.map((row) => row.outputChars)),
      prompt_character_count: median(rows.map((row) => row.promptChars)),
    });
    const baselineMetrics = aggregate(baseline, "baseline");
    const candidateMetrics = aggregate(candidate, "candidate");
    return { handoff_count: handoffCount, baseline: baselineMetrics, candidate: candidateMetrics, parity };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function difference(baseline, candidate) {
  const result = {};
  for (const key of Object.keys(baseline)) {
    const before = baseline[key]; const after = candidate[key];
    result[key] = { baseline: before, candidate: after, delta: after - before, percent_change: before === 0 ? null : ((after - before) / before) * 100 };
  }
  return result;
}

function markdown(report) {
  const lines = ["# Baton efficiency measurement", "", `Original local command: \`${report.metadata.original_command}\``, "", "| Handoffs | Metric | Baseline | Candidate | Delta |", "| ---: | --- | ---: | ---: | ---: |"];
  for (const scenario of report.scenarios) {
    for (const [metric, row] of Object.entries(scenario.differences)) lines.push(`| ${scenario.handoff_count} | ${metric} | ${row.baseline} | ${row.candidate} | ${row.delta} |`);
  }
  lines.push("", "## Runtime skill code points", "", "| File | Baseline | Candidate |", "| --- | ---: | ---: |");
  for (const [file, baseline] of Object.entries(report.metadata.runtime_skill_code_points.baseline)) {
    lines.push(`| ${file} | ${baseline ?? "missing"} | ${report.metadata.runtime_skill_code_points.candidate[file] ?? "missing"} |`);
  }
  lines.push("", "Behavioral parity checks selection and prompt acceptance. Prompt text is allowed to differ. Character counts are Unicode code points; this report makes no token estimate.", "");
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(help()); return; }
  // Resolve a command name or wrapper once; every source and catalog uses it.
  const resolved = childProcess.spawnSync(options.bun, ["-e", "if (typeof Bun === 'undefined') process.exit(1); process.stdout.write(process.execPath)"], { encoding: "utf8", timeout: 10_000 });
  if (resolved.status !== 0 || !path.isAbsolute(resolved.stdout.trim())) fail("--bun must resolve to a runnable Bun executable");
  options.bun = resolved.stdout.trim();
  const scenarios = [1, 4].map((handoffCount) => {
    const measured = measureScenario(options, handoffCount);
    return { ...measured, differences: difference(measured.baseline, measured.candidate) };
  });
  const report = {
    schema_version: 1,
    metadata: {
      generated_at: new Date().toISOString(),
      runtime: { bun: version(options.bun, ["--version"]), node: version("node", ["--version"]), platform: process.platform, arch: process.arch },
      sources: { baseline: { path: options.baseline, identifier: options.baselineId || gitRef(options.baseline) }, candidate: { path: options.candidate, identifier: options.candidateId || gitRef(options.candidate) } },
      runtime_skill_code_points: { baseline: runtimeSkillCodePoints(options.baseline), candidate: runtimeSkillCodePoints(options.candidate) },
      repeats: options.repeats,
      warmups: options.warmups,
      brief_budget_chars: options.briefBudgetChars,
      original_command: originalCommand(options),
      token_estimate: null,
    },
    scenarios,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.json) { ensureParent(options.json); fs.writeFileSync(options.json, json); }
  if (options.markdown) { ensureParent(options.markdown); fs.writeFileSync(options.markdown, markdown(report)); }
  process.stdout.write(json);
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
