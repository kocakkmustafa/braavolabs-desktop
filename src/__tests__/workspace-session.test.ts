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
const compiled = ts.transpileModule(`${gates}\nlet mode='cascade', dispatching=false, chatMotionVersion=0, workspaceDisposed=false, activeSession=null, nextDispatchRemote=false;\n${local("record")}\n${local("startNewSession")}\n${local("run")}\n({ run, newChat:startNewSession, dispose:()=>{workspaceDisposed=true}, setMode:(value)=>{mode=value} });`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
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
  const pollCompare = vi.fn(async () => ({ status: "COMPLETED", finalAnswer: "A-answer" }));
  const renderCascadeAnswer = vi.fn(), renderPlainAnswer = vi.fn(), renderCompareAnswer = vi.fn();
  const refreshSavings = vi.fn(async () => {}), sendBtn = element();
  const deps = { cfg, gov, vault: { get }, persist, t: (key: string) => key };
  const ui = runInNewContext(compiled, {
    ...client, deps, cfg, sessionStore, t: deps.t,
    ta: { value: "A-prompt", focus() {} }, companyInput: { value: "A-company" },
    localModelInput: { value: "synthetic-model" }, directProviderSel: { value: "synthetic-provider" }, directModelInput: { value: "synthetic-model" },
    hint: element(), sendBtn, scroll: element(), inspectorBody: element(), surface: "chat",
    document: { createTextNode: (text: string) => ({ textContent: text }) }, thinkingMotions: new Map(),
    el: element, scrollToEnd() {}, setChatMotion() {}, syncCrumb() {}, refreshSessionList() {}, trackMotion() {},
    createOwnedBrandMotion: () => null, answerMotion: () => "success", compareMotion: () => "success", compareProgressMotion: () => "thinking",
    renderErrorCard() {}, renderCascadeAnswer, renderCascadeInspector() {}, renderPlainAnswer, renderCompareAnswer, renderCompareInspector() {}, renderSourceInspector() {},
    bumpActivity() {}, refreshSavings, removeThinking: (row: ReturnType<typeof element>) => row.remove(),
    toCascadeView, toCompareView, cascade, startCompare, pollCompare,
    resolveOllamaHost: () => "http://localhost:11434", resolveOllamaModel, ollamaChat,
    isDirectProvider: () => true, resolveDirectModel: () => "synthetic-model", directChat,
    OllamaUnreachableError: class extends Error {}, DirectApiError: class extends Error {},
  }) as { run(): Promise<void>; newChat(): void; dispose(): void; setMode(mode: string): void };
  ui.setMode(mode);
  const switchOwner = (boundary: "logout" | "B" | "base" | "dispose" | "same-pair") => {
    if (boundary === "dispose") { ui.dispose(); return; }
    if (boundary === "base") { cfg.apiUrl = "https://other.example.invalid/api/v1"; return; }
    performSignOut(cfg, { persist, onSignedOut: () => { ui.dispose(); values.clear(); } }, async () => {});
    if (boundary === "B" || boundary === "same-pair") {
      client.invalidateSession(cfg); cfg.token = boundary === "B" ? "B-token" : "A-token"; cfg.refreshToken = boundary === "B" ? "B-refresh" : "A-refresh";
      void persist(cfg);
    }
  };
  return { ...ui, cfg, deps, native, grant, fetchImpl, cascade, resolveOllamaModel, ollamaChat, directChat, get, startCompare, pollCompare, renderCascadeAnswer, renderPlainAnswer, renderCompareAnswer, refreshSavings, sessionStore, sendBtn, switchOwner };
}

describe("actual workspace operation ownership", () => {
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
