#!/usr/bin/env bash
# Idempotent first-boot build helper + STAGING SWAP. Prestart hook runs this
# BEFORE next start — the only context allowed to touch the serve dir.
#
# DIST-DIR ISOLATION (task_1780688854348): every build writes .next-build and
# `next dev` writes .next-dev (NEXT_DIST_DIR from package.json scripts); the
# serve dir .next changes ONLY here, in the service-stopped prestart window.
# This closes the split-brain class from the 2026-06-05 prod incident: a local
# build overwrote .next under a running next-server — HTML served from new
# disk, assets resolved from the old in-memory manifest -> CSS 404, unstyled
# dashboard on Vilhelm's phone.
#
# COMPLETION GATE (cross-review KREVD-1): a staging build is swapped in only
# when .next-build/.build-commit exists. Next writes BUILD_ID BEFORE static
# assets are complete, so a build killed mid-write (OOM/SIGKILL/disk-full)
# leaves BUILD_ID but a broken tree; .build-commit is written by the
# postbuild:prod hook = a true "build finished" stamp.
#
# INTERRUPTED-SWAP RECOVERY (KREVD-2): the swap parks the previous good build
# as .next.old before moving staging in. If the process dies between the two
# mv's, the next prestart finds serve-dir missing + a COMPLETE .next.old and
# restores it in ~ms instead of rebuilding for ~90s. .next.old doubles as a
# manual rollback: `mv .next.old .next`.
#
# Staleness logic (unchanged in spirit): builds are stamped with the
# dashboard-source commit; we rebuild when the source advanced past the
# stamp, and skip during restart-storms (HEAD unchanged). Rebuild-on-stale
# (auto-heal) over fail-loud: a prestart hook should make the service
# correct, not refuse to start.
#
# To force a rebuild: rm -rf .next-build && npm run build:prod, then restart
# (prestart swaps it in), or delete .next/BUILD_ID for the full first-boot path.

set -uo pipefail

DIST_SERVE=".next"
DIST_STAGING=".next-build"
DIST_OLD=".next.old"

# Swap a COMPLETE staging build into the serve dir. Returns 1 (no-op) when
# staging is absent or incomplete — an unstamped staging tree is a killed
# build, never something to serve (KREVD-1).
swap_in_staging() {
  if [[ ! -f "$DIST_STAGING/.build-commit" ]]; then
    if [[ -d "$DIST_STAGING" ]]; then
      echo "[ensure-built] $DIST_STAGING exists but has no .build-commit (interrupted build) — ignoring it."
    fi
    return 1
  fi
  # Single rollback generation by design (cross-review (b)): OLD is removed
  # only AFTER the replacement staging is verified complete (the stamp check
  # above), so the loss window sacrifices the N-2 generation, never
  # current-good — if we die between the mv's, OLD is the just-parked serve
  # dir and the 0b-recovery restores it. Two generations = complexity
  # without a real win.
  rm -rf "$DIST_OLD"
  [[ -d "$DIST_SERVE" ]] && mv "$DIST_SERVE" "$DIST_OLD"
  mv "$DIST_STAGING" "$DIST_SERVE"
  echo "[ensure-built] Swapped staging build into $DIST_SERVE (previous parked as $DIST_OLD)."
  return 0
}

# Build to staging, then swap. NOT exec (KREVD-3): exec replaces the process,
# so nothing after the build would run and the staging build would never be
# swapped in — the server would keep serving the old (or no) build, which is
# the exact silent failure this redesign exists to end.
build_and_swap() {
  rm -rf "$DIST_STAGING"  # hygiene: never build on top of a killed build's tree
  npm run build:prod || { echo "[ensure-built] Build FAILED — refusing to touch $DIST_SERVE."; exit 1; }
  swap_in_staging || { echo "[ensure-built] Build completed but staging has no completion stamp — refusing to swap."; exit 1; }
}

# 0) A complete staging build waiting? Swap it in first — this is the normal
#    deploy flow (build ran while the service was up; we are now stopped).
swap_in_staging || true

# 0b) Interrupted-swap recovery (KREVD-2): serve dir gone but the parked
#     previous build is complete — restore it, then let the staleness check
#     decide if it needs a rebuild.
if [[ ! -f "$DIST_SERVE/BUILD_ID" && -f "$DIST_OLD/.build-commit" ]]; then
  echo "[ensure-built] $DIST_SERVE missing but $DIST_OLD holds a complete build — restoring (interrupted swap)."
  mv "$DIST_OLD" "$DIST_SERVE"
fi

# 1) Fresh install / serve dir cleared -> first-boot build.
if [[ ! -f "$DIST_SERVE/BUILD_ID" ]]; then
  echo "[ensure-built] No $DIST_SERVE/BUILD_ID — running first-boot build."
  build_and_swap
  exit 0
fi

# 2) Serve dir exists. Decide whether it is stale relative to checked-out source.
current_commit="$(git log -1 --format=%H -- . 2>/dev/null || true)"

# Not a git checkout (e.g. a tarball deploy) — we cannot reason about staleness,
# so trust the existing build rather than rebuild on every boot.
if [[ -z "$current_commit" ]]; then
  echo "[ensure-built] $DIST_SERVE/BUILD_ID present, not a git checkout — skipping build."
  exit 0
fi

built_commit=""
[[ -f "$DIST_SERVE/.build-commit" ]] && built_commit="$(cat "$DIST_SERVE/.build-commit" 2>/dev/null || true)"

if [[ "$built_commit" == "$current_commit" ]]; then
  echo "[ensure-built] $DIST_SERVE build is current (commit ${current_commit:0:12}), skipping build."
  exit 0
fi

if [[ -z "$built_commit" ]]; then
  echo "[ensure-built] $DIST_SERVE/BUILD_ID present but build provenance unknown — rebuilding to be safe."
else
  echo "[ensure-built] Dashboard source advanced (${built_commit:0:12} -> ${current_commit:0:12}) — rebuilding stale $DIST_SERVE."
fi
build_and_swap
