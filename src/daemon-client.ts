/**
 * Local daemon chat client (plan 1.3; contract: CLI docs/DAEMON-CHAT.md).
 *
 * The `braavo daemon` owns conversations (SQLite) and calls the user's own
 * provider key or local model. It refuses any request with an `Origin` header,
 * so this webview never fetches it: the Rust host (src-tauri/src/daemon.rs)
 * reads the port + bearer token at call time and forwards allow-listed chat
 * routes. Nothing here ever sees the token or a provider key.
 *
 * Pure and transport-injected like keyvault/spawn: the Tauri transport is
 * resolved at runtime, tests inject a fake.
 */
import type { ChatSession, SessionStore } from "./sessions";

export type Effort = "none" | "low" | "medium" | "high" | "max";

export interface Conversation {
  id: string;
  title: string;
  provider: string | null;
  model: string | null;
  effort: string | null;
  companyId: string | null;
  agentId: string | null;
  source: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessage: string | null;
}

export interface DaemonMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  at: string;
  stopReason?: string | null;
}

export type ModelSuggestion =
  | { status: "ok"; provider: string; model: string }
  | { status: "model-required"; provider: string }
  | { status: "setup-required" };

export interface DaemonModels {
  providers: { id: string; hasKey: boolean; local: boolean }[];
  local: { OLLAMA?: string[]; LMSTUDIO?: string[] };
  suggestions: Partial<Record<"strong" | "mid" | "light" | "analysis", ModelSuggestion>>;
}

export interface ImportConversation {
  externalId: string;
  title?: string;
  provider?: string;
  model?: string;
  createdAt?: string;
  messages: { role: "user" | "assistant"; content: string; at?: string }[];
}

export interface ImportResult { imported: number; skipped: number; ids: string[] }

export interface SearchResult {
  messageId: string;
  conversationId: string;
  role: "user" | "assistant";
  snippet: string;
  at: string;
}

/** One SSE frame as the host forwards it. */
export interface StreamEvent { event: string; data: unknown }

export interface DaemonReply { status: number; body: unknown }

export interface DaemonStatus { running: boolean; version?: string; reason?: string }

/** What the Rust host exposes. Fakes implement the same shape in tests. */
export interface DaemonTransport {
  status(): Promise<DaemonStatus>;
  request(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<DaemonReply>;
  /** Streams one turn; resolves when the stream ends or with the error reply that replaced it. */
  stream(conversationId: string, content: string, onEvent: (event: StreamEvent) => void): Promise<DaemonReply>;
  /** Drop the connection for a turn (the daemon aborts on disconnect). */
  cancelStream(conversationId: string): Promise<boolean>;
}

/** Contract error codes plus host-side transport failures. */
export type DaemonErrorCode =
  | "missing-key" | "model-required" | "provider" | "busy" | "budget"
  | "not-running" | "unauthorized" | "not-found" | "invalid" | "timeout" | "unknown";

export class DaemonError extends Error {
  constructor(readonly status: number, readonly code: DaemonErrorCode, message: string) {
    super(message);
    this.name = "DaemonError";
  }
}

const KNOWN_CODES = new Set<DaemonErrorCode>(["missing-key", "model-required", "provider", "busy", "budget"]);

export function errorFromReply(reply: DaemonReply): DaemonError {
  const body = (reply.body && typeof reply.body === "object" ? reply.body : {}) as { error?: unknown; code?: unknown };
  const message = typeof body.error === "string" ? body.error.slice(0, 500) : `daemon error ${reply.status}`;
  const raw = typeof body.code === "string" ? body.code : "";
  const code: DaemonErrorCode = KNOWN_CODES.has(raw as DaemonErrorCode) ? raw as DaemonErrorCode
    : reply.status === 401 ? "unauthorized"
    : reply.status === 404 ? "not-found"
    : reply.status === 409 ? "busy"
    : reply.status === 400 || reply.status === 413 ? "invalid"
    : "unknown";
  return new DaemonError(reply.status, code, message);
}

/** Host failures arrive as plain strings (see daemon.rs ERR_*). */
export function errorFromHost(error: unknown): DaemonError {
  if (error instanceof DaemonError) return error;
  const text = String(error instanceof Error ? error.message : error);
  if (text.startsWith("daemon-not-running")) return new DaemonError(0, "not-running", text);
  if (text.startsWith("daemon-timeout")) return new DaemonError(0, "timeout", text);
  if (text.startsWith("daemon-route-refused")) return new DaemonError(0, "invalid", text);
  return new DaemonError(0, "unknown", text.slice(0, 500));
}

export interface TurnHandlers {
  onUserMessage?(id: string): void;
  onDelta?(text: string, full: string): void;
  onReasoning?(text: string): void;
}

export interface TurnResult {
  text: string;
  messageId?: string;
  stopReason?: string;
  usage?: { inputTokens: number; outputTokens: number };
  /** `event: error` mid-stream. The partial answer is still stored by the daemon. */
  error?: DaemonError;
}

const MAX_CONTENT_CHARS = 100_000;

export function createDaemonClient(transport: DaemonTransport) {
  const call = async <T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> => {
    let reply: DaemonReply;
    try { reply = await transport.request(method, path, body); }
    catch (error) { throw errorFromHost(error); }
    if (reply.status < 200 || reply.status >= 300) throw errorFromReply(reply);
    return reply.body as T;
  };
  const id = (value: string) => encodeURIComponent(value);

  return {
    status: () => transport.status().catch((): DaemonStatus => ({ running: false, reason: "daemon-not-running" })),
    models: () => call<DaemonModels>("GET", "/v1/models"),
    async listConversations(opts: { limit?: number; before?: string } = {}): Promise<Conversation[]> {
      const query = new URLSearchParams();
      if (opts.limit !== undefined) query.set("limit", String(opts.limit));
      if (opts.before) query.set("before", opts.before);
      const qs = query.toString();
      return (await call<{ conversations: Conversation[] }>("GET", `/v1/conversations${qs ? `?${qs.replaceAll("+", "%20")}` : ""}`)).conversations;
    },
    async createConversation(input: { title?: string; provider: string; model: string; effort?: Effort }): Promise<Conversation> {
      return (await call<{ conversation: Conversation }>("POST", "/v1/conversations", input)).conversation;
    },
    getConversation: (conversationId: string) =>
      call<{ conversation: Conversation; messages: DaemonMessage[] }>("GET", `/v1/conversations/${id(conversationId)}`),
    async updateConversation(conversationId: string, patch: { title?: string; provider?: string; model?: string; effort?: Effort }): Promise<Conversation> {
      return (await call<{ conversation: Conversation }>("PATCH", `/v1/conversations/${id(conversationId)}`, patch)).conversation;
    },
    async deleteConversation(conversationId: string): Promise<void> {
      await call<unknown>("DELETE", `/v1/conversations/${id(conversationId)}`);
    },
    async abort(conversationId: string): Promise<boolean> {
      return (await call<{ aborted: boolean }>("POST", `/v1/conversations/${id(conversationId)}/abort`)).aborted;
    },
    cancelStream: (conversationId: string) => transport.cancelStream(conversationId).catch(() => false),
    importConversations: (source: string, conversations: ImportConversation[]) =>
      call<ImportResult>("POST", "/v1/conversations/import", { source, conversations }),
    async search(q: string, limit = 20): Promise<SearchResult[]> {
      const qs = new URLSearchParams({ q, limit: String(limit) }).toString().replaceAll("+", "%20");
      return (await call<{ results: SearchResult[] }>("GET", `/v1/search?${qs}`)).results;
    },
    /**
     * Stream one turn. Rejects (DaemonError) when the daemon refuses before a
     * stream starts — 409 busy, 400 missing-key/model-required. A mid-stream
     * `event: error` resolves with `error` set and the partial text.
     */
    async sendMessage(conversationId: string, content: string, handlers: TurnHandlers = {}): Promise<TurnResult> {
      if (!content.trim() || content.length > MAX_CONTENT_CHARS) throw new DaemonError(0, "invalid", "message must be 1–100000 characters");
      const result: TurnResult = { text: "" };
      const onEvent = ({ event, data }: StreamEvent) => {
        const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
        switch (event) {
          case "message":
            if (typeof d.id === "string") handlers.onUserMessage?.(d.id);
            break;
          case "delta":
            if (typeof d.text === "string") { result.text += d.text; handlers.onDelta?.(d.text, result.text); }
            break;
          case "reasoning":
            if (typeof d.text === "string") handlers.onReasoning?.(d.text);
            break;
          case "usage":
            if (typeof d.inputTokens === "number" && typeof d.outputTokens === "number") result.usage = { inputTokens: d.inputTokens, outputTokens: d.outputTokens };
            break;
          case "done":
            if (typeof d.messageId === "string") result.messageId = d.messageId;
            if (typeof d.stopReason === "string") result.stopReason = d.stopReason;
            break;
          case "error":
            result.error = errorFromReply({ status: 200, body: d });
            break;
        }
      };
      let reply: DaemonReply;
      try { reply = await transport.stream(conversationId, content, onEvent); }
      catch (error) { throw errorFromHost(error); }
      if (reply.status === 499) return { ...result, stopReason: result.stopReason ?? "aborted" };
      if (reply.status < 200 || reply.status >= 300) throw errorFromReply(reply);
      return result;
    },
  };
}

export type DaemonClient = ReturnType<typeof createDaemonClient>;

// ── model choice (K3: suggestions come from the user's own keys/local models) ──

export interface ModelOption { provider: string; model: string; label: string }

/** Selectable models: ok suggestions first (deduped), then local models. */
export function modelOptions(models: DaemonModels): ModelOption[] {
  const out: ModelOption[] = [];
  const seen = new Set<string>();
  const add = (provider: string, model: string, tier?: string) => {
    const key = `${provider}/${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ provider, model, label: tier ? `${key} · ${tier}` : key });
  };
  for (const tier of ["mid", "strong", "light", "analysis"] as const) {
    const s = models.suggestions?.[tier];
    if (s?.status === "ok") add(s.provider, s.model, tier);
  }
  for (const provider of ["OLLAMA", "LMSTUDIO"] as const) {
    for (const model of models.local?.[provider] ?? []) add(provider, model);
  }
  return out;
}

/** Providers with a key but no known model: the user types one (`PROVIDER/model`). */
export function providersNeedingModel(models: DaemonModels): string[] {
  const out = new Set<string>();
  for (const s of Object.values(models.suggestions ?? {})) if (s?.status === "model-required") out.add(s.provider);
  return [...out];
}

/** Parse a typed `PROVIDER/model` override. Provider is upper-cased like the daemon's ids. */
export function parseModelRef(raw: string): { provider: string; model: string } | null {
  const text = raw.trim();
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) return null;
  const provider = text.slice(0, slash).trim().toUpperCase();
  const model = text.slice(slash + 1).trim();
  if (!/^[A-Z][A-Z0-9_]{1,19}$/.test(provider) || !model || model.length > 200) return null;
  return { provider, model };
}

// ── one-time localStorage → daemon migration ──────────────────────────────────

export const IMPORT_SOURCE = "desktop-localstorage";
/** The daemon caps request bodies (256 KiB today); stay under it per batch. */
export const IMPORT_BATCH_BYTES = 200 * 1024;

export function toImportConversation(session: ChatSession): ImportConversation | null {
  const messages = session.entries
    .filter(e => e.role === "user" || e.role === "assistant")
    .filter(e => e.text.trim())
    .map(e => ({ role: e.role as "user" | "assistant", content: e.text, at: new Date(e.at).toISOString() }));
  if (!messages.length) return null;
  return {
    externalId: session.id,
    ...(session.title ? { title: session.title } : {}),
    createdAt: new Date(session.createdAt || session.entries[0]?.at || Date.now()).toISOString(),
    messages,
  };
}

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** Split into batches under the byte budget; an oversize conversation travels alone. */
export function batchImports(conversations: ImportConversation[], budget = IMPORT_BATCH_BYTES): ImportConversation[][] {
  const batches: ImportConversation[][] = [];
  let current: ImportConversation[] = [];
  let size = 0;
  for (const c of conversations) {
    const n = byteLength(c);
    if (current.length && size + n > budget) { batches.push(current); current = []; size = 0; }
    current.push(c);
    size += n;
  }
  if (current.length) batches.push(current);
  return batches;
}

export interface MigrationReport {
  attempted: number;
  imported: number;
  skipped: number;
  /** Sessions removed from localStorage after the daemon confirmed them. */
  cleared: number;
  /** Sessions kept locally because their batch failed. */
  failed: number;
  /** Sessions with nothing to import (only error lines / empty). Left untouched. */
  empty: number;
}

/**
 * Import the local transcript into the daemon, then clear each session ONLY
 * after the daemon confirmed its batch. Idempotent on (source, externalId), so
 * a crash between import and clear is repaired by simply running again.
 *
 * Only a normally persisted store is migrated: a corrupt record is preserved
 * for recovery and a volatile (unverified account) store has no owner.
 */
export async function migrateLocalSessions(
  client: Pick<DaemonClient, "importConversations">,
  store: SessionStore,
  options: { exclude?: readonly string[] } = {},
): Promise<MigrationReport> {
  const report: MigrationReport = { attempted: 0, imported: 0, skipped: 0, cleared: 0, failed: 0, empty: 0 };
  if (store.status().persistence !== "saved") return report;
  // The session open in the chat pane keeps receiving entries; it moves on a later launch.
  const exclude = new Set(options.exclude ?? []);
  const sessions = store.list().filter(s => !exclude.has(s.id));
  const payload: ImportConversation[] = [];
  for (const s of sessions) {
    const c = toImportConversation(s);
    if (c) payload.push(c); else report.empty += 1;
  }
  report.attempted = payload.length;
  for (const batch of batchImports(payload)) {
    let result: ImportResult;
    try { result = await client.importConversations(IMPORT_SOURCE, batch); }
    catch { report.failed += batch.length; continue; }
    const confirmed = (result?.imported ?? 0) + (result?.skipped ?? 0);
    if (!Number.isFinite(confirmed) || confirmed < batch.length) { report.failed += batch.length; continue; }
    report.imported += result.imported;
    report.skipped += result.skipped;
    for (const c of batch) { store.remove(c.externalId); report.cleared += 1; }
  }
  return report;
}

// ── sidebar: daemon conversations + whatever is still local ───────────────────

export type HistoryItem =
  | { kind: "daemon"; id: string; title: string; updatedAt: number }
  | { kind: "local"; id: string; title: string; updatedAt: number };

export function mergeHistory(conversations: Conversation[], local: ChatSession[]): HistoryItem[] {
  const items: HistoryItem[] = [
    ...conversations.map(c => ({ kind: "daemon" as const, id: c.id, title: c.title, updatedAt: Date.parse(c.updatedAt) || 0 })),
    ...local.map(s => ({ kind: "local" as const, id: s.id, title: s.title, updatedAt: s.updatedAt })),
  ];
  return items.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── Tauri transport ───────────────────────────────────────────────────────────

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type ChannelCtor = new () => { onmessage: ((message: unknown) => void) | null };

export function createTauriDaemonTransport(invoke: Invoke, Channel: ChannelCtor): DaemonTransport {
  return {
    async status() { return (await invoke("daemon_status")) as DaemonStatus; },
    async request(method, path, body) {
      return (await invoke("daemon_request", { method, path, body: body ?? null })) as DaemonReply;
    },
    async stream(conversationId, content, onEvent) {
      const channel = new Channel();
      channel.onmessage = (message) => {
        const m = message as StreamEvent;
        if (m && typeof m.event === "string") onEvent(m);
      };
      return (await invoke("daemon_send_message", { conversationId, content, onEvent: channel })) as DaemonReply;
    },
    async cancelStream(conversationId) {
      return Boolean(await invoke("daemon_stream_cancel", { conversationId }));
    },
  };
}

/** Tauri at runtime; null in a plain browser preview / tests (daemon chat unavailable). */
export function resolveDaemonTransport(): DaemonTransport | null {
  const core = (globalThis as any)?.__TAURI__?.core;
  if (typeof core?.invoke !== "function" || typeof core?.Channel !== "function") return null;
  return createTauriDaemonTransport(core.invoke as Invoke, core.Channel as ChannelCtor);
}
