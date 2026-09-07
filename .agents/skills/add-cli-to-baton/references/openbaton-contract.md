# OpenBaton 2.0 contract

Adapters expose a manifest with stable identity, catalog command/protocol, required runtime-skill source/destination, and native execution-handle kind. Catalog output preserves exact model ids and optional metadata. Baton commands are `init`, `config`, `models`, `match`, `spawn`, `record`, and `status`.

A worker brief has `goal`, `decisions`, `scope`, `acceptance`, `context`, `constraints`, and `mode`. `spawn` returns host, exact model, formatted prompt, scope, mode, `fork_context:false`, and `spawned:false`. It does not create managed state or launch a process. The host owns native execution and keeps its opaque handle; `record` stores terminal status and `status` reads the local ledger.
