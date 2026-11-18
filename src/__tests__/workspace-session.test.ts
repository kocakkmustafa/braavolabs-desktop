import { formatUsd } from "../i18n";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as client from "../client";
import type { Config } from "../config";
import { performSignOut } from "../session";
import { createMemoryStore, createConfigPersister } from "../store";
import { createSessionStore } from "../sessions";
import { createTauriGovernance } from "../governance";
import { toCascadeView, toCompareView } from "../render";
import { MAX_WIRE_JSON_BYTES, composeWire, createTray, splitWire, wireJsonBytes } from "../attachments";
import { compareMotion } from "../brand-motion";
import { DaemonError } from "../daemon-client";

// Execute the actual UI closures. Only paint, native confirmation and provider
// transport are synthetic; owner checks and transcript persistence are real.
const source = ts.createSourceFile("ui.ts", readFileSync(new URL("../ui.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const workspace = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "renderWorkspace")!;
function local(name: string) {
  let found: string | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(source) === name)) found = n.getText(source);
    ts.forEachChild(n, visit);
  };
  visit(workspace);
  if (!found) throw Error(`Missing actual workspace closure ${name}`);
  return found;
}
const gates = ["gateAction", "gateForToken"].map(name => source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name)!.getText(source)).join("\n");
const compiled = ts.transpileModule(`${gates}\nlet mode='cascade', dispatching=false, chatMotionVersion=0, workspaceDisposed=false, activeSession=null, nextDispatchRemote=false, daemonTurn=null, activeDaemonConv=null, daemonOnline=true, voiceCurrent=0, voiceChat=null;\n${local("dispatchController")}
${local("compareOperation")}\n${local("clearCompareOperation")}\n${local("stopDaemonTurn")}\n${local("stopDispatch")}
${local("cancelCurrentCompare")}\n${local("record")}\n${local("startNewSession")}\n${local("loadSession")}\n${local("daemonErrorText")}\n${local("runDaemonTurn")}\n${local("run")}\n${local("retryLast")}\n${local("seeDetails")}\n({ run, retry:retryLast, seeDetails, cancel:cancelCurrentCompare, newChat:startNewSession, load:loadSession, stop:stopDispatch, dispose:()=>{workspaceDisposed=true;clearCompareOperation()}, setMode:(value)=>{mode=value} });`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function delayed<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function element() {
  return { style: {} as Record<string, string>, value: "", textContent: "", disabled: false, append: vi.fn(), remove: vi.fn(), replaceChildren: vi.fn(), focus: vi.fn() };
}
function fixture(mode = "cascade") {
  const values = new Map<string, string>();
  const sessionStore = createSessionStore({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } }, () => "synthetic-session");
  const cfg: Config = { apiUrl: "https://api.example.invalid/api/v1", token: "A-token", refreshToken: "A-refresh" };
  const persist = createConfigPersister(createMemoryStore());
  const grant = { decision: "auto-allow", token: "synthetic-grant", actionId: "synthetic-action" };
  const native = vi.fn(async (command: string) => command === "request_action" ? grant : command === "consume_action" ? true : {});
  const gov = createTauriGovernance(native);
  const fetchImpl = vi.fn(async (_url: string, _init?: any) => ({ ok: true, status: 200, json: async () => ({ answer: "A-answer", attempts: [] }) }));
  const cascade = vi.fn((c: Config, p: client.CascadeParams) => client.cascade(c, p, { fetchImpl }));
  const localReply = { content: "A-answer", model: "synthetic-model" };
  const resolveOllamaModel = vi.fn(async () => "synthetic-model");
  const ollamaChat = vi.fn(async () => localReply);
  const directChat = vi.fn(async () => localReply);
  const get = vi.fn(async () => "synthetic-key-placeholder");
  const startCompare = vi.fn(async () => ({ id: "synthetic-research", status: "PENDING" }));
  const pollCompare = vi.fn(async (_cfg: Config, _id: string, _options: Parameters<typeof client.pollCompare>[2]): Promise<any> => ({ status: "COMPLETED", findings: { multiModel: { finalAnswer: "A-answer", synthesisParsed: true } } }));
  const cancelCompare = vi.fn(async (_cfg: Config, _id: string, _options: Parameters<typeof client.cancelCompare>[2]) => ({ success: true as const, status: "CANCELLED" as "CANCELLED" | "COMPLETED" | "FAILED" }));
  const cancelBtn = element(), hint = element();
  const renderCascadeAnswer = vi.fn(), renderPlainAnswer = vi.fn(), renderCompareAnswer = vi.fn();
  const refreshSavings = vi.fn(async () => {}), sendBtn = element();
  const compareControls = { read: vi.fn((): client.CompareParams["selections"] => undefined) };
  const companyInput = { value: "A-company" };
  const ta = { value: "A-prompt", focus() {} };
  const deps = { cfg, gov, vault: { get }, persist, t: (key: string) => key };
  // Local braavo daemon (plan 1.3) — the client is the tested daemon-client
  // surface; here only its transport outcome is synthetic.
  const daemon = {
    createConversation: vi.fn(async (input: { title?: string; provider: string; model: string }) => ({ id: "cv_A", title: input.title ?? "", provider: input.provider, model: input.model })),
    updateConversation: vi.fn(async (id: string, patch: { provider: string; model: string }) => ({ id, title: "", ...patch })),
    sendMessage: vi.fn(async (_id: string, _text: string, handlers: { onDelta?: (chunk: string, full: string) => void }): Promise<any> => {
      handlers.onDelta?.("A-", "A-"); return { text: "A-answer", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 2 } };
    }),
    abort: vi.fn(async () => true),
    cancelStream: vi.fn(async () => true),
  };
  const renderStatusCard = vi.fn(), showTab = vi.fn(), changesPathInput = { value: "" };
  const retries: Array<undefined | (() => boolean)> = [];
  const renderErrorCard = vi.fn(), refreshDaemonConversations = vi.fn(async () => {});
  const readDaemonModel = vi.fn((): { provider: string; model: string } | { error: string } => ({ provider: "OLLAMA", model: "synthetic-model" }));
  const showDaemonHint = vi.fn();
  // BRA-UI-09: the real tray and composeWire; the sent-chip row is a spy (DOM only).
  const attachTray = createTray(), renderSentChips = vi.fn(() => element());
  const ui = runInNewContext(compiled, {
    ...client, deps, cfg, sessionStore, t: deps.t,
    ta, companyInput, compareControls,
    localModelInput: { value: "synthetic-model" }, directProviderSel: { value: "synthetic-provider" }, directModelInput: { value: "synthetic-model" },
    updateStorageNotice() {}, redactSummary: (value: string) => value,
    AbortController, hint, sendBtn, cancelBtn, scroll: element(), inspectorBody: element(), surface: "chat",
    document: { createTextNode: (text: string) => ({ textContent: text }) }, thinkingMotions: new Map(),
    el: element, scrollToEnd() {}, setChatMotion() {}, syncCrumb() {}, refreshSessionList() {}, trackMotion() {},
    createOwnedBrandMotion: () => null, answerMotion: () => "success", compareMotion, compareProgressMotion: () => "thinking",
    renderErrorCard: (_scroll: unknown, message: string, retry?: () => boolean) => { retries.push(retry); renderErrorCard(message); }, renderCascadeAnswer, renderCascadeInspector() {}, renderPlainAnswer, renderCompareAnswer, renderCompareInspector() {}, renderSourceInspector() {}, speakButton: () => null,
    renderStatusCard: (_s: unknown, _t: unknown, detail: string, see: unknown) => renderStatusCard(detail, see), changesPathInput, showTab,
    bumpActivity() {}, refreshSavings, removeThinking: (row: ReturnType<typeof element>) => row.remove(),
    toCascadeView, toCompareView, cascade, startCompare, pollCompare, cancelCompare,
    resolveOllamaHost: () => "http://localhost:11434", resolveOllamaModel, ollamaChat,
    isDirectProvider: () => true, resolveDirectModel: () => "synthetic-model", directChat,
    OllamaUnreachableError: class extends Error {}, DirectApiError: class extends Error {},
    daemon, DaemonError, readDaemonModel, showDaemonHint, connectDaemon: vi.fn(async () => {}),
    attachTray, composeWire, wireJsonBytes, MAX_WIRE_JSON_BYTES, renderSentChips, getLocale: () => "en",
    deriveTitle: (text: string) => text, kv: element, historySearch: element(), refreshDaemonConversations,
  }) as { run(): Promise<void>; retry(text: string, mode: string): boolean; seeDetails: { target(): string; label(target: string): string; open(target: string): void }; cancel(): void; newChat(): void; load(id: string): void; stop(): void; dispose(): void; setMode(mode: string): void };
  ui.setMode(mode);
  const switchOwner = (boundary: "logout" | "B" | "base" | "dispose" | "same-pair") => {
    if (boundary === "dispose") { ui.dispose(); return; }
    if (boundary === "base") { cfg.apiUrl = "https://other.example.invalid/api/v1"; return; }
    performSignOut(cfg, { persist, onSignedOut: () => { ui.dispose(); sessionStore.clearMemory(); values.clear(); } }, async () => {});
    if (boundary === "B" || boundary === "same-pair") {
      client.invalidateSession(cfg); cfg.token = boundary === "B" ? "B-token" : "A-token"; cfg.refreshToken = boundary === "B" ? "B-refresh" : "A-refresh";
      void persist(cfg);
    }
  };
  return { ...ui, attachTray, renderSentChips, retries, renderStatusCard, showTab, changesPathInput, daemon, renderErrorCard, refreshDaemonConversations, readDaemonModel, showDaemonHint, cfg, deps, native, companyInput, compareControls, ta, grant, fetchImpl, cascade, resolveOllamaModel, ollamaChat, directChat, get, startCompare, pollCompare, cancelCompare, cancelBtn, hint, renderCascadeAnswer, renderPlainAnswer, renderCompareAnswer, refreshSavings, sessionStore, sendBtn, switchOwner };
}

describe("actual workspace operation ownership", () => {
  it.each(["cascade", "local", "direct", "compare"])("Kill aborts %s and ignores its late result", async mode => {
    const f = fixture(mode), response = delayed<any>();
    const work = mode === "cascade" ? f.cascade : mode === "local" ? f.ollamaChat : mode === "direct" ? f.directChat : f.startCompare;
    work.mockImplementation(() => response.promise);
    const pending = f.run(); await vi.waitFor(() => expect(work).toHaveBeenCalled());
    const args = work.mock.calls[0] as unknown[];
    const options = args[args.length - 1] as { signal: AbortSignal };
    expect(options.signal.aborted).toBe(false); f.stop(); expect(options.signal.aborted).toBe(true);
    response.resolve(mode === "compare" ? { id: "late", status: "PENDING" } : { content: "late", answer: "late", model: "test" });
    await pending; expect(f.sessionStore.list()[0]?.entries.map(entry => entry.role)).toEqual(["user"]);
    expect(f.sendBtn.disabled).toBe(false);
  });
  it("captures company/model/effort before confirmation and forwards the exact selection", async () => {
    const f = fixture("compare"), gate = delayed<any>();
    f.compareControls.read.mockReturnValue([{ provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEffort: "high" }]);
    f.native.mockImplementation(async command => command === "request_action" ? gate.promise : true);
    const pending = f.run();
    f.companyInput.value = "B-company";
    f.compareControls.read.mockReturnValue([{ provider: "OPENAI", model: "other" }]);
    gate.resolve(f.grant); await pending;
    expect(f.startCompare).toHaveBeenCalledWith(f.cfg, { companyId: "A-company", query: "A-prompt",
      selections: [{ provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEffort: "high" }] }, { signal: expect.any(AbortSignal) });
  });
  it("blocks unready explicit choices before governance, network or clearing the draft", async () => {
    const f = fixture("compare"); f.compareControls.read.mockImplementation(() => { throw Error("Load models"); });
    await f.run(); expect(f.native).not.toHaveBeenCalled(); expect(f.startCompare).not.toHaveBeenCalled();
    expect(f.ta.value).toBe("A-prompt"); expect(f.sessionStore.list()).toEqual([]);
  });
  it.each(["cascade", "compare", "local", "direct"])("keeps the current %s operation working", async mode => {
    const f = fixture(mode); await f.run();
    expect(f.sessionStore.list()[0]?.entries.map(e => e.role)).toEqual(["user", "assistant"]);
    expect(f.sendBtn.disabled).toBe(false);
  });
  it.each(["logout", "B", "base", "dispose", "same-pair"] as const)("does not dispatch a prompt after %s while native confirmation waits", async boundary => {
    const f = fixture(), gate = delayed<any>();
    f.native.mockImplementation(async command => command === "request_action" ? gate.promise : true);
    const pending = f.run(); await vi.waitFor(() => expect(f.native).toHaveBeenCalled());
    f.switchOwner(boundary); gate.resolve(f.grant); await pending;
    expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.refreshSavings).not.toHaveBeenCalled();
  });
  it("keeps the submitted lane fixed while confirmation waits", async () => {
    const f = fixture(), gate = delayed<any>();
    f.native.mockImplementation(async command => command === "request_action" ? gate.promise : true);
    const pending = f.run(); f.setMode("compare"); gate.resolve(f.grant); await pending;
    expect(f.cascade).toHaveBeenCalledOnce(); expect(f.startCompare).not.toHaveBeenCalled();
    expect(f.sessionStore.list()[0]?.entries.every(e => e.mode === "cascade")).toBe(true);
  });
  it("stops local transport after ownership changes during model lookup", async () => {
    const f = fixture("local"), model = delayed<string>(); f.resolveOllamaModel.mockImplementation(async () => model.promise);
    const pending = f.run(); await vi.waitFor(() => expect(f.resolveOllamaModel).toHaveBeenCalledOnce());
    f.switchOwner("B"); model.resolve("synthetic-model"); await pending; expect(f.ollamaChat).not.toHaveBeenCalled();
  });
  it("stops direct transport after a cancelled confirmation", async () => {
    const f = fixture("direct"), gate = delayed<any>();
    f.native.mockImplementation(async command => command === "request_action" ? gate.promise : true);
    const pending = f.run(); f.switchOwner("B"); gate.resolve(f.grant); await pending;
    expect(f.get).not.toHaveBeenCalled(); expect(f.directChat).not.toHaveBeenCalled();
  });
  it("stops direct transport after ownership changes during the native read", async () => {
    const f = fixture("direct"), key = delayed<string>(); f.get.mockImplementation(async () => key.promise);
    const pending = f.run(); await vi.waitFor(() => expect(f.get).toHaveBeenCalledOnce());
    f.switchOwner("B"); key.resolve("synthetic-key-placeholder"); await pending; expect(f.directChat).not.toHaveBeenCalled();
  });
  it("discards the API result even if the client completed just before the UI boundary", async () => {
    const f = fixture();
    f.cascade.mockImplementation(async (cfg, params) => {
      const result = await client.cascade(cfg, params, { fetchImpl: f.fetchImpl });
      f.newChat(); f.switchOwner("B"); return result;
    });
    await f.run(); expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(f.sessionStore.list()).toEqual([]); expect(f.renderCascadeAnswer).not.toHaveBeenCalled();
    expect(f.refreshSavings).not.toHaveBeenCalled();
  });
  it.each(["local", "direct"])("discards a late %s result without recreating a cleared transcript", async mode => {
    const f = fixture(mode), reply = delayed<{ content: string; model: string }>();
    const transport = mode === "local" ? f.ollamaChat : f.directChat;
    transport.mockImplementation(async () => reply.promise);
    const pending = f.run(); await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
    f.newChat(); f.switchOwner("B"); reply.resolve({ content: "A-answer", model: "synthetic-model" }); await pending;
    expect(f.sessionStore.list()).toEqual([]); expect(f.renderPlainAnswer).not.toHaveBeenCalled();
  });
  it("drops a late provider failure after the workspace is replaced", async () => {
    const f = fixture(), reply = delayed<any>(); f.cascade.mockImplementation(async () => reply.promise);
    const pending = f.run(); await vi.waitFor(() => expect(f.cascade).toHaveBeenCalledOnce());
    f.newChat(); f.switchOwner("B"); reply.reject(Error("synthetic old failure")); await pending;
    expect(f.sessionStore.list()).toEqual([]); expect(f.refreshSavings).not.toHaveBeenCalled();
  });
  it("keeps a new empty chat clear when the previous operation finishes", async () => {
    const f = fixture(), reply = delayed<any>(); f.cascade.mockImplementation(async () => reply.promise);
    const pending = f.run(); await vi.waitFor(() => expect(f.cascade).toHaveBeenCalledOnce());
    f.newChat(); expect(f.sendBtn.disabled).toBe(false);
    reply.resolve({ answer: "A-answer", attempts: [] }); await pending;
    expect(f.sessionStore.list()[0]?.entries.map(e => e.role)).toEqual(["user"]);
    expect(f.renderCascadeAnswer).not.toHaveBeenCalled(); expect(f.refreshSavings).not.toHaveBeenCalled();
  });
});

describe("compare polling owner continuity", () => {
  it("does not make a second request after a new session begins in onTick", async () => {
    const cfg: Config = { apiUrl: "https://api.example.invalid/api/v1", token: "A", refreshToken: "A-r" };
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: "RUNNING" }) }));
    await expect(client.pollCompare(cfg, "A-research", { fetchImpl, intervalMs: 0, maxAttempts: 2, onTick: () => { client.invalidateSession(cfg); cfg.token = "B"; cfg.refreshToken = "B-r"; } })).rejects.toBeInstanceOf(client.SessionChangedError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("stops polling when its UI is replaced under the same account", async () => {
    const cfg: Config = { apiUrl: "https://api.example.invalid/api/v1", token: "A" };
    let mounted = true;
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: "RUNNING" }) }));
    await expect(client.pollCompare(cfg, "A-research", { fetchImpl, intervalMs: 0, isCurrent: () => mounted, onTick: () => { mounted = false; } })).rejects.toBeInstanceOf(client.SessionChangedError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("keeps polling through a normal same-owner refresh", async () => {
    const cfg: Config = { apiUrl: "https://api.example.invalid/api/v1", token: "A", refreshToken: "A-r" };
    let gets = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/refresh")) return { ok: true, status: 200, json: async () => ({ token: "A2", refreshToken: "A-r2" }) };
      gets++;
      if (gets === 1) return { ok: false, status: 401, json: async () => ({ error: "expired" }) };
      return { ok: true, status: 200, json: async () => ({ status: gets === 2 ? "RUNNING" : "COMPLETED" }) };
    });
    const save = vi.fn();
    await expect(client.pollCompare(cfg, "A-research", { fetchImpl, save, intervalMs: 0 })).resolves.toMatchObject({ status: "COMPLETED" });
    expect(cfg.token).toBe("A2"); expect(save).toHaveBeenCalledOnce(); expect(gets).toBe(3);
  });
});

describe("current server Compare terminal outcomes in the actual workspace", () => {
  const partial = {
    finalAnswer: "paid candidate fallback", synthesis: "untrusted synthesis",
    synthesisParsed: false, synthesisStatus: "invalid_structured",
    synthesizerError: "Invalid structured synthesis: finalAnswer must be a string",
    perModel: [{ provider: "synthetic", model: "candidate", answer: "paid candidate fallback", costUsd: 0.002 }],
    consensus: ["untrusted consensus"], disagreements: ["untrusted disagreement"], totalCostUsd: 0.003,
  };
  it.each(["FAILED", "COMPLETED"])("never records malformed synthesis as an assistant answer or a successful spend (%s)", async status => {
    const f = fixture("compare");
    f.pollCompare.mockResolvedValue({ status, findings: { multiModel: partial } });
    await f.run();
    const entries = f.sessionStore.list()[0]!.entries;
    expect(entries.map(e => e.role)).toEqual(["user", "error"]);
    expect(entries[1]!.text).toBe(partial.synthesizerError);
    const settled = f.native.mock.calls.filter(([command]) => command === "settle_action");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toEqual(["settle_action", expect.objectContaining({ kind: "server.dispatch", outcome: "error" })]);
    const view = f.renderCompareAnswer.mock.calls[0]![1];
    expect(view).toMatchObject({ status: "FAILED", finalAnswer: "", synthesis: "", consensus: [], disagreements: [], totalCostUsd: 0.003 });
    expect(view.perModel[0].answer).toBe(partial.perModel[0]!.answer);
    expect(f.startCompare).toHaveBeenCalledOnce();
    expect(f.pollCompare).toHaveBeenCalledOnce();
    expect(f.sendBtn.disabled).toBe(false);
  });

  it.each(["FAILED", "CANCELLED"])("keeps a terminal %s without findings out of the assistant transcript", async status => {
    const f = fixture("compare");
    f.pollCompare.mockResolvedValue({ status, error: "synthetic terminal failure" });
    await f.run();
    expect(f.sessionStore.list()[0]!.entries[1]).toMatchObject({ role: "error", text: status === "CANCELLED" ? "chat.cancelled" : "synthetic terminal failure" });
    expect(f.native.mock.calls.filter(([command]) => command === "settle_action")[0]).toEqual([
      "settle_action", expect.objectContaining({ outcome: "error" }),
    ]);
  });

  it.each(["structured", "plain_text", "budget_skipped", "unavailable"])("preserves the current server's usable %s answer", async synthesisStatus => {
    const f = fixture("compare");
    f.pollCompare.mockResolvedValue({ status: "COMPLETED", findings: { multiModel: {
      finalAnswer: "usable answer", synthesisStatus, synthesisParsed: synthesisStatus === "structured",
    } } });
    await f.run();
    expect(f.sessionStore.list()[0]!.entries[1]).toMatchObject({ role: "assistant", text: "usable answer" });
    expect(f.native.mock.calls.filter(([command]) => command === "settle_action")[0]).toEqual([
      "settle_action", expect.objectContaining({ outcome: "success" }),
    ]);
  });

  it("does not audit an empty completed payload as a usable answer", async () => {
    const f = fixture("compare");
    f.pollCompare.mockResolvedValue({ status: "COMPLETED", findings: { multiModel: { finalAnswer: "  " } } });
    await f.run();
    expect(f.sessionStore.list()[0]!.entries[1]!.role).toBe("error");
    expect(f.native.mock.calls.filter(([command]) => command === "settle_action")[0]).toEqual([
      "settle_action", expect.objectContaining({ outcome: "error" }),
    ]);
  });

  it("renders paid partial candidates with an explicit failure, without a final-answer or raw-fallback badge", () => {
    const renderer = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "renderCompareAnswer")!.getText(source);
    const compiledRenderer = ts.transpileModule(`${renderer}\nrenderCompareAnswer;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    function node(_tag: string, _class?: string, text = "") {
      return { text, children: [] as any[], style: {} as Record<string, string>, append(...children: any[]) { this.children.push(...children); } };
    }
    const render = runInNewContext(compiledRenderer, { formatUsd, speakButton: () => null, el: node, document: { createTextNode: (text: string) => node("text", undefined, text) } });
    const scroll = node("section");
    render(scroll, toCompareView({ status: "FAILED", findings: { multiModel: partial } }), (key: string) => key);
    const text = (n: ReturnType<typeof node>): string => [n.text, ...n.children.map(text)].join(" ");
    const painted = text(scroll);
    expect(painted).toContain("paid candidate fallback");
    expect(painted).toContain(formatUsd(0.002));
    expect(painted).toContain("FAILED");
    expect(painted).toContain(partial.synthesizerError);
    expect(painted).not.toContain("chat.finalAnswer");
    expect(painted).not.toContain("chat.unparsed");
    expect(painted).not.toContain("untrusted synthesis");
    expect(painted).not.toContain("untrusted consensus");
  });
});

describe("actual Compare cancel handler", () => {
  it("waits for the server cancellation response, then aborts polling and records its soft-cancel notice", async () => {
    const f = fixture("compare"), polling = delayed<any>(), cancellation = delayed<any>();
    f.pollCompare.mockImplementation(() => polling.promise);
    f.cancelCompare.mockImplementation(() => cancellation.promise);
    const pending = f.run();
    await vi.waitFor(() => expect(f.pollCompare).toHaveBeenCalledOnce());
    expect(f.cancelBtn.style.display).toBe(""); expect(f.sendBtn.disabled).toBe(true);
    const signal = f.pollCompare.mock.calls[0][2]!.signal!;
    f.cancel(); f.cancel();
    expect(f.cancelCompare).toHaveBeenCalledExactlyOnceWith(f.cfg, "synthetic-research", expect.objectContaining({ signal }));
    expect(f.cancelBtn.disabled).toBe(true); expect(signal.aborted).toBe(false);
    cancellation.resolve({ success: true, status: "CANCELLED" }); await pending;
    expect(signal.aborted).toBe(true); expect(f.sendBtn.disabled).toBe(false); expect(f.cancelBtn.style.display).toBe("none");
    expect(f.sessionStore.list()[0]!.entries.map(entry => [entry.role, entry.text])).toEqual([["user", "A-prompt"], ["error", "chat.cancelled"]]);
    polling.resolve({ status: "COMPLETED", findings: { multiModel: { finalAnswer: "late answer" } } });
    await Promise.resolve(); expect(f.sessionStore.list()[0]!.entries).toHaveLength(2);
  });
  it("allows another cancel attempt after a failure while the original compare keeps running", async () => {
    const f = fixture("compare"), polling = delayed<any>();
    f.pollCompare.mockImplementation(() => polling.promise);
    f.cancelCompare.mockRejectedValueOnce(new client.ApiError(503, "RAW_PRIVATE_DETAIL"));
    const pending = f.run(); await vi.waitFor(() => expect(f.pollCompare).toHaveBeenCalledOnce());
    f.cancel(); await vi.waitFor(() => expect(f.cancelBtn.disabled).toBe(false));
    expect(f.sendBtn.disabled).toBe(true); expect(f.sessionStore.list()[0]!.entries).toHaveLength(1);
    f.cancel(); await pending;
    expect(f.cancelCompare).toHaveBeenCalledTimes(2);
    expect(f.sessionStore.list()[0]!.entries[1]!.text).toBe("chat.cancelled");
  });
  it.each(["COMPLETED", "FAILED"] as const)("preserves a %s result when completion races cancellation", async status => {
    const f = fixture("compare"), polling = delayed<any>();
    f.pollCompare.mockImplementation(() => polling.promise);
    f.cancelCompare.mockResolvedValue({ success: true, status });
    const pending = f.run(); await vi.waitFor(() => expect(f.pollCompare).toHaveBeenCalledOnce());
    f.cancel(); await vi.waitFor(() => expect(f.cancelCompare).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(f.pollCompare.mock.calls[0][2]!.signal!.aborted).toBe(false);
    polling.resolve(status === "COMPLETED" ? { status, findings: { multiModel: { finalAnswer: "completed before cancel", synthesisParsed: true } } } : { status, error: "failed before cancel" });
    await pending;
    expect(f.sessionStore.list()[0]!.entries[1]).toMatchObject({ role: status === "COMPLETED" ? "assistant" : "error", text: status === "COMPLETED" ? "completed before cancel" : "failed before cancel" });
  });
  it.each(["new chat", "dispose", "account", "api"])("discards delayed cancellation feedback after %s", async boundary => {
    const f = fixture("compare"), polling = delayed<any>(), cancellation = delayed<any>();
    f.pollCompare.mockImplementation(() => polling.promise); f.cancelCompare.mockImplementation(() => cancellation.promise);
    const pending = f.run(); await vi.waitFor(() => expect(f.pollCompare).toHaveBeenCalledOnce());
    f.cancel();
    if (boundary === "new chat") f.newChat();
    if (boundary === "dispose") f.dispose();
    if (boundary === "account") f.switchOwner("B");
    if (boundary === "api") f.switchOwner("base");
    cancellation.resolve({ success: true, status: "CANCELLED" });
    polling.resolve({ status: "COMPLETED", findings: { multiModel: { finalAnswer: "old account answer" } } });
    await pending; expect(f.renderCompareAnswer).not.toHaveBeenCalled();
    for (const session of f.sessionStore.list()) expect(session.entries.every(entry => entry.role === "user")).toBe(true);
  });
  it("restores send controls and records API errors in the active transcript", async () => {
    const f = fixture("compare"); f.startCompare.mockRejectedValue(new client.ApiError(503, "synthetic unavailable"));
    await f.run(); expect(f.sendBtn.disabled).toBe(false); expect(f.cancelBtn.style.display).toBe("none");
    expect(f.sessionStore.list()[0]!.entries[1]).toMatchObject({ role: "error", text: "503 · synthetic unavailable" });
    expect(f.pollCompare).not.toHaveBeenCalled(); expect(f.cancelCompare).not.toHaveBeenCalled();
  });
});

describe("reviewed Compare cancellation feedback races", () => {
  it("keeps the soft-cancel notice when polling observes CANCELLED before the cancel acknowledgement", async () => {
    const f = fixture("compare"), polling = delayed<any>(), cancellation = delayed<any>();
    f.pollCompare.mockImplementation(() => polling.promise); f.cancelCompare.mockImplementation(() => cancellation.promise);
    const pending = f.run(); await vi.waitFor(() => expect(f.pollCompare).toHaveBeenCalledOnce());
    f.cancel(); polling.resolve({ status: "CANCELLED" }); await pending;
    expect(f.renderCompareAnswer.mock.calls[0]![1]).toMatchObject({ status: "CANCELLED", error: "chat.cancelled" });
    expect(f.sessionStore.list()[0]!.entries[1]).toMatchObject({ role: "error", text: "chat.cancelled" });
    expect(f.pollCompare.mock.calls[0][2]!.signal!.aborted).toBe(true);
    cancellation.resolve({ success: true, status: "CANCELLED" }); await Promise.resolve();
    expect(f.sessionStore.list()[0]!.entries).toHaveLength(2); expect(f.hint.style.display).toBe("none");
  });
  it("clears the failed-cancel notice as soon as retry begins and keeps it cleared after acknowledgement", async () => {
    const f = fixture("compare"), polling = delayed<any>(), cancellation = delayed<any>();
    f.pollCompare.mockImplementation(() => polling.promise);
    f.cancelCompare.mockRejectedValueOnce(new client.ApiError(503, "synthetic failure")).mockImplementationOnce(() => cancellation.promise);
    const pending = f.run(); await vi.waitFor(() => expect(f.pollCompare).toHaveBeenCalledOnce());
    f.cancel(); await vi.waitFor(() => expect(f.cancelBtn.disabled).toBe(false));
    expect(f.hint).toMatchObject({ textContent: "chat.cancelFailed", style: { display: "block" } });
    f.cancel(); expect(f.hint.style.display).toBe("none"); expect(f.hint.textContent).toBe("");
    cancellation.resolve({ success: true, status: "CANCELLED" }); await pending;
    expect(f.hint.style.display).toBe("none"); expect(f.hint.textContent).toBe("");
  });
  it.each(["COMPLETED", "FAILED", "CANCELLED"] as const)("clears failed-cancel feedback when polling finishes %s", async status => {
    const f = fixture("compare"), polling = delayed<any>(); f.pollCompare.mockImplementation(() => polling.promise);
    f.cancelCompare.mockRejectedValueOnce(new client.ApiError(503, "synthetic failure"));
    const pending = f.run(); await vi.waitFor(() => expect(f.pollCompare).toHaveBeenCalledOnce());
    f.cancel(); await vi.waitFor(() => expect(f.cancelBtn.disabled).toBe(false)); expect(f.hint.style.display).toBe("block");
    polling.resolve({ status, findings: { multiModel: { finalAnswer: "terminal answer", perModel: [{ provider: "synthetic", model: "synthetic", answer: "paid partial", costUsd: 0.002 }], totalCostUsd: 0.002 } } });
    await pending; expect(f.hint.style.display).toBe("none"); expect(f.hint.textContent).toBe("");
    if (status === "CANCELLED") {
      expect(f.renderCompareAnswer.mock.calls[0]![1]).toMatchObject({ error: "chat.cancelled", totalCostUsd: 0.002, perModel: [{ answer: "paid partial" }] });
      expect(f.sessionStore.list()[0]!.entries[1]!.text).toBe("chat.cancelled");
    }
  });
  it.each(["new chat", "load session"])("clears failed-cancel feedback on %s and ignores the later poll result", async boundary => {
    const f = fixture("compare"), polling = delayed<any>(); f.pollCompare.mockImplementation(() => polling.promise);
    f.cancelCompare.mockRejectedValueOnce(new client.ApiError(503, "synthetic failure"));
    const pending = f.run(); await vi.waitFor(() => expect(f.pollCompare).toHaveBeenCalledOnce());
    f.cancel(); await vi.waitFor(() => expect(f.cancelBtn.disabled).toBe(false)); expect(f.hint.style.display).toBe("block");
    if (boundary === "new chat") f.newChat(); else f.load(f.sessionStore.list()[0]!.id);
    expect(f.hint.style.display).toBe("none"); expect(f.hint.textContent).toBe(""); expect(f.cancelBtn.style.display).toBe("none");
    polling.resolve({ status: "CANCELLED" }); await pending;
    expect(f.hint.style.display).toBe("none"); expect(f.renderCompareAnswer).not.toHaveBeenCalled();
  });
});

describe("daemon chat lane (plan 1.3)", () => {
  it("creates the conversation in the daemon, streams the turn and keeps no local transcript", async () => {
    const f = fixture("daemon"); await f.run();
    expect(f.daemon.createConversation).toHaveBeenCalledWith({ title: "A-prompt", provider: "OLLAMA", model: "synthetic-model" });
    expect(f.daemon.sendMessage).toHaveBeenCalledWith("cv_A", "A-prompt", expect.any(Object));
    expect(f.sessionStore.list()).toEqual([]);
    expect(JSON.stringify(f.native.mock.calls.find(call => call[0] === "request_action"))).toContain("local.dispatch");
    expect(f.renderErrorCard).not.toHaveBeenCalled();
    expect(f.refreshDaemonConversations).toHaveBeenCalled();
    expect(f.sendBtn.disabled).toBe(false);
  });
  it("blocks a daemon turn without a usable model before governance or clearing the draft", async () => {
    const f = fixture("daemon");
    f.readDaemonModel.mockReturnValue({ error: "chat.daemonNoModels" });
    await f.run();
    expect(f.showDaemonHint).toHaveBeenCalledWith("chat.daemonNoModels");
    expect(f.native).not.toHaveBeenCalled(); expect(f.daemon.createConversation).not.toHaveBeenCalled();
    expect(f.ta.value).toBe("A-prompt");
  });
  it("Kill aborts the daemon turn (abort + disconnect) and ignores its late result", async () => {
    const f = fixture("daemon"), response = delayed<any>();
    f.daemon.sendMessage.mockImplementation(() => response.promise);
    const pending = f.run(); await vi.waitFor(() => expect(f.daemon.sendMessage).toHaveBeenCalled());
    f.stop();
    expect(f.daemon.abort).toHaveBeenCalledWith("cv_A");
    expect(f.daemon.cancelStream).toHaveBeenCalledWith("cv_A");
    response.resolve({ text: "late", stopReason: "aborted" }); await pending;
    expect(f.renderErrorCard).not.toHaveBeenCalled();
    expect(f.sessionStore.list()).toEqual([]);
    expect(f.sendBtn.disabled).toBe(false);
  });
  it("Stop asks the daemon to abort gracefully and keeps the stream open for the partial answer", async () => {
    const f = fixture("daemon"), response = delayed<any>();
    f.daemon.sendMessage.mockImplementation(() => response.promise);
    const pending = f.run(); await vi.waitFor(() => expect(f.daemon.sendMessage).toHaveBeenCalled());
    f.cancel();
    expect(f.daemon.abort).toHaveBeenCalledWith("cv_A");
    expect(f.daemon.cancelStream).not.toHaveBeenCalled();
    response.resolve({ text: "partial", stopReason: "aborted" }); await pending;
    expect(f.renderErrorCard).not.toHaveBeenCalled();
  });
  it.each([
    [new DaemonError(409, "busy", "a turn is already streaming"), "chat.daemonBusy"],
    [new DaemonError(400, "missing-key", "no anthropic key; run: braavo keys add anthropic"), "chat.daemonMissingKey"],
    [new DaemonError(0, "not-running", "daemon-not-running"), "chat.daemonOffline"],
  ])("maps %s to an honest error card", async (error, key) => {
    const f = fixture("daemon");
    f.daemon.sendMessage.mockImplementation(async () => { throw error; });
    await f.run();
    expect(f.renderErrorCard).toHaveBeenCalledWith(key);
    expect(f.sendBtn.disabled).toBe(false);
  });
});

describe("UI-02 sohbet durum/hata kartları (gerçek kapanışlar)", () => {
  it("direct modda tek durum kartı, model adıyla", async () => {
    const f = fixture("direct");
    await f.run();
    expect(f.renderStatusCard).toHaveBeenCalledTimes(1);
    expect(f.renderStatusCard).toHaveBeenCalledWith("synthetic-model", expect.objectContaining({ target: expect.any(Function), open: expect.any(Function) }));
  });
  it("Değişiklikleri gör yalnız çalışma yolu varken Değişiklikler sekmesini açar", () => {
    const f = fixture("cascade");
    expect(f.seeDetails.target()).toBe("detail");
    expect(f.seeDetails.label("detail")).toBe("chat.seeDetails");
    f.changesPathInput.value = "/repo";
    expect(f.seeDetails.target()).toBe("changes");
    expect(f.seeDetails.label("changes")).toBe("chat.seeChanges");
    f.seeDetails.open("changes");
    expect(f.showTab).toHaveBeenCalledWith("changes");
  });
  it("yeniden dene: başka tur sürerken false döner ve kartı korur", async () => {
    const f = fixture("daemon"), response = delayed<any>();
    f.daemon.sendMessage.mockImplementation(async () => response.promise);
    const pending = f.run(); await vi.waitFor(() => expect(f.daemon.sendMessage).toHaveBeenCalled());
    expect(f.retry("baska", "daemon")).toBe(false);
    response.resolve({ text: "ok", stopReason: "end_turn" }); await pending;
  });
  it("yeniden dene: taslağı korur, kartın kendi isteğini ve modunu kullanır, kullanıcı mesajını çoğaltmaz", async () => {
    const f = fixture("local");
    f.ollamaChat.mockImplementationOnce(async () => { throw new Error("gecici"); });
    await f.run();
    expect(f.renderErrorCard).toHaveBeenCalledTimes(1);
    const retry = f.retries[f.retries.length - 1]!;
    f.setMode("cascade"); // kullanıcı o arada başka moda geçti
    f.ta.value = "yazdigim taslak";
    expect(retry()).toBe(true);
    await vi.waitFor(() => expect(f.ollamaChat).toHaveBeenCalledTimes(2));
    expect((f.ollamaChat.mock.calls[1] as unknown[])[2]).toBe("A-prompt"); // hata anındaki istek, mod local
    await vi.waitFor(() => expect(f.sendBtn.disabled).toBe(false));
    expect(f.ta.value).toBe("yazdigim taslak");
    const entries = f.sessionStore.list()[0].entries;
    expect(entries.filter(e => e.role === "user")).toHaveLength(1);
  });
  it("BRA-UI-09: ek, gerçek run() kapanışında tek istekle gider; sohbet kaydı yalnız yazılan metni tutar; yeniden dene eki korur", async () => {
    const f = fixture("local");
    f.attachTray.add({ id: 1, name: "satis.csv", size: 7, content: "a,b\n1,2" });
    f.ollamaChat.mockImplementationOnce(async () => { throw new Error("gecici"); });
    await f.run();
    const wire = (f.ollamaChat.mock.calls[0] as unknown[])[2] as string;
    expect(wire).toContain("a,b\n1,2");
    expect(splitWire(wire)).toEqual({ text: "A-prompt", files: [{ name: "satis.csv", size: 7 }] });
    expect(f.attachTray.items()).toHaveLength(0); // gönderimle boşaldı
    expect(f.renderSentChips).toHaveBeenCalledTimes(1);
    expect((f.renderSentChips.mock.calls[0] as unknown[])[0]).toEqual([expect.objectContaining({ name: "satis.csv" })]);
    expect(f.sessionStore.list()[0].entries.filter(e => e.role === "user").map(e => e.text)).toEqual(["A-prompt"]); // içerik kaydedilmez
    const retry = f.retries[f.retries.length - 1]!;
    expect(retry()).toBe(true);
    await vi.waitFor(() => expect(f.ollamaChat).toHaveBeenCalledTimes(2));
    expect((f.ollamaChat.mock.calls[1] as unknown[])[2]).toBe(wire); // aynı istek, ek dahil
    await vi.waitFor(() => expect(f.sendBtn.disabled).toBe(false));
    expect(f.renderSentChips).toHaveBeenCalledTimes(1); // yeniden denemede balon/çip çoğalmaz
  });
  it("BRA-UI-09: sesli tur bekleyen eki götürmez; yazılı gönderim götürür", async () => {
    const f = fixture("local");
    f.attachTray.add({ id: 1, name: "a.txt", size: 1, content: "ICERIK" });
    await (f.run as unknown as (retry?: unknown, voice?: { text: string; token: number }) => Promise<void>)(undefined, { text: "sesle sordum", token: 1 });
    expect((f.ollamaChat.mock.calls[0] as unknown[])[2]).toBe("sesle sordum");
    expect(f.attachTray.items()).toHaveLength(1);
    await f.run();
    expect((f.ollamaChat.mock.calls[1] as unknown[])[2]).toContain("ICERIK");
    expect(f.attachTray.items()).toHaveLength(0);
  });
  it("BRA-UI-09: ek varken boş metin ipucu verir ve gitmez; tel boyutu aşılırsa açık hata verir ve ek silinmez", async () => {
    const f = fixture("local");
    f.attachTray.add({ id: 1, name: "a.txt", size: 1, content: "x" });
    f.ta.value = "";
    await f.run();
    expect(f.ollamaChat).not.toHaveBeenCalled();
    expect(f.hint).toMatchObject({ textContent: "attach.needText", style: { display: "block" } });
    f.ta.value = "A-prompt";
    f.attachTray.take();
    f.attachTray.add({ id: 2, name: "big.txt", size: 100, content: "\"\n".repeat(80_000) }); // 160k chars, 320k bytes escaped
    await f.run();
    expect(f.ollamaChat).not.toHaveBeenCalled();
    expect(f.hint).toMatchObject({ textContent: "attach.errWireTooBig", style: { display: "block" } });
    expect(f.attachTray.items()).toHaveLength(1);
    expect(f.sendBtn.disabled).toBe(false);
  });
  it("BRA-UI-09: reddedilen gönderim (ön denetim) ekleri tutar", async () => {
    const f = fixture("compare");
    f.companyInput.value = "";
    f.attachTray.add({ id: 1, name: "a.txt", size: 1, content: "x" });
    await f.run();
    expect(f.startCompare).not.toHaveBeenCalled();
    expect(f.attachTray.items()).toHaveLength(1);
  });
  it("kayıtlı oturumdaki hata kartında yeniden dene yoktur", () => {
    const f = fixture("cascade");
    const session = f.sessionStore.create();
    f.sessionStore.append(session.id, { role: "user", mode: "cascade", text: "eski", at: 1 });
    f.sessionStore.append(session.id, { role: "error", mode: "cascade", text: "eski hata", at: 2 });
    f.load(session.id);
    expect(f.retries[f.retries.length - 1]).toBeUndefined();
  });
  it("yeniden dene: daemon çevrimdışıyken dağıtım olmaz, false döner (kart kalır)", async () => {
    const f = fixture("daemon");
    f.daemon.sendMessage.mockImplementation(async () => { throw new DaemonError(0, "not-running", "daemon-not-running"); });
    await f.run();
    const retry = f.retries[f.retries.length - 1]!;
    f.readDaemonModel.mockImplementation(() => ({ error: "model yok" }));
    const calls = f.daemon.sendMessage.mock.calls.length;
    expect(retry()).toBe(false);
    expect(f.daemon.sendMessage.mock.calls.length).toBe(calls);
    expect(f.sendBtn.disabled).toBe(false);
  });
  it("yeniden dene: compare'de şirket kimliği boşsa false döner (kart kalır)", async () => {
    const f = fixture("local");
    f.ollamaChat.mockImplementationOnce(async () => { throw new Error("gecici"); });
    await f.run();
    const retry = f.retries[f.retries.length - 1]!;
    f.setMode("compare");
    f.companyInput.value = "";
    const calls = f.startCompare.mock.calls.length;
    // kart kendi modunu (local) kullanır; compare'e geçilmiş olması etkilemez → dağıtım olur
    expect(retry()).toBe(true);
    await vi.waitFor(() => expect(f.sendBtn.disabled).toBe(false));
    expect(f.startCompare.mock.calls.length).toBe(calls);
  });
  it("yeniden dene: compare kartı şirket kimliği boşken dağıtmaz, false döner", async () => {
    const f = fixture("compare");
    f.pollCompare.mockImplementation(async () => { throw new Error("gecici"); });
    await f.run();
    const retry = f.retries[f.retries.length - 1];
    expect(retry).toBeDefined();
    f.companyInput.value = "";
    const calls = f.startCompare.mock.calls.length;
    expect(retry!()).toBe(false);
    expect(f.startCompare.mock.calls.length).toBe(calls);
  });
});
