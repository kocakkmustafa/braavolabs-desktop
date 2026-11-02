import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { appendSpoken, createVoice, speechLang, type VoiceEnv } from "../voice";

class FakeRecognition {
  static last: FakeRecognition;
  lang = ""; continuous = false; interimResults = false;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0; stopped = 0;
  constructor() { FakeRecognition.last = this; }
  start() { this.started += 1; }
  stop() { this.stopped += 1; this.onerror?.({ error: "aborted" }); this.onend?.(); }
  abort() { this.stop(); }
  hear(results: Array<[string, boolean]>, resultIndex = 0) {
    this.onresult?.({ resultIndex, results: results.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })) });
  }
}

function fakeSynth() {
  const spoken: Array<{ text: string; lang: string; onend: (() => void) | null }> = [];
  class Utterance { lang = ""; onend: (() => void) | null = null; onerror: (() => void) | null = null; constructor(readonly text: string) {} }
  const synth = { speaking: false, cancel: vi.fn(), speak: (u: Utterance) => { spoken.push(u); } };
  return { env: { speechSynthesis: synth, SpeechSynthesisUtterance: Utterance } as unknown as VoiceEnv, spoken, synth };
}

describe("voice (plan 5.9)", () => {
  it("is absent where the webview has no speech services", () => {
    const v = createVoice({});
    expect(v.canDictate).toBe(false);
    expect(v.canSpeak).toBe(false);
    expect(v.dictate("en", "", { onText: vi.fn(), onEnd: vi.fn() })).toBe(false);
    expect(v.speak("hi", "en")).toBe(false);
  });

  it("dictates into the composer text in the app language, interim words included, final words kept", () => {
    const v = createVoice({ webkitSpeechRecognition: FakeRecognition as never });
    const texts: string[] = []; const onEnd = vi.fn();
    expect(v.dictate("tr", "Taslak:", { onText: t => texts.push(t), onEnd })).toBe(true);
    const rec = FakeRecognition.last;
    expect(rec).toMatchObject({ lang: "tr-TR", continuous: true, interimResults: true, started: 1 });
    expect(v.listening).toBe(true);
    expect(v.dictate("tr", "", { onText: vi.fn(), onEnd: vi.fn() })).toBe(false);
    rec.hear([["lansman", false]]);
    rec.hear([["lansman yazısı", true]]);
    rec.hear([["lansman yazısı", true], ["pazartesi", false]], 1);
    expect(texts).toEqual(["Taslak: lansman", "Taslak: lansman yazısı", "Taslak: lansman yazısı pazartesi"]);
    v.stopDictation();
    expect(texts.at(-1)).toBe("Taslak: lansman yazısı");
    expect(onEnd).toHaveBeenCalledWith(undefined);
    expect(v.listening).toBe(false);
  });

  it("reports a denied microphone and other failures, but not its own stop", () => {
    const v = createVoice({ SpeechRecognition: FakeRecognition as never });
    const onEnd = vi.fn();
    v.dictate("en", "", { onText: vi.fn(), onEnd });
    FakeRecognition.last.onerror?.({ error: "not-allowed" });
    FakeRecognition.last.onend?.();
    expect(onEnd).toHaveBeenLastCalledWith({ kind: "denied", detail: "not-allowed" });
    v.dictate("en", "", { onText: vi.fn(), onEnd });
    FakeRecognition.last.onerror?.({ error: "audio-capture" });
    FakeRecognition.last.onend?.();
    expect(onEnd).toHaveBeenLastCalledWith({ kind: "failed", detail: "audio-capture" });
  });

  it("reads aloud one text at a time in the app language", () => {
    const { env, spoken, synth } = fakeSynth();
    const v = createVoice(env);
    const done = vi.fn();
    expect(v.canSpeak).toBe(true);
    expect(v.speak("  ", "en")).toBe(false);
    expect(v.speak("Merhaba", "tr", done)).toBe(true);
    expect(synth.cancel).toHaveBeenCalledTimes(1);
    expect(spoken[0]).toMatchObject({ text: "Merhaba", lang: "tr-TR" });
    spoken[0].onend?.();
    expect(done).toHaveBeenCalled();
    v.stopSpeaking();
    expect(synth.cancel).toHaveBeenCalledTimes(2);
  });

  it("joins spoken words without doubled spaces and maps every app locale", () => {
    expect(appendSpoken("", " hi ")).toBe("hi");
    expect(appendSpoken("a", "b")).toBe("a b");
    expect(appendSpoken("a ", "b")).toBe("a b");
    expect(appendSpoken("a", "  ")).toBe("a");
    for (const l of ["en", "tr", "es-419", "pt-BR", "de", "fr", "ja", "ar", "it", "ko", "id", "pl", "hi", "zh-Hans"]) expect(speechLang(l)).toMatch(/^[a-z]{2}-[A-Z0-9]{2,3}$/);
    expect(speechLang("xx")).toBe("en-US");
  });

  it("declares why the app asks for the microphone and speech recognition", () => {
    const plist = readFileSync(new URL("../../src-tauri/Info.plist", import.meta.url), "utf8");
    expect(plist).toMatch(/<key>NSMicrophoneUsageDescription<\/key>\s*<string>[^<]{20,}<\/string>/);
    expect(plist).toMatch(/<key>NSSpeechRecognitionUsageDescription<\/key>\s*<string>[^<]{20,}<\/string>/);
  });
});
