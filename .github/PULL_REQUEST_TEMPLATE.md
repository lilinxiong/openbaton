## Summary

<!-- What changed, and why. Name the surface: core, adapter, docs, or sample. -->
<!-- Title: conventional (`feat:`, `fix:`, `docs:`, `chore:`) so the type labeler can classify it. -->

-

## Verification

<!-- Commands you actually ran. `bun run test` is the default for code. Docs-only can skip it. -->

- [ ] `bun run test`

## Checklist

- [ ] Scope is one change. No drive-by cleanup.
- [ ] User-facing docs stay bilingual: `README.md` and `README.zh.md` (and the matching `docs/*.zh.md` / `samples/**/README.zh.md`) when those pages changed.
- [ ] Architecture HTML under `docs/architecture/*.html` was left alone unless this PR is specifically about those diagrams.
- [ ] Adapter / catalog / routing changes use live catalog ids only. No invented models, flags, or classifications.
- [ ] Ticket, `BATON_SESSION_ID`, or capacity changes say how the root-agent tree is affected.
