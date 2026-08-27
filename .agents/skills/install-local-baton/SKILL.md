---
name: install-local-baton
description: Install or update Baton from an OpenBaton source checkout onto the local machine. Use after cloning this repository, when the user asks to install Baton locally, set up a dev checkout, link the repo to PATH, refresh skills and config from the checkout, or update an existing local Baton to match the latest repository build. Triggers include install local baton, setup baton, bun link, update local baton, 安装 baton, 更新 baton.
---

# Install or update local Baton

Link this OpenBaton checkout to the machine, build it, and refresh the user's global Baton files (`~/.baton` and host runtime skills) from the repository. Baton is hookless.

Fresh clone and existing install use the same path: build, `bun link`, then `baton update`.

## Preconditions

1. Confirm the working tree is the OpenBaton repository root (`package.json` name is `@zhouliuya/openbaton`).
2. Require **Node.js 22.5+** and **Bun** on `PATH`. If either is missing, stop and tell the user how to install them.
3. Require **python3** to run the repository installer script.

Do not modify unrelated user files, git config, credentials, or `~/.baton` model selections beyond what `baton init` / `baton update` normally write.

## Detect current state

Before changing anything, record:

- `node -v`
- `bun --version`
- whether `baton` is already on `PATH` (`command -v baton`) and its resolved path
- if present, `baton version`
- whether `~/.baton/config.toml` exists

Use this only to choose the completion message (`installed` vs `updated`). Do not branch into a different install mechanism.

## Run the repository installer

From the repository root, run:

```bash
python3 scripts/update_local_baton.py
```

This script:

1. `bun install --frozen-lockfile`
2. `bun run test`
3. `bun run build`
4. `bun link` so global `baton` points at this checkout's `dist/bin/baton.js`
5. `baton update` to refresh global skills, config defaults, and host runtime skills
6. `baton version` as a smoke check

If the user explicitly asks for a faster dev loop and accepts skipping verification, rerun with:

```bash
python3 scripts/update_local_baton.py --skip-tests
```

Use `--dry-run` only to show planned commands; do not treat it as completion.

If the script fails:

- Read the stderr message and fix the concrete blocker (missing tool, failed test, build error, or `baton` not resolving to this checkout after `bun link`).
- Retry once after fixing repository-local issues.
- Do not fall back to `npm install -g @zhouliuya/openbaton`; this skill is for **source checkout** development, not the published package.

## First-time initialization

`baton update` refreshes files that already exist; it does not install host runtime skills on a completely fresh machine.

After the installer succeeds, if **either** is true:

- `~/.baton/config.toml` was missing before the run, or
- no host runtime skill files exist yet under the user's home (for example `~/.codex/skills/baton/SKILL.md`, `~/.cursor/skills/baton/SKILL.md`, or the Grok equivalent),

run once:

```bash
baton init
```

If the invoking host is known and the user has not configured Baton yet, suggest the matching non-interactive bootstrap when appropriate, for example:

```bash
baton init --cli cursor
baton config --cli cursor --enable
```

Do not run interactive `baton config` unless the user asks.

## Verify and report

Confirm all of the following:

- `command -v baton` resolves to this checkout's built CLI (`dist/bin/baton.js` under the repo root)
- `baton version` succeeds
- `baton update` output shows refreshed global files

Report a short summary:

- **installed** or **updated**
- repository path
- linked `baton` command path
- version string
- whether `baton init` ran
- next step for the user: run `baton config` (or `baton models refresh`) if models are not configured yet

## Red lines

- Do not commit, push, or edit unrelated repository code while installing.
- Do not overwrite the user's CLI model allowlists or enabled-host choices except through normal `baton update` default merging.
- Do not claim success if `baton` on `PATH` still points at a different installation than this checkout.
