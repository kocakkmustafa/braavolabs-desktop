import { describe, it, expect, vi } from "vitest";
import {
  createDaemonClient,
  createTauriDaemonTransport,
  resolveDaemonTransport,
  DaemonError,
  modelOptions,
  providersNeedingModel,
  parseModelRef,
  migrateLocalSessions,
  batchImports,
  toImportConversation,
  mergeHistory,
  IMPORT_SOURCE,
  type DaemonTransport,
  type DaemonReply,
  type StreamEvent,
  type ImportConversation,
  type Conversation,
} from "../daemon-client";
import { createSessionStore, type KVStorage } from "../sessions";

type Call = { method: string; path: string; body?: unknown };

/** In-memory fake of the Rust host: canned replies per "METHOD path" and scripted streams. */
function fakeTransport(opts: {
  replies?: Record<string, DaemonReply | ((body: unknown) => DaemonReply)>;
  streams?: Record<string, { events: StreamEvent[]; reply?: DaemonReply; hang?: boolean }>;
  requestError?: string;
} = {}) {
  const calls: Call[] = [];
  const cancelled: string[] = [];
  const pending = new Map<string, (reply: DaemonReply) => void>();
  const transport: DaemonTransport = {
    status: vi.fn(async () => ({ running: true, version: "0.9.0" })),
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (opts.requestError) throw opts.requestError;
      const r = opts.replies?.[`${method} ${path}`];
      if (!r) return { status: 404, body: { error: "not found" } };
      return typeof r === "function" ? r(body) : r;
    },
    async stream(conversationId, content, onEvent) {
      calls.push({ method: "STREAM", path: conversationId, body: content });
      const script = opts.streams?.[conversationId];
      if (!script) return { status: 404, body: { error: "conversation not found" } };
      for (const e of script.events) onEvent(e);
      if (script.hang) return new Promise<DaemonReply>(resolve => pending.set(conversationId, resolve));
      return script.reply ?? { status: 200, body: null };
    },
    async cancelStream(conversationId) {
      cancelled.push(conversationId);
      const resolve = pending.get(conversationId);
      pending.delete(conversationId);
      resolve?.({ status: 499, body: { error: "cancelled", code: "cancelled" } });
      return Boolean(resolve);
    },
  };
  return { transport, calls, cancelled };
}

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: "cv_1", title: "Hello", provider: "ANTHROPIC", model: "claude-x", effort: null, companyId: null, agentId: null,
  source: null, createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z", messageCount: 0, lastMessage: null, ...over,
});

describe("daemon client — requests", () => {
  it("lists, creates, reads, patches and deletes conversations on the contract paths", async () => {
    const { transport, calls } = fakeTransport({ replies: {
      "GET /v1/conversations?limit=50&before=2026-11-01T00%3A00%3A00.000Z": { status: 200, body: { conversations: [conv()] } },
      "POST /v1/conversations": { status: 201, body: { conversation: conv() } },
      "GET /v1/conversations/cv_1": { status: 200, body: { conversation: conv(), messages: [] } },
      "PATCH /v1/conversations/cv_1": { status: 200, body: { conversation: conv({ model: "other" }) } },
      "DELETE /v1/conversations/cv_1": { status: 204, body: null },
    } });
    const client = createDaemonClient(transport);
    expect(await client.listConversations({ limit: 50, before: "2026-11-01T00:00:00.000Z" })).toHaveLength(1);
    expect((await client.createConversation({ provider: "ANTHROPIC", model: "claude-x", title: "Hello" })).id).toBe("cv_1");
    expect((await client.getConversation("cv_1")).messages).toEqual([]);
    expect((await client.updateConversation("cv_1", { model: "other" })).model).toBe("other");
    await expect(client.deleteConversation("cv_1")).resolves.toBeUndefined();
    expect(calls.map(c => c.method)).toEqual(["GET", "POST", "GET", "PATCH", "DELETE"]);
    expect(calls[1].body).toEqual({ provider: "ANTHROPIC", model: "claude-x", title: "Hello" });
  });

  it("encodes ids and search queries so the host allow-list accepts them", async () => {
    const { transport, calls } = fakeTransport({ replies: {
      "GET /v1/search?q=hello%20w%C3%B6rld%20%26%20more&limit=5": { status: 200, body: { results: [{ messageId: "m", conversationId: "cv_1", role: "user", snippet: "hello", at: "x" }] } },
    } });
    const client = createDaemonClient(transport);
    expect(await client.search("hello wörld & more", 5)).toHaveLength(1);
    await expect(client.getConversation("../companies")).rejects.toBeInstanceOf(DaemonError);
    expect(calls[1].path).toBe("/v1/conversations/..%2Fcompanies");
  });

  it("maps host transport failures to not-running / timeout", async () => {
    const down = createDaemonClient(fakeTransport({ requestError: "daemon-not-running" }).transport);
    await expect(down.models()).rejects.toMatchObject({ code: "not-running", status: 0 });
    const slow = createDaemonClient(fakeTransport({ requestError: "daemon-timeout" }).transport);
    await expect(slow.models()).rejects.toMatchObject({ code: "timeout" });
  });

  it("status never throws (a failed probe means not running)", async () => {
    const { transport } = fakeTransport();
    transport.status = async () => { throw new Error("ipc gone"); };
    expect(await createDaemonClient(transport).status()).toEqual({ running: false, reason: "daemon-not-running" });
  });

  it("abort posts to the abort route", async () => {
    const { transport, calls } = fakeTransport({ replies: { "POST /v1/conversations/cv_1/abort": { status: 200, body: { aborted: true } } } });
    expect(await createDaemonClient(transport).abort("cv_1")).toBe(true);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/conversations/cv_1/abort" });
  });
});

describe("daemon client — streaming a turn", () => {
  it("accumulates deltas and reports usage + stop reason", async () => {
    const { transport } = fakeTransport({ streams: { cv_1: { events: [
      { event: "message", data: { id: "ms_u", role: "user" } },
      { event: "reasoning", data: { text: "thinking" } },
      { event: "delta", data: { text: "Hel" } },
      { event: "delta", data: { text: "lo" } },
      { event: "usage", data: { inputTokens: 12, outputTokens: 3 } },
      { event: "done", data: { messageId: "ms_a", stopReason: "end_turn" } },
    ] } } });
    const deltas: string[] = []; const reasoning: string[] = []; let userId = "";
    const result = await createDaemonClient(transport).sendMessage("cv_1", "hi", {
      onUserMessage: id => { userId = id; }, onDelta: (_t, full) => deltas.push(full), onReasoning: t => reasoning.push(t),
    });
    expect(userId).toBe("ms_u");
    expect(deltas).toEqual(["Hel", "Hello"]);
    expect(reasoning).toEqual(["thinking"]);
    expect(result).toEqual({ text: "Hello", messageId: "ms_a", stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 3 } });
  });

  it("rejects a second send while streaming with busy (409)", async () => {
    const { transport } = fakeTransport({ streams: { cv_1: { events: [], reply: { status: 409, body: { error: "a turn is already streaming", code: "busy" } } } } });
    await expect(createDaemonClient(transport).sendMessage("cv_1", "again")).rejects.toMatchObject({ status: 409, code: "busy" });
  });

  it("surfaces missing-key (400) with the daemon's own hint, before any stream", async () => {
    const onDelta = vi.fn();
    const { transport } = fakeTransport({ streams: { cv_1: { events: [], reply: { status: 400, body: { error: "no anthropic key; run: braavo keys add anthropic", code: "missing-key" } } } } });
    const error = await createDaemonClient(transport).sendMessage("cv_1", "hi", { onDelta }).catch(e => e);
    expect(error).toBeInstanceOf(DaemonError);
    expect(error).toMatchObject({ status: 400, code: "missing-key", message: "no anthropic key; run: braavo keys add anthropic" });
    expect(onDelta).not.toHaveBeenCalled();
  });

  it("keeps the partial answer when a provider error arrives mid-stream", async () => {
    const { transport } = fakeTransport({ streams: { cv_1: { events: [
      { event: "delta", data: { text: "partial" } },
      { event: "error", data: { error: "provider failed (key redacted)", code: "provider" } },
    ] } } });
    const result = await createDaemonClient(transport).sendMessage("cv_1", "hi");
    expect(result.text).toBe("partial");
    expect(result.error).toMatchObject({ code: "provider", message: "provider failed (key redacted)" });
  });

  it("abort: the daemon's done(aborted) ends the turn with the partial text", async () => {
    const { transport, calls } = fakeTransport({
      replies: { "POST /v1/conversations/cv_1/abort": { status: 200, body: { aborted: true } } },
      streams: { cv_1: { events: [{ event: "delta", data: { text: "half" } }, { event: "done", data: { messageId: "ms_a", stopReason: "aborted" } }] } },
    });
    const client = createDaemonClient(transport);
    const result = await client.sendMessage("cv_1", "hi");
    expect(await client.abort("cv_1")).toBe(true);
    expect(result).toMatchObject({ text: "half", stopReason: "aborted" });
    expect(calls.map(c => c.method)).toEqual(["STREAM", "POST"]);
  });

  it("cancelStream (host disconnect) resolves a hanging turn as aborted", async () => {
    const { transport, cancelled } = fakeTransport({ streams: { cv_1: { events: [{ event: "delta", data: { text: "so far" } }], hang: true } } });
    const client = createDaemonClient(transport);
    const turn = client.sendMessage("cv_1", "hi");
    await Promise.resolve();
    expect(await client.cancelStream("cv_1")).toBe(true);
    expect(await turn).toEqual({ text: "so far", stopReason: "aborted" });
    expect(cancelled).toEqual(["cv_1"]);
  });

  it("refuses empty or oversize content without calling the host", async () => {
    const { transport, calls } = fakeTransport();
    const client = createDaemonClient(transport);
    await expect(client.sendMessage("cv_1", "   ")).rejects.toMatchObject({ code: "invalid" });
    await expect(client.sendMessage("cv_1", "x".repeat(100_001))).rejects.toMatchObject({ code: "invalid" });
    expect(calls).toEqual([]);
  });
});

describe("model choice from the user's own keys (K3)", () => {
  const models = {
    providers: [{ id: "ANTHROPIC", hasKey: true, local: false }, { id: "OLLAMA", hasKey: false, local: true }, { id: "MISTRAL", hasKey: true, local: false }],
    local: { OLLAMA: ["llama3.2", "qwen3"] },
    suggestions: {
      strong: { status: "ok", provider: "ANTHROPIC", model: "claude-strong" },
      mid: { status: "ok", provider: "OLLAMA", model: "llama3.2" },
      light: { status: "ok", provider: "OLLAMA", model: "llama3.2" },
      analysis: { status: "model-required", provider: "MISTRAL" },
    },
  } as const;
  it("puts the mid suggestion first, dedupes, then lists local models", () => {
    expect(modelOptions(models as any).map(o => `${o.provider}/${o.model}`)).toEqual(["OLLAMA/llama3.2", "ANTHROPIC/claude-strong", "OLLAMA/qwen3"]);
  });
  it("lists providers that need a typed model and parses PROVIDER/model", () => {
    expect(providersNeedingModel(models as any)).toEqual(["MISTRAL"]);
    expect(parseModelRef(" mistral/mistral-large-latest ")).toEqual({ provider: "MISTRAL", model: "mistral-large-latest" });
    expect(parseModelRef("openrouter/meta/llama-3")).toEqual({ provider: "OPENROUTER", model: "meta/llama-3" });
    for (const bad of ["", "nomodel", "/m", "P/", "a b/c"]) expect(parseModelRef(bad)).toBeNull();
  });
  it("no keys and no local models means no options", () => {
    expect(modelOptions({ providers: [], local: {}, suggestions: { mid: { status: "setup-required" } } })).toEqual([]);
  });
});

function memStorage(): KVStorage & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return { raw, getItem: k => raw.get(k) ?? null, setItem: (k, v) => void raw.set(k, v) };
}

function seededStore(storage = memStorage()) {
  let n = 0;
  const store = createSessionStore(storage, () => `s${++n}`, { key: "bv.sessions.v2:test" });
  const a = store.create(1000);
  store.append(a.id, { role: "user", mode: "local", text: "first question", at: 1001 });
  store.append(a.id, { role: "assistant", mode: "local", text: "first answer", at: 1002 });
  store.append(a.id, { role: "error", mode: "local", text: "transient error", at: 1003 });
  const b = store.create(2000);
  store.append(b.id, { role: "user", mode: "direct", text: "second", at: 2001 });
  const empty = store.create(3000);
  store.append(empty.id, { role: "error", mode: "local", text: "only an error", at: 3001 });
  return { store, storage };
}

/** A fake daemon import endpoint that is idempotent on (source, externalId). */
function idempotentImporter() {
  const seen = new Set<string>();
  const bodies: { source: string; conversations: ImportConversation[] }[] = [];
  return {
    bodies,
    seen,
    async importConversations(source: string, conversations: ImportConversation[]) {
      bodies.push({ source, conversations });
      let imported = 0; let skipped = 0;
      for (const c of conversations) {
        const key = `${source}\u0000${c.externalId}`;
        if (seen.has(key)) skipped += 1; else { seen.add(key); imported += 1; }
      }
      return { imported, skipped, ids: conversations.map(c => `cv_${c.externalId}`) };
    },
  };
}

describe("localStorage → daemon migration", () => {
  it("maps a session to the import shape (user/assistant only, ISO times, stable externalId)", () => {
    const { store } = seededStore();
    const c = toImportConversation(store.get("s1")!)!;
    expect(c).toEqual({
      externalId: "s1", title: "first question", createdAt: new Date(1000).toISOString(),
      messages: [
        { role: "user", content: "first question", at: new Date(1001).toISOString() },
        { role: "assistant", content: "first answer", at: new Date(1002).toISOString() },
      ],
    });
    expect(toImportConversation(store.get("s3")!)).toBeNull();
  });

  it("imports with the desktop source and clears local copies only after success", async () => {
    const { store, storage } = seededStore();
    const daemon = idempotentImporter();
    const report = await migrateLocalSessions(daemon, store);
    expect(report).toEqual({ attempted: 2, imported: 2, skipped: 0, cleared: 2, failed: 0, empty: 1 });
    expect(daemon.bodies[0].source).toBe(IMPORT_SOURCE);
    expect(daemon.bodies[0].source).toBe("desktop-localstorage");
    expect(store.list().map(s => s.id)).toEqual(["s3"]);
    expect(JSON.parse(storage.raw.get("bv.sessions.v2:test")!).map((s: { id: string }) => s.id)).toEqual(["s3"]);
  });

  it("keeps everything local when the import call fails, and a re-run is idempotent", async () => {
    const { store } = seededStore();
    const failing = { importConversations: vi.fn(async () => { throw new DaemonError(0, "not-running", "daemon-not-running"); }) };
    expect(await migrateLocalSessions(failing, store)).toMatchObject({ attempted: 2, cleared: 0, failed: 2 });
    expect(store.list()).toHaveLength(3);

    // Crash between a successful import and the local clear: the daemon already
    // holds the conversations; running again must skip, not duplicate, then clear.
    const daemon = idempotentImporter();
    for (const s of store.list()) { const c = toImportConversation(s); if (c) daemon.seen.add(`${IMPORT_SOURCE}\u0000${c.externalId}`); }
    const report = await migrateLocalSessions(daemon, store);
    expect(report).toMatchObject({ imported: 0, skipped: 2, cleared: 2, failed: 0 });
    expect(daemon.seen.size).toBe(2);
    expect(store.list().map(s => s.id)).toEqual(["s3"]);
  });

  it("leaves the session open in the chat pane alone", async () => {
    const { store } = seededStore();
    const daemon = idempotentImporter();
    expect(await migrateLocalSessions(daemon, store, { exclude: ["s1"] })).toMatchObject({ attempted: 1, cleared: 1 });
    expect(store.list().map(s => s.id).sort()).toEqual(["s1", "s3"]);
  });

  it("does not clear when the daemon confirms fewer conversations than sent", async () => {
    const { store } = seededStore();
    const short = { importConversations: async () => ({ imported: 1, skipped: 0, ids: ["cv"] }) };
    expect(await migrateLocalSessions(short, store)).toMatchObject({ cleared: 0, failed: 2 });
    expect(store.list()).toHaveLength(3);
  });

  it("never migrates a volatile (unverified account) or corrupt store", async () => {
    const daemon = idempotentImporter();
    const volatile = createSessionStore(memStorage(), () => "v1", { volatile: true });
    volatile.append(volatile.create().id, { role: "user", mode: "local", text: "x", at: 1 });
    expect(await migrateLocalSessions(daemon, volatile)).toMatchObject({ attempted: 0 });
    const corruptStorage = memStorage(); corruptStorage.raw.set("bv.sessions.v2:c", "{not json");
    const corrupt = createSessionStore(corruptStorage, undefined, { key: "bv.sessions.v2:c" });
    expect(await migrateLocalSessions(daemon, corrupt)).toMatchObject({ attempted: 0 });
    expect(daemon.bodies).toEqual([]);
    expect(corruptStorage.raw.get("bv.sessions.v2:c")).toBe("{not json");
  });

  it("batches under the daemon's body limit; a failed batch only keeps its own sessions", async () => {
    const big = (id: string): ImportConversation => ({ externalId: id, messages: [{ role: "user", content: "x".repeat(120 * 1024) }] });
    expect(batchImports([big("a"), big("b"), big("c")]).map(b => b.map(c => c.externalId))).toEqual([["a"], ["b"], ["c"]]);
    const small = (id: string): ImportConversation => ({ externalId: id, messages: [{ role: "user", content: "hi" }] });
    expect(batchImports([small("a"), small("b")])).toHaveLength(1);

    const storage = memStorage();
    let n = 0;
    const store = createSessionStore(storage, () => `b${++n}`, { key: "bv.sessions.v2:b" });
    for (let i = 0; i < 3; i++) {
      const s = store.create(i);
      for (let j = 0; j < 40; j++) store.append(s.id, { role: "user", mode: "local", text: "y".repeat(3000), at: i * 100 + j });
    }
    let call = 0;
    const flaky = { importConversations: async (_s: string, cs: ImportConversation[]) => {
      call += 1;
      if (call === 2) throw new Error("413");
      return { imported: cs.length, skipped: 0, ids: [] };
    } };
    const report = await migrateLocalSessions(flaky, store);
    expect(report.failed).toBeGreaterThan(0);
    expect(report.cleared + report.failed).toBe(3);
    expect(store.list()).toHaveLength(report.failed);
  });
});

describe("sidebar history", () => {
  it("merges daemon conversations with remaining local sessions, newest first", () => {
    const items = mergeHistory(
      [conv({ id: "cv_old", updatedAt: new Date(1000).toISOString() }), conv({ id: "cv_new", updatedAt: new Date(5000).toISOString() })],
      [{ id: "s1", title: "local", createdAt: 0, updatedAt: 3000, entries: [] }],
    );
    expect(items.map(i => `${i.kind}:${i.id}`)).toEqual(["daemon:cv_new", "local:s1", "daemon:cv_old"]);
  });
});

describe("Tauri transport", () => {
  it("calls the host commands and forwards channel frames; never passes a URL or token", async () => {
    const invoked: { cmd: string; args?: Record<string, unknown> }[] = [];
    class FakeChannel { onmessage: ((m: unknown) => void) | null = null; }
    const invoke = async (cmd: string, args?: Record<string, unknown>) => {
      invoked.push({ cmd, args });
      if (cmd === "daemon_send_message") {
        const ch = args!.onEvent as FakeChannel;
        ch.onmessage?.({ event: "delta", data: { text: "x" } });
        ch.onmessage?.("garbage");
        return { status: 200, body: null };
      }
      if (cmd === "daemon_stream_cancel") return true;
      if (cmd === "daemon_status") return { running: false, reason: "daemon-not-running" };
      return { status: 200, body: { conversations: [] } };
    };
    const transport = createTauriDaemonTransport(invoke, FakeChannel);
    const events: StreamEvent[] = [];
    expect(await transport.stream("cv_1", "hi", e => events.push(e))).toEqual({ status: 200, body: null });
    expect(events).toEqual([{ event: "delta", data: { text: "x" } }]);
    await transport.request("GET", "/v1/conversations");
    expect(await transport.cancelStream("cv_1")).toBe(true);
    expect(await transport.status()).toEqual({ running: false, reason: "daemon-not-running" });
    expect(invoked.map(i => i.cmd)).toEqual(["daemon_send_message", "daemon_request", "daemon_stream_cancel", "daemon_status"]);
    expect(invoked[1].args).toEqual({ method: "GET", path: "/v1/conversations", body: null });
    for (const i of invoked) expect(JSON.stringify(i.args ?? {})).not.toMatch(/token|https?:/i);
  });

  it("is unavailable outside Tauri", () => {
    expect(resolveDaemonTransport()).toBeNull();
  });
});
