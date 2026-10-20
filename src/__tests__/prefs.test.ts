import { describe, it, expect } from "vitest";
import { createPrefs, effectiveReducedMotion, type KVStorage } from "../prefs";

function memStorage(): KVStorage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

describe("prefs — reduced motion", () => {
  it("defaults off and persists a toggle roundtrip", () => {
    const p = createPrefs(memStorage());
    expect(p.reducedMotion()).toBe(false);
    p.setReducedMotion(true);
    expect(p.reducedMotion()).toBe(true);
    p.setReducedMotion(false);
    expect(p.reducedMotion()).toBe(false);
  });

  it("keeps a session preference when storage becomes unavailable after startup", () => {
    let blocked = false;
    const p = createPrefs({ getItem: () => { if (blocked) throw new Error("blocked"); return "0"; },
      setItem: () => { if (blocked) throw new Error("quota"); } });
    expect(p.reducedMotion()).toBe(false);
    blocked = true;
    expect(() => p.setReducedMotion(true)).not.toThrow();
    expect(p.reducedMotion()).toBe(true);
  });

  it("app toggle OR the OS preference reduces motion — OS can never be overridden off", () => {
    const p = createPrefs(memStorage());
    expect(effectiveReducedMotion(p, false)).toBe(false);
    expect(effectiveReducedMotion(p, true)).toBe(true); // OS wins even with toggle off
    p.setReducedMotion(true);
    expect(effectiveReducedMotion(p, false)).toBe(true);
    expect(effectiveReducedMotion(p, true)).toBe(true);
  });
});

it("does not acknowledge persistent storage when only session memory is available", () => {
  const p = createPrefs(undefined); expect(p.setReducedMotion(true)).toBe(false); expect(p.reducedMotion()).toBe(true);
});
