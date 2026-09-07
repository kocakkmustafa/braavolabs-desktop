import approved from "./assets/approved-motion.json";
import atlasUrl from "./assets/mascot-gestures-expressive-v1.png";
import coinUrl from "./assets/coin-front-a.png";
import { applyReducedMotion, type Prefs } from "./prefs";

export type MotionState = keyof typeof approved.states;

export function motionSequence(state: MotionState): { frames: readonly number[]; delays: readonly number[] } {
  return approved.states[state];
}

export function runMotion(status: string): MotionState {
  const states: Readonly<Record<string, string>> = approved.runStates;
  return Object.hasOwn(states, status) ? states[status] as MotionState : "idle";
}

/** A terminal poll status alone cannot establish a usable Compare answer. */
export function compareProgressMotion(status: string): MotionState {
  const state = runMotion(status);
  return state === "success" ? "idle" : state;
}

export function answerMotion(answer: unknown): MotionState {
  return typeof answer === "string" && answer.trim().length > 0 ? "success" : "error";
}

export function compareMotion(result: {
  status: string; hasResult: boolean; finalAnswer: string; synthesis: string;
}): MotionState {
  if (result.status !== "COMPLETED") return runMotion(result.status);
  return result.hasResult && (answerMotion(result.finalAnswer) === "success" || answerMotion(result.synthesis) === "success")
    ? "success" : "error";
}

const PREFERENCE_EVENT = "braavo:motion-preference";

/** Notify existing decorations after the app's persisted toggle changes. */
export function notifyBrandMotionPreference(): void {
  document.dispatchEvent(new Event(PREFERENCE_EVENT));
}

/** Keep the effective CSS preference current, including an OS true → false
 * transition. The app's own saved reduction can never be overridden off. */
export function watchBrandMotionPreference(prefs: Pick<Prefs, "reducedMotion">): () => void {
  let media: MediaQueryList;
  try { media = window.matchMedia("(prefers-reduced-motion: reduce)"); } catch { return () => {}; }
  const sync = () => {
    applyReducedMotion(document.documentElement, prefs.reducedMotion() || media.matches);
    notifyBrandMotionPreference();
  };
  media.addEventListener("change", sync);
  sync();
  return () => media.removeEventListener("change", sync);
}

export interface BrandMotion {
  element: HTMLSpanElement;
  setState(state: MotionState): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

type BrandMotionOptions = { state?: MotionState; kind?: "mascot" | "coin"; size?: number };

/** Recheck visual ownership AFTER awaited work, before allocating listeners
 * or attaching a new coin to a chat that may now belong to another session. */
export function createOwnedBrandMotion(ownsMotion: () => boolean, options: BrandMotionOptions): BrandMotion | undefined {
  return ownsMotion() ? createBrandMotion(options) : undefined;
}

/** Visual state only: this controller never starts or settles product work. */
export function createBrandMotion(options: BrandMotionOptions = {}): BrandMotion {
  const kind = options.kind ?? "mascot";
  const element = document.createElement("span");
  element.className = `brand-motion brand-motion-${kind}`;
  element.setAttribute("aria-hidden", "true");
  const size = options.size ?? (kind === "mascot" ? 88 : 20);
  element.style.width = `${size}px`;
  element.style.height = `${size}px`;

  if (kind === "mascot") {
    element.style.backgroundImage = `url("${atlasUrl}")`;
  } else {
    const image = document.createElement("img");
    image.src = coinUrl;
    image.alt = "";
    image.draggable = false;
    element.append(image);
  }

  let state = options.state ?? "idle";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let inView = false;
  let surfaceVisible = true;
  let focused = document.hasFocus();
  let started = false;
  let finished = false;
  let frameIndex = 0;
  // A missing media/viewport capability stays static; it cannot silently opt
  // a user into motion when the relevant preference or visibility is unknown.
  let media: MediaQueryList | undefined;
  try { media = window.matchMedia("(prefers-reduced-motion: reduce)"); } catch { /* static fallback */ }

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const draw = (frame: number) => {
    element.dataset.frame = String(frame);
    if (kind === "mascot") {
      element.style.backgroundPosition = `${(frame % approved.columns) * 100 / (approved.columns - 1)}% ${Math.floor(frame / approved.columns) * 100 / (approved.rows - 1)}%`;
    }
  };
  const canAnimate = () => !disposed && inView && surfaceVisible && focused && !document.hidden
    && media !== undefined && !media.matches && !document.documentElement.classList.contains("reduce-motion");

  const schedule = () => {
    const sequence = motionSequence(state);
    if (frameIndex >= sequence.frames.length - 1) { finished = true; return; }
    timer = setTimeout(() => {
      timer = undefined;
      if (!canAnimate()) { sync(); return; }
      frameIndex += 1;
      draw(sequence.frames[frameIndex]);
      schedule();
    }, sequence.delays[frameIndex]);
  };
  const sync = () => {
    if (disposed) return;
    element.dataset.state = state;
    const active = canAnimate();
    element.dataset.motionActive = String(active && state === "thinking");
    if (kind === "coin") return;
    const sequence = motionSequence(state);
    if (!active) {
      clearTimer();
      if (started) finished = true;
      draw(sequence.frames[sequence.frames.length - 1]);
      return;
    }
    if (!started && !finished) {
      started = true;
      frameIndex = 0;
      draw(sequence.frames[0]);
      schedule();
    }
  };

  const onBlur = () => { focused = false; sync(); };
  const onFocus = () => { focused = true; sync(); };
  document.addEventListener("visibilitychange", sync);
  document.addEventListener(PREFERENCE_EVENT, sync);
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus);
  media?.addEventListener("change", sync);
  const observer = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
      inView = entries.some((entry) => entry.isIntersecting);
      sync();
    }) : undefined;
  observer?.observe(element);
  sync();

  return {
    element,
    setState(next) {
      if (disposed || next === state) return;
      clearTimer();
      state = next;
      started = false;
      finished = false;
      sync();
    },
    setVisible(visible) { surfaceVisible = visible; sync(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer();
      element.dataset.motionActive = "false";
      observer?.disconnect();
      document.removeEventListener("visibilitychange", sync);
      document.removeEventListener(PREFERENCE_EVENT, sync);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      media?.removeEventListener("change", sync);
    },
  };
}
