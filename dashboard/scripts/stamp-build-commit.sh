#!/usr/bin/env bash
# Stamp the just-completed .next build with the dashboard-source commit it was
# built from. Wired as the build:prod postbuild hook so both manual deploys
# (`npm run build:prod`) and the ensure-built prestart hook produce a stamped
# build. ensure-built.sh reads .next/.build-commit on later boots to detect a
# stale build (source advanced past the build) instead of blindly trusting that
# .next/BUILD_ID merely exists.
#
# Safe to no-op: outside a git checkout, or before .next exists, it does nothing
# and never fails the build.

set -uo pipefail

# Dist dir: explicit arg (npm post-hooks run as separate processes, so the
# build command's inline env does NOT reach us) > env > serve-dir default.
dist="${1:-${NEXT_DIST_DIR:-.next}}"

commit="$(git log -1 --format=%H -- . 2>/dev/null || true)"
if [[ -n "$commit" && -d "$dist" ]]; then
  printf '%s\n' "$commit" > "$dist/.build-commit"
  echo "[stamp-build] Stamped $dist build @ ${commit:0:12}"
fi
exit 0
