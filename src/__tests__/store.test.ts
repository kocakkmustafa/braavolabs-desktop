import { describe, it, expect, vi } from "vitest";
import { createMemoryStore, createTauriStore, hydrateConfig } from "../store";
import type { Config } from "../config";

describe("createMemoryStore (dev/test fallback — never touches disk)", () => {
  it("round-trips set → get → clear", async () => {
    const s = createMemoryStore();
    expect(await s.get()).toEqual({});
    await s.set({ token: "t", refreshToken: "r" });
    expect(await s.get()).toEqual({ token: "t", refreshToken: "r" });
    await s.clear();
    expect(await s.get()).toEqual({});
  });
});

describe("createTauriStore (delegates to the Rust secret command)", () => {
  it("maps get/set/clear onto invoke with the CLI-parity field names", async () => {
    const calls: any[] = [];
    const invoke = vi.fn(async (cmd: string, args?: any) => {
      calls.push({ cmd, args });
      if (cmd === "secure_store_get") return { token: "tok", refreshToken: "ref" };
      return null;
    });
    const s = createTauriStore(invoke);
    expect(await s.get()).toEqual({ token: "tok", refreshToken: "ref" });
    await s.set({ token: "n", refreshToken: "m" });
    await s.clear();
    expect(calls.map((c) => c.cmd)).toEqual(["secure_store_get", "secure_store_set", "secure_store_clear"]);
    expect(calls[1].args).toEqual({ token: "n", refreshToken: "m" });
  });

  it("tolerates a null get() result (no stored secrets yet)", async () => {
    const invoke = vi.fn(async () => null);
    const s = createTauriStore(invoke);
    expect(await s.get()).toEqual({});
  });
});

describe("hydrateConfig", () => {
  it("copies stored secrets onto the config in place", async () => {
    const store = createMemoryStore();
    await store.set({ token: "abc", refreshToken: "def" });
    const cfg: Config = { apiUrl: "https://host/api/v1" };
    await hydrateConfig(cfg, store);
    expect(cfg.token).toBe("abc");
    expect(cfg.refreshToken).toBe("def");
  });
});
