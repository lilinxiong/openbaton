# Sample adapter runtime

The host owns native execution, waiting, cancellation, and release. Baton only discovers the catalog, selects an exact model, and formats a handoff.

Use `baton match --host sample-adapter --work-mode implementation --json` to inspect selection. Build a brief JSON with `goal`, `decisions`, `scope`, `acceptance`, `context`, `constraints`, and `mode`; call `baton spawn --brief FILE --host sample-adapter --json`. Preserve `host`, `model_id`, `prompt`, `scope`, and `mode`; the result always has `spawned: false`. Pass the opaque native handle to `baton record` after the host completes and inspect it with `baton status`.

This fixture has no real worker and must not claim paid-model or runtime execution evidence.
