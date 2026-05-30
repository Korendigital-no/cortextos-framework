import { describe, it, expect } from "vitest";
import { commitAndPushContentFile, type GitRunner } from "../content-git";

/**
 * The "edit body" save must make a content edit canonical (commit + push to
 * origin/main) and SURFACE the outcome — the original bug was a silent
 * no-persist that left the editor and the live site diverged.
 */
// Default mock: on a clean main at origin/main tip, with a staged change.
// Keyed by the git subcommand; `rev-list` returns "0" (no unpushed commits),
// `rev-parse` returns "main", `diff` exits 1 (something staged).
function runnerFrom(overrides: Record<string, { status: number; stdout?: string; stderr?: string }> = {}): { run: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const base: Record<string, { status: number; stdout?: string; stderr?: string }> = {
    remote: { status: 0, stdout: "https://github.com/Korendigital-no/Korendigital-nettside.git\n" },
    "rev-parse": { status: 0, stdout: "main\n" },
    fetch: { status: 0 },
    "rev-list": { status: 0, stdout: "0\n" },
    add: { status: 0 },
    diff: { status: 1 }, // staged change present
    commit: { status: 0 },
    push: { status: 0 },
  };
  const run: GitRunner = (_cwd, args) => {
    calls.push(args);
    const r = overrides[args[0]] ?? base[args[0]] ?? { status: 0 };
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { run, calls };
}

const REPO = "/tmp/site";
const REL = "content/blog/hvem-koren-digital-er.md";

describe("commitAndPushContentFile", () => {
  it("on clean main: stages only the given path, commits, pushes origin main → saved + live", async () => {
    const { run, calls } = runnerFrom();
    const res = await commitAndPushContentFile(REPO, REL, "content: edit hvem", run);
    expect(res).toEqual({ ok: true, pushed: true, kind: "pushed", message: "Saved and pushed to origin/main." });
    // never `git add -A` — only the single path
    expect(calls.find((c) => c[0] === "add")).toEqual(["add", "--", REL]);
    expect(calls.some((c) => c[0] === "add" && (c.includes("-A") || c.includes(".")))).toBe(false);
    expect(calls.find((c) => c[0] === "push")).toEqual(["push", "origin", "main"]);
  });

  it("REFUSES to push when the clone origin is a stale/wrong remote (codex P2: never falsely report live)", async () => {
    const { run, calls } = runnerFrom({ remote: { status: 0, stdout: "https://github.com/vkoren04/old-fork.git\n" } });
    const res = await commitAndPushContentFile(REPO, REL, "msg", run);
    expect(res.ok).toBe(true);
    expect(res.pushed).toBe(false);
    expect(res.message).toContain("origin");
    expect(res.message).toContain("did not reach the canonical repo");
    expect(calls.some((c) => c[0] === "commit" || c[0] === "push")).toBe(false);
  });

  it("REFUSES to push when the clone is NOT on main (codex P1: avoids deploying a recovery/publish branch)", async () => {
    const { run, calls } = runnerFrom({ "rev-parse": { status: 0, stdout: "content-edits-recovery-2026-05-30\n" } });
    const res = await commitAndPushContentFile(REPO, REL, "msg", run);
    expect(res.ok).toBe(true);
    expect(res.pushed).toBe(false);
    expect(res.message).toContain("not main");
    // No commit/push attempted from the wrong branch.
    expect(calls.some((c) => c[0] === "commit" || c[0] === "push")).toBe(false);
  });

  it("REFUSES to push when local main has unpushed commits (codex P1: avoids deploying unrelated history)", async () => {
    const { run, calls } = runnerFrom({ "rev-list": { status: 0, stdout: "3\n" } });
    const res = await commitAndPushContentFile(REPO, REL, "msg", run);
    expect(res.ok).toBe(true);
    expect(res.pushed).toBe(false);
    expect(res.message).toContain("unpushed commit");
    expect(calls.some((c) => c[0] === "commit" || c[0] === "push")).toBe(false);
  });

  it("treats an unchanged file as a benign no-op (kind=no-change, no commit/push)", async () => {
    const { run, calls } = runnerFrom({ diff: { status: 0 } });
    const res = await commitAndPushContentFile(REPO, REL, "msg", run);
    expect(res).toEqual({ ok: true, pushed: false, kind: "no-change", message: "No change to commit." });
    expect(calls.some((c) => c[0] === "commit")).toBe(false);
    expect(calls.some((c) => c[0] === "push")).toBe(false);
  });

  it("on push failure: rolls back the commit AND unstages (so it can't leak into a publish PR) and reports not-live", async () => {
    const { run, calls } = runnerFrom({ push: { status: 1, stderr: "rejected: fetch first" } });
    const res = await commitAndPushContentFile(REPO, REL, "msg", run);
    expect(res.ok).toBe(true);
    expect(res.pushed).toBe(false);
    expect(res.kind).toBe("not-live");
    expect(res.message).toContain("rolled back");
    expect(res.message).toContain("rejected: fetch first");
    // The local commit was undone AND unstaged with a mixed reset — nothing left
    // in the index for a pathspec-less publish commit to grab.
    expect(calls.some((c) => c[0] === "reset" && c.includes("--mixed") && c.includes("HEAD~1"))).toBe(true);
  });

  it("on commit failure: unstages the file (no staged residue) and reports error", async () => {
    const { run, calls } = runnerFrom({ commit: { status: 1, stderr: "nothing to commit?" } });
    const res = await commitAndPushContentFile(REPO, REL, "msg", run);
    expect(res.ok).toBe(false);
    expect(res.pushed).toBe(false);
    expect(res.kind).toBe("error");
    expect(res.message).toContain("git commit failed");
    // The staged file from `git add` was unstaged.
    expect(calls.some((c) => c[0] === "reset" && c.includes("HEAD") && c.includes(REL))).toBe(true);
  });

  it("surfaces a git add failure as a hard failure", async () => {
    const { run } = runnerFrom({ add: { status: 128, stderr: "not a git repo" } });
    const res = await commitAndPushContentFile(REPO, REL, "msg", run);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("git add failed");
  });
});
