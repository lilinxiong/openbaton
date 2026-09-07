---
name: add-cli-to-baton
description: Add the invoking CLI through OpenBaton's public Adapter SDK, manifest, and native handoff conformance path.
---

# Add a CLI through the Adapter SDK

Use this skill when adding a host-native adapter with model discovery and exact-model handoffs. Baton 2.0 never dispatches a child itself.

## Contract

1. Define an adapter package with an `adapter.json` manifest and the public SDK.
2. Make the catalog command return the adapter id and exact picker-visible model ids.
3. Keep executable discovery, catalog normalization, and adapter-specific metadata inside the adapter. Native execution, waiting, cancellation, and release are host-owned APIs.
4. Declare the runtime skill path and native handle kind in the manifest; runtime skill is required.
5. Run SDK conformance, isolated package checks, manifest discovery, and catalog checks.

The CLI surface is `init`, `config`, `models`, `match`, `spawn`, `record`, and `status`. `match` selects a host/model/work mode from the live catalog. `spawn --brief FILE` returns a structured payload with `host`, `model_id`, `prompt`, `scope`, `mode`, and `spawned: false`; it does not create tickets, receipts, sessions, reservations, or a native process. The host performs native execution and may later call `record` with its opaque handle.

A brief contains `goal`, `decisions`, `scope`, `acceptance`, `context`, `constraints`, and `mode` (`read-only` or `write`). Preserve the selected model and prompt exactly when handing off. Keep live execution and paid-model acceptance outside the sample walkthrough; use the fake adapter for deterministic checks.

Read [references/openbaton-contract.md](references/openbaton-contract.md), [references/capability-probes.md](references/capability-probes.md), and [references/acceptance.md](references/acceptance.md) for adapter boundaries and evidence requirements.
