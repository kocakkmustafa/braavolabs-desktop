import { describe, it, expect } from "vitest";
import {
  companySummary,
  relativeAge,
  toCompanyViews,
  toJobViews,
} from "../company";

describe("toCompanyViews", () => {
  it("maps the real list shape and derives the action affordances from status", () => {
    const views = toCompanyViews([
      { id: "c1", name: "Growth Desk", status: "ACTIVE", agentCount: 4, pipelineCount: 3 },
      { id: "c2", name: "Support Desk", status: "PAUSED", agentCount: 2, pipelineCount: 1 },
    ]);
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({ tone: "arc", canPause: true, canResume: false, agentCount: 4 });
    expect(views[1]).toMatchObject({ tone: "ember", canPause: false, canResume: true });
  });

  it("accepts Prisma's _count shape so a real company never shows 0 agents", () => {
    const [v] = toCompanyViews([{ id: "c1", name: "X", status: "ACTIVE", _count: { agents: 5, pipelines: 2 } }]);
    expect(v.agentCount).toBe(5);
    expect(v.pipelineCount).toBe(2);
  });

  it("drops rows without an id instead of rendering a blank one", () => {
    expect(toCompanyViews([{ name: "no id" }, "junk", null, { id: "ok", status: "DRAFT" }])).toHaveLength(1);
  });

  it("falls back to the id as the name, and to steel for an unknown status", () => {
    const [v] = toCompanyViews([{ id: "c9", status: "WEIRD" }]);
    expect(v.name).toBe("c9");
    expect(v.tone).toBe("steel");
    expect(v.canPause).toBe(false);
    expect(v.canResume).toBe(false);
  });

  it("archived reads molten and offers neither action", () => {
    const [v] = toCompanyViews([{ id: "c1", status: "ARCHIVED" }]);
    expect(v.tone).toBe("molten");
    expect(v.canPause || v.canResume).toBe(false);
  });

  it("returns empty for a non-array payload", () => {
    expect(toCompanyViews({ error: "nope" })).toEqual([]);
    expect(toCompanyViews(null)).toEqual([]);
  });
});

describe("toJobViews", () => {
  it("distinguishes scheduled / paused / unscheduled — never conflates them", () => {
    const jobs = toJobViews([
      { id: "j1", name: "Outbound", schedule: "0 8 * * *", enabled: true, nextRunAt: "2026-07-26T08:00:00.000Z" },
      { id: "j2", name: "Triage", schedule: "*/15 * * * *", enabled: false, nextRunAt: null },
      // enabled with a cron but NO live scheduler: a real bug shape (the cron
      // never reached the queue), so it must not read as "scheduled".
      { id: "j3", name: "Price watch", schedule: "0 * * * *", enabled: true, nextRunAt: null },
    ]);
    expect(jobs.map((j) => j.state)).toEqual(["scheduled", "paused", "unscheduled"]);
  });

  it("treats a missing `enabled` as enabled (server omits it when true)", () => {
    const [j] = toJobViews([{ id: "j1", schedule: "0 * * * *", nextRunAt: "2026-07-26T00:00:00.000Z" }]);
    expect(j.enabled).toBe(true);
    expect(j.state).toBe("scheduled");
  });

  it("never invents a next run from the cron string", () => {
    const [j] = toJobViews([{ id: "j1", schedule: "0 8 * * *", enabled: true }]);
    expect(j.nextRunAt).toBeNull();
    expect(j.state).toBe("unscheduled");
  });

  it("drops idless rows and non-array payloads", () => {
    expect(toJobViews([{ name: "x" }, 7])).toEqual([]);
    expect(toJobViews("nope")).toEqual([]);
  });
});

describe("relativeAge", () => {
  const now = Date.parse("2026-07-25T12:00:00.000Z");
  it("formats minutes, hours and days", () => {
    expect(relativeAge("2026-07-25T11:56:00.000Z", now)).toBe("4m");
    expect(relativeAge("2026-07-25T09:00:00.000Z", now)).toBe("3h");
    expect(relativeAge("2026-07-23T12:00:00.000Z", now)).toBe("2d");
  });
  it("says 'now' under a minute and empty for missing/invalid input", () => {
    expect(relativeAge("2026-07-25T11:59:40.000Z", now)).toBe("0m");
    expect(relativeAge(null, now)).toBe("");
    expect(relativeAge("not a date", now)).toBe("");
  });
});

describe("companySummary", () => {
  it("counts companies, active ones, jobs and live schedules", () => {
    const companies = toCompanyViews([
      { id: "a", status: "ACTIVE" },
      { id: "b", status: "PAUSED" },
      { id: "c", status: "ACTIVE" },
    ]);
    const jobs = toJobViews([
      { id: "j1", enabled: true, nextRunAt: "2026-07-26T00:00:00.000Z" },
      { id: "j2", enabled: false },
    ]);
    expect(companySummary(companies, jobs)).toEqual({ total: 3, active: 2, jobs: 2, scheduled: 1 });
  });
});

it("does not invent counts/status or replace an explicit zero with a nested nonzero", () => {
  const [unknown, zero] = toCompanyViews([{ id: "u", agentCount: "0", pipelineCount: -1 },
    { id: "z", agentCount: 0, pipelineCount: 0, _count: { agents: 5, pipelines: 2 } }]);
  expect(unknown).toMatchObject({ agentCount: null, pipelineCount: null, status: "", canPause: false, canResume: false });
  expect(zero).toMatchObject({ agentCount: 0, pipelineCount: 0 });
  expect(toCompanyViews([{ id: "i", agentCount: Infinity, pipelineCount: 1.5 }])[0]).toMatchObject({ agentCount: null, pipelineCount: null });
});
