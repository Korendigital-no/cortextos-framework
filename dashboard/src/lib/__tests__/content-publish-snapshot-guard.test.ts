import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Race-guard R1: publishApproved must refuse to publish from a STALE snapshot.
// The publish branch is cut from local HEAD; if origin/<startBranch> has
// advanced since this clone last synced, publishing would branch from an old
// main and could revert newer commits on merge. The guard fetches and aborts
// BEFORE any mutation when origin is ahead. Same mock harness as the
// verify-on-disk guardrail test: mock @/lib/content + node:child_process so no
// real git/gh runs.

type FakePost = { slug: string; filename: string; title: string; status: string };
const makePost = (slug: string, status: string): FakePost => ({
  slug,
  filename: `${slug}.md`,
  title: `Title ${slug}`,
  status,
});

let diskState: Map<string, FakePost>;
// Configurable git behaviour for the snapshot check.
let behindCount: string; // stdout of `rev-list --count main..origin/main`
let fetchStatus: number; // exit status of `git fetch origin main`

const getAllPosts = vi.fn(async () => Array.from(diskState.values()));
const getPostBySlug = vi.fn(async (slug: string) => diskState.get(slug) ?? null);
const setStatus = vi.fn(async (slug: string, status: string) => {
  const updated = { ...(diskState.get(slug) ?? makePost(slug, "draft")), status };
  diskState.set(slug, updated);
  return updated;
});
const readStatusFromDisk = vi.fn(async (slug: string) => diskState.get(slug)?.status ?? null);
const revertToApproved = vi.fn(async (slug: string) => {
  const updated = { ...(diskState.get(slug) ?? makePost(slug, "draft")), status: "approved" };
  diskState.set(slug, updated);
  return updated;
});
const getWebsiteRepoPath = vi.fn(() => "/tmp/fake-website-repo");

vi.mock("@/lib/content", () => ({
  getAllPosts,
  getPostBySlug,
  readStatusFromDisk,
  revertToApproved,
  setStatus,
  getWebsiteRepoPath,
}));
vi.mock("@/lib/content-publish-pending", () => ({
  upsertPending: vi.fn(async () => {}),
}));

function spawnImpl(cmd: string, args: string[]) {
  const a = args.join(" ");
  let stdout = "";
  let status = 0;
  if (cmd === "git" && a.startsWith("rev-parse --abbrev-ref")) stdout = "main";
  if (cmd === "git" && a.startsWith("remote get-url origin")) {
    stdout = "https://github.com/Korendigital-no/Korendigital-nettside.git";
  }
  if (cmd === "git" && a.startsWith("fetch origin")) status = fetchStatus;
  if (cmd === "git" && a.startsWith("rev-list --count")) stdout = behindCount;
  if (cmd === "git" && (a.startsWith("show-ref") || a.startsWith("ls-remote"))) status = 1;
  if (cmd === "git" && args[0] === "show" && args[1]?.startsWith(":")) {
    stdout = "---\ntitle: T\ndate: 2026-05-29\nexcerpt: E\nstatus: published\n---\nbody\n";
  }
  if (cmd === "gh" && a.startsWith("pr create")) {
    stdout = "https://github.com/Korendigital-no/Korendigital-nettside/pull/99";
  }
  return { status, stdout: Buffer.from(stdout), stderr: Buffer.from("") };
}

const spawnSync = vi.fn(spawnImpl);
vi.mock("node:child_process", () => ({ spawnSync }));

beforeEach(() => {
  diskState = new Map();
  behindCount = "0";
  fetchStatus = 0;
  vi.clearAllMocks();
  spawnSync.mockImplementation(spawnImpl);
  setStatus.mockImplementation(async (slug: string, status: string) => {
    const updated = { ...(diskState.get(slug) ?? makePost(slug, "draft")), status };
    diskState.set(slug, updated);
    return updated;
  });
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function gitMutated(): boolean {
  return spawnSync.mock.calls.some(
    ([cmd, args]: [string, string[]]) =>
      cmd === "git" && (args[0] === "checkout" || args[0] === "commit" || args[0] === "push"),
  );
}

describe("publishApproved snapshot-freshness guard (R1)", () => {
  it("ABORTS before any mutation when origin/main is ahead", async () => {
    diskState.set("post-a", makePost("post-a", "approved"));
    behindCount = "3"; // origin has 3 commits we don't

    const { publishApproved } = await import("../content-publish");
    const result = await publishApproved();

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/3 new commit/);
    expect(result.message).toMatch(/stale snapshot|pull --ff-only/i);
    // No status flip persisted, no git mutation.
    expect(setStatus).not.toHaveBeenCalled();
    expect(gitMutated()).toBe(false);
  });

  it("ABORTS when the fetch itself fails (cannot verify freshness)", async () => {
    diskState.set("post-a", makePost("post-a", "approved"));
    fetchStatus = 1;

    const { publishApproved } = await import("../content-publish");
    const result = await publishApproved();

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/fetch.*failed/i);
    expect(setStatus).not.toHaveBeenCalled();
    expect(gitMutated()).toBe(false);
  });

  it("PROCEEDS to publish when origin/main is in sync (0 commits ahead)", async () => {
    diskState.set("post-x", makePost("post-x", "approved"));
    behindCount = "0";

    const { publishApproved } = await import("../content-publish");
    const result = await publishApproved();

    expect(result.ok).toBe(true);
    expect(result.prUrl).toContain("/pull/99");
    expect(gitMutated()).toBe(true);
  });

  it("PROCEEDS when rev-list is unparseable (cannot prove staleness — does not hard-block)", async () => {
    diskState.set("post-x", makePost("post-x", "approved"));
    behindCount = ""; // e.g. origin branch missing → NaN → no false-positive abort

    const { publishApproved } = await import("../content-publish");
    const result = await publishApproved();

    expect(result.ok).toBe(true);
  });
});
