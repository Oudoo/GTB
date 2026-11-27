#!/usr/bin/env node
// Renders the application icons (PWA-01) from one SVG mark using the locally installed
// Chromium. Run only when the mark changes; the PNGs in public/icons are committed.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const NAVY = "#10233F";
const TEAL = "#5FC3CB";

/** `inset` is the fraction of the canvas kept clear around the mark (maskable safe zone). */
function svg(size, { inset, rounded }) {
  const r = rounded ? size * 0.22 : 0;
  const c = size / 2;
  const radius = (size * (1 - inset * 2)) / 2 - size * 0.09;
  const stroke = size * 0.085;
  // Open ring (a stylised "Q"/proximity mark) with a dot that closes the gap.
  const gap = 0.9; // radians
  const start = -Math.PI / 4 + gap / 2;
  const end = -Math.PI / 4 - gap / 2 + Math.PI * 2;
  const p = (angle) => `${(c + radius * Math.cos(angle)).toFixed(2)} ${(c + radius * Math.sin(angle)).toFixed(2)}`;
  const dotAngle = -Math.PI / 4;
  const dotR = stroke * 0.72;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${r}" fill="${NAVY}"/>
  <path d="M ${p(start)} A ${radius} ${radius} 0 1 1 ${p(end)}" fill="none" stroke="${TEAL}" stroke-width="${stroke}" stroke-linecap="round"/>
  <circle cx="${(c + (radius + stroke * 0.2) * Math.cos(dotAngle)).toFixed(2)}" cy="${(c + (radius + stroke * 0.2) * Math.sin(dotAngle)).toFixed(2)}" r="${dotR}" fill="#FFFFFF"/>
</svg>`;
}

const targets = [
  { file: "icon-192.png", size: 192, inset: 0.12, rounded: true },
  { file: "icon-512.png", size: 512, inset: 0.12, rounded: true },
  // Maskable: full-bleed background, mark inside the central 60% safe zone.
  { file: "icon-maskable-512.png", size: 512, inset: 0.2, rounded: false },
  { file: "apple-touch-icon.png", size: 180, inset: 0.14, rounded: false },
  { file: "favicon-32.png", size: 32, inset: 0.08, rounded: true },
];

const outDir = join(process.cwd(), "public", "icons");
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
try {
  for (const target of targets) {
    const page = await browser.newPage({ viewport: { width: target.size, height: target.size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${svg(target.size, target)}</body></html>`,
    );
    const buffer = await page.locator("svg").screenshot({ omitBackground: true });
    writeFileSync(join(outDir, target.file), buffer);
    await page.close();
    console.log(`wrote public/icons/${target.file} (${target.size}px)`);
  }
  writeFileSync(join(outDir, "mark.svg"), svg(512, { inset: 0.12, rounded: true }));
} finally {
  await browser.close();
}
