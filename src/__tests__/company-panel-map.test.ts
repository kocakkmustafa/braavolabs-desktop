import { describe, expect, it } from "vitest";
import {
  budgetLevel, buildHireRequest, displayNote, flattenTree, keysAddCommand, parseBudget, parseUrls, toAgent, toCompanies, toConversationRefs, toHireResult,
  toPanel, toPanelEvent, toTask, toTasks, TEMPLATE_IDS,
} from "../company-panel/map";
import { parseInline, parseMarkdown } from "../company-panel/markdown";
import { agent, RAW_PANEL } from "./company-panel-fixture";


describe("company panel mapping", () => {
  it("maps the panel snapshot and flattens the org tree pre-order", () => {
    const p = toPanel(RAW_PANEL)!;
    expect(p.company).toEqual({ id: "co_1", name: "Acme", mission: "Ship", monthlyBudgetUsd: null });
    expect(p.rows.map(r => [r.agent.id, r.depth])).toEqual([["ag_1", 0], ["ag_2", 1], ["ag_3", 1]]);
    expect(p.routines[0]).toMatchObject({ agentName: "Pazar Analisti", enabled: true, last: { outcome: "no-change", note: null } });
    expect(p.routines[1]).toMatchObject({ enabled: false, nextFireAt: null, last: null });
    expect(p.month).toEqual({ inputTokens: 30, outputTokens: 15, usd: 0.03, unpricedCalls: 0, budgetRatio: null });
    expect(p.tasks).toEqual({ open: 0, running: 0, done: 0, failed: 0 });
    expect(p.agents[0].month).toEqual({ inputTokens: 10, outputTokens: 5, usd: 0.01, runs: 2 });
  });

  it("never presents an error agent's placeholder provider/model as its model (K3)", () => {
    const a = toAgent(agent({ status: "error", provider: "ANTHROPIC", model: "placeholder" }))!;
    expect(a).toMatchObject({ status: "error", setupNeeded: true, provider: null, model: null });
    expect(toAgent(agent())).toMatchObject({ setupNeeded: false, provider: "ANTHROPIC", model: "claude-x" });
  });

  it("keeps agents the tree misses, skips unknown and repeated ids", () => {
    const agents = [toAgent(agent())!, toAgent(agent({ id: "ag_9", name: "Orphan" }))!];
    const rows = flattenTree([{ id: "ag_1", children: [{ id: "ghost", children: [] }, { id: "ag_1", children: [] }] }], agents);
    expect(rows.map(r => [r.agent.id, r.depth])).toEqual([["ag_1", 0], ["ag_9", 0]]);
  });

  it("drops the local findings path from routine notes", () => {
    expect(displayNote("1 pages · 1 changed · no summary: no anthropic key · /Users/u/.braavo/memory/co_1/findings/market-analyst.md")).toBe("1 pages · 1 changed · no summary: no anthropic key");
    expect(displayNote("C:\\Users\\u\\f.md")).toBeNull();
    expect(displayNote("1 pages")).toBe("1 pages");
    expect(displayNote(null)).toBeNull();
  });

  it("is defensive about malformed input", () => {
    expect(toPanel(null)).toBeNull();
    expect(toPanel({ company: {} })).toBeNull();
    const p = toPanel({ company: { id: "co_1" }, agents: [{ name: "no id" }, agent({ status: "weird", month: { runs: -1, usd: "x" } })] })!;
    expect(p.company.name).toBe("co_1");
    expect(p.agents).toHaveLength(1);
    expect(p.agents[0]).toMatchObject({ status: "unknown", month: { runs: 0, usd: 0 } });
    expect(toCompanies({ companies: [{ id: "co_1", name: "A" }, { name: "x" }] })).toEqual([{ id: "co_1", name: "A" }]);
  });
});

describe("hire wizard", () => {
  it("parses URLs from a textarea, rejecting non-web entries", () => {
    expect(parseUrls("https://a.com/pricing\n  http://b.io, ftp://c.com nope https://a.com/pricing")).toEqual({
      urls: ["https://a.com/pricing", "http://b.io"], invalid: ["ftp://c.com", "nope"],
    });
    expect(parseUrls(Array.from({ length: 30 }, (_, i) => `https://x${i}.com`).join("\n")).urls).toHaveLength(20);
  });

  it("builds the daemon hire request", () => {
    expect(buildHireRequest({ templates: [...TEMPLATE_IDS], competitorUrls: "https://a.com", releaseUrls: "", timezone: "Europe/Istanbul", appLocale: "tr" })).toEqual({
      templates: "all", urls: { "market-analyst/watch-competitors": ["https://a.com"] }, timezone: "Europe/Istanbul", locale: "tr",
    });
    // URLs for an unchecked template are not sent; non-tr locales name agents in English.
    expect(buildHireRequest({ templates: ["release-tracker", "ceo"], competitorUrls: "https://a.com", releaseUrls: "https://r.dev/changelog", timezone: " ", appLocale: "de" })).toEqual({
      templates: ["ceo", "release-tracker"], urls: { "release-tracker/watch-releases": ["https://r.dev/changelog"] }, locale: "en",
    });
  });

  it("maps the hire result with agent names for needsSetup", () => {
    const r = toHireResult({
      agents: [{ id: "ag_1", name: "Genel Müdür", role: "ceo", status: "error", provider: "ANTHROPIC", model: "x" }, { id: "ag_2", name: "İçerik", role: "content-lead", status: "error" }],
      routines: [{ id: "rt_1" }, { id: "rt_2" }],
      skipped: ["market-analyst"],
      needsSetup: [{ agentId: "ag_1", reason: "setup-required" }, { agentId: "ag_2", reason: "model-required", provider: "OPENAI" }],
      needsUrls: ["release-tracker/watch-releases"],
    });
    expect(r.routineCount).toBe(2);
    expect(r.skipped).toEqual(["market-analyst"]);
    expect(r.needsSetup).toEqual([
      { agentId: "ag_1", agentName: "Genel Müdür", reason: "setup-required", provider: null },
      { agentId: "ag_2", agentName: "İçerik", reason: "model-required", provider: "OPENAI" },
    ]);
    expect(r.needsUrls).toEqual(["release-tracker/watch-releases"]);
    expect(keysAddCommand("OPENAI")).toBe("braavo keys add openai");
    expect(keysAddCommand(null)).toBe("braavo keys add <provider>");
  });
});

describe("events and findings markdown", () => {
  it("maps daemon events", () => {
    expect(toPanelEvent("company.changed", { type: "company.changed", companyId: "co_1" })).toEqual({ kind: "company", companyId: "co_1" });
    expect(toPanelEvent("agent.status", { type: "agent.status", agentId: "ag_1", status: "paused" })).toEqual({ kind: "agent", agentId: "ag_1", status: "paused" });
    expect(toPanelEvent("routine.executed", { type: "routine.executed", routineId: "rt_1", outcome: "ran" })).toEqual({ kind: "routine", routineId: "rt_1", outcome: "ran" });
    expect(toPanelEvent("conversation.changed", { conversationId: "cv" })).toEqual({ kind: "other" });
    expect(toPanelEvent("company.changed", "garbage")).toEqual({ kind: "other" });
  });

  it("parses findings markdown into plain blocks (no HTML)", () => {
    const blocks = parseMarkdown("\n## 2026-11-01 06:00 UTC · Prices\n\n- https://a.com\n  - price: +$39, -$49\n\nX **cut** price by `20%`.\n<img src=x onerror=alert(1)>\n```\nraw <b>\n```\n");
    expect(blocks.map(b => b.kind)).toEqual(["heading", "item", "item", "paragraph", "code"]);
    expect(blocks[2]).toMatchObject({ kind: "item", depth: 1 });
    expect(blocks[3]).toEqual({ kind: "paragraph", inline: [
      { kind: "text", text: "X " }, { kind: "strong", text: "cut" }, { kind: "text", text: " price by " }, { kind: "code", text: "20%" },
      { kind: "text", text: ". <img src=x onerror=alert(1)>" },
    ] });
    expect(blocks[4]).toEqual({ kind: "code", text: "raw <b>" });
    expect(parseInline("plain")).toEqual([{ kind: "text", text: "plain" }]);
  });
});

describe("budgets and tasks", () => {
  it("maps budgets, unpriced calls and task counts from the panel", () => {
    const p = toPanel({
      ...RAW_PANEL,
      company: { ...RAW_PANEL.company, monthlyBudgetUsd: 50 },
      agents: [agent({ budgetUsdMonthly: 10, budgetRatio: 0.85 })],
      month: { ...RAW_PANEL.month, unpricedCalls: 3, budgetRatio: 0.0006 },
      tasks: { open: 2, running: 1, done: 4, failed: 1, recent: [] },
    })!;
    expect(p.company.monthlyBudgetUsd).toBe(50);
    expect(p.agents[0]).toMatchObject({ budgetUsdMonthly: 10, budgetRatio: 0.85 });
    expect(p.month).toMatchObject({ unpricedCalls: 3, budgetRatio: 0.0006 });
    expect(p.tasks).toEqual({ open: 2, running: 1, done: 4, failed: 1 });
  });

  it("reads tasks from store rows and summaries alike, never inventing a status", () => {
    expect(toTask({ id: "tk_1", title: "Write", status: "DONE", assignee_agent_id: "ag_1", result: "Done.", conversation_id: "cv_1", updated_at: "2026-11-02T00:00:00Z" }))
      .toMatchObject({ status: "DONE", assigneeAgentId: "ag_1", result: "Done.", conversationId: "cv_1", updatedAt: "2026-11-02T00:00:00Z" });
    expect(toTask({ id: "tk_2", status: "WEIRD", assigneeAgentId: "ag_2" })).toMatchObject({ title: "tk_2", status: "UNKNOWN", assigneeAgentId: "ag_2", note: null });
    expect(toTask({ title: "no id" })).toBeNull();
    expect(toTasks({ tasks: [{ id: "a" }, null, { id: "" }] }).map(t => t.id)).toEqual(["a"]);
    expect(toConversationRefs({ conversations: [{ id: "cv_1", title: "Hi", updatedAt: "x", messageCount: 4 }, {}] }))
      .toEqual([{ id: "cv_1", title: "Hi", updatedAt: "x", messageCount: 4 }]);
    expect(toPanelEvent("task.changed", { type: "task.changed", taskId: "tk_1", companyId: "co_1" })).toEqual({ kind: "task", taskId: "tk_1" });
  });

  it("parses budget fields and levels", () => {
    expect(parseBudget("", 100)).toBeNull();
    expect(parseBudget(" $25.50 ", 100)).toBe(25.5);
    expect(parseBudget("25,5", 100)).toBe(25.5);
    expect(parseBudget("0", 100)).toBe(0);
    for (const bad of ["-1", "abc", "1.234", "101", "1e3"]) expect(parseBudget(bad, 100), bad).toBe("invalid");
    expect([null, 0.2, 0.8, 1, 3].map(budgetLevel)).toEqual(["none", "ok", "warn", "over", "over"]);
  });
});
