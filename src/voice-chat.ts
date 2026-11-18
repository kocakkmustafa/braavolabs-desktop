/**
 * Voice chat (BRA-UI-08): a hands-free loop on top of the device's own speech services.
 *
 *   idle → listening → thinking → speaking → listening → … → ended
 *
 * Pure state machine. The webview APIs live behind `Voice` (voice.ts), which takes an
 * injectable env, so every transition and failure path is testable with fakes. Nothing
 * here touches the network: what is heard goes through the chat's existing send path and
 * the reply is read with speechSynthesis. No audio and no extra request leaves the device
 * through us. Default OFF behind a local flag; see `isVoiceChatEnabled`.
 */
import type { Voice } from "./voice";

export type VoiceChatState = "idle" | "listening" | "thinking" | "speaking" | "ended" | "error";
/** denied = mic/speech permission; unsupported = no recognition/synthesis here; offline; unplayable = reply could not be read. */
export type VoiceChatError = "denied" | "unsupported" | "offline" | "unplayable";

export interface VoiceChatModel {
  state: VoiceChatState;
  error: VoiceChatError | null;
  paused: boolean;
  /** What was heard in the current turn (interim included). */
  heard: string;
  /** What is being read aloud (caption); kept after an "unplayable" failure so it can be replayed. */
  reply: string;
  turns: number;
  seconds: number;
}

export interface VoiceChatSummary { turns: number; seconds: number }

export interface VoiceChatDeps {
  voice: Voice;
  locale(): string;
  online(): boolean;
  /** Hand the heard text to the chat's normal send path. */
  send(text: string): void;
  now?(): number;
  onChange(model: Readonly<VoiceChatModel>): void;
  /** Voice chat ended after at least one turn. */
  onEnded?(summary: VoiceChatSummary): void;
}

/** Empty or silent turns in a row before voice chat closes itself. */
export const MAX_EMPTY_TURNS = 3;
const CAPTION_MAX = 600;
const SPEAKABLE_MAX = 4000;

/** Markdown/code are not read aloud: fenced code, diffs, inline code, links, markers. */
export function speakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/^(\+\+\+|---|@@).*$/gm, " ")
    .replace(/`([^`]*)`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~|]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SPEAKABLE_MAX);
}

export function createVoiceChat(deps: VoiceChatDeps) {
  const now = deps.now ?? (() => Date.now());
  const m: VoiceChatModel = { state: "idle", error: null, paused: false, heard: "", reply: "", turns: 0, seconds: 0 };
  let gen = 0; // bumps on every phase change; callbacks from an earlier phase are ignored
  let startedAt = 0;
  let empty = 0;
  let pendingText = "";
  const emit = () => deps.onChange({ ...m });
  const set = (patch: Partial<VoiceChatModel>) => { Object.assign(m, patch); emit(); };

  const fail = (error: VoiceChatError) => {
    gen++;
    deps.voice.stopSpeaking();
    set({ state: "error", error, paused: false });
  };

  const listen = () => {
    const g = ++gen;
    set({ state: "listening", error: null, paused: false, heard: "" });
    const started = deps.voice.dictate(deps.locale(), "", {
      onText: (text) => { if (g === gen) set({ heard: text }); },
      onEnd: (error) => { if (g === gen) heardEnd(error); },
    }, { continuous: false });
    if (!started && g === gen) fail("unsupported");
  };

  const heardEnd = (error?: { kind: string }) => {
    if (error?.kind === "denied") return fail("denied");
    if (error?.kind === "network") return fail("offline");
    if (error?.kind === "failed") return fail("unsupported");
    const text = m.heard.trim();
    if (!text) {
      // "no-speech" or nothing recognised: listen again a few times, then close quietly.
      if (++empty >= MAX_EMPTY_TURNS) return end();
      return listen();
    }
    submit(text);
  };

  const submit = (text: string) => {
    empty = 0;
    if (!deps.online()) { pendingText = text; set({ heard: text }); return fail("offline"); }
    pendingText = "";
    gen++;
    set({ state: "thinking", error: null, heard: text, turns: m.turns + 1 });
    deps.send(text);
  };

  const speakReply = (text: string) => {
    const g = ++gen;
    set({ state: "speaking", error: null, paused: false, reply: text.slice(0, CAPTION_MAX) });
    const ok = deps.voice.speak(text, deps.locale(), () => { if (g === gen) listen(); }, () => { if (g === gen) fail("unplayable"); });
    if (!ok && g === gen) fail("unplayable");
  };

  const end = () => {
    gen++;
    deps.voice.stopSpeaking();
    deps.voice.abortDictation();
    const seconds = Math.max(0, Math.round((now() - startedAt) / 1000));
    if (m.turns > 0) {
      set({ state: "ended", error: null, paused: false, heard: "", seconds });
      deps.onEnded?.({ turns: m.turns, seconds });
    } else {
      set({ state: "idle", error: null, paused: false, heard: "", reply: "", seconds });
    }
  };

  return {
    get model(): Readonly<VoiceChatModel> { return m; },
    get active() { return m.state === "listening" || m.state === "thinking" || m.state === "speaking"; },

    start(): void {
      if (m.state === "listening" || m.state === "thinking" || m.state === "speaking") return;
      startedAt = now(); empty = 0; pendingText = "";
      set({ turns: 0, seconds: 0, reply: "", heard: "" });
      if (!deps.voice.canDictate || !deps.voice.canSpeak) return fail("unsupported");
      listen();
    },

    /** "Bitir" (also Esc): stop speech and microphone; a short summary stays when there was a turn. */
    end(): void { if (m.state !== "idle") end(); },

    /** "Yazarak devam et" / "Sohbete dön": leave voice chat without a summary strip. */
    dismiss(): void {
      gen++;
      deps.voice.stopSpeaking(); deps.voice.abortDictation();
      set({ state: "idle", error: null, paused: false, heard: "", reply: "" });
    },

    /** "Sözünü kes": cut the reading and listen again. */
    interrupt(): void { if (m.state === "speaking") { deps.voice.stopSpeaking(); listen(); } },

    togglePause(): void {
      if (m.state !== "speaking") return;
      if (m.paused) deps.voice.resumeSpeaking(); else deps.voice.pauseSpeaking();
      set({ paused: !m.paused });
    },

    /** "Vazgeç" while thinking: ignore the pending answer and listen again. */
    cancelTurn(): void { if (m.state === "thinking") listen(); },

    /** The chat produced an answer for the turn voice chat sent. */
    reply(markdown: string): void {
      if (m.state !== "thinking") return;
      const text = speakable(markdown);
      if (!text) return listen(); // code/diff only: nothing to read
      speakReply(text);
    },

    /** The chat turn ended without an answer (error card is already in the chat): keep listening. */
    turnEnded(): void { if (m.state === "thinking") listen(); },

    /** Error-strip "Tekrar dene". */
    retry(): void {
      if (m.state !== "error") return;
      if (m.error === "offline" && pendingText) return submit(pendingText);
      if (m.error === "offline") return listen();
      if (m.error === "unplayable") return speakReply(m.reply);
      startedAt = now(); empty = 0;
      if (!deps.voice.canDictate || !deps.voice.canSpeak) return fail("unsupported");
      listen();
    },

    /** Error-strip "Kapat" for an unreadable reply: its text stays in the chat; carry on listening. */
    closeError(): void { if (m.state === "error") listen(); },
  };
}

export type VoiceChat = ReturnType<typeof createVoiceChat>;

// ── flag + first-run notice (local storage, same `bv.*` convention as prefs.ts / inbox.ts) ──
export const VOICE_CHAT_FLAG_KEY = "bv.flags.voiceChat";
export const VOICE_CHAT_INTRO_KEY = "bv.prefs.voiceChatIntroSeen";

export interface VoiceChatStorage { getItem(key: string): string | null; setItem?(key: string, value: string): void }
const defaultStorage = (): VoiceChatStorage | undefined => (globalThis as { localStorage?: VoiceChatStorage }).localStorage;

/** Only the literal "1" enables voice chat. Missing/unreadable storage = off. */
export function isVoiceChatEnabled(storage?: VoiceChatStorage): boolean {
  try { return (storage ?? defaultStorage())?.getItem(VOICE_CHAT_FLAG_KEY) === "1"; } catch { return false; }
}

export function voiceChatIntroSeen(storage?: VoiceChatStorage): boolean {
  try { return (storage ?? defaultStorage())?.getItem(VOICE_CHAT_INTRO_KEY) === "1"; } catch { return false; }
}

/** Remember the one-line AI notice was shown; false when storage is unavailable (then it shows again next time). */
export function markVoiceChatIntroSeen(storage?: VoiceChatStorage): boolean {
  try { const s = storage ?? defaultStorage(); if (!s?.setItem) return false; s.setItem(VOICE_CHAT_INTRO_KEY, "1"); return true; } catch { return false; }
}
