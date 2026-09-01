import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dir, "..");
const skillFiles = {
  root: path.join(root, "SKILL.md"),
  codex: path.join(root, "adapters", "codex", "runtime", "SKILL.md"),
  grok: path.join(root, "adapters", "grok", "runtime", "SKILL.md"),
};
const openspecApplySkill = path.join(root, ".agents", "skills", "openspec-apply-change", "SKILL.md");

function assertCrossTreeRouteContract(text: string, host: string): void {
  const paragraph = text.split(/\r?\n[\t ]*\r?\n/).find((candidate) => (
    /A\s+separate\s+root\s+conversation\s+has\s+its\s+own\s+tree-local\s+capacity\./i.test(candidate)
    && /session's\s+native\s+failure\s+into\s+that\s+signal\./i.test(candidate)
  ));
  assert.ok(paragraph, `${host} skill is missing its cross-tree route contract`);
  assert.match(paragraph, /shared\s+workspace\s+safety\s+checks\s+still\s+apply\s+across\s+trees/i);
  assert.match(paragraph, /native\s+route\s+availability,\s+quota,\s+rate-limit,\s+and\s+uncallability\s+evidence\s+remains\s+session-local/i);
  assert.match(paragraph, /new\s+session\s+must\s+recheck\s+it/i);
  assert.match(paragraph, /provider-wide\s+quota\s+input\s+is\s+`provider_quotas`\s+explicitly\s+returned\s+by\s+the\s+active\s+adapter\s+catalog/i);
  assert.doesNotMatch(paragraph, /host\/profile quota checks still apply across trees/i);
}

const commonInvariants: Array<[string, RegExp]> = [
  ["hookless explicit invocation", /hookless[\s\S]{0,260}(?:explicitly|explicit invocation|explicit host)/i],
  ["canonical OpenSpec ledger", /OpenSpec[\s\S]{0,180}(?:canonical|remain canonical|task ledger)/i],
  ["apply context and affected code", /(?=[\s\S]*apply\s+instructions)(?=[\s\S]*contextFiles)(?=[\s\S]*(?:repository guidance|repo guidance))(?=[\s\S]*affected\s+code)/i],
  ["captured source snapshot", /(?=[\s\S]*(?:capture|captures)[\s\S]{0,80}(?:audit|audits))(?=[\s\S]*source_snapshot)(?=[\s\S]*(?:revision|repository revision))(?=[\s\S]*(?:task-ledger|task ledger))(?=[\s\S]*(?:hash|fingerprint))(?=[\s\S]*(?:stale|fails closed))/i],
  ["versioned fine-grained plan", /versioned[\s\S]{0,120}fine-grained plan/i],
  ["compiled plan fields", /(?=[\s\S]*task refs)(?=[\s\S]*dependencies)(?=[\s\S]*read context)(?=[\s\S]*write paths)(?=[\s\S]*(?:allowed operations|operations))(?=[\s\S]*(?:patch recipe|patch-only))(?=[\s\S]*(?:done criteria|completion criteria))(?=[\s\S]*(?:validation|permitted validation))(?=[\s\S]*(?:gates|parent gates))(?=[\s\S]*(?:task mappings|mappings))/i],
  ["patch and verification modes", /patch-only[\s\S]{0,260}verification-only/i],
  ["maximal safe ready frontier", /maximal safe ready frontier/i],
  ["per-unit minimum capability", /(?=[\s\S]*minimum capability)(?=[\s\S]*(?:complexity|context))(?=[\s\S]*(?:code scope|reasoning))(?=[\s\S]*(?:execution|tool))/i],
  ["configured route priority", /(?=[\s\S]*configured)(?=[\s\S]*coding_models)(?=[\s\S]*(?:exact|priority order|order))/i],
  ["unverified route single-flight", /(?=[\s\S]*unverified\s+session-host-route)(?=[\s\S]*single-flight)(?=[\s\S]*first\s+native\s+launch)/i],
  ["successful bind fan-out", /bind\s+success\s+to\s+fan\s+out/i],
  ["native failure dispatch evidence", /(?=[\s\S]*native launch failure)(?=[\s\S]*exact code)(?=[\s\S]*unmodified raw message)(?=[\s\S]*dispatch\s+fail)(?=[\s\S]*release)/i],
  ["same-run immutable successor refill", /(?=[\s\S]*refill the same run)(?=[\s\S]*immutable configured successors)/i],
  ["no probe or compiled rerun", /(?=[\s\S]*never\s+create a separate read-only probe)(?=[\s\S]*new compiled run)(?=[\s\S]*never\s+special-case\s+Spark)/i],
  ["silent capable continuation", /(?=[\s\S]*silently continue)(?=[\s\S]*configured route)(?=[\s\S]*available)(?=[\s\S]*capable)/i],
  ["complete no-qualified diagnostics", /(?=[\s\S]*notify(?:\s+the\s+user)?\s+only on)(?=[\s\S]*NO_QUALIFIED_CANDIDATE)(?=[\s\S]*(?:every|each))(?=[\s\S]*(?:candidate|configured))(?=[\s\S]*(?:exclusion reason|exclusion))/i],
  ["session-local recovery", /(?=[\s\S]*session-local)(?=[\s\S]*(?:cache|facts))(?=[\s\S]*session evidence never carries to)(?=[\s\S]*new\s+(?:[A-Za-z]+\s+)?session)(?=[\s\S]*(?:recheck|check))/i],
  ["unchanged fresh native prompt", /(?=[\s\S]*prompt unchanged)(?=[\s\S]*fresh)(?=[\s\S]*(?:exact-model|exact model))(?=[\s\S]*native worker)/i],
  ["opaque handle and liveness", /(?=[\s\S]*opaque)(?=[\s\S]*(?:handle|execution handle))(?=[\s\S]*(?:real|native))(?=[\s\S]*liveness)/i],
  ["terminal release refill", /(?=[\s\S]*exactly one terminal)(?=[\s\S]*(?:release|releases)[\s\S]{0,120}before refilling)/i],
  ["terminal scope retention", /(?=[\s\S]*terminal scope)(?=[\s\S]*(?:owned|remain))(?=[\s\S]*release)/i],
  ["director return conditions", /(?=[\s\S]*source\s+staleness)(?=[\s\S]*changed\s+contracts)(?=[\s\S]*scope\s+changes)(?=[\s\S]*safety-blocked\s+partial\s+mutation)(?=[\s\S]*PLAN_INSUFFICIENT)/i],
  ["worker prohibitions", /(?=[\s\S]*worker)(?=[\s\S]*(?:not|cannot|must not))(?=[\s\S]*redesign)(?=[\s\S]*(?:broaden|scope))(?=[\s\S]*(?:spawn|children))(?=[\s\S]*Git)(?=[\s\S]*OpenSpec)(?=[\s\S]*(?:choose|choosing)\s+(?:a\s+)?model)/i],
  ["parent gate reconciliation", /(?=[\s\S]*parent)(?=[\s\S]*(?:accepts|accept) gates)(?=[\s\S]*reconcil(?:e|es))(?=[\s\S]*(?:checkbox|mapped unit))(?=[\s\S]*(?:never|not)[\s\S]*(?:early|before))/i],
  ["manual compatibility", /(?=[\s\S]*manual)(?=[\s\S]*(?:compatib|legacy))(?=[\s\S]*(?:compiled|scope flags))/i],
  ["compiled run operations", /(?=[\s\S]*--plan-file)(?=[\s\S]*--status)(?=[\s\S]*--accept-gate)(?=[\s\S]*--reconcile)(?=[\s\S]*(?:successor|revision))/i],
  ["rolling run operations", /(?=[\s\S]*baton run start)(?=[\s\S]*--append-plan)(?=[\s\S]*--seal-task)(?=[\s\S]*--accept-gate)(?=[\s\S]*--reconcile)/i],
  ["rolling incremental startup", /(?=[\s\S]*(?:small safe delta|small, safe delta))(?=[\s\S]*append later deltas)(?=[\s\S]*(?:queued|running|active))/i],
  ["rolling recovery and acceptance", /(?=[\s\S]*idempoten)(?=[\s\S]*terminal success)(?=[\s\S]*parent acceptance)(?=[\s\S]*release)/i],
];

describe("compiled OpenSpec runtime skill audit", () => {
  it("keeps the root, Codex, and Grok skills on the same director contract", () => {
    for (const [name, file] of Object.entries(skillFiles)) {
      assert.equal(fs.existsSync(file), true, `${name} runtime skill is missing`);
      const text = fs.readFileSync(file, "utf8");
      for (const [label, pattern] of commonInvariants) {
        assert.match(text, pattern, `${name} skill is missing invariant: ${label}`);
      }
    }
  });

  it("retains each host's native catalog and execution terminology", () => {
    const codex = fs.readFileSync(skillFiles.codex, "utf8");
    assert.match(codex, /app-server[\s\S]{0,180}model\/list/i);
    assert.match(codex, /(?=[\s\S]*task_name)(?=[\s\S]*fork_context=false)/i);
    assert.match(codex, /Codex native child/i);
    assertCrossTreeRouteContract(codex, "Codex");

    const grok = fs.readFileSync(skillFiles.grok, "utf8");
    assert.match(grok, /(?=[\s\S]*ACP)(?=[\s\S]*initialize)(?=[\s\S]*availableModels)/i);
    assert.match(grok, /(?=[\s\S]*spawn_subagent)(?=[\s\S]*background=true)(?=[\s\S]*isolation=none)/i);
    assert.match(grok, /(?=[\s\S]*subagent_id)(?=[\s\S]*get_command_or_subagent_output)/i);
    assert.match(grok, /(?=[\s\S]*resume_from)(?=[\s\S]*unset)/i);
    assertCrossTreeRouteContract(grok, "Grok");
  });

  it("keeps the OpenSpec apply skill outside the Baton integration edit scope", () => {
    const batonEditScope = Object.values(skillFiles).map((file) => path.relative(root, file));
    const protectedPath = path.relative(root, openspecApplySkill);
    assert.equal(fs.existsSync(openspecApplySkill), true, "OpenSpec apply skill is missing");
    assert.equal(batonEditScope.includes(protectedPath), false, "OpenSpec apply skill entered Baton edit scope");
    const protectedText = fs.readFileSync(openspecApplySkill, "utf8");
    assert.doesNotMatch(protectedText, /compiled apply|NO_QUALIFIED_CANDIDATE|Baton integration/i);
  });
});
