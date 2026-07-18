/**
 * Lane-B real-PTY — a governed INTERACTIVE vendor-CLI session inside the app.
 *
 * Today's Lane-B is safe-spawn: the desktop builds a `braavo spawn <vendor>`
 * command the USER pastes into their own terminal. Real-PTY closes the
 * competitive gap (Hermes/OpenClaw host sessions in-app) without giving up the
 * moat: opening a session passes the SAME fail-closed approval gate + audit
 * ledger as every other side effect, and the approval covers the SESSION —
 * bound to (vendor, cwd) via the one-time token, exactly like key_get /
 * command.run / browser.*.
 *
 * This module is the PURE, unit-tested core (same shape as browser.ts):
 *   1. ptySpawnToGate() — maps a spawn request to its governance (kind,
 *      detail). Only vendor + cwd ever reach governance/audit.
 *   2. governedPtySpawn() — the single chokepoint: gate → (only on an approved
 *      one-time token) driver.spawn.
 *   3. PtySessions — the session registry/state machine: running-session cap,
 *      byte counters, and the REDACTION rule — terminal buffers may contain
 *      secrets (a pasted key, a vendor login), so audit summaries carry ONLY
 *      vendor + cwd + byte counts + exit status, never buffer content.
 *
 * The actual PTY driver (Rust host over portable-pty, spending the token
 * host-side via try_consume_token) is INJECTED: real at runtime — a HUMAN-GATE,
 * `cargo tauri dev` — and a fake in tests. Input/resize/kill are lifecycle ops
 * on the approved session (no per-keystroke gating: unusable and dishonest —
 * the human WATCHES the live terminal; the governance line is session-open).
 */
import type { ActionDetail, ActionKind } from "./governance";
import { type SpawnVendor, VENDOR_SPECS } from "./spawn";

// ── gate mapping ────────────────────────────────────────────────────────────

export interface PtySpawnRequest {
  vendor: SpawnVendor;
  /** Absolute working directory the session opens in (governance hard-denies otherwise). */
  cwd: string;
  /** Optional extra argv AFTER the vendor bin (e.g. ["--continue"]). Shown in the summary. */
  args?: string[];
}

/**
 * Map a spawn request to its governance kind + detail. detail carries vendor +
 * cwd (the token binds to both) and an honest human summary. `args` appear in
 * the summary so the approver sees the real invocation — they are part of what
 * is being approved, and the driver receives the SAME args object it gated.
 */
export function ptySpawnToGate(r: PtySpawnRequest): { kind: ActionKind; detail: ActionDetail } {
  const bin = VENDOR_SPECS[r.vendor].bin;
  const hasArgs = r.args && r.args.length > 0;
  const argsPart = hasArgs ? ` ${r.args!.join(" ")}` : "";
  return {
    kind: "pty.spawn",
    detail: {
      vendor: r.vendor,
      cwd: r.cwd,
      // Bound into the token (governance.bindingKey) so what the approver SEES
      // in the summary is exactly what the host may launch — no arg-swap after
      // approval. Omitted when empty so the binding of a no-arg session is stable.
      ...(hasArgs ? { args: r.args } : {}),
      summary: `open interactive ${bin}${argsPart} session in ${r.cwd}`,
    },
  };
}

// ── driver (runtime-gated; injected) ────────────────────────────────────────

export interface PtyDriver {
  /**
   * Open an ALREADY-GATED session. `token` is the one-time governance token the
   * host spends (try_consume_token) before it allocates a PTY — a compromised
   * webview that skips the gate hands the host a token that fails to consume,
   * so no process starts (same semantics as key_get / browser dispatch).
   * Resolves to the host-side session id.
   */
  spawn(req: PtySpawnRequest, token: string): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>;
  /** Write user keystrokes into a running session. */
  write(sessionId: string, data: string): Promise<void>;
  /** Resize the PTY (terminal panel resized). */
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  /** Terminate the session (safe direction — stopping needs no approval). */
  kill(sessionId: string): Promise<void>;
}

// ── governed chokepoint ─────────────────────────────────────────────────────

/** gateForToken-shaped: classify+approve, hand back an UNCONSUMED one-time token. */
export type GateFn = (
  kind: string,
  detail: ActionDetail,
) => Promise<{ ok: true; token: string } | { ok: false; reason: string }>;

export type SpawnOutcome =
  | { ok: true; sessionId: string }
  | { ok: false; reason: string };

/**
 * The single chokepoint every real-PTY session funnels through. Order:
 *   1. cap check BEFORE gating — refuse past the running-session cap so we never
 *      approve+spawn a PTY we'd immediately have to disown (adversarial E1: the
 *      old code registered AFTER spawn, so a full registry couldn't retract an
 *      already-allocated host process). Best-effort UI throttle; the AUTHORITATIVE
 *      cap is host-side at token-issue (concurrent calls could still race here).
 *   2. classify + approve via `gate`.
 *   3. ONLY on an approved one-time token does `driver` allocate a PTY.
 *   4. register the confirmed session so the count reflects it for the next call.
 * A policy deny (unknown vendor, relative/sensitive cwd, dangerous flag) or a
 * human reject returns an honest reason and the driver is NEVER called.
 */
export async function governedPtySpawn(
  req: PtySpawnRequest,
  gate: GateFn,
  driver: PtyDriver,
  sessions: PtySessions,
): Promise<SpawnOutcome> {
  if (sessions.running().length >= MAX_RUNNING_SESSIONS) {
    return { ok: false, reason: `session cap reached (${MAX_RUNNING_SESSIONS})` };
  }
  const { kind, detail } = ptySpawnToGate(req);
  const g = await gate(kind, detail);
  if (!g.ok) return { ok: false, reason: g.reason };
  const r = await driver.spawn(req, g.token);
  if (!r.ok) return { ok: false, reason: r.error };
  const reg = sessions.register(r.sessionId, req.vendor, req.cwd);
  if (!reg.ok) return { ok: false, reason: reg.reason };
  return { ok: true, sessionId: r.sessionId };
}

// ── session registry / state machine ────────────────────────────────────────

export type PtyState = "running" | "exited" | "killed";

export interface PtySessionInfo {
  sessionId: string;
  vendor: SpawnVendor;
  cwd: string;
  state: PtyState;
  bytesIn: number;
  bytesOut: number;
  exitCode: number | null;
}

/** Running-session cap. Enforced BEFORE gating in governedPtySpawn (a best-effort
 * UI throttle) and defensively in register(); the AUTHORITATIVE fork-bomb guard
 * is host-side at PTY allocation — this TS registry does not own the processes. */
export const MAX_RUNNING_SESSIONS = 4;

/**
 * Pure in-memory registry the UI drives. It does NOT own the processes (the
 * Rust host does); it owns the STATE the webview needs: which sessions exist,
 * their byte counters (for the redacted audit trail) and lifecycle. All
 * mutations are total functions with honest errors — no throws in the happy
 * path, no silent drops.
 */
export class PtySessions {
  private sessions = new Map<string, PtySessionInfo>();

  /** Register a driver-confirmed session. Defensive cap re-check (governedPtySpawn
   * already gates on it before spawn); fails honestly past the cap or on a dup. */
  register(sessionId: string, vendor: SpawnVendor, cwd: string): { ok: true } | { ok: false; reason: string } {
    if (this.running().length >= MAX_RUNNING_SESSIONS) {
      return { ok: false, reason: `session cap reached (${MAX_RUNNING_SESSIONS})` };
    }
    if (this.sessions.has(sessionId)) {
      return { ok: false, reason: "duplicate session id" };
    }
    this.sessions.set(sessionId, {
      sessionId, vendor, cwd, state: "running", bytesIn: 0, bytesOut: 0, exitCode: null,
    });
    return { ok: true };
  }

  /** Count OUTPUT bytes (host → terminal). Buffer content itself is never stored
   * here. A negative length is clamped to 0 (adversarial E2: a compromised relay
   * could otherwise subtract to hide exfil volume — byte counts are the only
   * quantitative audit signal a redacted session has). */
  noteOutput(sessionId: string, byteLength: number): void {
    const s = this.sessions.get(sessionId);
    if (s && s.state === "running") s.bytesOut += Math.max(0, byteLength);
  }

  /** Count INPUT bytes (keystrokes → host). Content never stored; negative clamped. */
  noteInput(sessionId: string, byteLength: number): void {
    const s = this.sessions.get(sessionId);
    if (s && s.state === "running") s.bytesIn += Math.max(0, byteLength);
  }

  /** Driver reported process exit. Idempotent; a killed session stays "killed". */
  noteExit(sessionId: string, exitCode: number | null): void {
    const s = this.sessions.get(sessionId);
    if (s && s.state === "running") {
      s.state = "exited";
      s.exitCode = exitCode;
    }
  }

  /** User killed the session (safe direction — no approval). */
  noteKill(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s && s.state === "running") s.state = "killed";
  }

  get(sessionId: string): PtySessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  running(): PtySessionInfo[] {
    return [...this.sessions.values()].filter((s) => s.state === "running");
  }

  all(): PtySessionInfo[] {
    return [...this.sessions.values()];
  }

  /**
   * The REDACTED audit line for a session's lifetime. This is the ONLY string
   * that may reach the ledger: vendor + cwd + byte counts + how it ended.
   * Terminal buffer content (which can hold pasted secrets) never appears.
   */
  auditSummary(sessionId: string): string | null {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    const ending =
      s.state === "running" ? "running" :
      s.state === "killed" ? "killed by user" :
      `exited (${s.exitCode ?? "signal"})`;
    return `pty ${s.vendor} in ${s.cwd} — in ${s.bytesIn}B, out ${s.bytesOut}B, ${ending}`;
  }
}
