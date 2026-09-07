#!/usr/bin/env node
process.stdout.write(JSON.stringify({ adapter_id: "beta", version: "beta-fixture-2", models: [{ id: "beta-model", model: "beta-model", display_name: "Beta Model", hidden: false, service_tiers: [{ id: "standard", name: "Standard" }] }] }));
