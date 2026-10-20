/**
 * MCP client — desktop adapter. A port of the CLI's forge/mcp.ts dependency-free
 * Model Context Protocol stdio client into the Tauri webview context, with one
 * hard delivery constraint the CLI does not have: a webview CANNOT spawn a child
 * process — only the Rust host can. So this module has two backends behind ONE
 * interface, exactly like keyvault.ts / spawn.ts / governance.ts:
 *
 *   • createTauriMcpBridge — the REAL runtime. Server config + the JSON-RPC
 *     stdio session (spawn, initialize handshake, tools/list, tools/call,
 *     partial-line buffering, timeout→kill) all live in the Rust host
 *     (src-tauri/src/lib.rs). This module is a thin `invoke` adapter.
 *   • createMemoryMcpBridge — the dev/test analogue, the exact behavioural
 *     mirror. It runs the SAME JSON-RPC framing here in pure TypeScript over an
 *     INJECTED spawn (McpSpawn), so the handshake ordering, partial-line
 *     buffering, timeout→kill and "stderr is never parsed" contract are all
 *     unit-testable headlessly with a mock stdio server.
 *
 * THE MOAT APPLIES TO MCP TOO — to discovery as much as to the call. Starting
 * an MCP server (even just to ask it tools/list) is a native process launch
 * driven by a stored, mutable config entry, so BOTH listTools and callTool pass
 * discovery uses a definition-bound grant; tool calls use host prepare → native
 * approval → token-only execute. The host freezes all invocation fields before
 * approval, with a 120-second lifetime and registry/credential/revoke epochs. A
 * one-time token → the bridge consumes it EXACTLY ONCE — checked against the
 * server's CURRENT resolved command+args, not just its name — before anything
 * is spawned, so editing a server's definition between approval and use
 * invalidates the token instead of silently running the swapped-in command.
 * Memory backend consumes via the injected Governance; the Tauri backend hands
 * the token to the Rust host, which consumes it host-side (a compromised
 * webview cannot forge a host token) — the same contract as `governed_command`.
 *
 * MCP stdio framing is line-delimited JSON-RPC 2.0: one JSON object per line,
 * terminated by "\n". Config lives as { name: {command, args[]} } with args as a
 * discrete ARRAY (never a joined string) — so there is no shell and no injection
 * seam when the server is later spawned. stderr is surfaced verbatim for debug
 * but NEVER parsed as JSON-RPC — only stdout carries the protocol.
 */
import type { ActionDetail, Governance, GateResult } from "./governance";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Tauri v2 with `withGlobalTauri:true` exposes window.__TAURI__.core.invoke. */
function tauriInvoke(): Invoke | null {
  const g = globalThis as any;
  const inv = g?.__TAURI__?.core?.invoke;
  return typeof inv === "function" ? (inv as Invoke) : null;
}

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const APP_VERSION = "0.1.0";
export const DEFAULT_MCP_TIMEOUT_MS = 10_000;

const CLIENT_INFO = { name: "braavolabs", version: APP_VERSION };

// ── config (arg-array preserving) ────────────────────────────────────────────

/** A registered MCP server: its launch command and discrete argument array. */
export interface McpServerDef {
  command: string;
  args: string[];
}
export type McpConfig = Record<string, McpServerDef>;

/**
 * Add/replace a server. Args are stored as a discrete ARRAY — string-joining
 * here would reintroduce a shell-injection seam at spawn time.
 */
export function addMcpServer(cfg: McpConfig, name: string, command: string, args: string[]): McpConfig {
  return { ...cfg, [name]: { command, args: [...args] } };
}

export function removeMcpServer(cfg: McpConfig, name: string): McpConfig {
  const next = { ...cfg };
  delete next[name];
  return next;
}

/**
 * Split a whitespace-separated args string from the "add server" form into a
 * discrete array (simple double-quote grouping supported). Pure + testable; the
 * result is stored verbatim as the arg ARRAY, never re-joined into a shell line.
 */
export function parseArgsInput(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) out.push(m[1] ?? m[2]);
  return out;
}

/** Parse the tool-call args JSON. Empty input → {}. Non-object → error. */
export type ParsedToolArgs = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };
export function parseToolArgs(input: string): ParsedToolArgs {
  const s = input.trim();
  if (!s) return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return { ok: false, error: "arguments must be valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "arguments must be a JSON object" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

function snapshotToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const check = (v: unknown, depth: number): boolean => {
    if (depth > 32) return false;
    if (v === null || typeof v === "string" || typeof v === "boolean") return true;
    if (typeof v === "number") return Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v));
    if (Array.isArray(v)) return v.every(x => check(x, depth + 1));
    if (v && typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) return Object.values(v).every(x => check(x, depth + 1));
    return false;
  };
  if (!args || Array.isArray(args) || !check(args, 0)) throw new McpError("arguments require a bounded JSON object with safe numbers");
  const text = JSON.stringify(args);
  if (new TextEncoder().encode(text).length > 4096) throw new McpError("arguments exceed the native preview limit");
  return JSON.parse(text) as Record<string, unknown>;
}

// ── errors ───────────────────────────────────────────────────────────────────

export class McpError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

export class McpTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`MCP request "${method}" timed out after ${ms}ms`);
    this.name = "McpTimeoutError";
  }
}

/** Thrown when a `tools/call` is attempted without a valid, consumable gate token. */
export class McpGateError extends Error {
  constructor(message = "governance gate not satisfied") {
    super(message);
    this.name = "McpGateError";
  }
}

// ── JSON-RPC 2.0 over one stdio child ─────────────────────────────────────────

/** Minimal child-process surface used by the client (so tests inject a fake). */
export interface McpChildLike {
  stdin: { write(s: string): void };
  stdout: { on(event: "data", cb: (data: unknown) => void): void };
  stderr: { on(event: "data", cb: (data: unknown) => void): void };
  on(event: "error", cb: (err: Error) => void): void;
  kill(): void;
}

export type McpSpawn = (command: string, args: string[]) => McpChildLike;

export interface McpClientOpts {
  timeoutMs: number;
  onStderr?: (chunk: string) => void;
}

interface Pending {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A minimal JSON-RPC 2.0 client over one MCP stdio child. Buffers stdout, splits
 * on "\n" (partial lines are retained across chunks), and matches responses to
 * requests by numeric id. stderr is DEBUG passthrough only — never parsed.
 */
export class McpClient {
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;

  constructor(private child: McpChildLike, private opts: McpClientOpts) {
    child.stdout.on("data", (d) => this.onData(String(d)));
    child.stderr.on("data", (d) => this.opts.onStderr?.(String(d)));
    child.on("error", (e) => this.failAll(e));
  }

  private onData(chunk: string): void {
    if (this.closed) return;
    if (this.buf.length + chunk.length > 1_048_576) {
      this.failAll(new McpError("MCP output limit exceeded")); this.close(); return;
    }
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        // Non-JSON noise on stdout — ignore rather than crash. (stderr never reaches here.)
        continue;
      }
      if (typeof msg?.id !== "number") continue; // notifications / unmatched
      const p = this.pending.get(msg.id);
      if (!p) continue;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new McpError(String(msg.error?.message ?? "JSON-RPC error"), msg.error?.code));
      } else {
        p.resolve(msg.result);
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** Send a request and resolve with its `result` (or reject on error/timeout). */
  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpTimeoutError(method, this.opts.timeoutMs));
      }, this.opts.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** Fire a notification (no id, no response expected). */
  notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new McpError("client closed"));
    try {
      this.child.kill(); // no zombie: the child is always torn down
    } catch {
      /* already gone */
    }
  }
}

export interface WithMcpOpts {
  timeoutMs?: number;
  onStderr?: (chunk: string) => void;
}

/**
 * Spawn a server, run the MCP handshake (initialize → notifications/initialized),
 * hand the ready client to `fn`, then ALWAYS tear the child down (finally →
 * close → kill) — even on a timeout, so a wedged server never lingers.
 */
export async function withMcpServer<T>(
  def: McpServerDef,
  spawnImpl: McpSpawn,
  opts: WithMcpOpts,
  fn: (client: McpClient) => Promise<T>,
): Promise<T> {
  const child = spawnImpl(def.command, def.args);
  const client = new McpClient(child, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
    onStderr: opts.onStderr,
  });
  try {
    await client.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    client.notify("notifications/initialized");
    return await fn(client);
  } finally {
    client.close();
  }
}

export interface McpTool {
  name: string;
  description?: string;
  [k: string]: unknown;
}

export interface McpContentBlock {
  type?: string;
  text?: string;
  [k: string]: unknown;
}

export interface McpCallResult {
  content: McpContentBlock[];
  isError: boolean;
}

/** Full flow: handshake, tools/list, return the tool descriptors. */
export async function listServerTools(
  def: McpServerDef,
  spawnImpl: McpSpawn,
  opts: WithMcpOpts = {},
): Promise<McpTool[]> {
  return withMcpServer(def, spawnImpl, opts, async (client) => {
    const res = await client.request("tools/list");
    return Array.isArray(res?.tools) ? (res.tools as McpTool[]) : [];
  });
}

/** Full flow: handshake, tools/call, return the call result (content + isError). */
export async function callServerTool(
  def: McpServerDef,
  toolName: string,
  args: Record<string, unknown>,
  spawnImpl: McpSpawn,
  opts: WithMcpOpts = {},
): Promise<McpCallResult> {
  return withMcpServer(def, spawnImpl, opts, async (client) => {
    const res = await client.request("tools/call", { name: toolName, arguments: args ?? {} });
    return {
      content: Array.isArray(res?.content) ? (res.content as McpContentBlock[]) : [],
      isError: Boolean(res?.isError),
    };
  });
}

// ── view helpers (obsidian identity — molten on error, NEVER green) ───────────

/** Flatten a call result's content blocks into displayable text. */
export function summarizeCallResult(res: McpCallResult): { isError: boolean; text: string } {
  const text = res.content
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
  return { isError: res.isError, text };
}

/**
 * Border accent for a result card. Error → molten; success → neutral steel.
 * There is NO green anywhere in the Braavolabs identity — a success is steel, never
 * green (the obsidian palette has no green token to reach for).
 */
export function resultBorderColor(isError: boolean): string {
  return isError ? "var(--molten)" : "var(--steel-600)";
}

// ── the bridge (memory dev/test · Tauri host) ─────────────────────────────────

/** The MCP surface the UI drives. Backends: memory (dev/test) or Tauri host. */
export interface McpCapabilities { launchEnabled: boolean; reasonCode?: string; }

export interface McpBridge {
  capabilities(): Promise<McpCapabilities>;
  listServers(): Promise<McpConfig>;
  addServer(name: string, command: string, args: string[]): Promise<void>;
  removeServer(name: string): Promise<void>;
  /**
   * Discovery — spawns + handshakes + tools/list. GATED: starting the server
   * is a native process launch, so it passes the same one-time-token gate as
   * callTool. `token` must be a valid `mcp.discover` grant bound to {server,
   * the server's CURRENT resolved command+args} — a definition edited after
   * approval invalidates the token rather than silently running the new one.
   */
  listTools(server: string, token: string): Promise<McpTool[]>;
  /**
   * Side effect — GATED. `token` must be a valid one-time `mcp.tool` grant bound
   * to {server, tool}; it is consumed EXACTLY once before the server is spawned.
   * An invalid/absent/replayed token throws McpGateError and NOTHING runs.
   */
  /** Host snapshots the complete invocation before asking for native approval. */
  prepareCall(server: string, tool: string, args: Record<string, unknown>): Promise<GateResult>;
  /** Only a one-use approval token crosses the execution boundary. */
  executeCall(token: string): Promise<McpCallResult>;
  /** @deprecated Unsafe name-only grants are refused; use prepareCall/executeCall. */
  callTool(server: string, tool: string, args: Record<string, unknown>, token: string): Promise<McpCallResult>;
}

export interface MemoryMcpOpts {
  /** Injected stdio spawn — a mock in tests; a throwing stub in a plain browser. */
  spawnImpl: McpSpawn;
  /** Governance backend — callTool consumes the one-time token through it. */
  gov: Governance;
  /** Seed config (optional). */
  config?: McpConfig;
  timeoutMs?: number;
  onStderr?: (chunk: string) => void;
  launchEnabled?: boolean;
}

/**
 * In-memory bridge — the dev/test backend and the exact behavioural mirror of
 * the Rust host. Config lives in a Map; the JSON-RPC session runs here over the
 * injected spawn. callTool consumes the gate token FIRST (fail-closed): a bad
 * token means the server is never even spawned.
 */
export function createMemoryMcpBridge(opts: MemoryMcpOpts): McpBridge {
  const cfg = new Map<string, McpServerDef>(Object.entries(opts.config ?? {}).map(([name, d]) => [name, { command: d.command, args: [...d.args] }]));
  const withOpts: WithMcpOpts = { timeoutMs: opts.timeoutMs, onStderr: opts.onStderr };
  let revision = 0;
  let nextPlan = 0;
  const plans = new Map<string, { definition: McpServerDef; tool: string; args: Record<string, unknown>; detail: ActionDetail; revision: number; expires: number }>();
  const clock = () => globalThis.performance?.now?.() ?? Date.now();

  const def = (server: string): McpServerDef => {
    const d = cfg.get(server);
    if (!d) throw new McpError(`no MCP server named "${server}"`);
    return d;
  };

  return {
    async capabilities() { return { launchEnabled: opts.launchEnabled ?? true, ...(opts.launchEnabled === false ? { reasonCode: "MCP_HOST_REQUIRED" } : {}) }; },
    async listServers() {
      return Object.fromEntries([...cfg.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([n, d]) => [n, { command: d.command, args: [...d.args] }]));
    },
    async addServer(name, command, args) {
      const n = name.trim();
      if (!n) throw new McpError("server name is required");
      if (!command.trim()) throw new McpError("command is required");
      revision += 1; plans.clear();
      await opts.gov.invalidate();
      cfg.set(n, { command: command.trim(), args: [...args] });
    },
    async removeServer(name) {
      revision += 1; plans.clear();
      await opts.gov.invalidate();
      cfg.delete(name.trim());
    },
    async listTools(server, token) {
      const d = def(server); // unknown server → McpError, before any gate check
      // GATE — bind to the CURRENT resolved command+args (not just the name),
      // so a definition swapped in after approval invalidates the token instead
      // of silently spawning the new command.
      const detail: ActionDetail = { server, argv: [d.command, ...d.args] };
      const consumed = await opts.gov.consume(token, "mcp.discover", detail);
      if (!consumed) throw new McpGateError();
      return listServerTools(d, opts.spawnImpl, withOpts);
    },
    async prepareCall(server, tool, args) {
      const d = { ...def(server), args: [...def(server).args] };
      const preparedRevision = revision;
      const expires = clock() + 120_000;
      for (const [id, plan] of plans) if (clock() >= plan.expires) plans.delete(id);
      if (plans.size >= 128) throw new McpGateError("too many pending invocations");
      const canonical = snapshotToolArgs(args);
      const planId = globalThis.crypto?.randomUUID?.() ?? `plan-${++nextPlan}-${clock()}`;
      const detail: ActionDetail = { server, tool, path: planId, argv: [d.command, ...d.args] };
      const request = await opts.gov.request("mcp.tool", detail);
      if (revision !== preparedRevision) throw new McpGateError("registry changed while preparing invocation");
      plans.set(request.actionId, { definition: { command: d.command, args: [...d.args] }, tool, args: canonical, detail, revision: preparedRevision, expires });
      return request;
    },
    async executeCall(token) {
      for (const [id, plan] of plans) {
        if (plan.revision !== revision || clock() >= plan.expires) { plans.delete(id); continue; }
        if (!await opts.gov.consume(token, "mcp.tool", plan.detail)) continue;
        plans.delete(id);
        if (plan.revision !== revision || clock() >= plan.expires) throw new McpGateError("invocation invalidated");
        return callServerTool(plan.definition, plan.tool, plan.args, opts.spawnImpl, withOpts);
      }
      throw new McpGateError("prepare and approve a new invocation");
    },
    async callTool() { throw new McpGateError("prepareCall/executeCall required"); },
  };
}

/** Shape the Rust `mcp_list_servers` command returns (camelCase, serde). */
interface RawServerEntry {
  name?: string;
  command?: string;
  args?: string[];
}
interface RawCallResult {
  content?: McpContentBlock[];
  isError?: boolean;
}

/**
 * Tauri-backed bridge — the REAL runtime. Config persistence AND the JSON-RPC
 * stdio session (spawn, handshake, partial-line framing, timeout→kill) live in
 * the Rust host. callTool hands the one-time token to the host, which consumes
 * it there (a webview cannot forge a host token) before it will spawn the server.
 */
export function createTauriMcpBridge(invoke: Invoke): McpBridge {
  return {
    async capabilities() {
      const raw = await invoke("mcp_capabilities") as Partial<McpCapabilities> | null;
      return { launchEnabled: raw?.launchEnabled === true, reasonCode: typeof raw?.reasonCode === "string" ? raw.reasonCode : undefined };
    },
    async listServers() {
      const raw = (await invoke("mcp_list_servers")) as RawServerEntry[] | null;
      const out: McpConfig = {};
      if (Array.isArray(raw)) {
        for (const e of raw) {
          const name = String(e?.name ?? "");
          if (name) out[name] = { command: String(e?.command ?? ""), args: Array.isArray(e?.args) ? e!.args!.map(String) : [] };
        }
      }
      return out;
    },
    async addServer(name, command, args) {
      await invoke("mcp_add_server", { name, command, args });
    },
    async removeServer(name) {
      await invoke("mcp_remove_server", { name });
    },
    async listTools(server, token) {
      const raw = (await invoke("mcp_list_tools", { token, server })) as McpTool[] | null;
      return Array.isArray(raw) ? raw : [];
    },
    async prepareCall(server, tool, args) {
      const raw = await invoke("mcp_prepare_call", { server, tool, args: snapshotToolArgs(args) }) as Partial<GateResult> | null;
      if (!raw?.actionId) throw new McpGateError("host invocation could not be prepared");
      return { actionId: raw.actionId, kind: "mcp.tool", decision: raw.decision ?? "deny", reason: raw.reason ?? "", token: raw.token };
    },
    async executeCall(token) {
      const raw = (await invoke("mcp_call_tool", { token })) as RawCallResult | null;
      return { content: Array.isArray(raw?.content) ? raw.content : [], isError: Boolean(raw?.isError) };
    },
    async callTool() { throw new McpGateError("prepareCall/executeCall required"); },
  };
}

/**
 * Pick the real backend at runtime: Tauri host if present, else in-memory. The
 * memory fallback for a plain browser preview has no way to spawn a process, so
 * its spawn stub throws an honest "desktop host required" — never a fake result.
 */
export function resolveMcpBridge(gov: Governance): McpBridge {
  const inv = tauriInvoke();
  if (inv) return createTauriMcpBridge(inv);
  const spawnImpl: McpSpawn = () => {
    throw new McpError("MCP servers require the Braavolabs desktop host (run the Tauri app).");
  };
  return createMemoryMcpBridge({ spawnImpl, gov, launchEnabled: false });
}
