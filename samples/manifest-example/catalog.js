#!/usr/bin/env node

process.stdout.write(JSON.stringify({
  adapter_id: "sample-adapter",
  version: "1.0.0",
  models: [{
    id: "sample-model",
    display_name: "Sample Model",
    description: "A deterministic catalog fixture.",
    hidden: false,
    reasoning_efforts: [{ id: "low", description: "Short reasoning pass." }],
    default_reasoning_effort: "low",
    input_modalities: ["text"],
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    is_default: true,
  }],
}));
