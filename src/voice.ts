/**
 * Voice in and out for the chat composer (plan 5.9), on the platform's own speech
 * services — no audio leaves the app through us and no model is added:
 *
 * - Dictation: WebKit's SpeechRecognition. On macOS it is the system's dictation
 *   service (Apple may process the audio, as with Siri dictation); the app needs the
 *   microphone and speech-recognition usage strings in Info.plist.
 * - Read aloud: speechSynthesis with the system voices for the app language.
 *
 * Feature-detected: where the webview has neither, the buttons are never shown.
 * Dictated text only fills the composer; sending stays the user's action.
 */

/** App locale → BCP-47 tag the speech services expect. */
const SPEECH_LANG: Record<string, string> = {
  en: "en-US", tr: "tr-TR", "es-419": "es-419", "pt-BR": "pt-BR", de: "de-DE", fr: "fr-FR", ja: "ja-JP",
  ar: "ar-SA", it: "it-IT", ko: "ko-KR", id: "id-ID", pl: "pl-PL", hi: "hi-IN", "zh-Hans": "zh-CN",
};
export const speechLang = (locale: string): string => SPEECH_LANG[locale] ?? "en-US";

interface RecognitionResultLike { isFinal: boolean; 0: { transcript: string } }
interface RecognitionEventLike { resultIndex: number; results: ArrayLike<RecognitionResultLike> }
interface RecognitionLike {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
type RecognitionCtor = new () => RecognitionLike;
interface SynthesisLike { speak(u: unknown): void; cancel(): void; speaking: boolean }
type UtteranceCtor = new (text: string) => { lang: string; onend: (() => void) | null; onerror: (() => void) | null };

export interface VoiceEnv {
  SpeechRecognition?: RecognitionCtor;
  webkitSpeechRecognition?: RecognitionCtor;
  speechSynthesis?: SynthesisLike;
  SpeechSynthesisUtterance?: UtteranceCtor;
}

export type DictationError = "denied" | "no-speech" | "network" | "failed";

export interface DictationHandlers {
  /** The composer text so far: what was there before plus everything heard (interim included). */
  onText(text: string): void;
  onEnd(error?: { kind: DictationError; detail: string }): void;
}

/** Join without doubling spaces: "draft" + "the post" → "draft the post". */
export function appendSpoken(before: string, spoken: string): string {
  const s = spoken.trim();
  if (!s) return before;
  return before && !/\s$/.test(before) ? `${before} ${s}` : `${before}${s}`;
}

export function createVoice(env: VoiceEnv = globalThis as unknown as VoiceEnv) {
  const Recognition = env.SpeechRecognition ?? env.webkitSpeechRecognition;
  const synth = env.speechSynthesis;
  const Utterance = env.SpeechSynthesisUtterance;
  let active: RecognitionLike | null = null;

  return {
    canDictate: typeof Recognition === "function",
    canSpeak: Boolean(synth && typeof Utterance === "function"),
    get listening() { return active !== null; },

    /** Start dictation into `before`; resolves nothing — results arrive through the handlers. */
    dictate(locale: string, before: string, h: DictationHandlers): boolean {
      if (!Recognition || active) return false;
      const rec = new Recognition();
      rec.lang = speechLang(locale);
      rec.continuous = true;
      rec.interimResults = true;
      let finalText = "";
      let failure: { kind: DictationError; detail: string } | undefined;
      rec.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText = appendSpoken(finalText, r[0].transcript);
          else interim = appendSpoken(interim, r[0].transcript);
        }
        h.onText(appendSpoken(appendSpoken(before, finalText), interim));
      };
      rec.onerror = (e) => {
        const code = String(e?.error ?? "failed");
        // "aborted" is our own stop; it is not a failure.
        if (code === "aborted") return;
        failure = {
          kind: code === "not-allowed" || code === "service-not-allowed" ? "denied" : code === "no-speech" ? "no-speech" : code === "network" ? "network" : "failed",
          detail: code.slice(0, 80),
        };
      };
      rec.onend = () => {
        if (active === rec) active = null;
        h.onText(appendSpoken(before, finalText));
        h.onEnd(failure);
      };
      try { rec.start(); } catch (error) {
        h.onEnd({ kind: "failed", detail: String(error instanceof Error ? error.message : error).slice(0, 80) });
        return false;
      }
      active = rec;
      return true;
    },

    stopDictation(): void { active?.stop(); },

    /** Read text aloud in the app language; any earlier reading stops first. */
    speak(text: string, locale: string, onEnd?: () => void): boolean {
      if (!synth || !Utterance || !text.trim()) return false;
      synth.cancel();
      const u = new Utterance(text.slice(0, 20_000));
      u.lang = speechLang(locale);
      u.onend = () => onEnd?.();
      u.onerror = () => onEnd?.();
      synth.speak(u);
      return true;
    },

    stopSpeaking(): void { synth?.cancel(); },
    get speaking() { return Boolean(synth?.speaking); },
  };
}

export type Voice = ReturnType<typeof createVoice>;
