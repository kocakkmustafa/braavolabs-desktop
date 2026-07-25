/**
 * Company surface — pure view mappers (design v3 "Company" mode).
 *
 * Same shape as render.ts: the API's raw JSON in, a display-ready view out, so
 * every honesty decision (what to show when a field is missing, how to phrase a
 * schedule we cannot resolve) is unit-tested instead of buried in DOM code.
 *
 * Deliberate constraint: this module NEVER invents a value. If the server did
 * not send a next-run time, the view says so — it does not compute one from the
 * cron string, because only the live scheduler knows whether that cron is
 * actually registered.
 */

export interface CompanyView {
  id: string;
  name: string;
  /** Raw server status ("ACTIVE" | "PAUSED" | "DRAFT" | "ARCHIVED" | …). */
  status: string;
  /** idle = steel, running = ember, done = arc — matches the StatusDot rule. */
  tone: "steel" | "ember" | "arc" | "molten";
  agentCount: number;
  pipelineCount: number;
  /** True only when a pause action can succeed (server 404s otherwise). */
  canPause: boolean;
  /** True only when a resume action can succeed. */
  canResume: boolean;
}

export interface JobView {
  id: string;
  name: string;
  companyId: string | null;
  /** The cron/schedule string as stored, or "" when there is none. */
  schedule: string;
  enabled: boolean;
  /** ISO string from the LIVE scheduler, or null when none is registered. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  /**
   * What the UI shows on the right. "paused" / "unscheduled" are honest
   * distinctions: a disabled job and a job whose cron never reached the
   * scheduler are different failures, and conflating them hides a real bug.
   */
  state: "scheduled" | "paused" | "unscheduled";
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function toneFor(status: string): CompanyView["tone"] {
  switch (status.toUpperCase()) {
    case "ACTIVE":
      return "arc";
    case "PAUSED":
      return "ember";
    case "ARCHIVED":
      return "molten";
    default:
      return "steel"; // DRAFT and anything unknown
  }
}

/** Map GET /companies. Rows without an id are dropped, not rendered blank. */
export function toCompanyViews(raw: unknown): CompanyView[] {
  if (!Array.isArray(raw)) return [];
  const out: CompanyView[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const c = r as Record<string, unknown>;
    const id = str(c.id);
    if (!id) continue;
    const status = str(c.status) || "DRAFT";
    // The list endpoint returns counts under `_count` (Prisma) on some shapes
    // and flattened on others — accept both rather than showing 0 for a company
    // that clearly has agents.
    const counts = (c._count as Record<string, unknown> | undefined) ?? {};
    out.push({
      id,
      name: str(c.name) || id,
      status,
      tone: toneFor(status),
      agentCount: num(c.agentCount) || num(counts.agents),
      pipelineCount: num(c.pipelineCount) || num(counts.pipelines),
      canPause: status.toUpperCase() === "ACTIVE",
      canResume: status.toUpperCase() === "PAUSED",
    });
  }
  return out;
}

/** Map GET /pipelines/scheduled. */
export function toJobViews(raw: unknown): JobView[] {
  if (!Array.isArray(raw)) return [];
  const out: JobView[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const j = r as Record<string, unknown>;
    const id = str(j.id);
    if (!id) continue;
    const enabled = j.enabled !== false;
    const nextRunAt = str(j.nextRunAt) || null;
    out.push({
      id,
      name: str(j.name) || id,
      companyId: str(j.companyId) || null,
      schedule: str(j.schedule),
      enabled,
      nextRunAt,
      lastRunAt: str(j.lastRunAt) || null,
      state: !enabled ? "paused" : nextRunAt ? "scheduled" : "unscheduled",
    });
  }
  return out;
}

/** Short relative age, e.g. "4m", "3h", "2d". Empty for a missing timestamp. */
export function relativeAge(iso: string | null, now: number): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const mins = Math.floor(Math.abs(now - then) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** One-line summary for the header: "3 companies · 2 active · 7 jobs". */
export function companySummary(
  companies: CompanyView[],
  jobs: JobView[],
): { total: number; active: number; jobs: number; scheduled: number } {
  return {
    total: companies.length,
    active: companies.filter((c) => c.status.toUpperCase() === "ACTIVE").length,
    jobs: jobs.length,
    scheduled: jobs.filter((j) => j.state === "scheduled").length,
  };
}
