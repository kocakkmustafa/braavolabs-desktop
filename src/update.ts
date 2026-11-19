/**
 * New-version notice (BRA-UI-11). Pure and injectable; no DOM.
 *
 * There is no update engine. This module only asks GitHub Releases for the latest published version,
 * compares it with the running one and, when newer, offers a link to the release page that the user
 * opens in the system browser and installs by hand. Nothing is downloaded, installed or restarted here.
 *
 * Network: one unauthenticated GET to https://api.github.com, at most once a day on its own (the
 * "Check now" button in About may ask again). No token, no cookie, no identifier, no referrer.
 * A network error, a rate limit or an odd answer is silent in the banner and shows as "could not
 * check" in About. Default OFF behind a local flag; see `isUpdateEnabled`.
 */

export const UPDATE_FLAG_KEY = "bv.flags.updateBanner";
export const UPDATE_LAST_KEY = "bv.prefs.updateLastCheck";
export const UPDATE_SEEN_KEY = "bv.prefs.updateSeen";
export const UPDATE_DISMISSED_KEY = "bv.prefs.updateDismissed";

export const LATEST_URL = "https://api.github.com/repos/kocakkmustafa/braavolabs-desktop/releases/latest";
export const RELEASE_PREFIX = "https://github.com/kocakkmustafa/";
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_CHARS = 512 * 1024;
const TIMEOUT_MS = 8000;

export interface FlagStorage { getItem(key: string): string | null }
export interface Storage2 extends FlagStorage { setItem(key: string, value: string): void }

/** Only the literal "1" enables the notice. Missing/unreadable storage = off. */
export function isUpdateEnabled(storage?: FlagStorage): boolean {
  try {
    const s = storage ?? (globalThis as { localStorage?: FlagStorage }).localStorage;
    return s?.getItem(UPDATE_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

// ── versions ────────────────────────────────────────────────────────────────
export interface Semver { major: number; minor: number; patch: number; pre: string | null }

/** "v1.2.3", "1.2.3", "1.2.3-rc.1". Anything else is null. */
export function parseSemver(text: unknown): Semver | null {
  if (typeof text !== "string" || text.length > 64) return null;
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z][0-9A-Za-z.-]{0,30}))?(?:\+[0-9A-Za-z.-]{1,30})?$/.exec(text.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null };
}

function comparePre(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1; // a release is newer than its own pre-release
  if (b === null) return -1;
  const pa = a.split("."), pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1; }
    else if (nx !== ny) return nx ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** -1, 0 or 1. */
export function compareSemver(a: Semver, b: Semver): number {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  return comparePre(a.pre, b.pre);
}

export const formatVersion = (v: Semver): string => `${v.major}.${v.minor}.${v.patch}`;

// ── links and answers ───────────────────────────────────────────────────────
/** True for a short, plain https link under the project's own GitHub account. The host enforces the same rule. */
export function isReleaseUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length <= RELEASE_PREFIX.length || url.length > 300 || !url.startsWith(RELEASE_PREFIX)) return false;
  const rest = url.slice(RELEASE_PREFIX.length);
  if (rest.includes("..") || rest.includes("@")) return false;
  return /^[\x21-\x7e]+$/.test(url) && !/["\\<>`^{}|]/.test(url);
}

export interface LatestRelease { version: string; url: string }

/** The one acceptable shape of GitHub's "latest release" answer, or null. Drafts and pre-releases never count. */
export function validateRelease(body: unknown): LatestRelease | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const r = body as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true) return null;
  const v = parseSemver(r.tag_name);
  if (!v || v.pre !== null) return null;
  if (!isReleaseUrl(r.html_url)) return null;
  return { version: formatVersion(v), url: r.html_url };
}

// ── schedule ────────────────────────────────────────────────────────────────
/** True when no check was made in the last day (or the stored time is unusable or in the future). */
export function checkDue(last: unknown, now: number): boolean {
  const t = typeof last === "string" ? Number(last) : typeof last === "number" ? last : NaN;
  if (!Number.isFinite(t) || t <= 0 || t > now) return true;
  return now - t >= CHECK_INTERVAL_MS;
}

// ── the check ───────────────────────────────────────────────────────────────
export interface FetchBody { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> | void } }
export type FetchFn = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean; status: number; text(): Promise<string>;
  headers?: { get(name: string): string | null }; body?: FetchBody | null;
}>;

/** The body as text, never more than MAX_BODY_CHARS: a declared length over the limit is refused, and a stream is cut off at the limit. */
async function readCapped(res: Awaited<ReturnType<FetchFn>>): Promise<string | null> {
  const declared = Number(res.headers?.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_CHARS) return null;
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    return text.length > MAX_BODY_CHARS ? null : text;
  }
  const dec = new TextDecoder();
  let out = "", bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value?.byteLength ?? 0;
    if (bytes > MAX_BODY_CHARS) { void reader.cancel(); return null; }
    if (value) out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
}

export type CheckResult =
  | { kind: "newer"; version: string; url: string }
  | { kind: "current" }
  | { kind: "failed" };

/** One GET to LATEST_URL. Never throws. */
export async function checkForUpdate(current: string, fetchFn: FetchFn): Promise<CheckResult> {
  const cur = parseSemver(current);
  if (!cur) return { kind: "failed" };
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  try {
    const res = await fetchFn(LATEST_URL, {
      method: "GET",
      headers: { Accept: "application/vnd.github+json" },
      credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
      ...(ctl ? { signal: ctl.signal } : {}),
    });
    if (!res.ok) return { kind: "failed" };
    const text = await readCapped(res);
    if (text === null) return { kind: "failed" };
    const latest = validateRelease(JSON.parse(text));
    if (!latest) return { kind: "failed" };
    const lv = parseSemver(latest.version)!;
    return compareSemver(lv, cur) > 0 ? { kind: "newer", ...latest } : { kind: "current" };
  } catch {
    return { kind: "failed" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── controller ──────────────────────────────────────────────────────────────
export type UpdatePhase = "idle" | "checking" | "newer" | "current" | "failed";
export interface UpdateState { phase: UpdatePhase; version?: string; url?: string; lastCheck?: number; dismissed: boolean }

export interface UpdateDeps {
  current: string;
  storage?: Storage2;
  fetchFn?: FetchFn;
  now?: () => number;
}

export interface UpdateChecker {
  state(): UpdateState;
  subscribe(fn: (s: UpdateState) => void): () => void;
  /** At most one network call a day; otherwise it only restores what the last answer said. */
  auto(): Promise<void>;
  /** The "Check now" button. Ignored while a check is running. */
  manual(): Promise<void>;
  /** "Later": hide the banner for this version. */
  dismiss(): void;
}

function store(deps: UpdateDeps): Storage2 | undefined {
  try { return deps.storage ?? (globalThis as { localStorage?: Storage2 }).localStorage; } catch { return undefined; }
}
const read = (s: Storage2 | undefined, k: string): string | null => { try { return s?.getItem(k) ?? null; } catch { return null; } };
const write = (s: Storage2 | undefined, k: string, v: string): void => { try { s?.setItem(k, v); } catch { /* storage is optional */ } };

export function createUpdateChecker(deps: UpdateDeps): UpdateChecker {
  const now = deps.now ?? Date.now;
  const fetchFn: FetchFn = deps.fetchFn ?? ((url, init) => (globalThis as unknown as { fetch: FetchFn }).fetch(url, init));
  const cur = parseSemver(deps.current);
  const subs = new Set<(s: UpdateState) => void>();
  let st: UpdateState = { phase: "idle", dismissed: false };
  let running = false;

  const dismissedVersion = () => read(store(deps), UPDATE_DISMISSED_KEY);
  const set = (next: Omit<UpdateState, "dismissed">) => {
    st = { ...next, dismissed: !!next.version && dismissedVersion() === next.version };
    for (const fn of [...subs]) { try { fn(st); } catch { /* a listener must not break the others */ } }
  };
  const lastCheck = (): number | undefined => {
    const n = Number(read(store(deps), UPDATE_LAST_KEY));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  /** What the previous answer said, re-validated and compared with the running version. */
  const restore = () => {
    const raw = read(store(deps), UPDATE_SEEN_KEY);
    let seen: LatestRelease | null = null;
    try { seen = raw ? validateRelease({ tag_name: (JSON.parse(raw) as LatestRelease).version, html_url: (JSON.parse(raw) as LatestRelease).url }) : null; } catch { seen = null; }
    const lv = seen ? parseSemver(seen.version) : null;
    if (seen && lv && cur && compareSemver(lv, cur) > 0) set({ phase: "newer", version: seen.version, url: seen.url, lastCheck: lastCheck() });
    else if (lastCheck()) set({ phase: "current", lastCheck: lastCheck() });
  };

  const run = async () => {
    if (running) return;
    running = true;
    const at = now();
    // The time is written before the request so a failing network is not retried more than once a day either.
    write(store(deps), UPDATE_LAST_KEY, String(at));
    set({ phase: "checking", version: st.version, url: st.url, lastCheck: at });
    try {
      const r = await checkForUpdate(deps.current, fetchFn);
      if (r.kind === "newer") {
        write(store(deps), UPDATE_SEEN_KEY, JSON.stringify({ version: r.version, url: r.url }));
        set({ phase: "newer", version: r.version, url: r.url, lastCheck: at });
      } else if (r.kind === "current") {
        write(store(deps), UPDATE_SEEN_KEY, "");
        set({ phase: "current", lastCheck: at });
      } else set({ phase: "failed", version: st.version, url: st.url, lastCheck: at }); // a known newer version stays offered
    } finally {
      running = false;
    }
  };

  return {
    state: () => st,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    async auto() {
      if (checkDue(read(store(deps), UPDATE_LAST_KEY), now())) await run();
      else if (st.phase === "idle") restore();
    },
    async manual() { await run(); },
    dismiss() {
      if (st.version) write(store(deps), UPDATE_DISMISSED_KEY, st.version);
      set({ phase: st.phase, version: st.version, url: st.url, lastCheck: st.lastCheck });
    },
  };
}

/** The banner shows only for a newer, validated, not-dismissed version. */
export const bannerVisible = (s: UpdateState): boolean =>
  (s.phase === "newer" || s.phase === "checking" || s.phase === "failed") && !s.dismissed && !!s.version && isReleaseUrl(s.url);
