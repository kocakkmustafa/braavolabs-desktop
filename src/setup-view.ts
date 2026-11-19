/**
 * First-run setup screens (BRA-UI-11): permissions, provider key, ready. Plain DOM; every string goes in through
 * `textContent`. Status is glyph + word + colour (colour only touches the glyph). The permission rows come from the
 * host's real answers (see setup.ts); the key value goes only to the existing key vault and is cleared at once.
 */
import type { KeyVault } from "./keyvault";
import {
  SETTINGS_PANE, computerReady, mapPermissions, markSetupDone, planSteps, readHostStatus, readMic, requestMic, summarize,
  type HostStatus, type MicReport, type PermId, type PermRow, type StepId, type Storage2, type SummaryTone,
} from "./setup";

type Translate = (key: string, vars?: Record<string, string | number>) => string;
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type Nav = {
  permissions?: { query(d: { name: string }): Promise<{ state: string }> };
  mediaDevices?: { getUserMedia(c: { audio: boolean }): Promise<{ getTracks(): Array<{ stop(): void }> }> };
};

export interface SetupDeps {
  t: Translate;
  invoke?: Invoke;
  vault: KeyVault;
  providers: readonly string[];
  nav?: Nav;
  storage?: Storage2;
  /** Focus containment for the modal (ui.ts `containDialog`). */
  contain?: (card: HTMLElement, dismiss: () => void) => () => void;
  onClose?: () => void;
}
export interface SetupUi { element: HTMLElement; ready: Promise<void>; dispose(): void }

function make<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const GLYPH: Record<SummaryTone, string> = { done: "✓", wait: "○", err: "■" };
const stateTone = (s: PermRow["state"]): SummaryTone => (s === "granted" ? "done" : s === "notGranted" ? "err" : "wait");

export function mountSetup(deps: SetupDeps): SetupUi {
  const { t } = deps;
  const root = make("div", "setup-backdrop");
  const card = make("main", "setup-card");
  card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true"); card.setAttribute("aria-label", t("setup.title"));
  root.append(card);

  let steps: StepId[] = ["ready"];
  let idx = 0;
  let host: HostStatus | null = null;
  let mic: MicReport = "unknown";
  let keyProvider: string | null = null;
  let disposed = false;
  let busy = false;
  let note = "";
  const asked = new Set<PermId>();
  const later = new Set<PermId>();
  let release: (() => void) | undefined;

  const rows = (): PermRow[] => (host ? mapPermissions(host, mic, asked, later) : []);

  const close = () => {
    if (disposed) return;
    disposed = true; release?.(); release = undefined;
    globalThis.removeEventListener?.("focus", onBack);
    globalThis.document?.removeEventListener?.("visibilitychange", onBack);
    root.remove(); deps.onClose?.();
  };

  const refreshStatus = async () => {
    if (deps.invoke) {
      try { host = readHostStatus(await deps.invoke("computer_status")); } catch { host = null; }
    }
    mic = await readMic(deps.nav);
  };

  const stepper = () => {
    const nav = make("nav", "setup-steps");
    nav.setAttribute("aria-label", t("setup.stepsLabel"));
    steps.forEach((s, i) => {
      const k = i < idx ? "done" : i === idx ? "cur" : "";
      const item = make("span", `setup-step ${k}`.trim());
      if (k === "cur") item.setAttribute("aria-current", "step");
      item.append(make("span", "setup-glyph", k === "done" ? "✓" : k === "cur" ? "●" : "○"), make("span", undefined, `${i + 1} · ${t(`setup.step.${s}`)}`));
      nav.append(item);
    });
    return nav;
  };

  const btn = (label: string, cls: string, on: () => void, disabled = false) => {
    const b = make("button", `setup-btn ${cls}`.trim(), label);
    b.type = "button"; b.disabled = disabled;
    b.addEventListener("click", on);
    return b;
  };

  const go = (to: number) => { idx = Math.max(0, Math.min(steps.length - 1, to)); note = ""; draw(true); };
  const next = () => go(idx + 1);

  // ── permissions ──
  const permRow = (r: PermRow) => {
    const row = make("div", "setup-row");
    const text = make("div", "setup-row-text");
    const tag = make("span", `setup-tag tone-${stateTone(r.state)}`);
    tag.append(make("span", "setup-glyph", GLYPH[stateTone(r.state)]), make("span", undefined, t(`setup.state.${r.state}`)));
    const title = make("b", undefined, t(`setup.perm.${r.id}`));
    if (r.state !== "needed") title.append(tag);
    text.append(title, make("span", "setup-row-desc", t(`setup.perm.${r.id}Why`)));
    // macOS applies a Screen Recording grant only after the app is opened again (existing catalogue note).
    if (r.id === "screen" && (r.state === "pending" || r.state === "notGranted")) text.append(make("span", "setup-row-desc", t("computer.restartNote")));
    const acts = make("div", "setup-row-acts");
    if (r.state === "needed") acts.append(btn(t("setup.later"), "ghost", () => { later.add(r.id); draw(); }));
    if (r.state === "needed" || r.state === "later") acts.append(btn(t("setup.allow"), "", () => void allow(r.id)));
    if (r.state === "notGranted" || r.state === "pending") acts.append(btn(t("setup.openSettings"), "primary", () => void openSettings(r.id)));
    row.append(text, acts);
    return row;
  };

  const allow = async (id: PermId) => {
    if (busy) return;
    busy = true; note = "";
    try {
      asked.add(id); later.delete(id);
      if (id === "microphone") { if (await requestMic(deps.nav)) mic = "granted"; }
      else { try { await deps.invoke?.("computer_request_access", { kind: id }); } catch { note = t("setup.err.request"); } }
      await refreshStatus();
    } finally { busy = false; if (!disposed) draw(); }
  };
  const openSettings = async (id: PermId) => {
    try { await deps.invoke?.("computer_open_settings", { pane: SETTINGS_PANE[id] }); } catch { note = t("setup.err.settings"); }
    await recheck();
  };
  /** Re-read the real state (after System Settings, or when the user comes back to this window). */
  const recheck = async () => {
    if (disposed || busy) return;
    await refreshStatus();
    if (!disposed) draw();
  };
  const onBack = () => { if (!document.hidden) void recheck(); };

  const permissionsStep = () => {
    const r = rows();
    const granted = r.filter(x => x.state === "granted").length;
    const sub = granted > 0 && granted < r.length ? t("setup.perm.subSome", { n: granted }) : t("setup.perm.sub");
    const list = make("div", "setup-list");
    for (const x of r) list.append(permRow(x));
    const foot = make("div", "setup-foot");
    foot.append(make("span", "setup-foot-note", computerReady(r) ? t("setup.perm.footReady") : t("setup.perm.footWait")));
    if (idx > 0) foot.append(btn(t("setup.back"), "ghost", () => go(idx - 1)));
    foot.append(btn(computerReady(r) ? t("setup.next") : t("setup.skipComputer"), "primary", next));
    return [make("h1", "setup-title", t("setup.perm.title")), make("p", "setup-sub", sub), list, foot];
  };

  // ── provider key ──
  const keyStep = () => {
    const sel = make("select", "setup-input");
    sel.setAttribute("aria-label", t("setup.key.provider"));
    for (const p of deps.providers) { const o = make("option", undefined, p); o.value = p; sel.append(o); }
    const secret = make("input", "setup-input mono");
    secret.type = "password"; secret.autocomplete = "off"; secret.placeholder = t("setup.key.placeholder");
    secret.setAttribute("aria-label", t("setup.key.secret"));
    const err = make("p", "setup-err", note);
    err.setAttribute("role", "status");
    const save = async () => {
      const value = secret.value.trim();
      if (!value || busy) return;
      busy = true; note = "";
      try {
        await deps.vault.add(sel.value, value);
        keyProvider = sel.value;
        busy = false; secret.value = ""; next(); return;
      } catch { note = t("setup.key.failed"); }
      finally { secret.value = ""; busy = false; }
      if (!disposed) draw();
    };
    secret.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") void save(); });
    const fields = make("div", "setup-fields");
    const f1 = make("label", "setup-field"); f1.append(make("span", "setup-label", t("setup.key.provider")), sel);
    const f2 = make("label", "setup-field"); f2.append(make("span", "setup-label", t("setup.key.secret")), secret);
    fields.append(f1, f2, make("p", "setup-privacy", t("setup.key.privacy")), err);
    const foot = make("div", "setup-foot");
    foot.append(btn(t("setup.key.later"), "ghost setup-foot-start", next));
    if (idx > 0) foot.append(btn(t("setup.back"), "ghost", () => go(idx - 1)));
    foot.append(btn(t("setup.key.save"), "primary", () => void save()));
    return [make("h1", "setup-title", t("setup.key.title")), make("p", "setup-sub", t("setup.key.sub")), fields, foot];
  };

  // ── ready ──
  const readyStep = () => {
    const list = make("div", "setup-list");
    const sum = summarize({ supported: !!(host as HostStatus | null)?.supported, rows: rows(), keyProvider }, t);
    for (const s of sum) {
      const row = make("div", "setup-row");
      const text = make("div", "setup-row-text");
      const tag = make("span", `setup-tag tone-${s.tone}`);
      tag.append(make("span", "setup-glyph", GLYPH[s.tone]));
      text.append(make("b", undefined, t(`setup.step.${s.id}`)), make("span", "setup-row-desc", s.text));
      row.append(tag, text);
      const at = steps.indexOf(s.id);
      if (at >= 0 && s.tone !== "done") {
        const acts = make("span", "setup-row-acts");
        acts.append(btn(t("setup.fix"), "", () => go(at)));
        row.append(acts);
      }
      list.append(row);
    }
    const foot = make("div", "setup-foot");
    foot.append(make("span", "setup-foot-note", computerReady(rows()) ? "" : t("setup.perm.footWait")));
    if (idx > 0) foot.append(btn(t("setup.back"), "ghost", () => go(idx - 1)));
    foot.append(btn(t("setup.finish"), "primary", () => { markSetupDone(deps.storage); close(); }));
    return [make("h1", "setup-title", t("setup.ready.title")), make("p", "setup-sub", t("setup.ready.sub")), list, foot];
  };

  function draw(focus = false) {
    if (disposed) return;
    const id = steps[idx];
    const body = id === "permissions" ? permissionsStep() : id === "key" ? keyStep() : readyStep();
    const live = make("p", "setup-err", id === "permissions" ? note : "");
    live.setAttribute("role", "status");
    card.replaceChildren(stepper(), ...body, live);
    if (focus) {
      const title = body[0] as HTMLElement;
      title.tabIndex = -1;
      title.focus?.();
    }
  }

  const ready = (async () => {
    await refreshStatus();
    let hasKey = false;
    try { hasKey = (await deps.vault.list()).length > 0; } catch { hasKey = false; }
    if (disposed) return;
    steps = planSteps({ supported: !!(host as HostStatus | null)?.supported, hasKey });
    idx = 0;
    draw(true);
    globalThis.addEventListener?.("focus", onBack);
    globalThis.document?.addEventListener?.("visibilitychange", onBack);
    if (deps.contain) release = deps.contain(card, () => { /* the setup is not dismissed with Esc: it ends with a button */ });
  })();
  return { element: root, ready, dispose: close };
}
