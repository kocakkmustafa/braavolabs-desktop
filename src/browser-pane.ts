/**
 * The Braavo browser pane (plan 5.1): a Chromium with the app's own profile, driven over
 * the governed CDP host. Every navigate and read goes through `governedBrowser` (approval
 * gate + audit); the host re-checks the URL policy (~/.braavo/browser.json) and private
 * addresses before it spends the token. A page read here is untrusted: its text is shown
 * under an "untrusted" label and, when added to a message, fenced the same way the
 * daemon fences pages for agents.
 */
import { governedBrowser, type BrowserAction, type BrowserDriver, type BrowserResult, type GateFn } from "./browser";
import type { Translator } from "./i18n";

export type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export const PAGE_TEXT_MAX = 20_000;

/** Visible text of a page's HTML: no scripts, styles, templates or hidden elements (a common injection carrier). */
export function pageText(html: string, parse: (html: string) => Document = h => new DOMParser().parseFromString(h, "text/html")): { title: string; text: string } {
  const doc = parse(html);
  doc.querySelectorAll("script,style,noscript,template,svg,head,[hidden],[aria-hidden='true']").forEach(n => n.remove());
  doc.querySelectorAll<HTMLElement>("[style]").forEach(n => {
    if (/display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0/i.test(n.getAttribute("style") ?? "")) n.remove();
  });
  const title = parse(html).title.replace(/\s+/g, " ").trim().slice(0, 200);
  const text = (doc.body?.innerText ?? doc.body?.textContent ?? "")
    .replace(/[​-‏‪-‮⁠-⁤﻿]/g, "")
    .split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  return { title, text };
}

/** Same fence as the daemon's agent browser; a fake closing tag inside the page cannot end it. */
export function fenceUntrusted(url: string, title: string, text: string): string {
  const attr = (s: string) => s.replace(/[<>"&\n\r]/g, " ");
  const body = text.slice(0, PAGE_TEXT_MAX).replace(/<\/?\s*untrusted_web_content/gi, "[untrusted_web_content]");
  return `<untrusted_web_content url="${attr(url)}" title="${attr(title)}">\n${body}${text.length > PAGE_TEXT_MAX ? "\n… (cut)" : ""}\n</untrusted_web_content>`;
}

export function tauriBrowserDriver(invoke: Invoke): BrowserDriver {
  return {
    async dispatch(action: BrowserAction, token: string): Promise<BrowserResult> {
      return (await invoke("browser_dispatch", { token, action, ts: Date.now() })) as BrowserResult;
    },
  };
}

export interface BrowserPaneDeps {
  t: Translator;
  invoke: Invoke;
  gate: GateFn;
  /** Put text into the chat composer (the user still sends it). */
  addToMessage(text: string): void;
  parse?: (html: string) => Document;
}

export function createBrowserPane(deps: BrowserPaneDeps) {
  const { t, invoke } = deps;
  const driver = tauriBrowserDriver(invoke);
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const root = el("section", "bp-root");
  root.append(el("div", "rail-section-label", t("browser.title")), el("p", "cp-hint", t("browser.note")));
  const openBtn = el("button", "set-btn", t("browser.open"));
  const urlInput = el("input", "company-input bp-url") as HTMLInputElement;
  urlInput.type = "url"; urlInput.placeholder = "https://"; urlInput.setAttribute("aria-label", t("browser.url")); urlInput.dir = "ltr";
  const goBtn = el("button", "set-btn", t("browser.go"));
  const readBtn = el("button", "set-btn", t("browser.read"));
  const status = el("div", "cp-sub"); status.setAttribute("role", "status");
  const result = el("div", "bp-result"); result.hidden = true;
  const row = el("div", "cp-inline");
  row.append(openBtn, urlInput, goBtn, readBtn);
  root.append(row, status, result);

  let connected = false;
  let currentUrl = "";
  const setConnected = (on: boolean) => { connected = on; goBtn.disabled = !on; readBtn.disabled = !on; };
  setConnected(false);
  const say = (text: string, error = false) => { status.textContent = text; status.className = error ? "cp-error" : "cp-sub"; };
  const message = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 300);

  const open = async () => {
    openBtn.disabled = true; say(t("browser.opening"));
    try {
      const cdpUrl = (await invoke("browser_launch", { ts: Date.now() })) as string;
      await invoke("browser_connect", { cdpUrl, ts: Date.now() });
      setConnected(true); say(t("browser.connected"));
    } catch (e) { setConnected(false); say(t("browser.failed", { detail: message(e) }), true); }
    finally { openBtn.disabled = false; }
  };

  const go = async () => {
    const url = urlInput.value.trim();
    if (!connected || !url) return;
    say(t("browser.working"));
    try {
      const out = await governedBrowser({ op: "navigate", url }, deps.gate, driver);
      if (!out.ok) { say(out.reason, true); return; }
      if (!out.result.ok) { say(t("browser.failed", { detail: out.result.error ?? "" }), true); return; }
      currentUrl = typeof out.result.value === "string" ? out.result.value : url;
      urlInput.value = currentUrl;
      say(t("browser.loaded", { url: currentUrl }));
    } catch (e) { say(t("browser.failed", { detail: message(e) }), true); }
  };

  const read = async () => {
    if (!connected) return;
    say(t("browser.working"));
    try {
      const out = await governedBrowser({ op: "read", what: "dom" }, deps.gate, driver);
      if (!out.ok) { say(out.reason, true); return; }
      if (!out.result.ok || typeof out.result.value !== "string") { say(t("browser.failed", { detail: out.result.error ?? "" }), true); return; }
      const page = pageText(out.result.value, deps.parse);
      const url = currentUrl || urlInput.value.trim();
      result.replaceChildren();
      const badge = el("span", "bp-untrusted mono", t("browser.untrusted"));
      const head = el("div", "cp-row-between");
      const add = el("button", "set-btn", t("browser.addToMessage"));
      add.addEventListener("click", () => deps.addToMessage(fenceUntrusted(url, page.title, page.text)));
      head.append(el("div", "company-name", page.title || url), add);
      const body = el("pre", "bp-text");
      body.textContent = page.text.slice(0, 6_000) + (page.text.length > 6_000 ? "\n…" : "");
      result.append(badge, head, body);
      result.hidden = false;
      say(t("browser.readDone", { chars: String(page.text.length) }));
    } catch (e) { say(t("browser.failed", { detail: message(e) }), true); }
  };

  openBtn.addEventListener("click", () => void open());
  goBtn.addEventListener("click", () => void go());
  readBtn.addEventListener("click", () => void read());
  urlInput.addEventListener("keydown", e => { if (e.key === "Enter") void go(); });
  return { element: root, open, go, read };
}
