/**
 * App preferences — currently just Reduced Motion (Settings → App & Data).
 *
 * Same shape as sessions.ts: a pure, storage-injected core the tests drive
 * directly, plus a thin DOM applier. The preference COMBINES with the OS
 * setting: either the OS media query or the app toggle turns motion off —
 * the app can force reduction on, never force it off (accessibility wins).
 */

export interface KVStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = "bv.prefs.reducedMotion";
/** Class the stylesheet keys off — see styles.css `.reduce-motion`. */
export const REDUCE_CLASS = "reduce-motion";

export interface Prefs {
  reducedMotion(): boolean;
  setReducedMotion(on: boolean): boolean;
}

export function createPrefs(storage: KVStorage | undefined): Prefs {
  let reduced = false;
  try { reduced = storage?.getItem(KEY) === "1"; } catch { /* session fallback */ }
  return {
    reducedMotion: () => reduced,
    setReducedMotion(on) {
      reduced = on;
      try { if (!storage) return false; storage.setItem(KEY, on ? "1" : "0"); return true; }
      catch { return false; }
    },
  };
}

/** True when motion must be reduced: app toggle OR OS preference. */
export function effectiveReducedMotion(prefs: Prefs, osPrefersReduced: boolean): boolean {
  return prefs.reducedMotion() || osPrefersReduced;
}

export function applyReducedMotion(rootEl: Element, on: boolean): void {
  rootEl.classList.toggle(REDUCE_CLASS, on);
}

/** Runtime resolver — localStorage in the webview, memory fallback elsewhere. */
let runtimePrefs: Prefs | undefined;
export function resolvePrefs(): Prefs {
  if (runtimePrefs) return runtimePrefs;
  try {
    const ls = globalThis.localStorage;
    ls.getItem(KEY);
    return runtimePrefs = createPrefs(ls);
  } catch {
    return runtimePrefs = createPrefs(undefined);
  }
}
