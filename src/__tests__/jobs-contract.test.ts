import { describe, it, expect, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { listRuns, listApprovals, getRunReceipt, apiFetchWithHeaders, ApiError } from "../client";
import { jobBucket, JOB_STATES } from "../jobTypes";
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
  it("listRuns: filled page + cursor header, query + bearer", async () => {
    const fetchImpl = vi.fn(async () => res(200, [{ id: "r1" }, { id: "r2" }], { "X-Next-Cursor": "abc" }));
    const out = await listRuns(cfg(), { bucket: "working", cursor: "c0", limit: 2 }, { fetchImpl });
    expect(out).toEqual({ items: [{ id: "r1" }, { id: "r2" }], nextCursor: "abc" });
    const [url, init] = fetchImpl.mock.calls[0] as any[];
    expect(url).toBe("http://127.0.0.1:18183/api/v1/runs?bucket=working&cursor=c0&limit=2");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer t");
  });
  it("listRuns: empty list, no cursor, no query", async () => {
    const fetchImpl = vi.fn(async () => res(200, []));
    expect(await listRuns(cfg(), {}, { fetchImpl })).toEqual({ items: [], nextCursor: null });
    expect((fetchImpl.mock.calls[0] as any[])[0]).toBe("http://127.0.0.1:18183/api/v1/runs");
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
    const rc = { id: "x", runId: "r1", outcome: "COMPLETED" };
    const ok = vi.fn(async () => res(200, rc));
    expect(await getRunReceipt(cfg(), "r1", { fetchImpl: ok })).toEqual(rc);
    expect((ok.mock.calls[0] as any[])[0]).toBe("http://127.0.0.1:18183/api/v1/runs/r1/receipt");
    const nf = vi.fn(async () => res(404, { error: "receipt_not_found" }));
    await expect(getRunReceipt(cfg(), "r1", { fetchImpl: nf })).rejects.toMatchObject({ status: 404, message: "receipt_not_found" });
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
  it("mirrors the platform JOB_STATES and bucket of each state", () => {
    const p = "../../../platform/packages/core/src/types/job.ts";
    const path = join(process.cwd(), p);
    if (!existsSync(path)) return; // CI checkout has no sibling platform tree
    const src = readFileSync(path, "utf8");
    for (const s of JOB_STATES) expect(src).toContain(`"${s}",`);
  });
});
