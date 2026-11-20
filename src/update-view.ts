/**
 * New-version banner and the "About" page (BRA-UI-11). Plain DOM; versions, dates and links come from validated
 * values (update.ts) and go in through `textContent`. The link is opened by the host in the system browser, and only
 * when it is a https link under the project's own GitHub account (checked here and again in the host).
 * Status is glyph + word + colour (colour only touches the glyph).
 */
import {
  bannerVisible, createUpdateChecker, isReleaseUrl, isUpdateEnabled,
  type FlagStorage, type Storage2, type UpdateChecker, type UpdateState,
} from "./update";
import { createUpdateEngine, engineBannerVisible, tauriBackend, type EngineState, type UpdateEngine, type UpdaterBackend } from "./updater";
import { ltr } from "./bidi";

type Translate = (key: string, vars?: Record<string, string | number>) => string;
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function make<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Asks the host to open a release page. Refuses any other link. */
export function openReleasePage(invoke: Invoke | undefined, url: unknown): Promise<boolean> {
  if (!invoke || !isReleaseUrl(url)) return Promise.resolve(false);
  return invoke("open_release_page", { url }).then(() => true, () => false);
}

export interface UpdateUiDeps {
  t: Translate;
  /** Running version, e.g. "1.1.0". */
  version: string;
  invoke?: Invoke;
  storage?: Storage2;
  fetchFn?: Parameters<typeof createUpdateChecker>[0]["fetchFn"];
  now?: () => number;
  /** Date/time for "last check"; defaults to the active locale's short format. */
  formatDate?: (ms: number) => string;
  /** The signed in-app updater. Omitted = the Tauri plugins when running inside Tauri; null = none (manual notice only). */
  backend?: UpdaterBackend | null;
}
export interface UpdateUi { checker: UpdateChecker; engine: UpdateEngine | null; banner: HTMLElement; about(): HTMLElement; dispose(): void }
type Disposable<T> = T & { dispose(): void };

/** Null when the flag is off: no checker, no banner, no network. */
export function mountUpdate(deps: UpdateUiDeps, flagStorage?: FlagStorage): UpdateUi | null {
  if (!isUpdateEnabled(flagStorage)) return null;
  const { t } = deps;
  const checker = createUpdateChecker({ current: deps.version, storage: deps.storage, fetchFn: deps.fetchFn, now: deps.now });
  const backend = deps.backend === undefined ? tauriBackend() : deps.backend;
  const engine = backend ? createUpdateEngine({ current: deps.version, backend, storage: deps.storage, now: deps.now }) : null;
  const fmt = deps.formatDate ?? ((ms: number) => { try { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(ms); } catch { return new Date(ms).toISOString(); } });

  const banner = make("div", "update-banner");
  banner.setAttribute("role", "status");
  banner.hidden = true;
  const paintBanner = (s: UpdateState) => {
    const show = bannerVisible(s);
    banner.hidden = !show;
    if (!show) { banner.replaceChildren(); return; }
    const text = make("span", "update-banner-text");
    text.append(make("b", undefined, t("update.banner.title", { version: s.version! })), make("span", undefined, ` · ${t("update.banner.hint")}`));
    const acts = make("span", "update-banner-acts");
    const dl = make("button", "set-btn", t("update.download")); dl.type = "button";
    dl.addEventListener("click", () => void openReleasePage(deps.invoke, s.url));
    const later = make("button", "set-btn", t("update.later")); later.type = "button";
    later.setAttribute("aria-label", t("update.laterLabel", { version: s.version! }));
    later.addEventListener("click", () => checker.dismiss());
    acts.append(dl, later);
    banner.replaceChildren(make("span", "update-glyph", "↓"), text, acts);
  };
  const paintEngineBanner = (s: EngineState) => {
    const show = engineBannerVisible(s);
    banner.hidden = !show;
    if (!show) { banner.replaceChildren(); return; }
    const version = s.version!;
    const btn = (label: string, on: () => void) => { const b = make("button", "set-btn", label); b.type = "button"; b.addEventListener("click", on); return b; };
    const later = btn(t("update.later"), () => engine!.dismiss());
    later.setAttribute("aria-label", t("update.laterLabel", { version }));
    const acts = make("span", "update-banner-acts");
    let glyph = "↓", title: string, hint: string;
    if (s.phase === "downloading") {
      title = s.percent == null ? t("update.eng.downloadingNoPct", { version }) : t("update.eng.downloading", { version, percent: s.percent });
      hint = t("update.eng.hint");
    } else if (s.phase === "ready") {
      glyph = "✓"; title = t("update.eng.ready", { version }); hint = t("update.eng.readyHint");
      acts.append(btn(t("update.eng.restart"), () => void engine!.restart()), later);
    } else if (s.phase === "failed") {
      glyph = "■";
      if (s.failure === "signature") { title = t("update.eng.sigFailed"); hint = t("update.eng.sigFailedHint"); acts.append(later); }
      else {
        title = t("update.eng.failed"); hint = t("update.eng.failedHint");
        acts.append(btn(t("update.retry"), () => void (s.failure === "install" ? engine!.restart() : engine!.download())), later);
      }
    } else {
      title = t("update.banner.title", { version }); hint = t("update.eng.hint");
      acts.append(btn(t("update.download"), () => void engine!.download()), later);
    }
    const text = make("span", "update-banner-text");
    text.append(make("b", undefined, title), make("span", undefined, ` · ${hint}`));
    banner.replaceChildren(make("span", "update-glyph", glyph), text, acts);
  };
  const unsubBanner = engine ? engine.subscribe(paintEngineBanner) : checker.subscribe(paintBanner);
  void (engine ? engine.check() : checker.auto());

  const abouts: Array<() => void> = [];
  const about = () => { const a = buildAbout(deps, checker, fmt, engine); abouts.push(a.dispose); return a; };
  return { checker, engine, banner, about, dispose: () => { unsubBanner(); for (const d of abouts.splice(0)) d(); } };
}

/** The "About" settings page. Without a checker (flag off) it shows the version and the manual-install note only. */
export function buildAbout(deps: Pick<UpdateUiDeps, "t" | "version" | "invoke">, checker: UpdateChecker | null, fmt: (ms: number) => string, engine: UpdateEngine | null = null): Disposable<HTMLElement> {
  const { t } = deps;
  const root = make("div", "sheet-sec about-sec");
  const list = make("div", "about-list");
  const row = (label: string, ...value: HTMLElement[]) => {
    const r = make("div", "about-row");
    const v = make("span", "about-value");
    v.append(...value);
    r.append(make("span", "about-label", label), v);
    return { r, v };
  };
  const mono = (s: string) => ltr(make("span", "mono", s));
  const tag = (tone: "done" | "wait" | "err", glyph: string, word: string) => {
    const s = make("span", `update-tag tone-${tone}`);
    s.append(make("span", "update-glyph", glyph), make("span", undefined, word));
    return s;
  };
  const btn = (label: string, cls: string, on: () => void, disabled = false) => {
    const b = make("button", `set-btn ${cls}`.trim(), label); b.type = "button"; b.disabled = disabled;
    b.addEventListener("click", on);
    return b;
  };
  const note = make("p", "about-note", t(engine ? "about.engine" : "about.manual"));
  root.append(make("p", "about-name", t("app.name")), list, note);

  const paintEngine = (s: EngineState) => {
    const rows: HTMLElement[] = [row(t("about.version"), mono(deps.version)).r];
    let value: HTMLElement;
    let action: HTMLElement | null = null;
    if (s.phase === "checking") value = tag("wait", "○", t("update.checking"));
    else if (s.phase === "available") {
      value = tag("done", "↓", t("update.available", { version: s.version! }));
      action = btn(t("update.download"), "primary", () => void engine!.download());
    } else if (s.phase === "downloading") {
      value = tag("wait", "○", s.percent == null ? t("update.eng.downloadingNoPct", { version: s.version! }) : t("update.eng.downloading", { version: s.version!, percent: s.percent }));
    } else if (s.phase === "ready") {
      value = tag("done", "✓", t("update.eng.ready", { version: s.version! }));
      action = btn(t("update.eng.restart"), "primary", () => void engine!.restart());
    } else if (s.phase === "failed") {
      value = tag("err", "■", s.failure === "signature" ? t("update.eng.sigFailed") : s.failure === "check" ? t("update.failed") : t("update.eng.failed"));
      if (s.failure !== "signature") action = btn(t("update.retry"), "primary", () => void (s.failure === "check" ? engine!.check() : s.failure === "install" ? engine!.restart() : engine!.download()));
    } else if (s.phase === "current") {
      value = tag("done", "✓", t("update.current"));
      action = btn(t("update.checkNow"), "", () => void engine!.check());
    } else {
      value = tag("wait", "○", t("update.notChecked"));
      action = btn(t("update.checkNow"), "", () => void engine!.check());
    }
    const u = row(t("about.update"), value);
    if (action) u.r.append(action);
    rows.push(u.r);
    if (s.lastCheck) rows.push(row(t("about.lastCheck"), make("span", undefined, s.phase === "failed" && s.failure === "check" ? t("update.lastFailed", { when: fmt(s.lastCheck) }) : fmt(s.lastCheck))).r);
    list.replaceChildren(...rows);
  };

  const paint = (s?: UpdateState) => {
    const rows: HTMLElement[] = [row(t("about.version"), mono(deps.version)).r];
    if (checker && s) {
      let value: HTMLElement;
      let action: HTMLElement | null = null;
      if (s.phase === "checking") value = tag("wait", "○", t("update.checking"));
      else if (s.phase === "newer") {
        value = tag("done", "↓", t("update.available", { version: s.version! }));
        action = btn(t("update.download"), "primary", () => void openReleasePage(deps.invoke, s.url));
      } else if (s.phase === "current") {
        value = tag("done", "✓", t("update.current"));
        action = btn(t("update.checkNow"), "", () => void checker.manual());
      } else if (s.phase === "failed") {
        value = tag("err", "■", t("update.failed"));
        action = btn(t("update.retry"), "primary", () => void checker.manual());
      } else {
        value = tag("wait", "○", t("update.notChecked"));
        action = btn(t("update.checkNow"), "", () => void checker.manual());
      }
      const u = row(t("about.update"), value);
      if (action) u.r.append(action);
      rows.push(u.r);
      if (s.lastCheck) rows.push(row(t("about.lastCheck"), make("span", undefined, s.phase === "failed" ? t("update.lastFailed", { when: fmt(s.lastCheck) }) : fmt(s.lastCheck))).r);
    }
    list.replaceChildren(...rows);
  };
  const unsub = engine ? engine.subscribe(paintEngine) : checker ? checker.subscribe(paint) : () => {};
  if (engine) paintEngine(engine.state()); else paint(checker?.state());
  return Object.assign(root, { dispose: unsub });
}
