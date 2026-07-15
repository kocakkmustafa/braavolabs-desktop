import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Obsidian identity guard (§5): NO GREEN anywhere. The BYOK / Lane-A work added
 * a keys section + local/direct source styles — this locks in that none of it
 * (nor anything else in the sheet) smuggles a green accent past review.
 */
const rawCss = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
// Strip /* … */ comments — the sheet's own "NO GREEN" banner is prose, not a color.
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, "");

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** Green = the G channel clearly dominates both R and B and is bright enough. */
function isGreenish(hex: string): boolean {
  const { r, g, b } = hexToRgb(hex);
  return g > r + 40 && g > b + 40 && g > 90;
}

describe("no-green identity guard", () => {
  it("has no green color keyword in the stylesheet", () => {
    expect(/\bgreen\b/i.test(css)).toBe(false);
    expect(/\blime\b/i.test(css)).toBe(false);
    expect(/\bemerald\b/i.test(css)).toBe(false);
  });

  it("has no green-dominant hex color anywhere in the stylesheet", () => {
    const hexes = css.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    expect(hexes.length).toBeGreaterThan(0); // sanity: we did parse colors
    const offenders = hexes.filter(isGreenish);
    expect(offenders).toEqual([]);
  });

  it("has no rgb(...) triple where green dominates", () => {
    const rgbs = css.match(/rgba?\(([^)]+)\)/g) ?? [];
    const offenders = rgbs.filter((decl) => {
      const nums = decl.match(/[\d.]+/g)?.map(Number) ?? [];
      const [r, g, b] = nums;
      return g > r + 40 && g > b + 40 && g > 90;
    });
    expect(offenders).toEqual([]);
  });
});
