"""Tests for mmrag path-skip logic.

Regression coverage for the skip-dir collision bug: a file living under a
directory segment named like a build-output dir (build/, dist/, coverage/, ...)
was silently dropped from ingestion even when passed explicitly. The junk-dir
and junk-name filters must apply only to directory traversal (rglob discovery),
never to a file the caller named on purpose.

Runs under pytest if available, or standalone:
    knowledge-base/venv/bin/python knowledge-base/scripts/test_mmrag_skip.py
"""
import importlib.util
import os
from pathlib import Path

# Import mmrag.py by path without triggering any network/config IO.
os.environ.setdefault("MMRAG_DIR", "/tmp/mmrag-test")
_spec = importlib.util.spec_from_file_location(
    "mmrag", str(Path(__file__).with_name("mmrag.py"))
)
mmrag = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mmrag)


# ---- explicit files must always be honored (the bug) --------------------
def test_explicit_file_under_build_dir_is_not_skipped():
    p = Path("/Users/x/vault/02-areas/SOPs/build/niche-agent-template-patterns.md")
    assert mmrag.should_skip_path(p, explicit=True) is None


def test_explicit_file_under_dist_dir_is_not_skipped():
    assert mmrag.should_skip_path(Path("/repo/dist/report.md"), explicit=True) is None


def test_explicit_junk_named_file_is_not_skipped():
    # If a caller explicitly points at a .gitignore they mean it.
    assert mmrag.should_skip_path(Path("/repo/.gitignore"), explicit=True) is None


# ---- directory traversal must still skip junk ---------------------------
def test_traversal_file_under_build_dir_is_skipped():
    p = Path("/Users/x/vault/02-areas/SOPs/build/whatever.md")
    assert mmrag.should_skip_path(p, explicit=False) is not None


def test_traversal_node_modules_is_skipped():
    assert mmrag.should_skip_path(Path("/repo/node_modules/a.js"), explicit=False) is not None


def test_traversal_junk_name_is_skipped():
    assert mmrag.should_skip_path(Path("/repo/package-lock.json"), explicit=False) is not None


# ---- normal files are never skipped, either mode ------------------------
def test_normal_file_not_skipped_traversal():
    assert mmrag.should_skip_path(Path("/repo/orgs/x/notes.md"), explicit=False) is None


def test_normal_file_not_skipped_explicit():
    assert mmrag.should_skip_path(Path("/repo/orgs/x/notes.md"), explicit=True) is None


if __name__ == "__main__":
    # Standalone runner (no pytest dependency).
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {t.__name__}: {e!r}")
        except Exception as e:  # surface import/logic errors loudly
            failed += 1
            print(f"ERROR {t.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    raise SystemExit(1 if failed else 0)
