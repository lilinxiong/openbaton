#!/usr/bin/env bun

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const standaloneDir = path.join(root, "standalone");
const alphaPath = path.join(standaloneDir, "alpha.js");
const betaPath = path.join(standaloneDir, "beta.js");
assert(fs.existsSync(alphaPath), "missing standalone/alpha.js");
assert(fs.existsSync(betaPath), "missing standalone/beta.js");
assert.deepEqual(fs.readdirSync(standaloneDir).sort(), ["alpha.js", "beta.js"]);

const alpha = await import(pathToFileURL(alphaPath).href);
const beta = await import(pathToFileURL(betaPath).href);
assert.deepEqual(Object.keys(alpha), ["alpha"]);
assert.deepEqual(Object.keys(beta), ["beta"]);
assert.equal(alpha.alpha, "alpha");
assert.equal(beta.beta, "beta");

process.stdout.write("probe-e2e standalone verify: ok\n");
