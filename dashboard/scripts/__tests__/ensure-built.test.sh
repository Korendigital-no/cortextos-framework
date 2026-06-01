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
#   1. no .next/BUILD_ID                      -> BUILD   (first boot)
#   2. BUILD_ID + .build-commit == HEAD       -> SKIP    (current, restart-storm safe)
#   3. BUILD_ID + .build-commit != HEAD       -> BUILD   (source advanced = stale)
#   4. BUILD_ID + no .build-commit            -> BUILD   (provenance unknown)
#   5. BUILD_ID + not a git checkout          -> SKIP    (graceful, e.g. tarball deploy)

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
  mkdir -p .next
  echo "fake-build-id" > .next/BUILD_ID
  git log -1 --format=%H -- . > .next/.build-commit 2>/dev/null || true
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

echo ""
echo "ensure-built guard: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
