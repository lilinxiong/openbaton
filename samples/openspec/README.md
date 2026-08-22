# OpenSpec incident audit

This sample contains a strict-valid `incident-audit` change with five stable tasks. Feed the ordinary business request in `REQUEST.txt` unchanged from the current Codex task.

The audit is read-only except for the expected OpenSpec conclusion writeback to `openspec/changes/incident-audit/tasks.md`.

Expected interaction: the director creates one five-task proposal, deterministically selects exact model/reasoning-effort candidates from the enabled CLI allowlist, automatically approves those recommendations, and reserves all five tickets together. The four evidence tasks and the priority task are independent and must run in parallel. No model selector or user confirmation is involved.
