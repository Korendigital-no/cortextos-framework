#!/usr/bin/env bash
# Idempotent first-boot build helper. Prestart hook runs this BEFORE next start.
#
# Goal: serve a build that matches the checked-out source, WITHOUT triggering a
# rebuild on every launchd/pm2 restart-storm retry.
#
# The old version skipped the rebuild whenever .next/BUILD_ID existed. That made
# a stale .next survive forever after the source advanced (e.g. a deploy that
# rebuilt the framework but not the dashboard, or a `git pull` that left .next in
# place) — the recurring "committed != running" trap.
#
# This version stamps each build with the dashboard-source commit it was built
# from (.next/.build-commit, written by scripts/stamp-build-commit.sh via the
# build:prod postbuild hook) and rebuilds when the source has advanced past it.
# During a restart-storm HEAD is unchanged, so it still skips — preserving the
# anti-restart-storm behavior. Rebuild-on-stale (auto-heal) is deliberately
# chosen over fail-loud: a prestart hook should make the service correct, not
# refuse to start.
#
# To force a rebuild, delete .next/BUILD_ID or run `npm run build:prod`.

set -uo pipefail

# Fresh install / .next cleared -> first-boot build.
if [[ ! -f ".next/BUILD_ID" ]]; then
  echo "[ensure-built] No .next/BUILD_ID — running first-boot build."
  exec npm run build:prod
fi

# .next exists. Decide whether it is stale relative to the checked-out source.
current_commit="$(git log -1 --format=%H -- . 2>/dev/null || true)"

# Not a git checkout (e.g. a tarball deploy) — we cannot reason about staleness,
# so trust the existing build rather than rebuild on every boot.
if [[ -z "$current_commit" ]]; then
  echo "[ensure-built] .next/BUILD_ID present, not a git checkout — skipping build."
  exit 0
fi

built_commit=""
[[ -f ".next/.build-commit" ]] && built_commit="$(cat ".next/.build-commit" 2>/dev/null || true)"

if [[ "$built_commit" == "$current_commit" ]]; then
  echo "[ensure-built] .next build is current (commit ${current_commit:0:12}), skipping build."
  exit 0
fi

if [[ -z "$built_commit" ]]; then
  echo "[ensure-built] .next/BUILD_ID present but build provenance unknown — rebuilding to be safe."
else
  echo "[ensure-built] Dashboard source advanced (${built_commit:0:12} -> ${current_commit:0:12}) — rebuilding stale .next."
fi
exec npm run build:prod
