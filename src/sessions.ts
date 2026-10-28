/**
 * Local chat sessions — the sidebar's TODAY / EARLIER list (design v3).
 *
 * Pure and storage-injected like keyvault/spawn: the UI resolves a
 * localStorage-backed store at runtime, tests inject a memory Storage.
 * Sessions are plain user content (prompts + final answer text) and NEVER
 * secrets, so localStorage — not the secure store — is the right home; the
 * secure store stays reserved for tokens.
 *
 * Restore fidelity is deliberately plain-text: reopening a session replays
 * user/assistant/error lines, not the rich cascade/compare cards (those need
 * live API payloads we intentionally don't persist). Honest, bounded, local.
 */

export type SessionRole = "user" | "assistant" | "error";

export interface SessionEntry {
  role: SessionRole;
  /** Dispatch lane the entry came from ("cascade" | "compare" | "local" | "direct"). */
  mode: string;
  text: string;
  at: number;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  entries: SessionEntry[];
}

/** Newest sessions kept; older ones dropped on write. */
export const MAX_SESSIONS = 50;
/** Per-session entry cap — oldest entries dropped first. */
export const MAX_ENTRIES = 200;
/** Per-entry character cap. Model answers are unbounded and localStorage is
 *  ~5MB/origin; the transcript is a convenience record, not an archive. */
export const MAX_ENTRY_CHARS = 4000;
/** Sidebar title length, derived from the first user entry. */
export const TITLE_MAX = 42;

const STORE_KEY = "bv.sessions.v1";

/** The subset of Storage we need — lets tests pass a plain Map wrapper. */
export interface KVStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SessionStatus { persistence: "saved" | "failed" | "corrupt" | "volatile"; truncated: boolean; legacy?: boolean; }

export interface SessionStore {
  clearMemory(): void;
  status(): SessionStatus;
  export(): string;
  /** Newest-first. */
  list(): ChatSession[];
  get(id: string): ChatSession | undefined;
  create(now?: number): ChatSession;
  /** Appends, derives the title from the first user entry, persists. */
  append(id: string, entry: SessionEntry): ChatSession | undefined;
  remove(id: string): void;
}

export function deriveTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length <= TITLE_MAX ? flat : `${flat.slice(0, TITLE_MAX - 1)}…`;
}

/** Split for the sidebar: sessions updated since local midnight vs the rest. */
export function groupSessions(
  sessions: ChatSession[],
  now: number,
): { today: ChatSession[]; earlier: ChatSession[] } {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const cut = midnight.getTime();
  const today: ChatSession[] = [];
  const earlier: ChatSession[] = [];
  for (const s of sessions) (s.updatedAt >= cut ? today : earlier).push(s);
  return { today, earlier };
}

function sanitize(raw: unknown): { sessions: ChatSession[]; changed: boolean } {
  if (!Array.isArray(raw)) return { sessions: [], changed: true };
  const out: ChatSession[] = []; let changed = false;
  const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  for (const row of raw) {
    if (!row || typeof row !== "object" || typeof row.id !== "string" || !Array.isArray(row.entries)) { changed = true; continue; }
    const entries: SessionEntry[] = [];
    for (const entry of row.entries) {
      if (!entry || typeof entry !== "object" || !["user", "assistant", "error"].includes(entry.role)
        || typeof entry.mode !== "string" || typeof entry.text !== "string" || !finite(entry.at)) { changed = true; continue; }
      if (Object.keys(entry).some(key => !["role", "mode", "text", "at"].includes(key))) changed = true;
      entries.push({ role: entry.role, mode: entry.mode, text: entry.text, at: entry.at });
    }
    if (typeof row.title !== "string" || !finite(row.createdAt) || !finite(row.updatedAt)
      || Object.keys(row).some(key => !["id", "title", "createdAt", "updatedAt", "entries"].includes(key))) changed = true;
    out.push({ id: row.id, title: typeof row.title === "string" ? row.title : "",
      createdAt: finite(row.createdAt) ? row.createdAt : 0, updatedAt: finite(row.updatedAt) ? row.updatedAt : 0, entries });
  }
  return { sessions: out, changed };
}

/** A decoded JWT can propose a local partition label only. It never proves
 * identity or authorizes disk rehydration. A successful authenticated API reply
 * must bind the label to this exact config/API/token snapshot first. */
function namespaceFromIdentity(apiUrl: string, userId: unknown, tenantId: unknown): string | null {
  try {
    const api = new URL(apiUrl);
    if (api.username || api.password || !["http:", "https:"].includes(api.protocol)) return null;
    if (typeof userId !== "string" || !userId || typeof tenantId !== "string" || !tenantId || userId.length > 256 || tenantId.length > 256) return null;
    return `bv.sessions.v2:${encodeURIComponent(JSON.stringify([api.origin + api.pathname.replace(/\/+$/, ""), tenantId, userId]))}`;
  } catch { return null; }
}
export function sessionNamespace(apiUrl: string, accessToken?: string): string | null {
  try {
    const pieces = accessToken?.split("."); if (pieces?.length !== 3 || pieces[1].length > 16_384) return null;
    const part = pieces[1].replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(part.padEnd(Math.ceil(part.length / 4) * 4, "=")), character => character.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes));
    if (!claims || claims.typ === "refresh") return null;
    return namespaceFromIdentity(apiUrl, claims.userId, claims.tenantId);
  } catch { return null; }
}
type HistoryConfig = { apiUrl: string; token?: string };
const verifiedOwners = new WeakMap<HistoryConfig, { apiUrl: string; token: string; key: string }>();
export function rememberHistoryIdentity(cfg: HistoryConfig, authenticatedReply: { user?: { id?: string }; tenant?: { id?: string } }): boolean {
  verifiedOwners.delete(cfg);
  const key = namespaceFromIdentity(cfg.apiUrl, authenticatedReply.user?.id, authenticatedReply.tenant?.id);
  if (!cfg.token || !key || sessionNamespace(cfg.apiUrl, cfg.token) !== key) return false;
  verifiedOwners.set(cfg, { apiUrl: cfg.apiUrl, token: cfg.token, key });
  return true;
}
export function forgetHistoryIdentity(cfg: HistoryConfig): void { verifiedOwners.delete(cfg); }
function verifiedNamespace(cfg: HistoryConfig): string | null {
  const owner = verifiedOwners.get(cfg);
  if (!owner || owner.apiUrl !== cfg.apiUrl || owner.token !== cfg.token || sessionNamespace(cfg.apiUrl, cfg.token) !== owner.key) return null;
  return owner.key;
}

export function createSessionStore(storage: KVStorage, idGen?: () => string, options: { key?: string; volatile?: boolean; legacy?: boolean } = {}): SessionStore {
  const storeKey = options.key ?? STORE_KEY;
  const nextId =
    idGen ??
    (() =>
      globalThis.crypto?.randomUUID?.() ??
      `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);

  let state: SessionStatus = { persistence: options.volatile ? "volatile" : "saved", truncated: false, ...(options.legacy ? { legacy: true } : {}) };
  let original = "";
  let cache: ChatSession[] = [];
  try {
    original = storage.getItem(storeKey) ?? "[]";
    const parsed: unknown = JSON.parse(original);
    if (!Array.isArray(parsed)) throw new Error("invalid transcript");
    const result = sanitize(parsed); cache = result.sessions;
    if (result.changed) state.persistence = "corrupt";
  } catch { state.persistence = "corrupt"; }
  const bound = (sessions: ChatSession[]) => {
    if (sessions.length > MAX_SESSIONS) state.truncated = true;
    return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS).map(s => {
      if (s.entries.length > MAX_ENTRIES || s.entries.some(e => e.text.length > MAX_ENTRY_CHARS)) state.truncated = true;
      return { ...s, entries: s.entries.slice(-MAX_ENTRIES).map(e => e.text.length > MAX_ENTRY_CHARS
        ? { ...e, text: `${e.text.slice(0, MAX_ENTRY_CHARS)}…` } : e) };
    });
  };
  cache = bound(cache);
  const load = () => cache;
  const save = (sessions: ChatSession[]) => {
    cache = bound(sessions);
    // Preserve the original corrupt record for recovery/export. Never silently
    // overwrite it or evict 3/4 of history after a quota failure.
    if (state.persistence === "corrupt" || state.persistence === "volatile") return;
    try { storage.setItem(storeKey, JSON.stringify(cache)); state.persistence = "saved"; }
    catch { state.persistence = "failed"; }
  };

  return {
    clearMemory() { cache = []; },
    status() { return { ...state }; },
    export() { return JSON.stringify({ version: 1, sessions: cache, ...(state.persistence === "corrupt" || state.truncated ? { recovery: original } : {}) }, null, 2); },
    list() {
      return load().sort((a, b) => b.updatedAt - a.updatedAt);
    },
    get(id) {
      return load().find((s) => s.id === id);
    },
    create(now = Date.now()) {
      const sessions = load();
      const s: ChatSession = { id: nextId(), title: "", createdAt: now, updatedAt: now, entries: [] };
      sessions.push(s);
      save(sessions);
      return s;
    },
    append(id, entry) {
      const sessions = load();
      const s = sessions.find((x) => x.id === id);
      if (!s) return undefined;
      if (entry.text.length > MAX_ENTRY_CHARS || s.entries.length >= MAX_ENTRIES) state.truncated = true;
      s.entries.push(
        entry.text.length > MAX_ENTRY_CHARS
          ? { ...entry, text: `${entry.text.slice(0, MAX_ENTRY_CHARS)}…` }
          : entry,
      );
      if (s.entries.length > MAX_ENTRIES) s.entries.splice(0, s.entries.length - MAX_ENTRIES);
      if (!s.title && entry.role === "user") s.title = deriveTitle(entry.text);
      s.updatedAt = entry.at;
      save(sessions);
      return s;
    },
    remove(id) {
      save(load().filter((s) => s.id !== id));
    },
  };
}

/**
 * Wipe every persisted transcript + the cached account email. Called on
 * sign-out: these are plain user content (which is why localStorage is the
 * right home) but they are still THAT user's content — the next account to
 * sign in on this machine must not find them waiting in the sidebar.
 */
let activeRuntimeStore: SessionStore | undefined;
let activeRuntimeKey: string | undefined;
let activeRuntimeConfig: HistoryConfig | undefined;

/** Forget only the current runtime's scoped transcript and the old shared key.
 * A failed delete is visible; another account still opens a distinct namespace. */
export function clearAllSessions(): boolean {
  activeRuntimeStore?.clearMemory(); activeRuntimeStore = undefined;
  if (activeRuntimeConfig) forgetHistoryIdentity(activeRuntimeConfig); activeRuntimeConfig = undefined;
  const key = activeRuntimeKey; activeRuntimeKey = undefined;
  try {
    const storage = globalThis.localStorage;
    if (!storage) return true;
    if (key) storage.removeItem(key);
    // The unscoped v1 record has no verified owner. Ordinary logout must not
    // erase it; it is reserved for explicit owner-verified recovery/erasure.
    storage.removeItem("bv.account.email");
    return (!key || storage.getItem(key) === null) && storage.getItem("bv.account.email") === null;
  } catch { return false; }
}

/** Unknown token identity/storage failure never falls back to the old shared
 * record. Legacy bytes remain untouched for owner-verified recovery. */
export function resolveSessionStore(scope: { apiUrl: string; token?: string }): SessionStore {
  const key = verifiedNamespace(scope);
  activeRuntimeConfig = scope;
  activeRuntimeKey = key ?? undefined;
  try {
    const storage = globalThis.localStorage;
    if (!key) throw new Error("history identity unavailable");
    storage.getItem(key);
    activeRuntimeStore = createSessionStore(storage, undefined, { key, legacy: storage.getItem(STORE_KEY) !== null });
  } catch {
    const mem = new Map<string, string>();
    activeRuntimeStore = createSessionStore({ getItem: name => mem.get(name) ?? null, setItem: (name, value) => void mem.set(name, value) }, undefined, { volatile: true });
  }
  return activeRuntimeStore;
}
