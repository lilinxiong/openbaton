#!/usr/bin/env node
import { run } from "../src/cli.js";

const code = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
});
// Do not force-exit while a large model-selection disclosure is still queued
// on stdout/stderr. Setting exitCode lets Node/Bun flush both streams first.
process.exitCode = code;
