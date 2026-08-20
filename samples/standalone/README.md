# Standalone incident audit

This sample has no `openspec/` directory. Open `REQUEST.txt` and send its ordinary business request from a new Codex task.

The audit is read-only:

- `incidents.json`: frozen incident snapshot and cutoff.
- `policy.json`: acknowledgement and resolution targets.
- `REQUEST.txt`: user-facing request; it intentionally does not name Baton or subagents.

Expected interaction: the director automatically proposes models before creating tickets. Verify that `gpt-5.5`, `gpt-5.6-sol`, and `gpt-5.6-terra` are disclosed as built-in family exclusions and never appear as candidates. Review the remaining strengths, task/AA scores, quota/unknown reasons, and callability; change or manually select at least one exact candidate, and use two providers when two are callable. Then confirm once.
