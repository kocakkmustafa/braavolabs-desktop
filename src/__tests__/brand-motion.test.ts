import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerMotion, compareMotion, createBrandMotion, motionSequence,
  notifyBrandMotionPreference, runMotion,
  watchBrandMotionPreference,
  compareProgressMotion, createOwnedBrandMotion,
} from "../brand-motion";

class FakeElement extends EventTarget {
  className = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: FakeElement[] = [];
  classList = {
    contains: (name: string) => this.className.split(" ").includes(name),
    toggle: (name: string, on: boolean) => { this.className = on ? name : ""; },
  };
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  append(...children: FakeElement[]) { this.children.push(...children); }
}

function environment() {
  const doc = Object.assign(new EventTarget(), {
    hidden: false, focused: true, documentElement: new FakeElement(),
    createElement: () => new FakeElement(), hasFocus: () => doc.focused,
  });
  const media = Object.assign(new EventTarget(), { matches: false });
  const win = Object.assign(new EventTarget(), { matchMedia: () => media });
  let intersect: (entries: Array<{ isIntersecting: boolean }>) => void = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: typeof intersect) { intersect = callback; }
    observe() {}
    disconnect = disconnect;
  });
  return { doc, media, win, disconnect, visible: (value: boolean) => intersect([{ isIntersecting: value }]) };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("approved brand motion truth", () => {
  it("maps actual run states without treating unknown or cancelled work as complete", () => {
    expect(["RUNNING", "COMPLETED", "WAITING_APPROVAL", "FAILED", "PENDING", "PAUSED", "CANCELLED", "ROLLED_BACK", "", "surprise"].map(runMotion))
      .toEqual(["thinking", "success", "attention", "error", "idle", "idle", "idle", "idle", "idle", "idle"]);
  });

  it("requires a nonempty actual answer and completed compare result", () => {
    expect(answerMotion(" useful answer ")).toBe("success");
    for (const answer of ["", " \n ", null, undefined, {}]) expect(answerMotion(answer)).toBe("error");
    const completed = { status: "COMPLETED", hasResult: true, finalAnswer: "answer", synthesis: "" };
    expect(compareMotion(completed)).toBe("success");
    expect(compareMotion({ ...completed, finalAnswer: "", synthesis: "synthesis" })).toBe("success");
    expect(compareMotion({ ...completed, status: "FAILED" })).toBe("error");
    expect(compareMotion({ ...completed, hasResult: false })).toBe("error");
    expect(compareMotion({ ...completed, finalAnswer: " " })).toBe("error");
    expect(compareMotion({ ...completed, status: "CANCELLED" })).toBe("idle");
    expect(compareMotion({ ...completed, status: "unknown" })).toBe("idle");
  });

  it("follows each Compare stub/poll state without celebrating before the answer is checked", () => {
    expect(["PENDING", "RUNNING", "WAITING_APPROVAL", "PAUSED", "FAILED", "COMPLETED", "CANCELLED", "unknown"].map(compareProgressMotion))
      .toEqual(["idle", "thinking", "attention", "idle", "error", "idle", "idle", "idle"]);
  });

  it("uses only the approved one-shot frames and delays", () => {
    expect(motionSequence("thinking")).toEqual({ frames: [0, 2, 3], delays: [450, 220] });
    expect(motionSequence("success")).toEqual({ frames: [4, 5, 6, 7], delays: [420, 160, 240] });
    expect(motionSequence("attention")).toEqual({ frames: [8, 10, 11], delays: [450, 240] });
    for (const state of ["idle", "thinking", "success", "attention", "error"] as const) {
      expect(motionSequence(state).frames.some((frame) => frame === 1 || frame === 9)).toBe(false);
    }
  });
});

describe("brand motion lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());

  it("plays exactly once, then holds the last pose with no timer", () => {
    const env = environment();
    const motion = createBrandMotion({ state: "thinking" });
    env.visible(true);
    expect(motion.element.dataset.frame).toBe("0");
    vi.advanceTimersByTime(450);
    expect(motion.element.dataset.frame).toBe("2");
    vi.advanceTimersByTime(220);
    expect(motion.element.dataset.frame).toBe("3");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(motion.element.dataset.frame).toBe("3");
    motion.dispose();
  });

  it("cancels stale frames when state changes and does not replay identical state", () => {
    const env = environment();
    const motion = createBrandMotion({ state: "success" });
    env.visible(true);
    motion.setState("error");
    vi.advanceTimersByTime(1_000);
    expect(motion.element.dataset.frame).toBe("0");
    expect(vi.getTimerCount()).toBe(0);
    motion.setState("attention");
    vi.advanceTimersByTime(690);
    motion.setState("attention");
    expect(motion.element.dataset.frame).toBe("11");
    expect(vi.getTimerCount()).toBe(0);
    motion.dispose();
  });

  it("honors live OS and app reduced motion, holding a meaningful final pose", () => {
    const env = environment();
    const motion = createBrandMotion({ state: "success" });
    env.visible(true);
    env.media.matches = true;
    env.media.dispatchEvent(new Event("change"));
    expect(motion.element.dataset.frame).toBe("7");
    expect(vi.getTimerCount()).toBe(0);
    env.media.matches = false;
    env.doc.documentElement.className = "reduce-motion";
    notifyBrandMotionPreference();
    motion.setState("attention");
    expect(motion.element.dataset.frame).toBe("11");
    expect(motion.element.dataset.motionActive).toBe("false");
    expect(vi.getTimerCount()).toBe(0);
    motion.dispose();
  });

  it("updates the effective app class when the OS starts reduced then turns motion on", () => {
    const env = environment();
    env.media.matches = true;
    let appReduced = false;
    const dispose = watchBrandMotionPreference({ reducedMotion: () => appReduced });
    expect(env.doc.documentElement.classList.contains("reduce-motion")).toBe(true);
    env.media.matches = false;
    env.media.dispatchEvent(new Event("change"));
    expect(env.doc.documentElement.classList.contains("reduce-motion")).toBe(false);
    appReduced = true;
    env.media.dispatchEvent(new Event("change"));
    expect(env.doc.documentElement.classList.contains("reduce-motion")).toBe(true);
    dispose();
    appReduced = false;
    env.media.dispatchEvent(new Event("change"));
    expect(env.doc.documentElement.classList.contains("reduce-motion")).toBe(true);
  });

  it.each(["hidden", "offscreen", "blur", "surface"])("stops motion on %s and does not replay a completed gesture", (reason) => {
    const env = environment();
    const motion = createBrandMotion({ state: "thinking" });
    env.visible(true);
    if (reason === "hidden") { env.doc.hidden = true; env.doc.dispatchEvent(new Event("visibilitychange")); }
    if (reason === "offscreen") env.visible(false);
    if (reason === "blur") env.win.dispatchEvent(new Event("blur"));
    if (reason === "surface") motion.setVisible(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(motion.element.dataset.motionActive).toBe("false");
    expect(motion.element.dataset.frame).toBe("3");
    env.doc.hidden = false;
    env.doc.dispatchEvent(new Event("visibilitychange"));
    env.win.dispatchEvent(new Event("focus"));
    env.visible(true);
    motion.setVisible(true);
    expect(vi.getTimerCount()).toBe(0);
    motion.dispose();
  });

  it("runs coin motion only during visible thinking without a JS timer", () => {
    const env = environment();
    const coin = createBrandMotion({ kind: "coin", state: "thinking", size: 20 });
    env.visible(true);
    expect(coin.element.dataset.motionActive).toBe("true");
    expect(vi.getTimerCount()).toBe(0);
    coin.setState("success");
    expect(coin.element.dataset.motionActive).toBe("false");
    coin.dispose();
  });

  it("keeps a queued Compare coin still and updates it as polling advances", () => {
    const env = environment();
    const coin = createBrandMotion({ kind: "coin", state: compareProgressMotion("PENDING") });
    env.visible(true);
    expect(coin.element.dataset.motionActive).toBe("false");
    for (const [status, active] of [["RUNNING", "true"], ["WAITING_APPROVAL", "false"], ["PENDING", "false"], ["FAILED", "false"], ["COMPLETED", "false"]]) {
      coin.setState(compareProgressMotion(status));
      expect(coin.element.dataset.motionActive).toBe(active);
    }
    expect(vi.getTimerCount()).toBe(0);
    coin.dispose();
  });

  it.each(["new-session", "teardown"])("creates no late coin after an awaited gate loses ownership through %s", async (reason) => {
    const env = environment();
    const observeResources = vi.spyOn(env.doc, "addEventListener");
    let version = 1;
    let disposed = false;
    const ownsMotion = () => version === 1 && !disposed;
    let finishGate!: () => void;
    const gate = new Promise<void>((resolve) => { finishGate = resolve; });
    const createAfterGate = async () => {
      await gate;
      return createOwnedBrandMotion(ownsMotion, { kind: "coin", state: "thinking" });
    };
    const pending = createAfterGate();
    if (reason === "new-session") version += 1;
    else disposed = true;
    finishGate();
    expect(await pending).toBeUndefined();
    expect(observeResources).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes timers, observers and listeners idempotently and ignores late updates", () => {
    const env = environment();
    const docRemove = vi.spyOn(env.doc, "removeEventListener");
    const winRemove = vi.spyOn(env.win, "removeEventListener");
    const mediaRemove = vi.spyOn(env.media, "removeEventListener");
    const motion = createBrandMotion({ state: "thinking" });
    env.visible(true);
    motion.dispose();
    motion.dispose();
    motion.setState("success");
    env.visible(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(env.disconnect).toHaveBeenCalledTimes(1);
    expect(docRemove.mock.calls.map(([type]) => type).sort()).toEqual(["braavo:motion-preference", "visibilitychange"]);
    expect(winRemove.mock.calls.map(([type]) => type).sort()).toEqual(["blur", "focus"]);
    expect(mediaRemove.mock.calls.map(([type]) => type)).toEqual(["change"]);
  });
});
