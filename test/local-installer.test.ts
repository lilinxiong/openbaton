import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "bun:test";

const REPO = path.resolve(import.meta.dir, "..");
const PYTHON = execFileSync("which", ["python3"], { encoding: "utf8" }).trim();
const SYSTEM_NODE = execFileSync("which", ["node"], {
  encoding: "utf8",
  env: { ...process.env, PATH: process.env.PATH },
}).trim();
const ISOLATED_SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter);

type PlanMode = "success" | "active" | "conflict" | "invalid" | "stale" | "malformed-preflight" | "malformed-remove" | "malformed-already-absent" | "malformed-manifest" | "apply-conflict";
type Fixture = {
  root: string;
  checkout: string;
  home: string;
  bin: string;
  log: string;
  env: NodeJS.ProcessEnv;
};

/**
 * The fake CLI deliberately emits the same top-level fields as src/lib/uninstall.ts.
 * Keeping this contract here means installer tests exercise orchestration and
 * safety interpretation, while the existing uninstall tests exercise deletion.
 */
const FAKE_CLI = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const home = process.env.HOME;
const log = process.env.FAKE_LOG;
const record = (line) => fs.appendFileSync(log, line + "\\n");
record("cli " + args.join(" "));
const mode = process.env.FAKE_PLAN_MODE || "success";
const plan = { hosts: ["codex", "grok"], clean: true, dry_run: true, applied: false, targets: [], active_tickets: [], constraints: [] };
if (args[0] === "uninstall" && args.includes("--dry-run")) {
  if (mode === "active") plan.active_tickets = [{ path: "~/.baton/workspaces/active/v2/spawns/ticket.json", ticket_id: "ticket-active", status: "running", host: "codex" }];
  if (mode === "conflict") plan.targets = [{ action: "conflict", path: "~/.codex/skills/baton/SKILL.md", host: "codex", reason: "skill was modified or ownership is ambiguous" }];
  if (mode === "invalid") plan.constraints = ["UNINSTALL_STATE_INVALID: malformed runtime state"];
  if (mode === "stale") plan.targets = [{ action: "remove", path: "~/.baton/stale", reason: "clean removes Baton-owned global file", expected_kind: "file", expected_mode: 420, expected_fingerprint: "stale" }];
  if (mode === "malformed-preflight") {
    console.log(JSON.stringify({ hosts: plan.hosts, clean: true, dry_run: true, targets: [], active_tickets: [], constraints: [] }));
    process.exit(0);
  }
  if (mode === "malformed-remove") {
    plan.targets = [{ action: "remove", path: "~/.baton/malformed", reason: "invalid remove metadata", expected_kind: "file", expected_fingerprint: "", expected_mode: -1 }];
    console.log(JSON.stringify(plan));
    process.exit(0);
  }
  if (mode === "malformed-already-absent") {
    plan.targets = [{ action: "already-absent", path: "~/.baton/missing", reason: "invalid absent metadata", expected_kind: "file", expected_fingerprint: "present", expected_mode: 420 }];
    console.log(JSON.stringify(plan));
    process.exit(0);
  }
  console.log(JSON.stringify(plan));
  process.exit(0);
}
if (args[0] === "uninstall") {
  if (mode === "stale") { console.error("UNINSTALL_PLAN_STALE: target bytes changed: ~/.baton/stale"); process.exit(1); }
  if (mode === "apply-conflict") {
    console.log(JSON.stringify({ ...plan, dry_run: false, applied: false, targets: [{ action: "conflict", path: "~/.codex/skills/baton/SKILL.md", host: "codex", reason: "ownership changed after preflight" }] }));
    process.exit(0);
  }
  fs.rmSync(path.join(home, ".baton"), { recursive: true, force: true });
  fs.rmSync(path.join(home, ".codex", "skills", "baton"), { recursive: true, force: true });
  fs.rmSync(path.join(home, ".grok", "skills", "baton"), { recursive: true, force: true });
  console.log(JSON.stringify({ ...plan, dry_run: false, applied: true }));
  process.exit(0);
}
if (args[0] === "init") {
  if (process.env.FAKE_FAIL === "init") { console.error("init failed after link"); process.exit(27); }
  const stdin = fs.readFileSync(0, "utf8");
  record("init-stdin=" + JSON.stringify(stdin) + " args=" + args.join(" "));
  fs.mkdirSync(path.join(home, ".baton", "adapters"), { recursive: true });
  fs.mkdirSync(path.join(home, ".baton", "adapters", "codex"), { recursive: true });
  fs.mkdirSync(path.join(home, ".baton", "adapters", "grok"), { recursive: true });
  fs.writeFileSync(path.join(home, ".baton", "SKILL.md"), fs.readFileSync(path.join(process.cwd(), "SKILL.md")));
  fs.writeFileSync(path.join(home, ".baton", "adapters", "codex", "adapter.json"), "{}\\n");
  fs.writeFileSync(path.join(home, ".baton", "adapters", "grok", "adapter.json"), "{}\\n");
  fs.writeFileSync(path.join(home, ".baton", "config.toml"), "schema_version = 2\\ncli = {}\\n[director]\\nmax_concurrent = 4\\nmax_depth = 1\\n");
  fs.mkdirSync(path.join(home, ".codex", "skills", "baton"), { recursive: true });
  fs.mkdirSync(path.join(home, ".grok", "skills", "baton"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "skills", "baton", "SKILL.md"), "codex host skill\\n");
  fs.writeFileSync(path.join(home, ".grok", "skills", "baton", "SKILL.md"), "grok host skill\\n");
  const manifestFiles = mode === "malformed-manifest" ? ["not-an-object"] : [
    { kind: "host-skill", host: "codex", path: path.join(home, ".codex", "skills", "baton", "SKILL.md") },
    { kind: "host-skill", host: "grok", path: path.join(home, ".grok", "skills", "baton", "SKILL.md") },
  ];
  fs.writeFileSync(path.join(home, ".baton", "install-manifest.json"), JSON.stringify({ files: manifestFiles }));
  process.exit(0);
}
if (args[0] === "version") { console.log("1.0.0"); process.exit(0); }
process.exit(0);
`;

const FAKE_BUN = `#!/bin/sh
set -eu
printf '%s\\n' "bun $*" >> "$FAKE_LOG"
if [ "\${1:-}" = "pm" ] && [ "\${2:-}" = "ls" ]; then printf '%s\\n' "\${FAKE_PM_JSON:-{}}"; exit 0; fi
if [ "\${1:-}" = "install" ] && [ "\${FAKE_FAIL:-}" = "install" ]; then exit 22; fi
if [ "\${1:-}" = "run" ] && { [ "\${2:-}" = "test" ] || [ "\${2:-}" = "check" ]; }; then
  # The real test script runs the type/check gate before the test runner. Keep
  # both failure modes observable even though this fixture models that script
  # as one fake package-manager invocation.
  [ "\${FAKE_FAIL:-}" = "test" ] && exit 23
  [ "\${FAKE_FAIL:-}" = "check" ] && exit 23
  exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "build" ]; then [ "\${FAKE_FAIL:-}" = "build" ] && exit 24 || cp "$FAKE_CLI_TEMPLATE" "$FAKE_CHECKOUT/dist/bin/baton.js"; chmod +x "$FAKE_CHECKOUT/dist/bin/baton.js"; exit 0; fi
if [ "\${1:-}" = "link" ]; then [ "\${FAKE_FAIL:-}" = "link" ] && exit 25 || ln -sfn "$FAKE_CHECKOUT/dist/bin/baton.js" "$FAKE_BIN/baton"; exit 0; fi
if [ "\${1:-}" = "remove" ] || [ "\${1:-}" = "uninstall" ] || [ "\${1:-}" = "unlink" ]; then [ "\${FAKE_FAIL:-}" = "remove" ] && exit 26 || rm -f "$FAKE_BIN/baton"; exit 0; fi
exit 0
`;

const FAKE_NPM = `#!/bin/sh
set -eu
printf '%s\\n' "npm $*" >> "$FAKE_LOG"
if [ "\${1:-}" = "root" ] && [ "\${2:-}" = "--global" ]; then printf '%s\\n' "$FAKE_NPM_ROOT"; exit 0; fi
if [ "\${1:-}" = "ls" ] && [ "\${2:-}" = "-g" ]; then printf '%s\\n' "\${FAKE_PM_JSON:-{}}"; exit 0; fi
if [ "\${1:-}" = "uninstall" ] || [ "\${1:-}" = "remove" ]; then rm -f "$FAKE_BIN/baton"; exit 0; fi
exit 0
`;

const FAKE_NODE = `#!/bin/sh
exec "$REAL_NODE" "$@"
`;

function writeExecutable(file: string, source: string): void {
  fs.writeFileSync(file, source, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baton-local-installer-"));
  const checkout = path.join(root, "checkout");
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const log = path.join(root, "commands.log");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(log, "");
  fs.cpSync(REPO, checkout, {
    recursive: true,
    filter: (source) => !source.endsWith("/.git") && !source.includes("/node_modules/") && !source.includes("/test/") && !source.includes("/openspec/"),
  });
  fs.mkdirSync(path.join(checkout, "dist", "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "fake-cli.js"), FAKE_CLI, { mode: 0o755 });
  writeExecutable(path.join(bin, "bun"), FAKE_BUN);
  writeExecutable(path.join(bin, "npm"), FAKE_NPM);
  writeExecutable(path.join(bin, "node"), FAKE_NODE);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    // Do not inherit the developer's PATH: a real globally linked baton must
    // never be mistaken for the fixture's intentionally empty command path.
    PATH: `${bin}${path.delimiter}${ISOLATED_SYSTEM_PATH}`,
    FAKE_BIN: bin,
    FAKE_CHECKOUT: checkout,
    FAKE_CLI_TEMPLATE: path.join(root, "fake-cli.js"),
    FAKE_LOG: log,
    REAL_NODE: SYSTEM_NODE,
    FAKE_PM_JSON: "{}",
    FAKE_NPM_ROOT: path.join(root, "npm-global", "lib", "node_modules"),
    BATON_SESSION_ID: "isolated-installer-test",
  };
  for (const key of ["BATON_HOST", "CODEX_THREAD_ID", "GROK_SESSION_ID", "BATON_ADAPTER_PATHS"]) delete env[key];
  return { root, checkout, home, bin, log, env };
}

function runInstaller(f: Fixture, args: string[] = []) {
  return spawnSync(PYTHON, [path.join(f.checkout, "scripts", "update_local_baton.py"), ...args], {
    cwd: f.checkout,
    env: f.env,
    encoding: "utf8",
  });
}

function logLines(f: Fixture): string[] {
  return fs.readFileSync(f.log, "utf8").trim() ? fs.readFileSync(f.log, "utf8").trim().split("\n") : [];
}

function setupPriorInstall(f: Fixture, { ambiguous = false } = {}): string {
  const packageRoot = path.join(f.home, ".bun", "install", "global", "node_modules", "@zhouliuya", "openbaton");
  const oldCli = path.join(packageRoot, "dist", "bin", "baton.js");
  fs.mkdirSync(path.dirname(oldCli), { recursive: true });
  fs.writeFileSync(oldCli, "old baton runtime\n");
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@zhouliuya/openbaton", bin: { baton: "dist/bin/baton.js" } }));
  fs.mkdirSync(path.join(f.home, ".baton"), { recursive: true });
  fs.writeFileSync(path.join(f.home, ".baton", "old-runtime"), "keep until replacement\n");
  fs.symlinkSync(oldCli, path.join(f.bin, "baton"));
  f.env.FAKE_PM_JSON = ambiguous ? "{}" : JSON.stringify({ packages: [{ name: "@zhouliuya/openbaton", path: packageRoot, version: "0.9.0" }] });
  return fs.realpathSync(oldCli);
}

function setupPriorNpmInstall(f: Fixture): string {
  const npmRoot = f.env.FAKE_NPM_ROOT as string;
  const packageRoot = path.join(npmRoot, "@zhouliuya", "openbaton");
  const oldCli = path.join(packageRoot, "dist", "bin", "baton.js");
  fs.mkdirSync(path.dirname(oldCli), { recursive: true });
  fs.writeFileSync(oldCli, "old npm baton runtime\\n");
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@zhouliuya/openbaton", bin: { baton: "dist/bin/baton.js" } }));
  fs.mkdirSync(path.join(f.home, ".baton"), { recursive: true });
  fs.writeFileSync(path.join(f.home, ".baton", "old-runtime"), "keep until npm replacement\\n");
  fs.symlinkSync(oldCli, path.join(f.bin, "baton"));
  f.env.FAKE_PM_JSON = JSON.stringify({ packages: [{ name: "@zhouliuya/openbaton", path: packageRoot, version: "0.9.0" }] });
  return fs.realpathSync(oldCli);
}

describe("isolated local Baton installer", () => {
  it("detects fresh installs and keeps a dry-run read-only", () => {
    const f = fixture();
    const before = fs.readdirSync(f.home);
    const result = runInstaller(f, ["--skip-install", "--skip-tests", "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /installed|fresh/i);
    assert.match(result.stdout, /build/i);
    assert.match(result.stdout, /link/i);
    assert.match(result.stdout, /init|initial/i);
    assert.deepEqual(fs.readdirSync(f.home), before);
    assert.deepEqual(logLines(f), []);
  });

  it("classifies a partial prior footprint as clean-reinstall without mutation in dry-run", () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.home, ".baton"), { recursive: true });
    fs.writeFileSync(path.join(f.home, ".baton", "partial"), "unchanged\n");
    fs.mkdirSync(path.join(f.home, ".codex", "skills", "baton"), { recursive: true });
    fs.writeFileSync(path.join(f.home, ".codex", "skills", "baton", "SKILL.md"), "existing\n");
    const result = runInstaller(f, ["--skip-install", "--skip-tests", "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /clean-reinstall/i);
    assert.match(result.stdout, /\.baton/);
    assert.match(result.stdout, /codex/i);
    assert.equal(fs.readFileSync(path.join(f.home, ".baton", "partial"), "utf8"), "unchanged\n");
    assert.deepEqual(logLines(f), []);
  });

  it("previews a supported npm scoped global registration without mutation", () => {
    const f = fixture();
    const oldCli = setupPriorNpmInstall(f);
    const oldRuntime = fs.readFileSync(path.join(f.home, ".baton", "old-runtime"));
    const result = runInstaller(f, ["--skip-install", "--skip-tests", "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /clean-reinstall/i);
    assert.match(result.stdout, /npm uninstall --global @zhouliuya\/openbaton/);
    assert.equal(fs.realpathSync(path.join(f.bin, "baton")), oldCli);
    assert.deepEqual(fs.readFileSync(path.join(f.home, ".baton", "old-runtime")), oldRuntime);
    assert.equal(logLines(f).some((line) => line.includes("npm uninstall")), false);
  });

  it("clean-reinstalls an npm scoped global registration before linking and initializing", () => {
    const f = fixture();
    setupPriorNpmInstall(f);
    const result = runInstaller(f, ["--skip-install", "--skip-tests"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /clean-reinstalled/i);
    assert.equal(fs.realpathSync(path.join(f.bin, "baton")), fs.realpathSync(path.join(f.checkout, "dist", "bin", "baton.js")));
    assert.equal(fs.existsSync(path.join(f.home, ".baton", "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(f.home, ".baton", "config.toml")), true);
    const lines = logLines(f);
    const unregister = lines.findIndex((line) => line.includes("npm uninstall --global @zhouliuya/openbaton"));
    assert.ok(unregister >= 0);
    assert.ok(lines.findIndex((line) => line === "bun link") > unregister);
    assert.ok(lines.findIndex((line) => line.startsWith("cli init")) > unregister);
    assert.ok(lines.some((line) => line === "npm ls -g --depth=0 --json --long"));
  });

  it("recognizes name-keyed Bun and npm dependency listings", () => {
    for (const manager of ["bun", "npm"] as const) {
      const f = fixture();
      if (manager === "bun") setupPriorInstall(f);
      else setupPriorNpmInstall(f);
      const packageRoot = manager === "bun"
        ? path.join(f.home, ".bun", "install", "global", "node_modules", "@zhouliuya", "openbaton")
        : path.join(f.env.FAKE_NPM_ROOT as string, "@zhouliuya", "openbaton");
      f.env.FAKE_PM_JSON = JSON.stringify({
        dependencies: { "@zhouliuya/openbaton": { version: "0.9.0", path: packageRoot } },
      });

      const result = runInstaller(f, ["--skip-install", "--skip-tests", "--dry-run"]);
      assert.equal(result.status, 0, `${manager}: ${result.stderr}`);
      assert.match(result.stdout, /clean-reinstall/i);
    }
  });

  it("treats unparseable package listings as unavailable instead of valid empty listings", () => {
    const f = fixture();
    setupPriorInstall(f);
    f.env.FAKE_PM_JSON = "not-json";

    const result = runInstaller(f, ["--skip-install", "--skip-tests", "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /clean-reinstall/i);
  });

  it("preserves the old runtime and link for dependency, check, or build failures", () => {
    for (const failure of ["install", "check", "test", "build"]) {
      const f = fixture();
      const oldCli = setupPriorInstall(f);
      const oldRuntime = fs.readFileSync(path.join(f.home, ".baton", "old-runtime"));
      f.env.FAKE_FAIL = failure;
      const result = runInstaller(f, failure === "install" ? [] : ["--skip-install"]);
      assert.notEqual(result.status, 0, `${failure} unexpectedly succeeded`);
      assert.deepEqual(fs.readFileSync(path.join(f.home, ".baton", "old-runtime")), oldRuntime);
      assert.equal(fs.realpathSync(path.join(f.bin, "baton")), oldCli);
      assert.equal(logLines(f).some((line) => line.startsWith("cli uninstall")), false);
    }
  });

  it("makes --skip-tests skip only tests while still building and safety-checking", () => {
    const f = fixture();
    setupPriorInstall(f);
    f.env.FAKE_FAIL = "test";
    const result = runInstaller(f, ["--skip-install", "--skip-tests"]);
    assert.equal(result.status, 0, result.stderr);
    const lines = logLines(f);
    assert.equal(lines.some((line) => line === "bun run test"), false);
    assert.equal(lines.some((line) => line === "bun run build"), true);
    assert.equal(lines.some((line) => line.includes("cli uninstall --clean --yes --json")), true);
    assert.equal(lines.some((line) => line.includes("bun remove") || line.includes("npm uninstall --global @zhouliuya/openbaton")), true);
    assert.equal(lines.some((line) => line === "bun link"), true);
    assert.equal(lines.some((line) => line.startsWith("cli init")), true);
    assert.equal(lines.some((line) => line.startsWith("cli version")), true);
    assert.equal(lines.some((line) => line.includes("cli uninstall --clean --dry-run --json")), true);
  });

  it("installs a partial footprint even without a visible command or package registration", () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.home, ".baton"), { recursive: true });
    fs.writeFileSync(path.join(f.home, ".baton", "partial"), "replace me\n");
    assert.equal(fs.existsSync(path.join(f.bin, "baton")), false);

    const result = runInstaller(f, ["--skip-install", "--skip-tests"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /clean-reinstalled/i);
    assert.equal(fs.realpathSync(path.join(f.bin, "baton")), fs.realpathSync(path.join(f.checkout, "dist", "bin", "baton.js")));
    assert.equal(fs.existsSync(path.join(f.home, ".baton", "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(f.home, ".baton", "config.toml")), true);
    assert.equal(fs.existsSync(path.join(f.home, ".baton", "partial")), false);
    const lines = logLines(f);
    assert.equal(lines.some((line) => line.includes("cli uninstall --clean --dry-run --json")), true);
    assert.equal(lines.some((line) => line.includes("cli uninstall --clean --yes --json")), true);
    assert.equal(lines.some((line) => line === "bun link"), true);
    assert.equal(lines.some((line) => line.startsWith("cli init")), true);
  });

  it("performs clean reinstall in prepare, uninstall, unregister, link, init, verify order", () => {
    const f = fixture();
    setupPriorInstall(f);
    const result = runInstaller(f, []);
    assert.equal(result.status, 0, result.stderr);
    const lines = logLines(f);
    const index = (needle: string) => lines.findIndex((line) => line.includes(needle));
    assert.ok(index("bun install --frozen-lockfile") >= 0);
    assert.ok(index("bun run test") > index("bun install --frozen-lockfile"));
    assert.ok(index("bun run build") > index("bun run test"));
    assert.ok(index("cli uninstall --clean --dry-run --json") > index("bun run build"));
    assert.ok(index("cli uninstall --clean --yes --json") > index("cli uninstall --clean --dry-run --json"));
    assert.ok(index("bun remove") > index("cli uninstall --clean --yes --json") || index("npm uninstall") > index("cli uninstall --clean --yes --json"));
    assert.ok(index("bun link") > index("bun remove") || index("bun link") > index("npm uninstall"));
    assert.ok(index("cli init") > index("bun link"));
    assert.ok(index("cli version") > index("cli init"));
  });

  it("blocks active tickets, conflicts, invalid state, and stale plans before package replacement", () => {
    for (const mode of ["active", "conflict", "invalid", "stale"] as PlanMode[]) {
      const f = fixture();
      const oldCli = setupPriorInstall(f);
      f.env.FAKE_PLAN_MODE = mode;
      const result = runInstaller(f, ["--skip-install", "--skip-tests"]);
      assert.notEqual(result.status, 0, `${mode} unexpectedly succeeded`);
      assert.equal(fs.realpathSync(path.join(f.bin, "baton")), oldCli);
      const lines = logLines(f);
      assert.equal(lines.some((line) => line.includes("bun remove") || line.includes("npm uninstall") || line === "bun link"), false, mode);
      assert.equal(lines.some((line) => line.includes("--clean --yes")), mode === "stale");
      if (mode === "stale") {
        assert.match(`${result.stdout}\n${result.stderr}`, /UNINSTALL_PLAN_STALE: target bytes changed/);
      }
    }
  });

  it("reports recovery guidance when fresh installation fails after linking", () => {
    const f = fixture();
    f.env.FAKE_FAIL = "init";

    const result = runInstaller(f, ["--skip-install", "--skip-tests"]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /init failed after link/);
    assert.match(`${result.stdout}\n${result.stderr}`, /Recovery \(cleanup has begun\)|repair the link/i);
    assert.equal(logLines(f).some((line) => line === "bun link"), true);
  });

  it("rejects scalar install-manifest entries through the recovery path", () => {
    const f = fixture();
    f.env.FAKE_PLAN_MODE = "malformed-manifest";

    const result = runInstaller(f, ["--skip-install", "--skip-tests"]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /installed manifest is invalid/);
    assert.match(`${result.stdout}\n${result.stderr}`, /Recovery \(cleanup has begun\)|repair the link/i);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /AttributeError/);
  });

  it("fails before mutation when clean-uninstall preflight has a malformed schema", () => {
    const f = fixture();
    const oldCli = setupPriorInstall(f);
    const oldRuntime = fs.readFileSync(path.join(f.home, ".baton", "old-runtime"));
    f.env.FAKE_PLAN_MODE = "malformed-preflight";
    const result = runInstaller(f, ["--skip-install", "--skip-tests"]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /preflight|applied|schema|omitted/i);
    assert.deepEqual(fs.readFileSync(path.join(f.home, ".baton", "old-runtime")), oldRuntime);
    assert.equal(fs.realpathSync(path.join(f.bin, "baton")), oldCli);
    const lines = logLines(f);
    assert.equal(lines.some((line) => line.includes("--clean --yes") || line.includes("bun remove") || line.includes("bun unlink") || line.includes("npm uninstall") || line === "bun link"), false);
  });

  it("fails closed for malformed remove and already-absent expected metadata", () => {
    for (const mode of ["malformed-remove", "malformed-already-absent"] as const) {
      const f = fixture();
      const oldCli = setupPriorInstall(f);
      const oldRuntime = fs.readFileSync(path.join(f.home, ".baton", "old-runtime"));
      f.env.FAKE_PLAN_MODE = mode;
      const result = runInstaller(f, ["--skip-install", "--skip-tests"]);
      assert.notEqual(result.status, 0, `${mode} unexpectedly succeeded`);
      assert.match(`${result.stdout}\n${result.stderr}`, /expected_|invalid JSON schema|preflight/i, mode);
      assert.deepEqual(fs.readFileSync(path.join(f.home, ".baton", "old-runtime")), oldRuntime);
      assert.equal(fs.realpathSync(path.join(f.bin, "baton")), oldCli);
      const lines = logLines(f);
      assert.equal(lines.some((line) => line.includes("--clean --yes") || line.includes("bun remove") || line.includes("bun unlink") || line.includes("npm uninstall") || line === "bun link"), false, mode);
    }
  });

  it("stops on a newly reported apply conflict before unregistering or relinking", () => {
    const f = fixture();
    const oldCli = setupPriorInstall(f);
    f.env.FAKE_PLAN_MODE = "apply-conflict";
    const result = runInstaller(f, ["--skip-install", "--skip-tests"]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /conflict|ownership changed/i);
    assert.match(`${result.stdout}\n${result.stderr}`, /recovery|repair the link|cleanup has begun/i);
    assert.equal(fs.realpathSync(path.join(f.bin, "baton")), oldCli);
    const lines = logLines(f);
    assert.equal(lines.some((line) => line.includes("bun remove") || line.includes("bun unlink") || line.includes("npm uninstall") || line === "bun link"), false);
  });

  it("fails closed for an ambiguous executable without deleting it or runtime state", () => {
    const f = fixture();
    const oldCli = setupPriorInstall(f, { ambiguous: true });
    const result = runInstaller(f, ["--skip-install", "--skip-tests"]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /ambiguous|provenance|ownership|recogniz/i);
    assert.equal(fs.realpathSync(path.join(f.bin, "baton")), oldCli);
    assert.equal(fs.existsSync(path.join(f.home, ".baton", "old-runtime")), true);
    assert.equal(logLines(f).some((line) => line.includes("--clean")), false);
  });

  it("relinks, initializes non-interactively, restores host skills, and leaves profiles empty", () => {
    const f = fixture();
    setupPriorInstall(f);
    fs.writeFileSync(path.join(f.home, "unrelated.txt"), "do not touch\n");
    const result = runInstaller(f, ["--skip-install", "--skip-tests"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /clean-reinstalled/i);
    assert.match(result.stdout, /1\.0\.0/);
    assert.match(result.stdout, /command|target|checkout/i);
    assert.equal(fs.realpathSync(path.join(f.bin, "baton")), fs.realpathSync(path.join(f.checkout, "dist", "bin", "baton.js")));
    assert.deepEqual(fs.readFileSync(path.join(f.home, ".baton", "SKILL.md")), fs.readFileSync(path.join(f.checkout, "SKILL.md")));
    assert.equal(fs.existsSync(path.join(f.home, ".baton", "adapters", "codex", "adapter.json")), true);
    assert.equal(fs.existsSync(path.join(f.home, ".baton", "adapters", "grok", "adapter.json")), true);
    assert.equal(fs.existsSync(path.join(f.home, ".codex", "skills", "baton", "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(f.home, ".grok", "skills", "baton", "SKILL.md")), true);
    const config = fs.readFileSync(path.join(f.home, ".baton", "config.toml"), "utf8");
    assert.match(config, /^cli = \{\}$/m);
    assert.doesNotMatch(config, /\[cli\./);
    assert.equal(fs.readFileSync(path.join(f.home, "unrelated.txt"), "utf8"), "do not touch\n");
    const lines = logLines(f);
    assert.equal(lines.some((line) => line.includes("init-stdin=\"\"")), true);
  });

  it("does not touch unrelated checkout files during a fresh install", () => {
    const f = fixture();
    const unrelated = path.join(f.checkout, "operator-notes.txt");
    fs.writeFileSync(unrelated, "operator data\n");
    const before = fs.readFileSync(unrelated);
    const result = runInstaller(f, ["--skip-install", "--skip-tests"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(unrelated), before);
  });
});
