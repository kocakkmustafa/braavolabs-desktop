/**
 * Lane-C — governed computer-control (CDP browser driving).
 *
 * The competitive angle: agent hosts like Hermes / OpenClaw give an agent
 * ungoverned computer use. Braavolabs' moat is governance, so here every browser
 * action passes the SAME fail-closed approval gate + audit ledger as every other
 * side effect (governance.ts) BEFORE the driver touches a page — "governed
 * computer use."
 *
 * This module is the PURE, unit-tested core:
 *   1. the action model (BrowserAction),
 *   2. browserActionToGate() — maps an action to its governance (kind, detail,
 *      REDACTED summary); a typed value is shown as a length, never the text (it
 *      may be a password), and eval JS is truncated — the raw value/js reaches
 *      the driver SEPARATELY and never enters the governance/audit layer,
 *   3. governedBrowser() — the single chokepoint: gate → (only on an approved
 *      one-time token) drive.
 *
 * The actual CDP driver (a Rust/Tauri host command over a Chrome DevTools
 * Protocol connection, spending the token host-side) is INJECTED: real at
 * runtime — a HUMAN-GATE, `cargo tauri dev` + a headed Chrome — and a fake in
 * tests. Classification (incl. the hard-deny of non-http(s) navigation) lives in
 * governance.ts and is exercised here through the gate.
 */
import type { ActionDetail, ActionKind } from "./governance";

// ── action model ────────────────────────────────────────────────────────────
export type BrowserAction =
  | { op: "navigate"; url: string }
  | { op: "read"; what: "screenshot" | "dom" | "url" }
  | { op: "interact"; kind: "click" | "type" | "scroll" | "select"; selector: string; value?: string }
  | { op: "eval"; js: string };

export type BrowserOp = BrowserAction["op"];

/** op → governance ActionKind. All are require-approval (none auto-allowed). */
const OP_KIND: Record<BrowserOp, ActionKind> = {
  navigate: "browser.navigate",
  read: "browser.read",
  interact: "browser.interact",
  eval: "browser.eval",
};

export function opToKind(op: BrowserOp): ActionKind {
  return OP_KIND[op];
}

function preview(s: string, max = 120): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + "…";
}

/**
 * Map a BrowserAction to its governance kind + detail. TWO cleanly-separated
 * surfaces live on the returned detail:
 *
 *   • `summary` — the REDACTED, length-only human line that reaches the AUDIT
 *     LEDGER. It never carries a secret: a typed value shows only its length, and
 *     eval shows only its JS length (never the source).
 *   • the STRUCTURED fields (`url` · `js` · `selector`/`value`/`interactKind`) —
 *     bound into the one-time token (so an approval for one URL/JS/selector/value
 *     can't be swapped for another) AND shown in the host's native approval dialog
 *     (so the human sees WHAT will actually run). These reach the host but NOT the
 *     ledger — dialog visibility and ledger privacy are deliberately distinct.
 */
export function browserActionToGate(a: BrowserAction): { kind: ActionKind; detail: ActionDetail } {
  switch (a.op) {
    case "navigate":
      return { kind: "browser.navigate", detail: { url: a.url, summary: `navigate to ${preview(a.url)}` } };
    case "read":
      return { kind: "browser.read", detail: { summary: `read page (${a.what})` } };
    case "interact": {
      // A typed value may be a password — the SUMMARY shows only its length, never
      // the text. The raw value goes in `value` (bound + dialog only, never audited).
      const summary =
        a.kind === "type"
          ? `type ${a.value?.length ?? 0} chars into ${a.selector}`
          : a.kind === "select"
            ? `select an option in ${a.selector}`
            : `${a.kind} ${a.selector}`;
      return {
        kind: "browser.interact",
        detail: { interactKind: a.kind, selector: a.selector, value: a.value, summary },
      };
    }
    case "eval":
      // eval JS is arbitrary code — the SUMMARY is length-only (no preview) so the
      // ledger never carries a fragment of it; the raw JS goes in `js` (bound + shown
      // in the dialog for real consent, never audited).
      return { kind: "browser.eval", detail: { js: a.js, summary: `eval JS (${a.js.length} chars)` } };
  }
}

// ── driver (runtime-gated; injected) ─────────────────────────────────────────
export interface BrowserResult {
  ok: boolean;
  /** navigate: final URL · read: data-uri / DOM text / URL · interact: void · eval: JSON-able. */
  value?: unknown;
  error?: string;
}

export interface BrowserDriver {
  /**
   * Execute an ALREADY-GATED action. `token` is the one-time governance token the
   * host spends (try_consume_token) before it drives CDP — a compromised webview
   * that skips the gate hands the host a token that fails to consume, so nothing
   * runs (gateForToken semantics, same as key_get / command.run).
   */
  dispatch(action: BrowserAction, token: string): Promise<BrowserResult>;
}

// ── governed orchestrator ────────────────────────────────────────────────────
/** gateForToken-shaped: classify+approve, hand back an UNCONSUMED one-time token. */
export type GateFn = (
  kind: string,
  detail: ActionDetail,
) => Promise<{ ok: true; token: string } | { ok: false; reason: string }>;

export type GovernedOutcome =
  | { ok: true; result: BrowserResult }
  | { ok: false; reason: string };

/**
 * The single chokepoint every browser action funnels through. Classify + approve
 * via `gate`; ONLY on an approved one-time token does `driver` touch the page. A
 * policy deny (e.g. file:// navigation) or a human reject returns an honest
 * reason and the driver is NEVER called — fail-closed, identical to the rest of
 * the governance moat.
 */
export async function governedBrowser(
  action: BrowserAction,
  gate: GateFn,
  driver: BrowserDriver,
): Promise<GovernedOutcome> {
  const { kind, detail } = browserActionToGate(action);
  const g = await gate(kind, detail);
  if (!g.ok) return { ok: false, reason: g.reason };
  const result = await driver.dispatch(action, g.token);
  return { ok: true, result };
}
