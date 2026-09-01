import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OpenSpecError, parseTasks, readOpenSpecApplyInstructions, readOpenSpecStatus, readTaskLedgerIdentity, resolveOpenSpecApplyInstructions, writeTaskConclusion, writeTaskConclusionByNumber, writeTaskConclusions } from "../src/lib/openspec.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures/openspec/changes/demo/tasks.md");

function applyFixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-openspec-apply-"));
  const changeDir = path.join(cwd, "openspec", "changes", "demo");
  fs.mkdirSync(changeDir, { recursive: true });
  fs.writeFileSync(path.join(changeDir, "tasks.md"), "# Tasks\n\n## Build\n\n- [ ] 1.1 First\n- [ ] 1.2 Second\n");
  fs.writeFileSync(path.join(changeDir, "proposal.md"), "# Proposal\noriginal\n");
  const output = () => ({
    changeName: "demo",
    changeDir,
    schemaName: "spec-driven",
    // Deliberately non-canonical order; resolution sorts it.
    contextFiles: { tasks: [path.join(changeDir, "tasks.md")], proposal: [path.join(changeDir, "proposal.md")] },
    progress: { total: 2, complete: 0, remaining: 2 },
    tasks: fs.readFileSync(path.join(changeDir, "tasks.md"), "utf8").split(/\r?\n/)
      .filter((line) => /^- \[[ xX-]\] /.test(line))
      .map((line, index) => ({ id: String(index + 1), description: line.replace(/^- \[[ xX-]\] /, ""), done: /^- \[[xX]\] /.test(line) })),
    state: "ready",
    instruction: "Continue with the pending tasks.",
    context: "TypeScript project",
    operationGuidance: ["Keep summaries concise"],
  });
  return { cwd, changeDir, output };
}

describe("parseTasks + writeTaskConclusion", () => {
  it("resolves typed apply instructions, ordered context, ledger identity, and stable byte hashes", () => {
    const fixture = applyFixture();
    const calls: string[][] = [];
    const options = {
      cli: "/fake/openspec",
      runner: (_command: string, args: string[]) => {
        calls.push(args);
        return { status: 0, stdout: JSON.stringify(fixture.output()), stderr: "" };
      },
    };
    const resolved = resolveOpenSpecApplyInstructions(fixture.cwd, "demo", options);
    assert.equal(resolved.schema, "spec-driven");
    assert.equal(resolved.changeRoot, fs.realpathSync(fixture.changeDir));
    assert.deepEqual(resolved.contextFiles.map((file) => file.artifact), ["proposal", "tasks"]);
    assert.deepEqual(resolved.pendingTaskNumbers, ["1.1", "1.2"]);
    assert.equal(resolved.taskLedger.path, path.join(fixture.changeDir, "tasks.md"));
    assert.equal(resolved.taskLedger.identity, resolved.taskLedgerIdentity);
    assert.equal(resolved.instruction, "Continue with the pending tasks.");
    assert.deepEqual(resolved.operationGuidance, ["Keep summaries concise"]);
    const proposalHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(fixture.changeDir, "proposal.md"))).digest("hex");
    assert.equal(resolved.contextFileHashes[path.join(fixture.changeDir, "proposal.md")], proposalHash);
    assert.equal(resolved.selectedTaskSnapshotFingerprint.length, 64);
    assert.deepEqual(calls, [["instructions", "apply", "--change", "demo", "--json"]]);
    const second = readOpenSpecApplyInstructions(fixture.cwd, { change: "demo", ...options });
    assert.equal(second.selectedTaskSnapshotFingerprint, resolved.selectedTaskSnapshotFingerprint);
    assert.deepEqual(second.contextFiles, resolved.contextFiles);
  });

  it("changes context hashes and selected-task fingerprints when source bytes or task state changes", () => {
    const fixture = applyFixture();
    const options = { cli: "/fake/openspec", runner: () => ({ status: 0, stdout: JSON.stringify(fixture.output()), stderr: "" }) };
    const before = resolveOpenSpecApplyInstructions(fixture.cwd, "demo", options);
    fs.appendFileSync(path.join(fixture.changeDir, "proposal.md"), "changed\n");
    const contentChanged = resolveOpenSpecApplyInstructions(fixture.cwd, "demo", options);
    assert.equal(contentChanged.selectedTaskSnapshotFingerprint, before.selectedTaskSnapshotFingerprint, "context hashes and task snapshots are independent");
    assert.notEqual(contentChanged.contextFileHashes[path.join(fixture.changeDir, "proposal.md")], before.contextFileHashes[path.join(fixture.changeDir, "proposal.md")]);
    fs.appendFileSync(path.join(fixture.changeDir, "tasks.md"), "- [ ] 1.3 Inserted\n");
    const inserted = resolveOpenSpecApplyInstructions(fixture.cwd, "demo", options);
    assert.deepEqual(inserted.pendingTaskNumbers, ["1.1", "1.2", "1.3"]);
    assert.notEqual(inserted.selectedTaskSnapshotFingerprint, contentChanged.selectedTaskSnapshotFingerprint);
    const completed = fs.readFileSync(path.join(fixture.changeDir, "tasks.md"), "utf8").replace("- [ ] 1.1", "- [x] 1.1");
    fs.writeFileSync(path.join(fixture.changeDir, "tasks.md"), completed);
    const completion = resolveOpenSpecApplyInstructions(fixture.cwd, "demo", options);
    assert.deepEqual(completion.pendingTaskNumbers, ["1.2", "1.3"]);
    assert.notEqual(completion.selectedTaskSnapshotFingerprint, inserted.selectedTaskSnapshotFingerprint);
  });

  it("keeps transient apply metadata diagnostic-only in the task fingerprint", () => {
    const fixture = applyFixture();
    let applyIds = ["1", "2"];
    const options = {
      cli: "/fake/openspec",
      runner: () => ({
        status: 0,
        stdout: JSON.stringify({
          ...fixture.output(),
          tasks: applyIds.map((id, index) => ({ id, description: `${index === 0 ? "1.1 First" : "1.2 Second"}`, done: false })),
        }),
        stderr: "",
      }),
    };
    const before = resolveOpenSpecApplyInstructions(fixture.cwd, "demo", options);
    applyIds = ["101", "202"];
    const reallocated = resolveOpenSpecApplyInstructions(fixture.cwd, "demo", options);
    assert.equal(reallocated.selectedTaskSnapshotFingerprint, before.selectedTaskSnapshotFingerprint);
    assert.notEqual(reallocated.selectedTasks[0]?.applyId, before.selectedTasks[0]?.applyId);
  });

  it("rejects completion drift when Markdown is complete but apply output is pending", () => {
    const fixture = applyFixture();
    fs.writeFileSync(path.join(fixture.changeDir, "tasks.md"), "# Tasks\n\n## Build\n\n- [x] 1.1 First\n- [ ] 1.2 Second\n");
    const staleApply = { ...fixture.output(), tasks: [{ id: "101", description: "1.1 First", done: false }, { id: "202", description: "1.2 Second", done: false }] };
    const options = {
      cli: "/fake/openspec",
      runner: () => ({ status: 0, stdout: JSON.stringify(staleApply), stderr: "" }),
    };
    assert.throws(() => resolveOpenSpecApplyInstructions(fixture.cwd, "demo", options), (error) => error instanceof OpenSpecError && error.code === "TASK_MAPPING_CONTRADICTORY");
  });

  it("fails closed for malformed output, missing context/tasks, duplicate numbers, and escaped paths", () => {
    const fixture = applyFixture();
    const run = (output: unknown) => resolveOpenSpecApplyInstructions(fixture.cwd, "demo", {
      cli: "/fake/openspec",
      runner: () => ({ status: 0, stdout: typeof output === "string" ? output : JSON.stringify(output), stderr: "" }),
    });
    assert.throws(() => run("not json"), (error) => error instanceof OpenSpecError && error.code === "APPLY_INSTRUCTIONS_INVALID");
    const base = fixture.output();
    const missingContext = { ...base, contextFiles: {} };
    assert.throws(() => run(missingContext), (error) => error instanceof OpenSpecError && error.code === "CONTEXT_FILE_MISSING");
    const missingTasks = { ...base, contextFiles: { proposal: [path.join(fixture.changeDir, "proposal.md")] } };
    assert.throws(() => run(missingTasks), (error) => error instanceof OpenSpecError && error.code === "TASK_LEDGER_MISSING");
    fs.writeFileSync(path.join(fixture.changeDir, "tasks.md"), "- [ ] 1.1 One\n- [ ] 1.1 Duplicate\n");
    assert.throws(() => run(base), (error) => error instanceof OpenSpecError && error.code === "TASK_NUMBER_AMBIGUOUS");
    const outside = path.join(os.tmpdir(), `baton-openspec-outside-${process.pid}.md`);
    const escaped = { ...base, contextFiles: { tasks: [path.join(fixture.changeDir, "tasks.md")], proposal: [outside] } };
    fs.writeFileSync(outside, "outside\n");
    assert.throws(() => run(escaped), (error) => error instanceof OpenSpecError && error.code === "CONTEXT_PATH_INVALID");
  });

  it("retries status with the sole change for OpenSpec CLIs that require --change", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-openspec-status-"));
    const change = path.join(cwd, "openspec", "changes", "incident-audit");
    fs.mkdirSync(change, { recursive: true });
    fs.writeFileSync(path.join(change, "tasks.md"), "- [ ] 1.1 Verify incidents\n");
    const calls: string[][] = [];
    const status = readOpenSpecStatus(cwd, {
      cli: "/fake/openspec",
      runner: (_command, args) => {
        calls.push(args);
        return args.includes("--change")
          ? { status: 0, stdout: "incident-audit 0/1 complete\n", stderr: "- Loading change status...\n" }
          : { status: 1, stdout: "", stderr: "Missing required option --change" };
      },
    });
    assert.equal(status.ok, true);
    assert.equal(status.text, "incident-audit 0/1 complete");
    assert.deepEqual(calls, [["status"], ["status", "--change", "incident-audit"]]);
  });

  it("parses pending/done/skipped and flips a checkbox with a conclusion", () => {
    const text = fs.readFileSync(fixture, "utf8");
    const tasks = parseTasks(text);
    assert.ok(tasks.length >= 12);
    const pending = tasks.filter((t) => t.status === "pending");
    const done = tasks.filter((t) => t.status === "done");
    const skipped = tasks.filter((t) => t.status === "skipped");
    assert.ok(pending.length >= 10);
    assert.equal(done.length, 1);
    assert.equal(skipped.length, 1);

    const target = pending.find((t) => t.number === "2.1");
    assert.ok(target);
    const updated = writeTaskConclusion(text, target.line_index, "login form shipped");
    assert.ok(updated);
    const lines = updated.split(/\r?\n/);
    assert.match(lines[target.line_index], /^- \[x\]\s+2\.1 /);
    assert.match(lines[target.line_index + 1], /^\s+- conclusion: login form shipped$/);

    const again = parseTasks(updated);
    const flipped = again.find((t) => t.number === "2.1");
    assert.equal(flipped.status, "done");
  });

  it("writes by stable task number after unrelated insertion", () => {
    const source = [
      "# Tasks", "", "- [ ] 1.1 First", "- [ ] 1.2 Inserted", "- [ ] 2.1 Target", "- [ ] 2.2 Later",
    ].join("\n");
    const updated = writeTaskConclusionByNumber(source, "2.1", "target accepted");
    assert.match(updated, /- \[ \] 1\.2 Inserted/);
    assert.match(updated, /- \[x\] 2\.1 Target\n  - conclusion: target accepted/);
    assert.equal(parseTasks(updated).find((task) => task.number === "1.2")?.status, "pending");
    assert.equal(parseTasks(updated).find((task) => task.number === "2.1")?.status, "done");
  });

  it("preserves indentation while completing a nested pending task", () => {
    const source = "## Work\n\n  - [ ] 2.1 Nested target\n";
    const updated = writeTaskConclusionByNumber(source, "2.1", "nested accepted");
    assert.match(updated, /^  - \[x\] 2\.1 Nested target$/m);
    assert.match(updated, /^    - conclusion: nested accepted$/m);
    assert.equal(parseTasks(updated).find((task) => task.number === "2.1")?.status, "done");
  });

  it("fails closed for missing or duplicate task numbers", () => {
    assert.throws(() => writeTaskConclusionByNumber("- [ ] 1.1 One", "2.1", "x"), (error) => error instanceof OpenSpecError && error.code === "TASK_ID_NOT_FOUND");
    assert.throws(() => writeTaskConclusionByNumber("- [ ] 2.1 One\n- [ ] 2.1 Two", "2.1", "x"), (error) => error instanceof OpenSpecError && error.code === "TASK_ID_AMBIGUOUS");
  });

  it("writes a batch of stable task conclusions from one source snapshot", () => {
    const source = "## Work\n\n- [ ] 1.1 First\n- [ ] 1.2 Second\n";
    const updated = writeTaskConclusions(source, new Map([["1.1", "first\naccepted"], ["1.2", "second accepted"]]));
    assert.match(updated, /- \[x\] 1\.1 First\n  - conclusion: first accepted/);
    assert.match(updated, /- \[x\] 1\.2 Second\n  - conclusion: second accepted/);
    const file = path.join(os.tmpdir(), `baton-ledger-${process.pid}.md`); fs.writeFileSync(file, source);
    const identity = readTaskLedgerIdentity(file); assert.equal(identity.identity, path.resolve(file)); assert.equal(identity.sha256.length, 64); fs.unlinkSync(file);
  });
});
