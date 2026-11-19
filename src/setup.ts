/**
 * First-run setup (BRA-UI-11): permissions, then (when no key is stored yet) a provider key, then a summary.
 * Pure and injectable; no DOM. Default OFF behind a local flag; see `isSetupEnabled`.
 *
 * Nothing is invented: a permission's state is what the host reports (`computer_status`) or, for the
 * microphone, what the webview reports. A key value is only ever handed to the existing key vault.
 */

export const SETUP_FLAG_KEY = "bv.flags.setup";
export const SETUP_DONE_KEY = "bv.prefs.setupDone";

export interface FlagStorage { getItem(key: string): string | null }
export interface Storage2 extends FlagStorage { setItem(key: string, value: string): void }

const local = (): Storage2 | undefined => { try { return (globalThis as { localStorage?: Storage2 }).localStorage; } catch { return undefined; } };

/** Only the literal "1" enables the setup. Missing/unreadable storage = off. */
export function isSetupEnabled(storage?: FlagStorage): boolean {
  try { return (storage ?? local())?.getItem(SETUP_FLAG_KEY) === "1"; } catch { return false; }
}
export function isSetupDone(storage?: FlagStorage): boolean {
  try { return (storage ?? local())?.getItem(SETUP_DONE_KEY) === "1"; } catch { return false; }
}
/** False when the choice could not be remembered (the setup then shows again next time). */
export function markSetupDone(storage?: Storage2): boolean {
  try { (storage ?? local())!.setItem(SETUP_DONE_KEY, "1"); return true; } catch { return false; }
}

// ── steps ───────────────────────────────────────────────────────────────────
export type StepId = "permissions" | "key" | "ready";

/** Permissions only where the host can report them (macOS); the key step only while no key is stored. */
export function planSteps(opts: { supported: boolean; hasKey: boolean }): StepId[] {
  return [...(opts.supported ? ["permissions" as const] : []), ...(opts.hasKey ? [] : ["key" as const]), "ready"];
}

// ── permissions ─────────────────────────────────────────────────────────────
export type PermId = "screen" | "accessibility" | "microphone";
export const PERM_IDS: readonly PermId[] = ["screen", "accessibility", "microphone"];
/** "granted" · "later" (the user postponed) · "notGranted" (asked, still not granted) · "needed" (not asked yet). */
export type PermState = "granted" | "needed" | "notGranted" | "later";
export type MicReport = "granted" | "denied" | "prompt" | "unknown";

export interface HostStatus { supported: boolean; accessibility: boolean; screenRecording: boolean }
export interface PermRow { id: PermId; state: PermState }

/** Reads a host status of unknown shape; anything off-contract is null. */
export function readHostStatus(raw: unknown): HostStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.supported !== "boolean") return null;
  return { supported: r.supported, accessibility: r.accessibility === true, screenRecording: r.screenRecording === true };
}

/** The three rows from real reports. `asked` = rows the user pressed "Allow" on; `later` = rows postponed. */
export function mapPermissions(host: HostStatus, mic: MicReport, asked: ReadonlySet<PermId>, later: ReadonlySet<PermId>): PermRow[] {
  const granted: Record<PermId, boolean> = { screen: host.screenRecording, accessibility: host.accessibility, microphone: mic === "granted" };
  return PERM_IDS.map(id => {
    if (granted[id]) return { id, state: "granted" as const };
    if (asked.has(id) || (id === "microphone" && mic === "denied")) return { id, state: "notGranted" as const };
    if (later.has(id)) return { id, state: "later" as const };
    return { id, state: "needed" as const };
  });
}

export const grantedCount = (rows: readonly PermRow[]): number => rows.filter(r => r.state === "granted").length;

/** Computer control needs both host permissions; the microphone is for dictation only. */
export const computerReady = (rows: readonly PermRow[]): boolean => rows.filter(r => r.id !== "microphone").every(r => r.state === "granted");

export const SETTINGS_PANE: Record<PermId, string> = { screen: "screen", accessibility: "accessibility", microphone: "microphone" };

/** The webview's microphone answer. Anything unclear is "unknown", never "granted". */
export async function readMic(nav: { permissions?: { query(d: { name: string }): Promise<{ state: string }> } } | undefined): Promise<MicReport> {
  try {
    const r = await nav?.permissions?.query({ name: "microphone" });
    return r?.state === "granted" ? "granted" : r?.state === "denied" ? "denied" : r?.state === "prompt" ? "prompt" : "unknown";
  } catch { return "unknown"; }
}

/** Ask for the microphone; the stream is stopped at once. True only when it was really granted. */
export async function requestMic(nav: { mediaDevices?: { getUserMedia(c: { audio: boolean }): Promise<{ getTracks(): Array<{ stop(): void }> }> } } | undefined): Promise<boolean> {
  try {
    const stream = await nav?.mediaDevices?.getUserMedia({ audio: true });
    if (!stream) return false;
    for (const t of stream.getTracks()) t.stop();
    return true;
  } catch { return false; }
}

// ── summary ─────────────────────────────────────────────────────────────────
export type SummaryTone = "done" | "wait" | "err";
export interface SummaryRow { id: "permissions" | "key"; tone: SummaryTone; text: string }

/** One line of the summary per planned/known step; the words come from the catalogue through `t`. */
export function summarize(opts: {
  supported: boolean; rows: readonly PermRow[]; keyProvider: string | null;
}, t: (key: string, vars?: Record<string, string | number>) => string): SummaryRow[] {
  const out: SummaryRow[] = [];
  if (!opts.supported) out.push({ id: "permissions", tone: "wait", text: t("setup.sum.macOnly") });
  else {
    const n = grantedCount(opts.rows);
    const total = opts.rows.length;
    out.push({ id: "permissions", tone: n === total ? "done" : computerReady(opts.rows) ? "wait" : "err", text: t("setup.sum.perms", { n, total }) });
  }
  out.push(opts.keyProvider
    ? { id: "key", tone: "done", text: t("setup.sum.keyDone", { provider: opts.keyProvider }) }
    : { id: "key", tone: "wait", text: t("setup.sum.keyLater") });
  return out;
}
