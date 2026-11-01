/**
 * Company panel (plan 2.5, D1/D2) — pure mappers from the daemon's raw JSON to
 * display-ready views. Same rule as company.ts: never invent a value. A field
 * the daemon did not send stays null and the view says so.
 *
 * Display rule (founder decision K3, CLI commit 6435a67): an agent in `error`
 * has no usable model yet. Its stored provider/model is a placeholder from the
 * hire step, so the view marks it `setupNeeded` and never presents it as the
 * agent's model.
 */

export const TEMPLATE_IDS = [
  "ceo", "market-analyst", "content-social", "customer-voice", "finance-tracker", "tech-lead", "release-tracker",
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

/** Routine keys that need URLs (`needsUrls`), as the daemon's hire request names them. */
export const URL_KEYS = { competitors: "market-analyst/watch-competitors", releases: "release-tracker/watch-releases" } as const;

/** Roles whose routines append to `memory/<companyId>/findings/<role>.md`. */
export const FINDINGS_ROLES = ["market-analyst", "release-tracker"] as const;

export type AgentStatus = "idle" | "running" | "error" | "paused" | "unknown";
/** Efforts the agent card offers; null = the model's default. */
export const EFFORT_CHOICES = [null, "low", "medium", "high"] as const;

export interface MonthUsage { inputTokens: number; outputTokens: number; usd: number; runs: number }

export interface AgentView {
  id: string;
  name: string;
  role: string;
  title: string | null;
  /** Null when the agent needs setup: the stored value is only a placeholder. */
  provider: string | null;
  model: string | null;
  effort: string | null;
  status: AgentStatus;
  setupNeeded: boolean;
  reportsToAgentId: string | null;
  budgetUsdMonthly: number | null;
  month: MonthUsage;
}

export interface OrgRow { agent: AgentView; depth: number }

export interface RoutineView {
  id: string;
  name: string;
  agentId: string;
  agentName: string | null;
  rrule: string;
  timezone: string;
  enabled: boolean;
  nextFireAt: string | null;
  preflight: string;
  last: { at: string | null; outcome: string; note: string | null } | null;
}

export interface ActivityView { actor: string; verb: string; summary: string; at: string }

export interface PanelView {
  company: { id: string; name: string; mission: string | null };
  agents: AgentView[];
  /** Org chart flattened pre-order (manager before reports) with depth. */
  rows: OrgRow[];
  routines: RoutineView[];
  /** Newest first, as the daemon sends it. */
  activity: ActivityView[];
  month: { inputTokens: number; outputTokens: number; usd: number };
}

export interface CompanyRef { id: string; name: string }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const STATUSES = new Set<AgentStatus>(["idle", "running", "error", "paused"]);
export function toStatus(v: unknown): AgentStatus {
  return STATUSES.has(v as AgentStatus) ? (v as AgentStatus) : "unknown";
}

/**
 * Routine notes end with the absolute findings path (`… · /Users/…/market-analyst.md`);
 * the panel shows findings itself, so the path segment is dropped (as the phone does).
 */
export function displayNote(note: unknown): string | null {
  if (typeof note !== "string" || !note.trim()) return null;
  const kept = note.split(" · ").filter(part => !/^(\/|[A-Za-z]:\\)/.test(part.trim()));
  return kept.join(" · ").trim() || null;
}

export function toCompanies(raw: unknown): CompanyRef[] {
  return list(obj(raw).companies)
    .map(obj)
    .filter(c => str(c.id))
    .map(c => ({ id: str(c.id), name: str(c.name) || str(c.id) }));
}

export function toAgent(raw: unknown): AgentView | null {
  const a = obj(raw);
  const id = str(a.id);
  if (!id) return null;
  const status = toStatus(a.status);
  const setupNeeded = status === "error";
  const m = obj(a.month);
  return {
    id,
    name: str(a.name) || id,
    role: str(a.role),
    title: strOrNull(a.title),
    provider: setupNeeded ? null : strOrNull(a.provider),
    model: setupNeeded ? null : strOrNull(a.model),
    effort: strOrNull(a.effort),
    status,
    setupNeeded,
    reportsToAgentId: strOrNull(a.reportsToAgentId),
    budgetUsdMonthly: numOrNull(a.budgetUsdMonthly),
    month: { inputTokens: num(m.inputTokens), outputTokens: num(m.outputTokens), usd: num(m.usd), runs: num(m.runs) },
  };
}

/**
 * Flatten the daemon's `tree` pre-order. Agents the tree does not mention (an
 * older daemon, a race with a hire) are appended as roots rather than hidden;
 * ids in the tree with no agent are skipped; a repeated id is shown once.
 */
export function flattenTree(tree: unknown, agents: AgentView[]): OrgRow[] {
  const byId = new Map(agents.map(a => [a.id, a]));
  const seen = new Set<string>();
  const rows: OrgRow[] = [];
  const walk = (nodes: unknown, depth: number) => {
    if (depth > 32) return;
    for (const n of list(nodes).map(obj)) {
      const id = str(n.id);
      const agent = byId.get(id);
      if (!agent || seen.has(id)) continue;
      seen.add(id);
      rows.push({ agent, depth });
      walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
  for (const a of agents) if (!seen.has(a.id)) rows.push({ agent: a, depth: 0 });
  return rows;
}

export function toPanel(raw: unknown): PanelView | null {
  const p = obj(raw);
  const c = obj(p.company);
  if (!str(c.id)) return null;
  const agents = list(p.agents).map(toAgent).filter((a): a is AgentView => a !== null);
  const names = new Map(agents.map(a => [a.id, a.name]));
  const routines: RoutineView[] = list(p.routines).map(obj).filter(r => str(r.id)).map(r => {
    const last = r.last && typeof r.last === "object" ? obj(r.last) : null;
    return {
      id: str(r.id),
      name: str(r.name) || str(r.id),
      agentId: str(r.agentId),
      agentName: names.get(str(r.agentId)) ?? null,
      rrule: str(r.rrule),
      timezone: str(r.timezone) || "UTC",
      enabled: r.enabled !== false,
      nextFireAt: strOrNull(r.nextFireAt),
      preflight: str(r.preflight) || "none",
      last: last ? { at: strOrNull(last.at), outcome: str(last.outcome) || "unknown", note: displayNote(last.note) } : null,
    };
  });
  const activity = list(p.activity).map(obj).map(a => ({ actor: str(a.actor), verb: str(a.verb), summary: str(a.summary), at: str(a.at) }));
  const m = obj(p.month);
  return {
    company: { id: str(c.id), name: str(c.name) || str(c.id), mission: strOrNull(c.mission) },
    agents,
    rows: flattenTree(p.tree, agents),
    routines,
    activity,
    month: { inputTokens: num(m.inputTokens), outputTokens: num(m.outputTokens), usd: num(m.usd) },
  };
}

// ── hire wizard ──────────────────────────────────────────────────────────────

export const MAX_URLS = 20;

/** Split a textarea into http(s) URLs (one per line, or separated by spaces/commas). */
export function parseUrls(text: string): { urls: string[]; invalid: string[] } {
  const urls: string[] = [];
  const invalid: string[] = [];
  for (const token of text.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)) {
    let ok = false;
    try {
      const u = new URL(token);
      ok = (u.protocol === "https:" || u.protocol === "http:") && Boolean(u.hostname);
    } catch { ok = false; }
    if (!ok) invalid.push(token);
    else if (!urls.includes(token)) urls.push(token);
  }
  return { urls: urls.slice(0, MAX_URLS), invalid };
}

export interface HireForm {
  templates: readonly string[];
  competitorUrls: string;
  releaseUrls: string;
  timezone: string;
  /** The app locale; the daemon names agents in tr or en. */
  appLocale: string;
}

export interface HireRequest {
  templates: "all" | string[];
  urls?: Record<string, string[]>;
  timezone?: string;
  locale: "tr" | "en";
}

export function buildHireRequest(form: HireForm): HireRequest {
  const chosen = TEMPLATE_IDS.filter(id => form.templates.includes(id));
  const urls: Record<string, string[]> = {};
  const competitors = parseUrls(form.competitorUrls).urls;
  const releases = parseUrls(form.releaseUrls).urls;
  if (chosen.includes("market-analyst") && competitors.length) urls[URL_KEYS.competitors] = competitors;
  if (chosen.includes("release-tracker") && releases.length) urls[URL_KEYS.releases] = releases;
  const timezone = form.timezone.trim();
  return {
    templates: chosen.length === TEMPLATE_IDS.length ? "all" : [...chosen],
    ...(Object.keys(urls).length ? { urls } : {}),
    ...(timezone ? { timezone } : {}),
    locale: form.appLocale === "tr" ? "tr" : "en",
  };
}

export interface SetupItem { agentId: string; agentName: string; reason: "setup-required" | "model-required" | string; provider: string | null }

export interface HireResultView {
  hired: AgentView[];
  routineCount: number;
  skipped: string[];
  needsSetup: SetupItem[];
  /** Routine keys (`market-analyst/watch-competitors`) still waiting for URLs. */
  needsUrls: string[];
}

export function toHireResult(raw: unknown): HireResultView {
  const r = obj(raw);
  const hired = list(r.agents).map(toAgent).filter((a): a is AgentView => a !== null);
  const names = new Map(hired.map(a => [a.id, a.name]));
  return {
    hired,
    routineCount: list(r.routines).length,
    skipped: list(r.skipped).map(str).filter(Boolean),
    needsSetup: list(r.needsSetup).map(obj).filter(n => str(n.agentId)).map(n => ({
      agentId: str(n.agentId),
      agentName: names.get(str(n.agentId)) ?? str(n.agentId),
      reason: str(n.reason) || "setup-required",
      provider: strOrNull(n.provider),
    })),
    needsUrls: list(r.needsUrls).map(str).filter(Boolean),
  };
}

/** The CLI command that fixes a missing key; provider ids are upper-case in the daemon. */
export function keysAddCommand(provider: string | null): string {
  return `braavo keys add ${provider ? provider.toLowerCase() : "<provider>"}`;
}
export const PULL_MODEL_COMMAND = "braavo models pull qwen3:8b";
export const SETUP_COMMAND = "braavo setup";

/** The template a hire-result routine key belongs to (for a localized label). */
export function urlKeyTemplate(key: string): TemplateId | null {
  const id = key.split("/")[0];
  return (TEMPLATE_IDS as readonly string[]).includes(id) ? (id as TemplateId) : null;
}

// ── events ───────────────────────────────────────────────────────────────────

export type PanelEvent =
  | { kind: "company"; companyId: string }
  | { kind: "agent"; agentId: string; status: AgentStatus }
  | { kind: "routine"; routineId: string; outcome: string }
  | { kind: "other" };

export function toPanelEvent(event: string, data: unknown): PanelEvent {
  const d = obj(data);
  const type = str(d.type) || event;
  if (type === "company.changed" && str(d.companyId)) return { kind: "company", companyId: str(d.companyId) };
  if (type === "agent.status" && str(d.agentId)) return { kind: "agent", agentId: str(d.agentId), status: toStatus(d.status) };
  if (type === "routine.executed" && str(d.routineId)) return { kind: "routine", routineId: str(d.routineId), outcome: str(d.outcome) };
  return { kind: "other" };
}
