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
}
export interface UpdateUi { checker: UpdateChecker; banner: HTMLElement; about(): HTMLElement; dispose(): void }
type Disposable<T> = T & { dispose(): void };

/** Null when the flag is off: no checker, no banner, no network. */
export function mountUpdate(deps: UpdateUiDeps, flagStorage?: FlagStorage): UpdateUi | null {
  if (!isUpdateEnabled(flagStorage)) return null;
  const { t } = deps;
  const checker = createUpdateChecker({ current: deps.version, storage: deps.storage, fetchFn: deps.fetchFn, now: deps.now });
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
  const unsubBanner = checker.subscribe(paintBanner);
  void checker.auto();

  const abouts: Array<() => void> = [];
  const about = () => { const a = buildAbout(deps, checker, fmt); abouts.push(a.dispose); return a; };
  return { checker, banner, about, dispose: () => { unsubBanner(); for (const d of abouts.splice(0)) d(); } };
}

/** The "About" settings page. Without a checker (flag off) it shows the version and the manual-install note only. */
export function buildAbout(deps: Pick<UpdateUiDeps, "t" | "version" | "invoke">, checker: UpdateChecker | null, fmt: (ms: number) => string): Disposable<HTMLElement> {
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
  const mono = (s: string) => make("span", "mono", s);
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
  const note = make("p", "about-note", t("about.manual"));
  root.append(make("p", "about-name", t("app.name")), list, note);

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
  const unsub = checker ? checker.subscribe(paint) : () => {};
  paint(checker?.state());
  return Object.assign(root, { dispose: unsub });
}
