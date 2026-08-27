import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { discoverAdapterManifests } from "../src/adapters/sdk.js";

const fixtures = path.join(process.cwd(), "test", "fixtures", "adapters");

describe("generic adapter write dispatch contract", () => {
  it("keeps successor decisions adapter-neutral", () => {
    const manifests = discoverAdapterManifests({ BATON_ADAPTER_PATHS: `${fixtures}/alpha${path.delimiter}${fixtures}/beta` });
    assert.deepEqual(manifests.map((item) => item.adapter.id), ["alpha", "beta"]);
    assert.deepEqual(manifests.map((item) => item.native.execution_handle_kind), ["alpha-task", "beta-session"]);
  });

  it("requires manifest-declared generic execution handles", () => {
    const manifests = discoverAdapterManifests({ BATON_ADAPTER_PATHS: `${fixtures}/alpha` });
    assert.match(manifests[0]?.native.execution_handle_kind || "", /^[a-z][a-z0-9._-]*$/);
  });
});
