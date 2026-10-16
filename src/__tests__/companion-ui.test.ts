import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { captureSession, invalidateSession, isCurrentSession } from "../client";
import type { Config } from "../config";

// Execute the actual settings handlers; transport/native effects are synthetic.
const source = ts.createSourceFile("ui.ts", readFileSync(new URL("../ui.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const workspace = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "renderWorkspace")!;
function local(name: string) {
  let found: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(source) === name)) found = node.getText(source);
    ts.forEachChild(node, visit);
  };
  visit(workspace); if (!found) throw Error(`Missing actual companion closure ${name}`); return found;
}
const compiled = ts.transpileModule(`let workspaceDisposed=false,activeRelayStopper=null;\n${["compBridge", "startingCompanion", "baseGov", "syncComp", "stopCompanion", "startCompanion"].map(local).join("\n")}\n({start:startCompanion,stop:stopCompanion,dispose:()=>{workspaceDisposed=true;return stopCompanion()},bridge:()=>compBridge,stopper:()=>activeRelayStopper});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function delayed<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const cfg: Config = { apiUrl: "https://synthetic.invalid/api/v1", token: "A-token" };
  const baseGov = { synthetic: "base" }, decorated = { synthetic: "decorated" };
  const deps = { gov: baseGov };
  const toggle = { disabled: false, classList: { toggle: vi.fn() } }, status = { textContent: "off" };
  const bridges: { handlers: any; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
  const register = vi.fn(async () => ({ sessionId: "synthetic-session" }));
  const resolveApproval = vi.fn(async () => ({ resolved: true, token: "synthetic-grant" }));
  const resolveRejection = vi.fn(async () => {}), killEverything = vi.fn(async () => {}), run = vi.fn(), record = vi.fn();
  class Bridge {
    handlers: any; start = register; stop = vi.fn(async () => {}); emitAudit = vi.fn(async () => {});
    constructor(_transport: unknown, handlers: any) { this.handlers = handlers; bridges.push(this); }
  }
  const ui = runInNewContext(compiled, { cfg, deps, captureSession, isCurrentSession, compToggle: toggle, compStatus: status,
    t: (key: string) => key, createRelayTransport: vi.fn(), RelayBridge: Bridge, bridgeGovernance: () => decorated,
    activeSession: null, dispatching: false, mode: "compare", nextDispatchRemote: false, ta: { value: "" },
    record, run, resolveApproval, resolveRejection, openApprovals: new Map(), killEverything,
  }) as { start(): Promise<void>; stop(): Promise<void>; dispose(): Promise<void>; bridge(): unknown; stopper(): unknown };
  return { ...ui, cfg, deps, baseGov, decorated, toggle, status, bridges, register, resolveApproval, resolveRejection, killEverything, run, record };
}

describe("actual companion startup, stop and error feedback", () => {
  it("installs the bridge once and removes it immediately when stopped", async () => {
    const f = fixture(); await f.start(); expect(f.bridge()).toBe(f.bridges[0]); expect(f.deps.gov).toBe(f.decorated);
    expect(f.status.textContent).toBe("settings.companionOn"); expect(f.toggle.disabled).toBe(false);
    const end = delayed<void>(); f.bridges[0].stop.mockImplementation(() => end.promise);
    const stopping = f.stop(); expect(f.bridge()).toBeNull(); expect(f.stopper()).toBeNull(); expect(f.deps.gov).toBe(f.baseGov);
    end.resolve(); await stopping;
  });
  it("keeps a startup failure visible after cleanup and allows retry", async () => {
    const f = fixture(); f.register.mockRejectedValueOnce(new Error("RAW_PRIVATE_DETAIL"));
    await f.start(); expect(f.status.textContent).toBe("settings.companionErr"); expect(f.toggle.disabled).toBe(false);
    expect(f.bridge()).toBeNull(); expect(f.stopper()).toBeNull(); expect(f.deps.gov).toBe(f.baseGov);
    await f.start(); expect(f.status.textContent).toBe("settings.companionOn");
  });
  it("ignores duplicate starts while registration is pending", async () => {
    const f = fixture(), registration = delayed<{ sessionId: string }>(); f.register.mockImplementation(() => registration.promise);
    const pending = f.start(); await f.start(); expect(f.register).toHaveBeenCalledOnce();
    registration.resolve({ sessionId: "synthetic-session" }); await pending;
  });
  it.each(["dispose", "logout", "replacement", "api", "stop"])("does not restore a delayed startup or dispatch old commands after %s", async boundary => {
    const f = fixture(), registration = delayed<{ sessionId: string }>(); f.register.mockImplementation(() => registration.promise);
    const pending = f.start();
    if (boundary === "dispose") await f.dispose();
    if (boundary === "stop") await f.stop();
    if (boundary === "logout") { invalidateSession(f.cfg); f.cfg.token = undefined; }
    if (boundary === "replacement") f.cfg.token = "B-token";
    if (boundary === "api") f.cfg.apiUrl = "https://other.invalid/api/v1";
    registration.resolve({ sessionId: "old-session" }); await pending;
    const handlers = f.bridges[0].handlers;
    handlers.onSteer("old prompt"); await handlers.onApprove("old action"); await handlers.onReject("old action"); await handlers.onKill();
    expect(f.bridge()).toBeNull(); expect(f.stopper()).toBeNull(); expect(f.deps.gov).toBe(f.baseGov);
    expect(f.bridges[0].stop).toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled(); expect(f.record).not.toHaveBeenCalled();
    expect(f.resolveApproval).not.toHaveBeenCalled(); expect(f.resolveRejection).not.toHaveBeenCalled(); expect(f.killEverything).not.toHaveBeenCalled();
  });
  it("does not let an old registration replace a newer pending start", async () => {
    const f = fixture(), first = delayed<{ sessionId: string }>(), second = delayed<{ sessionId: string }>();
    f.register.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const old = f.start(); await f.stop(); const current = f.start();
    first.resolve({ sessionId: "old" }); await old; expect(f.toggle.disabled).toBe(true); expect(f.bridge()).toBeNull(); expect(f.stopper()).not.toBeNull();
    second.resolve({ sessionId: "new" }); await current; expect(f.bridge()).toBe(f.bridges[1]); expect(f.toggle.disabled).toBe(false);
  });
});
