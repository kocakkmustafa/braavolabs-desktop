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
  setReducedMotion(on: boolean): void;
}

export function createPrefs(storage: KVStorage): Prefs {
  return {
    reducedMotion() {
      return storage.getItem(KEY) === "1";
    },
    setReducedMotion(on) {
      storage.setItem(KEY, on ? "1" : "0");
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
export function resolvePrefs(): Prefs {
  try {
    const ls = globalThis.localStorage;
    ls.getItem(KEY);
    return createPrefs(ls);
  } catch {
    const mem = new Map<string, string>();
    return createPrefs({
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => void mem.set(k, v),
    });
  }
}
