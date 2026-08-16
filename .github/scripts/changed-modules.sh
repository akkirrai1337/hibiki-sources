#!/usr/bin/env bash
# Lists top-level directories that changed since $1 (a git ref/SHA) and are
# real Gradle modules (contain their own build.gradle.kts). New modules are
# picked up automatically -- nothing here needs editing when a source is added.
set -euo pipefail

base="${1:-HEAD~1}"

git diff --name-only "$base" HEAD \
  | awk -F/ '{print $1}' \
  | sort -u \
  | while read -r dir; do
      [ -n "$dir" ] && [ -f "$dir/build.gradle.kts" ] && echo "$dir"
      true
    done
