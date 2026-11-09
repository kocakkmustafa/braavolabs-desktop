/**
 * Platform job contract mirror (BRA-P0-04g).
 * Source of truth: ventures/braavolabs/platform/packages/core/src/types/job.ts
 * Platform commit: 34d05676b3014380c99dae249f0b8ffc867bdcbe (last commit touching job.ts)
 * Keep byte-for-byte semantically identical; update both together.
 */

export const JOB_STATES = [
  "DRAFT",
  "PLANNED",
  "READY",
  "RUNNING",
  "NEEDS_APPROVAL",
  "RESUMING",
  "PAUSED",
  "FAILED",
  "CANCELLED",
  "COMPLETED",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const RESULT_STATUSES = ["VERIFIED", "UNVERIFIED"] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const LEGACY_RUN_STATUS_VALUES = [
  "PENDING",
  "RUNNING",
  "PAUSED",
  "WAITING_APPROVAL",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type LegacyRunStatusValue = (typeof LEGACY_RUN_STATUS_VALUES)[number];

export type JobReceiptEvidenceKind = "diff" | "test" | "pr" | "artifact" | "log";

export interface JobReceiptEvidence {
  kind: JobReceiptEvidenceKind;
  ref: string;
  ok?: boolean;
}

export interface JobReceipt {
  id: string;
  runId: string;
  tenantId: string;
  outcome: JobState;
  resultStatus: ResultStatus | null;
  costUsd: number | null;
  evidence: JobReceiptEvidence[];
  approvalIds: string[];
  contentHash: string;
  /** ISO 8601 */
  createdAt: string;
}

/** Row of GET /runs `runs[]` (narrow select + computed bucket). */
export interface JobRunRow {
  id: string;
  pipelineId: string;
  status: string;
  state: JobState | null;
  resultStatus: ResultStatus | null;
  trigger?: string | null;
  costUsd?: number | string | null;
  startedAt: string | null;
  completedAt: string | null;
  heartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
  pipeline?: { id: string; name: string; company?: { id: string; name: string } | null } | null;
  bucket: InboxBucket | null;
}

export const INBOX_BUCKETS = ["working", "needs_approval", "done", "stuck"] as const;
export type InboxBucket = (typeof INBOX_BUCKETS)[number];

export interface JobBucketInput {
  state?: string | null;
  status?: string | null;
  resultStatus?: string | null;
  heartbeatAt?: Date | string | number | null;
  now: Date | string | number;
  staleAfterMs: number;
}

const STATE_BUCKET: Record<JobState, InboxBucket | null> = {
  DRAFT: null,
  PLANNED: "working",
  READY: "working",
  RUNNING: "working",
  RESUMING: "working",
  NEEDS_APPROVAL: "needs_approval",
  COMPLETED: "done",
  CANCELLED: "done",
  FAILED: "stuck",
  PAUSED: "stuck",
};

const LEGACY_BUCKET: Record<LegacyRunStatusValue, InboxBucket> = {
  PENDING: "working",
  RUNNING: "working",
  WAITING_APPROVAL: "needs_approval",
  COMPLETED: "done",
  CANCELLED: "done",
  FAILED: "stuck",
  PAUSED: "stuck",
};

function toMs(v: Date | string | number): number {
  return v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
}

function isOwn<T extends string>(table: Record<T, unknown>, key: string): key is T {
  return Object.prototype.hasOwnProperty.call(table, key);
}

function isStale(hb: JobBucketInput["heartbeatAt"], now: JobBucketInput["now"], staleAfterMs: number): boolean {
  if (hb === null || hb === undefined) return false;
  const h = toMs(hb);
  const n = toMs(now);
  if (!Number.isFinite(h) || !Number.isFinite(n) || !Number.isFinite(staleAfterMs) || staleAfterMs < 0) return true;
  return n - h > staleAfterMs;
}

/** Same rules as the platform: state wins over status; unknown/corrupt -> stuck; stale RUNNING -> stuck; null = hidden (DRAFT). */
export function jobBucket(input: JobBucketInput): InboxBucket | null {
  const { state, status, resultStatus, heartbeatAt, now, staleAfterMs } = input;
  let bucket: InboxBucket | null;
  let running = false;
  if (state !== null && state !== undefined) {
    if (!isOwn(STATE_BUCKET, state)) return "stuck";
    bucket = STATE_BUCKET[state];
    running = state === "RUNNING";
  } else {
    if (typeof status !== "string" || !isOwn(LEGACY_BUCKET, status)) return "stuck";
    bucket = LEGACY_BUCKET[status];
    running = status === "RUNNING";
  }
  if (
    resultStatus !== null &&
    resultStatus !== undefined &&
    !(RESULT_STATUSES as readonly string[]).includes(resultStatus)
  ) {
    return "stuck";
  }
  if (bucket === null) return null;
  if (running && isStale(heartbeatAt, now, staleAfterMs)) return "stuck";
  return bucket;
}
