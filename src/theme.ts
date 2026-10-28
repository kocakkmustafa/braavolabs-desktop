/** Frontend appearance only; no credentials or host permission state. */
import type { KVStorage } from "./prefs";
export const THEME_KEY = "bv.prefs.theme";
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = typeof THEMES[number];
export function isTheme(value: unknown): value is Theme { return THEMES.includes(value as Theme); }
interface ThemeRoot { dataset: DOMStringMap; style: { colorScheme: string }; }
interface ThemeMedia {
  matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}
export function createTheme(root: ThemeRoot, storage: KVStorage | undefined, media: ThemeMedia) {
  let choice: Theme = "system";
  try { const saved = storage?.getItem(THEME_KEY); if (isTheme(saved)) choice = saved; } catch { /* use system */ }
  const apply = () => {
    root.dataset.themePreference = choice;
    root.dataset.theme = choice === "system" ? media.matches ? "dark" : "light" : choice;
    root.style.colorScheme = root.dataset.theme;
  };
  apply();
  media.addEventListener("change", apply);
  return {
    choice: () => choice,
    set(value: Theme): boolean {
      if (!isTheme(value)) throw new Error("unsupported theme");
      choice = value; apply();
      try { if (!storage) return false; storage.setItem(THEME_KEY, value); return true; } catch { return false; }
    },
    dispose: () => media.removeEventListener("change", apply),
  };
}
let runtime: ReturnType<typeof createTheme> | undefined;
export function resolveTheme() {
  if (!runtime) {
    let storage: KVStorage | undefined;
    try { storage = globalThis.localStorage; } catch { /* blocked storage */ }
    const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)")
      : { matches: false, addEventListener() {}, removeEventListener() {} };
    runtime = createTheme(document.documentElement, storage, media);
  }
  return runtime;
}
