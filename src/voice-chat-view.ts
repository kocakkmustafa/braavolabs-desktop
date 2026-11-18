/**
 * Voice chat strip: pure view-model (what the strip shows for a model) plus a thin DOM applier.
 * Status is always colour + glyph + word; colour only ever touches the glyph/badge/bars,
 * the words stay in text colour (contrast >= 4.5:1). See styles.css `.vc-*`.
 */
import type { VoiceChatError, VoiceChatModel } from "./voice-chat";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export type VcAction =
  | "end" | "cancel" | "pause" | "resume" | "interrupt" | "typeInstead" | "retry" | "replay" | "close" | "restart" | "backToChat";
export type VcTone = "work" | "err" | "done";
export type VcIcon = "mic" | "helmet" | "volume" | "check" | "micOff" | "warn" | "wifiOff" | "volumeOff";

export interface VcButton { id: VcAction; label: string; primary?: boolean; pressed?: boolean }
export interface VcView {
  tone: VcTone;
  glyph: "●" | "■" | "✓";
  icon: VcIcon;
  word: string;
  status: string;
  hint: string;
  /** Listening/speaking carry a caption line; its text updates in place without rebuilding the strip. */
  captionSlot: boolean;
  /** Pulse ring on the badge (listening/thinking). */
  pulse: boolean;
  bars: "none" | "level" | "progress";
  caption: string;
  live: "polite" | "assertive" | "off";
  role: "status" | "alert";
  buttons: VcButton[];
}

/** m:ss, the same in every language. */
export const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

const ERRORS: Record<VoiceChatError, { icon: VcIcon; key: string; actions: Array<[VcAction, boolean]> }> = {
  denied: { icon: "micOff", key: "voiceChat.errDenied", actions: [["typeInstead", true]] },
  unsupported: { icon: "warn", key: "voiceChat.errUnsupported", actions: [["typeInstead", true]] },
  offline: { icon: "wifiOff", key: "voiceChat.errOffline", actions: [["typeInstead", false], ["retry", true]] },
  unplayable: { icon: "volumeOff", key: "voiceChat.errUnplayable", actions: [["close", false], ["replay", true]] },
};

const ACTION_KEY: Record<VcAction, string> = {
  end: "voiceChat.end", cancel: "voiceChat.cancel", pause: "voiceChat.pause", resume: "voiceChat.resume",
  interrupt: "voiceChat.interrupt", typeInstead: "voiceChat.typeInstead", retry: "voiceChat.retry",
  replay: "voiceChat.replay", close: "voiceChat.close", restart: "voiceChat.restart", backToChat: "voiceChat.backToChat",
};

/** null when there is nothing to show (idle). */
export function stripView(m: VoiceChatModel, t: Translate): VcView | null {
  const btn = (id: VcAction, primary = false, pressed?: boolean): VcButton => ({ id, label: t(ACTION_KEY[id]), primary, pressed });
  const run = t("now.running");
  switch (m.state) {
    case "idle": return null;
    case "listening":
      return {
        tone: "work", glyph: "●", icon: "mic", word: t("voiceChat.listening"), status: run, hint: t("voiceChat.listeningHint"), captionSlot: true,
        pulse: true, bars: "level", caption: m.heard, live: "polite", role: "status", buttons: [btn("end", true)],
      };
    case "thinking":
      return {
        tone: "work", glyph: "●", icon: "helmet", word: t("voiceChat.thinking"), status: run, hint: t(m.busy ? "voiceChat.busyHint" : "voiceChat.thinkingHint"), captionSlot: false,
        pulse: true, bars: "progress", caption: "", live: "polite", role: "status", buttons: [btn("cancel"), btn("end", true)],
      };
    case "speaking":
      return {
        tone: "work", glyph: "●", icon: "volume", word: t("voiceChat.speaking"), status: run, hint: t("voiceChat.speakingHint"), captionSlot: true,
        pulse: false, bars: "level", caption: m.reply, live: "off", role: "status",
        buttons: [btn(m.paused ? "resume" : "pause", false, m.paused), btn("interrupt"), btn("end", true)],
      };
    case "ended":
      return {
        tone: "done", glyph: "✓", icon: "check", word: t("voiceChat.ended"), status: t("now.done"),
        hint: t("voiceChat.endedHint", { time: clock(m.seconds) }), captionSlot: false, pulse: false, bars: "none", caption: "", live: "polite", role: "status",
        buttons: [btn("restart"), btn("backToChat", true)],
      };
    case "error": {
      const e = ERRORS[m.error ?? "unsupported"];
      return {
        tone: "err", glyph: "■", icon: e.icon, word: t(e.key), status: t("now.error"), hint: t(`${e.key}Hint`), captionSlot: false,
        pulse: false, bars: "none", caption: "", live: "assertive", role: "alert",
        // Nothing was ever read (the turn gave no answer): "read again" would have nothing to read.
        buttons: (m.error === "unplayable" && !m.reply ? [["close", true]] as Array<[VcAction, boolean]> : e.actions).map(([id, p]) => btn(id, p)),
      };
    }
  }
}

/** The one-line summary left in the chat when voice chat ends after at least one turn. */
export const summaryLine = (t: Translate, turns: number, seconds: number): string =>
  t("voiceChat.summary", { n: turns, time: clock(seconds) });

// ── DOM ──────────────────────────────────────────────────────────────────────
const SVG_NS = "http://www.w3.org/2000/svg";
const PATHS: Record<VcIcon | "wave" | "x" | "info", string[]> = {
  mic: ["M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0Z", "M5 11a7 7 0 0 0 14 0", "M12 18v3.5"],
  micOff: ["M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0Z", "M5 11a7 7 0 0 0 11.5 5.4", "M12 18v3.5", "M3 3l18 18"],
  helmet: ["M6 20V11a6 6 0 0 1 12 0v9Z", "M7.5 10h9", "M9 14v4M12 14v4M15 14v4"],
  volume: ["M11 5 6 9H3v6h3l5 4Z", "M15.5 8.5a5 5 0 0 1 0 7", "M18.5 5.5a9 9 0 0 1 0 13"],
  volumeOff: ["M11 5 6 9H3v6h3l5 4Z", "M22 9l-6 6M16 9l6 6"],
  check: ["M20 6 9 17l-5-5"],
  warn: ["M5 3.5h14a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5Z", "M12 8v5", "M12 16.2h.01"],
  wifiOff: ["M3 3l18 18", "M8.5 16.4a5 5 0 0 1 7 0", "M5 12.9a10 10 0 0 1 5-2.7", "M14 10.3a10 10 0 0 1 5 2.6", "M12 20h.01"],
  wave: ["M4 10v4", "M8 7v10", "M12 4v16", "M16 8v8", "M20 11v2"],
  x: ["M18 6 6 18", "M6 6l12 12"],
  info: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 11v5", "M12 8h.01"],
};

export function vcIcon(name: keyof typeof PATHS, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: String(size), height: String(size), fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  for (const d of PATHS[name]) { const p = document.createElementNS(SVG_NS, "path"); p.setAttribute("d", d); svg.append(p); }
  return svg;
}

const BAR_COUNT = 28;
function levelBars(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "vc-bars";
  for (let i = 0; i < BAR_COUNT; i++) {
    const env = Math.sin((i / (BAR_COUNT - 1)) * Math.PI);
    const bar = document.createElement("i");
    bar.style.height = `${6 + Math.round(env * (10 + 14 * Math.abs(Math.sin(i * 1.7 + 1))))}px`;
    bar.style.animationDelay = `${-((i * 137) % 900)}ms`;
    wrap.append(bar);
  }
  return wrap;
}

function build(host: HTMLElement, view: VcView, t: Translate, on: (id: VcAction) => void): void {
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.vcAction;
  host.replaceChildren();
  host.className = `vc-strip vc-${view.tone}`;

  const line = document.createElement("div");
  line.className = "vc-line";
  const badge = document.createElement("div");
  badge.className = `vc-badge${view.pulse ? " vc-pulse" : ""}`;
  badge.append(vcIcon(view.icon, 20));
  const txt = document.createElement("div");
  txt.className = "vc-txt";
  // Only the state word is a live region: it is announced when the state changes, never per heard word.
  const word = document.createElement("span");
  word.className = "vc-word";
  word.setAttribute("role", view.role);
  word.setAttribute("aria-live", view.live);
  const st = document.createElement("span");
  st.className = "vc-st";
  const glyph = document.createElement("span");
  glyph.className = "vc-glyph";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = view.glyph;
  st.append(glyph, view.status);
  word.append(view.word, st);
  const hint = document.createElement("span");
  hint.className = "vc-hint";
  hint.textContent = view.hint;
  txt.append(word, hint);
  line.append(badge, txt);

  if (view.bars === "level") { const b = levelBars(); b.setAttribute("role", "img"); b.setAttribute("aria-label", t("voiceChat.level")); line.append(b); }
  else if (view.bars === "progress") {
    const p = document.createElement("div");
    p.className = "vc-prog";
    p.setAttribute("role", "progressbar");
    p.setAttribute("aria-label", t("voiceChat.thinkingHint"));
    p.append(document.createElement("i"));
    line.append(p);
  }

  const acts = document.createElement("div");
  acts.className = "vc-acts";
  for (const b of view.buttons) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `vc-btn${b.primary ? " vc-primary" : ""}`;
    el.dataset.vcAction = b.id;
    el.textContent = b.label;
    if (b.pressed !== undefined) el.setAttribute("aria-pressed", String(b.pressed));
    el.addEventListener("click", () => on(b.id));
    acts.append(el);
  }
  line.append(acts);
  host.append(line);

  if (view.captionSlot) {
    const cap = document.createElement("div");
    cap.className = "vc-cap";
    cap.setAttribute("aria-label", t("voiceChat.caption"));
    host.append(cap);
  }
  if (focused) host.querySelector<HTMLElement>(`[data-vc-action="${focused}"]`)?.focus();
}

/**
 * Render the strip into `host`. The skeleton (badge, bars, buttons, live word) is rebuilt only when
 * the STATE changes; interim recognition results update just the caption text node, so buttons stay
 * the same DOM nodes (clicks are never lost), the bar animation is not restarted and screen readers
 * are not re-read the whole strip.
 */
export function renderStrip(host: HTMLElement, view: VcView | null, t: Translate, on: (id: VcAction) => void): void {
  if (!view) { host.replaceChildren(); host.hidden = true; delete host.dataset.vcSig; return; }
  host.hidden = false;
  const sig = JSON.stringify([view.tone, view.glyph, view.icon, view.word, view.status, view.hint, view.captionSlot, view.pulse, view.bars, view.live, view.role, view.buttons.map(b => [b.id, b.label, b.primary, b.pressed])]);
  if (host.dataset.vcSig !== sig) { build(host, view, t, on); host.dataset.vcSig = sig; }
  const cap = host.querySelector<HTMLElement>(".vc-cap");
  if (cap && cap.textContent !== view.caption) cap.textContent = view.caption;
}

/** One-line AI notice (first open only). `onDismiss` fires for both "Anladım" and the close icon. */
export function renderIntro(t: Translate, onDismiss: () => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "vc-info";
  row.setAttribute("role", "note");
  const text = document.createElement("span");
  text.textContent = t("voiceChat.intro");
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "vc-btn vc-ghost";
  ok.textContent = t("voiceChat.introOk");
  ok.addEventListener("click", onDismiss);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "vc-icon-btn";
  close.setAttribute("aria-label", t("voiceChat.close"));
  close.append(vcIcon("x", 15));
  close.addEventListener("click", onDismiss);
  row.append(vcIcon("info", 16), text, ok, close);
  return row;
}
