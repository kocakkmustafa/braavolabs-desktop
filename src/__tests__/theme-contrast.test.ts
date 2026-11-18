import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const tokens = (selector: string) => Object.fromEntries([...css.match(new RegExp(`${selector} \\{([^}]+)\\}`))![1].matchAll(/(--[\w-]+):\s*(#[\da-f]{6});/g)].map(m => [m[1], m[2]]));
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map(i => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
  return .2126 * r + .7152 * g + .0722 * b;
}
const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
const palettes = () => { const dark = tokens(":root"); return [dark, { ...dark, ...tokens(':root\\[data-theme="light"\\]') }]; };
it("Ilık Grafit: metin 1-2 her yüzeyde, metin 3 zemin/kartta 4.5:1; metin 4 ve durum renkleri 3:1 (renk + simge + sözcük)", () => {
  for (const p of palettes()) {
    for (const bg of ["--bg", "--surface-1", "--surface-card", "--surface-2", "--surface-sel"]) {
      for (const fg of ["--text-1", "--text-2"]) expect(contrast(p[fg], p[bg]), `${fg}/${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const bg of ["--bg", "--surface-1", "--surface-card", "--surface-2"]) expect(contrast(p["--text-3"], p[bg]), `--text-3/${bg}`).toBeGreaterThanOrEqual(4.5);
    for (const bg of ["--bg", "--surface-1", "--surface-card", "--surface-2"]) expect(contrast(p["--done"], p[bg]), `--done/${bg}`).toBeGreaterThanOrEqual(4.5);
    for (const fg of ["--text-4", "--run", "--approve", "--error", "--done", "--diff-add", "--diff-del", "--focus-ring"]) {
      for (const bg of ["--bg", "--surface-1", "--surface-card"]) expect(contrast(p[fg], p[bg]), `${fg}/${bg}`).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(p["--primary-ink"], p["--primary"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ffffff", p["--danger-fill"])).toBeGreaterThanOrEqual(4.5);
  }
});
it("eski takma adlar kaldırıldı; yeni belirteçler iki temada tanımlı; global kenarsız denetimler", () => {
  expect(css).not.toMatch(/--(obsidian|steel-\d+|arc-blue|arc|ember|ember-dim|molten|gunmetal|radius|radius-sm|mono|sans|muted|text|text-muted|text-dim)\s*:/);
  expect(css).not.toMatch(/var\(--(obsidian|steel-\d+|arc-blue|arc|ember|ember-dim|molten|gunmetal|radius|radius-sm|mono|sans|muted|text|text-muted|text-dim)[,)]/);
  for (const p of palettes()) for (const token of ["--bg", "--surface-1", "--surface-card", "--surface-2", "--surface-sel", "--text-1", "--text-2", "--text-3", "--text-4", "--primary", "--primary-ink", "--run", "--approve", "--error", "--done", "--queue", "--focus-ring", "--danger-fill"]) expect(p[token], token).toMatch(/^#[\da-f]{6}$/);
  expect(css).toMatch(/button,\s*input,\s*select,\s*textarea\s*\{[^}]*border:\s*0;/);
  expect(css).toContain("outline: 2px solid var(--focus-ring)");
  expect(css).toMatch(/data-theme="light"\] \{[^}]*--text-sub: var\(--text-2\);/);
  expect(css).not.toMatch(/\.toggle\.on::after \{[^}]*#fff/);
});
it("--text-sub (küçük metin tonu) her yüzeyde 4.5:1", () => {
  const sub = (p: Record<string, string>, theme: string) => css.includes("--text-sub: var(--text-2);") && theme === "light" ? p["--text-2"] : p["--text-3"];
  const [dark, light] = palettes();
  for (const [p, theme] of [[dark, "dark"], [light, "light"]] as const) for (const bg of ["--bg", "--surface-1", "--surface-card", "--surface-2"]) expect(contrast(sub(p, theme), p[bg]), `${theme} text-sub/${bg}`).toBeGreaterThanOrEqual(4.5);
});
it("preserves Inspector at narrow widths and allows larger text and motion preference without a GUI claim", () => {
  expect(css).not.toMatch(/\.inspector\s*\{\s*display:\s*none/);
  expect(css).not.toMatch(/font-size:\s*[\d.]+px/);
  expect(css).toContain('minmax(0, 1fr)'); expect(css).toContain('grid-column: 1 / -1');
  expect(css).toContain('[dir="rtl"] .toggle.on::after');
  expect(css).toContain('@media (prefers-reduced-motion: reduce)');
});
