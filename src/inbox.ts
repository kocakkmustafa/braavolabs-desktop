/**
 * Desktop jobs inbox core (BRA-P0-04i). Pure + injectable; no DOM, no Tauri.
 *
 * Decision (Project orchestration, binding):
 *  (a) The platform `approvals`/`decide` is the single source of truth. The desktop only
 *      shows + decides; it never creates a second approval record for the same action and
 *      never routes a platform approval through the local `governance` gate.
 *      SEC-BRA-01: the exact-action hash/nonce are server-side only (GET /approvals strips
 *      them; decide takes `{ decision, reason?, note? }`). The platform verifies them when the
 *      grant is consumed. The desktop adds a content guard: APPROVED is sent only if the
 *      approval, re-read just before sending, is still PENDING and its content fingerprint
 *      equals the one the user saw. Otherwise it is refused (nothing is sent).
 *  (b) Local `governance` approvals stay for desktop-only actions (computer control, local
 *      files). `isLocalGovernanceKind` is that set. Reporting receipts to the platform is
 *      out of scope (04i-b).
 *  (c) Offline: a platform approval cannot be approved. Fail-closed: no local approval,
 *      no request; the UI says "decide once online". A network failure while deciding is
 *      treated the same way.
 *  (d) Behind a flag, default OFF.
 */

import { ApiError, decideApproval, listApprovals, listRuns } from "./client";
import type { Config } from "./config";
import { INBOX_BUCKETS, type InboxBucket, type JobRunRow } from "./jobTypes";

// ── flag (default OFF; same `bv.*` localStorage convention as prefs.ts) ─────
export const INBOX_FLAG_KEY = "bv.flags.jobsInbox";

export interface FlagStorage { getItem(key: string): string | null }

/** Only the literal "1" enables the inbox. Missing/unreadable storage = off. */
export function isInboxEnabled(storage?: FlagStorage): boolean {
  try {
    const s = storage ?? (globalThis as { localStorage?: FlagStorage }).localStorage;
    return s?.getItem(INBOX_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

// ── local governance scope ──────────────────────────────────────────────────
/** Desktop-only actions that have no platform Approval counterpart. Everything else stays platform. */
export const LOCAL_GOVERNANCE_KINDS: ReadonlySet<string> = new Set([
  "computer.read",
  "computer.interact",
  "file.write",
]);
export function isLocalGovernanceKind(kind: string): boolean {
  return LOCAL_GOVERNANCE_KINDS.has(kind);
}

// ── approval snapshot + fingerprint ─────────────────────────────────────────
/** Row of GET /approvals (narrow projection, BRA-P0-04h). */
export interface PlatformApproval {
  id: string;
  runId: string;
  type?: string;
  status?: string;
  description?: string | null;
  amountUsd?: number | string | null;
  metadata?: { toolName?: string } | null;
  details?: unknown;
  artifact?: unknown;
  expiresAt?: string | null;
}

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

/** What the user is deciding on. Any change to these fields changes the fingerprint. */
export function approvalFingerprint(a: PlatformApproval): string {
  return stable({
    id: a.id,
    runId: a.runId,
    type: a.type ?? null,
    description: a.description ?? null,
    amountUsd: a.amountUsd === undefined || a.amountUsd === null ? null : Number(a.amountUsd),
    toolName: a.metadata?.toolName ?? null,
    details: a.details ?? null,
    artifact: a.artifact ?? null,
  });
}

// ── decide ──────────────────────────────────────────────────────────────────
export type DecideOutcome =
  | { ok: true; decision: "APPROVED" | "REJECTED" }
  | { ok: false; reason: "offline" | "changed" | "gone" | "already" | "error"; message?: string };

type FetchLike = (url: string, init?: any) => Promise<any>;

export interface DecideDeps {
  cfg: Config;
  /** Injectable connectivity probe; default `navigator.onLine`. */
  isOnline?: () => boolean;
  fetchImpl?: FetchLike;
  save?: (c: Config) => void | Promise<void>;
  maxPages?: number;
}

const defaultOnline = (): boolean => {
  const n = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  return n?.onLine !== false;
};

/** Re-read the pending approval by id (paged). null = not pending any more. */
async function fetchPending(id: string, d: DecideDeps): Promise<PlatformApproval | null> {
  let cursor: string | undefined;
  for (let page = 0; page < (d.maxPages ?? 5); page++) {
    const r = await listApprovals(d.cfg, { limit: 100, cursor }, { fetchImpl: d.fetchImpl, save: d.save });
    const hit = r.items.find((a: PlatformApproval) => a.id === id);
    if (hit) return hit;
    if (!r.nextCursor) return null;
    cursor = r.nextCursor;
  }
  return null;
}

/**
 * One decision controller per app session: tracks in-flight and settled ids so the same
 * approval is decided at most once (no second record, no double POST).
 */
export function createDecider(d: DecideDeps) {
  const inflight = new Map<string, Promise<DecideOutcome>>();
  const settled = new Set<string>();

  async function run(seen: PlatformApproval, decision: "APPROVED" | "REJECTED", note?: string): Promise<DecideOutcome> {
    const online = d.isOnline ?? defaultOnline;
    if (!online()) return { ok: false, reason: "offline" }; // (c) fail-closed, no request
    try {
      if (decision === "APPROVED") {
        const now = await fetchPending(seen.id, d);
        if (!now) return { ok: false, reason: "gone" };
        if (approvalFingerprint(now) !== approvalFingerprint(seen)) return { ok: false, reason: "changed" };
      }
      await decideApproval(
        d.cfg,
        seen.id,
        { decision, ...(note ? { note } : {}) },
        { fetchImpl: d.fetchImpl, save: d.save },
      );
      settled.add(seen.id);
      return { ok: true, decision };
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 409) { settled.add(seen.id); return { ok: false, reason: "already", message: e.message }; }
        if (e.status === 404) return { ok: false, reason: "gone", message: e.message };
        return { ok: false, reason: "error", message: e.message };
      }
      return { ok: false, reason: "offline" }; // network failure: never approve locally
    }
  }

  return {
    isSettled: (id: string) => settled.has(id),
    decide(seen: PlatformApproval, decision: "APPROVED" | "REJECTED", note?: string): Promise<DecideOutcome> {
      if (settled.has(seen.id)) return Promise.resolve({ ok: false, reason: "already" });
      const cur = inflight.get(seen.id);
      if (cur) return cur;
      const p = run(seen, decision, note).finally(() => inflight.delete(seen.id));
      inflight.set(seen.id, p);
      return p;
    },
  };
}

// ── buckets + notification ──────────────────────────────────────────────────
export type BucketMap = Record<InboxBucket, JobRunRow[]>;

export async function loadBuckets(
  cfg: Config,
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void | Promise<void>; limit?: number } = {},
): Promise<BucketMap> {
  const out = {} as BucketMap;
  await Promise.all(INBOX_BUCKETS.map(async b => {
    out[b] = (await listRuns(cfg, { bucket: b, limit: o.limit ?? 25 }, { fetchImpl: o.fetchImpl, save: o.save })).items;
  }));
  return out;
}

/** Notifies each pending approval id exactly once, however many polls see it. */
export function createNotifier(notify: (a: PlatformApproval) => void) {
  const told = new Set<string>();
  return {
    feed(pending: PlatformApproval[]): number {
      let n = 0;
      for (const a of pending) {
        if (told.has(a.id)) continue;
        told.add(a.id);
        notify(a);
        n++;
      }
      return n;
    },
  };
}
