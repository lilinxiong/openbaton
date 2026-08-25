#!/usr/bin/env python3
"""Build this checkout and update the locally linked Baton installation."""

from __future__ import annotations

import argparse
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Sequence


REPO_ROOT = Path(__file__).resolve().parents[1]
BUILT_CLI = REPO_ROOT / "dist" / "bin" / "baton.js"
GLOBAL_SKILL = Path.home() / ".baton" / "SKILL.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Install dependencies, test and build this checkout, link it with Bun, "
            "then refresh the local Baton skill and global config defaults."
        )
    )
    parser.add_argument(
        "--skip-install",
        action="store_true",
        help="skip 'bun install --frozen-lockfile'",
    )
    parser.add_argument(
        "--skip-tests",
        action="store_true",
        help="skip 'bun run test'",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print the update commands without running them",
    )
    return parser.parse_args()


def display_command(command: Sequence[str]) -> str:
    return shlex.join(str(part) for part in command)


def run(command: Sequence[str], *, dry_run: bool) -> None:
    print(f"+ {display_command(command)}", flush=True)
    if dry_run:
        return
    subprocess.run(command, cwd=REPO_ROOT, check=True)


def require_command(name: str) -> str:
    executable = shutil.which(name)
    if executable is None:
        raise RuntimeError(f"required command is not on PATH: {name}")
    return executable


def resolve_linked_baton() -> str:
    baton = require_command("baton")
    actual = Path(baton).resolve()
    expected = BUILT_CLI.resolve()
    if actual != expected:
        raise RuntimeError(
            "'bun link' completed, but the baton command on PATH does not point "
            f"to this checkout:\n  command: {baton}\n  target:  {actual}\n"
            f"  expected: {expected}"
        )
    return baton


def verify_active_skill() -> None:
    """Ensure the global director skill is the one shipped by this checkout."""
    source = REPO_ROOT / "SKILL.md"
    if not GLOBAL_SKILL.is_file():
        raise RuntimeError(
            "baton update completed without writing the active global skill: "
            f"{GLOBAL_SKILL}"
        )
    if GLOBAL_SKILL.read_bytes() != source.read_bytes():
        raise RuntimeError(
            "the active global Baton skill does not match this checkout after "
            f"baton update:\n  installed: {GLOBAL_SKILL}\n  source:    {source}"
        )


def main() -> int:
    args = parse_args()

    if not (REPO_ROOT / "package.json").is_file():
        raise RuntimeError(f"package.json not found under repository root: {REPO_ROOT}")

    bun = require_command("bun")
    require_command("node")

    commands: list[tuple[str, list[str]]] = []
    if not args.skip_install:
        commands.append(
            ("install locked dependencies", [bun, "install", "--frozen-lockfile"])
        )
    if not args.skip_tests:
        commands.append(("run tests and type checking", [bun, "run", "test"]))
    commands.extend(
        [
            ("build the distribution", [bun, "run", "build"]),
            ("link this checkout globally", [bun, "link"]),
        ]
    )

    total = len(commands) + 2
    for index, (label, command) in enumerate(commands, start=1):
        print(f"[{index}/{total}] {label}", flush=True)
        run(command, dry_run=args.dry_run)

    next_step = len(commands) + 1
    if args.dry_run:
        print(f"[{next_step}/{total}] refresh the installed Baton files", flush=True)
        run(["baton", "update"], dry_run=True)
        print(f"[{next_step + 1}/{total}] verify the linked CLI", flush=True)
        run(["baton", "version"], dry_run=True)
        print("Dry run complete; no commands were executed.")
        return 0

    if not BUILT_CLI.is_file():
        raise RuntimeError(f"build did not create the expected CLI: {BUILT_CLI}")

    baton = resolve_linked_baton()
    print(f"[{next_step}/{total}] refresh the installed Baton files", flush=True)
    run([baton, "update"], dry_run=False)
    verify_active_skill()
    print(f"  verified active global skill: {GLOBAL_SKILL}", flush=True)
    print(f"[{next_step + 1}/{total}] verify the linked CLI", flush=True)
    run([baton, "version"], dry_run=False)

    print("Local Baton update complete.")
    print(f"  checkout: {REPO_ROOT}")
    print(f"  command:  {baton}")
    print(f"  target:   {BUILT_CLI.resolve()}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
