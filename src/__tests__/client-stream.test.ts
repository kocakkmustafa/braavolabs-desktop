import { describe, expect, it, vi } from "vitest";
import { apiFetch, AuthenticationPersistenceError, AuthenticationProtocolError } from "../client";
import type { Config } from "../config";
const cfg = (): Config => ({ apiUrl: "http://127.0.0.1:18183/api/v1", token: "synthetic-old", refreshToken: "synthetic-refresh" });
const response = (status: number, value: unknown = {}) => ({ status, ok: status >= 200 && status < 300, statusText: String(status), json: vi.fn(async () => value) });

describe("streaming requests retain the desktop API contract", () => {
  it("returns the body without JSON consumption and keeps URL, auth, redirect and abort controls", async () => {
    const controller = new AbortController();
    const res = { ...response(200), body: { synthetic: true } };
    const fetchImpl = vi.fn(async () => res);
    expect(await apiFetch("/relay/sessions/test/commands", { cfg: cfg(), fetchImpl, stream: true, signal: controller.signal })).toBe(res);
    expect(res.json).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:18183/api/v1/relay/sessions/test/commands", expect.objectContaining({
      redirect: "error", signal: controller.signal, headers: expect.objectContaining({ Accept: "text/event-stream", Authorization: "Bearer synthetic-old" }),
    }));
  });
  it("does not send an already cancelled stream", async () => {
    const controller = new AbortController(); controller.abort(); const fetchImpl = vi.fn();
    await expect(apiFetch("/relay/sessions/test/commands", { cfg: cfg(), fetchImpl, stream: true, signal: controller.signal })).rejects.toBeDefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([408, 429, 500, 503])("preserves transient refresh HTTP %s for raw and normal callers", async status => {
    const c = cfg(), save = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => response(url.endsWith("/auth/refresh") ? status : 401));
    await expect(apiFetch("/test", { cfg: c, fetchImpl, save })).rejects.toMatchObject({ name: "ApiError", status });
    expect(await apiFetch("/test", { cfg: c, fetchImpl, save, raw: true })).toMatchObject({ status, body: { error: "Authentication refresh temporarily unavailable" } });
    expect(c).toEqual(cfg()); expect(save).not.toHaveBeenCalled();
  });
  it.each([false, true])("identifies malformed refresh bundles without persisting them (raw=%s)", async raw => {
    const c = cfg(), save = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/auth/refresh") ? response(200, { token: "" }) : response(401));
    await expect(apiFetch("/test", { cfg: c, fetchImpl, save, raw })).rejects.toBeInstanceOf(AuthenticationProtocolError);
    expect(c).toEqual(cfg()); expect(save).not.toHaveBeenCalled();
  });
  it.each([false, true])("identifies failed refresh persistence and never replays this request (raw=%s)", async raw => {
    const c = cfg(), save = vi.fn(async () => { throw new Error("synthetic persistence failure"); });
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/auth/refresh") ? response(200, { token: "synthetic-new" }) : response(401));
    await expect(apiFetch("/test", { cfg: c, fetchImpl, save, raw })).rejects.toBeInstanceOf(AuthenticationPersistenceError);
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(save).toHaveBeenCalledOnce();
  });
});

describe("refresh response decoding", () => {
  it("treats invalid JSON as a terminal protocol error without persisting or replaying", async () => {
    const save = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/auth/refresh")
      ? { ...response(200), json: async () => { throw new SyntaxError("synthetic malformed JSON"); } } : response(401));
    await expect(apiFetch("/test", { cfg: cfg(), fetchImpl, save })).rejects.toBeInstanceOf(AuthenticationProtocolError);
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(save).not.toHaveBeenCalled();
  });
  it("preserves a body-read network error for transport recovery", async () => {
    const error = new TypeError("synthetic body disconnected"), save = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/auth/refresh")
      ? { ...response(200), json: async () => { throw error; } } : response(401));
    await expect(apiFetch("/test", { cfg: cfg(), fetchImpl, save })).rejects.toBe(error);
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(save).not.toHaveBeenCalled();
  });
});
