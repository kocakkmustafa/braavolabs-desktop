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
/** Sidebar title length, derived from the first user entry. */
export const TITLE_MAX = 42;

const STORE_KEY = "bv.sessions.v1";

/** The subset of Storage we need — lets tests pass a plain Map wrapper. */
export interface KVStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SessionStore {
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

function sanitize(raw: unknown): ChatSession[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatSession[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const c = s as Partial<ChatSession>;
    if (typeof c.id !== "string" || !Array.isArray(c.entries)) continue;
    out.push({
      id: c.id,
      title: typeof c.title === "string" ? c.title : "",
      createdAt: typeof c.createdAt === "number" ? c.createdAt : 0,
      updatedAt: typeof c.updatedAt === "number" ? c.updatedAt : 0,
      entries: c.entries.filter(
        (e): e is SessionEntry =>
          !!e && typeof e === "object" && typeof (e as SessionEntry).text === "string",
      ),
    });
  }
  return out;
}

export function createSessionStore(storage: KVStorage, idGen?: () => string): SessionStore {
  const nextId =
    idGen ??
    (() =>
      globalThis.crypto?.randomUUID?.() ??
      `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);

  const load = (): ChatSession[] => {
    try {
      return sanitize(JSON.parse(storage.getItem(STORE_KEY) ?? "[]"));
    } catch {
      // Corrupt JSON — start clean rather than crash the workspace.
      return [];
    }
  };

  const save = (sessions: ChatSession[]) => {
    const bounded = [...sessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS);
    storage.setItem(STORE_KEY, JSON.stringify(bounded));
  };

  return {
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
      s.entries.push(entry);
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

/** Runtime resolver — localStorage in the webview, memory when unavailable. */
export function resolveSessionStore(): SessionStore {
  try {
    const ls = globalThis.localStorage;
    // Probe: some webview states throw on access.
    ls.getItem(STORE_KEY);
    return createSessionStore(ls);
  } catch {
    const mem = new Map<string, string>();
    return createSessionStore({
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => void mem.set(k, v),
    });
  }
}
