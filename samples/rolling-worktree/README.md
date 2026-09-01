# Rolling isolated-worktree example

Run this example from the root of a clean Git repository after configuring an
adapter that declares `native.exact_execution_root=true`.

```bash
export BATON_SESSION_ID="rolling-sample"
baton models refresh --host codex
baton run start --host codex \
  --source-file samples/rolling-worktree/source.json \
  --plan-delta-file samples/rolling-worktree/delta.json \
  --run-id rolling-sample --dispatch --json
baton run rolling-sample --status --json
```

The delta intentionally omits `worktree_mode`: Baton persists
`isolated-worktree` on its writing unit, prepares only the selected frontier,
and returns an exact-root ticket. After the native worker is bound, completed,
and released, freeze and integrate the audited result using values from status:

The first native launch may hold later tickets at `ROUTE_PROBE_PENDING` until the route reports one live probe; once proven, remaining capacity refills normally.

```text
baton run rolling-sample --freeze-unit sample-write --attempt attempt-1 --text "sample result audited" --validation "sample validation passed" --json
baton integration begin --run rolling-sample --repository-id <sha256> --bundle-id <bundle> --expected-before-tree <tree> --json
baton integration apply --run rolling-sample --repository-id <sha256> --bundle-id <bundle> --json
baton integration accept --run rolling-sample --repository-id <sha256> --bundle-id <bundle> --conclusion "sample result accepted" --json
baton run rolling-sample --cleanup-unit sample-write --attempt attempt-1 --json
```

If `apply` reports conflicts, the parent creates a resolved Git tree inside its
authorized integration boundary, submits it with `integration resolve`, and
then calls `accept`. Never ask the worker to merge or resolve.
