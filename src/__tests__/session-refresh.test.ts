/** Real boot/session/client source with a delayed synthetic secure store. No Tauri invocation. */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, logout } from "../client";
import { DEFAULT_API, setPersist, type Config } from "../config";
import { performSignOut } from "../session";
import * as storeModule from "../store";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function resp(status: number, body: unknown) {
  return { status, ok: status === 200, statusText: String(status), json: async () => body };
}
const source = ts.createSourceFile("main.ts", readFileSync(new URL("../main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const bootNode = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "boot");
if (!bootNode) throw Error("Missing real boot source");
const compiled = ts.transpileModule(bootNode.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

async function bootFixture(blockRotationWrite = false) {
  let state: { token?: string; refreshToken?: string } = { token: "A-old", refreshToken: "A-refresh-old" };
  const writeStarted = deferred<void>(); const writeRelease = deferred<void>();
  const store: storeModule.SecretStore = {
    get: async () => ({ ...state }),
    set: async (value) => {
      const snapshot = { ...value };
      if (blockRotationWrite && value.token === "A-new") { writeStarted.resolve(); await writeRelease.promise; }
      state = snapshot;
    },
    clear: async () => { state = {}; },
  };
  let deps!: { cfg: Config; persist: (cfg: Config) => Promise<void>; onSignedOut: () => void };
  const renderLogin = vi.fn();
  const boot = runInNewContext(`${compiled}\nboot;`, {
    ...storeModule, DEFAULT_API, setPersist,
    document: { getElementById: () => ({}), documentElement: {} },
    resolveStore: () => store, loadApiUrl: (fallback: string) => fallback,
    resolveKeyVault: () => ({}), resolveSpawnProbe: () => ({}), resolveGovernance: () => ({}),
    resolveMcpBridge: () => ({}), detectLocale: () => "en", makeT: () => (key: string) => key,
    renderWorkspace: (value: typeof deps) => { deps = value; }, renderLogin,
    clearAllSessions: vi.fn(),
  }) as () => Promise<void>;
  await boot();
  return { deps, state: () => ({ ...state }), writeStarted, writeRelease, renderLogin };
}

afterEach(() => { setPersist(() => {}); });

describe("actual desktop sign-out with API refresh", () => {
  it("keeps real sign-out cleared after the pending refresh returns", async () => {
    const f = await bootFixture(); const refresh = deferred<ReturnType<typeof resp>>();
    const started = deferred<void>();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/logout")) return resp(200, {});
      if (url.endsWith("/auth/refresh")) { started.resolve(); return refresh.promise; }
      return resp(401, {});
    });
    const result = apiFetch("/billing/savings", { cfg: f.deps.cfg, fetchImpl }).catch(error => error);
    await started.promise;
    performSignOut(f.deps.cfg, f.deps, c => logout(c, { fetchImpl }));
    refresh.resolve(resp(200, { token: "A-new", refreshToken: "A-refresh-new" }));
    const outcome = await result;
    expect(f.deps.cfg.token).toBeUndefined(); expect(f.deps.cfg.refreshToken).toBeUndefined();
    expect(outcome).toMatchObject({ name: "SessionChangedError" });
    await vi.waitFor(() => expect(f.state()).toEqual({}));
    expect(f.renderLogin).toHaveBeenCalledOnce();
    const logoutCall = fetchImpl.mock.calls.find(([url]) => url.endsWith("/auth/logout"));
    expect(logoutCall).toBeDefined();
  });

  it("does not let an already dispatched secret write finish after sign-out cleanup", async () => {
    const f = await bootFixture(true);
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/auth/refresh")
      ? resp(200, { token: "A-new", refreshToken: "A-refresh-new" }) : resp(401, {}));
    const result = apiFetch("/billing/savings", { cfg: f.deps.cfg, fetchImpl }).catch(error => error);
    await f.writeStarted.promise;
    performSignOut(f.deps.cfg, f.deps, async () => {});
    f.writeRelease.resolve();
    const outcome = await result;
    expect(f.state()).toEqual({});
    expect(outcome).toMatchObject({ name: "SessionChangedError" });
    expect(f.deps.cfg.token).toBeUndefined();
  });

  it("invalidates old requests even when the same token pair is restored after sign-out", async () => {
    const f = await bootFixture(); const response = deferred<ReturnType<typeof resp>>();
    const result = apiFetch("/billing/savings", { cfg: f.deps.cfg, fetchImpl: async () => response.promise }).catch(error => error);
    performSignOut(f.deps.cfg, f.deps, async () => {});
    f.deps.cfg.token = "A-old"; f.deps.cfg.refreshToken = "A-refresh-old";
    response.resolve(resp(200, { accountAData: true }));
    expect(await result).toMatchObject({ name: "SessionChangedError" });
  });
});
