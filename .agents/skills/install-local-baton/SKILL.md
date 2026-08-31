---
name: install-local-baton
description: Fresh-install or clean-reinstall Baton from an OpenBaton source checkout onto the local machine. Use after cloning this repository, when the user asks to install Baton locally, set up a development checkout, link the repo to PATH, or replace an existing local Baton installation.
---

# Fresh-install or clean-reinstall local Baton

Link this OpenBaton checkout and install it into the user's global Baton
namespace under `~/.baton`. The installer detects whether this is fresh or an
existing installation and selects the corresponding safe plan automatically.

## Preconditions

1. Confirm the working directory is the repository root and that
   `package.json` identifies the OpenBaton package.
2. Require Node.js 22.5 or newer and Bun on `PATH`.
3. Require `python3` for the repository installer.

Do not modify unrelated files, credentials, or Git configuration. Only the
selected plan's declared Baton-owned targets may change; a clean plan may
remove those targets, including Baton-owned config and registrations. The
user's profile is owned by `~/.baton/config.toml`; configuring one host must
not silently rewrite profiles for other hosts.

## Inspect the current installation

Record before changing anything:

- `node -v` and `bun --version`;
- whether `baton` is on `PATH` and its resolved path;
- `baton version`, when available;
- whether `~/.baton/config.toml` exists;
- whether shared or adapter runtime skills are already installed.

Use this to report whether the result is a fresh installation or a clean
reinstall. Installation mode is based on the visible `baton` command, the
`~/.baton` home, and registered host-skill footprints. A missing `baton`
command is therefore not proof that the machine is fresh. When a visible
`baton` command exists, the installer additionally validates its supported
Bun/npm package-manager registration and provenance; it does not independently
scan package registrations or manifests as installation-mode footprints.

## Run the installer

From the repository root:

```bash
python3 scripts/update_local_baton.py
```

The script detects footprints, then executes the selected plan. The clean plan
builds and verifies first, performs a built-CLI clean-uninstall preflight and
apply, removes recognized package registrations, runs `bun link`, runs a
non-interactive profile-free `baton init`, and verifies the resulting link and
installation. The fresh plan omits only the clean-uninstall/removal stages.
It does not silently preserve an old installation as the result of a clean
plan. If the user explicitly accepts omitted tests, the faster form is:

```bash
python3 scripts/update_local_baton.py --skip-tests
```

Use `--dry-run` to render the complete fresh or clean-reinstall plan, including
the clean-uninstall preflight/apply and registration-removal stages, without
executing it. The dry-run must not invoke package-manager unlink: Bun 1.4.0
package-manager dry-run is unsafe. If a step fails, stop on the concrete
blocker; do not replace the source checkout with another installation method.

The clean plan is blocked when active tickets have not drained, an owned-file
or package conflict is detected, state is invalid/incomplete, or the command
to remove a recognized registration is ambiguous. Resolve the reported state
and rerun the installer; never use `rm -rf ~/.baton` or manually delete a
selected host/profile as a shortcut.

## Initialize adapters

After linking, the installer runs plain `baton init` with noninteractive stdin.
It must not open the host picker or create model choices. Users configure a
host explicitly afterward:

```bash
baton config --cli <adapter-id> --runner <model-id> --longctx <model-id> --coding-model <model-id>
```

This current syntax writes only `[cli.<adapter-id>]`; use `-` to clear
`runner` or `longctx`, and `--coding-model all` only when the catalog's
complete Coding order is explicitly desired. Do not use `--enable`. An empty
profile is valid after init but blocks classified routing until configured.
Profile choices remain user-owned and are never synthesized by the installer.

## Verify and report

Confirm that:

- `command -v baton` resolves to this checkout's `dist/bin/baton.js`;
- `baton version` succeeds;
- the selected fresh/clean-reinstall plan and every safety preflight is reported;
- no unrelated adapter profile or user file changed.

Report freshly installed or cleanly reinstalled, repository path, linked
command path, version, whether noninteractive `baton init` ran, and the next
configuration command. Do not commit or publish as part of installation.
