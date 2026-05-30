import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Pre-publish verify-on-disk guardrail. We mock @/lib/content so we can
// control what setStatus "writes" and what getPostBySlug reports back from
// "disk", and we mock node:child_process so no real git/gh runs. The
// verification step lives BEFORE any git mutation, so the failure path never
// touches child_process at all.

type FakePost = {
  slug: string;
  filename: string;
  title: string;
  status: string;
};

const makePost = (slug: string, status: string): FakePost => ({
  slug,
  filename: `${slug}.md`,
  title: `Title ${slug}`,
  status,
});

// Mutable disk state the mock reads back through getPostBySlug.
let diskState: Map<string, FakePost>;
// Controls whether setStatus actually updates diskState (simulating a flip
// that silently fails to persist).
let setStatusPersists: boolean;

const getAllPosts = vi.fn(async () => Array.from(diskState.values()));
const getPostBySlug = vi.fn(async (slug: string) => diskState.get(slug) ?? null);
const setStatus = vi.fn(async (slug: string, status: string) => {
  const existing = diskState.get(slug) ?? makePost(slug, "draft");
  const updated = { ...existing, status };
  if (setStatusPersists) diskState.set(slug, updated);
  return updated;
});
// readStatusFromDisk reflects the LITERAL diskState (bypasses any overlay),
// which is exactly what the real impl does vs the sidecar-overlaid getPostBySlug.
const readStatusFromDisk = vi.fn(async (slug: string) => diskState.get(slug)?.status ?? null);
const revertToApproved = vi.fn(async (slug: string) => {
  const existing = diskState.get(slug) ?? makePost(slug, "draft");
  const updated = { ...existing, status: "approved" };
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

// Default child_process mock: every git/gh call succeeds with empty output
// unless a specific arg pattern needs a real-ish answer. Extracted so it can
// be re-installed in beforeEach (a test that overrides via mockImplementation
// must not leak its impl into the next test — clearAllMocks resets call
// history but NOT the implementation).
function defaultSpawnImpl(cmd: string, args: string[]) {
  const a = args.join(" ");
  let stdout = "";
  if (cmd === "git" && a.startsWith("rev-parse --abbrev-ref")) stdout = "main";
  if (cmd === "git" && a.startsWith("remote get-url origin")) {
    stdout = "https://github.com/Korendigital-no/Korendigital-nettside.git";
  }
  if (cmd === "gh" && a.startsWith("pr create")) {
    stdout = "https://github.com/Korendigital-no/Korendigital-nettside/pull/99";
  }
  // git show :<path> returns the staged blob. Return a published-frontmatter
  // blob so the staged-blob guardrail passes in the happy path.
  if (cmd === "git" && args[0] === "show" && args[1]?.startsWith(":")) {
    stdout = "---\ntitle: T\ndate: 2026-05-29\nexcerpt: E\nstatus: published\n---\nbody\n";
  }
  // show-ref / ls-remote must "fail" (non-zero) so the branch name is free.
  let status = 0;
  if (cmd === "git" && (a.startsWith("show-ref") || a.startsWith("ls-remote"))) {
    status = 1;
  }
  return { status, stdout: Buffer.from(stdout), stderr: Buffer.from("") };
}

const spawnSync = vi.fn(defaultSpawnImpl);

vi.mock("node:child_process", () => ({
  spawnSync,
}));

beforeEach(() => {
  diskState = new Map();
  setStatusPersists = true;
  vi.clearAllMocks();
  spawnSync.mockImplementation(defaultSpawnImpl);
  setStatus.mockImplementation(async (slug: string, status: string) => {
    const existing = diskState.get(slug) ?? makePost(slug, "draft");
    const updated = { ...existing, status };
    if (setStatusPersists) diskState.set(slug, updated);
    return updated;
  });
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function importPublish() {
  return import("../content-publish");
}

describe("publishApproved verify-on-disk guardrail", () => {
  it("FAILS and rolls back when a flipped post is not 'published' on disk", async () => {
    // Two approved posts. setStatus claims success but does NOT persist —
    // disk still says 'approved'.
    diskState.set("post-a", makePost("post-a", "approved"));
    diskState.set("post-b", makePost("post-b", "approved"));
    setStatusPersists = false;

    const { publishApproved } = await importPublish();
    const result = await publishApproved();

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/verification failed/i);
    expect(result.message).toContain("post-a");
    expect(result.message).toContain("post-b");
    expect(result.message).toMatch(/rolled back/i);

    // No git mutation should have occurred — guardrail is pre-git.
    const gitMutations = spawnSync.mock.calls.filter(
      ([cmd, args]) =>
        cmd === "git" &&
        (args[0] === "checkout" || args[0] === "commit" || args[0] === "push"),
    );
    expect(gitMutations).toHaveLength(0);

    // Rollback uses revertToApproved (clears publish stamp + keeps approval).
    const rollbackSlugs = revertToApproved.mock.calls.map(([slug]) => slug).sort();
    expect(rollbackSlugs).toEqual(["post-a", "post-b"]);
  });

  it("FAILS when the sidecar would mask a still-approved file (disk truth wins)", async () => {
    // Simulate the codex HIGH#1 scenario: getPostBySlug/getAllPosts could be
    // sidecar-overlaid to report 'published', but the file bytes are still
    // 'approved'. readStatusFromDisk reads the literal disk state, so the
    // guardrail must catch it. Here setStatus does NOT persist (disk stays
    // approved) while the overlaid view (getAllPosts) is irrelevant to the
    // check — the guardrail relies on readStatusFromDisk only.
    diskState.set("masked", makePost("masked", "approved"));
    setStatusPersists = false; // disk stays 'approved' despite the flip claim

    const { publishApproved } = await importPublish();
    const result = await publishApproved();

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/verification failed/i);
    expect(result.message).toContain("masked");
    // Never committed.
    const committed = spawnSync.mock.calls.some(
      ([cmd, args]) => cmd === "git" && args[0] === "commit",
    );
    expect(committed).toBe(false);
  });

  it("FAILS naming only the offending slug when one of several persists", async () => {
    diskState.set("good", makePost("good", "approved"));
    diskState.set("bad", makePost("bad", "approved"));
    // Custom setStatus: 'good' persists, 'bad' does not.
    setStatus.mockImplementation(async (slug: string, status: string) => {
      const existing = diskState.get(slug) ?? makePost(slug, "draft");
      const updated = { ...existing, status };
      if (slug !== "bad") diskState.set(slug, updated);
      return updated;
    });

    const { publishApproved } = await importPublish();
    const result = await publishApproved();

    expect(result.ok).toBe(false);
    expect(result.message).toContain("bad");
    expect(result.message).not.toMatch(/did not flip.*\bgood\b/);
  });

  it("FAILS at the staged-blob check when the index content is not published (TOCTTOU)", async () => {
    // Disk verification passes (file is published), but the STAGED blob the
    // commit would capture says 'approved' (a concurrent edit landed after the
    // disk check, before commit). The staged-blob guardrail must catch it.
    diskState.set("toc", makePost("toc", "approved"));
    setStatusPersists = true; // disk check passes
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      const a = args.join(" ");
      let stdout = "";
      let status = 0;
      if (cmd === "git" && a.startsWith("rev-parse --abbrev-ref")) stdout = "main";
      if (cmd === "git" && a.startsWith("remote get-url origin")) {
        stdout = "https://github.com/Korendigital-no/Korendigital-nettside.git";
      }
      if (cmd === "git" && (a.startsWith("show-ref") || a.startsWith("ls-remote"))) status = 1;
      // Staged blob shows approved → guardrail must reject.
      if (cmd === "git" && args[0] === "show" && args[1]?.startsWith(":")) {
        stdout = "---\ntitle: T\ndate: 2026-05-29\nexcerpt: E\nstatus: approved\n---\nbody\n";
      }
      return { status, stdout: Buffer.from(stdout), stderr: Buffer.from("") };
    });

    const { publishApproved } = await importPublish();
    const result = await publishApproved();

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/staged content/i);
    const committed = spawnSync.mock.calls.some(
      ([cmd, args]) => cmd === "git" && args[0] === "commit",
    );
    expect(committed).toBe(false);
  });

  it("PASSES through to git/PR when all flips persist as 'published'", async () => {
    diskState.set("post-x", makePost("post-x", "approved"));
    setStatusPersists = true;

    const { publishApproved } = await importPublish();
    const result = await publishApproved();

    expect(result.ok).toBe(true);
    expect(result.prUrl).toContain("/pull/99");
    // The flip persisted, so verification passed and git ran.
    const committed = spawnSync.mock.calls.some(
      ([cmd, args]) => cmd === "git" && args[0] === "commit",
    );
    expect(committed).toBe(true);
  });

  // Regression (#edit-body): the approve→publish path leaves the approve
  // status-flip uncommitted in content/blog for publishApproved to read and
  // commit. Publishing must NOT be blocked by that expected dirty state (an
  // earlier over-broad clobber guard did exactly that). Clobber protection
  // comes from policy A instead — body-edit saves commit immediately, so no
  // uncommitted body edit ever exists to clobber.
  it("PUBLISHES normally even though the approve status-flip is uncommitted on disk", async () => {
    diskState.set("post-x", makePost("post-x", "approved"));
    setStatusPersists = true;
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "status") {
        // approve left an uncommitted frontmatter change — the normal state.
        return { status: 0, stdout: Buffer.from(" M content/blog/post-x.md\n"), stderr: Buffer.from("") };
      }
      return defaultSpawnImpl(cmd, args);
    });

    const { publishApproved } = await importPublish();
    const result = await publishApproved();

    expect(result.ok).toBe(true);
    const committed = spawnSync.mock.calls.some(([cmd, args]) => cmd === "git" && args[0] === "commit");
    expect(committed).toBe(true);
  });
});
