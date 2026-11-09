import { describe, it, expect, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { listRuns, listApprovals, getRunReceipt, apiFetchWithHeaders, ApiError } from "../client";
import { jobBucket, JOB_STATES, LEGACY_RUN_STATUS_VALUES } from "../jobTypes";
import type { Config } from "../config";

const clientSrc = readFileSync(join(process.cwd(), "src", "client.ts"), "utf8");
const cfg = (): Config => ({ apiUrl: "http://127.0.0.1:18183/api/v1", token: "t", refreshToken: "r" });
const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => ({
  status, ok: status >= 200 && status < 300, statusText: String(status),
  headers: { get: (k: string) => headers[k] ?? headers[k.toLowerCase()] ?? null },
  json: vi.fn(async () => body),
});

describe("jobs inbox contract (source)", () => {
  for (const ep of ["`/runs${query", "/receipt`", "/approvals${query", 'qs.set("bucket"', 'qs.set("groupBy"', 'qs.set("cursor"', "X-Next-Cursor"]) {
    it(`pins ${ep}`, () => expect(clientSrc.includes(ep)).toBe(true));
  }
  it("apiFetch signature unchanged", () => {
    expect(clientSrc).toContain("export async function apiFetch(path: string, opts: RequestOpts): Promise<any>");
  });
});

describe("jobs inbox calls", () => {
  it("listRuns: real platform shape { runs, nextCursor } filled page", async () => {
    const fetchImpl = vi.fn(async () => res(200, { runs: [{ id: "r1", bucket: "working" }, { id: "r2", bucket: "done" }], nextCursor: "abc" }));
    const out = await listRuns(cfg(), { bucket: "working", cursor: "c0", limit: 2 }, { fetchImpl });
    expect(out).toEqual({ items: [{ id: "r1", bucket: "working" }, { id: "r2", bucket: "done" }], nextCursor: "abc" });
    const [url, init] = fetchImpl.mock.calls[0] as any[];
    expect(url).toBe("http://127.0.0.1:18183/api/v1/runs?bucket=working&cursor=c0&limit=2");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer t");
  });
  it("listRuns: real shape empty list, last page", async () => {
    const fetchImpl = vi.fn(async () => res(200, { runs: [], nextCursor: null }));
    expect(await listRuns(cfg(), {}, { fetchImpl })).toEqual({ items: [], nextCursor: null });
    expect((fetchImpl.mock.calls[0] as any[])[0]).toBe("http://127.0.0.1:18183/api/v1/runs");
  });
  it("listRuns: legacy bare array + header still accepted", async () => {
    const fetchImpl = vi.fn(async () => res(200, [{ id: "r1" }], { "X-Next-Cursor": "h" }));
    expect(await listRuns(cfg(), {}, { fetchImpl })).toEqual({ items: [{ id: "r1" }], nextCursor: "h" });
  });
  it("listRuns: 401 (refresh fails) and 500 throw ApiError", async () => {
    const f401 = vi.fn(async (u: string) => res(u.endsWith("/auth/refresh") ? 401 : 401, { error: "no" }));
    await expect(listRuns(cfg(), {}, { fetchImpl: f401, save: vi.fn() })).rejects.toMatchObject({ name: "ApiError", status: 401 });
    const f500 = vi.fn(async () => res(500, { error: "boom" }));
    await expect(listRuns(cfg(), {}, { fetchImpl: f500 })).rejects.toBeInstanceOf(ApiError);
    await expect(listRuns(cfg(), {}, { fetchImpl: f500 })).rejects.toMatchObject({ status: 500, message: "boom" });
  });
  it("listApprovals: groupBy=run reads nextCursor from body; flat list from header", async () => {
    const g = vi.fn(async () => res(200, { groups: [{ runId: "r1", approvals: [] }], nextCursor: "n1" }));
    expect(await listApprovals(cfg(), { groupBy: "run", cursor: "c" }, { fetchImpl: g })).toEqual({
      groups: [{ runId: "r1", approvals: [] }], items: [], nextCursor: "n1",
    });
    expect((g.mock.calls[0] as any[])[0]).toBe("http://127.0.0.1:18183/api/v1/approvals?groupBy=run&cursor=c");
    const f = vi.fn(async () => res(200, [{ id: "a" }], { "X-Next-Cursor": "n2" }));
    expect(await listApprovals(cfg(), {}, { fetchImpl: f })).toMatchObject({ items: [{ id: "a" }], nextCursor: "n2" });
    const e = vi.fn(async () => res(200, { groups: [], nextCursor: null }));
    expect(await listApprovals(cfg(), { groupBy: "run" }, { fetchImpl: e })).toEqual({ groups: [], items: [], nextCursor: null });
  });
  it("getRunReceipt: ok and 404 throws", async () => {
    const rc = { id: "x", runId: "r1", tenantId: "t", outcome: "COMPLETED", resultStatus: null, costUsd: null, evidence: [], approvalIds: [], contentHash: "h", createdAt: "2026-11-09T00:00:00Z" };
    const ok = vi.fn(async () => res(200, rc));
    expect(await getRunReceipt(cfg(), "r1", { fetchImpl: ok })).toEqual(rc);
    expect((ok.mock.calls[0] as any[])[0]).toBe("http://127.0.0.1:18183/api/v1/runs/r1/receipt");
    const nf = vi.fn(async () => res(404, { error: "receipt_not_found" }));
    await expect(getRunReceipt(cfg(), "r1", { fetchImpl: nf })).rejects.toMatchObject({ status: 404, message: "receipt_not_found" });
  });
  it("getRunReceipt: malformed 200 bodies throw ApiError", async () => {
    for (const bad of [null, "x", [], {}, { id: "x", runId: "r", outcome: "COMPLETED", evidence: "no", approvalIds: [], contentHash: "h", createdAt: "t" }]) {
      const f = vi.fn(async () => res(200, bad));
      await expect(getRunReceipt(cfg(), "r1", { fetchImpl: f })).rejects.toBeInstanceOf(ApiError);
    }
  });
  it("getRunReceipt: full platform receipt passes", async () => {
    const rc = { id: "x", runId: "r1", tenantId: "t", outcome: "COMPLETED", resultStatus: "VERIFIED", costUsd: 0.1, evidence: [{ kind: "pr", ref: "1" }], approvalIds: [], contentHash: "h", createdAt: "2026-11-09T00:00:00Z" };
    expect(await getRunReceipt(cfg(), "r1", { fetchImpl: vi.fn(async () => res(200, rc)) })).toEqual(rc);
  });
  it("apiFetchWithHeaders returns headers case-insensitively via the response", async () => {
    const f = vi.fn(async () => res(200, [], { "X-Next-Cursor": "z" }));
    const { headers } = await apiFetchWithHeaders("/runs", { cfg: cfg(), fetchImpl: f });
    expect(headers.get("X-Next-Cursor")).toBe("z");
    expect(headers.get("missing")).toBeNull();
  });
});

describe("jobBucket parity with platform", () => {
  const now = 1_000_000, staleAfterMs = 60_000;
  const table: Array<[string, any, string | null]> = [
    ["DRAFT hidden", { state: "DRAFT" }, null],
    ["PLANNED", { state: "PLANNED" }, "working"],
    ["RESUMING", { state: "RESUMING" }, "working"],
    ["NEEDS_APPROVAL", { state: "NEEDS_APPROVAL" }, "needs_approval"],
    ["COMPLETED", { state: "COMPLETED" }, "done"],
    ["CANCELLED", { state: "CANCELLED" }, "done"],
    ["FAILED", { state: "FAILED" }, "stuck"],
    ["PAUSED", { state: "PAUSED" }, "stuck"],
    ["state wins over status", { state: "COMPLETED", status: "FAILED" }, "done"],
    ["legacy PENDING", { state: null, status: "PENDING" }, "working"],
    ["legacy WAITING_APPROVAL", { status: "WAITING_APPROVAL" }, "needs_approval"],
    ["unknown state", { state: "WAT" }, "stuck"],
    ["unknown legacy", { status: "WAT" }, "stuck"],
    ["no state/status", {}, "stuck"],
    ["bad resultStatus", { state: "COMPLETED", resultStatus: "MAYBE" }, "stuck"],
    ["RUNNING fresh", { state: "RUNNING", heartbeatAt: now - 1000 }, "working"],
    ["RUNNING stale", { state: "RUNNING", heartbeatAt: now - 120_000 }, "stuck"],
    ["RUNNING no heartbeat", { state: "RUNNING", heartbeatAt: null }, "working"],
    ["RUNNING garbage heartbeat", { state: "RUNNING", heartbeatAt: "xx" }, "stuck"],
    ["legacy RUNNING stale", { status: "RUNNING", heartbeatAt: now - 120_000 }, "stuck"],
  ];
  it.each(table)("%s", (_n, input, want) => {
    expect(jobBucket({ now, staleAfterMs, ...input })).toBe(want);
  });
  it("explicit state -> bucket table (10 states)", () => {
    const want: Record<string, string | null> = {
      DRAFT: null, PLANNED: "working", READY: "working", RUNNING: "working", RESUMING: "working",
      NEEDS_APPROVAL: "needs_approval", COMPLETED: "done", CANCELLED: "done", FAILED: "stuck", PAUSED: "stuck",
    };
    expect([...JOB_STATES].sort()).toEqual(Object.keys(want).sort());
    for (const [st, b] of Object.entries(want)) expect(jobBucket({ state: st, now, staleAfterMs })).toBe(b);
  });
  it("explicit legacy status -> bucket table (7 values)", () => {
    const want: Record<string, string> = {
      PENDING: "working", RUNNING: "working", WAITING_APPROVAL: "needs_approval", COMPLETED: "done",
      CANCELLED: "done", FAILED: "stuck", PAUSED: "stuck",
    };
    expect([...LEGACY_RUN_STATUS_VALUES].sort()).toEqual(Object.keys(want).sort());
    for (const [st, b] of Object.entries(want)) expect(jobBucket({ state: null, status: st, now, staleAfterMs })).toBe(b);
  });
  it("stale boundary: diff == threshold is fresh, +1ms is stale", () => {
    expect(jobBucket({ state: "RUNNING", heartbeatAt: now - staleAfterMs, now, staleAfterMs })).toBe("working");
    expect(jobBucket({ state: "RUNNING", heartbeatAt: now - staleAfterMs - 1, now, staleAfterMs })).toBe("stuck");
  });
  it("legacy RUNNING without heartbeat -> working", () => {
    expect(jobBucket({ state: null, status: "RUNNING", now, staleAfterMs })).toBe("working");
  });
  it.each([-1, NaN, Infinity])("RUNNING + heartbeat with staleAfterMs=%s -> stuck", (v) => {
    expect(jobBucket({ state: "RUNNING", heartbeatAt: now, now, staleAfterMs: v })).toBe("stuck");
  });
  it("now/heartbeat accept Date, ISO string and ms", () => {
    const n = Date.UTC(2026, 10, 9, 12, 0, 0);
    const hb = n - 1000;
    for (const [nn, h] of [[new Date(n), new Date(hb)], [new Date(n).toISOString(), new Date(hb).toISOString()], [n, hb]] as const) {
      expect(jobBucket({ state: "RUNNING", heartbeatAt: h, now: nn, staleAfterMs: 5000 })).toBe("working");
      expect(jobBucket({ state: "RUNNING", heartbeatAt: h, now: nn, staleAfterMs: 500 })).toBe("stuck");
    }
  });
  it.each(["PAUSED", "NEEDS_APPROVAL", "DRAFT"])("%s + corrupt resultStatus -> stuck", (st) => {
    expect(jobBucket({ state: st, resultStatus: "MAYBE", now, staleAfterMs })).toBe("stuck");
  });
  it.each(["__proto__", "toString", "constructor", "hasOwnProperty"])("prototype key %s -> stuck", (k) => {
    expect(jobBucket({ state: k, now, staleAfterMs })).toBe("stuck");
    expect(jobBucket({ state: null, status: k, now, staleAfterMs })).toBe("stuck");
  });
  it("optional: platform job.ts still lists the same states", () => {
    const path = join(process.cwd(), "../platform/packages/core/src/types/job.ts");
    if (!existsSync(path)) return;
    const src = readFileSync(path, "utf8");
    for (const s of JOB_STATES) expect(src).toContain(`"${s}",`);
  });
});
