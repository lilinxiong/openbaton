---
name: install-local-baton
description: Install or update Baton from an OpenBaton source checkout onto the local machine. Use after cloning this repository, when the user asks to install Baton locally, set up a development checkout, link the repo to PATH, refresh shared runtime files, or update an existing local Baton.
---

# Install or update local Baton

Link this OpenBaton checkout, build it, and refresh the user's global Baton
files under `~/.baton`. A source checkout and an existing installation use the
same sequence: build, `bun link`, then `baton update`.

## Preconditions

1. Confirm the working directory is the repository root and that
   `package.json` identifies the OpenBaton package.
2. Require Node.js 22.5 or newer and Bun on `PATH`.
3. Require `python3` for the repository installer.

Do not modify unrelated files, credentials, Git configuration, or adapter
profiles beyond the files normally refreshed by `baton update`.

## Inspect the current installation

Record before changing anything:

- `node -v` and `bun --version`;
- whether `baton` is on `PATH` and its resolved path;
- `baton version`, when available;
- whether `~/.baton/config.toml` exists;
- whether shared or adapter runtime skills are already installed.

Use this only to report whether the result is an installation or an update.

## Run the installer

From the repository root:

```bash
python3 scripts/update_local_baton.py
```

The script installs the lockfile dependencies, runs checks, builds the package,
links `baton`, runs `baton update`, and performs a version smoke check. If the
user explicitly accepts omitted tests, the faster form is:

```bash
python3 scripts/update_local_baton.py --skip-tests
```

Use `--dry-run` only to display commands. If a step fails, fix the concrete
repository-local issue and retry once. Do not replace a source checkout with a
different installation mechanism.

## Initialize adapters

`baton update` refreshes files that already exist. On a new machine, run:

```bash
baton init
```

Then select and enable an adapter from its manifest:

```bash
baton config --cli <adapter-id> --enable
```

Do not run interactive configuration unless the user asks. Adapter catalog and
profile choices remain user-owned.

## Verify and report

Confirm that:

- `command -v baton` resolves to this checkout's `dist/bin/baton.js`;
- `baton version` succeeds;
- `baton update` reports refreshed shared files;
- no unrelated adapter profile or user file changed.

Report installed or updated, repository path, linked command path, version,
whether `baton init` ran, and the next configuration command. Do not commit or
publish as part of installation.
