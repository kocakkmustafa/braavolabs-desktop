import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCALES, MESSAGES, makeT } from "../i18n";
import { createMemoryKeyVault } from "../keyvault";
import {
  CHECK_INTERVAL_MS, LATEST_URL, UPDATE_DISMISSED_KEY, UPDATE_FLAG_KEY, UPDATE_LAST_KEY, bannerVisible, checkDue, checkForUpdate,
  compareSemver, createUpdateChecker, isReleaseUrl, isUpdateEnabled, parseSemver, validateRelease, type FetchFn,
} from "../update";
import {
  SETUP_DONE_KEY, SETUP_FLAG_KEY, computerReady, isSetupDone, isSetupEnabled, mapPermissions, planSteps, readHostStatus, readMic, requestMic, summarize,
  type PermId,
} from "../setup";
import { mountSetup } from "../setup-view";
import { buildAbout, mountUpdate, openReleasePage } from "../update-view";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const REL = "https://github.com/kocakkmustafa/braavolabs-desktop/releases/tag/v1.2.0";
const release = (over: Record<string, unknown> = {}) => ({ tag_name: "v1.2.0", html_url: REL, draft: false, prerelease: false, name: "<img src=x onerror=alert(1)>", body: "notes", ...over });
const ok = (body: unknown): ReturnType<FetchFn> => Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const mem = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
};

describe("semver and answer validation", () => {
  it("parses and compares versions, pre-releases below their release", () => {
    expect(parseSemver("v1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3, pre: null });
    for (const bad of ["1.2", "1.2.3.4", "latest", "", "1.2.x", "v", 5, null, "1.2.3 ", "1.2.3-"]) {
      if (bad === "1.2.3 ") expect(parseSemver(bad)).not.toBeNull(); // trimmed
      else expect(parseSemver(bad), String(bad)).toBeNull();
    }
    const c = (a: string, b: string) => compareSemver(parseSemver(a)!, parseSemver(b)!);
    expect(c("1.2.0", "1.1.9")).toBe(1);
    expect(c("1.10.0", "1.9.0")).toBe(1);
    expect(c("1.1.0", "1.1.0")).toBe(0);
    expect(c("2.0.0", "10.0.0")).toBe(-1);
    expect(c("1.2.0-rc.1", "1.2.0")).toBe(-1);
    expect(c("1.2.0-rc.2", "1.2.0-rc.10")).toBe(-1);
  });
  it("accepts only a full, public, https github.com/kocakkmustafa/ answer", () => {
    expect(validateRelease(release())).toEqual({ version: "1.2.0", url: REL });
    expect(validateRelease(release({ draft: true }))).toBeNull();
    expect(validateRelease(release({ prerelease: true }))).toBeNull();
    expect(validateRelease(release({ tag_name: "v1.2.0-beta.1" }))).toBeNull();
    expect(validateRelease(release({ tag_name: "nightly" }))).toBeNull();
    for (const html_url of ["http://github.com/kocakkmustafa/x", "https://github.com/evil/x", "https://github.com.evil.io/kocakkmustafa/x", "javascript:alert(1)", "https://github.com/kocakkmustafa/x y", "https://github.com/kocakkmustafa/../x", "https://github.com/kocakkmustafa/x@e.io", 5, null])
      expect(validateRelease(release({ html_url })), String(html_url)).toBeNull();
    for (const bad of [null, [], "x", 3, {}]) expect(validateRelease(bad)).toBeNull();
    expect(isReleaseUrl(REL)).toBe(true);
    expect(isReleaseUrl("https://github.com/kocakkmustafa/")).toBe(false);
  });
  it("is due once a day; a missing, broken or future time counts as due", () => {
    const now = 10 * CHECK_INTERVAL_MS;
    expect(checkDue(null, now)).toBe(true);
    expect(checkDue("abc", now)).toBe(true);
    expect(checkDue(String(now + 5), now)).toBe(true);
    expect(checkDue(String(now - 1000), now)).toBe(false);
    expect(checkDue(String(now - CHECK_INTERVAL_MS), now)).toBe(true);
  });
});

describe("the one request", () => {
  it("is a single anonymous GET to api.github.com", async () => {
    const fetchFn = vi.fn<FetchFn>(() => ok(release()));
    const r = await checkForUpdate("1.1.0", fetchFn);
    expect(r).toEqual({ kind: "newer", version: "1.2.0", url: REL });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(LATEST_URL);
    expect(url.startsWith("https://api.github.com/")).toBe(true);
    expect(init).toMatchObject({ method: "GET", credentials: "omit", referrerPolicy: "no-referrer" });
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization|cookie|token/i);
  });
  it("says current for the same or an older release", async () => {
    expect(await checkForUpdate("1.2.0", () => ok(release()))).toEqual({ kind: "current" });
    expect(await checkForUpdate("1.3.0", () => ok(release()))).toEqual({ kind: "current" });
  });
  it("fails quietly on network errors, rate limits, odd bodies and oversized bodies", async () => {
    expect(await checkForUpdate("1.1.0", () => Promise.reject(new TypeError("offline")))).toEqual({ kind: "failed" });
    expect(await checkForUpdate("1.1.0", () => Promise.resolve({ ok: false, status: 403, text: async () => "{}" }))).toEqual({ kind: "failed" });
    expect(await checkForUpdate("1.1.0", () => Promise.resolve({ ok: false, status: 429, text: async () => "{}" }))).toEqual({ kind: "failed" });
    expect(await checkForUpdate("1.1.0", () => Promise.resolve({ ok: true, status: 200, text: async () => "<html>" }))).toEqual({ kind: "failed" });
    expect(await checkForUpdate("1.1.0", () => Promise.resolve({ ok: true, status: 200, text: async () => " ".repeat(600 * 1024) }))).toEqual({ kind: "failed" });
    expect(await checkForUpdate("1.1.0", () => ok(release({ draft: true })))).toEqual({ kind: "failed" });
    expect(await checkForUpdate("not-a-version", () => ok(release()))).toEqual({ kind: "failed" });
  });
});

describe("checker: at most one automatic request a day", () => {
  it("asks once, then only restores the last answer until a day has passed", async () => {
    const storage = mem();
    let t = 1_000_000_000_000;
    const fetchFn = vi.fn<FetchFn>(() => ok(release()));
    const mk = () => createUpdateChecker({ current: "1.1.0", storage, fetchFn, now: () => t });
    const a = mk();
    await a.auto();
    expect(a.state()).toMatchObject({ phase: "newer", version: "1.2.0", url: REL });
    expect(bannerVisible(a.state())).toBe(true);
    t += 60_000;
    const b = mk(); // a restart within the day
    await b.auto();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(b.state()).toMatchObject({ phase: "newer", version: "1.2.0" });
    t += CHECK_INTERVAL_MS;
    await b.auto();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it("does not retry a failing network more than once a day, and the install of the new version clears the banner", async () => {
    const storage = mem();
    const t = 5_000_000_000_000;
    const fail = vi.fn<FetchFn>(() => Promise.reject(new TypeError("offline")));
    const c = createUpdateChecker({ current: "1.1.0", storage, fetchFn: fail, now: () => t });
    await c.auto(); await c.auto();
    expect(fail).toHaveBeenCalledTimes(1);
    expect(c.state().phase).toBe("failed");
    expect(bannerVisible(c.state())).toBe(false); // silent in the main window
    const s2 = mem({ [UPDATE_LAST_KEY]: String(t - 1000), "bv.prefs.updateSeen": JSON.stringify({ version: "1.2.0", url: REL }) });
    const installed = createUpdateChecker({ current: "1.2.0", storage: s2, fetchFn: fail, now: () => t });
    await installed.auto();
    expect(installed.state().phase).toBe("current");
  });
  it("'Later' hides this version only; a newer one shows again; manual check ignores the day limit", async () => {
    const storage = mem();
    const fetchFn = vi.fn<FetchFn>(() => ok(release()));
    const c = createUpdateChecker({ current: "1.1.0", storage, fetchFn, now: () => 42_000_000_000_000 });
    await c.auto();
    c.dismiss();
    expect(storage.m.get(UPDATE_DISMISSED_KEY)).toBe("1.2.0");
    expect(bannerVisible(c.state())).toBe(false);
    await c.manual();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(bannerVisible(c.state())).toBe(false);
    fetchFn.mockImplementation(() => ok(release({ tag_name: "v1.3.0", html_url: "https://github.com/kocakkmustafa/braavolabs-desktop/releases/tag/v1.3.0" })));
    await c.manual();
    expect(bannerVisible(c.state())).toBe(true);
  });
  it("works when storage throws", async () => {
    const storage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const c = createUpdateChecker({ current: "1.1.0", storage, fetchFn: () => ok(release()), now: () => 1 });
    await expect(c.auto()).resolves.toBeUndefined();
    expect(c.state().phase).toBe("newer");
  });
});

describe("review fixes", () => {
  it("keeps offering a known newer version when a later check fails, and cleans up subscriptions", async () => {
    stubDom();
    const storage = mem();
    let body: Record<string, unknown> | Error = release();
    const fetchFn: FetchFn = () => (body instanceof Error ? Promise.reject(body) : ok(body));
    const c = createUpdateChecker({ current: "1.1.0", storage, fetchFn, now: () => 9e12 });
    await c.auto();
    body = new TypeError("offline");
    await c.manual();
    expect(c.state()).toMatchObject({ phase: "failed", version: "1.2.0", url: REL });
    expect(bannerVisible(c.state())).toBe(true);
    const ui = mountUpdate({ t: makeT("en"), version: "1.1.0", storage: mem(), fetchFn: () => ok(release()), now: () => 9e12 }, { getItem: (k: string) => (k === UPDATE_FLAG_KEY ? "1" : null) })!;
    await flush();
    const about = ui.about() as unknown as El & { dispose(): void };
    ui.dispose();
    const before = about.text();
    await ui.checker.manual(); await flush();
    expect(about.text()).toBe(before); // no longer subscribed
  });
  it("refuses a declared length over the limit and cuts a stream at the limit", async () => {
    const big = { ok: true, status: 200, headers: { get: () => String(600 * 1024) }, text: async () => JSON.stringify(release()) };
    expect(await checkForUpdate("1.1.0", () => Promise.resolve(big))).toEqual({ kind: "failed" });
    const chunk = new Uint8Array(100 * 1024);
    let reads = 0; const cancel = vi.fn();
    const streaming = { ok: true, status: 200, text: async () => "", body: { getReader: () => ({ read: async () => (++reads < 100 ? { done: false, value: chunk } : { done: true }), cancel }) } };
    expect(await checkForUpdate("1.1.0", () => Promise.resolve(streaming))).toEqual({ kind: "failed" });
    expect(reads).toBeLessThan(10);
    expect(cancel).toHaveBeenCalled();
    const bytes = new TextEncoder().encode(JSON.stringify(release()));
    let sent = false;
    const small = { ok: true, status: 200, text: async () => "", body: { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: bytes })), cancel: () => {} }) } };
    expect(await checkForUpdate("1.1.0", () => Promise.resolve(small))).toMatchObject({ kind: "newer" });
  });
  it("re-reads the permission state when the window gets focus again", async () => {
    stubDom();
    const listeners = new Map<string, () => void>();
    vi.stubGlobal("addEventListener", (n: string, h: () => void) => listeners.set(n, h));
    vi.stubGlobal("removeEventListener", (n: string) => listeners.delete(n));
    let st = { supported: true, accessibility: false, screenRecording: false };
    const ui = mountSetup({ t: makeT("en"), invoke: async (cmd) => (cmd === "computer_status" ? st : undefined), vault: createMemoryKeyVault(), providers: ["anthropic"], storage: mem() });
    await ui.ready; await flush();
    const el = ui.element as unknown as El;
    expect(el.text()).not.toContain("Allowed");
    expect(el.text()).not.toContain("quit and reopen");
    await el.all().filter(e => e.tag === "button" && e.textContent === "Allow")[0].click(); await flush(); // screen recording: asked, host still says no
    expect(el.text()).toContain("quit and reopen"); // existing Screen Recording note
    st = { supported: true, accessibility: true, screenRecording: true }; // the user allowed them in System Settings
    listeners.get("focus")!(); await flush();
    expect(el.text()).toContain("Allowed");
    ui.dispose();
    expect(listeners.has("focus")).toBe(false);
  });
});

describe("flags are default OFF and never set in code", () => {
  it("needs the literal 1", () => {
    for (const [on, f, key] of [[isUpdateEnabled, UPDATE_FLAG_KEY, "bv.flags.updateBanner"], [isSetupEnabled, SETUP_FLAG_KEY, "bv.flags.setup"]] as const) {
      expect(f).toBe(key);
      expect(on({ getItem: () => null })).toBe(false);
      expect(on({ getItem: () => "true" })).toBe(false);
      expect(on({ getItem: () => { throw new Error("x"); } })).toBe(false);
      expect(on({ getItem: (k) => (k === key ? "1" : null) })).toBe(true);
    }
    for (const f of readdirSync(new URL("..", import.meta.url)).filter(n => n.endsWith(".ts")))
      expect(read(`../${f}`), f).not.toMatch(/setItem\(\s*(UPDATE_FLAG_KEY|SETUP_FLAG_KEY|["']bv\.flags\.(setup|updateBanner))/);
    expect(read("../update.ts")).not.toMatch(/UPDATE_FLAG_KEY[^;\n]*(\?\?|\|\|)\s*["']1["']/);
  });
  it("flag off: no banner object, no checker and no network request", async () => {
    const fetchFn = vi.fn<FetchFn>(() => ok(release()));
    expect(mountUpdate({ t: makeT("en"), version: "1.1.0", fetchFn }, { getItem: () => null })).toBeNull();
    await Promise.resolve();
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("ui.ts creates the setup, banner and checker only through the flag-gated modules", () => {
    const ui = read("../ui.ts");
    expect(ui.match(/mountUpdate\(/g)).toHaveLength(1);
    expect(ui.match(/mountSetup\(/g)).toHaveLength(1);
    expect(ui).toMatch(/if \(isSetupEnabled\(\) && !isSetupDone\(\)\) \{\s*const setup = setupUi = mountSetup\(/);
    expect(ui).not.toMatch(/createUpdateChecker|checkForUpdate|api\.github\.com/);
    expect(read("../update-view.ts")).toMatch(/if \(!isUpdateEnabled\(flagStorage\)\) return null;/);
  });
});

// ── a tiny DOM, as in inbox-ui.test.ts ──────────────────────────────────────
class El {
  textContent = ""; className = ""; disabled = false; hidden = false; type = ""; value = ""; placeholder = ""; autocomplete = ""; tabIndex = 0;
  attrs: Record<string, string> = {}; children: El[] = []; handlers = new Map<string, (e?: unknown) => unknown>(); parent: El | null = null;
  constructor(readonly tag: string) {}
  append(...c: El[]) { for (const x of c) { x.parent = this; this.children.push(x); } }
  replaceChildren(...c: El[]) { this.children = []; this.append(...c); }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(n: string, h: (e?: unknown) => unknown) { this.handlers.set(n, h); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); this.parent = null; }
  focus() {}
  all(): El[] { return [this, ...this.children.flatMap(c => c.all())]; }
  text(): string { return [this.textContent, ...this.children.map(c => c.text())].join(" "); }
  button(label: string) { const b = this.all().find(e => e.tag === "button" && e.textContent === label); if (!b) throw new Error(`no button ${label}`); return b; }
  hasButton(label: string) { return this.all().some(e => e.tag === "button" && e.textContent === label); }
  click() { return this.handlers.get("click")?.(); }
}
const stubDom = () => vi.stubGlobal("document", { createElement: (tag: string) => new El(tag) });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
afterEach(() => { vi.unstubAllGlobals(); });

describe("permission rows come from real reports", () => {
  const host = { supported: true, accessibility: false, screenRecording: true };
  const none = new Set<PermId>();
  it("maps the host answer and the microphone answer, never inventing a grant", () => {
    expect(mapPermissions(host, "unknown", none, none)).toEqual([{ id: "screen", state: "granted" }, { id: "accessibility", state: "needed" }, { id: "microphone", state: "needed" }]);
    expect(mapPermissions(host, "unknown", new Set<PermId>(["microphone"]), none)[2].state).toBe("pending");
    expect(mapPermissions(host, "granted", none, none)[2].state).toBe("granted");
    expect(mapPermissions(host, "denied", none, none)[2].state).toBe("notGranted");
    expect(mapPermissions(host, "unknown", new Set<PermId>(["accessibility"]), none)[1].state).toBe("pending"); // asked, still not granted: neutral, not red
    expect(mapPermissions(host, "unknown", none, new Set<PermId>(["accessibility"]))[1].state).toBe("later");
    expect(mapPermissions({ ...host, accessibility: true }, "unknown", new Set<PermId>(["accessibility"]), none)[1].state).toBe("granted");
  });
  it("computer control is ready only when both host permissions are granted (the microphone does not count)", () => {
    expect(computerReady(mapPermissions({ supported: true, accessibility: true, screenRecording: true }, "prompt", none, none))).toBe(true);
    expect(computerReady(mapPermissions(host, "granted", none, none))).toBe(false);
  });
  it("reads an unknown host answer defensively and plans the steps", () => {
    expect(readHostStatus(null)).toBeNull();
    expect(readHostStatus({ accessibility: true })).toBeNull();
    expect(readHostStatus({ supported: true, accessibility: "yes" })).toEqual({ supported: true, accessibility: false, screenRecording: false });
    expect(planSteps({ supported: true, hasKey: false })).toEqual(["permissions", "key", "ready"]);
    expect(planSteps({ supported: true, hasKey: true })).toEqual(["permissions", "ready"]);
    expect(planSteps({ supported: false, hasKey: false })).toEqual(["key", "ready"]);
    expect(planSteps({ supported: false, hasKey: true })).toEqual(["ready"]);
  });
  it("reads and asks for the microphone through the webview, true only when really granted", async () => {
    expect(await readMic(undefined)).toBe("unknown");
    expect(await readMic({ permissions: { query: async () => ({ state: "granted" }) } })).toBe("granted");
    expect(await readMic({ permissions: { query: async () => ({ state: "weird" }) } })).toBe("unknown");
    expect(await readMic({ permissions: { query: async () => { throw new Error("x"); } } })).toBe("unknown");
    const stop = vi.fn();
    expect(await requestMic({ mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) } })).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(await requestMic({ mediaDevices: { getUserMedia: async () => { throw new Error("denied"); } } })).toBe(false);
    expect(await requestMic(undefined)).toBe(false);
  });
  it("summarises with what is known; off macOS it says macOS only", () => {
    const t = makeT("en");
    expect(summarize({ supported: false, rows: [], keyProvider: null }, t).map(r => r.text)).toEqual(["Computer control is available on macOS only.", "No key added yet"]);
    const s = summarize({ supported: true, rows: mapPermissions(host, "unknown", none, none), keyProvider: "anthropic" }, t);
    expect(s[0]).toMatchObject({ tone: "err", text: "1 of 3 permissions allowed" });
    expect(s[1]).toMatchObject({ tone: "done", text: "anthropic key saved" });
  });
});

describe("setup flow (flag on)", () => {
  const t = makeT("en");
  const status = (over: Record<string, unknown> = {}) => ({ supported: true, accessibility: false, screenRecording: false, apps: [], allowApps: [], session: null, ...over });
  it("walks permissions, key and ready; the key goes to the vault and the field is cleared; Finish remembers it", async () => {
    stubDom();
    const vault = createMemoryKeyVault();
    const storage = mem();
    const calls: string[] = [];
    let st = status();
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      calls.push(cmd + (args ? ":" + JSON.stringify(args) : ""));
      if (cmd === "computer_status") return st;
      if (cmd === "computer_request_access") { if (args?.kind === "screen") st = status({ screenRecording: true }); return true; }
      return undefined;
    });
    const onClose = vi.fn();
    const ui = mountSetup({ t, invoke, vault, providers: ["anthropic", "openai"], nav: undefined, storage, onClose });
    await ui.ready; await flush();
    const el = ui.element as unknown as El;
    expect(el.text()).toContain("1 · Permissions");
    expect(el.text()).toContain("2 · Provider key");
    expect(el.text()).toContain("3 · Ready");
    expect(el.all().find(e => e.attrs["aria-current"] === "step")?.text()).toContain("Permissions");
    expect(el.hasButton("Continue")).toBe(false);
    await el.all().filter(e => e.tag === "button" && e.textContent === "Allow")[0].click(); await flush();
    expect(calls).toContain('computer_request_access:{"kind":"screen"}');
    expect(el.text()).toContain("Allowed"); // screen recording, as the host now reports
    await el.all().filter(e => e.tag === "button" && e.textContent === "Allow")[0].click(); await flush();
    expect(el.text()).toContain("Waiting for you"); // asked, still not granted: neutral
    expect(el.text()).not.toContain("■");
    expect(el.hasButton("Open System Settings")).toBe(true);
    el.button("Open System Settings").click(); await flush();
    expect(calls).toContain('computer_open_settings:{"pane":"accessibility"}');
    await el.button("Continue without computer control").click(); await flush();
    expect(el.text()).toContain("Model provider key");
    const input = el.all().find(e => e.tag === "input")!;
    const select = el.all().find(e => e.tag === "select")!;
    select.value = "openai"; input.value = "sk-test-0123456789";
    await el.button("Save and continue").click(); await flush();
    expect(await vault.list()).toEqual([{ provider: "openai", masked: "sk-t…6789" }]);
    expect(input.value).toBe("");
    expect(el.text()).not.toContain("sk-test");
    expect(el.text()).toContain("You are ready");
    expect(el.text()).toContain("openai key saved");
    expect(el.text()).toContain("1 of 3 permissions allowed");
    expect(isSetupDone(storage)).toBe(false);
    el.button("Finish").click();
    expect(isSetupDone(storage)).toBe(true);
    expect(storage.m.get(SETUP_DONE_KEY)).toBe("1");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(calls.some(c => /sk-test/.test(c))).toBe(false);
  });
  it("'Not now' postpones a row; the key step is skipped when a key exists; Back and Fix go back", async () => {
    stubDom();
    const vault = createMemoryKeyVault();
    await vault.add("anthropic", "abcdefghijkl");
    const ui = mountSetup({ t, invoke: async (cmd) => (cmd === "computer_status" ? status() : undefined), vault, providers: ["anthropic"], storage: mem() });
    await ui.ready; await flush();
    const el = ui.element as unknown as El;
    expect(el.text()).not.toContain("Provider key");
    el.all().filter(e => e.tag === "button" && e.textContent === "Not now")[0].click();
    expect(el.text()).toContain("Later");
    el.button("Continue without computer control").click();
    expect(el.text()).toContain("You are ready");
    el.button("Fix").click();
    expect(el.text()).toContain("Give Valar permissions");
  });
  it("off macOS the permission step does not exist and the summary says macOS only", async () => {
    stubDom();
    const ui = mountSetup({ t, invoke: async () => status({ supported: false }), vault: createMemoryKeyVault(), providers: ["anthropic"], storage: mem() });
    await ui.ready; await flush();
    const el = ui.element as unknown as El;
    expect(el.text()).not.toContain("Permissions");
    expect(el.text()).toContain("Model provider key");
    el.button("Add later").click();
    expect(el.text()).toContain("Computer control is available on macOS only.");
  });
  it("a failed key save shows a plain message and never the key", async () => {
    stubDom();
    const vault = { ...createMemoryKeyVault(), add: async () => { throw new Error("boom sk-secret-xyz"); } };
    const ui = mountSetup({ t, vault, providers: ["anthropic"], storage: mem() });
    await ui.ready; await flush();
    const el = ui.element as unknown as El;
    el.all().find(e => e.tag === "input")!.value = "sk-secret-xyz";
    await el.button("Save and continue").click(); await flush();
    expect(el.text()).toContain("The key could not be saved.");
    expect(el.text()).not.toContain("sk-secret");
  });
});

describe("banner and About", () => {
  const flagOn = { getItem: (k: string) => (k === UPDATE_FLAG_KEY ? "1" : null) };
  it("shows the banner for a newer version; Download opens the release page through the host; Later hides it", async () => {
    stubDom();
    const invoke = vi.fn(async () => undefined);
    const fetchFn: FetchFn = () => ok(release());
    const ui = mountUpdate({ t: makeT("en"), version: "1.1.0", invoke, storage: mem(), fetchFn, now: () => 9e12 }, flagOn)!;
    await flush();
    const banner = ui.banner as unknown as El;
    expect(banner.hidden).toBe(false);
    expect(banner.text()).toContain("New version 1.2.0 available");
    expect(banner.text()).toContain("Download it and install it yourself.");
    banner.button("Download").click(); await flush();
    expect(invoke).toHaveBeenCalledWith("open_release_page", { url: REL });
    banner.button("Later").click();
    expect(banner.hidden).toBe(true);
  });
  it("renders nothing from the answer except the validated version: a hostile name or note never reaches the DOM", async () => {
    stubDom();
    const ui = mountUpdate({ t: makeT("en"), version: "1.1.0", storage: mem(), fetchFn: () => ok(release()), now: () => 9e12 }, flagOn)!;
    await flush();
    expect((ui.banner as unknown as El).text()).not.toMatch(/onerror|img|notes/);
    expect(await openReleasePage(vi.fn(), "https://evil.example/")).toBe(false);
    const invoke = vi.fn(async () => undefined);
    expect(await openReleasePage(invoke, "javascript:alert(1)")).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
  it("About: version, up to date / new version / could not check with word, glyph and action; manual check", async () => {
    stubDom();
    let body: Record<string, unknown> | Error = release();
    const fetchFn = vi.fn<FetchFn>(() => (body instanceof Error ? Promise.reject(body) : ok(body)));
    const ui = mountUpdate({ t: makeT("en"), version: "1.1.0", storage: mem(), fetchFn, now: () => 9e12, formatDate: () => "TODAY" }, flagOn)!;
    await flush();
    const about = ui.about() as unknown as El;
    expect(about.text()).toContain("1.1.0");
    expect(about.text()).toContain("1.2.0 is available");
    expect(about.text()).toContain("TODAY");
    expect(about.hasButton("Download")).toBe(true);
    body = new TypeError("offline");
    await ui.checker.manual(); await flush();
    expect(about.text()).toContain("Could not check");
    expect(about.text()).toContain("■");
    expect(about.text()).toContain("TODAY · failed");
    body = release({ tag_name: "v1.1.0" });
    about.button("Try again").click(); await flush();
    expect(about.text()).toContain("You have the latest version");
    expect(about.hasButton("Check now")).toBe(true);
    expect(about.text()).toContain("You download and install a new version yourself.");
  });
  it("About with the flag off shows the version and the manual note only, with no check button", () => {
    stubDom();
    const about = buildAbout({ t: makeT("en"), version: "1.1.0" }, null, () => "") as unknown as El;
    expect(about.text()).toContain("1.1.0");
    expect(about.all().some(e => e.tag === "button")).toBe(false);
  });
});

describe("security scan (sources)", () => {
  const files = ["../update.ts", "../update-view.ts", "../setup.ts", "../setup-view.ts"];
  it("holds no token, key, PAT or secret value, no markup injection and only the two GitHub hosts", () => {
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(/github_pat_|ghp_|gho_|sk-[A-Za-z0-9]{8}|AKIA[0-9A-Z]{8}|BEGIN [A-Z ]*PRIVATE KEY/);
      expect(src, f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
      expect(src, f).not.toMatch(/Authorization|Bearer|publish\.|PUBLISH_|key_get|secure_store|localStorage\.setItem\([^)]*key/i);
      expect(src, f).not.toMatch(/console\./);
      for (const m of src.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) expect(["api.github.com", "github.com"], `${f}:${m[0]}`).toContain(m[1]);
    }
    expect(read("../setup-view.ts")).not.toMatch(/vault\.get\(/);
  });
  it("adds no update engine: no updater plugin, key or config, and the CSP is unchanged", () => {
    const conf = read("../../src-tauri/tauri.conf.json");
    expect(conf).not.toMatch(/updater|pubkey/i);
    expect(read("../../src-tauri/Cargo.toml")).not.toMatch(/updater|tauri-plugin-process/);
    expect(read("../../src-tauri/capabilities/default.json")).not.toMatch(/updater|process/);
    expect(read("../../package.json")).not.toMatch(/updater|plugin-process/);
    expect(read("../../src-tauri/src/lib.rs")).toContain("open_release_page,");
  });
});

describe("i18n (14 languages)", () => {
  const keys = Object.keys(MESSAGES.en).filter(k => /^(setup|update|about)\./.test(k) || k === "settings.page.about");
  const src = ["../setup-view.ts", "../setup.ts", "../update-view.ts", "../update.ts", "../ui.ts", "../settings-pages.ts"].map(read).join("\n");
  // Keys built from a state or a step id: `setup.state.${...}`, `setup.step.${...}`, `setup.perm.${id}Why`.
  const families = ["setup.state.", "setup.step.", "setup.perm."];
  it("has every key in all fourteen languages with the same placeholders, translated", () => {
    expect(keys.length).toBeGreaterThanOrEqual(60);
    const short = new Set(["setup.next", "setup.perm.microphone", "setup.state.later", "setup.step.ready", "setup.allow", "setup.back", "setup.perm.accessibility", "setup.key.provider", "about.version", "setup.fix", "setup.finish", "update.download", "settings.page.about", "setup.step.key", "update.banner.title", "update.available", "setup.sum.keyDone", "update.lastFailed", "update.later", "setup.step.permissions", "setup.state.granted", "setup.key.secret", "setup.sum.perms", "update.laterLabel", "setup.title"]);
    for (const l of LOCALES) for (const k of keys) {
      expect(MESSAGES[l][k]?.trim(), `${l}:${k}`).toBeTruthy();
      expect([...MESSAGES[l][k].matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort(), `${l}:${k}`).toEqual([...MESSAGES.en[k].matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort());
      if (l !== "en" && !short.has(k)) expect(MESSAGES[l][k], `${l}:${k}`).not.toBe(MESSAGES.en[k]);
    }
  });
  it("has no unused key and no used key that is missing", () => {
    const used = new Set([...src.matchAll(/["'`]((?:setup|update|about)\.[\w.]+)["'`]/g)].map(m => m[1]));
    const unused = keys.filter(k => k !== "settings.page.about" && !used.has(k) && !families.some(f => k.startsWith(f) && src.includes("`" + f + "${")) && !(/^setup\.perm\.\w+Why$/.test(k) && src.includes("Why`")));
    expect(unused).toEqual([]);
    expect([...used].filter(k => !keys.includes(k))).toEqual([]);
    for (const id of ["screen", "accessibility", "microphone"]) expect(keys).toContain(`setup.perm.${id}Why`);
    for (const s of ["granted", "pending", "notGranted", "later"]) expect(keys).toContain(`setup.state.${s}`);
  });
  it("never promises an automatic update or a restart, in any language", () => {
    const banned: Record<string, RegExp> = {
      en: /automatic|restart|relaunch/i, tr: /otomatik|yeniden başlat/i, "es-419": /automátic|reinici/i, "pt-BR": /automátic|reinici/i, de: /automatisch|neu starten|neustart/i,
      fr: /automatique|redémarr/i, ja: /自動|再起動|再開/, ar: /تلقائي|إعادة التشغيل|إعادة تشغيل/, it: /automatic|riavvi/i, ko: /자동|다시 시작|재시작/,
      id: /otomatis|mulai ulang/i, pl: /automatyczn|uruchom ponownie|restart/i, hi: /स्वचालित|रीस्टार्ट|पुनः आरंभ/, "zh-Hans": /自动|重启|重新启动/,
    };
    for (const l of LOCALES) for (const k of keys) expect(MESSAGES[l][k], `${l}:${k}`).not.toMatch(banned[l]);
    for (const f of ["../update.ts", "../update-view.ts", "../setup.ts", "../setup-view.ts"]) expect(read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").replace("computer.restartNote", ""), f).not.toMatch(/relaunch|restart|autoUpdate/i);
    expect(MESSAGES.en["about.manual"]).toMatch(/download and install/);
  });
});
