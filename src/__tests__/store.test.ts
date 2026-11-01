import { describe, it, expect, vi } from "vitest";
import { createMemoryStore, createTauriStore, hydrateConfig, isLocalApiUrl, loadApiUrl, saveApiUrl } from "../store";
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

describe("remembered API URL", () => {
  const DEFAULT = "https://braavolabs.com/api/v1";
  function withStorage(entries: Record<string, string>, fn: () => void) {
    const data = new Map(Object.entries(entries));
    vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } });
    try { fn(); } finally { vi.unstubAllGlobals(); }
  }

  it("recognises loopback, .local and private-LAN addresses", () => {
    for (const url of ["http://localhost:8080/api/v1", "http://127.0.0.1:8080", "http://[::1]:8080", "http://mac.local/api", "http://192.168.1.164:8080", "http://10.0.0.2", "http://172.20.1.1"]) expect(isLocalApiUrl(url), url).toBe(true);
    for (const url of [DEFAULT, "https://api.example.com/v1", "http://172.32.0.1", "not a url"]) expect(isLocalApiUrl(url), url).toBe(false);
  });

  it("drops a local address left by an old development setup in a release build only", () => {
    withStorage({ "braavolabs.apiUrl": "http://localhost:8080/api/v1" }, () => {
      expect(loadApiUrl(DEFAULT, { production: true })).toBe(DEFAULT);
      expect(loadApiUrl(DEFAULT, { production: false })).toBe("http://localhost:8080/api/v1");
    });
  });

  it("keeps a local address the user chose in the sign-in form (self-hosting)", () => {
    withStorage({}, () => {
      saveApiUrl("http://192.168.1.20:8080/api/v1");
      expect(loadApiUrl(DEFAULT, { production: true })).toBe("http://192.168.1.20:8080/api/v1");
    });
    withStorage({ "braavolabs.apiUrl": "https://self.example.com/api/v1" }, () => {
      expect(loadApiUrl(DEFAULT, { production: true })).toBe("https://self.example.com/api/v1");
    });
  });
});
