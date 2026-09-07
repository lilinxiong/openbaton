# Samples

Start with [getting-started](getting-started/README.md). Its walkthrough uses the in-repository fake adapter in an isolated temporary HOME. It exercises `init`, `config`, `models`, `match`, `spawn`, `record`, and `status`; it does not start a real worker or call a paid model.

`manifest-example/` demonstrates the public adapter manifest, catalog command, native handle kind, and runtime skill. It is a deterministic fixture, not a live CLI integration. `spawn` only emits a native handoff payload with `spawned: false`; the host owns execution.

See [EXPECTED.md](EXPECTED.md) for the exact acceptance shape.
