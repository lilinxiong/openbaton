#!/usr/bin/env bun

/**
 * Isolated newcomer walkthrough: init, config, match, spawn, dispatch.
 * Uses samples/manifest-example (sample-adapter). No paid host.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const adapter = path.join(repoRoot, "samples", "manifest-example");
const batonEntry = path.join(repoRoot, "bin", "baton.ts");
const sessionId = "getting-started-session";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-getting-started-home-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "baton-getting-started-work-"));
const env = {
  ...process.env,
  HOME: home,
  BATON_ADAPTER_PATHS: adapter,
  BATON_SESSION_ID: sessionId,
};
delete env.BATON_HOST;

function baton(args, cwd = work) {
  const printable = ["baton", ...args].join(" ");
  process.stdout.write(`\n$ ${printable}\n`);
  const result = spawnSync("bun", [batonEntry, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${printable} exited ${result.status}`);
  }
  return result.stdout;
}

execFileSync("git", ["init", "-q"], { cwd: work });
fs.writeFileSync(path.join(work, "README.md"), "demo\n");
execFileSync("git", ["add", "README.md"], { cwd: work });
execFileSync("git", ["-c", "user.email=gs@example.invalid", "-c", "user.name=GS", "commit", "-qm", "init"], { cwd: work });

process.stdout.write(`HOME=${home}\nWORK=${work}\nADAPTER=${adapter}\n`);

baton(["init", "--cli", "sample-adapter"], repoRoot);
baton(["config", "--cli", "sample-adapter", "--runner", "sample-model", "--longctx", "sample-model", "--coding-model", "sample-model"], repoRoot);
baton(["models", "refresh", "--host", "sample-adapter"], repoRoot);
const matchOut = baton(["match", "tiny typo in one file", "--host", "sample-adapter"], repoRoot);
if (!matchOut.includes("sample-model")) {
  throw new Error("match did not select sample-model");
}

const spawnOut = baton([
  "spawn", "tiny typo in one file",
  "--host", "sample-adapter",
  "--classification", "mechanical",
  "--write-path", "README.md",
  "--json",
], work);
const spawned = JSON.parse(spawnOut);
const ticket = spawned.dispatched?.[0]?.ticket?.id;
if (!ticket) throw new Error("spawn did not return a ticket id");
process.stdout.write(`ticket=${ticket}\n`);

const reserved = JSON.parse(baton(["dispatch", "next", "--host", "sample-adapter", "--json"], work));
if (reserved.reserved?.[0]?.ticket_id !== ticket) {
  throw new Error("dispatch next reserved a different ticket");
}

baton(["dispatch", "bind", ticket, "--execution-handle", "sample-native-task=demo-1", "--host", "sample-adapter", "--json"], work);
const done = JSON.parse(baton(["dispatch", "complete", ticket, "--host", "sample-adapter", "--text", "fixed the typo", "--release", "--json"], work));
if (done.ticket?.status !== "completed") {
  throw new Error(`expected completed, got ${done.ticket?.status}`);
}

const status = JSON.parse(baton(["dispatch", "status", "--host", "sample-adapter", "--json"], work));
if (status.active !== 0) throw new Error(`expected active 0, got ${status.active}`);
process.stdout.write("\ngetting-started walkthrough ok\n");
