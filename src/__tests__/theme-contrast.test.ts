import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const tokens = (selector: string) => Object.fromEntries([...css.match(new RegExp(`${selector} \\{([^}]+)\\}`))![1].matchAll(/(--[\w-]+):\s*(#[\da-f]{6});/g)].map(m => [m[1], m[2]]));
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map(i => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
  return .2126 * r + .7152 * g + .0722 * b;
}
const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
it("keeps normal token text and white primary/danger labels at 4.5:1 in both palettes", () => {
  const dark = tokens(":root"), light = { ...dark, ...tokens(':root\\[data-theme="light"\\]') };
  for (const palette of [dark, light]) {
    for (const fg of ["--text", "--text-muted", "--text-dim", "--steel-400", "--arc-blue-lit", "--ember", "--molten"]) {
      for (const bg of ["--obsidian", "--obsidian-raised", "--obsidian-inset", "--steel-900", "--steel-800"]) {
        expect(contrast(palette[fg], palette[bg]), `${fg} / ${bg}: ${palette[fg]} ${palette[bg]}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast("#ffffff", palette["--arc-blue"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ffffff", palette["--danger-fill"])).toBeGreaterThanOrEqual(4.5);
  }
});
it("preserves Inspector at narrow widths and allows larger text and motion preference without a GUI claim", () => {
  expect(css).not.toMatch(/\.inspector\s*\{\s*display:\s*none/);
  expect(css).not.toMatch(/font-size:\s*[\d.]+px/);
  expect(css).toContain('minmax(0, 1fr)'); expect(css).toContain('grid-column: 1 / -1');
  expect(css).toContain('[dir="rtl"] .toggle.on::after');
  expect(css).toContain('@media (prefers-reduced-motion: reduce)');
});
