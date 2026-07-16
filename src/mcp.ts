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
 * THE MOAT APPLIES TO MCP TOO. A `tools/call` is a side effect, so it passes the
 * P-D4 governance gate: request('mcp.tool', {server, tool}) → approval → a
 * one-time token → callTool consumes it EXACTLY ONCE before the server is ever
 * spawned. Memory backend consumes via the injected Governance; the Tauri backend
 * hands the token to the Rust host, which consumes it host-side (a compromised
 * webview cannot forge a host token) — the same contract as `governed_command`.
 * `tools/list` is read-only discovery and is NOT gated.
 *
 * MCP stdio framing is line-delimited JSON-RPC 2.0: one JSON object per line,
 * terminated by "\n". Config lives as { name: {command, args[]} } with args as a
 * discrete ARRAY (never a joined string) — so there is no shell and no injection
 * seam when the server is later spawned. stderr is surfaced verbatim for debug
 * but NEVER parsed as JSON-RPC — only stdout carries the protocol.
 */
import type { ActionDetail, Governance } from "./governance";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Tauri v2 with `withGlobalTauri:true` exposes window.__TAURI__.core.invoke. */
function tauriInvoke(): Invoke | null {
  const g = globalThis as any;
  const inv = g?.__TAURI__?.core?.invoke;
  return typeof inv === "function" ? (inv as Invoke) : null;
}

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const FORGE_VERSION = "0.1.0";
export const DEFAULT_MCP_TIMEOUT_MS = 10_000;

const CLIENT_INFO = { name: "forge", version: FORGE_VERSION };

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
 * There is NO green anywhere in the Forge identity — a success is steel, never
 * green (the obsidian palette has no green token to reach for).
 */
export function resultBorderColor(isError: boolean): string {
  return isError ? "var(--molten)" : "var(--steel-600)";
}

// ── the bridge (memory dev/test · Tauri host) ─────────────────────────────────

/** The MCP surface the UI drives. Backends: memory (dev/test) or Tauri host. */
export interface McpBridge {
  listServers(): Promise<McpConfig>;
  addServer(name: string, command: string, args: string[]): Promise<void>;
  removeServer(name: string): Promise<void>;
  /** Discovery — spawns + handshakes + tools/list. Read-only, NOT gated. */
  listTools(server: string): Promise<McpTool[]>;
  /**
   * Side effect — GATED. `token` must be a valid one-time `mcp.tool` grant bound
   * to {server, tool}; it is consumed EXACTLY once before the server is spawned.
   * An invalid/absent/replayed token throws McpGateError and NOTHING runs.
   */
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
}

/**
 * In-memory bridge — the dev/test backend and the exact behavioural mirror of
 * the Rust host. Config lives in a Map; the JSON-RPC session runs here over the
 * injected spawn. callTool consumes the gate token FIRST (fail-closed): a bad
 * token means the server is never even spawned.
 */
export function createMemoryMcpBridge(opts: MemoryMcpOpts): McpBridge {
  const cfg = new Map<string, McpServerDef>(Object.entries(opts.config ?? {}));
  const withOpts: WithMcpOpts = { timeoutMs: opts.timeoutMs, onStderr: opts.onStderr };

  const def = (server: string): McpServerDef => {
    const d = cfg.get(server);
    if (!d) throw new McpError(`no MCP server named "${server}"`);
    return d;
  };

  return {
    async listServers() {
      return Object.fromEntries([...cfg.entries()].sort(([a], [b]) => a.localeCompare(b)));
    },
    async addServer(name, command, args) {
      const n = name.trim();
      if (!n) throw new McpError("server name is required");
      if (!command.trim()) throw new McpError("command is required");
      cfg.set(n, { command: command.trim(), args: [...args] });
    },
    async removeServer(name) {
      cfg.delete(name.trim());
    },
    async listTools(server) {
      return listServerTools(def(server), opts.spawnImpl, withOpts);
    },
    async callTool(server, tool, args, token) {
      const d = def(server);
      // GATE FIRST — spend the one-time token BEFORE spawning anything. A
      // replayed/forged/mis-bound token → refused → the server never runs.
      const detail: ActionDetail = { server, tool };
      const consumed = await opts.gov.consume(token, "mcp.tool", detail);
      if (!consumed) throw new McpGateError();
      return callServerTool(d, tool, args, opts.spawnImpl, withOpts);
    },
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
    async listTools(server) {
      const raw = (await invoke("mcp_list_tools", { server })) as McpTool[] | null;
      return Array.isArray(raw) ? raw : [];
    },
    async callTool(server, tool, args, token) {
      const raw = (await invoke("mcp_call_tool", { token, server, tool, args })) as RawCallResult | null;
      return {
        content: Array.isArray(raw?.content) ? (raw!.content as McpContentBlock[]) : [],
        isError: Boolean(raw?.isError),
      };
    },
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
    throw new McpError("MCP servers require the Forge desktop host (run the Tauri app).");
  };
  return createMemoryMcpBridge({ spawnImpl, gov });
}
