import { describe, it, expect } from "vitest";
import { toSavingsView, toCascadeView, toCompareView, toLoginError } from "../render";

describe("toSavingsView (honesty gate)", () => {
  it("shows a label only when the server reported a real positive savedUsd", () => {
    // >= $1 → 2 decimals; sub-$1 amounts get 4 (see the sub-dollar case below).
    const v = toSavingsView({ report: { savedUsd: 1.2345, savedPct: 42, actualUsd: 1.7, baselineUsd: 2.9 } });
    expect(v.hasSavings).toBe(true);
    expect(v.label).toBe("≈ saved $1.23");
    expect(v.savedPct).toBe(42);
  });

  it("uses 4 decimals for sub-dollar amounts", () => {
    const v = toSavingsView({ report: { savedUsd: 0.0042 } });
    expect(v.label).toBe("≈ saved $0.0042");
  });

  it("renders NOTHING (no fabricated $0) when savedUsd is zero", () => {
    const v = toSavingsView({ report: { savedUsd: 0, savedPct: 0 } });
    expect(v.hasSavings).toBe(false);
    expect(v.label).toBe("");
  });

  it("is defensive against an absent/partial payload", () => {
    const v = toSavingsView(undefined);
    expect(v.hasSavings).toBe(false);
    expect(v.label).toBe("");
    expect(v.savedUsd).toBe(0);
  });

  it("uses 2 decimals for amounts >= $1", () => {
    const v = toSavingsView({ report: { savedUsd: 12.5 } });
    expect(v.label).toBe("≈ saved $12.50");
  });

  it("passes the data-quality note through verbatim", () => {
    const v = toSavingsView({ report: { savedUsd: 1 }, note: "5/9 rows reconstructed" });
    expect(v.note).toBe("5/9 rows reconstructed");
  });
});

describe("toCascadeView", () => {
  it("maps a TenantCascadeResult including attempts", () => {
    const v = toCascadeView({
      answer: "yes",
      provider: "anthropic",
      model: "claude-haiku",
      tier: "cheap",
      confidence: 0.82,
      escalated: true,
      totalCostUsd: 0.0042,
      stoppedReason: "confident",
      rationale: "clear",
      attempts: [{ provider: "anthropic", model: "claude-haiku", tier: "cheap", confidence: 0.4, costUsd: 0.001 }],
    });
    expect(v.provider).toBe("anthropic");
    expect(v.escalated).toBe(true);
    expect(v.attempts).toHaveLength(1);
    expect(v.attempts[0].costUsd).toBe(0.001);
  });

  it("coerces a missing/garbage payload to safe defaults", () => {
    const v = toCascadeView(null);
    expect(v.answer).toBe("");
    expect(v.confidence).toBe(0);
    expect(v.escalated).toBe(false);
    expect(v.attempts).toEqual([]);
  });
});

describe("toCompareView", () => {
  it("extracts perModel + finalAnswer + consensus from findings.multiModel", () => {
    const session = {
      status: "COMPLETED",
      findings: {
        summary: "s",
        multiModel: {
          perModel: [
            { provider: "openai", model: "gpt", answer: "A", costUsd: 0.002 },
            { provider: "anthropic", model: "claude", answer: "B", costUsd: 0.003 },
          ],
          failed: [{ provider: "google", model: "gemini", error: "timeout" }],
          synthesis: "they mostly agree",
          consensus: ["x is true"],
          disagreements: ["y differs"],
          finalAnswer: "merged",
          synthesisParsed: true,
          totalCostUsd: 0.006,
        },
      },
    };
    const v = toCompareView(session);
    expect(v.hasResult).toBe(true);
    expect(v.perModel).toHaveLength(2);
    expect(v.perModel[1].provider).toBe("anthropic");
    expect(v.failed[0].error).toBe("timeout");
    expect(v.finalAnswer).toBe("merged");
    expect(v.consensus).toEqual(["x is true"]);
    expect(v.disagreements).toEqual(["y differs"]);
    expect(v.totalCostUsd).toBe(0.006);
  });

  it("hasResult=false for a terminal session with no multiModel block", () => {
    const v = toCompareView({ status: "FAILED", error: "provider down" });
    expect(v.hasResult).toBe(false);
    expect(v.finalAnswer).toBe("");
    expect(v.error).toBe("provider down");
    expect(v.perModel).toEqual([]);
  });
});

describe("toLoginError (raw-mode banner mapping)", () => {
  it("returns null for a 2xx", () => {
    expect(toLoginError({ status: 200, body: {} })).toBeNull();
  });
  it("401 → invalid creds", () => {
    expect(toLoginError({ status: 401, body: { error: "Invalid email or password" } })?.kind).toBe("invalid");
  });
  it("429 with 'lock' → locked, else rate_limited", () => {
    expect(toLoginError({ status: 429, body: { error: "Account temporarily locked. Try again in 30 minutes." } })?.kind).toBe("locked");
    expect(toLoginError({ status: 429, body: { error: "Too many requests" } })?.kind).toBe("rate_limited");
  });
  it("503 → unavailable (fail closed)", () => {
    expect(toLoginError({ status: 503, body: {} })?.kind).toBe("unavailable");
  });
});
