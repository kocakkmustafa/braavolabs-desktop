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
  /** Thinking, but the chat lane was busy with another reply: the sentence waits and is sent when it frees up. */
  busy: boolean;
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
  /** Hand the heard text to the chat's normal send path (never through the composer draft).
   *  "busy": a reply is still running, keep the sentence and call `laneFree()` later; "rejected": the chat refused it. */
  send(text: string): "sent" | "busy" | "rejected";
  now?(): number;
  onChange(model: Readonly<VoiceChatModel>): void;
  /** Voice chat ended after at least one turn. */
  onEnded?(summary: VoiceChatSummary): void;
  /** Bitir / dismiss / Vazgeç / reset: the chat run voice chat was waiting for no longer has an owner (its answer must not be read). */
  onAbandon?(): void;
}

/** Empty or silent turns in a row before voice chat closes itself. */
export const MAX_EMPTY_TURNS = 3;
const CAPTION_MAX = 600;
const SPEAKABLE_MAX = 4000;

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const DIFF_HEAD = /^(diff --git |index [0-9a-f]+\.\.|--- |\+\+\+ |@@ )/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*:?-{2,}:?(\s*\|\s*:?-{2,}:?)+\s*\|?\s*$/;

/** Markdown/code are not read aloud: fenced code (backticks or tildes), indented code, diffs, tables, inline code, links, markers. */
export function speakable(markdown: string): string {
  const kept: string[] = [];
  let fence: string | null = null; // opening marker of the fence we are inside
  let inDiff = false;
  let inIndented = false;
  let prevBlank = true;
  for (const line of markdown.split(/\r?\n/)) {
    const blank = line.trim() === "";
    if (fence) {
      const close = new RegExp("^\\s{0,3}" + (fence[0] === "`" ? "`" : "~") + "{" + fence.length + ",}\\s*$");
      if (close.test(line)) fence = null;
      continue;
    }
    const open = FENCE.exec(line);
    if (open) { fence = open[1]; inDiff = false; inIndented = false; prevBlank = false; continue; }
    if (DIFF_HEAD.test(line)) { inDiff = true; prevBlank = false; continue; }
    if (inDiff) {
      if (/^[+\- \\]/.test(line)) continue;
      inDiff = false;
    }
    // Indented code cannot interrupt a paragraph: it needs a blank line before it (or more indented code).
    if (/^( {4,}|\t)/.test(line) && !blank && (prevBlank || inIndented)) { inIndented = true; continue; }
    if (!blank) inIndented = false;
    if (TABLE_ROW.test(line) || TABLE_RULE.test(line)) { prevBlank = false; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { prevBlank = true; continue; }
    kept.push(line);
    prevBlank = blank;
  }
  return kept.join("\n")
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
  const m: VoiceChatModel = { state: "idle", error: null, paused: false, busy: false, heard: "", reply: "", turns: 0, seconds: 0 };
  let gen = 0; // bumps on every phase change; callbacks from an earlier phase are ignored
  let startedAt = 0;
  let empty = 0;
  let pendingText = "";
  let queued = ""; // heard while the chat lane was busy
  const emit = () => deps.onChange({ ...m });
  const set = (patch: Partial<VoiceChatModel>) => { Object.assign(m, patch); emit(); };

  const fail = (error: VoiceChatError) => {
    gen++;
    deps.voice.stopSpeaking();
    set({ state: "error", error, paused: false, busy: false });
  };

  const listen = () => {
    const g = ++gen;
    set({ state: "listening", error: null, paused: false, busy: false, heard: "" });
    const started = deps.voice.dictate(deps.locale(), "", {
      onText: (text) => { if (g === gen) set({ heard: text }); },
      onEnd: (error) => { if (g === gen) heardEnd(error); },
    }, { continuous: false, owner: "voicechat" });
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
    set({ state: "thinking", error: null, heard: text, busy: false });
    dispatch(text);
  };

  const dispatch = (text: string) => {
    const result = deps.send(text);
    if (result === "busy") { queued = text; return set({ busy: true }); }
    queued = "";
    if (result === "rejected") return noAnswer();
    set({ busy: false, turns: m.turns + 1 });
  };

  /** The turn produced nothing to read: say so (the chat has the text or error card) instead of going quiet. */
  const noAnswer = () => { m.reply = ""; fail("unplayable"); };

  const speakReply = (text: string) => {
    const g = ++gen;
    set({ state: "speaking", error: null, paused: false, reply: text.slice(0, CAPTION_MAX) });
    const ok = deps.voice.speak(text, deps.locale(), () => { if (g === gen) listen(); }, () => { if (g === gen) fail("unplayable"); });
    if (!ok && g === gen) fail("unplayable");
  };

  const end = () => {
    gen++;
    queued = ""; // deliberate: a sentence still waiting for the lane is dropped when the user ends voice chat
    deps.onAbandon?.();
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
      set({ turns: 0, seconds: 0, reply: "", heard: "", busy: false });
      if (!deps.voice.canDictate || !deps.voice.canSpeak) return fail("unsupported");
      listen();
    },

    /** "Bitir" (also Esc): stop speech and microphone; a short summary stays when there was a turn. */
    end(): void { if (m.state !== "idle") end(); },

    /** "Yazarak devam et" / "Sohbete dön": leave voice chat without a summary strip. */
    dismiss(): void {
      gen++;
      queued = "";
      deps.onAbandon?.();
      deps.voice.stopSpeaking(); deps.voice.abortDictation();
      set({ state: "idle", error: null, paused: false, heard: "", reply: "", busy: false });
    },

    /** "Sözünü kes": cut the reading and listen again. */
    interrupt(): void { if (m.state === "speaking") { deps.voice.stopSpeaking(); listen(); } },

    togglePause(): void {
      if (m.state !== "speaking") return;
      if (m.paused) deps.voice.resumeSpeaking(); else deps.voice.pauseSpeaking();
      set({ paused: !m.paused });
    },

    /** "Vazgeç" while thinking: ignore the pending answer and listen again. */
    cancelTurn(): void { if (m.state === "thinking") { queued = ""; deps.onAbandon?.(); listen(); } },

    /** The chat lane freed up: send the sentence that was waiting. */
    laneFree(): void { if (m.state === "thinking" && queued) { const text = queued; queued = ""; dispatch(text); } },

    /** The chat produced an answer for the turn voice chat sent. */
    reply(markdown: string): void {
      // Not thinking, or thinking but our own sentence is still waiting: this answer belongs to an older run.
      if (m.state !== "thinking" || m.busy) return;
      const text = speakable(markdown);
      if (!text) return listen(); // code/diff only: nothing to read
      speakReply(text);
    },

    /** The chat turn ended without an answer (an error card is already in the chat): say "could not read" rather than going quiet. */
    turnEnded(): void { if (m.state === "thinking" && !m.busy) noAnswer(); },

    /** Error-strip "Tekrar dene". */
    retry(): void {
      if (m.state !== "error") return;
      if (m.error === "offline" && pendingText) return submit(pendingText);
      if (m.error === "offline") return listen();
      if (m.error === "unplayable") return m.reply ? speakReply(m.reply) : listen();
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
