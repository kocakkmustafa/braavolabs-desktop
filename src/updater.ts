/**
 * Signed in-app update (BRA-UI-11c). Pure state machine over an injected backend; no DOM.
 *
 * Used only while the local flag bv.flags.updateBanner = "1" AND the app runs inside Tauri with the updater plugin.
 * Otherwise update.ts (the manual "download it yourself" notice) stays the whole story. Flag off: nothing here runs.
 *
 * Flow: check -> available -> (user presses Download) -> downloading -> ready -> (user presses Restart) -> restart.
 * Nothing is downloaded or installed without a press. The signature is checked by the host against the public key in
 * tauri.conf.json and cannot be switched off from here; a signature failure has no "install anyway" path.
 * Error texts never carry the host's raw message (it can hold a URL); only a fixed failure kind is kept.
 */
import { compareSemver, parseSemver, formatVersion, isReleaseUrl, UPDATE_DISMISSED_KEY, UPDATE_LAST_KEY, type Storage2 } from "./update";

export interface UpdaterHandle {
  version: string;
  /** Latest.json as the host read it; only its download links are inspected. */
  rawJson?: Record<string, unknown>;
  download(onProgress: (downloaded: number, total: number | null) => void): Promise<void>;
  install(): Promise<void>;
}
export interface UpdaterBackend {
  /** The newer release, or null when there is none. A missing/unreadable latest.json rejects. */
  check(): Promise<UpdaterHandle | null>;
  restart(): Promise<void>;
}

export type EnginePhase = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "failed";
/** `signature` = the downloaded file did not verify. `check`/`download`/`install` = anything else, by stage. */
export type FailureKind = "check" | "download" | "install" | "signature";
export interface EngineState {
  phase: EnginePhase;
  version?: string;
  /** 0-100 while the size is known; null while it is not. */
  percent?: number | null;
  failure?: FailureKind;
  lastCheck?: number;
  dismissed: boolean;
}

/** Every download link inside latest.json must stay under the project's own GitHub account. */
export function downloadLinksOk(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return true;
  const r = raw as Record<string, unknown>;
  const urls: unknown[] = [];
  if ("url" in r) urls.push(r.url);
  const p = r.platforms;
  if (p && typeof p === "object") for (const e of Object.values(p as Record<string, unknown>)) if (e && typeof e === "object" && "url" in e) urls.push((e as { url: unknown }).url);
  return urls.every(isReleaseUrl);
}

const isSignatureError = (e: unknown): boolean => /signature|minisign|verif/i.test(e instanceof Error ? e.message : typeof e === "string" ? e : "");

export interface EngineDeps {
  current: string;
  backend: UpdaterBackend;
  storage?: Storage2;
  now?: () => number;
}
export interface UpdateEngine {
  state(): EngineState;
  subscribe(fn: (s: EngineState) => void): () => void;
  /** At every start and for the "Check now" button. Ignored while busy. */
  check(): Promise<void>;
  /** "Download" (also "Try again" after a failed download). */
  download(): Promise<void>;
  /** "Restart": installs the verified download, then restarts. */
  restart(): Promise<void>;
  /** "Later": hide the banner for this version. */
  dismiss(): void;
}

function store(deps: EngineDeps): Storage2 | undefined {
  try { return deps.storage ?? (globalThis as { localStorage?: Storage2 }).localStorage; } catch { return undefined; }
}
const rd = (s: Storage2 | undefined, k: string): string | null => { try { return s?.getItem(k) ?? null; } catch { return null; } };
const wr = (s: Storage2 | undefined, k: string, v: string): void => { try { s?.setItem(k, v); } catch { /* storage is optional */ } };

export function createUpdateEngine(deps: EngineDeps): UpdateEngine {
  const now = deps.now ?? Date.now;
  const cur = parseSemver(deps.current);
  const subs = new Set<(s: EngineState) => void>();
  let st: EngineState = { phase: "idle", dismissed: false };
  let handle: UpdaterHandle | null = null;
  let busy = false;

  const set = (next: Omit<EngineState, "dismissed">) => {
    st = { ...next, dismissed: !!next.version && rd(store(deps), UPDATE_DISMISSED_KEY) === next.version };
    for (const fn of [...subs]) { try { fn(st); } catch { /* a listener must not break the others */ } }
  };

  return {
    state: () => st,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },

    async check() {
      if (busy || st.phase === "downloading" || st.phase === "ready") return;
      busy = true;
      const at = now();
      wr(store(deps), UPDATE_LAST_KEY, String(at));
      set({ phase: "checking", lastCheck: at });
      try {
        const h = await deps.backend.check();
        const v = h ? parseSemver(h.version) : null;
        if (!h) { handle = null; set({ phase: "current", lastCheck: at }); }
        else if (!v || !cur || compareSemver(v, cur) <= 0) { handle = null; set({ phase: "current", lastCheck: at }); }
        else if (!downloadLinksOk(h.rawJson)) { handle = null; set({ phase: "failed", failure: "check", lastCheck: at }); }
        else { handle = h; set({ phase: "available", version: formatVersion(v), lastCheck: at }); }
      } catch {
        handle = null;
        set({ phase: "failed", failure: "check", lastCheck: at });
      } finally {
        busy = false;
      }
    },

    async download() {
      if (busy || !handle || (st.phase !== "available" && !(st.phase === "failed" && st.failure === "download"))) return;
      busy = true;
      const { version, lastCheck } = st;
      set({ phase: "downloading", version, percent: null, lastCheck });
      try {
        await handle.download((done, total) => {
          const pct = total && total > 0 ? Math.max(0, Math.min(100, Math.floor((done / total) * 100))) : null;
          set({ phase: "downloading", version, percent: pct, lastCheck });
        });
        set({ phase: "ready", version, lastCheck });
      } catch (e) {
        set({ phase: "failed", version, failure: isSignatureError(e) ? "signature" : "download", lastCheck });
      } finally {
        busy = false;
      }
    },

    async restart() {
      if (busy || !handle || (st.phase !== "ready" && !(st.phase === "failed" && st.failure === "install"))) return;
      busy = true;
      const { version, lastCheck } = st;
      try {
        await handle.install();
        await deps.backend.restart();
      } catch (e) {
        set({ phase: "failed", version, failure: isSignatureError(e) ? "signature" : "install", lastCheck });
      } finally {
        busy = false;
      }
    },

    dismiss() {
      if (st.version) wr(store(deps), UPDATE_DISMISSED_KEY, st.version);
      set({ phase: st.phase, version: st.version, percent: st.percent, failure: st.failure, lastCheck: st.lastCheck });
    },
  };
}

/** The banner shows for a found, downloading, ready or failed (with a known version) update that is not dismissed. A failed check stays silent. */
export const engineBannerVisible = (s: EngineState): boolean =>
  !s.dismissed && !!s.version && (s.phase === "available" || s.phase === "downloading" || s.phase === "ready" || (s.phase === "failed" && s.failure !== "check"));

/** The real backend: the Tauri updater and process plugins, loaded only when this is called. Null outside Tauri. */
export function tauriBackend(): UpdaterBackend | null {
  const inTauri = typeof globalThis === "object" && "__TAURI_INTERNALS__" in globalThis;
  if (!inTauri) return null;
  return {
    async check() {
      const { check } = await import("@tauri-apps/plugin-updater");
      const u = await check();
      if (!u) return null;
      return {
        version: u.version,
        rawJson: u.rawJson,
        download: (onProgress) => {
          let done = 0, total: number | null = null;
          return u.download((ev) => {
            if (ev.event === "Started") { total = ev.data.contentLength ?? null; onProgress(0, total); }
            else if (ev.event === "Progress") { done += ev.data.chunkLength; onProgress(done, total); }
          });
        },
        install: () => u.install(),
      };
    },
    async restart() {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  };
}
