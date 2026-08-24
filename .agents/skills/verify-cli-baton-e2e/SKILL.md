---
name: verify-cli-baton-e2e
description: Run the fixed OpenSpec coding probe after add-cli-to-baton to verify init/config, director apply routing, parallel native subagents, and cleanup. Use when a new host adapter is registered and you need end-to-end Baton proof in a clean worktree context.
---

# Verify CLI Baton E2E

Run **after** `/add-cli-to-baton` reports adapter `PASS`. Prove the target host can execute a real OpenSpec coding change through Baton apply: plan → filter → scoped dispatch → parallel native subagents → verify → archive → cleanup.

Unless the user names a different target, treat the **invoking CLI** as `<target>`. In Cursor, `/verify-cli-baton-e2e` alone is enough — do not require `cursor` on the command line. Resolve with `baton host detect --json`, runtime env signals, or `BATON_HOST` when ambiguous.

The user runs **only this skill** in the orchestration chat. It owns bootstrap, apply handoff, verify, archive, and cleanup instructions. The user does **not** separately invoke `/openspec-apply-change` from the orchestration chat; that happens once in a **fresh chat** opened on the probe worktree (see step 3).

The probe template lives in `samples/probe-e2e/` (tracked in git). It is **not** placed in the repo-root `openspec/` directory, which is gitignored.

## Preconditions

1. Working tree is the OpenBaton repository.
2. Phase 1 adapter work is complete: registry, runtime skill, tests, and read-only live ticket passed.
3. `baton`, `openspec`, and `bun` are on `PATH`.
4. `cli.<target>.enabled` is true with a non-empty `subagent_models` allowlist for the target under test.

Record baseline: `git status`, `baton version`, `baton config --cli <target>`.

## Director/worker boundary during apply

When the user applies the probe in a fresh chat, the target runtime Baton skill intercepts `/openspec-apply-change`. The director MUST NOT implement executable tasks. Follow the host skill:

- `baton apply probe-e2e --host <target> --json`
- filter the ready frontier (`--write-path` / `--read-only`)
- one scoped `baton apply ... --dispatch --json --unit ... --write-path ...`
- native-spawn every reserved ticket in the same turn, bind, wait, release, refill

Do not rewrite OpenSpec apply skills.

## Workflow

### 1. Confirm init/config

Verify non-interactive config works for the target:

```bash
baton config --cli <target>
baton models --host <target>
```

Confirm the catalog comes from the target CLI, the profile is host-scoped, and disable would fail closed for explicit host operations.

### 2. Bootstrap the probe worktree

From the repository root:

```bash
bun samples/bootstrap-probe.mjs --host <target> --worktree ../openbaton-probe-<target>
```

This creates a git worktree, copies the fixed `samples/probe-e2e/` template, commits a baseline, and strict-validates change `probe-e2e`.

If the worktree path or branch already exists from a failed run, remove it first:

```bash
git worktree remove ../openbaton-probe-<target> --force
git branch -D probe/<target>-e2e
```

### 3. Hand off to a fresh chat

Print or relay the bootstrap output. The apply chat must:

- use the probe **worktree** as its working directory (clean conversation context)
- run `/openspec-apply-change probe-e2e`
- pass `REQUEST.txt` unchanged (no Baton/subagent/model words)

Expected probe shape:

- **Wave 1 (parallel):** tasks `1.1` → `src/utils/format.js`, `1.2` → `src/utils/validate.js`
- **Wave 2 (serial):** task `2.1` → `src/index.js`

### 4. Verify

After apply completes in the probe worktree:

```bash
bun samples/verify-probe.mjs --host <target> ../openbaton-probe-<target>
```

The verifier checks Baton ticket lifecycle, OpenSpec task writeback, implementation files, `openspec validate --strict`, and `bun verify-local.mjs`.

### 5. On failure — reset and retry

Classify the failure:

| Symptom | Likely fix |
|---------|------------|
| routing/dispatch/leak/model/host mismatch | adapter or runtime skill in Phase 1 |
| probe spec ambiguity | `samples/probe-e2e/` template |
| auth/quota/permission | external `BLOCKED`; stop and report next action |

Reset the probe worktree:

```bash
git -C ../openbaton-probe-<target> reset --hard
```

Clear leaked tickets if needed (`baton status`, close/release). Retry bootstrap through verify. Cap retries at three attempts before reporting `REVISE`.

### 6. On success — archive and cleanup

In the probe worktree chat:

```text
/openspec-archive-change probe-e2e
```

Then from the OpenBaton repository:

```bash
git worktree remove ../openbaton-probe-<target>
git branch -D probe/<target>-e2e
```

Audit the main repository: only Phase 1 adapter changes may remain. Do not commit unless the user separately requests it.

## Completion contract

Claim `PASS` only when all of the following are true:

- bootstrap strict validation succeeded;
- apply ran in a clean probe worktree through the target runtime skill;
- three OpenSpec tasks completed with conclusions and bound native subagent tickets;
- wave 1 ran in parallel (two tasks), wave 2 ran after section 1;
- `verify-probe.mjs` exited zero;
- archive completed;
- probe worktree removed;
- main OpenBaton worktree has no probe artifacts or leaked tickets.

Report evidence separately: init/config, bootstrap, apply handoff, verify output, archive, cleanup audit.

## Terminal outcomes

- **PASS**: full probe E2E succeeded and probe workspace was removed.
- **REVISE**: repository-controlled failure; fix adapter or template and retry.
- **BLOCKED**: external condition (auth, quota, missing openspec); state the exact next action.
