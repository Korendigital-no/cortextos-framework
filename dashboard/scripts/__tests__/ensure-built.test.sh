#!/usr/bin/env bash
#
# Standalone test for ensure-built.sh stale-build guard.
#
# ensure-built.sh is a prestart hook (not run in CI), so this test is run
# manually:  bash dashboard/scripts/__tests__/ensure-built.test.sh
#
# It exercises the build/skip decision in a throwaway git sandbox with a
# stubbed `npm`, so it never triggers a real `next build`.
#
# Cases:
#   1. no .next/BUILD_ID                      -> BUILD + swap  (first boot)
#   2. BUILD_ID + .build-commit == HEAD       -> SKIP    (current, restart-storm safe)
#   3. BUILD_ID + .build-commit != HEAD       -> BUILD + swap  (source advanced = stale)
#   4. BUILD_ID + no .build-commit            -> BUILD   (provenance unknown)
#   5. BUILD_ID + not a git checkout          -> SKIP    (graceful, e.g. tarball deploy)
#   6. complete staging waiting               -> SWAP, NO build (deploy flow)
#   7. staging WITHOUT .build-commit          -> ignored (KREVD-1: killed build never served)
#   8. serve missing + complete .next.old     -> RESTORE, no build (KREVD-2: interrupted swap)
#   9. swap parks previous serve as .next.old (rollback candidate)

set -uo pipefail

SCRIPT_UNDER_TEST="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/ensure-built.sh"
PASS=0
FAIL=0

fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
pass() { echo "  ok:   $1"; PASS=$((PASS + 1)); }

# Build a throwaway sandbox: a git repo whose cwd plays the role of dashboard/.
# A stub `npm` on PATH records invocation instead of running next build.
make_sandbox() {
  local sb
  sb="$(mktemp -d)"
  mkdir -p "$sb/bin"
  cat > "$sb/bin/npm" <<'STUB'
#!/usr/bin/env bash
# Stub npm: simulate `npm run build:prod` + its postbuild stamp.
if [[ "${1:-}" == "run" && "${2:-}" == "build:prod" ]]; then
  echo "STUB_NPM_BUILD_INVOKED"
  # Mirrors the real build:prod: writes the STAGING dir (NEXT_DIST_DIR=.next-build)
  # and the postbuild completion stamp. ensure-built owns the swap into .next.
  mkdir -p .next-build
  echo "fake-build-id" > .next-build/BUILD_ID
  git log -1 --format=%H -- . > .next-build/.build-commit 2>/dev/null || true
  exit 0
fi
echo "STUB_NPM_UNEXPECTED_ARGS: $*" >&2
exit 1
STUB
  chmod +x "$sb/bin/npm"
  mkdir -p "$sb/repo/dashboard"
  (
    cd "$sb/repo"
    git init -q
    git config user.email t@t.t
    git config user.name t
    echo "v1" > dashboard/page.tsx
    git add -A && git commit -qm "c1"
  )
  echo "$sb"
}

# run_case <expect: BUILD|SKIP> <description>; reads sandbox dir from $SB,
# runs the script from $SB/repo/dashboard with stub npm on PATH.
run_case() {
  local expect="$1" desc="$2" out
  out="$(cd "$SB/repo/dashboard" && PATH="$SB/bin:$PATH" bash "$SCRIPT_UNDER_TEST" 2>&1)"
  if [[ "$expect" == "BUILD" ]]; then
    if grep -q "STUB_NPM_BUILD_INVOKED" <<<"$out"; then pass "$desc"; else fail "$desc (expected BUILD, got: $out)"; fi
  else
    if grep -q "STUB_NPM_BUILD_INVOKED" <<<"$out"; then fail "$desc (expected SKIP, but built: $out)"; else pass "$desc"; fi
  fi
}

# Case 1: no .next/BUILD_ID -> BUILD
SB="$(make_sandbox)"
run_case BUILD "case1: no BUILD_ID triggers first-boot build"
rm -rf "$SB"

# Case 2: BUILD_ID + .build-commit == HEAD -> SKIP
SB="$(make_sandbox)"
(
  cd "$SB/repo/dashboard"
  mkdir -p .next; echo id > .next/BUILD_ID
  git log -1 --format=%H -- . > .next/.build-commit
)
run_case SKIP "case2: build current (commit matches HEAD) skips"
rm -rf "$SB"

# Case 3: BUILD_ID + .build-commit != HEAD (source advanced) -> BUILD
SB="$(make_sandbox)"
(
  cd "$SB/repo/dashboard"
  mkdir -p .next; echo id > .next/BUILD_ID
  echo "stale-old-commit-sha" > .next/.build-commit
  # advance dashboard source so HEAD differs from stamped commit
  echo "v2" > page.tsx
  cd "$SB/repo" && git add -A && git commit -qm "c2 dashboard change"
)
run_case BUILD "case3: source advanced past stamped commit rebuilds stale .next"
rm -rf "$SB"

# Case 4: BUILD_ID + no .build-commit -> BUILD (provenance unknown)
SB="$(make_sandbox)"
(
  cd "$SB/repo/dashboard"
  mkdir -p .next; echo id > .next/BUILD_ID
  # deliberately no .build-commit
)
run_case BUILD "case4: missing provenance sentinel rebuilds to be safe"
rm -rf "$SB"

# Case 5: BUILD_ID + not a git checkout -> SKIP (graceful)
SB="$(make_sandbox)"
NONGIT="$(mktemp -d)"
mkdir -p "$NONGIT/dashboard/.next"
echo id > "$NONGIT/dashboard/.next/BUILD_ID"
out="$(cd "$NONGIT/dashboard" && PATH="$SB/bin:$PATH" bash "$SCRIPT_UNDER_TEST" 2>&1)"
if grep -q "STUB_NPM_BUILD_INVOKED" <<<"$out"; then
  fail "case5: non-git checkout should skip, but built: $out"
else
  pass "case5: non-git checkout skips gracefully"
fi
rm -rf "$SB" "$NONGIT"

# Case 6: complete staging waiting -> swapped in WITHOUT building (deploy flow)
SB="$(make_sandbox)"
(
  cd "$SB/repo/dashboard"
  mkdir -p .next-build; echo staging-id > .next-build/BUILD_ID
  git log -1 --format=%H -- . > .next-build/.build-commit
)
run_case SKIP "case6: complete staging swaps in without a build"
if [[ -f "$SB/repo/dashboard/.next/BUILD_ID" && ! -d "$SB/repo/dashboard/.next-build" ]]; then
  pass "case6b: staging became the serve dir"
else
  fail "case6b: staging was not swapped into .next"
fi
rm -rf "$SB"

# Case 7: staging WITHOUT .build-commit (killed build) -> ignored, first-boot path builds
SB="$(make_sandbox)"
(
  cd "$SB/repo/dashboard"
  mkdir -p .next-build; echo half-written > .next-build/BUILD_ID
  # deliberately NO .build-commit — BUILD_ID alone must never be trusted (KREVD-1)
)
run_case BUILD "case7: unstamped staging is ignored and a fresh build runs"
rm -rf "$SB"

# Case 8: serve missing + COMPLETE .next.old -> restored without building (KREVD-2)
SB="$(make_sandbox)"
(
  cd "$SB/repo/dashboard"
  mkdir -p .next.old; echo old-id > .next.old/BUILD_ID
  git log -1 --format=%H -- . > .next.old/.build-commit
)
run_case SKIP "case8: interrupted swap restores .next.old without a build"
if [[ -f "$SB/repo/dashboard/.next/BUILD_ID" && ! -d "$SB/repo/dashboard/.next.old" ]]; then
  pass "case8b: .next.old became the serve dir"
else
  fail "case8b: .next.old was not restored into .next"
fi
rm -rf "$SB"

# Case 9: swap parks the previous serve dir as .next.old (rollback candidate)
SB="$(make_sandbox)"
(
  cd "$SB/repo/dashboard"
  mkdir -p .next; echo previous-id > .next/BUILD_ID
  git log -1 --format=%H -- . > .next/.build-commit
  mkdir -p .next-build; echo staging-id > .next-build/BUILD_ID
  git log -1 --format=%H -- . > .next-build/.build-commit
)
run_case SKIP "case9: staging swap with existing serve dir skips build"
if [[ "$(cat "$SB/repo/dashboard/.next/BUILD_ID")" == "staging-id" && "$(cat "$SB/repo/dashboard/.next.old/BUILD_ID")" == "previous-id" ]]; then
  pass "case9b: previous build parked as .next.old, staging promoted"
else
  fail "case9b: swap did not park previous build correctly"
fi
rm -rf "$SB"

echo ""
echo "ensure-built guard: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
