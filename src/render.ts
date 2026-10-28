/**
 * Pure view-model mappers — turn raw API payloads into the exact fields the
 * three panes render, with all the honesty rules baked in (never invent a
 * savings figure; only show "$X saved" when the server reported a real
 * positive number). Kept side-effect-free so the DOM layer (ui.ts) is a thin
 * shell and every mapping rule is unit-tested here instead of in the browser.
 *
 * Shapes are read from the live server types:
 *   TenantCascadeResult          (research/cascade.service.ts)
 *   MultiModelCompareResult      (services/multi-model.ts, embedded at
 *                                 session.findings.multiModel by compare)
 *   TenantSavingsResult.report   (billing/savings.service.ts + lib/routing.ts)
 */

// ── savings ──────────────────────────────────────────────────────────────────

export interface SavingsView {
  /** True only when the server reported a real, positive saved amount. */
  hasSavings: boolean;
  savedUsd: number | null;
  savedPct: number | null;
  actualUsd: number | null;
  baselineUsd: number | null;
  /** "≈ saved $1.23" or "" — the ember footer line. Empty ⇒ render nothing. */
  label: string;
  /** Data-quality note passed through verbatim (honesty; never dropped). */
  note?: string;
}

/** Missing/invalid observations stay unknown. Numeric strings are not measurements. */
function metric(value: unknown, maximum = Infinity): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;
}
/** Savings is a difference, so measured losses/negative percentages are valid. */
function signedMetric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function money(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

/**
 * Map GET /billing/savings. Defensive against partial/absent payloads: a
 * missing or non-positive `savedUsd` yields hasSavings:false and an empty
 * label so the UI shows NOTHING rather than a fabricated "$0 saved" badge.
 */
export function toSavingsView(raw: any): SavingsView {
  const report = raw?.report ?? {};
  const savedUsd = signedMetric(report.savedUsd);
  const savedPct = signedMetric(report.savedPct);
  const actualUsd = metric(report.actualUsd);
  const baselineUsd = metric(report.baselineUsd);
  const has = savedUsd !== null && savedUsd > 0;
  return {
    hasSavings: has,
    savedUsd,
    savedPct,
    actualUsd,
    baselineUsd,
    label: has ? `≈ saved ${money(savedUsd)}` : "",
    note: typeof raw?.note === "string" ? raw.note : undefined,
  };
}

// ── cascade ──────────────────────────────────────────────────────────────────

export interface CascadeAttemptView {
  provider: string;
  model: string;
  tier: string;
  confidence: number | null;
  costUsd: number | null;
}

export interface CascadeView {
  answer: string;
  provider: string;
  model: string;
  tier: string;
  confidence: number | null;
  escalated: boolean | null;
  totalCostUsd: number | null;
  stoppedReason: string;
  rationale: string;
  attempts: CascadeAttemptView[];
}

/** Map POST /research/cascade (TenantCascadeResult) for the inspector. */
export function toCascadeView(raw: any): CascadeView {
  const attempts = Array.isArray(raw?.attempts) ? raw.attempts : [];
  return {
    answer: String(raw?.answer ?? ""),
    provider: String(raw?.provider ?? ""),
    model: String(raw?.model ?? ""),
    tier: String(raw?.tier ?? ""),
    confidence: metric(raw?.confidence, 1),
    escalated: typeof raw?.escalated === "boolean" ? raw.escalated : null,
    totalCostUsd: metric(raw?.totalCostUsd),
    stoppedReason: String(raw?.stoppedReason ?? ""),
    rationale: String(raw?.rationale ?? ""),
    attempts: attempts.map(
      (a: any): CascadeAttemptView => ({
        provider: String(a?.provider ?? ""),
        model: String(a?.model ?? ""),
        tier: String(a?.tier ?? ""),
        confidence: metric(a?.confidence, 1),
        costUsd: metric(a?.costUsd),
      }),
    ),
  };
}

// ── compare (async session) ──────────────────────────────────────────────────

export interface CompareCandidateView {
  provider: string;
  model: string;
  answer: string;
  costUsd: number | null;
}

export interface CompareView {
  status: string;
  /** Present once the session COMPLETED and carries a multiModel block. */
  hasResult: boolean;
  finalAnswer: string;
  synthesis: string;
  consensus: string[];
  disagreements: string[];
  perModel: CompareCandidateView[];
  failed: { provider: string; model: string; error: string }[];
  synthesisParsed: boolean;
  totalCostUsd: number | null;
  /** Server-persisted error string on a FAILED session, if any. */
  error?: string;
}

/**
 * Map GET /research/:id for a compare session. The per-model answers +
 * consensus/disagreements + final synthesis live under
 * `session.findings.multiModel` (MultiModelCompareResult); a session can be
 * terminal without that block (plain research, or a failed compare), so
 * hasResult gates whether the multi-card view renders.
 */
export function toCompareView(session: any): CompareView {
  const mm = session?.findings?.multiModel;
  const has = mm != null && typeof mm === "object" && !Array.isArray(mm);
  // The current server retains paid candidates after a malformed synthesis.
  // That partial payload (including its candidate fallback) is not a final answer.
  const invalidSynthesis = has && mm.synthesisStatus === "invalid_structured";
  const status = invalidSynthesis ? "FAILED" : String(session?.status ?? "");
  const completed = has && status === "COMPLETED";
  return {
    status,
    hasResult: has,
    finalAnswer: completed ? String(mm.finalAnswer ?? "") : "",
    synthesis: completed ? String(mm.synthesis ?? "") : "",
    consensus: completed && Array.isArray(mm.consensus) ? mm.consensus.map(String) : [],
    disagreements: completed && Array.isArray(mm.disagreements) ? mm.disagreements.map(String) : [],
    perModel:
      has && Array.isArray(mm.perModel)
        ? mm.perModel.map(
            (m: any): CompareCandidateView => ({
              provider: String(m?.provider ?? ""),
              model: String(m?.model ?? ""),
              answer: String(m?.answer ?? ""),
              costUsd: metric(m?.costUsd),
            }),
          )
        : [],
    failed:
      has && Array.isArray(mm.failed)
        ? mm.failed.map((f: any) => ({
            provider: String(f?.provider ?? ""),
            model: String(f?.model ?? ""),
            error: String(f?.error ?? ""),
          }))
        : [],
    synthesisParsed: has ? mm.synthesisParsed === true : false,
    totalCostUsd: has ? metric(mm.totalCostUsd) : null,
    error: typeof session?.error === "string" && session.error.trim() ? session.error
      : invalidSynthesis ? String(mm.synthesizerError || "Invalid structured synthesis") : undefined,
  };
}

// ── login error mapping (raw-mode banner) ────────────────────────────────────

export interface LoginErrorView {
  kind: "network" | "invalid" | "locked" | "rate_limited" | "unavailable" | "unknown";
  message: string;
}

/**
 * Turn a raw (non-throwing) login response into a specific banner. 401 → bad
 * creds; 429 → account lockout / IP rate-limit; 5xx → auth service down (fail
 * closed — do NOT retry-loop, force a fresh login). Mirrors auth.service.ts.
 */
export function toLoginError(raw: { status: number; body?: any }): LoginErrorView | null {
  if (raw.status >= 200 && raw.status < 300) return null;
  const serverMsg = String(raw.body?.error ?? raw.body?.message ?? "");
  if (raw.status === 0) {
    return { kind: "network", message: "Authentication service could not be reached" };
  }
  if (raw.status === 401) {
    return { kind: "invalid", message: serverMsg || "Invalid email or password" };
  }
  if (raw.status === 429) {
    const locked = /lock/i.test(serverMsg);
    return {
      kind: locked ? "locked" : "rate_limited",
      message: serverMsg || "Too many attempts. Try again later.",
    };
  }
  if (raw.status >= 500 && raw.status < 600) {
    return { kind: "unavailable", message: serverMsg || "Authentication service temporarily unavailable" };
  }
  return { kind: "unknown", message: "Sign in failed" };
}
