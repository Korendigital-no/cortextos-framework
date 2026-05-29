import { describe, it, expect } from "vitest";
import { stagedBlobIsPublished } from "../content-publish";

// Frontmatter-status detection used by the staged-blob guardrail. No git, no
// disk — pure string parsing.

const fm = (status: string) => `---
title: T
date: 2026-05-29
excerpt: E
status: ${status}
---
body
`;

describe("stagedBlobIsPublished", () => {
  it("true for plain status: published", () => {
    expect(stagedBlobIsPublished(fm("published"))).toBe(true);
  });

  it("false for approved / draft", () => {
    expect(stagedBlobIsPublished(fm("approved"))).toBe(false);
    expect(stagedBlobIsPublished(fm("draft"))).toBe(false);
  });

  it("true with a trailing YAML comment", () => {
    expect(stagedBlobIsPublished(fm("published # ready"))).toBe(true);
  });

  it("true with quoted value", () => {
    expect(stagedBlobIsPublished(fm('"published"'))).toBe(true);
    expect(stagedBlobIsPublished(fm("'published'"))).toBe(true);
  });

  it("false when no frontmatter fence", () => {
    expect(stagedBlobIsPublished("no frontmatter here, status: published")).toBe(false);
  });

  it("false for empty input", () => {
    expect(stagedBlobIsPublished("")).toBe(false);
  });
});
