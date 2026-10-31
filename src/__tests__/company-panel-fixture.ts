/** Shared daemon panel snapshot for the company panel tests (shape: CLI src/daemon/company.ts `panel`). */
export const agent = (over: Record<string, unknown> = {}) => ({
  id: "ag_1", name: "Genel Müdür", role: "ceo", title: "management", provider: "ANTHROPIC", model: "claude-x", effort: null,
  status: "idle", reportsToAgentId: null, budgetUsdMonthly: null, month: { inputTokens: 10, outputTokens: 5, usd: 0.01, runs: 2 }, ...over,
});

export const RAW_PANEL = {
  company: { id: "co_1", name: "Acme", mission: "Ship", status: "active", monthlyBudgetUsd: null },
  agents: [
    agent(),
    agent({ id: "ag_2", name: "Pazar Analisti", role: "market-analyst", reportsToAgentId: "ag_1", status: "error", provider: "ANTHROPIC", model: "placeholder-model", effort: "low" }),
    agent({ id: "ag_3", name: "Teknik Lider", role: "cto", reportsToAgentId: "ag_1", status: "paused" }),
  ],
  tree: [{ id: "ag_1", children: [{ id: "ag_2", children: [] }, { id: "ag_3", children: [] }] }],
  routines: [
    { id: "rt_1", name: "Rakipleri izle", agentId: "ag_2", rrule: "FREQ=HOURLY;INTERVAL=6", timezone: "Europe/Istanbul", enabled: true, nextFireAt: "2026-11-01T12:00:00.000Z", preflight: "web", last: { at: "2026-11-01T06:00:00.000Z", outcome: "no-change", note: null } },
    { id: "rt_2", name: "Heartbeat", agentId: "ag_1", rrule: "FREQ=DAILY", timezone: "UTC", enabled: false, nextFireAt: null, preflight: "none", last: null },
  ],
  activity: [{ actor: "user", verb: "hired-templates", summary: "7 agents", at: "2026-11-01T05:00:00.000Z" }],
  month: { since: "2026-11-01T00:00:00.000Z", inputTokens: 30, outputTokens: 15, usd: 0.03 },
};
