/**
 * Opt-in end-to-end run of the panel store against a REAL `braavo daemon`
 * (CLI branch feat/chat). It stands in for the Rust host with a node HTTP
 * transport that keeps the same guarantees (loopback, token from the daemon
 * dir, no Origin header). Point it at a throwaway HOME — it creates a company,
 * hires agents and runs a routine:
 *
 *   BRAAVO_E2E_DAEMON_DIR=<tmp HOME>/.braavo/daemon pnpm exec vitest run company-panel-live
 */
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DaemonReply, StreamEvent } from "../daemon-client";
import { createPanelApi, type PanelTransport } from "../company-panel/api";
import { TEMPLATE_IDS } from "../company-panel/map";
import { createPanelStore } from "../company-panel/store";
import { parseMarkdown } from "../company-panel/markdown";

const dir = process.env.BRAAVO_E2E_DAEMON_DIR;

function nodeTransport(daemonDir: string): PanelTransport {
  const port = JSON.parse(readFileSync(join(daemonDir, "state.json"), "utf8")).port as number;
  const headers = () => ({ Authorization: `Bearer ${readFileSync(join(daemonDir, "token"), "utf8").trim()}`, Host: `127.0.0.1:${port}` });
  const home = join(daemonDir, "..", "..");
  return {
    request(method, path, body) {
      return new Promise<DaemonReply>((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: { ...headers(), ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) } }, res => {
          let raw = "";
          res.on("data", c => { raw += c; });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }));
        });
        req.on("error", () => reject("daemon-not-running"));
        req.end(payload);
      });
    },
    events(onEvent) {
      let closeReq: () => void = () => {};
      let cancelled = false;
      const done = new Promise<DaemonReply>(resolve => {
        const req = httpRequest({ host: "127.0.0.1", port, method: "GET", path: "/v1/events", headers: { ...headers(), Accept: "text/event-stream" } }, res => {
          let buf = "";
          res.on("data", c => {
            buf += c;
            for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
              const block = buf.slice(0, i); buf = buf.slice(i + 2);
              const event = /^event: (.*)$/m.exec(block)?.[1];
              const data = /^data: (.*)$/m.exec(block)?.[1];
              if (event && data) onEvent({ event, data: JSON.parse(data) } as StreamEvent);
            }
          });
          res.on("end", () => resolve({ status: cancelled ? 499 : res.statusCode ?? 0, body: cancelled ? "cancelled" : "ended" }));
          res.on("error", () => resolve({ status: cancelled ? 499 : 0, body: "closed" }));
        });
        req.on("error", () => resolve({ status: cancelled ? 499 : 0, body: "daemon-not-running" }));
        req.end();
        closeReq = () => { cancelled = true; req.destroy(); resolve({ status: 499, body: "cancelled" }); };
      });
      return { done, close: async () => closeReq() };
    },
    async findings(companyId, role) {
      // Same path the Rust host builds (daemon.rs findings_path).
      try { return { text: readFileSync(join(home, ".braavo", "memory", companyId, "findings", `${role}.md`), "utf8"), truncated: false }; }
      catch { return { text: "", truncated: false }; }
    },
  };
}

describe.skipIf(!dir)("company panel against a live daemon", () => {
  it("creates, hires, renders the panel, patches an agent and runs a routine", { timeout: 120_000 }, async () => {
    const transport = nodeTransport(dir!);
    const seen: string[] = [];
    const events = transport.events.bind(transport);
    transport.events = (on) => events(e => { seen.push(e.event); on(e); });
    const store = createPanelStore(createPanelApi(transport), { refreshDelayMs: 50 });
    store.getState().start();
    await expect.poll(() => store.getState().phase, { timeout: 10_000 }).toMatch(/no-company|ready/);

    if (store.getState().phase === "no-company") {
      const ok = await store.getState().createAndHire({ name: "E2E Panel Co", mission: "test" }, {
        templates: [...TEMPLATE_IDS], competitorUrls: "https://example.com", releaseUrls: "", timezone: "Europe/Istanbul", appLocale: "tr",
      });
      expect(ok, JSON.stringify(store.getState().hireError ?? store.getState().createError)).toBe(true);
      const hire = store.getState().hireResult!;
      expect(hire.hired.length).toBe(7);
      expect(hire.needsUrls).toEqual(["release-tracker/watch-releases"]);
      console.log("hire.needsSetup", JSON.stringify(hire.needsSetup.map(n => [n.agentName, n.reason, n.provider])));
    }
    const s = store.getState();
    expect(s.phase).toBe("ready");
    const panel = s.panel!;
    console.log("org", panel.rows.map(r => `${"  ".repeat(r.depth)}${r.agent.name} [${r.agent.role}] ${r.agent.setupNeeded ? "setup needed" : `${r.agent.provider}/${r.agent.model}`} · ${r.agent.status}`).join("\n"));
    expect(panel.rows[0].depth).toBe(0);
    expect(panel.rows.some(r => r.depth > 0)).toBe(true);
    for (const a of panel.agents) if (a.status === "error") expect([a.provider, a.model]).toEqual([null, null]);
    expect(panel.routines.length).toBeGreaterThan(0);

    // Pause / resume an agent through PATCH /v1/agents/:id.
    const target = panel.agents.find(a => a.role === "ceo")!;
    expect(await store.getState().updateAgent(target.id, { status: "paused" })).toBe(true);
    expect(store.getState().panel!.agents.find(a => a.id === target.id)!.status).toBe("paused");
    expect(await store.getState().updateAgent(target.id, { effort: "high" })).toBe(true);
    expect(store.getState().panel!.agents.find(a => a.id === target.id)!.effort).toBe("high");
    expect(await store.getState().updateAgent(target.id, { status: "idle" })).toBe(true);
    expect(store.getState().panel!.agents.find(a => a.id === target.id)!.status).not.toBe("paused");
    // A refused patch stays inline.
    expect(await store.getState().updateAgent(target.id, { provider: "NOPE", model: "x" })).toBe(false);
    console.log("refused patch:", JSON.stringify(store.getState().agentError[target.id]));

    // Run the competitor watch now (web preflight on example.com).
    const watch = store.getState().panel!.routines.find(r => r.preflight === "web")!;
    await store.getState().runRoutine(watch.id);
    console.log("run now:", JSON.stringify(store.getState().routineResult[watch.id]));
    expect(store.getState().routineResult[watch.id]).toBeDefined();
    await expect.poll(() => store.getState().panel!.routines.find(r => r.id === watch.id)!.last, { timeout: 10_000 }).not.toBeNull();
    console.log("activity", JSON.stringify(store.getState().panel!.activity.slice(0, 5)));
    // Every company: the market analyst's findings as the panel reads them.
    for (const c of store.getState().companies) {
      await store.getState().selectCompany(c.id);
      const f = store.getState().findings;
      console.log(`findings ${c.name}:`, JSON.stringify(f?.text.slice(-300) ?? null));
      if (f?.text.trim()) expect(parseMarkdown(f.text).some(b => b.kind === "heading")).toBe(true);
    }
    console.log("events seen", JSON.stringify(seen));
    expect(seen).toContain("company.changed");
    expect(seen).toContain("routine.executed");
    store.getState().stop();
  });
});
