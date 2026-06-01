// Generates the PWA icon set from inline SVG sources via sharp.
//
// Why static PNGs (not next/og ImageResponse): a web app manifest needs stable,
// cacheable icon URLs with explicit sizes + purpose, and iOS reads a static
// apple-touch-icon for the home-screen icon. Static files are the most portable,
// debuggable PWA icon setup. Re-run with `node scripts/generate-pwa-icons.mjs`
// whenever the mark changes.
//
// Brand: gold (#D4AF37) node-graph (agent-orchestration motif) on near-black
// (#0F0F0F) — matches the dashboard's gold-on-dark theme.

import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "public", "icons");

const BG = "#0F0F0F";
const GOLD = "#D4AF37";

// The orchestration mark: a central node with three connected satellites.
// `scale` shrinks the glyph toward the center so maskable icons keep their
// content inside the OS safe zone (~80%).
function glyph(scale) {
  const cx = 256;
  const cy = 256;
  // Satellite positions around the center.
  const nodes = [
    [256, 120],
    [148, 366],
    [364, 366],
  ];
  const lines = nodes
    .map(([x, y]) => `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" />`)
    .join("");
  // Faint ring between satellites for a "network" feel.
  const ring = nodes
    .map(([x, y], i) => {
      const [nx, ny] = nodes[(i + 1) % nodes.length];
      return `<line x1="${x}" y1="${y}" x2="${nx}" y2="${ny}" stroke-opacity="0.45" />`;
    })
    .join("");
  const sats = nodes.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="26" />`).join("");
  return `
    <g transform="translate(${cx} ${cy}) scale(${scale}) translate(${-cx} ${-cy})">
      <g stroke="${GOLD}" stroke-width="16" stroke-linecap="round">${lines}${ring}</g>
      <g fill="${GOLD}">${sats}<circle cx="${cx}" cy="${cy}" r="40" /></g>
    </g>`;
}

// `any` icons: rounded corners baked in (shown un-masked in browsers/launchers).
const svgAny = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="${BG}"/>
  ${glyph(0.84)}
</svg>`;

// `maskable` + apple icons: full-bleed background, glyph inside the safe zone.
const svgMaskable = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${BG}"/>
  ${glyph(0.66)}
</svg>`;

async function render(svg, size, file) {
  await sharp(Buffer.from(svg), { density: 384 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(path.join(OUT, file));
  console.log(`  ${file} (${size}x${size})`);
}

await mkdir(OUT, { recursive: true });
console.log("Generating PWA icons →", OUT);
await render(svgAny, 192, "icon-192.png");
await render(svgAny, 512, "icon-512.png");
await render(svgMaskable, 192, "icon-maskable-192.png");
await render(svgMaskable, 512, "icon-maskable-512.png");
await render(svgMaskable, 180, "apple-touch-icon.png");
await render(svgAny, 32, "favicon-32.png");
console.log("Done.");
