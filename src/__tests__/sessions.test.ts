import { describe, it, expect, vi } from "vitest";
import {
  createSessionStore,
  sessionNamespace,
  resolveSessionStore,
  clearAllSessions,
  rememberHistoryIdentity,
  deriveTitle,
  groupSessions,
  MAX_ENTRIES,
  MAX_ENTRY_CHARS,
  MAX_SESSIONS,
  TITLE_MAX,
  type KVStorage,
  type SessionEntry,
} from "../sessions";

function memStorage(): KVStorage & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: (k) => raw.get(k) ?? null,
    setItem: (k, v) => void raw.set(k, v),
  };
}

const entry = (over: Partial<SessionEntry> = {}): SessionEntry => ({
  role: "user",
  mode: "cascade",
  text: "hello there",
  at: 1000,
  ...over,
});

describe("deriveTitle", () => {
  it("flattens whitespace and trims", () => {
    expect(deriveTitle("  fix\n the   bug ")).toBe("fix the bug");
  });
  it("caps at TITLE_MAX with an ellipsis", () => {
    const long = "x".repeat(TITLE_MAX * 2);
    const title = deriveTitle(long);
    expect(title.length).toBe(TITLE_MAX);
    expect(title.endsWith("…")).toBe(true);
  });
  it("returns empty for blank input", () => {
    expect(deriveTitle("   ")).toBe("");
  });
});

describe("createSessionStore", () => {
  it("creates, appends, titles from first user entry, persists roundtrip", () => {
    const storage = memStorage();
    let store = createSessionStore(storage, () => "id-1");
    const s = store.create(500);
    store.append(s.id, entry({ text: "compare the schemas", at: 600 }));
    store.append(s.id, entry({ role: "assistant", text: "answer", at: 700 }));

    // A fresh store over the same storage sees the same data (persistence).
    store = createSessionStore(storage);
    const loaded = store.get("id-1");
    expect(loaded?.title).toBe("compare the schemas");
    expect(loaded?.entries).toHaveLength(2);
    expect(loaded?.updatedAt).toBe(700);
  });

  it("assistant-first entries never set the title", () => {
    const storage = memStorage();
    const store = createSessionStore(storage, () => "id-1");
    const s = store.create(0);
    store.append(s.id, entry({ role: "assistant", text: "greeting", at: 1 }));
    expect(store.get(s.id)?.title).toBe("");
    store.append(s.id, entry({ role: "user", text: "real question", at: 2 }));
    expect(store.get(s.id)?.title).toBe("real question");
  });

  it("caps entries per session, dropping oldest", () => {
    const storage = memStorage();
    const store = createSessionStore(storage, () => "id-1");
    const s = store.create(0);
    for (let i = 0; i < MAX_ENTRIES + 10; i += 1) {
      store.append(s.id, entry({ text: `m${i}`, at: i }));
    }
    const loaded = store.get(s.id)!;
    expect(loaded.entries).toHaveLength(MAX_ENTRIES);
    expect(loaded.entries[0].text).toBe("m10");
  });

  it("caps the session count, dropping the stalest", () => {
    const storage = memStorage();
    let n = 0;
    const store = createSessionStore(storage, () => `id-${n++}`);
    for (let i = 0; i < MAX_SESSIONS + 5; i += 1) {
      const s = store.create(i);
      store.append(s.id, entry({ at: i }));
    }
    const list = store.list();
    expect(list).toHaveLength(MAX_SESSIONS);
    // Newest-first, and the oldest five fell off.
    expect(list[0].updatedAt).toBe(MAX_SESSIONS + 4);
    expect(list.some((s) => s.updatedAt < 5)).toBe(false);
  });

  it("survives corrupt stored JSON by starting clean", () => {
    const storage = memStorage();
    storage.raw.set("bv.sessions.v1", "{not json");
    const store = createSessionStore(storage, () => "id-1");
    expect(store.list()).toEqual([]);
    const s = store.create(1);
    expect(store.get(s.id)).toBeDefined();
  });

  it("drops malformed rows but keeps valid ones", () => {
    const storage = memStorage();
    storage.raw.set(
      "bv.sessions.v1",
      JSON.stringify([
        { id: "good", title: "t", createdAt: 1, updatedAt: 2, entries: [entry()] },
        { nope: true },
        "junk",
      ]),
    );
    const store = createSessionStore(storage);
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("good");
  });

  it("remove() deletes a session", () => {
    const storage = memStorage();
    const store = createSessionStore(storage, () => "id-1");
    const s = store.create(1);
    store.remove(s.id);
    expect(store.get(s.id)).toBeUndefined();
  });
});

describe("storage failure handling (adversarial: quota exhaustion)", () => {
  it("a throwing setItem never propagates — the send path must not be stranded", () => {
    const store = createSessionStore(
      { getItem: () => "[]", setItem: () => { throw new Error("QuotaExceededError"); } },
      () => "id-1",
    );
    // Both writes go through save(); neither may throw.
    expect(() => store.create(1)).not.toThrow();
    expect(() => store.append("id-1", entry())).not.toThrow();
  });

  it("keeps bounded history in memory and reports quota failure without destructive retry", () => {
    let calls = 0;
    const store = createSessionStore({ getItem: () => "[]", setItem: () => { calls++; throw Error("QuotaExceededError"); } }, () => "synthetic");
    store.create(1); store.append("synthetic", entry({ text: "important" }));
    expect(calls).toBe(2); // one attempt for each distinct operation, no eviction retry
    expect(store.status().persistence).toBe("failed");
    expect(JSON.parse(store.export()).sessions[0].entries[0].text).toBe("important");
  });
  it("preserves corrupt persisted bytes while new work stays exportable", () => {
    const storage = memStorage(); storage.raw.set("bv.sessions.v1", "{damaged");
    const store = createSessionStore(storage, () => "new"); store.create(1); store.append("new", entry());
    expect(storage.raw.get("bv.sessions.v1")).toBe("{damaged");
    expect(store.status().persistence).toBe("corrupt");
    expect(JSON.parse(store.export()).recovery).toBe("{damaged");
    expect(JSON.parse(store.export()).sessions[0].entries).toHaveLength(1);
  });

  it("truncates an oversized entry instead of storing an unbounded answer", () => {
    const storage = memStorage();
    const store = createSessionStore(storage, () => "id-1");
    const s = store.create(0);
    store.append(s.id, entry({ role: "assistant", text: "x".repeat(MAX_ENTRY_CHARS * 3), at: 1 }));
    const stored = store.get(s.id)!.entries[0].text;
    expect(stored.length).toBe(MAX_ENTRY_CHARS + 1); // + the ellipsis
    expect(stored.endsWith("…")).toBe(true);
  });
});

describe("groupSessions", () => {
  it("splits by local midnight of `now`", () => {
    const now = new Date(2026, 6, 24, 15, 0, 0).getTime();
    const midnight = new Date(2026, 6, 24, 0, 0, 0).getTime();
    const mk = (id: string, updatedAt: number) => ({
      id,
      title: id,
      createdAt: 0,
      updatedAt,
      entries: [],
    });
    const { today, earlier } = groupSessions(
      [mk("a", midnight + 60_000), mk("b", midnight - 60_000), mk("c", now)],
      now,
    );
    expect(today.map((s) => s.id)).toEqual(["a", "c"]);
    expect(earlier.map((s) => s.id)).toEqual(["b"]);
  });
});


describe("account/API history partition after a failed disk clear", () => {
  const token = (userId: string, tenantId = "tenant") => `header.${Buffer.from(JSON.stringify({ userId, tenantId })).toString("base64url")}.signature`;
  it("opens distinct API/tenant/user namespaces without putting the token in a key", () => {
    const a = sessionNamespace("https://api.example.invalid/v1/", token("A"));
    expect(a).toBe(sessionNamespace("https://api.example.invalid/v1", token("A")));
    expect(a).not.toBe(sessionNamespace("https://api.example.invalid/v1", token("B")));
    expect(a).not.toBe(sessionNamespace("https://api.example.invalid/v1", token("A", "other")));
    expect(a).not.toBe(sessionNamespace("https://other.example.invalid/v1", token("A")));
    expect(a).not.toContain(token("A")); expect(sessionNamespace("https://api.example.invalid", "opaque-token")).toBeNull();
  });
  it("does not open A's disk history as B after logout deletion fails", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: () => { throw Error("storage unavailable"); } };
    vi.stubGlobal("localStorage", storage);
    try {
      const cfgA = { apiUrl: "https://api.example.invalid", token: token("A") };
      rememberHistoryIdentity(cfgA, { user: { id: "A" }, tenant: { id: "tenant" } });
      const a = resolveSessionStore(cfgA);
      const chat = a.create(1); a.append(chat.id, entry({ text: "A-only" }));
      expect(clearAllSessions()).toBe(false); expect(a.list()).toEqual([]);
      const cfgB = { apiUrl: "https://api.example.invalid", token: token("B") };
      rememberHistoryIdentity(cfgB, { user: { id: "B" }, tenant: { id: "tenant" } });
      const b = resolveSessionStore(cfgB);
      expect(b.list()).toEqual([]); expect(b.export()).not.toContain("A-only");
      const unknown = resolveSessionStore({ apiUrl: "https://api.example.invalid", token: "unrecognized" });
      expect(unknown.status().persistence).toBe("volatile"); expect(unknown.export()).not.toContain("A-only");
    } finally { vi.unstubAllGlobals(); }
  });
  it("does not overwrite partially corrupt entries when the session count stayed the same", () => {
    const storage = memStorage();
    const original = JSON.stringify([{ id: "a", title: "old", createdAt: 1, updatedAt: 1,
      entries: [entry(), { role: "user", text: 42, at: 1, mode: "cascade" }] }]);
    storage.raw.set("bv.sessions.v1", original);
    const store = createSessionStore(storage); expect(store.status().persistence).toBe("corrupt");
    store.append("a", entry({ text: "new" }));
    expect(storage.raw.get("bv.sessions.v1")).toBe(original); expect(JSON.parse(store.export()).recovery).toBe(original);
  });
});


describe("verified snapshot is required before loading a history namespace", () => {
  const token = (userId: string, n = 1) => `header.${Buffer.from(JSON.stringify({ userId, tenantId: "tenant", n })).toString("base64url")}.signature`;
  it("never treats a decoded or changed token as verified account ownership", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    vi.stubGlobal("localStorage", storage);
    try {
      const cfg = { apiUrl: "https://api.example.invalid", token: token("A") };
      const key = sessionNamespace(cfg.apiUrl, cfg.token)!; values.set(key, JSON.stringify([{ id: "A-chat", title: "A", createdAt: 1, updatedAt: 1, entries: [entry({ text: "A-only" })] }]));
      expect(resolveSessionStore(cfg).status().persistence).toBe("volatile");
      expect(rememberHistoryIdentity(cfg, { user: { id: "B" }, tenant: { id: "tenant" } })).toBe(false);
      expect(resolveSessionStore(cfg).export()).not.toContain("A-only");
      expect(rememberHistoryIdentity(cfg, { user: { id: "A" }, tenant: { id: "tenant" } })).toBe(true);
      expect(resolveSessionStore(cfg).export()).toContain("A-only");
      cfg.token = token("A", 2); // same labels, changed token has not been authenticated in this snapshot
      expect(resolveSessionStore(cfg).status().persistence).toBe("volatile");
      rememberHistoryIdentity(cfg, { user: { id: "A" }, tenant: { id: "tenant" } });
      cfg.apiUrl = "https://other.example.invalid";
      expect(resolveSessionStore(cfg).status().persistence).toBe("volatile");
    } finally { vi.unstubAllGlobals(); }
  });
  it("preserves the ownerless legacy record during an ordinary scoped logout", () => {
    const values = new Map<string, string>([["bv.sessions.v1", "LEGACY_RECOVERY_BYTES"]]);
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } });
    try {
      const cfg = { apiUrl: "https://api.example.invalid", token: token("A") };
      rememberHistoryIdentity(cfg, { user: { id: "A" }, tenant: { id: "tenant" } });
      const store = resolveSessionStore(cfg); expect(store.status().legacy).toBe(true); store.create(1);
      expect(clearAllSessions()).toBe(true); expect(values.get("bv.sessions.v1")).toBe("LEGACY_RECOVERY_BYTES");
      expect(values.has(sessionNamespace(cfg.apiUrl, cfg.token)!)).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });
});
