import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelCompare, pollCompare } from "../client";
import type { Config } from "../config";
const cfg = (): Config => ({ apiUrl: "http://127.0.0.1:18183/api/v1", token: "synthetic-token" });
const response = (status: number, value: unknown) => ({ status, ok: status >= 200 && status < 300, statusText: String(status), json: async () => value });
afterEach(() => vi.useRealTimers());

describe("compare cancellation wire contract and local polling", () => {
  it.each(["CANCELLED", "COMPLETED", "FAILED"] as const)("preserves authoritative %s and uses the encoded session with bearer auth", async status => {
    const signal = new AbortController().signal;
    const fetchImpl = vi.fn(async () => response(200, { success: true, status }));
    expect(await cancelCompare(cfg(), "session /?#", { fetchImpl, signal })).toEqual({ success: true, status });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:18183/api/v1/research/session%20%2F%3F%23/cancel", expect.objectContaining({
      method: "POST", signal, redirect: "error", headers: expect.objectContaining({ Authorization: "Bearer synthetic-token" }),
    }));
  });
  it.each([{}, { success: false, status: "CANCELLED" }, { success: true, status: "RUNNING" }, { success: true, status: 1 }])("rejects invalid success metadata %# without claiming cancellation", async value => {
    const fetchImpl = vi.fn(async () => response(200, value));
    await expect(cancelCompare(cfg(), "session", { fetchImpl })).rejects.toMatchObject({ name: "ApiError", status: 502 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it.each([404, 503])("does not retry or replace cancellation HTTP %s", async status => {
    const fetchImpl = vi.fn(async () => response(status, { error: "synthetic failure" }));
    await expect(cancelCompare(cfg(), "session", { fetchImpl })).rejects.toMatchObject({ name: "ApiError", status });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("ends polling on CANCELLED without another wait or request", async () => {
    vi.useFakeTimers(); const fetchImpl = vi.fn(async () => response(200, { status: "CANCELLED" }));
    expect(await pollCompare(cfg(), "session", { fetchImpl })).toEqual({ status: "CANCELLED" });
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels the polling delay immediately without another GET", async () => {
    vi.useFakeTimers(); const controller = new AbortController();
    const fetchImpl = vi.fn(async () => response(200, { status: "RUNNING" }));
    const result = pollCompare(cfg(), "session", { fetchImpl, signal: controller.signal });
    const assertion = expect(result).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(0); expect(vi.getTimerCount()).toBe(1);
    controller.abort(); await assertion;
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("passes abort to the in-flight GET and discards a late completed response", async () => {
    const controller = new AbortController(); let complete!: (value: unknown) => void;
    const fetchImpl = vi.fn((_url: string, _init: any) => new Promise(resolve => { complete = resolve; }));
    const result = pollCompare(cfg(), "session", { fetchImpl, signal: controller.signal });
    const assertion = expect(result).rejects.toBeDefined();
    expect(fetchImpl.mock.calls[0][1].signal).toBe(controller.signal);
    controller.abort(); complete(response(200, { status: "COMPLETED", private: "old result" })); await assertion;
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
