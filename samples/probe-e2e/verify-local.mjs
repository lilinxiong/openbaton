#!/usr/bin/env bun

import assert from "node:assert/strict";
import { formatLabel } from "./src/utils/format.js";
import { isNonEmpty } from "./src/utils/validate.js";
import { runSmoke } from "./src/index.js";

assert.equal(formatLabel("  hello "), "HELLO");
assert.equal(isNonEmpty(" x "), true);
assert.equal(isNonEmpty("   "), false);
assert.deepEqual(runSmoke(), { ok: true });

process.stdout.write("probe-e2e local verify: ok\n");
