#!/usr/bin/env node
import { run } from "../src/cli.js";

const code = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
});
// Let Node/Bun flush queued stdout/stderr before terminating the process.
process.exitCode = code;
