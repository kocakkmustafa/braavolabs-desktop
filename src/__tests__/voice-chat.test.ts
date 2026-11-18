import { describe, expect, it, vi } from "vitest";
import { createVoice, type VoiceEnv } from "../voice";
import {
  createVoiceChat, isVoiceChatEnabled, markVoiceChatIntroSeen, speakable, voiceChatIntroSeen,
  MAX_EMPTY_TURNS, VOICE_CHAT_FLAG_KEY, VOICE_CHAT_INTRO_KEY, type VoiceChatModel,
} from "../voice-chat";

class FakeRecognition {
  static all: FakeRecognition[] = [];
  static get last() { return FakeRecognition.all[FakeRecognition.all.length - 1]; }
  lang = ""; continuous = true; interimResults = false;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0; aborted = 0; throwOnStart = false;
  constructor() { FakeRecognition.all.push(this); }
  start() { if (this.throwOnStart) throw new Error("boom"); this.started += 1; }
  // Like a real engine: stop()/abort() return at once and onend arrives LATER.
  stop() { queueMicrotask(() => this.onend?.()); }
  abort() { this.aborted += 1; queueMicrotask(() => { this.onerror?.({ error: "aborted" }); this.onend?.(); }); }
  /** One utterance: interim words, then the final result, then the service ends the session. */
  say(text: string) {
    this.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: text } }] });
    this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] });
    this.onend?.();
  }
  fail(error: string) { this.onerror?.({ error }); this.onend?.(); }
  silence() { this.fail("no-speech"); }
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

function setup(opts: { speech?: boolean; recognition?: boolean; online?: boolean } = {}) {
  FakeRecognition.all = [];
  const utterances: Array<{ text: string; lang: string; onend: (() => void) | null; onerror: (() => void) | null }> = [];
  class Utterance { lang = ""; onend: (() => void) | null = null; onerror: (() => void) | null = null; constructor(readonly text: string) { utterances.push(this); } }
  const synth = { speaking: false, cancel: vi.fn(), speak: vi.fn(), pause: vi.fn(), resume: vi.fn() };
  const env: VoiceEnv = {
    ...(opts.recognition === false ? {} : { webkitSpeechRecognition: FakeRecognition as never }),
    ...(opts.speech === false ? {} : { speechSynthesis: synth, SpeechSynthesisUtterance: Utterance as never }),
  };
  const sent: string[] = [];
  let sendResult: "sent" | "busy" | "rejected" = "sent";
  const models: VoiceChatModel[] = [];
  const ended = vi.fn();
  let online = opts.online ?? true;
  let clock = 1_000;
  const voice = createVoice(env);
  const chat = createVoiceChat({
    voice, locale: () => "tr", online: () => online,
    send: (t) => { sent.push(t); return sendResult; }, now: () => clock, onChange: (x) => models.push(x), onEnded: ended,
  });
  return { chat, sent, models, ended, utterances, synth, voice, setSend: (r: "sent" | "busy" | "rejected") => { sendResult = r; }, setOnline: (v: boolean) => { online = v; }, tick: (ms: number) => { clock += ms; } };
}

describe("voice chat state machine (BRA-UI-08)", () => {
  it("runs idle → listening → thinking → speaking → listening", () => {
    const t = setup();
    expect(t.chat.model.state).toBe("idle");
    t.chat.start();
    expect(t.chat.model.state).toBe("listening");
    expect(FakeRecognition.last).toMatchObject({ lang: "tr-TR", continuous: false, started: 1 });
    FakeRecognition.last.say("bölgelere göre bak");
    expect(t.sent).toEqual(["bölgelere göre bak"]);
    expect(t.chat.model).toMatchObject({ state: "thinking", heard: "bölgelere göre bak", turns: 1 });
    t.chat.reply("**Kuzey** arttı. Ayrıntı: `x=1`");
    expect(t.chat.model.state).toBe("speaking");
    expect(t.utterances[0]).toMatchObject({ text: "Kuzey arttı. Ayrıntı:", lang: "tr-TR" });
    expect(t.chat.model.reply).toBe("Kuzey arttı. Ayrıntı:");
    t.utterances[0].onend?.();
    expect(t.chat.model.state).toBe("listening");
    expect(FakeRecognition.all).toHaveLength(2);
    expect(FakeRecognition.last.started).toBe(1);
  });

  it("shows interim words while listening", () => {
    const t = setup();
    t.chat.start();
    FakeRecognition.last.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: "merha" } }] });
    expect(t.chat.model.heard).toBe("merha");
  });

  it("Bitir while listening, thinking and speaking stops mic and voice; summary only after a turn", async () => {
    const a = setup();
    a.chat.start();
    a.chat.end();
    expect(a.chat.model.state).toBe("idle");
    expect(FakeRecognition.last.aborted).toBe(1);
    expect(a.ended).not.toHaveBeenCalled();

    const b = setup();
    b.chat.start(); FakeRecognition.last.say("selam");
    b.tick(134_000);
    b.chat.end();
    expect(b.chat.model).toMatchObject({ state: "ended", turns: 1, seconds: 134 });
    expect(b.ended).toHaveBeenCalledWith({ turns: 1, seconds: 134 });
    b.chat.reply("geç gelen yanıt"); // ignored after end
    expect(b.utterances).toHaveLength(0);

    const c = setup();
    c.chat.start(); FakeRecognition.last.say("selam"); c.chat.reply("yanıt");
    c.chat.end();
    expect(c.chat.model.state).toBe("ended");
    expect(c.synth.cancel).toHaveBeenCalled();
    c.utterances[0].onend?.(); // stale end must not restart listening
    expect(c.chat.model.state).toBe("ended");
    c.chat.start(); // Yeniden başlat
    expect(c.chat.model).toMatchObject({ state: "listening", turns: 0 });
    await flush();
    expect(FakeRecognition.last.started).toBe(1);
  });

  it("Sözünü kes cuts the reading and listens; Duraklat/Sürdür toggles", () => {
    const t = setup();
    t.chat.start(); FakeRecognition.last.say("a"); t.chat.reply("uzun yanıt");
    t.chat.togglePause();
    expect(t.synth.pause).toHaveBeenCalled();
    expect(t.chat.model.paused).toBe(true);
    t.chat.togglePause();
    expect(t.synth.resume).toHaveBeenCalled();
    expect(t.chat.model.paused).toBe(false);
    t.chat.togglePause();
    t.chat.interrupt();
    expect(t.chat.model).toMatchObject({ state: "listening", paused: false });
    t.utterances[0].onend?.(); // late end of the cut utterance is ignored
    expect(FakeRecognition.all).toHaveLength(2);
    t.chat.interrupt(); t.chat.togglePause(); // no-ops outside speaking
    expect(t.chat.model.state).toBe("listening");
  });

  it("Vazgeç returns to listening; a turn that ends without an answer says so instead of going quiet; code-only replies are not read", () => {
    const t = setup();
    t.chat.start(); FakeRecognition.last.say("a");
    t.chat.cancelTurn();
    expect(t.chat.model.state).toBe("listening");
    FakeRecognition.last.say("b");
    t.chat.turnEnded();
    expect(t.chat.model).toMatchObject({ state: "error", error: "unplayable", reply: "" });
    t.chat.retry(); // nothing to read again: just listen
    expect(t.chat.model.state).toBe("listening");
    FakeRecognition.last.say("c");
    t.chat.reply("```ts\nconst x = 1\n```");
    expect(t.chat.model.state).toBe("listening");
    expect(t.utterances).toHaveLength(0);
    t.chat.reply("x"); // not thinking: ignored
    expect(t.utterances).toHaveLength(0);
  });

  it("silence listens again, then closes after MAX_EMPTY_TURNS", () => {
    const t = setup();
    t.chat.start();
    for (let i = 1; i < MAX_EMPTY_TURNS; i++) { FakeRecognition.last.silence(); expect(t.chat.model.state).toBe("listening"); }
    expect(FakeRecognition.all).toHaveLength(MAX_EMPTY_TURNS);
    FakeRecognition.last.silence();
    expect(t.chat.model.state).toBe("idle");
    expect(t.sent).toEqual([]);
  });

  it("microphone denied → error 'denied'; Tekrar dene restarts", () => {
    const t = setup();
    t.chat.start();
    FakeRecognition.last.fail("not-allowed");
    expect(t.chat.model).toMatchObject({ state: "error", error: "denied" });
    t.chat.retry();
    expect(t.chat.model.state).toBe("listening");
    FakeRecognition.last.fail("service-not-allowed");
    expect(t.chat.model.error).toBe("denied");
    t.chat.dismiss(); // Yazarak devam et
    expect(t.chat.model.state).toBe("idle");
  });

  it("no recognition / no synthesis → 'unsupported' without touching anything", () => {
    const a = setup({ recognition: false });
    a.chat.start();
    expect(a.chat.model).toMatchObject({ state: "error", error: "unsupported" });
    expect(FakeRecognition.all).toHaveLength(0);
    const b = setup({ speech: false });
    b.chat.start();
    expect(b.chat.model.error).toBe("unsupported");
    b.chat.retry();
    expect(b.chat.model.error).toBe("unsupported");
  });

  it("recognition that cannot start or fails otherwise → 'unsupported'", () => {
    FakeRecognition.all = [];
    const t = setup();
    const orig = FakeRecognition.prototype.start;
    FakeRecognition.prototype.start = function (this: FakeRecognition) { throw new Error("boom"); };
    t.chat.start();
    FakeRecognition.prototype.start = orig;
    expect(t.chat.model).toMatchObject({ state: "error", error: "unsupported" });
    t.chat.retry();
    FakeRecognition.last.fail("audio-capture");
    expect(t.chat.model.error).toBe("unsupported");
  });

  it("offline: speech kept and resent on Tekrar dene; network error from recognition is offline too", () => {
    const t = setup({ online: false });
    t.chat.start(); FakeRecognition.last.say("durum nedir");
    expect(t.chat.model).toMatchObject({ state: "error", error: "offline" });
    expect(t.sent).toEqual([]);
    t.chat.retry(); // still offline
    expect(t.chat.model.error).toBe("offline");
    t.setOnline(true);
    t.chat.retry();
    expect(t.sent).toEqual(["durum nedir"]);
    expect(t.chat.model.state).toBe("thinking");
    t.chat.cancelTurn();
    FakeRecognition.last.fail("network");
    expect(t.chat.model.error).toBe("offline");
    t.chat.retry();
    expect(t.chat.model.state).toBe("listening");
  });

  it("unreadable reply: replay, close, and a failed start both land on 'unplayable'", () => {
    const t = setup();
    t.chat.start(); FakeRecognition.last.say("a"); t.chat.reply("yanıt metni");
    t.utterances[0].onerror?.();
    expect(t.chat.model).toMatchObject({ state: "error", error: "unplayable", reply: "yanıt metni" });
    t.chat.retry(); // Tekrar oku
    expect(t.chat.model.state).toBe("speaking");
    expect(t.utterances[1].text).toBe("yanıt metni");
    t.utterances[1].onerror?.();
    t.chat.closeError(); // Kapat
    expect(t.chat.model.state).toBe("listening");
  });

  it("restart right after Bitir waits for the old session's async onend instead of failing as 'unsupported'", async () => {
    const t = setup();
    t.chat.start();
    const first = FakeRecognition.last;
    t.chat.end();
    t.chat.start(); // old onend has not been delivered yet
    expect(t.chat.model).toMatchObject({ state: "listening", error: null });
    expect(FakeRecognition.all).toHaveLength(1);
    await flush();
    expect(first.aborted).toBe(1);
    expect(FakeRecognition.all).toHaveLength(2);
    expect(FakeRecognition.last.started).toBe(1);
    expect(t.chat.model).toMatchObject({ state: "listening", error: null });
    FakeRecognition.last.say("merhaba");
    expect(t.sent).toEqual(["merhaba"]);
  });

  it("dictation running when the wave button is pressed: stop, then voice chat starts once onend arrives", async () => {
    const t = setup();
    const ended = vi.fn();
    expect(t.voice.dictate("tr", "", { onText: vi.fn(), onEnd: ended })).toBe(true);
    expect(t.voice.dictate("tr", "", { onText: vi.fn(), onEnd: vi.fn() })).toBe(false); // genuinely busy
    t.voice.stopDictation();
    t.chat.start();
    expect(t.chat.model.state).toBe("listening");
    expect(FakeRecognition.all).toHaveLength(1);
    await flush();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(FakeRecognition.all).toHaveLength(2);
    expect(t.chat.model.error).toBeNull();
  });

  it("Bitir while a restart is still queued cancels the queued start", async () => {
    const t = setup();
    t.chat.start(); t.chat.end(); t.chat.start(); t.chat.end();
    await flush();
    expect(FakeRecognition.all).toHaveLength(1);
    expect(t.chat.model.state).toBe("idle");
  });

  it("a sentence heard while the chat is busy waits and is sent when the lane frees up (never dropped)", () => {
    const t = setup();
    t.chat.start();
    t.setSend("busy");
    FakeRecognition.last.say("ikinci soru");
    expect(t.chat.model).toMatchObject({ state: "thinking", busy: true, turns: 0 });
    t.chat.laneFree();
    expect(t.sent).toEqual(["ikinci soru", "ikinci soru"]); // retried once the lane was free (still busy here)
    t.setSend("sent");
    t.chat.laneFree();
    expect(t.sent).toHaveLength(3);
    expect(t.chat.model).toMatchObject({ state: "thinking", busy: false, turns: 1 });
    t.chat.laneFree(); // nothing queued any more
    expect(t.sent).toHaveLength(3);
  });

  it("Vazgeç drops a waiting sentence; turnEnded does not fire while it is waiting; a refused send is 'unplayable'", () => {
    const t = setup();
    t.chat.start(); t.setSend("busy");
    FakeRecognition.last.say("bekleyen");
    t.chat.turnEnded();
    expect(t.chat.model.state).toBe("thinking");
    t.setSend("sent");
    t.chat.cancelTurn();
    t.chat.laneFree();
    expect(t.sent).toEqual(["bekleyen"]);
    expect(t.chat.model.state).toBe("listening");
    t.setSend("rejected");
    FakeRecognition.last.say("reddedilen");
    expect(t.chat.model).toMatchObject({ state: "error", error: "unplayable" });
  });

  it("a daemon-style answer (handed over by the chat, not via the transcript) is read aloud", () => {
    const t = setup();
    t.chat.start(); FakeRecognition.last.say("selam");
    t.chat.reply("Merhaba! Nasıl yardımcı olabilirim?");
    expect(t.chat.model.state).toBe("speaking");
    expect(t.utterances[0].text).toBe("Merhaba! Nasıl yardımcı olabilirim?");
  });

  it("never reaches the network: only the injected send is called", () => {
    const t = setup();
    t.chat.start(); FakeRecognition.last.say("merhaba");
    expect(t.sent).toEqual(["merhaba"]);
  });
});

describe("speakable", () => {
  it("drops code, diffs, links and markdown markers", () => {
    expect(speakable("# Başlık\n- **madde** bir\n```diff\n+ a\n- b\n```\nson [bağlantı](https://x.y) https://z.w")).toBe("Başlık madde bir son bağlantı");
    expect(speakable("```ts\nunterminated")).toBe("");
    expect(speakable("a".repeat(5000))).toHaveLength(4000);
  });
  it("skips tilde fences, longer fences, indented code, unfenced diffs and tables; keeps list items and prose", () => {
    expect(speakable("önce\n\n~~~sh\nrm -rf x\n~~~\n\nsonra")).toBe("önce sonra");
    expect(speakable("a\n````md\n```\ninner\n```\n````\nb")).toBe("a b");
    expect(speakable("Örnek:\n\n    const x = 1;\n    run(x);\n\nBitti.")).toBe("Örnek: Bitti.");
    expect(speakable("Bir paragraf\n    devam eden satır")).toBe("Bir paragraf devam eden satır"); // not code: cannot interrupt a paragraph
    expect(speakable("Değişiklik:\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-eski\n+yeni\n bağlam\n\nTamam.")).toBe("Değişiklik: Tamam.");
    expect(speakable("| Ad | Değer |\n|---|---|\n| a | 1 |\n\nÖzet burada.")).toBe("Özet burada.");
    expect(speakable("- bir\n- iki\n+ üç")).toBe("bir iki üç");
    expect(speakable("```ts\nunterminated\n+ x")).toBe("");
  });
});

describe("flag and first-run notice", () => {
  const mem = (init: Record<string, string> = {}) => { const d = { ...init }; return { d, getItem: (k: string) => d[k] ?? null, setItem: (k: string, v: string) => { d[k] = v; } }; };
  it("is OFF unless the flag is the literal 1; storage failures read as off", () => {
    expect(isVoiceChatEnabled(mem())).toBe(false);
    expect(isVoiceChatEnabled(mem({ [VOICE_CHAT_FLAG_KEY]: "true" }))).toBe(false);
    expect(isVoiceChatEnabled(mem({ [VOICE_CHAT_FLAG_KEY]: "1" }))).toBe(true);
    expect(isVoiceChatEnabled({ getItem: () => { throw new Error("x"); } })).toBe(false);
  });
  it("remembers the notice once", () => {
    const s = mem();
    expect(voiceChatIntroSeen(s)).toBe(false);
    expect(markVoiceChatIntroSeen(s)).toBe(true);
    expect(s.d[VOICE_CHAT_INTRO_KEY]).toBe("1");
    expect(voiceChatIntroSeen(s)).toBe(true);
    expect(markVoiceChatIntroSeen({ getItem: () => null })).toBe(false);
    expect(voiceChatIntroSeen({ getItem: () => { throw new Error("x"); } })).toBe(false);
  });
});
