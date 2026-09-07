# Baton 2.0 acceptance — 2026-09-07

> Historical acceptance record for the original v2 delivery (config schema 3). Current configuration and effort semantics are documented in the guides.

The user approved the five-batch implementation, a clean local reinstall without backup after the first two batches, and breaking removal of the managed runtime. This is an implementation and acceptance record, not a token-cost or performance benchmark.

## Code reduction

Counted newline-delimited lines in tracked production `src/**/*.ts`, excluding tests, generated `dist`, samples and documentation:

| | Before (`28a7dfb`) | V2 |
|---|---:|---:|
| Production TypeScript files | 61 | 22 |
| Production TypeScript lines | 13,376 | 2,961 |

Production TypeScript is reduced by 77.9%. This removes control-plane responsibilities; remaining source is formatted for readability. Removed tests covered removed behavior; replacement tests cover the native contract and retained installation boundaries.

## Evidence

- First two batches: 234 tests passed, one existing large OS-pipe stress test skipped, zero failures; committed before cleanup.
- The old global installation, configuration, state, adapters and generated Codex/Cursor/Grok Baton skills were deleted without backup. Source checkouts were preserved. The current checkout was linked and installed before batch three.
- The installed skill was loaded before batch three; work was delegated to actual Codex native subagents using separate model/effort choices (Luna low, Terra medium, Sol medium).
- Final installer: dependency installation, TypeScript checking, 31 tests, build, link, runtime update and version smoke check passed.
- The isolated walkthrough covers init/config/models/match/spawn/record/status, handoff preservation, absence of retired state directories and temporary-directory cleanup. Its host result is explicitly simulated; it executes no paid worker.
- Real Codex catalog discovery and installed `spawn --brief` selection returned the exact requested model and effort with `spawned:false`.
- Three actual completed native worker outcomes were recorded and retrieved with the installed record/status commands. These records reflect host outcomes; they do not establish a second execution lifecycle.
- Installed shared skill, Codex runtime skill and adapter manifest were byte-compared with this checkout. The command link resolves to this checkout's `dist/bin/baton.js`, version 2.0.0. Retired local cache/workspace/rollback directories and Cursor/Grok Baton skills are absent.
- The local OpenSpec change `simplify-host-native-delegation` passes strict validation. OpenSpec remains local because this repository ignores `openspec/**`.

## Boundaries

Scope is a worker prompt contract, not filesystem isolation. Catalog capacity can be unknown and is disclosed. Host-provided unavailable models are exclusions, not a quota monitor. The native host owns launch, capacity, cancellation and completion. No cross-CLI task runner or managed compatibility runtime is retained.
