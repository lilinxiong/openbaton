# Manifest sample acceptance

- Discovery reads only `manifest-example/adapter.json`.
- The manifest validates as schema `1` and uses SDK version `1.0`.
- The catalog response has the matching `adapter_id`, a version, and an exact
  `models` array.
- Configuration writes only `[cli.sample-adapter]` for the selected package.
- The configured `coding_models` order is preserved for automatic selection.
- A ticket includes `session_id`, `session_uid`, `session_ordinal`,
  `ticket_id`, selected model/options, an immutable Receipt, and a reservation.
- Native execution returns an opaque handle that is bound immediately and used
  for activity, terminal recording, and release.
- Capacity backpressure keeps the same reservation and model.
- Explicit quota exhaustion can create a new immutable successor ticket only
  after a clean write baseline. The successor has a new session ordinal,
  `successor_from_ticket_id`, a new Receipt, and the same session, host, scope,
  and quota lineage.
- No real service credentials or built-in catalog entries appear in the sample.
