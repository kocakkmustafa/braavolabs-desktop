import { afterEach, expect, it, vi } from "vitest";
import { verifyHistoryIdentity } from "../client";
import { rememberHistoryIdentity, resolveSessionStore, sessionNamespace } from "../sessions";

const token = (userId: string, n = 1) => `header.${Buffer.from(JSON.stringify({ userId, tenantId: "tenant", n })).toString("base64url")}.signature`;
const profile = (id = "A") => ({ id, tenant: { id: "tenant" } });
const response = (status: number, value: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => value });
function fixture() {
  const cfg = { apiUrl: "https://api.example.invalid/api/v1", token: token("A"), refreshToken: "synthetic-refresh" };
  const values = new Map<string, string>();
  const raw = JSON.stringify([{ id: "old", title: "A", createdAt: 1, updatedAt: 1, entries: [{ role: "user", mode: "local", text: "A-only", at: 1 }] }]);
  values.set(sessionNamespace(cfg.apiUrl, cfg.token)!, raw);
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } });
  return { cfg, values, raw };
}
afterEach(() => vi.unstubAllGlobals());
it("rehydrates only after the authenticated profile matches this token/API snapshot", async () => {
  const { cfg } = fixture();
  expect(resolveSessionStore(cfg).export()).not.toContain("A-only");
  const fetchImpl = vi.fn(async () => response(200, profile()));
  expect(await verifyHistoryIdentity(cfg, { fetchImpl })).toBe(true);
  expect(resolveSessionStore(cfg).export()).toContain("A-only");
  expect(fetchImpl).toHaveBeenCalledOnce();
});
it("does not let an invalid or mismatched token open a decoded namespace", async () => {
  const { cfg, values, raw } = fixture(); cfg.refreshToken = "";
  expect(await verifyHistoryIdentity(cfg, { fetchImpl: async () => response(401, {}) })).toBe(false);
  expect(resolveSessionStore(cfg).status().persistence).toBe("volatile");
  expect(await verifyHistoryIdentity(cfg, { fetchImpl: async () => response(200, profile("B")) })).toBe(false);
  expect(resolveSessionStore(cfg).export()).not.toContain("A-only");
  expect(values.get(sessionNamespace(cfg.apiUrl, cfg.token)!)).toBe(raw);
});
it("binds a same-owner refresh to the newly authenticated profile and current token", async () => {
  const { cfg } = fixture(); rememberHistoryIdentity(cfg, { user: { id: "A" }, tenant: { id: "tenant" } });
  let profiles = 0; const rotated = token("A", 2);
  const fetchImpl = vi.fn(async (url: string) => url.endsWith("/auth/refresh")
    ? response(200, { token: rotated, refreshToken: "rotated-synthetic-refresh" })
    : ++profiles === 1 ? response(401, {}) : response(200, profile()));
  expect(await verifyHistoryIdentity(cfg, { fetchImpl, save: vi.fn() })).toBe(true);
  expect(cfg.token).toBe(rotated); expect(resolveSessionStore(cfg).export()).toContain("A-only");
});
it("discards a profile response after the API changes", async () => {
  const { cfg } = fixture(); let finish!: (value: unknown) => void;
  const pending = verifyHistoryIdentity(cfg, { fetchImpl: async () => response(200, await new Promise(resolve => { finish = resolve; })) });
  cfg.apiUrl = "https://other.example.invalid/api/v1"; finish(profile());
  expect(await pending).toBe(false); expect(resolveSessionStore(cfg).status().persistence).toBe("volatile");
});
it("a stalled verification stays bounded and leaves saved bytes untouched", async () => {
  const { cfg, values, raw } = fixture();
  expect(await verifyHistoryIdentity(cfg, { timeoutMs: 10, fetchImpl: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) })).toBe(false);
  expect(resolveSessionStore(cfg).status().persistence).toBe("volatile");
  expect(values.get(sessionNamespace(cfg.apiUrl, cfg.token)!)).toBe(raw);
});
