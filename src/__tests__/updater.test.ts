import { afterEach, describe, expect, it, vi } from "vitest";
import { makeT } from "../i18n";
import { UPDATE_DISMISSED_KEY, UPDATE_FLAG_KEY } from "../update";
import { mountUpdate } from "../update-view";
import { createUpdateEngine, downloadLinksOk, engineBannerVisible, tauriBackend, type UpdaterBackend, type UpdaterHandle } from "../updater";

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const GOOD_RAW = { version: "1.2.0", platforms: { "darwin-aarch64": { url: "https://github.com/kocakkmustafa/braavolabs-desktop/releases/download/v1.2.0/B.app.tar.gz", signature: "x" } } };

function handle(over: Partial<UpdaterHandle> = {}): UpdaterHandle {
  return { version: "1.2.0", rawJson: GOOD_RAW, download: async (cb) => { cb(0, 200); cb(50, 200); cb(200, 200); }, install: async () => {}, ...over };
}
function backend(h: UpdaterHandle | null | Error, restart = vi.fn(async () => {})) {
  const check = vi.fn(async () => { if (h instanceof Error) throw h; return h; });
  const b: UpdaterBackend = { check, restart };
  return { b, check, restart };
}

class El {
  textContent = ""; className = ""; disabled = false; hidden = false; type = "";
  attrs: Record<string, string> = {}; children: El[] = []; handlers = new Map<string, () => unknown>(); parent: El | null = null;
  constructor(readonly tag: string) {}
  append(...c: El[]) { for (const x of c) { x.parent = this; this.children.push(x); } }
  replaceChildren(...c: El[]) { this.children = []; this.append(...c); }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(n: string, h: () => unknown) { this.handlers.set(n, h); }
  all(): El[] { return [this, ...this.children.flatMap(c => c.all())]; }
  text(): string { return [this.textContent, ...this.children.map(c => c.text())].join(" "); }
  button(label: string) { const b = this.all().find(e => e.tag === "button" && e.textContent === label); if (!b) throw new Error(`no button ${label}`); return b; }
  hasButton(label: string) { return this.all().some(e => e.tag === "button" && e.textContent === label); }
  click() { return this.handlers.get("click")?.(); }
}
afterEach(() => { vi.unstubAllGlobals(); });
const stubDom = () => vi.stubGlobal("document", { createElement: (tag: string) => new El(tag) });
const flagOn = { getItem: (k: string) => (k === UPDATE_FLAG_KEY ? "1" : null) };
const t = makeT("en");

describe("update engine state machine", () => {
  it("check -> available -> downloading (with percent) -> ready -> restart", async () => {
    const { b, restart } = backend(handle());
    const install = vi.fn(async () => {});
    const e = createUpdateEngine({ current: "1.1.0", backend: backend(handle({ install })).b, storage: mem(), now: () => 5 });
    const seen: string[] = [];
    e.subscribe(s => seen.push(`${s.phase}${s.percent !== undefined ? `:${s.percent}` : ""}`));
    await e.check();
    expect(e.state()).toMatchObject({ phase: "available", version: "1.2.0", lastCheck: 5 });
    await e.download();
    expect(seen).toEqual(["checking", "available", "downloading:null", "downloading:0", "downloading:25", "downloading:100", "ready"]);
    expect(install).not.toHaveBeenCalled(); // nothing is installed before Restart
    expect(e.state().phase).toBe("ready");
    void b; void restart;
    const r = vi.fn(async () => {});
    const e2 = createUpdateEngine({ current: "1.1.0", backend: backend(handle({ install }), r).b, storage: mem() });
    await e2.check(); await e2.download(); await e2.restart();
    expect(install).toHaveBeenCalledTimes(1);
    expect(r).toHaveBeenCalledTimes(1);
  });
  it("does nothing out of order: no download before a check, no restart before ready", async () => {
    const install = vi.fn(async () => {});
    const { b, restart } = backend(handle({ install }));
    const e = createUpdateEngine({ current: "1.1.0", backend: b, storage: mem() });
    await e.download(); await e.restart();
    await e.check(); await e.restart();
    expect(install).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });
  it("no newer release, an older or odd version and a missing latest.json are quiet", async () => {
    for (const h of [null, handle({ version: "1.1.0" }), handle({ version: "1.0.0" }), handle({ version: "latest" })]) {
      const e = createUpdateEngine({ current: "1.1.0", backend: backend(h).b, storage: mem() });
      await e.check();
      expect(e.state().phase).toBe("current");
      expect(engineBannerVisible(e.state())).toBe(false);
    }
    const e = createUpdateEngine({ current: "1.1.0", backend: backend(new Error("404 https://github.com/x/latest.json")).b, storage: mem() });
    await e.check();
    expect(e.state()).toMatchObject({ phase: "failed", failure: "check" });
    expect(engineBannerVisible(e.state())).toBe(false); // silent in the banner; About says "Could not check"
    expect(JSON.stringify(e.state())).not.toMatch(/github|404|latest\.json/); // the raw message is never kept
  });
  it("refuses a release whose download link leaves the project's account", async () => {
    const raw = { platforms: { "darwin-aarch64": { url: "https://evil.example/x.tar.gz" } } };
    const e = createUpdateEngine({ current: "1.1.0", backend: backend(handle({ rawJson: raw })).b, storage: mem() });
    await e.check();
    expect(e.state()).toMatchObject({ phase: "failed", failure: "check" });
    expect(downloadLinksOk(GOOD_RAW)).toBe(true);
    expect(downloadLinksOk({ url: "http://github.com/kocakkmustafa/x" })).toBe(false);
    expect(downloadLinksOk({ platforms: { a: { url: "https://github.com.evil.io/kocakkmustafa/x" } } })).toBe(false);
    expect(downloadLinksOk(undefined)).toBe(false); // fail closed
    expect(downloadLinksOk("x")).toBe(false);
    expect(downloadLinksOk({ version: "1.2.0" })).toBe(false); // no link at all
    expect(downloadLinksOk({ url: "https://github.com/kocakkmustafa/other/releases/download/v1/x" })).toBe(false); // another repo of the account
    expect(downloadLinksOk({ url: "https://github.com/kocakkmustafa/braavolabs-desktop/releases/tag/v1.2.0" })).toBe(false); // not a download link
  });
  it("a failed download can be retried; a signature failure is its own state with no retry and no install", async () => {
    let n = 0;
    const install = vi.fn(async () => {});
    const e = createUpdateEngine({ current: "1.1.0", backend: backend(handle({ install, download: async () => { if (n++ === 0) throw new Error("network https://x.example/secret-path"); } })).b, storage: mem() });
    await e.check(); await e.download();
    expect(e.state()).toMatchObject({ phase: "failed", failure: "download", version: "1.2.0" });
    expect(JSON.stringify(e.state())).not.toMatch(/example|secret-path/);
    await e.download();
    expect(e.state().phase).toBe("ready");

    const sig = createUpdateEngine({ current: "1.1.0", backend: backend(handle({ install, download: async () => { throw new Error("signature verification failed: key RWQ..."); } })).b, storage: mem() });
    await sig.check(); await sig.download();
    expect(sig.state()).toMatchObject({ phase: "failed", failure: "signature" });
    expect(JSON.stringify(sig.state())).not.toMatch(/RWQ|verification/);
    await sig.download(); await sig.restart(); // neither moves it on
    expect(sig.state().failure).toBe("signature");
    expect(install).not.toHaveBeenCalled();
  });
  it("a TLS or network 'verify failed' error is not a signature failure", async () => {
    const e = createUpdateEngine({ current: "1.1.0", backend: backend(handle({ download: async () => { throw new Error("certificate verify failed"); } })).b, storage: mem() });
    await e.check(); await e.download();
    expect(e.state()).toMatchObject({ phase: "failed", failure: "download" });
  });
  it("after a successful install, a failed restart retries only the restart", async () => {
    const install = vi.fn(async () => {});
    let n = 0;
    const r = vi.fn(async () => { if (n++ === 0) throw new Error("relaunch failed"); });
    const e = createUpdateEngine({ current: "1.1.0", backend: backend(handle({ install }), r).b, storage: mem() });
    await e.check(); await e.download(); await e.restart();
    expect(e.state()).toMatchObject({ phase: "failed", failure: "install" });
    await e.restart();
    expect(install).toHaveBeenCalledTimes(1);
    expect(r).toHaveBeenCalledTimes(2);
  });
  it("an install failure keeps the download and can retry the install", async () => {
    let n = 0;
    const install = vi.fn(async () => { if (n++ === 0) throw new Error("disk"); });
    const r = vi.fn(async () => {});
    const e = createUpdateEngine({ current: "1.1.0", backend: backend(handle({ install }), r).b, storage: mem() });
    await e.check(); await e.download(); await e.restart();
    expect(e.state()).toMatchObject({ phase: "failed", failure: "install" });
    expect(r).not.toHaveBeenCalled();
    await e.restart();
    expect(r).toHaveBeenCalledTimes(1);
  });
  it("Later hides the banner for that version only", async () => {
    const s = mem();
    const e = createUpdateEngine({ current: "1.1.0", backend: backend(handle()).b, storage: s });
    await e.check();
    expect(engineBannerVisible(e.state())).toBe(true);
    e.dismiss();
    expect(s.m.get(UPDATE_DISMISSED_KEY)).toBe("1.2.0");
    expect(engineBannerVisible(e.state())).toBe(false);
  });
});

describe("engine banner and About", () => {
  it("shows the texts of each step; Download and Restart need a press; Later hides", async () => {
    stubDom();
    const install = vi.fn(async () => {});
    const r = vi.fn(async () => {});
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    const ui = mountUpdate({ t, version: "1.1.0", storage: mem(), backend: backend(handle({ install, download: async cb => { cb(10, 100); await gate; } }), r).b }, flagOn)!;
    await flush();
    const banner = ui.banner as unknown as El;
    expect(banner.hidden).toBe(false);
    expect(banner.text()).toContain("New version 1.2.0 available");
    expect(banner.text()).toContain("The signature is checked before anything is installed.");
    expect(banner.text()).not.toMatch(/resume|continue/i);
    banner.button("Download").click(); await flush();
    expect(banner.text()).toContain("Downloading 1.2.0… 10%");
    expect(banner.hasButton("Restart")).toBe(false);
    release(); await flush();
    expect(banner.text()).toContain("1.2.0 is ready to install");
    expect(install).not.toHaveBeenCalled();
    banner.button("Restart").click(); await flush();
    expect(install).toHaveBeenCalledTimes(1);
    expect(r).toHaveBeenCalledTimes(1);
  });
  it("shows a signature failure with no retry and no install-anyway; the text carries no URL or key", async () => {
    stubDom();
    const ui = mountUpdate({ t, version: "1.1.0", storage: mem(), backend: backend(handle({ download: async () => { throw new Error("bad signature https://github.com/kocakkmustafa/x key RWQabc"); } })).b }, flagOn)!;
    await flush();
    const banner = ui.banner as unknown as El;
    banner.button("Download").click(); await flush();
    const text = banner.text();
    expect(text).toContain("The update's signature did not match");
    expect(text).toContain("It was not installed.");
    expect(text).not.toMatch(/https?:|RWQ|github/i);
    expect(banner.hasButton("Later")).toBe(true);
    expect(banner.hasButton("Try again") || banner.hasButton("Restart") || banner.hasButton("Download")).toBe(false);
    expect(text).not.toMatch(/anyway/i);
  });
  it("a missing latest.json (404) leaves the banner silent and About says it could not check", async () => {
    stubDom();
    const ui = mountUpdate({ t, version: "1.1.0", storage: mem(), backend: backend(new Error("404")).b, formatDate: () => "TODAY" }, flagOn)!;
    await flush();
    expect((ui.banner as unknown as El).hidden).toBe(true);
    const about = ui.about() as unknown as El;
    expect(about.text()).toContain("Could not check");
    expect(about.text()).toContain("TODAY · failed");
    expect(about.text()).toContain("checks its signature before installing");
    expect(about.text()).not.toContain("does not install updates for you");
    expect(about.hasButton("Try again")).toBe(true);
  });
  it("About shows each step with an action", async () => {
    stubDom();
    const ui = mountUpdate({ t, version: "1.1.0", storage: mem(), backend: backend(handle()).b, formatDate: () => "TODAY" }, flagOn)!;
    await flush();
    const about = ui.about() as unknown as El;
    expect(about.text()).toContain("1.2.0 is available");
    about.button("Download").click(); await flush();
    expect(about.text()).toContain("1.2.0 is ready to install");
    expect(about.hasButton("Restart")).toBe(true);
  });
  it("renders the version only as text, never as markup", async () => {
    stubDom();
    const ui = mountUpdate({ t, version: "1.1.0", storage: mem(), backend: backend(handle({ version: "1.2.0<img onerror=1>" })).b }, flagOn)!;
    await flush();
    expect((ui.banner as unknown as El).hidden).toBe(true); // not a valid version: treated as current
  });
});

describe("flag off and no plugin: zero effect", () => {
  it("flag off: no engine, no check, no network even with a backend", async () => {
    const fetchFn = vi.fn();
    const { b, check } = backend(handle());
    expect(mountUpdate({ t, version: "1.1.0", fetchFn, backend: b }, { getItem: () => null })).toBeNull();
    await flush();
    expect(check).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("flag on in engine mode makes no GitHub API request; without a backend the manual notice is unchanged", async () => {
    stubDom();
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => "{}" }));
    const { b } = backend(handle());
    const withEngine = mountUpdate({ t, version: "1.1.0", fetchFn, storage: mem(), backend: b }, flagOn)!;
    await flush();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(withEngine.engine).not.toBeNull();
    const manual = mountUpdate({ t, version: "1.1.0", fetchFn, storage: mem(), backend: null, now: () => 9e12 }, flagOn)!;
    await flush();
    expect(manual.engine).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("outside Tauri there is no backend and the plugins are not loaded", () => {
    expect(tauriBackend()).toBeNull();
  });
});
