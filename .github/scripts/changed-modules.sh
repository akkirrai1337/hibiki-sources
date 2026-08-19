#!/usr/bin/env bash
# Lists Gradle module directories (paths, e.g. "extensions/aniliberty") that
# changed since $1 (a git ref/SHA) -- found by walking each changed file's
# path up to the nearest ancestor directory containing its own
# build.gradle.kts. Works regardless of nesting depth, so new modules and
# new module groups are picked up automatically -- nothing here needs
# editing when a source is added.
set -euo pipefail

base="${1:-HEAD~1}"

git diff --name-only "$base" HEAD \
  | while read -r path; do
      [ -z "$path" ] && continue
      dir=$(dirname "$path")
      while [ "$dir" != "." ] && [ ! -f "$dir/build.gradle.kts" ]; do
        dir=$(dirname "$dir")
      done
      [ "$dir" != "." ] && [ -f "$dir/build.gradle.kts" ] && echo "$dir"
    done | sort -u
