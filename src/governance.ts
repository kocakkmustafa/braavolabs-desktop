/**
 * Governance-by-default — the desktop's security MOAT. Every side-effecting
 * action (Lane-B launch, a command through the choke point, an MCP tool call, a
 * file write, a BYOK egress) passes a policy gate BEFORE it can run. The gate is
 * FAIL-CLOSED: an unknown action is never auto-allowed — it falls through to
 * require-approval. This is the deliberate opposite of an "allow-all" agent host.
 *
 * Three cooperating pieces, all pure/injectable so the whole thing is unit-tested
 * without Tauri or disk:
 *
 *   1. classifyAction() — the POLICY. A pure function mapping (kind, detail) →
 *      { auto-allow | require-approval | deny }. This is the single source of
 *      truth the Rust host mirrors (src-tauri/src/lib.rs), exactly as knownPaths
 *      is the source of truth for spawn detection.
 *   2. The GATE — a one-time-token lifecycle. request() classifies + audits;
 *      approve()/reject() resolve a pending approval; consume() spends a token
 *      EXACTLY once (a replayed token is rejected) — so an executor that requires
 *      a consumed token can never run without passing the gate.
 *   3. The LEDGER — an append-only audit trail. Every transition appends one
 *      entry (monotonic seq + ts + kind + decision + outcome + REDACTED summary).
 *      A secret/token is NEVER written — only the action type and meta.
 *
 * SECURITY BOUNDARY (honest): the real enforcement point is the Rust host (a
 * compromised webview can't forge a host-side token, and the command choke point
 * validates the working-dir allowlist there). The in-memory backend here is the
 * dev/test analogue — same contract, same fail-closed policy — so behaviour is
 * verifiable headlessly. Full OS-level sandbox isolation (container / seatbelt /
 * AppContainer) is a documented roadmap/human-gate; this layer is "governed +
 * choke-point", NOT a claim of OS sandboxing.
 */

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Tauri v2 with `withGlobalTauri:true` exposes window.__TAURI__.core.invoke. */
function tauriInvoke(): Invoke | null {
  const g = globalThis as any;
  const inv = g?.__TAURI__?.core?.invoke;
  return typeof inv === "function" ? (inv as Invoke) : null;
}

// ── action taxonomy ─────────────────────────────────────────────────────────

/**
 * The actions the desktop can request. Extend DELIBERATELY — an action kind not
 * in this list is still handled (fail-closed → require-approval), it just isn't
 * one we've explicitly reasoned about.
 */
export const ACTION_KINDS = [
  "probe.detect", // Lane-B: detect an installed vendor CLI (read-only)
  "local.dispatch", // Lane-A local Ollama (keyless, localhost)
  "direct.dispatch", // Lane-A BYOK egress to a provider API (secret leaves via header)
  "spawn.launch", // Lane-B: reveal/copy the vendor CLI launch command
  "command.run", // execute a command through the Rust choke point
  "mcp.tool", // call an MCP tool
  "file.write", // write a file
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export function isActionKind(k: string): k is ActionKind {
  return (ACTION_KINDS as readonly string[]).includes(k);
}

export type Decision = "auto-allow" | "require-approval" | "deny";

/**
 * The ONLY kinds that run without a human tap. Deliberately tiny and explicit:
 * read-only detection + local keyless dispatch. Anything with an external side
 * effect (egress, launch, command, mcp, file-write) is NOT here, so it needs
 * approval. Adding a kind here is a conscious, reviewable widening of trust.
 */
const AUTO_ALLOW: ReadonlySet<string> = new Set<string>(["probe.detect", "local.dispatch"]);

/** Obviously destructive command shapes — hard-denied, never even surfaced for approval. */
const DESTRUCTIVE: readonly RegExp[] = [
  /\brm\s+-rf?\b/i,
  /\bmkfs\b/i,
  /\bdd\b\s+if=/i,
  />\s*\/dev\/(sd|nvme|disk)/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, // fork bomb
] as const;

/** Meta describing an action — NEVER a secret. `summary` is human-readable copy. */
export interface ActionDetail {
  /** One-line human summary shown in the approval modal + (redacted) in audit. */
  summary?: string;
  /** command.run: argv ARRAY (never a shell string — no injection seam). */
  argv?: string[];
  /** command.run: working directory (Rust choke point enforces the allowlist). */
  cwd?: string;
  /** file.write: target path. */
  path?: string;
  /** mcp.tool: tool + server names (meta only). */
  tool?: string;
  server?: string;
  /** spawn.launch: which vendor CLI. */
  vendor?: string;
  /** direct.dispatch: which provider. */
  provider?: string;
}

/** True when a path tries to escape its base via a `..` segment (defense-in-depth). */
export function isTraversal(path: string): boolean {
  return path
    .split(/[\\/]+/)
    .some((seg) => seg === "..");
}

/** True when a joined command line matches an obviously destructive pattern. */
export function isDestructive(joined: string): boolean {
  return DESTRUCTIVE.some((re) => re.test(joined));
}

/**
 * THE POLICY. Pure, total, fail-closed. Order matters: hard denies are checked
 * first (independent of the allow/approval split), then the explicit auto-allow
 * set, then everything else — known-side-effecting AND unknown — requires a human.
 */
export function classifyAction(
  kind: string,
  detail: ActionDetail = {},
): { decision: Decision; reason: string } {
  // 1. Hard denies (defense-in-depth — a denied action is never approvable).
  if (kind === "command.run" && isDestructive((detail.argv ?? []).join(" "))) {
    return { decision: "deny", reason: "destructive command pattern" };
  }
  if (kind === "file.write" && detail.path && isTraversal(detail.path)) {
    return { decision: "deny", reason: "path traversal blocked" };
  }
  // 2. Explicit auto-allow (read-only / local-keyless only).
  if (AUTO_ALLOW.has(kind)) {
    return { decision: "auto-allow", reason: "read-only / local-keyless" };
  }
  // 3. FAIL-CLOSED default — the moat. Unknown kinds land here too.
  return {
    decision: "require-approval",
    reason: isActionKind(kind) ? "side-effecting action" : "unknown action (fail-closed)",
  };
}

/** One row per action kind for the Settings → Policy visibility panel. */
export interface PolicyRow {
  kind: ActionKind;
  decision: Decision;
  note: string;
}

/** The default disposition of every known kind (with a representative detail). */
export function policyRows(): PolicyRow[] {
  return ACTION_KINDS.map((kind) => {
    const { decision, reason } = classifyAction(kind, {});
    return { kind, decision, note: reason };
  });
}

// ── audit ledger ────────────────────────────────────────────────────────────

/**
 * One append-only audit line. Carries the action TYPE + a REDACTED summary and
 * NOTHING sensitive — no token, no secret, no raw key. `seq` is a monotonic
 * counter (the reliable order key); `ts` is a wall-clock hint (frontend-supplied
 * or filled in), never trusted for ordering.
 */
export interface AuditEntry {
  seq: number;
  ts: number;
  kind: string;
  decision: Decision | "-";
  outcome: AuditOutcome;
  summary: string;
}

export type AuditOutcome =
  | "granted" // auto-allow: token minted immediately
  | "pending" // require-approval: awaiting the human
  | "approved" // human approved → token minted
  | "rejected" // human rejected
  | "denied" // policy hard-deny
  | "consumed" // token spent (action is now running)
  | "replay-rejected" // a spent/forged token was refused
  | "success" // action completed ok
  | "error"; // action failed

/**
 * Strip anything that looks like a credential from free text before it can land
 * in the ledger. Meta summaries should never contain a secret, but this is the
 * belt-and-braces guarantee the audit test asserts.
 */
export function redactSummary(s: string): string {
  return (s ?? "")
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "«redacted»") // openai / anthropic style
    .replace(/\bBearer\s+[A-Za-z0-9._-]{6,}/gi, "Bearer «redacted»")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "«redacted»"); // long opaque tokens
}

export interface AuditLedger {
  append(e: { kind: string; decision: Decision | "-"; outcome: AuditOutcome; summary?: string; ts?: number }): void;
  recent(n: number): AuditEntry[];
}

/** In-memory append-only ledger — the dev/test backend. */
export function createMemoryLedger(): AuditLedger {
  const entries: AuditEntry[] = [];
  let seq = 0;
  return {
    append(e) {
      entries.push({
        seq: ++seq,
        ts: e.ts ?? Date.now(),
        kind: e.kind,
        decision: e.decision,
        outcome: e.outcome,
        summary: redactSummary(e.summary ?? ""),
      });
    },
    recent(n) {
      const from = Math.max(0, entries.length - Math.max(0, n));
      return entries.slice(from);
    },
  };
}

// ── the gate ────────────────────────────────────────────────────────────────

/** What request() hands back. `token` is present only when the action may run NOW. */
export interface GateResult {
  actionId: string;
  kind: string;
  decision: Decision;
  reason: string;
  /** Auto-allow only. For require-approval the token is minted by approve(). */
  token?: string;
}

/** The governance surface the UI drives. Backends: memory (dev/test) or Tauri host. */
export interface Governance {
  /** Classify + audit an action. Returns a token immediately iff auto-allowed. */
  request(kind: string, detail?: ActionDetail): Promise<GateResult>;
  /** Resolve a pending approval → mint a one-time token. */
  approve(actionId: string): Promise<{ token: string }>;
  /** Resolve a pending approval as rejected — no token is ever minted. */
  reject(actionId: string): Promise<void>;
  /** Spend a token EXACTLY once. Returns false for a replayed/forged/mismatched token. */
  consume(token: string, kind: string, detail?: ActionDetail): Promise<boolean>;
  /** Record the terminal outcome of an executed action (success/error). */
  settle(kind: string, outcome: "success" | "error", detail?: ActionDetail): Promise<void>;
  /** Last n audit entries, oldest→newest. Never contains a secret. */
  recent(n?: number): Promise<AuditEntry[]>;
  /** Static policy table for the Settings visibility panel (pure, no host call). */
  policy(): PolicyRow[];
}

/** Stable binding key so a token issued for action A can't authorize action B. */
function bindingKey(kind: string, detail: ActionDetail): string {
  const d = detail ?? {};
  return JSON.stringify([
    kind,
    d.argv ?? null,
    d.cwd ?? null,
    d.path ?? null,
    d.tool ?? null,
    d.server ?? null,
    d.vendor ?? null,
    d.provider ?? null,
  ]);
}

let ridCounter = 0;
function rid(prefix: string): string {
  ridCounter += 1;
  const rand =
    (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, "");
  return `${prefix}_${ridCounter}_${rand}`;
}

interface Bound {
  actionId: string;
  kind: string;
  binding: string;
}

/**
 * In-memory gate — the dev/test backend and the exact behavioural mirror of the
 * Rust host. Tokens live in a Map and are DELETED on consume (one-time). A
 * pending approval must be resolved by approve()/reject() before a token exists.
 */
export function createMemoryGovernance(ledger: AuditLedger = createMemoryLedger()): Governance {
  const pending = new Map<string, Bound>(); // actionId → awaiting-approval
  const tokens = new Map<string, Bound>(); // token → bound action (spent on consume)

  return {
    async request(kind, detail = {}) {
      const { decision, reason } = classifyAction(kind, detail);
      const actionId = rid("act");
      const binding = bindingKey(kind, detail);
      const summary = detail.summary ?? kind;

      if (decision === "deny") {
        ledger.append({ kind, decision, outcome: "denied", summary });
        return { actionId, kind, decision, reason };
      }
      if (decision === "auto-allow") {
        const token = rid("tok");
        tokens.set(token, { actionId, kind, binding });
        ledger.append({ kind, decision, outcome: "granted", summary });
        return { actionId, kind, decision, reason, token };
      }
      // require-approval → park it; NO token yet.
      pending.set(actionId, { actionId, kind, binding });
      ledger.append({ kind, decision, outcome: "pending", summary });
      return { actionId, kind, decision, reason };
    },

    async approve(actionId) {
      const rec = pending.get(actionId);
      if (!rec) throw new Error("no pending action for that id");
      pending.delete(actionId);
      const token = rid("tok");
      tokens.set(token, rec);
      ledger.append({ kind: rec.kind, decision: "require-approval", outcome: "approved" });
      return { token };
    },

    async reject(actionId) {
      const rec = pending.get(actionId);
      if (!rec) return;
      pending.delete(actionId);
      ledger.append({ kind: rec.kind, decision: "require-approval", outcome: "rejected" });
    },

    async consume(token, kind, detail = {}) {
      const rec = tokens.get(token);
      // Missing token = replay (already spent) or forgery (never issued).
      if (!rec) {
        ledger.append({ kind, decision: "-", outcome: "replay-rejected", summary: kind });
        return false;
      }
      // Binding mismatch = a valid token aimed at the wrong action.
      if (rec.kind !== kind || rec.binding !== bindingKey(kind, detail)) {
        ledger.append({ kind, decision: "-", outcome: "replay-rejected", summary: kind });
        return false;
      }
      tokens.delete(token); // one-time — a second consume can't find it
      ledger.append({ kind, decision: "-", outcome: "consumed", summary: detail.summary ?? kind });
      return true;
    },

    async settle(kind, outcome, detail = {}) {
      ledger.append({ kind, decision: "-", outcome, summary: detail.summary ?? kind });
    },

    async recent(n = 50) {
      return ledger.recent(n);
    },

    policy() {
      return policyRows();
    },
  };
}

/** Raw shapes the Rust host returns (camelCase via serde). */
interface RawGateResult {
  actionId?: string;
  decision?: Decision;
  reason?: string;
  token?: string | null;
}
interface RawAuditEntry {
  seq?: number;
  ts?: number;
  kind?: string;
  decision?: Decision | "-";
  outcome?: AuditOutcome;
  summary?: string;
}

/**
 * Tauri-backed gate — the REAL enforcement. request/approve/reject/consume all
 * delegate to the Rust host, which owns the token store and the command choke
 * point (a webview compromise can't forge a host token). policy() stays LOCAL:
 * the disposition table is a compile-time constant, so a compromised host can
 * never lie to the user about which actions auto-run.
 */
export function createTauriGovernance(invoke: Invoke): Governance {
  return {
    async request(kind, detail = {}) {
      const raw = (await invoke("request_action", {
        kind,
        detail,
        ts: Date.now(),
      })) as RawGateResult | null;
      const decision = raw?.decision ?? "require-approval";
      return {
        actionId: String(raw?.actionId ?? ""),
        kind,
        decision,
        reason: String(raw?.reason ?? ""),
        token: raw?.token ?? undefined,
      };
    },
    async approve(actionId) {
      const raw = (await invoke("approve_action", { actionId, ts: Date.now() })) as
        | { token?: string }
        | null;
      return { token: String(raw?.token ?? "") };
    },
    async reject(actionId) {
      await invoke("reject_action", { actionId, ts: Date.now() });
    },
    async consume(token, kind, detail = {}) {
      const ok = (await invoke("consume_action", { token, kind, detail, ts: Date.now() })) as
        | boolean
        | null;
      return ok === true;
    },
    async settle(kind, outcome, detail = {}) {
      await invoke("settle_action", { kind, outcome, detail, ts: Date.now() });
    },
    async recent(n = 50) {
      const raw = (await invoke("audit_recent", { n })) as RawAuditEntry[] | null;
      return Array.isArray(raw)
        ? raw.map((e) => ({
            seq: Number(e?.seq ?? 0),
            ts: Number(e?.ts ?? 0),
            kind: String(e?.kind ?? ""),
            decision: (e?.decision ?? "-") as Decision | "-",
            outcome: (e?.outcome ?? "error") as AuditOutcome,
            summary: redactSummary(String(e?.summary ?? "")),
          }))
        : [];
    },
    policy() {
      return policyRows();
    },
  };
}

/** Pick the real backend at runtime: Tauri host if present, else in-memory. */
export function resolveGovernance(): Governance {
  const inv = tauriInvoke();
  return inv ? createTauriGovernance(inv) : createMemoryGovernance();
}
