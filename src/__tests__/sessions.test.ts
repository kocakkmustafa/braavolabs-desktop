import { describe, it, expect } from "vitest";
import {
  createSessionStore,
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

  it("retries with a smaller history when the full write fails", () => {
    let calls = 0;
    const written: string[] = [];
    const store = createSessionStore(
      {
        getItem: () =>
          JSON.stringify(
            Array.from({ length: MAX_SESSIONS }, (_, i) => ({
              id: `s${i}`,
              title: "t",
              createdAt: i,
              updatedAt: i,
              entries: [],
            })),
          ),
        setItem: (_k, v) => {
          calls += 1;
          if (calls === 1) throw new Error("QuotaExceededError");
          written.push(v);
        },
      },
      () => "new",
    );
    store.create(999);
    expect(calls).toBe(2); // full write, then the evicted retry
    expect(JSON.parse(written[0]).length).toBeLessThan(MAX_SESSIONS);
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
