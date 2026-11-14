import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideApproval } from "../client";
import {
  approvalFingerprint, createDecider, createNotifier, isInboxEnabled, isLocalGovernanceKind, INBOX_FLAG_KEY,
} from "../inbox";
import type { Config } from "../config";

const cfg = (): Config => ({ apiUrl: "http://127.0.0.1:18183/api/v1", token: "t", refreshToken: "r" });
const res = (status: number, body: unknown = {}) => ({
  status, ok: status >= 200 && status < 300, statusText: String(status),
  headers: { get: () => null }, json: vi.fn(async () => body),
});
const A = { id: "a1", runId: "r1", type: "SPEND", status: "PENDING", description: "Send mail", amountUsd: 2, metadata: { toolName: "gmail" }, details: { risk: "HIGH" } };

/** Platform fake: GET /approvals returns `current`; POST decide recorded. */
function platform(current: any[], decideStatus = 200) {
  const posts: any[] = [];
  const fetchImpl = vi.fn(async (url: string, init: any) => {
    if (init.method === "POST") { posts.push({ url, body: JSON.parse(init.body) }); return res(decideStatus, decideStatus < 300 ? { ok: true } : { error: "x" }); }
    return res(200, current);
  });
  return { fetchImpl, posts };
}

describe("contract with 04g / platform decide", () => {
  it("decide: POST /approvals/:id/decide with { decision } only (no hash/nonce from client)", async () => {
    const { fetchImpl, posts } = platform([]);
    await decideApproval(cfg(), "a/1", { decision: "REJECTED", note: "n" }, { fetchImpl });
    expect(posts[0]).toEqual({ url: "http://127.0.0.1:18183/api/v1/approvals/a%2F1/decide", body: { decision: "REJECTED", note: "n" } });
  });
});

describe("decider", () => {
  it("offline: fail-closed, no request at all, never approved", async () => {
    const { fetchImpl, posts } = platform([A]);
    const d = createDecider({ cfg: cfg(), fetchImpl, isOnline: () => false });
    expect(await d.decide(A, "APPROVED")).toEqual({ ok: false, reason: "offline" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });
  it("network failure while deciding is offline, not approved", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const d = createDecider({ cfg: cfg(), fetchImpl, isOnline: () => true });
    expect(await d.decide(A, "APPROVED")).toMatchObject({ ok: false, reason: "offline" });
  });
  it("unchanged content: approves via platform decide", async () => {
    const { fetchImpl, posts } = platform([A]);
    const d = createDecider({ cfg: cfg(), fetchImpl, isOnline: () => true });
    expect(await d.decide(A, "APPROVED")).toEqual({ ok: true, decision: "APPROVED" });
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ decision: "APPROVED" });
  });
  it("content changed since the user saw it: refused, nothing posted", async () => {
    const { fetchImpl, posts } = platform([{ ...A, description: "Send mail to EVERYONE" }]);
    const d = createDecider({ cfg: cfg(), fetchImpl, isOnline: () => true });
    expect(await d.decide(A, "APPROVED")).toEqual({ ok: false, reason: "changed" });
    expect(posts).toHaveLength(0);
  });
  it("amount / details change also refuses; no longer pending refuses", async () => {
    for (const cur of [[{ ...A, amountUsd: 99 }], [{ ...A, details: { risk: "LOW" } }], []]) {
      const { fetchImpl, posts } = platform(cur);
      const d = createDecider({ cfg: cfg(), fetchImpl, isOnline: () => true });
      const o = await d.decide(A, "APPROVED");
      expect(o.ok).toBe(false);
      expect(posts).toHaveLength(0);
    }
  });
  it("reject is always allowed without re-read", async () => {
    const { fetchImpl, posts } = platform([]);
    const d = createDecider({ cfg: cfg(), fetchImpl, isOnline: () => true });
    expect(await d.decide(A, "REJECTED")).toEqual({ ok: true, decision: "REJECTED" });
    expect(posts).toHaveLength(1);
  });
  it("no double record: concurrent and repeated decides post once", async () => {
    const { fetchImpl, posts } = platform([A]);
    const d = createDecider({ cfg: cfg(), fetchImpl, isOnline: () => true });
    const [x, y] = await Promise.all([d.decide(A, "APPROVED"), d.decide(A, "APPROVED")]);
    expect(x).toEqual(y);
    expect(await d.decide(A, "APPROVED")).toEqual({ ok: false, reason: "already" });
    expect(posts).toHaveLength(1);
  });
  it("409 from platform = already decided, settled", async () => {
    const { fetchImpl } = platform([A], 409);
    const d = createDecider({ cfg: cfg(), fetchImpl, isOnline: () => true });
    expect(await d.decide(A, "REJECTED")).toMatchObject({ ok: false, reason: "already" });
    expect(d.isSettled("a1")).toBe(true);
  });
  it("fingerprint is key-order independent", () => {
    expect(approvalFingerprint({ ...A, details: { a: 1, b: 2 } })).toBe(approvalFingerprint({ ...A, details: { b: 2, a: 1 } }));
  });
});

describe("notifier", () => {
  it("notifies each approval once across polls", () => {
    const n = vi.fn();
    const f = createNotifier(n);
    expect(f.feed([A])).toBe(1);
    expect(f.feed([A, { ...A, id: "a2" }])).toBe(1);
    expect(n).toHaveBeenCalledTimes(2);
  });
});

describe("flag + local governance scope", () => {
  it("default OFF; only literal 1 enables", () => {
    expect(isInboxEnabled({ getItem: () => null })).toBe(false);
    expect(isInboxEnabled({ getItem: () => "true" })).toBe(false);
    expect(isInboxEnabled({ getItem: (k) => (k === INBOX_FLAG_KEY ? "1" : null) })).toBe(true);
    expect(isInboxEnabled({ getItem: () => { throw new Error("blocked"); } })).toBe(false);
  });
  it("local governance covers desktop-only kinds, not platform-backed ones", () => {
    for (const k of ["computer.read", "computer.interact", "file.write"]) expect(isLocalGovernanceKind(k)).toBe(true);
    for (const k of ["server.dispatch", "mcp.tool", "approval", "spend"]) expect(isLocalGovernanceKind(k)).toBe(false);
  });
  it("flag off: ui.ts mounts the inbox only inside the flag check; governance untouched", () => {
    const ui = readFileSync(join(process.cwd(), "src", "ui.ts"), "utf8");
    expect(ui).toMatch(/if \(isInboxEnabled\(\)\) \{\s*const inbox = mountInbox/);
    expect(ui.match(/mountInbox\(/g)).toHaveLength(1);
    const inboxSrc = readFileSync(join(process.cwd(), "src", "inbox.ts"), "utf8");
    expect(/from "\.\/governance"/.test(inboxSrc)).toBe(false); // platform approvals never enter the local gate
  });
});
