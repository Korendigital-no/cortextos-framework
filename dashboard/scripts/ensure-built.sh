#!/usr/bin/env bash
# Idempotent first-boot build helper. Prestart hook runs this BEFORE next start.
#
# If .next/BUILD_ID exists, the prior build is reusable — skip the expensive
# rebuild. This prevents launchd/pm2 restart-storms from triggering rebuilds
# on every supervisor retry. Build only when the dashboard genuinely needs it
# (fresh install or after `git pull` cleared .next).
#
# To force a rebuild, the operator (or post-deploy hook) deletes .next/BUILD_ID
# or runs `npm run build:prod` manually.

set -uo pipefail

if [[ -f ".next/BUILD_ID" ]]; then
  echo "[ensure-built] .next/BUILD_ID present, skipping build."
  exit 0
fi

echo "[ensure-built] No .next/BUILD_ID — running first-boot build."
exec npm run build:prod
