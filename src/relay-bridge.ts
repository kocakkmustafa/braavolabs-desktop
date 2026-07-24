/**
 * Desktop relay bridge — Companion channel Dilim 2a: the desktop-side client
 * CORE that bridges local governance (governance.ts) to the cloud relay
 * control plane (Dilim 1, sealed — braavolabs monorepo
 * `packages/api/src/modules/relay/*`, mirrored in relay-protocol.ts). A
 * governed local session registers itself with the relay, mirrors governed
 * events UP to a companion (mobile panel) that observes it, and receives
 * commands DOWN from that companion.
 *
 * Same shape as R6's browser.ts / pty.ts: a PURE, unit-tested core with the
 * real I/O INJECTED —
 *   1. RelayTransport — the wire (real: fetch+SSE, relay-transport.ts; fake:
 *      an in-memory stand-in the tests drive headlessly),
 *   2. BridgeHandlers — how an inbound ControlCommand becomes a LOCAL action
 *      (approve/reject → governance.approve/reject; steer → inject into the
 *      run loop; kill → terminate). RelayBridge only CALLS these; the actual
 *      wiring to governance/session lives outside this module (main.ts,
 *      headed — see the module-level note below).
 *
 * SAFETY (headed/kurucu-kapı note): once BridgeHandlers.onApprove/onReject
 * are wired to a REAL governance backend, a governed action's approval
 * dialog can be resolved from two places at once — the native in-app dialog
 * OR a companion `approve`/`reject` ControlCommand racing it. Only one can
 * win. That race is MODELED and TESTED here (see resolveApproval below) so
 * the wiring is safe when it lands, but the actual LIVE wiring of
 * companion-approve to a real governance gate is NOT done in this slice —
 * this slice activates observation (approval-request/audit/output mirror
 * UP) and the two safe commands (steer/kill); approve/reject dispatch is
 * coded and tested end-to-end against createMemoryGovernance, but plugging
 * BridgeHandlers into the app's real approval flow is a headed session.
 */
import {
  ControlCommandSchema,
  redactSessionEventInput,
  type ControlCommand,
  type SessionEventInput,
  type SessionEventState,
  type SessionRegistration,
} from "./relay-protocol";
import type { Governance } from "./governance";

// ── injected transport ──────────────────────────────────────────────────

/**
 * The wire between this local session and the cloud relay. Real
 * implementation: relay-transport.ts (fetch + fetch-streamed SSE, runtime-
 * only, verified headed). Fake implementation: tests.
 */
export interface RelayTransport {
  /** Register this local session with the relay. Returns the server-minted id. */
  register(reg: SessionRegistration): Promise<{ sessionId: string }>;
  /** Post an already-gated, already-(client-side)-redacted event. */
  postEvent(sessionId: string, ev: SessionEventInput): Promise<void>;
  /**
   * Subscribe to inbound ControlCommands for this session. `onCmd` receives
   * an UNVALIDATED, already-JSON-parsed payload — RelayBridge re-validates
   * with ControlCommandSchema before dispatch (defense-in-depth independent
   * of whatever the transport already checked; a fake test transport can
   * push anything). Returns an unsubscribe function.
   */
  subscribeCommands(sessionId: string, onCmd: (raw: unknown) => void): () => void;
}

// ── injected local handlers ─────────────────────────────────────────────

/**
 * Translates an inbound (already-validated) ControlCommand into a LOCAL
 * action. Provided by the app's wiring layer (main.ts), NOT implemented in
 * this module — RelayBridge only calls these. `onSteer` is synchronous
 * (injects a message into the run loop's input queue); the others are
 * async side effects.
 */
export interface BridgeHandlers {
  onSteer(message: string): void;
  onApprove(actionId: string): Promise<void>;
  onReject(actionId: string): Promise<void>;
  onKill(): Promise<void>;
}

// ── the bridge ───────────────────────────────────────────────────────────

/**
 * One relay-bridged local session. `start()` registers + subscribes;
 * `emit*()` mirror governed activity UP (client-side redacted, then handed
 * to the transport); inbound commands are validated + dispatched to
 * `handlers`; `stop()` marks the session ended and unsubscribes.
 */
export class RelayBridge {
  private readonly transport: RelayTransport;
  private readonly handlers: BridgeHandlers;
  private sessionId: string | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(transport: RelayTransport, handlers: BridgeHandlers) {
    this.transport = transport;
    this.handlers = handlers;
  }

  /** The relay-assigned session id, once started (null before `start()`). */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /** Register with the relay and start listening for inbound commands. */
  async start(reg: SessionRegistration): Promise<{ sessionId: string }> {
    const { sessionId } = await this.transport.register(reg);
    this.sessionId = sessionId;
    this.unsubscribe = this.transport.subscribeCommands(sessionId, (raw) => this.dispatch(raw));
    return { sessionId };
  }

  /** Mirror the session as ended, then unsubscribe. No-op if never started. */
  async stop(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.setStatus("ended");
    } finally {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.sessionId = null;
    }
  }

  // ── inbound: companion → local ─────────────────────────────────────────

  /**
   * Validate + dispatch ONE inbound payload. A malformed/unknown-`type`
   * payload is IGNORED, never thrown — a future command type this build
   * doesn't know about (or a corrupted frame) must not take the bridge
   * down. Fire-and-forget: dispatch itself is synchronous from the
   * transport's point of view (it does not block the next inbound message
   * on this one's handler finishing).
   */
  private dispatch(raw: unknown): void {
    const parsed = ControlCommandSchema.safeParse(raw);
    if (!parsed.success) return;
    void this.runHandler(parsed.data);
  }

  /**
   * Run the ONE handler for this command, isolated in its own try/catch —
   * a handler throwing (or its promise rejecting) must never kill the
   * bridge / the command subscription. The command stream keeps delivering
   * regardless of any single handler's outcome.
   */
  private async runHandler(cmd: ControlCommand): Promise<void> {
    try {
      switch (cmd.type) {
        case "steer":
          this.handlers.onSteer(cmd.message);
          break;
        case "approve":
          await this.handlers.onApprove(cmd.actionId);
          break;
        case "reject":
          await this.handlers.onReject(cmd.actionId);
          break;
        case "kill":
          await this.handlers.onKill();
          break;
      }
    } catch {
      // Swallowed by design — see the doc comment above. A failed handler
      // should surface through the app's own error/audit path, not by
      // crashing this dispatch loop.
    }
  }

  // ── outbound: local → companion ────────────────────────────────────────

  /**
   * Post an event, applying CLIENT-SIDE redaction first (defense-in-depth —
   * the relay server redacts again independently; a raw secret must not
   * even leave this process). A transport/network failure is swallowed:
   * the companion mirror is best-effort observability, and losing it must
   * never break the local session it's mirroring. No-ops before `start()`.
   */
  private async post(ev: SessionEventInput): Promise<void> {
    if (!this.sessionId) return;
    const redacted = redactSessionEventInput(ev);
    try {
      await this.transport.postEvent(this.sessionId, redacted);
    } catch {
      // best-effort mirror — see doc comment above.
    }
  }

  /** Mirror a governance approval-request (governance.ts's require-approval
   * GateResult) up to the companion so it can approve/reject remotely. */
  emitApprovalRequest(actionId: string, kind: string, dialogText: string): Promise<void> {
    return this.post({ type: "approval-request", actionId, kind, dialogText });
  }

  /** Mirror a chunk of terminal/agent output (base64, bounded). */
  emitOutput(text: string): Promise<void> {
    return this.post({ type: "output", textB64: toBase64(text) });
  }

  /** Mirror a redacted audit-ledger line (governance.ts's AuditEntry summary). */
  emitAudit(summary: string): Promise<void> {
    return this.post({ type: "audit", summary });
  }

  /** Mirror a redacted agent-turn summary — never the raw transcript. */
  emitAgentTurn(summary: string): Promise<void> {
    return this.post({ type: "agent-turn", summary });
  }

  /** Mirror the session's lifecycle state. */
  setStatus(state: SessionEventState): Promise<void> {
    return this.post({ type: "status", state });
  }
}

function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  if (typeof btoa === "function") {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}

// ── governance bridging (observation, safe direction active) ────────────

/**
 * Decorate a Governance so every require-approval gate result ALSO mirrors
 * an approval-request event to the companion, and every settle() ALSO
 * mirrors an audit line. Everything else (auto-allow, deny, approve,
 * reject, consume, recent, policy) passes straight through to `gov`
 * unchanged — this is an OBSERVATION layer, not a new decision surface.
 *
 * approve()/reject() are intentionally NOT overridden here: when a
 * companion `approve`/`reject` ControlCommand arrives, RelayBridge calls
 * `handlers.onApprove`/`onReject` (see BridgeHandlers), and THAT wiring
 * (headed, out of this slice) is what calls `gov.approve`/`gov.reject` —
 * using the race-safe `resolveApproval`/`resolveRejection` helpers below.
 */
export function bridgeGovernance(gov: Governance, bridge: RelayBridge): Governance {
  return {
    ...gov,
    async request(kind, detail) {
      const result = await gov.request(kind, detail);
      if (result.decision === "require-approval") {
        await bridge.emitApprovalRequest(
          result.actionId,
          result.kind,
          detail?.summary ?? `${kind} requires approval`,
        );
      }
      return result;
    },
    async settle(kind, outcome, detail) {
      await gov.settle(kind, outcome, detail);
      const suffix = detail?.summary ? ` — ${detail.summary}` : "";
      await bridge.emitAudit(`${kind}: ${outcome}${suffix}`);
    },
  };
}

// ── native-dialog vs companion-approve race (modeled + tested, not wired) ─

/**
 * Race-safe approval resolution. governance.ts's `approve()` is NOT
 * idempotent by itself: calling it on an actionId that is no longer
 * pending (already approved/rejected by whoever got there first) THROWS
 * ("no pending action for that id") rather than returning a safe no-op.
 * Once a companion `approve` command is wired to a live gate alongside the
 * app's own native approval dialog, BOTH can try to resolve the SAME
 * actionId — this wraps that race into "first resolver wins, the loser is
 * a safe no-op" instead of an unhandled throw.
 *
 * NOT wired to a live gate in this slice — this is the tested CORE
 * primitive a future headed session's BridgeHandlers.onApprove should call.
 */
export async function resolveApproval(
  gov: Governance,
  actionId: string,
): Promise<{ resolved: true; token: string } | { resolved: false }> {
  try {
    const { token } = await gov.approve(actionId);
    return { resolved: true, token };
  } catch {
    return { resolved: false };
  }
}

/**
 * reject()'s governance.ts backends are ALREADY a safe no-op on an
 * unknown/already-resolved actionId (`if (!rec) return;` — no throw). This
 * wrapper exists only so BridgeHandlers wiring can treat approve/reject
 * identically (both return without throwing, first-resolver-wins).
 */
export async function resolveRejection(gov: Governance, actionId: string): Promise<void> {
  await gov.reject(actionId);
}
