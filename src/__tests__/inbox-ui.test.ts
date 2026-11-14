import { afterEach, describe, expect, it, vi } from "vitest";
import { disposeActiveInbox, mountInbox } from "../inbox-ui";
import { createDecider } from "../inbox";
import { makeT } from "../i18n";
import type { Config } from "../config";

class El {
  textContent = ""; className = ""; disabled = false; style: Record<string, string> = {};
  attrs: Record<string, string> = {}; children: El[] = []; handlers = new Map<string, () => unknown>(); parent: El | null = null;
  constructor(readonly tag: string) {}
  append(...c: El[]) { for (const x of c) { x.parent = this; this.children.push(x); } }
  replaceChildren(...c: El[]) { this.children = []; this.append(...c); }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(n: string, h: () => unknown) { this.handlers.set(n, h); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); this.parent = null; }
  all(): El[] { return [this, ...this.children.flatMap(c => c.all())]; }
  button(text: string) { const b = this.all().find(e => e.tag === "button" && e.textContent === text); if (!b) throw Error("no button " + text); return b; }
}
const cfg = (): Config => ({ apiUrl: "http://127.0.0.1:18183/api/v1", token: "t", refreshToken: "r" });
const t = makeT("en");
const A = { id: "a1", runId: "r1", type: "SPEND", status: "PENDING", description: "Send mail", amountUsd: 1 };
const res = (status: number, body: unknown) => ({ status, ok: status < 300, statusText: String(status), headers: { get: () => null }, json: async () => body });

function stubDom() {
  vi.stubGlobal("document", { createElement: (tag: string) => new El(tag) });
  const host = new El("div");
  return host;
}
function stubNet(approvals: unknown[], opts: { decide?: number; fail?: boolean } = {}) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
    calls.push(`${init.method} ${url}`);
    if (opts.fail) throw new TypeError("fetch failed");
    if (init.method === "POST") return res(opts.decide ?? 200, opts.decide && opts.decide >= 300 ? { error: "x" } : {});
    if (url.includes("/runs")) return res(200, { runs: [], nextCursor: null });
    return res(200, approvals);
  }));
  return calls;
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); };

afterEach(() => { disposeActiveInbox(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("inbox panel", () => {
  it("decision error message survives the redraw", async () => {
    const host = stubDom();
    // Pending list shows A, but by decide time it is gone from the platform -> "gone"
    let phase = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      if (url.includes("/runs")) return res(200, { runs: [], nextCursor: null });
      if (init.method === "POST") return res(200, {});
      return res(200, phase++ === 0 ? [A] : []);
    }));
    const h = mountInbox(host as any, cfg(), t);
    h.open(); await flush();
    const panel = host.children[0];
    panel.button("Approve").handlers.get("click")!(); await flush();
    const msg = panel.all().find(e => e.attrs.role === "status")!;
    expect(msg.textContent).toBe(t("inbox.gone"));
  });
  it("failed refresh keeps the Close button", async () => {
    const host = stubDom(); stubNet([], { fail: true });
    mountInbox(host as any, cfg(), t).open(); await flush();
    const panel = host.children[0];
    expect(panel.button("Close")).toBeTruthy();
    expect(panel.all().find(e => e.attrs.role === "status")!.textContent).toBe(t("inbox.offline"));
  });
  it("dispose stops polling and re-mount disposes the previous instance", async () => {
    vi.useFakeTimers();
    const host = stubDom(); const calls = stubNet([]);
    const first = mountInbox(host as any, cfg(), t); first.open();
    await vi.advanceTimersByTimeAsync(0);
    const n0 = calls.length;
    mountInbox(host as any, cfg(), t); // replaces first
    expect(host.children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(calls.length).toBe(n0); // old poller dead, new one never opened
    disposeActiveInbox();
    expect(host.children).toHaveLength(0);
  });
});

describe("decider POST-stage fail-closed", () => {
  const A2 = { ...A };
  const mk = (post: (init: any) => Promise<any>) => vi.fn(async (_u: string, init: any) => init.method === "POST" ? post(init) : res(200, [A2]));
  it("network error -> not ok (offline)", async () => {
    const d = createDecider({ cfg: cfg(), fetchImpl: mk(async () => { throw new TypeError("x"); }), isOnline: () => true });
    expect(await d.decide(A2, "APPROVED")).toMatchObject({ ok: false, reason: "offline" });
  });
  it("5xx -> not ok (error), not settled", async () => {
    const d = createDecider({ cfg: cfg(), fetchImpl: mk(async () => res(503, { error: "down" })), isOnline: () => true });
    expect(await d.decide(A2, "APPROVED")).toMatchObject({ ok: false, reason: "error" });
    expect(d.isSettled("a1")).toBe(false);
  });
  it("unparseable 2xx body -> not ok (error)", async () => {
    const bad = { status: 200, ok: true, statusText: "200", headers: { get: () => null }, json: async () => { throw new SyntaxError("bad json"); } };
    const d = createDecider({ cfg: cfg(), fetchImpl: mk(async () => bad), isOnline: () => true });
    expect(await d.decide(A2, "APPROVED")).toMatchObject({ ok: false, reason: "error" });
  });
  it("hung request: timeout releases the id, nothing approved, retry possible", async () => {
    vi.useFakeTimers();
    const d = createDecider({ cfg: cfg(), fetchImpl: mk(() => new Promise(() => {})), isOnline: () => true, timeoutMs: 1000 });
    const p = d.decide(A2, "REJECTED");
    await vi.advanceTimersByTimeAsync(1300);
    expect(await p).toMatchObject({ ok: false, reason: "offline" });
    const again = d.decide(A2, "REJECTED"); // inflight cleared -> a new attempt is made
    await vi.advanceTimersByTimeAsync(1300);
    expect(await again).toMatchObject({ ok: false });
    expect(d.isSettled("a1")).toBe(false);
  });
});
