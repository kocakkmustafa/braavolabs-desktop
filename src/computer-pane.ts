/**
 * Computer control pane (plan 5.8). Off until the user starts a session. It explains the two
 * macOS permissions (Screen Recording, Accessibility) before anything else, lets the user
 * pick the apps an agent may use, and shows the running session (actions left, time left,
 * Stop). The test button takes one governed screenshot of an allowed app.
 */
import type { GateFn } from "./browser";
import { computerActionToGate, governedComputer, type ComputerAction, type ComputerDriver, type ComputerResult, type TargetApp } from "./computer";
import type { Translator } from "./i18n";

export type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface ComputerStatus {
  supported: boolean;
  accessibility: boolean;
  screenRecording: boolean;
  apps: Array<{ bundleId: string; name: string; blocked: string | null }>;
  allowApps: string[];
  session: { id: string; actions: number; maxActions: number; remainingSecs: number; readGranted: boolean } | null;
}

/** The host command for an already-gated action: the same fields the gate bound. */
export function tauriComputerDriver(invoke: Invoke): ComputerDriver {
  return {
    async dispatch(action: ComputerAction, app: TargetApp, sessionId: string, token: string | null): Promise<ComputerResult> {
      const { detail } = computerActionToGate(action, app, sessionId);
      const input = { op: action.op, app: app.bundleId, sessionId, x: detail.x, y: detail.y, value: detail.value };
      const out = (await invoke("computer_dispatch", { token, input, ts: Date.now() })) as { ok: boolean; png?: string; width?: number; height?: number; pointsWidth?: number };
      return { ok: out.ok, png: out.png, width: out.width, height: out.height, scale: out.width && out.pointsWidth ? out.width / out.pointsWidth : undefined };
    },
  };
}

export interface ComputerPaneDeps { t: Translator; invoke: Invoke; gate: GateFn; now?: () => number }

export function createComputerPane(deps: ComputerPaneDeps) {
  const { t, invoke } = deps;
  const driver = tauriComputerDriver(invoke);
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const message = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 300);

  const root = el("section", "bp-root cc-root");
  const status = el("div", "cp-sub"); status.setAttribute("role", "status");
  const perms = el("div", "cc-perms");
  const appsBox = el("div", "cc-apps");
  const sessionBox = el("div", "cc-session");
  const shot = el("img", "cc-shot") as HTMLImageElement; shot.hidden = true; shot.alt = t("computer.shotAlt");
  root.append(el("div", "rail-section-label", t("computer.title")), el("p", "cp-hint", t("computer.note")), perms, appsBox, sessionBox, status, shot);

  let state: ComputerStatus | null = null;
  const session = { id: "", readGranted: false };
  const say = (text: string, error = false) => { status.textContent = text; status.className = error ? "cp-error" : "cp-sub"; };

  const permCard = (key: "screen" | "accessibility", granted: boolean) => {
    const card = el("div", "cc-perm");
    const head = el("div", "cp-row-between");
    head.append(el("div", "company-name", t(`computer.perm.${key}`)), el("span", granted ? "cc-ok" : "cc-missing", granted ? t("computer.granted") : t("computer.notGranted")));
    card.append(head, el("p", "cp-hint", t(`computer.perm.${key}Why`)));
    if (!granted) {
      const row = el("div", "cp-inline");
      const ask = el("button", "set-btn", t("computer.ask"));
      ask.addEventListener("click", () => void invoke("computer_request_access", { kind: key }).then(refresh, e => say(message(e), true)));
      const open = el("button", "set-btn", t("computer.openSettings"));
      open.addEventListener("click", () => void invoke("computer_open_settings", { pane: key }).catch(e => say(message(e), true)));
      row.append(ask, open);
      card.append(row);
      if (key === "screen") card.append(el("p", "cp-hint", t("computer.restartNote")));
    }
    return card;
  };

  const renderApps = (s: ComputerStatus) => {
    appsBox.replaceChildren(el("div", "rail-section-label", t("computer.apps")), el("p", "cp-hint", t("computer.appsNote")));
    const allowed = new Set(s.allowApps);
    const known = new Set(s.apps.map(a => a.bundleId));
    const rows = [...s.apps, ...s.allowApps.filter(id => !known.has(id)).map(id => ({ bundleId: id, name: id, blocked: null }))];
    for (const a of rows) {
      const label = el("label", "cc-app");
      const box = el("input") as HTMLInputElement;
      box.type = "checkbox"; box.checked = allowed.has(a.bundleId); box.disabled = !!a.blocked;
      box.addEventListener("change", () => {
        const next = rows.filter(r => r.bundleId === a.bundleId ? box.checked : allowed.has(r.bundleId)).map(r => r.bundleId);
        void invoke("computer_set_allow", { apps: next }).then(refresh, e => say(message(e), true));
      });
      label.append(box, el("span", "", a.name || a.bundleId), el("span", "cp-sub mono", a.bundleId));
      if (a.blocked) label.append(el("span", "cp-sub", `· ${a.blocked}`));
      appsBox.append(label);
    }
  };

  const renderSession = (s: ComputerStatus) => {
    sessionBox.replaceChildren();
    const ready = s.accessibility && s.screenRecording && s.allowApps.length > 0;
    if (s.session) {
      session.id = s.session.id; session.readGranted = s.session.readGranted;
      const banner = el("div", "cc-banner", t("computer.active", {
        actions: String(s.session.actions), max: String(s.session.maxActions),
        minutes: String(Math.floor(s.session.remainingSecs / 60)), seconds: String(s.session.remainingSecs % 60).padStart(2, "0"),
      }));
      banner.setAttribute("role", "status");
      const stop = el("button", "set-btn cc-stop", t("computer.stop"));
      stop.addEventListener("click", () => void invoke("computer_session_stop", { ts: Date.now() }).then(() => { session.id = ""; return refresh(); }, e => say(message(e), true)));
      const pick = el("select", "company-input") as HTMLSelectElement;
      for (const id of s.allowApps) { const o = el("option", "", s.apps.find(a => a.bundleId === id)?.name || id) as HTMLOptionElement; o.value = id; pick.append(o); }
      const test = el("button", "set-btn", t("computer.testShot"));
      test.addEventListener("click", () => void screenshot({ bundleId: pick.value, name: pick.selectedOptions[0]?.textContent ?? undefined }));
      const row = el("div", "cp-inline"); row.append(pick, test, stop);
      sessionBox.append(banner, row);
    } else {
      session.id = ""; session.readGranted = false;
      const start = el("button", "set-btn", t("computer.start"));
      start.disabled = !ready;
      start.addEventListener("click", () => void invoke("computer_session_start", { ts: Date.now() }).then(refresh, e => say(message(e), true)));
      sessionBox.append(el("p", "cp-hint", t(ready ? "computer.startNote" : "computer.notReady")), start);
    }
  };

  async function refresh(): Promise<void> {
    try {
      state = (await invoke("computer_status")) as ComputerStatus;
      if (!state.supported) { perms.replaceChildren(el("p", "cp-hint", t("computer.unsupported"))); appsBox.replaceChildren(); sessionBox.replaceChildren(); return; }
      perms.replaceChildren(permCard("screen", state.screenRecording), permCard("accessibility", state.accessibility));
      renderApps(state);
      renderSession(state);
    } catch (e) { say(message(e), true); }
  }

  async function screenshot(app: TargetApp): Promise<void> {
    if (!session.id || !app.bundleId) return;
    say(t("computer.working"));
    try {
      const out = await governedComputer({ op: "screenshot" }, app, session, deps.gate, driver);
      if (!out.ok) { say(out.reason, true); return; }
      if (!out.result.ok || !out.result.png) { say(out.result.error ?? t("computer.failed"), true); return; }
      shot.src = `data:image/png;base64,${out.result.png}`; shot.hidden = false;
      say(t("computer.shotDone", { width: String(out.result.width ?? 0), height: String(out.result.height ?? 0) }));
    } catch (e) { say(message(e), true); }
    await refresh();
  }

  return { element: root, refresh, screenshot, session };
}
