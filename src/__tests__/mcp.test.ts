import { describe, it, expect, vi } from "vitest";
import {
  addMcpServer,
  removeMcpServer,
  parseArgsInput,
  parseToolArgs,
  listServerTools,
  callServerTool,
  createMemoryMcpBridge,
  createTauriMcpBridge,
  summarizeCallResult,
  resultBorderColor,
  MCP_PROTOCOL_VERSION,
  McpTimeoutError,
  McpGateError,
  McpError,
  type McpChildLike,
  type McpTool,
} from "../mcp";
import { createMemoryGovernance } from "../governance";

// ── config (arg-array preservation) ─────────────────────────────────────────────
describe("mcp config", () => {
  it("add preserves args as a discrete ARRAY (no shell join)", () => {
    const cfg = addMcpServer({}, "fs", "npx", ["-y", "@mcp/server-filesystem", "/tmp"]);
    expect(cfg.fs.command).toBe("npx");
    expect(Array.isArray(cfg.fs.args)).toBe(true);
    expect(cfg.fs.args).toEqual(["-y", "@mcp/server-filesystem", "/tmp"]);
    // a dangerous-looking arg stays one inert element, never a shell separator
    const evil = addMcpServer({}, "x", "srv", ["hi; rm -rf /"]);
    expect(evil.x.args).toEqual(["hi; rm -rf /"]);
    expect(evil.x.args.filter((a) => a === "hi; rm -rf /")).toHaveLength(1);
  });

  it("remove drops one server without disturbing the others", () => {
    let cfg = addMcpServer({}, "a", "cmd-a", []);
    cfg = addMcpServer(cfg, "b", "cmd-b", ["x"]);
    cfg = removeMcpServer(cfg, "a");
    expect(cfg.a).toBeUndefined();
    expect(cfg.b).toEqual({ command: "cmd-b", args: ["x"] });
  });

  it("parseArgsInput splits on whitespace with double-quote grouping", () => {
    expect(parseArgsInput("-y @mcp/srv /tmp")).toEqual(["-y", "@mcp/srv", "/tmp"]);
    expect(parseArgsInput('--root "/my dir" --flag')).toEqual(["--root", "/my dir", "--flag"]);
    expect(parseArgsInput("   ")).toEqual([]);
  });

  it("parseToolArgs accepts {} / valid object, rejects non-object + bad JSON", () => {
    expect(parseToolArgs("")).toEqual({ ok: true, value: {} });
    expect(parseToolArgs('{"who":"world"}')).toEqual({ ok: true, value: { who: "world" } });
    expect(parseToolArgs("[1,2]")).toEqual({ ok: false, error: expect.stringContaining("object") });
    expect(parseToolArgs("{bad")).toEqual({ ok: false, error: expect.stringContaining("JSON") });
  });
});

// ── mock stdio JSON-RPC server ──────────────────────────────────────────────────
interface FakeServerOpts {
  respond?: boolean;
  tools?: McpTool[];
  callResult?: { content: Array<{ type?: string; text?: string }>; isError?: boolean };
  /** Split each response across two stdout chunks to exercise partial-line buffering. */
  splitFraming?: boolean;
}

/**
 * A fake MCP stdio child speaking line-delimited JSON-RPC 2.0. Records every
 * message sent and auto-answers initialize / tools/list / tools/call.
 * `respond:false` simulates a wedged server (→ timeout). `splitFraming` emits
 * each response in two pieces to prove the client reassembles partial lines.
 */
function makeFakeServer(opts: FakeServerOpts = {}) {
  const respond = opts.respond ?? true;
  let stdoutCb: (d: unknown) => void = () => {};
  let stderrCb: (d: unknown) => void = () => {};
  const rawWrites: string[] = [];
  const sent: any[] = [];
  let killed = false;

  const emit = (response: string) => {
    if (opts.splitFraming) {
      const mid = Math.max(1, Math.floor(response.length / 2));
      queueMicrotask(() => stdoutCb(Buffer.from(response.slice(0, mid))));
      queueMicrotask(() => stdoutCb(Buffer.from(response.slice(mid))));
    } else {
      queueMicrotask(() => stdoutCb(Buffer.from(response)));
    }
  };

  const child: McpChildLike = {
    stdin: {
      write(s: string) {
        rawWrites.push(s);
        for (const line of s.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          const msg = JSON.parse(t);
          sent.push(msg);
          if (msg.id === undefined || !respond) continue; // notification, or hung server
          let result: any;
          if (msg.method === "initialize") {
            result = { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: "fake" } };
          } else if (msg.method === "tools/list") {
            result = { tools: opts.tools ?? [] };
          } else if (msg.method === "tools/call") {
            result = opts.callResult ?? { content: [] };
          }
          emit(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
        }
      },
    },
    stdout: { on: (_e, cb) => void (stdoutCb = cb) },
    stderr: { on: (_e, cb) => void (stderrCb = cb) },
    on: () => {},
    kill: () => void (killed = true),
  };

  return {
    child,
    rawWrites,
    sent,
    emitStderr: (s: string) => stderrCb(Buffer.from(s)),
    get killed() {
      return killed;
    },
  };
}

const DEF = { command: "my-mcp", args: ["--stdio"] };

// ── JSON-RPC handshake / tools-list / tools-call ────────────────────────────────
describe("listServerTools — full JSON-RPC handshake", () => {
  it("runs initialize → notifications/initialized → tools/list and returns the tools", async () => {
    const server = makeFakeServer({ tools: [{ name: "read_file", description: "read a file" }, { name: "write_file" }] });
    let spawnedWith: { command: string; args: string[] } | undefined;
    const spawnImpl = (command: string, args: string[]) => {
      spawnedWith = { command, args };
      return server.child;
    };
    const tools = await listServerTools(DEF, spawnImpl, { timeoutMs: 1000 });
    expect(tools.map((t) => t.name)).toEqual(["read_file", "write_file"]);
    // spawn received command + args as a discrete array (no shell)
    expect(spawnedWith).toEqual({ command: "my-mcp", args: ["--stdio"] });
    // handshake ordering + client identity
    expect(server.sent.map((m) => m.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(server.sent[0].params.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(server.sent[0].params.clientInfo.name).toBe("forge");
    expect(server.sent[1].id).toBeUndefined(); // initialized is a NOTIFICATION
    expect(server.killed).toBe(true); // child torn down (no zombie)
  });

  it("frames every message as a single-line JSON object terminated by \\n", async () => {
    const server = makeFakeServer({ tools: [] });
    await listServerTools(DEF, () => server.child, { timeoutMs: 1000 });
    for (const w of server.rawWrites) {
      expect(w.endsWith("\n")).toBe(true);
      const inner = w.slice(0, -1);
      expect(inner).not.toContain("\n");
      expect(() => JSON.parse(inner)).not.toThrow();
    }
  });

  it("reassembles a response split across two stdout chunks (partial-line buffering)", async () => {
    const server = makeFakeServer({ tools: [{ name: "ok" }], splitFraming: true });
    const tools = await listServerTools(DEF, () => server.child, { timeoutMs: 1000 });
    expect(tools.map((t) => t.name)).toEqual(["ok"]);
  });
});

describe("callServerTool", () => {
  it("sends tools/call with name+arguments and returns the content text", async () => {
    const server = makeFakeServer({ callResult: { content: [{ type: "text", text: "hello world" }] } });
    const result = await callServerTool(DEF, "greet", { who: "world" }, () => server.child, { timeoutMs: 1000 });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe("hello world");
    const call = server.sent.find((m) => m.method === "tools/call");
    expect(call.params).toEqual({ name: "greet", arguments: { who: "world" } });
  });

  it("surfaces isError from the tool result", async () => {
    const server = makeFakeServer({ callResult: { content: [{ type: "text", text: "bad input" }], isError: true } });
    const result = await callServerTool(DEF, "boom", {}, () => server.child, { timeoutMs: 1000 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("bad input");
  });
});

// ── timeout → kill (zombie-free) + stderr never parsed ──────────────────────────
describe("timeout + stderr", () => {
  it("rejects with McpTimeoutError AND kills the child when the server never answers", async () => {
    const server = makeFakeServer({ respond: false });
    await expect(listServerTools(DEF, () => server.child, { timeoutMs: 25 })).rejects.toBeInstanceOf(McpTimeoutError);
    expect(server.killed).toBe(true); // wedged server is torn down — no zombie
  });

  it("passes server stderr to onStderr verbatim and NEVER parses it as JSON-RPC", async () => {
    const server = makeFakeServer({ tools: [{ name: "ok" }] });
    const stderrChunks: string[] = [];
    const p = listServerTools(DEF, () => server.child, { timeoutMs: 1000, onStderr: (c) => stderrChunks.push(c) });
    // Non-JSON debug noise on stderr must not break the JSON-RPC stream on stdout.
    server.emitStderr("[debug] booting server\n");
    server.emitStderr('{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"INJECTED"}]}}\n'); // looks like RPC, but it's stderr
    const tools = await p;
    // The stderr "RPC" line was NEVER parsed — the real tools/list result wins.
    expect(tools.map((t) => t.name)).toEqual(["ok"]);
    expect(stderrChunks.join("")).toContain("[debug] booting server");
  });
});

// ── the gate: tools/call MUST pass governance (the moat, applied to MCP) ─────────
describe("createMemoryMcpBridge — config + gated callTool", () => {
  it("add/list/remove round-trips through the bridge (arg array intact)", async () => {
    const gov = createMemoryGovernance();
    const bridge = createMemoryMcpBridge({ spawnImpl: () => makeFakeServer().child, gov });
    await bridge.addServer("fs", "npx", ["-y", "srv"]);
    await bridge.addServer("git", "mcp-git", []);
    expect(await bridge.listServers()).toEqual({ fs: { command: "npx", args: ["-y", "srv"] }, git: { command: "mcp-git", args: [] } });
    await bridge.removeServer("fs");
    expect(await bridge.listServers()).toEqual({ git: { command: "mcp-git", args: [] } });
  });

  it("callTool RUNS after request→approve→consume (tools/call reaches the server)", async () => {
    const gov = createMemoryGovernance();
    const server = makeFakeServer({ callResult: { content: [{ type: "text", text: "42" }] } });
    const bridge = createMemoryMcpBridge({
      spawnImpl: () => server.child,
      gov,
      config: { calc: { command: "mcp-calc", args: [] } },
    });
    // Drive the gate exactly as the UI does: request → approve → token.
    const detail = { server: "calc", tool: "add" };
    const req = await gov.request("mcp.tool", detail);
    expect(req.decision).toBe("require-approval");
    const { token } = await gov.approve(req.actionId);
    const res = await bridge.callTool("calc", "add", { a: 1, b: 2 }, token);
    expect(res.content[0].text).toBe("42");
    expect(server.sent.find((m) => m.method === "tools/call").params).toEqual({ name: "add", arguments: { a: 1, b: 2 } });
  });

  it("callTool is REFUSED without a valid gate token — the server is NEVER spawned", async () => {
    const gov = createMemoryGovernance();
    const spawnImpl = vi.fn(() => makeFakeServer().child);
    const bridge = createMemoryMcpBridge({ spawnImpl, gov, config: { calc: { command: "mcp-calc", args: [] } } });
    // A forged/never-issued token → consume fails → McpGateError, no spawn.
    await expect(bridge.callTool("calc", "add", {}, "tok_forged")).rejects.toBeInstanceOf(McpGateError);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("a token bound to one tool cannot authorize a different tool (mis-bound → refused, no spawn)", async () => {
    const gov = createMemoryGovernance();
    const spawnImpl = vi.fn(() => makeFakeServer().child);
    const bridge = createMemoryMcpBridge({ spawnImpl, gov, config: { calc: { command: "mcp-calc", args: [] } } });
    const req = await gov.request("mcp.tool", { server: "calc", tool: "add" });
    const { token } = await gov.approve(req.actionId);
    // token is bound to add — using it for "delete" must fail the binding check.
    await expect(bridge.callTool("calc", "delete", {}, token)).rejects.toBeInstanceOf(McpGateError);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("a consumed token cannot be replayed for a second call", async () => {
    const gov = createMemoryGovernance();
    const server = makeFakeServer({ callResult: { content: [{ type: "text", text: "ok" }] } });
    const bridge = createMemoryMcpBridge({ spawnImpl: () => server.child, gov, config: { calc: { command: "c", args: [] } } });
    const req = await gov.request("mcp.tool", { server: "calc", tool: "add" });
    const { token } = await gov.approve(req.actionId);
    await bridge.callTool("calc", "add", {}, token); // spends the token
    await expect(bridge.callTool("calc", "add", {}, token)).rejects.toBeInstanceOf(McpGateError); // replay refused
  });

  it("listTools on an unknown server throws (never fabricates tools)", async () => {
    const gov = createMemoryGovernance();
    const bridge = createMemoryMcpBridge({ spawnImpl: () => makeFakeServer().child, gov });
    await expect(bridge.listTools("nope")).rejects.toBeInstanceOf(McpError);
  });
});

// ── Tauri bridge — thin host delegation ─────────────────────────────────────────
describe("createTauriMcpBridge — hands the token to the host to consume", () => {
  it("callTool invokes mcp_call_tool with token+server+tool+args and maps the result", async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "mcp_call_tool") return { content: [{ type: "text", text: "hi" }], isError: false };
      return null;
    });
    const bridge = createTauriMcpBridge(invoke);
    const res = await bridge.callTool("fs", "read", { path: "/x" }, "tok_1");
    expect(res).toEqual({ content: [{ type: "text", text: "hi" }], isError: false });
    expect(calls).toEqual([{ cmd: "mcp_call_tool", args: { token: "tok_1", server: "fs", tool: "read", args: { path: "/x" } } }]);
  });

  it("listServers maps the host's entry array into an McpConfig", async () => {
    const invoke = vi.fn(async () => [{ name: "fs", command: "npx", args: ["-y", "srv"] }]);
    const bridge = createTauriMcpBridge(invoke);
    expect(await bridge.listServers()).toEqual({ fs: { command: "npx", args: ["-y", "srv"] } });
  });
});

// ── view helpers (obsidian identity — molten on error, no green) ─────────────────
describe("result view helpers", () => {
  it("summarizeCallResult flattens text blocks and carries isError", () => {
    expect(summarizeCallResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }], isError: false })).toEqual({ isError: false, text: "a\nb" });
    expect(summarizeCallResult({ content: [{ type: "text", text: "boom" }], isError: true })).toEqual({ isError: true, text: "boom" });
  });

  it("resultBorderColor is molten on error, steel on success — and NEVER green", () => {
    expect(resultBorderColor(true)).toBe("var(--molten)");
    expect(resultBorderColor(false)).toBe("var(--steel-600)");
    expect(resultBorderColor(true)).not.toMatch(/green/i);
    expect(resultBorderColor(false)).not.toMatch(/green/i);
  });
});
