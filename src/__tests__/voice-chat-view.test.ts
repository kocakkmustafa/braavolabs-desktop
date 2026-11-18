import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { LOCALES, MESSAGES, makeT } from "../i18n";
import { clock, renderStrip, stripView, summaryLine } from "../voice-chat-view";
import type { VoiceChatModel } from "../voice-chat";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const css = read("../styles.css");
const m = (patch: Partial<VoiceChatModel>): VoiceChatModel => ({ state: "listening", error: null, paused: false, busy: false, heard: "", reply: "", turns: 0, seconds: 0, ...patch });

describe("voice chat strip view (BRA-UI-08)", () => {
  const t = makeT("en");
  it("shows nothing when idle", () => expect(stripView(m({ state: "idle" }), t)).toBeNull());

  it("every state is colour + glyph + word, with the tasarım's actions", () => {
    const ids = (s: Partial<VoiceChatModel>) => stripView(m(s), t)!.buttons.map(b => b.id);
    const listening = stripView(m({ heard: "hello" }), t)!;
    expect(listening).toMatchObject({ tone: "work", glyph: "●", word: "Listening", status: "running", pulse: true, bars: "level", caption: "hello" });
    expect(ids({})).toEqual(["end"]);
    expect(stripView(m({ state: "thinking" }), t)).toMatchObject({ word: "Thinking", bars: "progress", pulse: true });
    expect(ids({ state: "thinking" })).toEqual(["cancel", "end"]);
    const speaking = stripView(m({ state: "speaking", reply: "caption text" }), t)!;
    expect(speaking).toMatchObject({ word: "Speaking", caption: "caption text", live: "off", pulse: false });
    expect(ids({ state: "speaking" })).toEqual(["pause", "interrupt", "end"]);
    expect(ids({ state: "speaking", paused: true })).toEqual(["resume", "interrupt", "end"]);
    expect(stripView(m({ state: "speaking", paused: true }), t)!.buttons[0].pressed).toBe(true);
    const ended = stripView(m({ state: "ended", seconds: 134, turns: 2 }), t)!;
    expect(ended).toMatchObject({ tone: "done", glyph: "✓", word: "Voice chat ended", status: "done" });
    expect(ended.hint).toContain("2:14");
    expect(ids({ state: "ended" })).toEqual(["restart", "backToChat"]);
  });

  it("the four error strips carry the Yazarak devam et way out where recognition is the problem", () => {
    const err = (error: VoiceChatModel["error"]) => stripView(m({ state: "error", error, reply: "yanıt" }), t)!;
    for (const e of ["denied", "unsupported", "offline", "unplayable"] as const) {
      expect(err(e)).toMatchObject({ tone: "err", glyph: "■", status: "error", role: "alert", live: "assertive" });
    }
    expect(err("denied").buttons.map(b => b.id)).toEqual(["typeInstead"]);
    expect(err("unsupported").buttons.map(b => b.id)).toEqual(["typeInstead"]);
    expect(err("offline").buttons.map(b => b.id)).toEqual(["typeInstead", "retry"]);
    expect(err("unplayable").buttons.map(b => b.id)).toEqual(["close", "replay"]);
    expect(stripView(m({ state: "error", error: "unplayable", reply: "" }), t)!.buttons.map(b => b.id)).toEqual(["close"]); // nothing was read: no "read again"
    expect(err("unsupported").word).toBe("Speech recognition is unavailable here");
  });

  it("formats time the same everywhere and builds the chat summary line", () => {
    expect(clock(0)).toBe("0:00"); expect(clock(65)).toBe("1:05");
    expect(summaryLine(makeT("tr"), 3, 134)).toBe("Sesli konuşma · 2:14 · 3 mesaj yazıya döküldü");
  });
});

describe("voice chat i18n", () => {
  const keys = Object.keys(MESSAGES.en).filter(k => k.startsWith("voiceChat."));
  it("exists in all desktop languages, none empty, and the notice carries the AI wording", () => {
    expect(keys.length).toBeGreaterThanOrEqual(30);
    for (const l of LOCALES) for (const k of keys) expect(MESSAGES[l][k]?.trim(), `${l}:${k}`).toBeTruthy();
    expect(MESSAGES.en["voiceChat.intro"]).toBe("Valar is an AI; your speech is transcribed on this device.");
    expect(MESSAGES.tr["voiceChat.intro"]).toBe("Valar bir yapay zekâdır; konuşmanız bu cihazda yazıya çevrilir.");
    expect(MESSAGES.en["voiceChat.button"]).toBe("Voice chat");
  });
  it("has no unused voiceChat key (every key is referenced in the source)", () => {
    const src = ["../ui.ts", "../voice-chat-view.ts"].map(read).join("\n");
    for (const k of keys) {
      const name = k.slice("voiceChat.".length);
      const direct = src.includes(`"${k}"`);
      // keys built as `${key}Hint`, or looked up through the ACTION_KEY / ERRORS tables, are quoted in the view file
      const viaTable = name.endsWith("Hint") && src.includes(`"voiceChat.${name.slice(0, -4)}"`);
      expect(direct || viaTable, k).toBe(true);
    }
  });
});

describe("voice chat is OFF by default and never touches the network", () => {
  const ui = read("../ui.ts");
  it("creates the wave button and strip only inside the flag check", () => {
    const block = ui.slice(ui.indexOf("if (isVoiceChatEnabled())"));
    expect(block.indexOf('el("button", "vc-wave-btn")')).toBeGreaterThan(-1);
    expect(ui.match(/vc-wave-btn/g)).toHaveLength(1);
    expect(ui).toMatch(/\.\.\.\(waveBtn \? \[waveBtn\] : \[\]\)/);
    expect(ui).toMatch(/\.\.\.\(vcHost \? \[vcHost\] : \[\]\)/);
    expect(ui.match(/isVoiceChatEnabled\(\)/g)).toHaveLength(1);
  });
  it("the flag is never switched on in code", () => {
    for (const f of readdirSync(new URL("..", import.meta.url)).filter(n => n.endsWith(".ts"))) {
      expect(read(`../${f}`), f).not.toMatch(/setItem\(\s*(VOICE_CHAT_FLAG_KEY|["']bv\.flags\.voiceChat)/);
    }
  });
  it("voice chat modules import no client and call no fetch/XHR/WebSocket", () => {
    for (const f of ["../voice-chat.ts", "../voice-chat-view.ts", "../voice.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|from "\.\/client"|sendBeacon/);
    }
  });
});

describe("voice chat styles", () => {
  it("wave button is 32px, focus ring lavender, no borders; targets >= 32px", () => {
    expect(css).toMatch(/\.composer \.vc-wave-btn \{[^}]*width: 2rem;[^}]*height: 2rem;/);
    expect(css).toMatch(/\.vc-wave-btn:focus-visible[^{]*\{ outline: 2px solid var\(--focus-ring\)/);
    expect(css).toMatch(/\.vc-btn \{[^}]*height: 2rem;/);
    expect(css.slice(css.indexOf("BRA-UI-08"))).not.toMatch(/border:\s*[1-9]|border:\s*\d+px/);
  });
  it("reduced motion (OS and app toggle) stops pulse and bars", () => {
    const tail = css.slice(css.indexOf("BRA-UI-08"));
    expect(tail).toMatch(/prefers-reduced-motion: reduce\) \{[^}]*\.vc-bars i[^}]*\.vc-badge\.vc-pulse::after \{ animation: none/);
    expect(tail).toMatch(/\.reduce-motion \.vc-bars i[^{]*\.vc-badge\.vc-pulse::after \{ animation: none/);
  });
  it("status colour sits on glyph/badge/bars only; words keep text colours", () => {
    expect(css).toMatch(/\.vc-word \{[^}]*color: var\(--text-1\)/);
    expect(css).toMatch(/\.vc-st \{[^}]*color: var\(--text-2\)/);
    expect(css).toMatch(/\.vc-hint \{[^}]*color: var\(--text-sub\)/);
    expect(css).toMatch(/\.vc-glyph \{[^}]*color: var\(--run\)/);
  });
});

describe("voice chat contrast on its surfaces", () => {
  const tokens = (selector: string) => Object.fromEntries([...css.match(new RegExp(`${selector} \\{([^}]+)\\}`))![1].matchAll(/(--[\w-]+):\s*(#[\da-f]{6});/g)].map(x => [x[1], x[2]]));
  const lum = (hex: string) => { const [r, g, b] = [1, 3, 5].map(i => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
  const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
  it("words >= 4.5:1 on strip/chip/button surfaces; glyph/badge/bar colours >= 3:1", () => {
    const dark = tokens(":root");
    const light = { ...dark, ...tokens(':root\\[data-theme="light"\\]') };
    for (const [name, p] of [["dark", dark], ["light", light]] as const) {
      const sub = p["--text-3"]; // text-3 is the stricter of the two --text-sub values
      for (const bg of ["--surface-card", "--surface-1", "--surface-2", "--surface-sel"]) {
        expect(ratio(p["--text-1"], p[bg]), `${name} text-1/${bg}`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(p["--text-2"], p[bg]), `${name} text-2/${bg}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const bg of ["--surface-card", "--surface-1", "--surface-2"]) expect(ratio(sub, p[bg]), `${name} hint/${bg}`).toBeGreaterThanOrEqual(4.5);
      for (const fg of ["--run", "--error", "--done"]) for (const bg of ["--surface-card", "--surface-1"]) expect(ratio(p[fg], p[bg]), `${name} ${fg}/${bg}`).toBeGreaterThanOrEqual(3);
      expect(ratio(p["--primary-ink"], p["--primary"])).toBeGreaterThanOrEqual(4.5);
    }
  });
});


// ── a tiny DOM, just enough for renderStrip ──────────────────────────────────
class FakeNode {
  children: FakeNode[] = []; attrs: Record<string, string> = {}; dataset: Record<string, string> = {}; listeners: Record<string, Array<() => void>> = {};
  style: Record<string, string> = {}; className = ""; hidden = false; type = ""; private text = ""; rebuilt = 0;
  constructor(readonly tag: string) {}
  get textContent() { return this.text + this.children.map(c => c.textContent).join(""); }
  set textContent(v: string) { this.text = v; this.children = []; }
  append(...n: Array<FakeNode | string>) { for (const x of n) { if (typeof x === "string") this.text += x; else this.children.push(x); } }
  replaceChildren() { this.children = []; this.text = ""; this.rebuilt += 1; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(e: string, f: () => void) { (this.listeners[e] ??= []).push(f); }
  focus() {}
  walk(): FakeNode[] { return [this, ...this.children.flatMap(c => c.walk())]; }
  querySelector(sel: string): FakeNode | null {
    const cls = /^\.([\w-]+)$/.exec(sel)?.[1];
    const act = /^\[data-vc-action="([\w]+)"\]$/.exec(sel)?.[1];
    return this.walk().slice(1).find(n => (cls && n.className.split(" ").includes(cls)) || (act && n.dataset.vcAction === act)) ?? null;
  }
}
const installDom = () => {
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new FakeNode(tag), createElementNS: (_: string, tag: string) => new FakeNode(tag), activeElement: null,
  };
};

describe("renderStrip keeps its skeleton while interim words arrive", () => {
  const t = makeT("en");
  it("rebuilds only when the state changes; buttons stay the same nodes; only the caption text moves; aria-live sits on the state word", () => {
    installDom();
    try {
      const host = new FakeNode("div");
      const clicks: string[] = [];
      const draw = (patch: Partial<VoiceChatModel>) => renderStrip(host as never, stripView(m(patch), t), t, id => clicks.push(id));
      draw({ state: "listening", heard: "" });
      const end = host.querySelector('[data-vc-action="end"]')!;
      const bars = host.querySelector(".vc-bars")!;
      const word = host.querySelector(".vc-word")!;
      const builds = host.rebuilt;
      expect(word.attrs["aria-live"]).toBe("polite");
      expect(host.attrs["aria-live"]).toBeUndefined();
      for (const heard of ["m", "me", "mer", "merha", "merhaba"]) draw({ state: "listening", heard });
      expect(host.rebuilt).toBe(builds);
      expect(host.querySelector('[data-vc-action="end"]')).toBe(end);
      expect(host.querySelector(".vc-bars")).toBe(bars);
      expect(host.querySelector(".vc-word")).toBe(word);
      expect(host.querySelector(".vc-cap")!.textContent).toBe("merhaba");
      end.listeners.click[0]();
      expect(clicks).toEqual(["end"]);
      draw({ state: "thinking", heard: "merhaba" });
      expect(host.rebuilt).toBe(builds + 1);
      expect(host.querySelector(".vc-cap")).toBeNull();
      draw({ state: "idle" });
      expect(host.hidden).toBe(true);
    } finally { delete (globalThis as { document?: unknown }).document; }
  });
});

describe("ui.ts voice wiring (source-level guarantees; the workspace needs a GUI webview)", () => {
  const ui = read("../ui.ts");
  const block = ui.slice(ui.indexOf("send: (text) => {"), ui.indexOf("onChange: (model) => {"));
  it("voice send never reads or writes the composer draft, and refuses nothing silently", () => {
    expect(block).not.toMatch(/ta\.value/);
    expect(block).toContain('return "busy"');
    expect(block).toContain('return "rejected"');
    expect(ui).toContain("run(undefined, { text, token })");
    expect(ui).toContain("if (!retry && !voiceTurn) ta.value =");
    expect(ui).toContain("voiceChat?.laneFree()");
  });
  it("A/B: abandoning a turn kills its token; stopDispatch cancels the waiting voice turn", () => {
    expect(ui).toContain("onAbandon: () => { voiceCurrent = 0; }");
    const stop = ui.slice(ui.indexOf("const stopDispatch = () => {"), ui.indexOf("activeDispatchStopper = stopDispatch"));
    expect(stop).toContain("voiceChat?.cancelTurn()");
  });
  it("daemon answers are handed to voice chat", () => {
    expect(ui).toMatch(/runDaemonTurn\(text, ownsRun, thinkingRow, setRunMotion, showAnswerMotion, voiceAnswer\)/);
    expect(ui).toContain("if (result.text) onAnswer?.(result.text)");
  });
  it("voice turns are tracked by token, so a cancelled turn's finally cannot end a newer turn", () => {
    expect(ui).toContain("voiceTurn.token === voiceCurrent");
    expect(ui).toMatch(/if \(voiceLive\(\)\) \{ voiceCurrent = 0; voiceChat\?\.turnEnded\(\); \}/);
    expect(ui).toMatch(/if \(!vc\.model\.busy\) \{ voiceCurrent = 0; stopDispatch\(\); \}/);
    expect(ui).not.toMatch(/\bvoiceTurn = (true|false)/);
  });
  it("Esc ends voice chat only outside dialogs, when not already handled and focus is in the chat", () => {
    expect(ui).toMatch(/e\.key === "Escape" && voiceChat\?\.active && !e\.defaultPrevented && !settingsOpen && !nowOpen && inChat/);
    expect(ui).toContain("chat.contains(focus)");
  });
});
