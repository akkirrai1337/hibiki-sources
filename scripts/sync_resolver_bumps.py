#!/usr/bin/env python3
"""Bumps a source's version when one of its resolver dependencies changed.

Why this exists: resolvers (kodik, alloha, sibnet, ...) are hidden dependencies. An app installs
them as a side effect of installing the source that declares them, and never lists or updates them
on their own. So publishing a resolver-only fix - a faster Kodik extraction, a provider changing
its protocol - reached nobody: the source's own version hadn't moved, no client offered an update,
and the only way to get the fix was to uninstall and reinstall the source.

Bumping the source instead means the fix travels the one update path every client already
implements, including versions already in people's hands. That matters more than it sounds: a
client-side check for resolver versions only helps clients that shipped with it, whereas this
reaches every build ever released, on both platforms.

State lives in repository/resolver-lock.json rather than being derived from `git diff`. A diff
against the previous commit is wrong in all the ordinary ways CI actually runs: a push containing
several commits, a re-run, a manual workflow_dispatch, a force-push. Comparing against a recorded
snapshot is none of those things - it is idempotent, self-healing if a run is ever missed, and
gives an honest answer when run locally.

Usage: python scripts/sync_resolver_bumps.py [--check]
  --check   report what would be bumped and exit non-zero if anything is out of date, without
            writing. For pull requests, where manifests aren't rewritten yet.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from build_index import EXTENSIONS_DIR, MANIFEST_SUFFIX, ManifestError, load_manifest

REPO_ROOT = Path(__file__).resolve().parent.parent
LOCK_PATH = REPO_ROOT / "repository" / "resolver-lock.json"


VERSION_LINE = re.compile(r'("version"\s*:\s*)"([^"]+)"')


def write_version(path: Path, expected: str, new_version: str) -> None:
    """Rewrites just the version string, leaving the rest of the file byte for byte.

    Not a json.load/json.dump round trip, which is the obvious implementation and the wrong one:
    these manifests are hand-formatted - yummy-anime keeps its resolverDependencies on one line -
    and re-serializing reflows the whole file, turning a one-word bump into a twenty-line diff that
    buries the actual change and undoes whatever formatting the author chose.
    """
    text = path.read_text(encoding="utf-8")
    found = VERSION_LINE.findall(text)
    if len(found) != 1 or found[0][1] != expected:
        raise ManifestError(f'{path.name}: expected exactly one "version": "{expected}" to rewrite')
    path.write_text(VERSION_LINE.sub(lambda m: f'{m.group(1)}"{new_version}"', text, count=1), encoding="utf-8")


def bump_patch(version: str) -> str:
    major, minor, patch = version.split(".")
    return f"{major}.{minor}.{int(patch) + 1}"


def load_all() -> tuple[dict[str, dict], dict[str, dict], dict[str, Path]]:
    """Every valid manifest, split into sources and resolvers, plus where each source lives."""
    sources: dict[str, dict] = {}
    resolvers: dict[str, dict] = {}
    paths: dict[str, Path] = {}
    errors: list[str] = []
    for path in sorted(EXTENSIONS_DIR.rglob(f"*{MANIFEST_SUFFIX}")):
        try:
            manifest = load_manifest(path)
        except ManifestError as error:
            errors.append(str(error))
            continue
        if manifest.get("type", "source") == "player-resolver":
            resolvers[manifest["id"]] = manifest
        else:
            sources[manifest["id"]] = manifest
            paths[manifest["id"]] = path
    if errors:
        raise ManifestError("\n".join(errors))
    return sources, resolvers, paths


def resolver_versions_for(manifest: dict, resolvers: dict[str, dict]) -> dict[str, str]:
    """The declared dependencies that actually exist here, and the version each is at.

    A dependency naming a resolver this repository doesn't publish is skipped rather than recorded
    as absent: it was never installed on any device either, so it cannot be the reason a source
    needs republishing.
    """
    return {
        resolver_id: resolvers[resolver_id]["version"]
        for resolver_id in manifest.get("resolverDependencies", [])
        if resolver_id in resolvers
    }


def read_lock() -> dict[str, dict]:
    if not LOCK_PATH.is_file():
        return {}
    try:
        return json.loads(LOCK_PATH.read_text(encoding="utf-8")).get("sources", {})
    except json.JSONDecodeError as error:
        raise ManifestError(f"{LOCK_PATH.name}: invalid JSON ({error})") from error


def write_lock(entries: dict[str, dict]) -> None:
    document = {"schemaVersion": 1, "sources": dict(sorted(entries.items()))}
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOCK_PATH.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sync(check_only: bool) -> tuple[list[str], bool]:
    sources, resolvers, paths = load_all()
    lock = read_lock()
    messages: list[str] = []
    bumped = False

    next_lock: dict[str, dict] = {}
    for source_id, manifest in sorted(sources.items()):
        current_version = manifest["version"]
        current_resolvers = resolver_versions_for(manifest, resolvers)
        previous = lock.get(source_id)

        if previous is None:
            # First time this source is seen. Recording without bumping on purpose: introducing
            # the lock file should not republish every source in the repository at once.
            messages.append(f"{source_id}: tracked at {current_version}")
            next_lock[source_id] = {"version": current_version, "resolvers": current_resolvers}
            continue

        if previous.get("resolvers") != current_resolvers:
            changed = sorted(
                f"{rid} {previous.get('resolvers', {}).get(rid, '-')} -> {current_resolvers.get(rid, '-')}"
                for rid in set(current_resolvers) | set(previous.get("resolvers", {}))
                if previous.get("resolvers", {}).get(rid) != current_resolvers.get(rid)
            )
            if previous.get("version") != current_version:
                # The author already bumped this source in the same change - adding another bump on
                # top would republish it twice for one edit.
                messages.append(f"{source_id}: {', '.join(changed)} (already bumped to {current_version})")
                next_lock[source_id] = {"version": current_version, "resolvers": current_resolvers}
                continue

            new_version = bump_patch(current_version)
            messages.append(f"{source_id}: {', '.join(changed)} => {current_version} -> {new_version}")
            bumped = True
            if not check_only:
                write_version(paths[source_id], current_version, new_version)
            next_lock[source_id] = {"version": new_version, "resolvers": current_resolvers}
            continue

        # Nothing to do, but keep the recorded version in step with a bump the author made for
        # their own reasons, so the "already bumped" branch above stays meaningful next time.
        next_lock[source_id] = {"version": current_version, "resolvers": current_resolvers}

    if not check_only:
        write_lock(next_lock)
    return messages, bumped


def main() -> int:
    check_only = "--check" in sys.argv
    try:
        messages, bumped = sync(check_only)
    except ManifestError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    for message in messages:
        print(message)
    if not messages:
        print("no resolver dependency changes")
    if check_only and bumped:
        print("error: source versions are out of date with their resolvers", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
