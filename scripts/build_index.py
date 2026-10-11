#!/usr/bin/env python3
"""Regenerates repository/index.json from extension source and resolver manifests.

Each extension is two files, not one: `<id>.manifest.json` (metadata only - no JS) and `<id>.js`
(the actual payload, plain readable JavaScript). They're kept separate specifically so the JS is
never embedded as an escaped one-line JSON string - a manifest with the payload inlined is
unreadable/undiffable in a text editor or on GitHub. Hibiki fetches both when installing: the
manifest, then `<id>.js` (same URL with `.manifest.json` swapped for `.js` - see
ExtensionMarketplaceClient's `payloadUrlFor` on the app side), and merges them into one on-device
file at install time. That merge point is the only place a full single-file manifest+payload ever
exists.

Every field in the index is derived entirely from the manifests, so there is no manual seed step -
a brand-new extensions/<id>.manifest.json + <id>.js pair is picked up automatically next run.

Usage: python scripts/build_index.py [--check]
  --check   validate every extensions/*.manifest.json (and its sibling .js) and exit non-zero on
            the first problem, without writing repository/index.json. Used by CI on pull requests,
            where the index file isn't expected to be regenerated yet (that happens on push to
            main instead).
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
REQUIRED_FIELDS = ["id", "name", "version"]
REQUIRED_CAPABILITIES = {"LATEST_RELEASES", "PLAYBACK"}
MANIFEST_SUFFIX = ".manifest.json"

# What the app gives extension scripts, by the `hostApi` level that introduced it - the app's
# HOST_API (hibiki-desktop src/shared/hostApi.ts). A manifest may declare `"hostApi": N`; an app
# whose HOST_API is lower then keeps the version it has instead of installing one that would break.
# A manifest without it is never checked by the app, so this refuses to publish a script that uses
# anything above level 1 without declaring at least that level.
#
# When the app gets something new for scripts: raise LATEST_HOST_API and HOST_API together, and add
# a pattern for it here at the new level.
LATEST_HOST_API = 1
HOST_API_FEATURES: list[tuple[int, str, re.Pattern[str]]] = [
    # Level 1: everything scripts had when hostApi was introduced. Listed so the table is complete;
    # nothing at this level ever needs a declaration.
    (1, "fetch", re.compile(r"\bfetch\s*\(")),
    (1, "fetchAll", re.compile(r"\bfetchAll\s*\(")),
    (1, "storage", re.compile(r"\bstorage\.(?:get|set|remove)\b")),
    (1, "challenge", re.compile(r"\bchallenge\s*\(")),
    (1, "browserFetch", re.compile(r"\bbrowserFetch\s*\(")),
    (1, "Jsoup", re.compile(r"\bJsoup\.")),
    (1, "Gzip", re.compile(r"\bGzip\.")),
    (1, "Url", re.compile(r"\bUrl\.")),
    (1, "AnimeTitle", re.compile(r"\bAnimeTitle\b")),
    (1, "link.dataSaver", re.compile(r"\.dataSaver\b")),
]


def check_host_api(path: Path, manifest: dict, payload: str) -> None:
    declared = manifest.get("hostApi")
    if declared is not None and (not isinstance(declared, int) or isinstance(declared, bool) or declared < 1):
        raise ManifestError(f"{path.name}: hostApi must be a positive integer")
    if declared is not None and declared > LATEST_HOST_API:
        raise ManifestError(f"{path.name}: hostApi {declared} is newer than any app ({LATEST_HOST_API})")
    used = [(level, name) for level, name, pattern in HOST_API_FEATURES if pattern.search(payload)]
    needed = max((level for level, _ in used), default=1)
    if needed > 1 and (declared is None or declared < needed):
        names = ", ".join(name for level, name in used if level == needed)
        raise ManifestError(
            f"{path.name}: uses {names} (hostApi {needed}) but declares "
            f"{'no hostApi' if declared is None else f'hostApi {declared}'} - older apps would install it and break"
        )


class ManifestError(ValueError):
    pass


def load_manifest(path: Path) -> dict:
    stem = path.name.removesuffix(MANIFEST_SUFFIX)
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ManifestError(f"{path.name}: invalid JSON ({error})") from error

    if manifest.get("payload"):
        raise ManifestError(
            f"{path.name}: must not embed an inline 'payload' - put the JS in the sibling {stem}.js instead"
        )
    for field in REQUIRED_FIELDS:
        if not manifest.get(field):
            raise ManifestError(f"{path.name}: missing required field '{field}'")

    if manifest["id"] != stem:
        raise ManifestError(f"{path.name}: manifest id '{manifest['id']}' must match the filename ({stem})")
    if not ID_PATTERN.match(manifest["id"]):
        raise ManifestError(f"{path.name}: id must be a lowercase slug")
    if not SEMVER_PATTERN.match(manifest["version"]):
        raise ManifestError(f"{path.name}: version must be basic semver (x.y.z)")
    extension_type = manifest.get("type", "source")
    if extension_type == "source":
        for field in ("lang", "capabilities"):
            if not manifest.get(field):
                raise ManifestError(f"{path.name}: source is missing required field '{field}'")
        capabilities = set(manifest["capabilities"])
        if not REQUIRED_CAPABILITIES.issubset(capabilities):
            raise ManifestError(f"{path.name}: source capabilities must include {sorted(REQUIRED_CAPABILITIES)}")
    elif extension_type == "player-resolver":
        if not manifest.get("hosts"):
            raise ManifestError(f"{path.name}: resolver must declare hosts")
    else:
        raise ManifestError(f"{path.name}: unsupported extension type '{extension_type}'")

    payload_path = path.with_name(f"{stem}.js")
    if not payload_path.is_file():
        raise ManifestError(f"{path.name}: missing sibling payload file {payload_path.name}")
    payload = payload_path.read_text(encoding="utf-8")
    if not payload.strip():
        raise ManifestError(f"{payload_path.name}: payload must not be blank")
    check_host_api(path, manifest, payload)

    return manifest


def build_index() -> dict:
    entries = []
    errors: list[str] = []
    for path in sorted(EXTENSIONS_DIR.rglob(f"*{MANIFEST_SUFFIX}")):
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
                "author": manifest.get("author"),
                "website": manifest.get("website"),
                "iconUrl": manifest.get("iconUrl"),
                "lang": manifest.get("lang", ""),
                "capabilities": manifest.get("capabilities", []),
                "resolverDependencies": manifest.get("resolverDependencies", []),
                "isNsfw": manifest.get("isNsfw", False),
                "type": manifest.get("type", "source"),
                "manifestUrl": f"{RAW_BASE_URL}/{path.relative_to(EXTENSIONS_DIR).as_posix()}",
                # Only when declared: an app reads a missing one as "don't check".
                **({"hostApi": manifest["hostApi"]} if "hostApi" in manifest else {}),
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
