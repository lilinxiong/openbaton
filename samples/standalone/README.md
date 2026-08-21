# Standalone incident audit

This sample has no `openspec/` directory. Feed the ordinary business request in `REQUEST.txt` unchanged from the current Codex task.

The audit is read-only:

- `incidents.json`: frozen incident snapshot and cutoff.
- `policy.json`: acknowledgement and resolution targets.
- `REQUEST.txt`: user-facing request; it intentionally does not name Baton or subagents.

Expected interaction: the director automatically creates one five-unit request-level proposal before creating tickets. When paired with the OpenSpec sample, both proposals appear in one selector with one global Provider control and one Submit. Verify that `gpt-5.5`, `gpt-5.6-sol`, and `gpt-5.6-terra` are disclosed as built-in family exclusions and never appear as candidates. Review the remaining strengths, task/AA scores, quota/unknown reasons, and callability; change or manually select at least one exact candidate, and use two providers when two are callable. Then submit once for both paths.
