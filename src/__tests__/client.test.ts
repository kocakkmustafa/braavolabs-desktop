import { describe, it, expect, vi } from "vitest";
import {
  apiFetch,
  login,
  startCompare,
  pollCompare,
  cascade,
  savings,
  listMemory,
} from "../client";
import type { Config } from "../config";

/** Minimal fetch Response stand-in (same helper the CLI suite uses). */
function resp(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: `status ${status}`,
    json: async () => body,
  };
}

const baseCfg = (): Config => ({ apiUrl: "https://host/api/v1" });

describe("apiFetch", () => {
  it("sends Bearer auth + Content-Type and returns parsed JSON on 2xx", async () => {
    const calls: any[] = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return resp(200, { hello: "world" });
    });
    const cfg = { ...baseCfg(), token: "tok" };
    const out = await apiFetch("/research/cascade", { method: "POST", body: { prompt: "hi" }, cfg, fetchImpl });
    expect(out).toEqual({ hello: "world" });
    expect(calls[0].url).toBe("https://host/api/v1/research/cascade");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.Authorization).toBe("Bearer tok");
    expect(calls[0].init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init.body)).toEqual({ prompt: "hi" });
  });

  it("refreshes exactly once on 401 then retries with the new token", async () => {
    const calls: any[] = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, auth: init?.headers?.Authorization });
      if (url.endsWith("/auth/refresh")) return resp(200, { token: "new", refreshToken: "r2" });
      if (init?.headers?.Authorization === "Bearer old") return resp(401, { error: "expired" });
      if (init?.headers?.Authorization === "Bearer new") return resp(200, { ok: true });
      return resp(500, {});
    });
    const cfg = { ...baseCfg(), token: "old", refreshToken: "r1" };
    const save = vi.fn();
    const out = await apiFetch("/billing/savings", { cfg, save, fetchImpl });
    expect(out).toEqual({ ok: true });
    expect(cfg.token).toBe("new");
    expect(cfg.refreshToken).toBe("r2"); // rotated refresh token overwrote the old one
    expect(save).toHaveBeenCalledOnce();
    const refresh = calls.find((c) => c.url.endsWith("/auth/refresh"));
    expect(refresh.auth).toBeUndefined(); // refresh must not carry a bearer header
    expect(fetchImpl).toHaveBeenCalledTimes(3); // original(401)+refresh+retry, no more
  });

  it("does NOT attempt a refresh loop on /auth/* paths", async () => {
    const fetchImpl = vi.fn(async () => resp(401, { error: "bad creds" }));
    const cfg = { ...baseCfg(), token: "x", refreshToken: "r1" };
    await expect(apiFetch("/auth/login", { method: "POST", body: {}, cfg, auth: false, fetchImpl })).rejects.toMatchObject({
      status: 401,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // never hit /auth/refresh
  });

  it("throws ApiError(401) on 401 when there is no refresh token", async () => {
    const fetchImpl = vi.fn(async () => resp(401, { error: "nope" }));
    const cfg = { ...baseCfg(), token: "old" };
    await expect(apiFetch("/billing/savings", { cfg, fetchImpl })).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
    });
  });

  it("throws ApiError with body.error on other non-2xx", async () => {
    const fetchImpl = vi.fn(async () => resp(422, { error: "bad query" }));
    const cfg = { ...baseCfg(), token: "t" };
    await expect(apiFetch("/research/compare", { method: "POST", body: {}, cfg, fetchImpl })).rejects.toThrow("bad query");
  });

  it("raw mode returns {status, body} instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => resp(429, { error: "Account temporarily locked" }));
    const cfg = { ...baseCfg(), token: "t" };
    const r = await apiFetch("/auth/login", { cfg, fetchImpl, raw: true, auth: false });
    expect(r).toMatchObject({ status: 429, body: { error: "Account temporarily locked" } });
  });
});

describe("command wrappers", () => {
  it("login POSTs /auth/login with NO bearer header (public)", async () => {
    let captured: any;
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      return resp(200, { token: "t", refreshToken: "r", user: { email: "a@b.c" }, tenant: { plan: "pro" } });
    });
    const cfg = baseCfg();
    const out = await login(cfg, { email: "a@b.c", password: "pw" }, { fetchImpl });
    expect(out.token).toBe("t");
    expect(captured.url).toBe("https://host/api/v1/auth/login");
    expect(captured.headers.Authorization).toBeUndefined();
    expect(captured.body).toEqual({ email: "a@b.c", password: "pw" });
  });

  it("startCompare POSTs /research/compare with companyId + query + maxCandidates", async () => {
    let captured: any;
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      captured = { url, method: init.method, body: JSON.parse(init.body) };
      return resp(201, { id: "s1", status: "PENDING" });
    });
    const cfg = { ...baseCfg(), token: "t" };
    const out = await startCompare(cfg, { companyId: "c1", query: "why is the sky blue", maxCandidates: 2 }, { fetchImpl });
    expect(out).toEqual({ id: "s1", status: "PENDING" });
    expect(captured.url).toBe("https://host/api/v1/research/compare");
    expect(captured.method).toBe("POST");
    expect(captured.body).toEqual({ companyId: "c1", query: "why is the sky blue", maxCandidates: 2 });
  });

  it("pollCompare GETs /research/:id until a terminal state", async () => {
    const seq = ["PENDING", "RUNNING", "COMPLETED"];
    let i = 0;
    const urls: string[] = [];
    const ticks: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return resp(200, { id: "s1", status: seq[Math.min(i++, seq.length - 1)] });
    });
    const cfg = { ...baseCfg(), token: "t" };
    const session = await pollCompare(cfg, "s1", { fetchImpl, intervalMs: 0, onTick: (s) => ticks.push(s) });
    expect(session.status).toBe("COMPLETED");
    expect(urls.every((u) => u === "https://host/api/v1/research/s1")).toBe(true);
    expect(ticks).toEqual(["PENDING", "RUNNING", "COMPLETED"]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("pollCompare throws ApiError(408) when it never reaches a terminal state", async () => {
    const fetchImpl = vi.fn(async () => resp(200, { id: "s1", status: "RUNNING" }));
    const cfg = { ...baseCfg(), token: "t" };
    await expect(
      pollCompare(cfg, "s1", { fetchImpl, intervalMs: 0, maxAttempts: 3 }),
    ).rejects.toMatchObject({ name: "ApiError", status: 408 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("cascade POSTs /research/cascade with the prompt and NEVER a companyId", async () => {
    let captured: any;
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      captured = { url, body: JSON.parse(init.body) };
      return resp(200, { answer: "42", provider: "openai", model: "gpt", tier: "cheap", confidence: 0.9, escalated: false, totalCostUsd: 0.001 });
    });
    const cfg = { ...baseCfg(), token: "t" };
    const out = await cascade(cfg, { prompt: "meaning of life?", confidenceThreshold: 0.8 }, { fetchImpl });
    expect(out.answer).toBe("42");
    expect(captured.url).toBe("https://host/api/v1/research/cascade");
    expect(captured.body).toEqual({ prompt: "meaning of life?", confidenceThreshold: 0.8 });
    expect(captured.body).not.toHaveProperty("companyId");
  });

  it("savings GETs /billing/savings with the days query", async () => {
    let capturedUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      capturedUrl = url;
      return resp(200, { report: { savedUsd: 1 } });
    });
    const cfg = { ...baseCfg(), token: "t" };
    await savings(cfg, { days: 30 }, { fetchImpl });
    expect(capturedUrl).toBe("https://host/api/v1/billing/savings?days=30");
  });

  it("listMemory GETs /memory with companyId + optional filters", async () => {
    let capturedUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      capturedUrl = url;
      return resp(200, []);
    });
    const cfg = { ...baseCfg(), token: "t" };
    await listMemory(cfg, { companyId: "c1", type: "SEMANTIC" }, { fetchImpl });
    expect(capturedUrl).toBe("https://host/api/v1/memory?companyId=c1&type=SEMANTIC");
  });
});
