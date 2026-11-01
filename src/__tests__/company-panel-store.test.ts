import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonReply, StreamEvent } from "../daemon-client";
import { createPanelApi, createTauriPanelTransport, type PanelTransport } from "../company-panel/api";
import { createPanelStore } from "../company-panel/store";
import { TEMPLATE_IDS } from "../company-panel/map";
import { agent, RAW_PANEL } from "./company-panel-fixture";

type Handler = (body: unknown) => DaemonReply | Promise<DaemonReply>;

/** A fake Rust host: a route table, a request log and a controllable event stream. */
function fakeTransport(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const subs: { onEvent: (e: StreamEvent) => void; end: (r: DaemonReply) => void; closed: boolean }[] = [];
  const findings: { companyId: string; role: string }[] = [];
  let findingsText = "## 2026-11-01 · Prices\n- https://a.com\n";
  const transport: PanelTransport = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      const h = routes[`${method} ${path}`];
      if (!h) return { status: 404, body: { error: "not found" } };
      return h(body);
    },
    events(onEvent) {
      let end!: (r: DaemonReply) => void;
      const done = new Promise<DaemonReply>(r => { end = r; });
      const sub = { onEvent, end, closed: false };
      subs.push(sub);
      return { done, close: async () => { sub.closed = true; end({ status: 499, body: "cancelled" }); } };
    },
    async findings(companyId, role) {
      findings.push({ companyId, role });
      return { text: findingsText, truncated: false };
    },
  };
  return { transport, calls, subs, findings, setFindings: (t: string) => { findingsText = t; } };
}

const ok = (body: unknown, status = 200): Handler => () => ({ status, body });
const MODELS = { providers: [{ id: "OLLAMA", hasKey: false, local: true }], local: { OLLAMA: ["qwen3:8b"] }, suggestions: { light: { status: "ok", provider: "OLLAMA", model: "qwen3:8b" } } };

const baseRoutes = (): Record<string, Handler> => ({
  "GET /v1/companies": ok({ companies: [{ id: "co_1", name: "Acme" }] }),
  "GET /v1/companies/co_1/panel": ok(RAW_PANEL),
  "GET /v1/models": ok(MODELS),
});

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("company panel store", () => {
  it("reports an offline daemon from the host error", async () => {
    const fake = fakeTransport({});
    fake.transport.request = async () => { throw "daemon-not-running"; };
    const store = createPanelStore(createPanelApi(fake.transport));
    store.getState().start();
    await vi.waitFor(() => expect(store.getState().phase).toBe("offline"));
    expect(store.getState().error?.code).toBe("not-running");
    store.getState().stop();
  });

  it("shows the create form when there is no company", async () => {
    const fake = fakeTransport({ ...baseRoutes(), "GET /v1/companies": ok({ companies: [] }) });
    const store = createPanelStore(createPanelApi(fake.transport));
    await store.getState().refresh();
    expect(store.getState().phase).toBe("no-company");
    expect(store.getState().panel).toBeNull();
  });

  it("loads the panel, the models and the market analyst's findings", async () => {
    const fake = fakeTransport(baseRoutes());
    const store = createPanelStore(createPanelApi(fake.transport));
    store.getState().start();
    await vi.waitFor(() => expect(store.getState().phase).toBe("ready"));
    await vi.waitFor(() => expect(store.getState().findings).not.toBeNull());
    const s = store.getState();
    expect(s.companyId).toBe("co_1");
    expect(s.panel!.rows.map(r => r.agent.name)).toEqual(["Genel Müdür", "Pazar Analisti", "Teknik Lider"]);
    expect(s.panel!.agents[1]).toMatchObject({ setupNeeded: true, model: null });
    expect(s.models).toEqual(MODELS);
    expect(fake.findings).toEqual([{ companyId: "co_1", role: "market-analyst" }]);
    expect(s.findings!.text).toContain("Prices");
    expect(s.wizardOpen).toBe(false);
    expect(s.live).toBe(true);
    store.getState().stop();
  });

  it("creates a company, hires and shows needsSetup / needsUrls", async () => {
    let created = false;
    const fake = fakeTransport({
      ...baseRoutes(),
      "GET /v1/companies": () => ({ status: 200, body: { companies: created ? [{ id: "co_1", name: "Acme" }] : [] } }),
      "POST /v1/companies": () => { created = true; return { status: 201, body: { company: { id: "co_1", name: "Acme" } } }; },
      "POST /v1/companies/co_1/hire": ok({
        agents: [agent({ status: "error" })], routines: [{ id: "rt_1" }], skipped: [],
        needsSetup: [{ agentId: "ag_1", reason: "setup-required" }], needsUrls: ["release-tracker/watch-releases"],
      }, 201),
    });
    const store = createPanelStore(createPanelApi(fake.transport));
    await store.getState().refresh();
    expect(store.getState().phase).toBe("no-company");
    const ok1 = await store.getState().createAndHire(
      { name: "  Acme ", mission: "" },
      { templates: [...TEMPLATE_IDS], competitorUrls: "https://a.com", releaseUrls: "", timezone: "Europe/Istanbul", appLocale: "tr" },
    );
    expect(ok1).toBe(true);
    const posts = fake.calls.filter(c => c.method === "POST");
    expect(posts.map(c => [c.path, c.body])).toEqual([
      ["/v1/companies", { name: "Acme" }],
      ["/v1/companies/co_1/hire", { templates: "all", urls: { "market-analyst/watch-competitors": ["https://a.com"] }, timezone: "Europe/Istanbul", locale: "tr" }],
    ]);
    const s = store.getState();
    expect(s.phase).toBe("ready");
    expect(s.hireResult!.needsSetup).toEqual([{ agentId: "ag_1", agentName: "Genel Müdür", reason: "setup-required", provider: null }]);
    expect(s.hireResult!.needsUrls).toEqual(["release-tracker/watch-releases"]);
  });

  it("keeps a hire failure inline and the created company", async () => {
    const fake = fakeTransport({
      ...baseRoutes(),
      "POST /v1/companies": ok({ company: { id: "co_1" } }, 201),
      "POST /v1/companies/co_1/hire": ok({ error: "unknown time zone" }, 400),
      "GET /v1/companies/co_1/panel": ok({ ...RAW_PANEL, agents: [], tree: [], routines: [] }),
    });
    const store = createPanelStore(createPanelApi(fake.transport));
    const result = await store.getState().createAndHire({ name: "Acme" }, { templates: ["ceo"], competitorUrls: "", releaseUrls: "", timezone: "Mars/Base", appLocale: "en" });
    expect(result).toBe(false);
    const s = store.getState();
    expect(s.hireError).toEqual({ code: "invalid", message: "unknown time zone" });
    expect(s.phase).toBe("ready");
    expect(s.wizardOpen).toBe(true); // nobody hired yet: the wizard stays open
  });

  it("patches an agent, refreshes, and shows a daemon refusal inline", async () => {
    let fail = false;
    const fake = fakeTransport({
      ...baseRoutes(),
      "PATCH /v1/agents/ag_2": () => fail ? { status: 400, body: { error: "unknown provider" } } : { status: 200, body: { agent: { id: "ag_2" } } },
    });
    const store = createPanelStore(createPanelApi(fake.transport));
    await store.getState().refresh();
    const panelReads = () => fake.calls.filter(c => c.path === "/v1/companies/co_1/panel").length;
    const before = panelReads();
    expect(await store.getState().updateAgent("ag_2", { provider: "OLLAMA", model: "qwen3:8b" })).toBe(true);
    expect(fake.calls.find(c => c.method === "PATCH")!.body).toEqual({ provider: "OLLAMA", model: "qwen3:8b" });
    expect(panelReads()).toBe(before + 1);
    fail = true;
    expect(await store.getState().updateAgent("ag_2", { effort: "high" })).toBe(false);
    expect(store.getState().agentError.ag_2).toEqual({ code: "invalid", message: "unknown provider" });
    expect(store.getState().agentBusy.ag_2).toBeUndefined();
    fail = false;
    await store.getState().updateAgent("ag_2", { status: "paused" });
    expect(store.getState().agentError.ag_2).toBeUndefined();
  });

  it("runs a routine now and keeps the outcome per routine", async () => {
    const fake = fakeTransport({
      ...baseRoutes(),
      "POST /v1/routines/rt_1/run": ok({ outcome: "changed", note: "2 pages" }),
      "POST /v1/routines/rt_2/run": ok({ error: "routine is already running" }, 409),
    });
    const store = createPanelStore(createPanelApi(fake.transport));
    await store.getState().refresh();
    await store.getState().runRoutine("rt_1");
    await store.getState().runRoutine("rt_2");
    const s = store.getState();
    expect(s.routineResult.rt_1).toEqual({ outcome: "changed", note: "2 pages" });
    expect(s.routineResult.rt_2).toEqual({ error: { code: "busy", message: "routine is already running" } });
    expect(s.routineBusy).toEqual({});
  });

  it("refreshes on daemon events (debounced) and applies agent status at once", async () => {
    const fake = fakeTransport(baseRoutes());
    const store = createPanelStore(createPanelApi(fake.transport), { refreshDelayMs: 300 });
    store.getState().start();
    await vi.waitFor(() => expect(store.getState().phase).toBe("ready"));
    const panelReads = () => fake.calls.filter(c => c.path === "/v1/companies/co_1/panel").length;
    const before = panelReads();
    const [sub] = fake.subs;
    sub.onEvent({ event: "agent.status", data: { type: "agent.status", agentId: "ag_3", status: "idle" } });
    expect(store.getState().panel!.agents.find(a => a.id === "ag_3")!.status).toBe("idle");
    sub.onEvent({ event: "company.changed", data: { type: "company.changed", companyId: "co_1" } });
    sub.onEvent({ event: "routine.executed", data: { type: "routine.executed", routineId: "rt_1", outcome: "changed" } });
    sub.onEvent({ event: "conversation.changed", data: { conversationId: "cv_1" } });
    expect(panelReads()).toBe(before);
    await vi.advanceTimersByTimeAsync(300);
    await flush();
    expect(panelReads()).toBe(before + 1); // three events, one refresh
    store.getState().stop();
  });

  it("reconnects a dropped event stream with backoff, and stops cleanly", async () => {
    const fake = fakeTransport(baseRoutes());
    const store = createPanelStore(createPanelApi(fake.transport), { reconnectMs: 1000, reconnectMaxMs: 4000 });
    store.getState().start();
    await vi.waitFor(() => expect(store.getState().phase).toBe("ready"));
    expect(fake.subs).toHaveLength(1);
    fake.subs[0].end({ status: 200, body: "ended" }); // daemon restarted
    await flush();
    expect(store.getState().live).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(fake.subs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.subs).toHaveLength(2);
    expect(store.getState().live).toBe(true);
    fake.subs[1].end({ status: 0, body: "daemon-not-running" });
    await flush();
    await vi.advanceTimersByTimeAsync(1999);
    expect(fake.subs).toHaveLength(2); // second delay doubled to 2 s
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.subs).toHaveLength(3);

    store.getState().stop();
    await flush();
    expect(fake.subs[2].closed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.subs).toHaveLength(3); // no reconnect after stop
    expect(store.getState().live).toBe(false);
  });

  it("switches the findings role", async () => {
    const fake = fakeTransport({
      ...baseRoutes(),
      "GET /v1/companies/co_1/panel": ok({ ...RAW_PANEL, agents: [...RAW_PANEL.agents, agent({ id: "ag_4", role: "release-tracker", name: "Sürüm" })] }),
    });
    const store = createPanelStore(createPanelApi(fake.transport));
    await store.getState().refresh();
    fake.setFindings("## releases");
    await store.getState().setFindingsRole("release-tracker");
    expect(fake.findings.at(-1)).toEqual({ companyId: "co_1", role: "release-tracker" });
    expect(store.getState().findings!.text).toBe("## releases");
  });
});

describe("Tauri panel transport", () => {
  it("uses the scoped host commands and a valid subscription id", async () => {
    const invoked: { cmd: string; args?: Record<string, unknown> }[] = [];
    let resolveSub!: (r: DaemonReply) => void;
    const invoke = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
      invoked.push({ cmd, args });
      if (cmd === "daemon_events_subscribe") return new Promise(r => { resolveSub = r; });
      if (cmd === "daemon_events_unsubscribe") { resolveSub({ status: 499, body: "cancelled" }); return true; }
      if (cmd === "daemon_findings") return { text: "x", truncated: false };
      return { status: 200, body: { companies: [] } };
    };
    class Channel { onmessage: ((m: unknown) => void) | null = null; }
    const t = createTauriPanelTransport(invoke, Channel);
    await t.request("GET", "/v1/companies");
    expect(invoked[0]).toEqual({ cmd: "daemon_request", args: { method: "GET", path: "/v1/companies", body: null } });
    const seen: StreamEvent[] = [];
    const sub = t.events(e => seen.push(e));
    const args = invoked[1].args!;
    expect(invoked[1].cmd).toBe("daemon_events_subscribe");
    expect(String(args.subscriptionId)).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    (args.onEvent as Channel).onmessage!({ event: "company.changed", data: { companyId: "co_1" } });
    (args.onEvent as Channel).onmessage!("junk");
    expect(seen).toEqual([{ event: "company.changed", data: { companyId: "co_1" } }]);
    await sub.close();
    expect(invoked[2]).toEqual({ cmd: "daemon_events_unsubscribe", args: { subscriptionId: args.subscriptionId } });
    expect(await sub.done).toEqual({ status: 499, body: "cancelled" });
    expect(await t.findings("co_1", "market-analyst")).toEqual({ text: "x", truncated: false });
    expect(invoked[3]).toEqual({ cmd: "daemon_findings", args: { companyId: "co_1", role: "market-analyst" } });
  });

  it("turns a failed subscribe into a reconnectable end, not a rejection", async () => {
    const t = createTauriPanelTransport(async (cmd) => { if (cmd === "daemon_events_subscribe") throw "daemon-not-running"; return null; }, class { onmessage = null; });
    expect(await t.events(() => {}).done).toEqual({ status: 0, body: "daemon-not-running" });
  });
});
