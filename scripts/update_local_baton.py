#!/usr/bin/env python3
"""Build and safely install this OpenBaton source checkout.

The old installation is deliberately kept usable until the replacement has
passed dependency, test, build, executable, and clean-uninstall preflight.
This module keeps the orchestration helpers small and injectable so an
isolated test can exercise planning without touching the real user home.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence


REPO_ROOT = Path(__file__).resolve().parents[1]
BUILT_CLI = REPO_ROOT / "dist" / "bin" / "baton.js"
PACKAGE_NAME = "@zhouliuya/openbaton"


@dataclass(frozen=True)
class PackageRegistration:
    """A package-manager registration that owns the visible baton command."""

    manager: str
    package_root: Path
    package_name: str
    remove_command: tuple[str, ...]
    kind: str


@dataclass(frozen=True)
class InstallationFootprint:
    command: Path | None
    resolved_command: Path | None
    baton_home: Path
    host_skills: tuple[Path, ...]
    registration: PackageRegistration | None

    @property
    def has_prior_installation(self) -> bool:
        return bool(self.command or self.baton_home.exists() or self.host_skills)

    @property
    def mode(self) -> str:
        return "clean-reinstalled" if self.has_prior_installation else "installed"


@dataclass(frozen=True)
class PlannedAction:
    label: str
    command: tuple[str, ...]
    capture: bool = False
    noninteractive: bool = False


@dataclass(frozen=True)
class InstallPlan:
    mode: str
    footprint: InstallationFootprint
    actions: tuple[PlannedAction, ...]


Runner = Callable[..., subprocess.CompletedProcess[str]]


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Install this OpenBaton checkout. Existing installations are cleanly "
            "removed after the replacement build passes all safety checks."
        )
    )
    parser.add_argument("--skip-install", action="store_true", help="skip 'bun install --frozen-lockfile'")
    parser.add_argument("--skip-tests", action="store_true", help="skip 'bun run test' (explicit opt-out)")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="render the ordered install/reinstall plan without changing the machine",
    )
    return parser.parse_args(argv)


def display_command(command: Sequence[str]) -> str:
    return shlex.join(str(part) for part in command)


def host_home(env: Mapping[str, str] | None = None) -> Path:
    values = env if env is not None else os.environ
    return Path(values.get("HOME") or values.get("USERPROFILE") or Path.home())


def baton_home(env: Mapping[str, str] | None = None) -> Path:
    return host_home(env) / ".baton"


def find_visible_command(name: str, env: Mapping[str, str] | None = None) -> Path | None:
    """Find an executable on PATH, including a symlink whose target is absent."""
    values = env if env is not None else os.environ
    for entry in values.get("PATH", os.defpath).split(os.pathsep):
        candidate = (Path(entry or os.curdir) / name).absolute()
        try:
            info = candidate.lstat()
            if stat.S_ISDIR(info.st_mode):
                continue
            if stat.S_ISLNK(info.st_mode) or info.st_mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH):
                return candidate
        except OSError:
            continue
    return None


def require_command(name: str, env: Mapping[str, str] | None = None) -> str:
    """Compatibility helper retained for callers of the original entrypoint."""
    command = find_visible_command(name, env)
    if command is None:
        raise RuntimeError(f"required command is not on PATH: {name}")
    return str(command)


def resolve_path_without_following_links(path: Path) -> Path:
    try:
        return path.resolve(strict=False)
    except OSError:
        return path.absolute()


def resolve_linked_baton(*, env: Mapping[str, str] | None = None, repo_root: Path = REPO_ROOT) -> str:
    """Verify that PATH's baton resolves to this checkout's built CLI."""
    command = find_visible_command("baton", env)
    if command is None:
        raise RuntimeError("required command is not on PATH: baton")
    actual = resolve_path_without_following_links(command)
    expected = (repo_root / "dist" / "bin" / "baton.js").resolve()
    if actual != expected:
        raise RuntimeError(
            "'bun link' completed, but the baton command on PATH does not point "
            f"to this checkout:\n  command: {command}\n  target:  {actual}\n  expected: {expected}"
        )
    return str(command)


def _symlink_chain(path: Path) -> list[Path]:
    chain: list[Path] = []
    current = path.absolute()
    seen: set[Path] = set()
    for _ in range(32):
        if current in seen:
            break
        seen.add(current)
        chain.append(current)
        try:
            if not current.is_symlink():
                break
            target = Path(os.readlink(current))
            current = (current.parent / target).absolute() if not target.is_absolute() else target
        except OSError:
            break
    return chain


def _package_root_for(path: Path) -> Path | None:
    for directory in (path.parent, *path.parents):
        package_file = directory / "package.json"
        if not package_file.is_file():
            continue
        try:
            package = json.loads(package_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if package.get("name") != PACKAGE_NAME:
            continue
        binary = package.get("bin", {})
        if isinstance(binary, str):
            binary = {"baton": binary}
        if not isinstance(binary, dict) or "baton" not in binary:
            continue
        return directory
    return None


def invoke(
    command: Sequence[str],
    *,
    env: Mapping[str, str] | None = None,
    runner: Runner | None = None,
    capture: bool = False,
    noninteractive: bool = False,
    cwd: Path = REPO_ROOT,
) -> subprocess.CompletedProcess[str]:
    kwargs: dict[str, Any] = {
        "cwd": str(cwd), "check": True, "text": True,
        "env": dict(env) if env is not None else None,
    }
    if capture:
        kwargs.update(stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if noninteractive:
        kwargs["stdin"] = subprocess.DEVNULL
    if runner:
        return runner(list(command), **kwargs)
    return subprocess.run(list(command), **kwargs)


def _npm_global_root(npm: str, env: Mapping[str, str], runner: Runner | None) -> Path | None:
    try:
        result = invoke([npm, "root", "--global"], env=env, runner=runner, capture=True)
    except (OSError, subprocess.CalledProcessError):
        return None
    lines = result.stdout.strip().splitlines()
    return Path(lines[-1]).expanduser().resolve() if lines and lines[-1].strip() else None


def _package_listing(
    command: Sequence[str], env: Mapping[str, str], runner: Runner | None,
) -> tuple[bool, set[Path]]:
    """Read a package-manager listing without changing its registry.

    Bun and npm have emitted several JSON shapes over time. We only need the
    package name/path pairs, so walk those shapes conservatively and ignore
    malformed records. A failed listing is not proof of unknown ownership;
    filesystem identity is still checked for the supported global layouts.
    """
    try:
        result = invoke(command, env=env, runner=runner, capture=True)
        raw = result.stdout or "{}"
        try:
            payload = json.loads(raw)
        except ValueError:
            # Some package-manager wrappers append a newline/banner or an
            # extra delimiter after the JSON document. Keep only the first
            # complete value; malformed first values still fail closed below.
            payload, _ = json.JSONDecoder().raw_decode(raw.lstrip())
    except (OSError, subprocess.CalledProcessError):
        return False, set()
    except ValueError:
        # A successful invocation with unparseable output is still unavailable
        # ownership data. Keep that distinct from a valid empty listing so the
        # supported filesystem layout can remain the deciding evidence.
        return False, set()
    if not isinstance(payload, (dict, list)):
        return False, set()
    found: set[Path] = set()

    package_maps = {
        "dependencies", "devDependencies", "optionalDependencies",
        "peerDependencies", "transitiveDependencies",
    }

    def visit(value: Any, inferred_name: str | None = None) -> None:
        if isinstance(value, dict):
            explicit_name = value.get("name")
            name = explicit_name if isinstance(explicit_name, str) else inferred_name
            location = value.get("path", value.get("location"))
            if name == PACKAGE_NAME and isinstance(location, str) and location:
                found.add(Path(location).expanduser().resolve(strict=False))
            for key, child in value.items():
                if key in package_maps and isinstance(child, dict):
                    for package_name, package_record in child.items():
                        visit(package_record, package_name)
                else:
                    visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(payload)
    return True, found


def _scoped_package_relative(path: Path, root: Path) -> bool:
    """Require an exact scoped package path under a package-manager root."""
    # Normalize lexical ``..`` segments but do not resolve symlinks: a Bun
    # global link intentionally has a package directory symlink to the
    # checkout, and resolving it would erase the registration path.
    package_path = Path(os.path.abspath(str(path)))
    package_root = Path(os.path.abspath(str(root)))
    try:
        return tuple(package_path.relative_to(package_root).parts) == (
            "@zhouliuya", "openbaton"
        )
    except ValueError:
        return False


def _package_registration(
    command: Path,
    env: Mapping[str, str],
    *,
    repo_root: Path,
    runner: Runner | None = None,
    dry_run: bool = False,
) -> PackageRegistration | None:
    """Resolve only supported Bun/npm package layouts; return None otherwise."""
    roots: list[Path] = []
    for item in _symlink_chain(command):
        root = _package_root_for(item)
        if root and root not in roots:
            roots.append(root)
    resolved_root = _package_root_for(resolve_path_without_following_links(command))
    if resolved_root and resolved_root not in roots:
        roots.append(resolved_root)
    bun = find_visible_command("bun", env)
    npm = find_visible_command("npm", env)
    # Package-manager inspection is read-only and is deliberately also used
    # by --dry-run, so a supported npm registration is not reported as an
    # ambiguous executable merely because this is a preview.
    npm_root = _npm_global_root(str(npm), env, runner) if npm else None
    bun_listing_ok, bun_registered = _package_listing([str(bun), "pm", "ls", "-g", "--json"], env, runner) if bun else (False, set())
    npm_listing_ok, npm_registered = _package_listing([str(npm), "ls", "-g", "--depth=0", "--json", "--long"], env, runner) if npm else (False, set())
    bun_install = Path(env.get("BUN_INSTALL", str(host_home(env) / ".bun"))).expanduser()
    candidates: list[PackageRegistration] = []
    for package_root in roots:
        package_root_resolved = package_root.resolve(strict=False)
        global_bun_root = bun_install / "install" / "global" / "node_modules"
        under_bun_global = _scoped_package_relative(package_root, global_bun_root)
        if bun and under_bun_global:
            if bun_listing_ok and bun_registered and package_root.resolve(strict=False) not in bun_registered:
                continue
            if bun_listing_ok and not bun_registered:
                continue
            linked = package_root.is_symlink() or package_root_resolved == repo_root.resolve()
            candidates.append(PackageRegistration(
                manager="bun", package_root=package_root, package_name=PACKAGE_NAME,
                remove_command=(str(bun), "unlink") if linked else (str(bun), "remove", "--global", PACKAGE_NAME),
                kind="bun-link" if linked else "bun-global-package",
            ))
        if npm and npm_root and _scoped_package_relative(package_root, npm_root):
            if npm_listing_ok and npm_registered and package_root.resolve(strict=False) not in npm_registered:
                continue
            if npm_listing_ok and not npm_registered:
                continue
            candidates.append(PackageRegistration(
                manager="npm", package_root=package_root, package_name=PACKAGE_NAME,
                remove_command=(str(npm), "uninstall", "--global", PACKAGE_NAME),
                kind="npm-global-package",
            ))
    unique = {(item.manager, item.kind, item.package_root.resolve(strict=False)): item for item in candidates}
    if len(unique) > 1:
        raise RuntimeError(
            "ambiguous Baton executable provenance; refusing cleanup: "
            + ", ".join(sorted(item.kind for item in unique.values()))
        )
    return next(iter(unique.values())) if unique else None


def registered_host_skill_paths(repo_root: Path, home: Path) -> tuple[Path, ...]:
    paths: list[Path] = []
    adapter_root = repo_root / "adapters"
    if not adapter_root.is_dir():
        return ()
    for manifest_file in sorted(adapter_root.glob("*/adapter.json")):
        try:
            manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
            destination = manifest["runtime_skill"]["destination"]
            if not isinstance(destination, str) or not destination or Path(destination).is_absolute():
                continue
            path = (home / destination).resolve()
            if path.exists() and path not in paths:
                paths.append(path)
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return tuple(paths)


def detect_installation(
    *,
    env: Mapping[str, str] | None = None,
    repo_root: Path = REPO_ROOT,
    runner: Runner | None = None,
    dry_run: bool = False,
) -> InstallationFootprint:
    values = env if env is not None else os.environ
    command = find_visible_command("baton", values)
    resolved = resolve_path_without_following_links(command) if command else None
    registration = _package_registration(command, values, repo_root=repo_root, runner=runner, dry_run=dry_run) if command else None
    home = baton_home(values)
    return InstallationFootprint(command, resolved, home, registered_host_skill_paths(repo_root, home.parent), registration)


def _bun_path(env: Mapping[str, str]) -> str:
    return str(find_visible_command("bun", env) or "bun")


def build_plan(
    args: argparse.Namespace,
    footprint: InstallationFootprint,
    *,
    env: Mapping[str, str] | None = None,
    repo_root: Path = REPO_ROOT,
) -> InstallPlan:
    values = env if env is not None else os.environ
    bun = _bun_path(values)
    cli = repo_root / "dist" / "bin" / "baton.js"
    actions: list[PlannedAction] = []
    if not args.skip_install:
        actions.append(PlannedAction("install locked dependencies", (bun, "install", "--frozen-lockfile")))
    if not args.skip_tests:
        actions.append(PlannedAction("run tests and type checking", (bun, "run", "test")))
    actions.append(PlannedAction("build the distribution", (bun, "run", "build")))
    if footprint.has_prior_installation:
        actions.append(PlannedAction("plan clean uninstall with the newly built CLI", (str(cli), "uninstall", "--clean", "--dry-run", "--json"), capture=True))
        actions.append(PlannedAction("apply clean uninstall with the newly built CLI", (str(cli), "uninstall", "--clean", "--yes", "--json"), capture=True))
        if footprint.registration:
            actions.append(PlannedAction("remove the recognized old package registration", footprint.registration.remove_command))
    actions.extend([
        PlannedAction("link this checkout globally", (bun, "link")),
        PlannedAction("initialize Baton and host skills without a CLI profile", (str(cli), "init"), noninteractive=True),
        PlannedAction("verify the linked CLI and installed files", (str(cli), "version"), capture=True),
    ])
    return InstallPlan(footprint.mode, footprint, tuple(actions))


def run(
    command: Sequence[str], *, dry_run: bool = False, env: Mapping[str, str] | None = None,
    capture: bool = False, noninteractive: bool = False, runner: Runner | None = None,
    cwd: Path = REPO_ROOT,
) -> str:
    print(f"+ {display_command(command)}", flush=True)
    if dry_run:
        return ""
    try:
        result = invoke(command, env=env, runner=runner, capture=capture, noninteractive=noninteractive, cwd=cwd)
    except subprocess.CalledProcessError as error:
        detail = "\n".join(
            part.strip() for part in (error.stdout, error.stderr)
            if isinstance(part, str) and part.strip()
        )
        raise RuntimeError(
            f"command failed ({error.returncode}): {display_command(command)}"
            + (f"\n{detail}" if detail else "")
        ) from error
    return result.stdout if capture else ""


def _parse_json_output(output: str) -> dict[str, Any]:
    try:
        value = json.loads(output)
    except ValueError as error:
        start = output.find("{")
        if start < 0:
            raise RuntimeError("built Baton uninstall output was not valid JSON") from error
        try:
            value = json.loads(output[start:])
        except (TypeError, ValueError) as error:
            raise RuntimeError("built Baton uninstall output was not valid JSON") from error
    except TypeError as error:
        raise RuntimeError("built Baton uninstall output was not valid JSON") from error
    if not isinstance(value, dict):
        raise RuntimeError("built Baton uninstall output did not return a JSON object")
    return value


_UNINSTALL_PLAN_KEYS = frozenset({
    "hosts", "clean", "dry_run", "applied", "targets", "active_tickets", "retained_runtime_records", "constraints",
})
_UNINSTALL_TARGET_REQUIRED_KEYS = frozenset({
    "action", "path", "reason", "expected_fingerprint", "expected_mode", "expected_kind",
})
_UNINSTALL_TARGET_CORE_KEYS = frozenset({"action", "path", "reason"})
_UNINSTALL_TARGET_KEYS = frozenset({
    "action", "path", "host", "reason", "expected_fingerprint", "expected_mode", "expected_kind",
})
_UNINSTALL_TICKET_KEYS = frozenset({"path", "ticket_id", "status", "host"})
_UNINSTALL_RETAINED_RECORD_KEYS = frozenset({"path", "kind", "reason"})
_UNINSTALL_ACTIONS = frozenset({"remove", "already-absent", "conflict"})
_UNINSTALL_KINDS = frozenset({"file", "directory", "absent"})
_SAFE_UNINSTALL_CONSTRAINTS = frozenset({
    "preserve modified or ambiguous skills",
    "never remove package-manager executable",
    "never recurse outside explicit Baton/host integration paths",
    "preserve auditable rolling-run v2 records and their containing workspace runtime namespaces",
    "preserve rolling isolation worktrees, snapshots, bundles, integration contexts, and retained evidence",
})


def _invalid_uninstall_schema(detail: str) -> RuntimeError:
    return RuntimeError(f"built Baton uninstall result has invalid JSON schema: {detail}")


def _require_object(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise _invalid_uninstall_schema(f"{label} must be an object")
    return value


def _require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise _invalid_uninstall_schema(f"{label} must be a non-empty string")
    return value


def _require_string_list(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        raise _invalid_uninstall_schema(f"{label} must be an array of non-empty strings")
    return value


def _require_exact_keys(value: Mapping[str, Any], expected: frozenset[str], label: str) -> None:
    actual = set(value)
    missing = sorted(expected - actual)
    unknown = sorted(actual - expected)
    if missing or unknown:
        details: list[str] = []
        if missing:
            details.append("missing " + ", ".join(missing))
        if unknown:
            details.append("unknown " + ", ".join(unknown))
        raise _invalid_uninstall_schema(f"{label} has " + "; ".join(details))


def _require_keys(value: Mapping[str, Any], required: frozenset[str], allowed: frozenset[str], label: str) -> None:
    missing = sorted(required - set(value))
    unknown = sorted(set(value) - allowed)
    if missing or unknown:
        details: list[str] = []
        if missing:
            details.append("missing " + ", ".join(missing))
        if unknown:
            details.append("unknown " + ", ".join(unknown))
        raise _invalid_uninstall_schema(f"{label} has " + "; ".join(details))


def validate_uninstall_plan(
    payload: Mapping[str, Any], *, expected_dry_run: bool = True, expected_applied: bool = False,
) -> None:
    """Validate the complete JSON contract before trusting an uninstall result.

    The installer is a destructive caller, so a syntactically valid but
    incomplete result is not sufficient. Both the preview and apply result
    must carry the expected state flags and every target/ticket must have the
    shape emitted by ``src/lib/uninstall.ts``.
    """
    plan = _require_object(payload, "top-level result")
    _require_exact_keys(plan, _UNINSTALL_PLAN_KEYS, "top-level result")
    if plan["clean"] is not True:
        raise RuntimeError("built Baton uninstall result was not a clean plan")
    hosts = _require_string_list(plan["hosts"], "hosts")
    if not hosts:
        raise _invalid_uninstall_schema("hosts must not be empty")
    if len(set(hosts)) != len(hosts):
        raise _invalid_uninstall_schema("hosts contains duplicates")

    active = plan["active_tickets"]
    if not isinstance(active, list):
        raise _invalid_uninstall_schema("active_tickets must be an array")
    for index, item in enumerate(active):
        ticket = _require_object(item, f"active_tickets[{index}]")
        _require_exact_keys(ticket, _UNINSTALL_TICKET_KEYS, f"active_tickets[{index}]")
        for field in _UNINSTALL_TICKET_KEYS:
            _require_string(ticket[field], f"active_tickets[{index}].{field}")
    if active:
        ids = ", ".join(str(item["ticket_id"]) for item in active)
        raise RuntimeError(f"clean uninstall blocked by active tickets: {ids}")

    retained = plan["retained_runtime_records"]
    if not isinstance(retained, list):
        raise _invalid_uninstall_schema("retained_runtime_records must be an array")
    retained_paths: set[str] = set()
    for index, item in enumerate(retained):
        record = _require_object(item, f"retained_runtime_records[{index}]")
        _require_exact_keys(record, _UNINSTALL_RETAINED_RECORD_KEYS, f"retained_runtime_records[{index}]")
        record_path = _require_string(record["path"], f"retained_runtime_records[{index}].path")
        if record_path in retained_paths:
            raise _invalid_uninstall_schema(f"retained_runtime_records contains duplicate path: {record_path}")
        retained_paths.add(record_path)
        if record["kind"] != "rolling-run-v2":
            raise _invalid_uninstall_schema(f"retained_runtime_records[{index}].kind must be rolling-run-v2")
        _require_string(record["reason"], f"retained_runtime_records[{index}].reason")

    targets = plan["targets"]
    if not isinstance(targets, list):
        raise _invalid_uninstall_schema("targets must be an array")
    for index, item in enumerate(targets):
        target = _require_object(item, f"targets[{index}]")
        _require_keys(target, _UNINSTALL_TARGET_CORE_KEYS, _UNINSTALL_TARGET_KEYS, f"targets[{index}]")
        action = _require_string(target["action"], f"targets[{index}].action")
        if action not in _UNINSTALL_ACTIONS:
            raise _invalid_uninstall_schema(f"targets[{index}].action is unknown: {action}")
        path = _require_string(target["path"], f"targets[{index}].path")
        _require_string(target["reason"], f"targets[{index}].reason")
        # Surface a newly reported ownership conflict even if a buggy caller
        # omitted optional fingerprint metadata; it must never be treated as
        # an ordinary target or allow package unregister/link to proceed.
        if action == "conflict":
            raise RuntimeError("clean uninstall has ownership conflicts: " + path)
        _require_keys(target, _UNINSTALL_TARGET_REQUIRED_KEYS, _UNINSTALL_TARGET_KEYS, f"targets[{index}]")
        if "host" in target:
            _require_string(target["host"], f"targets[{index}].host")
        fingerprint = target["expected_fingerprint"]
        mode = target["expected_mode"]
        kind = target["expected_kind"]
        if action == "remove":
            if not isinstance(kind, str) or kind not in {"file", "directory"}:
                raise _invalid_uninstall_schema(f"targets[{index}].remove expected_kind must be file or directory")
            if not isinstance(fingerprint, str) or not fingerprint:
                raise _invalid_uninstall_schema(f"targets[{index}].remove expected_fingerprint must be a non-empty string")
            if type(mode) is not int or mode < 0:
                raise _invalid_uninstall_schema(f"targets[{index}].remove expected_mode must be a non-negative integer")
        elif action == "already-absent":
            if kind != "absent" or fingerprint is not None or mode is not None:
                raise _invalid_uninstall_schema(
                    f"targets[{index}].already-absent requires expected_kind=absent and null fingerprint/mode"
                )
        elif not isinstance(kind, str) or kind not in _UNINSTALL_KINDS:
            raise _invalid_uninstall_schema(f"targets[{index}].expected_kind is invalid: {kind!r}")
    constraints = _require_string_list(plan["constraints"], "constraints")
    blocking = [item for item in constraints if item not in _SAFE_UNINSTALL_CONSTRAINTS]
    if blocking:
        raise RuntimeError("clean uninstall result is blocked: " + "; ".join(blocking))
    if type(plan["dry_run"]) is not bool or plan["dry_run"] is not expected_dry_run:
        raise RuntimeError(
            "built Baton uninstall result has unexpected dry_run flag: "
            f"expected {expected_dry_run}, got {plan['dry_run']!r}"
        )
    applied = plan.get("applied", False)
    if type(applied) is not bool or applied is not expected_applied:
        raise RuntimeError(
            "built Baton uninstall result has unexpected applied flag: "
            f"expected {expected_applied}, got {applied!r}"
        )


def _manifest_host_files(home: Path) -> list[Path]:
    manifest_file = home / "install-manifest.json"
    if not manifest_file.is_file():
        raise RuntimeError(f"initialization did not write install manifest: {manifest_file}")
    try:
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
        files = manifest["files"]
        if not isinstance(files, list) or any(not isinstance(item, dict) for item in files):
            raise TypeError("install manifest files must be a list of objects")
        return [Path(item["path"]) for item in files if item.get("kind") == "host-skill"]
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise RuntimeError(f"installed manifest is invalid: {manifest_file}") from error


def verify_installation(
    *, env: Mapping[str, str] | None = None, repo_root: Path = REPO_ROOT,
    expected_mode: str, runner: Runner | None = None,
) -> tuple[Path, str]:
    values = env if env is not None else os.environ
    command = find_visible_command("baton", values)
    expected = (repo_root / "dist" / "bin" / "baton.js").resolve()
    if not command:
        raise RuntimeError("verification failed: baton is not on PATH")
    target = resolve_path_without_following_links(command)
    if target != expected:
        raise RuntimeError(f"verification failed: baton target is {target}, expected {expected}")
    output = run([str(repo_root / "dist" / "bin" / "baton.js"), "version"], env=values, runner=runner, capture=True, cwd=repo_root)
    version = next((line.strip() for line in output.splitlines() if line.strip().lower().startswith("baton ")), output.strip())
    if not version:
        raise RuntimeError("verification failed: baton version output is empty")
    global_skill = baton_home(values) / "SKILL.md"
    source_skill = repo_root / "SKILL.md"
    if not global_skill.is_file() or global_skill.read_bytes() != source_skill.read_bytes():
        raise RuntimeError(f"verification failed: global skill does not match {source_skill}")
    adapter_root = baton_home(values) / "adapters"
    missing_adapters = [str(adapter_root / adapter.name / "adapter.json") for adapter in repo_root.joinpath("adapters").iterdir()
                        if adapter.is_dir() and (adapter / "adapter.json").is_file()
                        if not (adapter_root / adapter.name / "adapter.json").is_file()]
    if missing_adapters:
        raise RuntimeError("verification failed: missing bundled adapters: " + ", ".join(missing_adapters))
    missing_hosts = [str(path) for path in _manifest_host_files(baton_home(values)) if not path.is_file()]
    if missing_hosts:
        raise RuntimeError("verification failed: missing manifest-owned host skills: " + ", ".join(missing_hosts))
    required_runtime_modules = (
        Path("worktree") / "setup.js",
        Path("worktree") / "audit.js",
        Path("worktree") / "bundle.js",
        Path("worktree-integration.js"),
        Path("worktree-lifecycle.js"),
    )
    missing_runtime_modules = [
        str(repo_root / "dist" / "src" / "lib" / name)
        for name in required_runtime_modules
        if not (repo_root / "dist" / "src" / "lib" / name).is_file()
    ]
    if missing_runtime_modules:
        raise RuntimeError(
            "verification failed: missing rolling isolation runtime modules: "
            + ", ".join(missing_runtime_modules)
        )
    config = baton_home(values) / "config.toml"
    if not config.is_file() or re.search(r"(?m)^\s*\[cli(?:\.|\s*\])", config.read_text(encoding="utf-8")):
        raise RuntimeError("verification failed: initialization restored a CLI profile")
    if expected_mode not in {"installed", "clean-reinstalled"}:
        raise RuntimeError(f"verification failed: invalid installation mode {expected_mode}")
    return command, version


def recovery_guidance(repo_root: Path = REPO_ROOT) -> str:
    cli = repo_root / "dist" / "bin" / "baton.js"
    return (
        "Recovery (cleanup has begun): inspect `command -v baton` and `~/.baton`, "
        f"then repair the link with `bun link` and initialize with `{cli} init`; "
        "verify with `baton version`. Inspect retained rolling-run status before removing "
        "any worktree, bundle refs, or integration context. Existing CLI profiles are not restored automatically."
    )


def _require_runtime(env: Mapping[str, str]) -> None:
    if not find_visible_command("bun", env):
        raise RuntimeError("required command is not on PATH: bun")
    if not find_visible_command("node", env):
        raise RuntimeError("required command is not on PATH: node")


def install(
    args: argparse.Namespace, *, env: Mapping[str, str] | None = None,
    repo_root: Path = REPO_ROOT, runner: Runner | None = None,
) -> int:
    values = env if env is not None else os.environ
    if not (repo_root / "package.json").is_file():
        raise RuntimeError(f"package.json not found under repository root: {repo_root}")
    footprint = detect_installation(env=values, repo_root=repo_root, runner=runner, dry_run=args.dry_run)
    if footprint.command and footprint.registration is None:
        command = footprint.command or Path("<unknown>")
        raise RuntimeError(
            f"cannot establish supported package ownership for Baton command {command}; "
            "refusing cleanup or executable deletion"
        )
    plan = build_plan(args, footprint, env=values, repo_root=repo_root)
    print(f"Installation mode: {plan.mode}")
    if footprint.command:
        print(f"  existing command: {footprint.command} -> {footprint.resolved_command}")
    if footprint.baton_home.exists():
        print(f"  existing Baton home: {footprint.baton_home}")
    for path in footprint.host_skills:
        print(f"  existing host skill: {path}")
    if args.dry_run:
        for index, action in enumerate(plan.actions, 1):
            print(f"[{index}/{len(plan.actions)}] {action.label}")
            print(f"  + {display_command(action.command)}")
        print("Dry run complete; no commands were executed.")
        return 0

    _require_runtime(values)
    cleanup_started = False
    try:
        bun = _bun_path(values)
        if not args.skip_install:
            run([bun, "install", "--frozen-lockfile"], env=values, runner=runner, cwd=repo_root)
        if not args.skip_tests:
            run([bun, "run", "test"], env=values, runner=runner, cwd=repo_root)
        run([bun, "run", "build"], env=values, runner=runner, cwd=repo_root)
        built_cli = repo_root / "dist" / "bin" / "baton.js"
        if not built_cli.is_file():
            raise RuntimeError(f"build did not create the expected CLI: {built_cli}")
        if footprint.has_prior_installation:
            preflight_output = run([str(built_cli), "uninstall", "--clean", "--dry-run", "--json"], env=values, runner=runner, capture=True, cwd=repo_root)
            validate_uninstall_plan(
                _parse_json_output(preflight_output), expected_dry_run=True, expected_applied=False,
            )
            cleanup_started = True
            apply_output = run(
                [str(built_cli), "uninstall", "--clean", "--yes", "--json"],
                env=values, runner=runner, capture=True, cwd=repo_root,
            )
            validate_uninstall_plan(
                _parse_json_output(apply_output), expected_dry_run=False, expected_applied=True,
            )
            if footprint.registration is not None:
                run(footprint.registration.remove_command, env=values, runner=runner, cwd=repo_root)
        cleanup_started = True
        run([bun, "link"], env=values, runner=runner, cwd=repo_root)
        run([str(built_cli), "init"], env=values, runner=runner, noninteractive=True, cwd=repo_root)
        command, version = verify_installation(env=values, repo_root=repo_root, expected_mode=plan.mode, runner=runner)
    except (OSError, subprocess.CalledProcessError, RuntimeError) as error:
        if cleanup_started:
            raise RuntimeError(f"{error}\n{recovery_guidance(repo_root)}") from error
        raise

    print(f"Local Baton {plan.mode} complete.")
    print(f"  checkout: {repo_root}")
    print(f"  command:  {command}")
    print(f"  target:   {resolve_path_without_following_links(command)}")
    print(f"  version:  {version}")
    print("  initialized: yes (no CLI profile selected)")
    print("  next: baton config")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    return install(parse_args(argv))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
