#!/usr/bin/env python3
"""Updates repository/index.json for one just-built module and moves its
release APK into artifacts/. The module must already have a matching entry
in repository/index.json (keyed by packageName) -- this script updates an
existing source, it does not register a brand-new one."""

import hashlib
import json
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
INDEX_PATH = os.path.join(REPO_ROOT, "repository", "index.json")
ARTIFACTS_DIR = os.path.join(REPO_ROOT, "artifacts")
ARTIFACT_URL_PREFIX = "https://raw.githubusercontent.com/akkirrai1337/hibiki-sources/main/artifacts"


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: update-index.py <module>", file=sys.stderr)
        sys.exit(1)
    module = sys.argv[1]

    metadata_path = os.path.join(
        REPO_ROOT, module, "build", "outputs", "apk", "release", "output-metadata.json",
    )
    if not os.path.isfile(metadata_path):
        print(f"No release output-metadata.json for module '{module}' at {metadata_path}", file=sys.stderr)
        sys.exit(1)

    with open(metadata_path, encoding="utf-8") as handle:
        metadata = json.load(handle)

    application_id = metadata["applicationId"]
    element = metadata["elements"][0]
    version_code = element["versionCode"]
    version_name = element["versionName"]
    apk_path = os.path.join(
        REPO_ROOT, module, "build", "outputs", "apk", "release", element["outputFile"],
    )
    if not os.path.isfile(apk_path):
        print(f"Built APK not found at {apk_path}", file=sys.stderr)
        sys.exit(1)

    with open(INDEX_PATH, encoding="utf-8") as handle:
        index = json.load(handle)

    entry = next(
        (source for source in index["sources"] if source["packageName"] == application_id),
        None,
    )
    if entry is None:
        print(
            f"No repository/index.json entry for packageName '{application_id}'. "
            "Add one manually the first time a source is published, then rebuilds "
            "will update it automatically.",
            file=sys.stderr,
        )
        sys.exit(1)

    os.makedirs(ARTIFACTS_DIR, exist_ok=True)
    artifact_name = f"{entry['id']}-{version_name}.apk"
    dest_path = os.path.join(ARTIFACTS_DIR, artifact_name)
    os.replace(apk_path, dest_path)

    entry["version"] = version_name
    entry["versionCode"] = version_code
    entry["apkUrl"] = f"{ARTIFACT_URL_PREFIX}/{artifact_name}"
    entry["sha256"] = sha256_file(dest_path)
    entry["sizeBytes"] = os.path.getsize(dest_path)

    with open(INDEX_PATH, "w", encoding="utf-8") as handle:
        json.dump(index, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

    print(f"Updated {entry['id']} -> version {version_name} ({dest_path})")


if __name__ == "__main__":
    main()
