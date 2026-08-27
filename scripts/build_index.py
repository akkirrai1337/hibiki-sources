#!/usr/bin/env python3
"""Regenerates repository/index.json from extensions/*.json.

Every field in the index is derived entirely from the extension manifests, so there is no manual
seed step - a brand-new extensions/<id>.json is picked up automatically the next time this runs.
The index deliberately omits `payload` (Hibiki fetches the full extensions/<id>.json for that);
it only carries what a marketplace listing UI needs plus a `manifestUrl` pointing at the real file.

Usage: python scripts/build_index.py [--check]
  --check   validate every extensions/*.json manifest and exit non-zero on the first problem,
            without writing repository/index.json. Used by CI on pull requests, where the index
            file isn't expected to be regenerated yet (that happens on push to main instead).
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
EXTENSIONS_DIR = REPO_ROOT / "extensions"
INDEX_PATH = REPO_ROOT / "repository" / "index.json"
RAW_BASE_URL = "https://raw.githubusercontent.com/akkirrai1337/hibiki-sources/main/extensions"

ID_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SEMVER_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")
REQUIRED_FIELDS = ["id", "name", "version", "lang", "payload", "capabilities"]
REQUIRED_CAPABILITIES = {"LATEST_RELEASES", "PLAYBACK"}


class ManifestError(ValueError):
    pass


def load_manifest(path: Path) -> dict:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ManifestError(f"{path.name}: invalid JSON ({error})") from error

    for field in REQUIRED_FIELDS:
        if not manifest.get(field):
            raise ManifestError(f"{path.name}: missing required field '{field}'")

    if manifest["id"] != path.stem:
        raise ManifestError(f"{path.name}: manifest id '{manifest['id']}' must match the filename")
    if not ID_PATTERN.match(manifest["id"]):
        raise ManifestError(f"{path.name}: id must be a lowercase slug")
    if not SEMVER_PATTERN.match(manifest["version"]):
        raise ManifestError(f"{path.name}: version must be basic semver (x.y.z)")
    capabilities = set(manifest["capabilities"])
    if not REQUIRED_CAPABILITIES.issubset(capabilities):
        raise ManifestError(
            f"{path.name}: capabilities must include {sorted(REQUIRED_CAPABILITIES)} "
            "(current ScriptedAnimeSource requires both on every extension)"
        )
    return manifest


def build_index() -> dict:
    entries = []
    errors: list[str] = []
    for path in sorted(EXTENSIONS_DIR.glob("*.json")):
        try:
            manifest = load_manifest(path)
        except ManifestError as error:
            errors.append(str(error))
            continue
        entries.append(
            {
                "id": manifest["id"],
                "name": manifest["name"],
                "version": manifest["version"],
                "description": manifest.get("description"),
                "author": manifest.get("author"),
                "website": manifest.get("website"),
                "iconUrl": manifest.get("iconUrl"),
                "lang": manifest["lang"],
                "capabilities": manifest["capabilities"],
                "manifestUrl": f"{RAW_BASE_URL}/{path.name}",
            }
        )

    if errors:
        raise ManifestError("\n".join(errors))

    return {"schemaVersion": 1, "extensions": entries}


def main() -> int:
    check_only = "--check" in sys.argv
    try:
        index = build_index()
    except ManifestError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    if check_only:
        print(f"{len(index['extensions'])} extension manifest(s) are valid")
        return 0

    rendered = json.dumps(index, ensure_ascii=False, indent=2) + "\n"
    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    INDEX_PATH.write_text(rendered, encoding="utf-8")
    print(f"wrote {len(index['extensions'])} extension(s) to {INDEX_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
