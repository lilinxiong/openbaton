# Baton probe E2E (coding)

Fixed OpenSpec change `probe-e2e` for post-adapter end-to-end verification.

- Section 1: two independent implement tasks (`format.js`, `validate.js`) — parallel
- Section 2: one integration task (`index.js`) — serial after section 1

Bootstrap copies this template into an isolated git worktree. The change lives under
`samples/probe-e2e/openspec/`, not the repo-root `openspec/` directory (gitignored).

After apply, run:

```bash
bun samples/verify-probe.mjs [--host cursor] WORKSPACE
```
