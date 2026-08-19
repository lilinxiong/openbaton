import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initProject } from "../src/commands/init.js";
import { loadConfig } from "../src/lib/config.js";
import { applyChange } from "../src/lib/apply.js";
import { parseTasks } from "../src/lib/openspec.js";
import { withHome } from "./home.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureTasks = path.join(here, "fixtures/openspec/changes/demo/tasks.md");

describe("applyChange", () => {
  it("does not stop at the 9th pending task — every pending gets a ticket, director-local, or blocked", () => {
    withHome(() => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-apply-"));
    fs.mkdirSync(path.join(cwd, "openspec", "changes", "demo"), { recursive: true });
    fs.copyFileSync(fixtureTasks, path.join(cwd, "openspec", "changes", "demo", "tasks.md"));
    initProject(cwd, { tools: ["claude"] });
    const cfg = loadConfig(cwd);
    const result = applyChange({ cwd, change: "demo", cfg });
    const pending = parseTasks(fs.readFileSync(fixtureTasks, "utf8")).filter((t) => t.status === "pending");
    assert.ok(pending.length >= 10);
    const handled = result.tickets.length + result.local.length + result.blocked.length;
    assert.equal(handled, pending.length);
    assert.ok(handled > 9);
    });
  });
});
