/**
 * Relay control-plane contract — Desktop-side MIRROR of the sealed Dilim 1
 * (braavolabs monorepo, `packages/api/src/modules/relay/protocol.ts`). The
 * Desktop app cannot import monorepo code (separate repo, separate deploy),
 * so this contract is duplicated deliberately and kept in lockstep — the
 * exact same discipline governance.ts already follows for the Rust host
 * mirror (see that file's header).
 *
 * Two message families, each a zod discriminated union on `type`:
 *
 *   SessionEvent    — this LOCAL session → companion (status/output/approvals/audit)
 *   ControlCommand  — companion → this LOCAL session (steer/approve/reject/kill)
 *
 * Naming note (same as the server contract): `SessionEvent`'s
 * "approval-request" variant carries its OWN `kind` field (the governed
 * action's kind, e.g. "browser.navigate" — a mirror of governance.ts's
 * ActionKind). To avoid colliding with that inner field, the union's OUTER
 * discriminant is named `type`.
 *
 * REDACTION RULE: this contract never intentionally carries a raw secret.
 * Free-text fields (dialogText / summary / decoded output / label / cwd) are
 * bounded AND passed through `redact()` — see redactSessionEventInput below.
 * The server (bus.ts) redacts again independently; this is DEFENSE IN DEPTH
 * so a raw secret never goes out over the wire from this process in the
 * first place, not a substitute for the server-side guarantee.
 *
 * EXCEPTION — structured/round-tripped identifiers: `approval-request`'s
 * `actionId`/`kind` and `approve`/`reject`'s `actionId` are NOT passed
 * through the general `redact()` (which would corrupt a UUID/hex-shaped id
 * and silently break the approve/reject round-trip). They get the narrower
 * `redactStructuredId()` instead — see its doc comment.
 *
 * SURFACE NOTE: this mirror's `SessionRegistration.surface` includes "web"
 * in addition to the server's current "desktop"|"cli" (Dilim 1, first
 * slice) — the wider client-side type is forward-compatible with a future
 * web companion/session surface and is harmless to carry even though this
 * Desktop app itself only ever registers as "desktop".
 */
import { z } from "zod";

// ─── Bounds ─────────────────────────────────────────────────────────────
// Mirrors the server contract's bounds exactly (protocol.ts) so a message
// this client builds can never be rejected by the server's own zod parse.
export const MAX_TEXT_LEN = 4000;
export const MAX_OUTPUT_B64_LEN = 200_000;
export const MAX_ACTION_ID_LEN = 200;
export const MAX_ACTION_KIND_LEN = 120;
export const MAX_LABEL_LEN = 200;
export const MAX_CWD_LEN = 1024;

// ─── Redaction ──────────────────────────────────────────────────────────
// Defense-in-depth backstop, NOT a substitute for the contract never
// carrying raw secrets in the first place. Three simple, cheap patterns:
//   - `sk-...` style provider API key prefixes
//   - `Bearer <opaque>` authorization-header-shaped tokens
//   - long (>=32 char) opaque alnum/[-_.] runs (JWT/hex-secret shaped)
// This will over-redact some legitimate long identifiers (hashes, commit
// SHAs) — an acceptable false-positive rate for a mirrored, human-readable
// audit/approval feed where under-redaction is the far worse failure mode.
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._-]{10,}/gi,
  /(?<![A-Za-z0-9._-])[A-Za-z0-9._-]{32,}(?![A-Za-z0-9._-])/g,
];

export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "«redacted»");
  }
  return out;
}

// Narrower pass for STRUCTURED IDENTIFIERS that must remain functional after
// redaction: `approval-request.actionId`/`.kind` and `approve`/`reject`
// commands' `actionId` round-trip — the companion echoes the exact actionId
// back to approve/reject the SAME governed action, and this local session
// matches it against governance's own pending-action table. Those ids are
// commonly UUID/hex-shaped (>=32 chars) and would be destroyed by the
// generic long-opaque-token rule in `redact()`, silently breaking the
// approval flow (worse than the redaction gap it would "fix"). So
// structured ids only pass through the sk-/Bearer patterns.
const STRUCTURED_ID_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._-]{10,}/gi,
];

export function redactStructuredId(text: string): string {
  let out = text;
  for (const pattern of STRUCTURED_ID_PATTERNS) {
    out = out.replace(pattern, "«redacted»");
  }
  return out;
}

// ─── SessionRegistration ────────────────────────────────────────────────
export const SURFACES = ["cli", "desktop", "web"] as const;
export type Surface = (typeof SURFACES)[number];

export const SessionRegistrationSchema = z.object({
  surface: z.enum(SURFACES),
  label: z.string().trim().min(1).max(MAX_LABEL_LEN).optional(),
  cwd: z.string().trim().min(1).max(MAX_CWD_LEN).optional(),
});
export type SessionRegistration = z.infer<typeof SessionRegistrationSchema>;

// ─── SessionEvent (this LOCAL session → companion) ─────────────────────
// Governed-action approval mirror (governance.ts). `kind` here is the
// governed action's OWN kind (e.g. "browser.navigate"), unrelated to the
// outer union discriminant.
export const ApprovalRequestEventSchema = z.object({
  type: z.literal("approval-request"),
  actionId: z.string().trim().min(1).max(MAX_ACTION_ID_LEN),
  kind: z.string().trim().min(1).max(MAX_ACTION_KIND_LEN),
  dialogText: z.string().trim().min(1).max(MAX_TEXT_LEN),
});

// Redacted turn summary — never the raw transcript.
export const AgentTurnEventSchema = z.object({
  type: z.literal("agent-turn"),
  summary: z.string().trim().min(1).max(MAX_TEXT_LEN),
});

// Terminal/agent output, base64-encoded and bounded.
export const OutputEventSchema = z.object({
  type: z.literal("output"),
  textB64: z.string().min(1).max(MAX_OUTPUT_B64_LEN),
});

// Audit ledger line mirror — redacted summary, never raw ledger payload.
export const AuditEventSchema = z.object({
  type: z.literal("audit"),
  summary: z.string().trim().min(1).max(MAX_TEXT_LEN),
});

export const SESSION_STATES = ["running", "idle", "ended"] as const;
export type SessionEventState = (typeof SESSION_STATES)[number];

export const StatusEventSchema = z.object({
  type: z.literal("status"),
  state: z.enum(SESSION_STATES),
});

export const SessionEventInputSchema = z.discriminatedUnion("type", [
  ApprovalRequestEventSchema,
  AgentTurnEventSchema,
  OutputEventSchema,
  AuditEventSchema,
  StatusEventSchema,
]);
/** What this LOCAL session posts — no envelope yet (server assigns it). */
export type SessionEventInput = z.infer<typeof SessionEventInputSchema>;

/** What the companion receives — input + server-assigned envelope. This
 * client never has to construct one (the server does); the type exists for
 * completeness/documentation parity with the server contract. */
export type SessionEvent = SessionEventInput & {
  sessionId: string;
  seq: number;
  ts: string;
};

/**
 * Apply the redaction rule to a parsed SessionEventInput's free-text
 * fields BEFORE it is handed to the transport — the client-side half of
 * defense-in-depth (the server redacts again independently in bus.ts).
 * `output` is base64 — decoded, redacted, and re-encoded so the pattern
 * match runs against the actual text, not its base64 encoding. Malformed
 * base64 is treated conservatively (replaced wholesale) rather than left
 * un-redacted.
 */
export function redactSessionEventInput(ev: SessionEventInput): SessionEventInput {
  switch (ev.type) {
    case "approval-request":
      // actionId/kind: structured-id pass (round-trip safety, see
      // redactStructuredId doc). dialogText: full redaction (free text).
      return {
        ...ev,
        actionId: redactStructuredId(ev.actionId),
        kind: redactStructuredId(ev.kind),
        dialogText: redact(ev.dialogText),
      };
    case "agent-turn":
      return { ...ev, summary: redact(ev.summary) };
    case "audit":
      return { ...ev, summary: redact(ev.summary) };
    case "output": {
      let decoded: string;
      try {
        decoded = base64Decode(ev.textB64);
      } catch {
        return { ...ev, textB64: base64Encode("«unreadable output»") };
      }
      return { ...ev, textB64: base64Encode(redact(decoded)) };
    }
    case "status":
      return ev; // no free text to redact
  }
}

// base64 helpers that work in BOTH the Vite/browser webview (no Buffer) and
// the Vitest/Node test runner (no atob/btoa without a shim) — governance.ts
// keeps webview code node-free; this mirrors that discipline rather than
// assuming either global is present.
function base64Encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  if (typeof btoa === "function") {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}

function base64Decode(b64: string): string {
  if (typeof atob === "function") {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(b64, "base64").toString("utf8");
}

// ─── ControlCommand (companion → this LOCAL session) ───────────────────
export const SteerCommandSchema = z.object({
  type: z.literal("steer"),
  message: z.string().trim().min(1).max(MAX_TEXT_LEN),
});
export const ApproveCommandSchema = z.object({
  type: z.literal("approve"),
  actionId: z.string().trim().min(1).max(MAX_ACTION_ID_LEN),
});
export const RejectCommandSchema = z.object({
  type: z.literal("reject"),
  actionId: z.string().trim().min(1).max(MAX_ACTION_ID_LEN),
});
export const KillCommandSchema = z.object({
  type: z.literal("kill"),
});

export const ControlCommandSchema = z.discriminatedUnion("type", [
  SteerCommandSchema,
  ApproveCommandSchema,
  RejectCommandSchema,
  KillCommandSchema,
]);
export type ControlCommand = z.infer<typeof ControlCommandSchema>;

/** What this LOCAL session receives — command + server-assigned envelope. */
export type ControlCommandMessage = ControlCommand & {
  sessionId: string;
  seq: number;
  ts: string;
};

/**
 * Symmetric redaction pass for an INCOMING command — defense-in-depth for
 * whatever this session logs/mirrors locally from a companion command (the
 * server already redacts outbound in bus.ts; this is the client-side
 * backstop, same rationale as redactSessionEventInput above). `steer.message`
 * is free text → full redaction. `approve`/`reject`'s `actionId` is a
 * structured, round-tripped identifier (matched against governance's own
 * pending-action table) → structured-id pass only. `kill` carries no payload.
 */
export function redactControlCommand(cmd: ControlCommand): ControlCommand {
  if (cmd.type === "steer") {
    return { ...cmd, message: redact(cmd.message) };
  }
  if (cmd.type === "approve" || cmd.type === "reject") {
    return { ...cmd, actionId: redactStructuredId(cmd.actionId) };
  }
  return cmd;
}
