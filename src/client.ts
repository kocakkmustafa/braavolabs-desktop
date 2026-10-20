import { rememberHistoryIdentity, forgetHistoryIdentity } from "./sessions";
import { withinRequestBudget } from "./request-budget";
/**
 * Braavolabs API client — the shared CLI endpoint contract with a desktop URL boundary:
 * dependency-free `fetch`, a single transparent refresh-on-401, `ApiError` on
 * non-2xx, and `raw` mode for callers (login) that render their own banner.
 * Keeping the CLI endpoint contract means server-side changes only have to be
 * reasoned about once. `fetchImpl`/`save` stay injectable so the desktop's
 * whole network layer is unit-testable with fakes (no disk, no sockets, no
 * Tauri).
 *
 * Load-bearing endpoint contracts (server routers, confirmed against source):
 *   POST /auth/login          → { token, refreshToken, user, tenant }  (public)
 *   POST /auth/refresh        → same shape; OLD refresh token is rotated/revoked
 *   POST /auth/logout         → 200 { message }; auth-optional, revokes the server
 *                               refresh token via bearer OR the refresh-token body
 *   POST /research/compare    → { id, status:"PENDING" }  (async; poll GET /research/:id)
 *   GET  /research/:id        → full session row (PENDING→RUNNING→COMPLETED|FAILED)
 *   POST /research/cascade    → synchronous TenantCascadeResult (NO companyId in body)
 *   GET  /billing/savings     → tenant savings report (no companyId)
 *   GET  /memory?companyId=…  → company-scoped memory rows (right-inspector panel)
 */
import { type Config, saveConfig } from "./config";
import { parseCompareSelectionOptions, type CompareSelectionOptions, type ModelSelection } from "./compare-selection";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// A temporary refresh HTTP failure remains retryable. Invalid rotation data or
// failed persistence must stop automatic reconnect before credentials are reused.
class TransientRefreshError extends ApiError {}
export class AuthenticationPersistenceError extends ApiError {}
export class AuthenticationProtocolError extends ApiError {}

/** Bind every credential-bearing request to the explicitly selected API origin.
 * HTTPS self-hosts are supported; plaintext is reserved for loopback fixtures.
 * Redirects are separately rejected at fetch so a 307 cannot forward passwords.
 */
export function apiRequestUrl(apiUrl: string, path: string): string {
  let base: URL;
  try { base = new URL(apiUrl); } catch { throw new ApiError(0, "Invalid API URL"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if ((base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) ||
      base.username || base.password || base.search || base.hash || apiUrl.includes("\\")) {
    throw new ApiError(0, "API requires HTTPS or loopback, without credentials, query or fragment");
  }
  const prefix = base.pathname.replace(/\/$/, "");
  const url = new URL(`${base.origin}${prefix}${path}`);
  if (!path.startsWith("/") || url.origin !== base.origin || !url.pathname.startsWith(`${prefix}/`)) {
    throw new ApiError(0, "Request must remain inside the selected API");
  }
  return url.href;
}

type FetchLike = (url: string, init?: any) => Promise<any>;

export interface RequestOpts {
  method?: string;
  body?: unknown;
  auth?: boolean;
  raw?: boolean;
  /** Return a successful response without consuming its streaming body. */
  stream?: boolean;
  /** Cancel this request, including its replay after a shared refresh. */
  signal?: AbortSignal;
  cfg: Config;
  /** Persist cfg after a refresh; defaults to the registered secure backend. */
  save?: (c: Config) => void | Promise<void>;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

export interface RawResult {
  status: number;
  statusText: string;
  body: any;
}

/** A logout/login transition must invalidate even an identical restored pair. */
export class SessionChangedError extends Error {
  constructor() {
    super("Session changed while the request was pending");
    this.name = "SessionChangedError";
  }
}
export interface SessionSnapshot {
  revision: number;
  apiUrl: string;
  token?: string;
  refreshToken?: string;
}
const sessions = new WeakMap<Config, SessionSnapshot>();
const refreshes = new WeakMap<Config, { owner: SessionSnapshot; promise: Promise<string | undefined> }>();

function currentSession(cfg: Config): SessionSnapshot {
  let state = sessions.get(cfg);
  if (!state) {
    state = { revision: 0, apiUrl: cfg.apiUrl, token: cfg.token, refreshToken: cfg.refreshToken };
    sessions.set(cfg, state);
  } else if (state.apiUrl !== cfg.apiUrl || state.token !== cfg.token || state.refreshToken !== cfg.refreshToken) {
    state.revision++;
    state.apiUrl = cfg.apiUrl; state.token = cfg.token; state.refreshToken = cfg.refreshToken;
  }
  return state;
}
export function captureSession(cfg: Config): SessionSnapshot {
  return { ...currentSession(cfg) };
}
export function isCurrentSession(cfg: Config, owner: SessionSnapshot): boolean {
  const state = currentSession(cfg);
  return state.revision === owner.revision && state.apiUrl === owner.apiUrl;
}
export function invalidateSession(cfg: Config): void {
  currentSession(cfg).revision++;
}
function assertSession(cfg: Config, owner: SessionSnapshot): void {
  if (!isCurrentSession(cfg, owner)) throw new SessionChangedError();
}

/** One refresh per captured owner/pair. Rotation itself keeps that owner alive. */
async function refreshSession(
  cfg: Config,
  owner: SessionSnapshot,
  doFetch: FetchLike,
  save: (c: Config) => void | Promise<void>,
): Promise<string | undefined> {
  assertSession(cfg, owner);
  const pending = refreshes.get(cfg);
  if (pending && pending.owner.revision === owner.revision && pending.owner.apiUrl === owner.apiUrl) {
    // Rotation updates memory before async persistence finishes. Join that
    // flight before reusing its pair so a late 401 cannot bypass a failed save.
    const token = await pending.promise;
    assertSession(cfg, owner);
    return token === undefined ? undefined : cfg.token;
  }
  const current = currentSession(cfg);
  if (current.token !== owner.token || current.refreshToken !== owner.refreshToken) {
    return current.token; // A late 401 can reuse the already rotated pair.
  }
  if (!owner.refreshToken) return undefined;
  let flight = refreshes.get(cfg);
  if (!flight || flight.owner.revision !== owner.revision || flight.owner.apiUrl !== owner.apiUrl ||
      flight.owner.token !== owner.token || flight.owner.refreshToken !== owner.refreshToken) {
    const promise = (async () => {
      const r = await doFetch(apiRequestUrl(owner.apiUrl, "/auth/refresh"), {
        redirect: "error",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: owner.refreshToken }),
      });
      assertSession(cfg, owner);
      if (!r.ok) {
        if (r.status === 408 || r.status === 429 || (r.status >= 500 && r.status < 600)) {
          throw new TransientRefreshError(r.status, "Authentication refresh temporarily unavailable");
        }
        return undefined;
      }
      let d: { token?: string; refreshToken?: string };
      try { d = await r.json(); }
      catch (error) {
        assertSession(cfg, owner);
        if (error instanceof SyntaxError) throw new AuthenticationProtocolError(503, "Invalid authentication response");
        throw error; // A body-read network failure remains retryable.
      }
      assertSession(cfg, owner);
      if (typeof d?.token !== "string" || !d.token.trim() ||
          (d.refreshToken !== undefined && (typeof d.refreshToken !== "string" || !d.refreshToken.trim()))) {
        throw new AuthenticationProtocolError(503, "Invalid authentication response");
      }
      cfg.token = d.token;
      if (d.refreshToken !== undefined) cfg.refreshToken = d.refreshToken;
      // These writes are our own rotation, not a new account/session.
      current.token = cfg.token; current.refreshToken = cfg.refreshToken;
      try { await save(cfg); }
      catch { throw new AuthenticationPersistenceError(503, "Unable to persist refreshed session"); }
      finally { assertSession(cfg, owner); }
      return cfg.token;
    })();
    flight = { owner, promise };
    refreshes.set(cfg, flight);
    const cleanup = () => { if (refreshes.get(cfg) === flight) refreshes.delete(cfg); };
    void promise.then(cleanup, cleanup);
  }
  const token = await flight.promise;
  assertSession(cfg, owner);
  return token === undefined ? undefined : cfg.token;
}


/**
 * JSON request against the configured API base. Bearer auth by default,
 * exactly one transparent refresh on 401 (never on `/auth/*` — guards the
 * refresh endpoint itself against an infinite loop), `raw` mode hands back
 * {status,body} so callers can branch on codes instead of catching.
 */
export async function apiFetch(path: string, opts: RequestOpts): Promise<any> {
  const { cfg } = opts;
  const owner = captureSession(cfg);
  const authed = opts.auth !== false;
  const save = opts.save ?? saveConfig;
  const doFetch: FetchLike = opts.fetchImpl ?? (globalThis.fetch as FetchLike);

  const req = (tok?: string) => {
    assertSession(cfg, owner);
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("Request aborted");
    return doFetch(apiRequestUrl(owner.apiUrl, path), {
      redirect: "error",
      method: opts.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(opts.stream ? { Accept: "text/event-stream" } : {}),
        ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  };

  let res = await req(authed ? owner.token : undefined);
  assertSession(cfg, owner);

  // Transparent single refresh on 401 (never on /auth/* to avoid loops).
  if (res.status === 401 && authed && owner.refreshToken && !path.startsWith("/auth/")) {
    let token: string | undefined;
    try {
      token = await refreshSession(cfg, owner, doFetch, save);
    } catch (error) {
      assertSession(cfg, owner);
      if (opts.raw && error instanceof TransientRefreshError) {
        return { status: error.status, statusText: error.message, body: { error: error.message } } satisfies RawResult;
      }
      throw error;
    }
    if (token) res = await req(token);
    assertSession(cfg, owner);
  }

  if (opts.raw) {
    const body = res.status === 204 ? null : await res.json().catch(() => ({}));
    assertSession(cfg, owner);
    return { status: res.status, statusText: res.statusText, body } satisfies RawResult;
  }

  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    assertSession(cfg, owner);
    throw new ApiError(res.status, b.error ?? b.message ?? res.statusText);
  }
  if (opts.stream) return res;
  if (res.status === 204) return null;
  const body = await res.json();
  assertSession(cfg, owner);
  return body;
}

// ── typed command wrappers ──────────────────────────────────────────────────

export interface LoginResult {
  token: string;
  refreshToken: string;
  user?: { id?: string; email?: string; name?: string | null; role?: string };
  tenant?: { id?: string; name?: string; slug?: string; plan?: string };
}

/**
 * POST /auth/login — public (auth:false, so NO bearer header is sent). Use
 * `raw:true` at the call site if you want to render a specific banner for
 * 401 (bad creds) vs 429 (rate-limited / account lockout) instead of a toast.
 */
export async function login(
  cfg: Config,
  creds: { email: string; password: string },
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void } = {},
): Promise<LoginResult> {
  return apiFetch("/auth/login", {
    method: "POST",
    body: creds,
    cfg,
    auth: false,
    fetchImpl: o.fetchImpl,
    save: o.save,
  });
}

export interface CompareParams {
  selections?: ModelSelection[];
  companyId: string;
  query: string;
  maxCandidates?: number;
  maxTokensPerCandidate?: number;
  maxCostUsd?: number;
}

/** POST /research/compare — returns the async session stub { id, status }. */
export async function startCompare(
  cfg: Config,
  p: CompareParams,
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void | Promise<void>; signal?: AbortSignal } = {},
): Promise<{ id: string; status: string }> {
  const body: Record<string, unknown> = { companyId: p.companyId, query: p.query };
  if (p.selections !== undefined) body.selections = p.selections;
  if (p.maxCandidates !== undefined) body.maxCandidates = p.maxCandidates;
  if (p.maxTokensPerCandidate !== undefined) body.maxTokensPerCandidate = p.maxTokensPerCandidate;
  if (p.maxCostUsd !== undefined) body.maxCostUsd = p.maxCostUsd;
  // Explicit selections must never degrade to an automatic compare on an older server.
  const path = p.selections === undefined ? "/research/compare" : "/research/compare/selected";
  return withinRequestBudget(signal => apiFetch(path, { method: "POST", body, cfg, fetchImpl: o.fetchImpl, save: o.save, signal }), o);
}

/** Verify rehydrated transcript ownership through the existing authenticated
 * profile route. Failure/offline leaves history volatile and does not block Local.
 * The decoded token alone is never trusted to open a persisted namespace. */
export async function verifyHistoryIdentity(cfg: Config, o: { fetchImpl?: FetchLike; save?: (c: Config) => void | Promise<void>; timeoutMs?: number } = {}): Promise<boolean> {
  const owner = captureSession(cfg);
  forgetHistoryIdentity(cfg);
  try {
    const profile = await withinRequestBudget(signal => apiFetch("/users/me", { cfg, signal, save: o.save, fetchImpl: o.fetchImpl }), { timeoutMs: o.timeoutMs ?? 5000 });
    if (!isCurrentSession(cfg, owner)) return false;
    return rememberHistoryIdentity(cfg, { user: { id: profile?.id }, tenant: { id: profile?.tenant?.id } });
  } catch { return false; }
}

/** Company-scoped discovery; no inference or provider probe. */
export async function listCompareSelectionOptions(
  cfg: Config, companyId: string,
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void } = {},
): Promise<CompareSelectionOptions> {
  const raw = await apiFetch(`/research/compare/options?companyId=${encodeURIComponent(companyId)}`, {
    cfg, fetchImpl: o.fetchImpl, save: o.save,
  });
  return parseCompareSelectionOptions(raw, companyId);
}

const TERMINAL_STATES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/** GET /research/:id — the poll endpoint for both /research and /research/compare. */
export async function getSession(
  cfg: Config,
  id: string,
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void | Promise<void>; signal?: AbortSignal } = {},
): Promise<any> {
  return apiFetch(`/research/${encodeURIComponent(id)}`, { cfg, fetchImpl: o.fetchImpl, save: o.save, signal: o.signal });
}

/** Soft-cancel prevents subsequent server rounds; in-flight provider work may finish. */
export async function cancelCompare(
  cfg: Config,
  id: string,
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void | Promise<void>; signal?: AbortSignal } = {},
): Promise<{ success: true; status: "CANCELLED" | "COMPLETED" | "FAILED" }> {
  const result = await apiFetch(`/research/${encodeURIComponent(id)}/cancel`, {
    method: "POST", cfg, fetchImpl: o.fetchImpl, save: o.save, signal: o.signal,
  });
  if (result?.success !== true || !TERMINAL_STATES.has(result?.status)) {
    throw new ApiError(502, "Invalid research cancellation response");
  }
  return result;
}

/** Cancel the polling delay as well as an in-flight fetch. */
function waitForPoll(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (aborted = false) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (aborted) reject(signal?.reason ?? new Error("Request aborted"));
      else resolve();
    };
    const abort = () => finish(true);
    const timer = setTimeout(() => finish(), ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Poll GET /research/:id until it reaches a terminal state (~5 min default). */
export async function pollCompare(
  cfg: Config,
  id: string,
  o: {
    fetchImpl?: FetchLike;
    save?: (c: Config) => void;
    intervalMs?: number;
    maxAttempts?: number;
    onTick?: (status: string, attempt: number) => void;
    signal?: AbortSignal;
    /** A replaced UI must stop polling even if the same account remains. */
    isCurrent?: () => boolean;
  } = {},
): Promise<any> {
  const owner = captureSession(cfg);
  const assertCurrent = () => {
    assertSession(cfg, owner);
    if (o.isCurrent && !o.isCurrent()) throw new SessionChangedError();
    if (o.signal?.aborted) throw o.signal.reason ?? new Error("Request aborted");
  };
  const interval = o.intervalMs ?? 2000;
  const maxAttempts = o.maxAttempts ?? 150; // ~5 min at 2s
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    assertCurrent();
    const session = await getSession(cfg, id, { fetchImpl: o.fetchImpl, save: o.save, signal: o.signal });
    assertCurrent();
    const status = String(session?.status ?? "");
    o.onTick?.(status, attempt);
    assertCurrent();
    if (TERMINAL_STATES.has(status)) return session;
    await waitForPoll(interval, o.signal);
  }
  throw new ApiError(408, `Timed out polling research session ${id}`);
}

export interface CascadeParams {
  prompt: string;
  confidenceThreshold?: number;
  secondOpinion?: boolean;
  budgetUsdCap?: number;
}

/**
 * POST /research/cascade — SYNCHRONOUS. Deliberately sends NO companyId: the
 * endpoint is a direct tenant-scoped prompt cascade (tenant derived from JWT),
 * unlike /research/compare which is company-scoped and 404s on a foreign id.
 */
export async function cascade(
  cfg: Config,
  p: CascadeParams,
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void | Promise<void>; signal?: AbortSignal } = {},
): Promise<any> {
  const body: Record<string, unknown> = { prompt: p.prompt };
  if (p.confidenceThreshold !== undefined) body.confidenceThreshold = p.confidenceThreshold;
  if (p.secondOpinion !== undefined) body.secondOpinion = p.secondOpinion;
  if (p.budgetUsdCap !== undefined) body.budgetUsdCap = p.budgetUsdCap;
  return withinRequestBudget(signal => apiFetch("/research/cascade", { method: "POST", body, cfg, fetchImpl: o.fetchImpl, save: o.save, signal }), o);
}

/** POST /auth/logout — best-effort server-side refresh-token revocation. Sends
 * the refresh token in the body so the server can revoke even when the ACCESS
 * token has expired (the common idle-app sign-out): the endpoint is auth-optional
 * and falls back to the refresh token when the bearer is dead (audit #1 — without
 * the body the server 401s an expired bearer and the refresh token survives).
 * Raw so a failure (offline / already-expired) is swallowed by the caller; local
 * creds are cleared regardless. Server replies 200 { message }. */
export async function logout(
  cfg: Config,
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void } = {},
): Promise<RawResult> {
  return apiFetch("/auth/logout", { method: "POST", body: { refreshToken: cfg.refreshToken }, cfg, raw: true, fetchImpl: o.fetchImpl, save: o.save });
}

/** GET /billing/savings?days=N — tenant-scoped, no companyId. */
export async function savings(
  cfg: Config,
  p: { days?: number } = {},
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void } = {},
): Promise<any> {
  const q = p.days !== undefined ? `?days=${encodeURIComponent(String(p.days))}` : "";
  return apiFetch(`/billing/savings${q}`, { cfg, fetchImpl: o.fetchImpl, save: o.save });
}

/**
 * GET /api/v1/memory?companyId=…  — company-scoped memory rows for the
 * right-inspector "hafıza" panel. Requires an active company (there is NO
 * tenant-wide memory listing endpoint), same constraint /research already has.
 */
export async function listMemory(
  cfg: Config,
  p: { companyId: string; type?: string; status?: string },
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void } = {},
): Promise<any> {
  const qs = new URLSearchParams({ companyId: p.companyId });
  if (p.type) qs.set("type", p.type);
  if (p.status) qs.set("status", p.status);
  return apiFetch(`/memory?${qs.toString()}`, { cfg, fetchImpl: o.fetchImpl, save: o.save });
}

// ── companies + always-on jobs (Company surface) ──────────────────────────

/** GET /companies — the tenant's companies with agent/pipeline counts. */
export async function listCompanies(
  cfg: Config,
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void } = {},
): Promise<any> {
  return apiFetch("/companies", { cfg, fetchImpl: o.fetchImpl, save: o.save });
}

/**
 * GET /pipelines/scheduled — always-on jobs. The server joins each pipeline's
 * cron with the LIVE scheduler state, so `nextRunAt` is real (null when no
 * scheduler is registered) instead of something we guess client-side.
 */
export async function listScheduledPipelines(
  cfg: Config,
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void } = {},
): Promise<any> {
  return apiFetch("/pipelines/scheduled", { cfg, fetchImpl: o.fetchImpl, save: o.save });
}

/** POST /companies/:id/pause — 404s when the company is not ACTIVE. */
export async function pauseCompany(
  cfg: Config,
  id: string,
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void } = {},
): Promise<any> {
  return apiFetch(`/companies/${encodeURIComponent(id)}/pause`, {
    cfg,
    method: "POST",
    fetchImpl: o.fetchImpl,
    save: o.save,
  });
}

/** POST /companies/:id/resume — the inverse; 404s when not PAUSED. */
export async function resumeCompany(
  cfg: Config,
  id: string,
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void } = {},
): Promise<any> {
  return apiFetch(`/companies/${encodeURIComponent(id)}/resume`, {
    cfg,
    method: "POST",
    fetchImpl: o.fetchImpl,
    save: o.save,
  });
}
