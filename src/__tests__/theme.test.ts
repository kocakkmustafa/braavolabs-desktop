import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createTheme, THEME_KEY } from "../theme";

const bootstrap = readFileSync(new URL("../../public/theme-init.js", import.meta.url), "utf8");
function fixture(saved: string | null, dark: boolean, blocked = false) {
  const root = { dataset: {} as DOMStringMap, style: { colorScheme: "" } };
  const media = { matches: dark, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const storage = { getItem: vi.fn(() => { if (blocked) throw Error("blocked"); return saved; }),
    setItem: vi.fn(() => { if (blocked) throw Error("quota"); }) };
  return { root, media, storage };
}
describe("appearance before paint and runtime", () => {
  it.each([null, "bad", "system", "light", "dark"])("keeps prepaint/runtime parity for preference %s and both OS modes", saved => {
    for (const dark of [true, false]) for (const blocked of [true, false]) {
      const before = fixture(saved, dark, blocked), after = fixture(saved, dark, blocked);
      runInNewContext(bootstrap, { document: { documentElement: before.root }, localStorage: before.storage, matchMedia: () => before.media });
      createTheme(after.root, after.storage, after.media);
      expect(before.root).toEqual(after.root);
    }
  });
  it("updates system mode, preserves explicit choice and releases its observer", () => {
    const f = fixture("system", false), theme = createTheme(f.root, f.storage, f.media);
    const change = f.media.addEventListener.mock.calls[0][1] as () => void;
    expect(f.root.dataset.theme).toBe("light");
    f.media.matches = true; change(); expect(f.root.dataset.theme).toBe("dark");
    expect(theme.set("light")).toBe(true);
    change(); expect(f.root.dataset.theme).toBe("light");
    theme.set("dark"); theme.set("system"); f.media.matches = false; change();
    expect(f.root.dataset.theme).toBe("light");
    expect(f.storage.setItem).toHaveBeenLastCalledWith(THEME_KEY, "system");
    theme.dispose(); expect(f.media.removeEventListener).toHaveBeenCalledWith("change", change);
  });
  it("applies session choice when persistence fails, without falsely acknowledging storage", () => {
    const f = fixture("dark", false, true), theme = createTheme(f.root, f.storage, f.media);
    expect(theme.set("dark")).toBe(false); expect(theme.choice()).toBe("dark"); expect(f.root.dataset.theme).toBe("dark");
    expect(() => theme.set("invalid" as any)).toThrow("unsupported theme");
  });
  it("loads the self-only blocking bootstrap before the entry module without changing the CSP", () => {
    const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    expect(html.indexOf('<script src="/theme-init.js"></script>')).toBeLessThan(html.indexOf('src="/src/main.ts"'));
    expect(html).not.toMatch(/<script[^>]*src="\/theme-init.js"[^>]*(?:async|defer|type=)/);
    expect(bootstrap).not.toMatch(/fetch\(|invoke\(|setItem\(/);
  });
});
