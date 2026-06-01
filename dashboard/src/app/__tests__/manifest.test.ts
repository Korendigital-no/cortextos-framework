import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import manifest from "../manifest";

const PUBLIC = path.join(__dirname, "..", "..", "..", "public");

// The web app manifest is what makes the dashboard installable. These assertions
// lock the fields a browser actually requires for "Add to Home screen" +
// standalone display, so a future edit can't silently break installability.

describe("PWA web app manifest", () => {
  const m = manifest();

  it("declares the installable essentials", () => {
    expect(m.name).toBe("cortextOS Dashboard");
    expect(m.short_name).toBe("cortextOS");
    expect(m.start_url).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.theme_color).toBe("#0F0F0F");
    expect(m.background_color).toBe("#0F0F0F");
  });

  it("ships both a 192 and 512 icon (Chrome installability minimum)", () => {
    const sizes = (m.icons ?? []).map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
  });

  it("includes a maskable icon for adaptive Android launchers", () => {
    const maskable = (m.icons ?? []).filter((i) => i.purpose === "maskable");
    expect(maskable.length).toBeGreaterThanOrEqual(1);
    expect(maskable.map((i) => i.sizes)).toContain("512x512");
  });

  it("points every icon at an asset file that actually exists in public/", () => {
    for (const icon of m.icons ?? []) {
      expect(icon.src).toMatch(/^\/icons\/.+\.png$/);
      expect(icon.type).toBe("image/png");
      expect(existsSync(path.join(PUBLIC, icon.src))).toBe(true);
    }
  });

  it("ships the iOS apple-touch-icon (home-screen icon on iPhone)", () => {
    expect(existsSync(path.join(PUBLIC, "icons", "apple-touch-icon.png"))).toBe(true);
  });
});
