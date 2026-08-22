# CodexBar quota helper (not on the Codex model path)

The Codex CLI adapter obtains picker-visible models only from Codex app-server
`model/list`. It does not consult CodexBar for model discovery or callability.
The existing CodexBar reader is retained as an optional sanitized quota helper
for future CLI adapters that expose provider identities.

## Precedence

1. A selected CLI's provider report with at least one percentage window.
2. CodexBar GUI widget snapshot, then local CodexBar history.
3. Installed and callable local CodexBar CLI, only when the GUI has no usable window for that provider.
4. Explicit `unknown` with a machine-readable reason.

A CodexBar result never overwrites a CLI-reported quota. This is quota-source
fallback only; it is not model discovery, callability evidence, or a routing
fallback.

## Discovery and invocation

Baton first reads the newest macOS CodexBar widget snapshot:

- `~/Library/Group Containers/*.com.steipete.codexbar/widget-snapshot.json`

If that file has no usable window for the missing provider, it reads the latest local history row:

- `~/Library/Application Support/com.steipete.codexbar/history/<provider>.json`

Only after both local GUI sources miss does it look for `codexbar`/`CodexBar` on `PATH`, then the standard macOS app helpers:

- `/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI`
- `~/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI`

and invoke a bounded machine-readable query equivalent to:

```text
codexbar usage --provider PROVIDER --format json --json-only --no-color --web-timeout 10
```

Provider id `openai` maps to CodexBar `codex`; hyphens are ignored when matching
GUI ids such as `alibabatokenplan`. Other safe provider IDs pass through
unchanged. No `--all-accounts` or login/configuration command is used. Multiple
reported CLI accounts are treated as ambiguous rather than selecting one
silently.

## Persisted fields

Baton extracts only:

- provider;
- observed time;
- used and remaining percentage;
- reset time;
- sanitized window label;
- source such as `codexbar:codex:oauth`, `codexbar:mimo:widget`, or `codexbar:alibaba-token-plan:history`.

It intentionally discards account email/ID, login method, cookies, tokens, credentials, credits, raw output, and raw errors. CodexBar provider errors become stable reasons such as `CODEXBAR_PROVIDER_UNAVAILABLE`; malformed output, invocation failure, and multiple accounts also remain explicit unknown states.

CodexBar may represent the account selected in that local app and is therefore
informational provenance. The selected CLI continues to own model identity and
the host continues to own execution.
