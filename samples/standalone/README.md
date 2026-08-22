# Standalone incident audit

This sample has no `openspec/` directory. Feed the ordinary business request in `REQUEST.txt` unchanged from the current Codex task.

The audit is read-only:

- `incidents.json`: frozen incident snapshot and cutoff.
- `policy.json`: acknowledgement and resolution targets.
- `REQUEST.txt`: user-facing request; it intentionally does not name Baton or subagents.

Expected interaction: the director creates one five-unit request-level proposal, deterministically selects exact model/reasoning-effort candidates from the enabled Codex allowlist, automatically approves those recommendations, and creates tickets. No model selector or user confirmation is involved.
