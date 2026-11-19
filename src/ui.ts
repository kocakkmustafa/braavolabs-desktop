/**
 * DOM shell for the 3-pane obsidian UI. Deliberately thin: every decision that
 * matters (what to render, honesty gates, error mapping) lives in the pure,
 * unit-tested modules (client.ts / render.ts / i18n.ts). This file only wires
 * those outputs into elements and forwards user intent back to the client.
 * Login handlers have source-executing regression tests; real WebView paint,
 * native validity bubbles and keyboard behavior still need native UI checks.
 */
import { createToaster, type ToastKind } from "./toast";
import { createPaletteController, isPaletteShortcut, paletteBlocked, type PaletteCommand } from "./palette";
import { SETTINGS_PAGE_IDS, nextSettingsPage, type SettingsPageId } from "./settings-pages";
import { resolveTheme, THEMES } from "./theme";
import type { Config } from "./config";
import type { ModelSelection } from "./compare-selection";
import { createCompareControls } from "./compare-controls";
import { saveApiUrl } from "./store";
import {
  ApiError,
  captureSession,
  invalidateSession,
  isCurrentSession,
  login,
  startCompare,
  pollCompare,
  cancelCompare,
  cascade,
  savings as savingsCall,
  listCompanies,
  listScheduledPipelines,
  pauseCompany,
  resumeCompany,
} from "./client";
import { performSignOut } from "./session";
import { isInboxEnabled, loadBuckets } from "./inbox";
import { disposeActiveInbox, mountInbox } from "./inbox-ui";
import { resolvePanelTransport } from "./company-panel/api";
import type { CompanyPanelHandle } from "./company-panel/mount";
import {
  toSavingsView,
  toCascadeView,
  toCompareView,
  toLoginError,
  type CascadeView,
  type CompareView,
} from "./render";
import {
  resolveOllamaHost,
  resolveOllamaModel,
  ollamaChat,
  OllamaUnreachableError,
} from "./local";
import {
  DIRECT_PROVIDERS,
  type DirectProvider,
  isDirectProvider,
  resolveDirectModel,
  directChat,
  DirectApiError,
} from "./direct";
import type { KeyVault } from "./keyvault";
import {
  SPAWN_VENDORS,
  buildLaunchCommand,
  spawnFallbackMessage,
  spawnRiskNote,
  type SpawnProbe,
  type VendorStatus,
} from "./spawn";
import {
  type Governance,
  type ActionDetail,
  type AuditEntry,
  redactSummary,
} from "./governance";
import {
  type McpBridge,
  type McpTool,
  parseArgsInput,
  parseToolArgs,
  summarizeCallResult,
  resultBorderColor,
  McpGateError,
} from "./mcp";
import { type Translator, LOCALES, LOCALE_NAMES, makeT, getLocale, saveLocale, formatUsd, formatNumber, formatTime } from "./i18n";
import {
  toChangeViews,
  changeSummary,
  changeCounts,
  type ChangeView,
} from "./changes";
import {
  toCompanyViews,
  toJobViews,
  companySummary,
  relativeAge,
  type CompanyView,
  type JobView,
} from "./company";
import {
  resolveSessionStore,
  rememberHistoryIdentity,
  groupSessions,
  deriveTitle,
  type ChatSession,
  type SessionRole,
} from "./sessions";
import {
  createDaemonClient,
  resolveDaemonTransport,
  modelOptions,
  parseModelRef,
  migrateLocalSessions,
  mergeHistory,
  DaemonError,
  type Conversation,
  type DaemonClient,
  type HistoryItem,
  type ModelOption,
  type SearchResult,
} from "./daemon-client";
import {
  resolvePrefs,
  applyReducedMotion,
  effectiveReducedMotion,
} from "./prefs";
import {
  RelayBridge,
  bridgeGovernance,
  resolveApproval,
  resolveRejection,
} from "./relay-bridge";
import { createRelayTransport } from "./relay-transport";
import {
  answerMotion, compareMotion, createBrandMotion, notifyBrandMotionPreference,
  watchBrandMotionPreference,
  compareProgressMotion, createOwnedBrandMotion,
  type BrandMotion, type MotionState,
} from "./brand-motion";
import { createVoice } from "./voice";
import { createVoiceChat, isVoiceChatEnabled, markVoiceChatIntroSeen, voiceChatIntroSeen, type VoiceChat } from "./voice-chat";
import { createPublishUi, type PublishUi } from "./publish-view";
import { isPublishEnabled } from "./publish";
import { composeWire, createTray, isAttachmentsEnabled, splitWire, wireExceeds, type AttachmentTray } from "./attachments";
import { createAttachUi, renderSentChips, type AttachUi } from "./attachments-view";
import { version as APP_VERSION } from "../package.json";
import { isSetupDone, isSetupEnabled } from "./setup";
import { mountSetup } from "./setup-view";
import { buildAbout, mountUpdate } from "./update-view";
import { renderIntro, renderStrip, stripView, summaryLine, vcIcon, type VcAction } from "./voice-chat-view";
import { createBrowserPane } from "./browser-pane";
import { createComputerPane } from "./computer-pane";
import { ltr } from "./bidi";

/** How an approval was settled. `token` is present only when the resolver
 *  ALREADY minted one (companion approve) — the local click mints its own. */
export interface ApprovalOutcome {
  approved: boolean;
  token?: string;
}

/**
 * Open approval modals, keyed by governance actionId. Two things resolve them
 * besides the user's click: a companion decision arriving over the relay
 * (which must hand its minted token over — approving on the phone and then
 * failing locally would be worse than not offering it), and the kill switch
 * (fail-closed, no token).
 */
const openApprovals = new Map<string, (o: ApprovalOutcome) => void>();

/** Settle every open approval. Used by the kill switch and by teardown. */
function settleAllApprovals(outcome: ApprovalOutcome): number {
  const n = openApprovals.size;
  for (const resolve of [...openApprovals.values()]) resolve(outcome);
  openApprovals.clear();
  return n;
}

/** Set while the companion broadcast is live so the kill switch can stop it. */
let activeDispatchStopper: (() => void) | null = null;
let activeRelayStopper: (() => Promise<void>) | null = null;

/**
 * Teardown for the CURRENT workspace render. Registered by renderWorkspace and
 * run before the next render (or the login view) replaces it. Without this the
 * companion bridge, the governance decorator and the keydown listener outlive
 * sign-out — so the NEXT account's approvals would mirror to the previous
 * account's phone, which could still steer and kill.
 */
let disposeWorkspace: (() => void) | null = null;
let disposeMotionPreference: (() => void) | null = null;

function runWorkspaceTeardown(): void {
  const dispose = disposeWorkspace;
  disposeWorkspace = null;
  dispose?.();
  disposeMotionPreference?.();
  disposeMotionPreference = null;
  disposeActiveInbox();
  settleAllApprovals({ approved: false });
}

/** OS-level reduced-motion, guarded for non-browser test environments. */
function osPrefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

function initReducedMotion(): ReturnType<typeof resolvePrefs> {
  const prefs = resolvePrefs();
  applyReducedMotion(document.documentElement, effectiveReducedMotion(prefs, osPrefersReducedMotion()));
  disposeMotionPreference = watchBrandMotionPreference(prefs);
  return prefs;
}

/**
 * Stop everything this UI can actually reach today — honest scope:
 * approvals, local HTTP requests, managed native children, companion broadcast
 * and governed browser connection. Remote completion and descendants remain
 * unknown, and each independent cleanup proceeds even if another fails.
 */
async function killEverything(gov: Governance): Promise<{ approvals: number; native: boolean; relay: "stopped" | "failed" | "inactive" }> {
  const approvals = settleAllApprovals({ approved: false });
  // This host fence also cancels a native dialog already awaiting Allow.
  activeDispatchStopper?.();
  let native = true;
  try { await gov.invalidate(); } catch { native = false; }

  let relay: "stopped" | "failed" | "inactive" = "inactive";
  if (activeRelayStopper) {
    const stop = activeRelayStopper;
    activeRelayStopper = null;
    try {
      await stop();
      relay = "stopped";
    } catch {
      // Local teardown still happened inside the stopper; the relay may not
      // have received the `ended` event — report that difference honestly.
      relay = "failed";
    }
  }

  // Belt-and-braces: ask the host to drop any governed browser connection.
  // NOT reported to the user — the host returns Ok() whether or not anything
  // was connected, and no surface in this UI opens one, so a "✓ disconnected"
  // line would be a guaranteed false positive.
  try {
    const g = globalThis as Record<string, any>;
    const inv = g?.__TAURI__?.core?.invoke as
      | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>)
      | undefined;
    await inv?.("browser_disconnect", { ts: Date.now() });
  } catch {
    /* no host / nothing connected */
  }

  return { approvals, native, relay };
}

export interface UiDeps {
  root: HTMLElement;
  cfg: Config;
  t: Translator;
  /** Local BYOK key vault (Tauri-backed at runtime, memory in dev/test). */
  vault: KeyVault;
  /** Lane-B vendor CLI detection (Tauri-backed at runtime, memory in dev/test). */
  spawn: SpawnProbe;
  /** Governance gate — every side-effecting action passes through it (fail-closed). */
  gov: Governance;
  /** MCP bridge — register servers, list tools, and (gated) call a tool. */
  mcp: McpBridge;
  /** The built-in API address; the sign-in "Advanced" fold opens when another one is in use. */
  defaultApiUrl?: string;
  /** Persist secrets after login/refresh/logout. */
  persist: (c: Config) => Promise<void> | void;
  onSignedOut: () => void;
  onSignOutError?: (message: string) => void;
}

/** Dispatch lane: server cascade/compare, local Ollama, BYOK direct, or the local braavo daemon. */
type Mode = "compare" | "cascade" | "local" | "direct" | "daemon";

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const SVG_NS = "http://www.w3.org/2000/svg";
/** Lucide line icons (1.5 stroke) as inline SVG; paths only, no dependency. */
const ICONS = {
  chat: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
  company: ["M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z", "M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2", "M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2", "M10 6h4", "M10 10h4", "M10 14h4", "M10 18h4"],
  code: ["m18 16 4-4-4-4", "m6 8-4 4 4 4", "m14.5 4-5 16"],
  plus: ["M5 12h14", "M12 5v14"],
  search: ["M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z", "m21 21-4.3-4.3"],
  settings: ["M21 4h-7", "M10 4H3", "M21 12h-9", "M8 12H3", "M21 20h-5", "M12 20H3", "M14 2v4", "M8 10v4", "M16 18v4"],
  logout: ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "m16 17 5-5-5-5", "M21 12H9"],
  mic: ["M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z", "M19 10v2a7 7 0 0 1-14 0v-2", "M12 19v3"],
  check: ["M20 6 9 17l-5-5"],
  diamond: ["M12 2.5 21.5 12 12 21.5 2.5 12Z"],
  stop: ["M5 5h14v14H5z"],
  retry: ["M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", "M8 16H3v5"],
  file: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4"],
  folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
  sun: ["M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z", "M12 2v2", "M12 20v2", "m4.93 4.93 1.41 1.41", "m17.66 17.66 1.41 1.41", "M2 12h2", "M20 12h2", "m6.34 17.66-1.41 1.41", "m19.07 4.93-1.41 1.41"],
  key: ["m21 2-9.6 9.6", "m15.5 7.5 3 3L22 7l-3-3", "M7.5 10.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z"],
  plug: ["M12 22v-5", "M9 8V2", "M15 8V2", "M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"],
  shield: ["M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"],
  phone: ["M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z", "M12 18h.01"],
  lock: ["M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z", "M7 11V7a5 5 0 0 1 10 0v4"],
  info: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M12 16v-4", "M12 8h.01"],
  activity: ["M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"],
} as const;
const icon = (name: keyof typeof ICONS, size = 16): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("ico");
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
};
/** Valar (lead agent) mark: M1 grille helmet, 48 grid, evenodd; collar at .55 opacity. */
const valarIcon = (size = 24): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 48 48");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("valar-mark");
  const helmet = document.createElementNS(SVG_NS, "path");
  helmet.setAttribute("fill-rule", "evenodd");
  helmet.setAttribute("d", "M11 40V22C11 12.5 17 6 24 6C31 6 37 12.5 37 22V40ZM14 18.5H34V22H14ZM17 26.5H19.6V35.5H17ZM22.7 26.5H25.3V35.5H22.7ZM28.4 26.5H31V35.5H28.4Z");
  const collar = document.createElementNS(SVG_NS, "path");
  collar.setAttribute("d", "M10 42H38V45.5H10Z");
  collar.setAttribute("opacity", ".55");
  svg.append(helmet, collar);
  return svg;
};
/** Task / job status as colour + glyph + word (never colour alone). */
type NowKind = "run" | "approval" | "error" | "done" | "queue";
const NOW_GLYPH: Record<NowKind, string> = { run: "●", approval: "◆", error: "■", done: "✓", queue: "○" };

// Plan 5.9: dictation into the composer and read-aloud on answers, on the system's own speech services.
const voice = createVoice();

/** "Read aloud" for an answer card; null where the webview has no speech synthesis. */
function speakButton(t: Translator, text: () => string): HTMLButtonElement | null {
  if (!voice.canSpeak) return null;
  const btn = el("button", "speak-btn", t("chat.speak"));
  btn.type = "button";
  btn.setAttribute("aria-pressed", "false");
  const reset = () => { btn.setAttribute("aria-pressed", "false"); btn.textContent = t("chat.speak"); };
  btn.addEventListener("click", () => {
    if (btn.getAttribute("aria-pressed") === "true") { voice.stopSpeaking(); reset(); return; }
    // One voice at a time: the other cards' buttons go back to "Read aloud".
    for (const other of document.querySelectorAll<HTMLButtonElement>('.speak-btn[aria-pressed="true"]')) other.click();
    if (voice.speak(text(), getLocale(), reset)) { btn.setAttribute("aria-pressed", "true"); btn.textContent = t("chat.speakStop"); }
  });
  return btn;
}

let toaster: ReturnType<typeof createToaster> | null = null;
/** Toast göster (D7). Satır içi role=status/alert bildirimleri yerinde kalır; bu ek, görünür katmandır. */
function notify(t: Translator, kind: ToastKind, text: string): void {
  if (typeof document === "undefined" || !document.body) return;
  if (!toaster) {
    let host = document.querySelector<HTMLElement>(".toast-host");
    if (!host) { host = el("div", "toast-host"); document.body.append(host); }
    const h = host;
    toaster = createToaster({ createElement: (tag) => document.createElement(tag) as never, host: () => h as never },
      { info: t("toast.info"), done: t("toast.done"), error: t("toast.error") }, t("toast.dismiss"));
  }
  toaster.show(kind, text);
}

/** Keyboard containment and restoration for in-app dialogs. Native confirmation
 * remains the separate host authority; this only improves navigation. */
function containDialog(card: HTMLElement, dismiss: () => void): () => void {
  const previous = document.activeElement as HTMLElement | null;
  card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true"); card.tabIndex = -1;
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); return; }
    if (event.key !== "Tab") return;
    const focusable = [...card.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')].filter(node => !node.hidden && node.tabIndex >= 0 && !node.closest('[hidden],[inert],[aria-hidden="true"]') && node.getClientRects().length > 0);
    if (!focusable.length) { event.preventDefault(); card.focus(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    const outside = !focusable.includes(document.activeElement as HTMLElement);
    if (event.shiftKey && (document.activeElement === first || outside)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || outside)) { event.preventDefault(); first.focus(); }
  };
  card.addEventListener("keydown", onKey);
  return () => { card.removeEventListener("keydown", onKey); if (previous?.isConnected) previous.focus(); };
}

function languageSelector(deps: UiDeps): HTMLElement {
  const label = el("label", "locale-picker", deps.t("settings.language"));
  const select = el("select"); select.setAttribute("aria-label", deps.t("settings.language"));
  for (const locale of LOCALES) { const option = el("option", undefined, LOCALE_NAMES[locale]); option.value = locale; select.append(option); }
  select.value = getLocale();
  const notice = el("span", "storage-notice"); notice.setAttribute("role", "status");
  select.addEventListener("change", async () => {
    const locale = LOCALES.find(value => value === select.value); if (!locale) return;
    select.disabled = true; activeDispatchStopper?.();
    try { await deps.gov.invalidate(); if (!saveLocale(locale)) throw new Error("preference unavailable"); location.reload(); }
    catch { select.disabled = false; select.value = getLocale(); notice.textContent = deps.t("settings.languageFailed"); }
  });
  label.append(select, notice); return label;
}

function themeSelector(deps: UiDeps): HTMLElement {
  const wrapper = el("div", "theme-picker");
  const label = el("label", "locale-picker", deps.t("settings.theme"));
  const select = el("select"); select.setAttribute("aria-label", deps.t("settings.theme"));
  const theme = resolveTheme();
  for (const value of THEMES) {
    const option = el("option", undefined, deps.t(`theme.${value}`)); option.value = value; select.append(option);
  }
  select.value = theme.choice();
  // Tema başka yerden de değişir (komut paleti): seçici tek kaynaktan (theme) eşitlenir.
  theme.subscribe?.(() => { select.value = theme.choice(); });
  const notice = el("div", "storage-notice"); notice.setAttribute("role", "status");
  select.addEventListener("change", () => {
    const value = THEMES.find(value => value === select.value); if (!value) return;
    notice.textContent = theme.set(value) ? "" : deps.t("settings.preferenceUnsaved");
  });
  label.append(select); wrapper.append(label, el("div", "set-sub", deps.t("settings.themeSub")), notice);
  return wrapper;
}

// ── login view ────────────────────────────────────────────────────────────
export function renderLogin(deps: UiDeps): void {
  const { root, cfg, t } = deps;
  invalidateSession(cfg);
  runWorkspaceTeardown();
  initReducedMotion();
  root.innerHTML = "";
  const wrap = el("div", "login-wrap");
  const card = el("form", "login-card");

  const h1 = el("h1");
  const dot = el("span", "brand-dot");
  h1.append(dot, document.createTextNode(t("login.title")));
  const sub = el("div", "sub", t("login.localPrerequisite"));

  const errBox = el("div", "login-error");
  errBox.setAttribute("role", "alert");
  errBox.style.display = "none";

  const emailInput = el("input");
  emailInput.type = "email";
  emailInput.autocomplete = "username";
  emailInput.required = true;
  const pwInput = el("input");
  pwInput.type = "password";
  pwInput.autocomplete = "current-password";
  pwInput.required = true;
  // Native validation runs before submit; translate its bubble without
  // canceling it or replacing the browser's required/email constraints.
  const localizeValidation = (input: HTMLInputElement, requiredKey: string) => {
    const clear = () => input.setCustomValidity("");
    input.addEventListener("input", clear);
    input.addEventListener("change", clear);
    input.addEventListener("invalid", () => {
      clear();
      if (input.validity.valueMissing) input.setCustomValidity(t(requiredKey));
      else if (input.type === "email" && input.validity.typeMismatch)
        input.setCustomValidity(t("login.invalidEmail"));
    });
  };
  localizeValidation(emailInput, "login.requiredEmail");
  localizeValidation(pwInput, "login.requiredPassword");
  const apiInput = el("input");
  apiInput.type = "text"; apiInput.dir = "ltr";
  emailInput.dir = "ltr";
  apiInput.value = cfg.apiUrl;

  const field = (labelKey: string, input: HTMLInputElement) => {
    const f = el("div", "field");
    const l = el("label", undefined, t(labelKey));
    input.id = labelKey.replaceAll(".", "-");
    l.htmlFor = input.id;
    f.append(l, input);
    return f;
  };

  // The API address is for self-hosting; most people never change it, so it folds
  // under "Advanced" and opens on its own only when a non-default address is in use.
  const advancedApiField = () => {
    const details = el("details", "login-advanced") as HTMLDetailsElement;
    details.open = deps.defaultApiUrl !== undefined && cfg.apiUrl !== deps.defaultApiUrl;
    details.append(el("summary", undefined, t("login.advanced")), field("login.apiUrl", apiInput));
    return details;
  };

  const btn = el("button", "login-btn", t("login.submit"));
  btn.type = "submit";

  const submit = async () => {
    if (btn.disabled || !card.reportValidity()) return;
    errBox.style.display = "none";
    btn.disabled = true;
    btn.textContent = t("login.signingIn");
    cfg.apiUrl = apiInput.value.trim() || cfg.apiUrl;
    saveApiUrl(cfg.apiUrl);
    const owner = captureSession(cfg);
    try {
      // raw mode → branch on status for a specific banner (401 vs 429 vs 503).
      const res = await login(
        cfg,
        { email: emailInput.value.trim(), password: pwInput.value },
        {},
      ).then((r) => ({ ok: true as const, data: r }))
        .catch((e: unknown) =>
          e instanceof ApiError
            ? { ok: false as const, status: e.status, message: e.message }
            : { ok: false as const, status: 0, message: String(e) },
        );

      if (!isCurrentSession(cfg, owner)) return;
      if (!res.ok) {
        const view = toLoginError({ status: res.status, body: { error: res.message } });
        errBox.textContent = mapLoginErrorText(t, view);
        errBox.style.display = "block";
        return;
      }
      invalidateSession(cfg);
      cfg.token = res.data.token;
      cfg.refreshToken = res.data.refreshToken;
      const signedIn = captureSession(cfg);
      await deps.persist(cfg);
      if (!isCurrentSession(cfg, signedIn)) return;
      rememberHistoryIdentity(cfg, res.data);
      // Email is identity, not a secret — localStorage (not the secure store)
      // so the account row can show who is signed in.
      try {
        globalThis.localStorage?.setItem("bv.account.email", emailInput.value.trim());
      } catch {
        /* webview without storage — the account row just stays generic */
      }
      renderWorkspace(deps);
    } finally {
      btn.disabled = false;
      btn.textContent = t("login.submit");
    }
  };

  card.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });

  card.append(
    h1,
    sub,
    languageSelector(deps),
    themeSelector(deps),
    errBox,
    field("login.email", emailInput),
    field("login.password", pwInput),
    advancedApiField(),
    btn,
  );
  wrap.append(card);
  root.append(wrap);
}

function mapLoginErrorText(t: Translator, view: ReturnType<typeof toLoginError>): string {
  switch (view?.kind) {
    case "network":
      return t("login.errNetwork");
    case "invalid":
      return t("login.errInvalid");
    case "locked":
      return t("login.errLocked");
    case "rate_limited":
      return t("login.errRateLimited");
    case "unavailable":
      return t("login.errUnavailable");
    default:
      return t("login.errUnknown");
  }
}

// ── workspace (3-pane) ──────────────────────────────────────────────────────
export function renderWorkspace(deps: UiDeps): void {
  const { root, cfg, t } = deps;
  // A second render must not leave the previous one's bridge, governance
  // decorator or key listener alive (see runWorkspaceTeardown).
  runWorkspaceTeardown();
  const prefs = initReducedMotion();
  root.innerHTML = "";
  let mode: Mode = "cascade";
  let workspaceDisposed = false;
  const motions = new Set<BrandMotion>();
  const trackMotion = (motion: BrandMotion) => {
    if (workspaceDisposed) motion.dispose();
    else motions.add(motion);
    return motion;
  };
  const thinkingMotions = new Map<HTMLElement, BrandMotion>();
  const removeThinking = (row: HTMLElement) => {
    const motion = thinkingMotions.get(row);
    motion?.dispose();
    if (motion) motions.delete(motion);
    thinkingMotions.delete(row);
    row.remove();
  };

  const shell = el("div", "shell");

  // --- title bar (design v3): traffic lights, mode crumb, Settings ---
  const titlebar = el("div", "titlebar");
  const lights = el("div", "tb-lights");
  lights.append(el("i", "tb-l1"), el("i", "tb-l2"), el("i", "tb-l3"));
  const crumb = el("span", "tb-crumb mono", t("app.name"));
  // "Şu an" (Now): what is running / waiting, from sources that already exist.
  const nowWrap = el("div", "tb-now");
  const nowBtn = el("button", "tb-now-btn");
  nowBtn.type = "button";
  nowBtn.setAttribute("aria-haspopup", "dialog");
  nowBtn.setAttribute("aria-expanded", "false");
  nowBtn.append(icon("activity", 16), el("span", undefined, t("now.button")));
  const nowPop = el("div", "now-pop");
  nowPop.setAttribute("role", "dialog");
  nowPop.setAttribute("aria-label", t("now.title"));
  nowPop.style.display = "none";
  nowWrap.append(nowBtn, nowPop);
  titlebar.append(lights, crumb, el("div", "tb-spacer"), nowWrap);

  // --- left rail ---
  const rail = el("aside", "rail");
  // Surface tabs (icon only; active tab gets the single underline in the borderless design).
  // Chat is the everyday surface; Code is the vendor-CLI (Lane-B) surface.
  const seg = el("div", "seg");
  seg.setAttribute("role", "tablist");
  seg.setAttribute("aria-label", t("rail.surfaces"));
  const mkSegBtn = (ico: keyof typeof ICONS, label: string, active = false) => {
    const b = el("button", active ? "seg-btn active" : "seg-btn");
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-label", label);
    b.title = label;
    b.append(icon(ico, 20));
    return b;
  };
  const segChatBtn = mkSegBtn("chat", t("surface.chat"), true);
  const segCodeBtn = mkSegBtn("code", t("surface.code"));
  const segCompanyBtn = mkSegBtn("company", t("surface.company"));
  seg.append(segChatBtn, segCompanyBtn, segCodeBtn);

  const valarCard = el("div", "valar-card");
  valarCard.append(valarIcon(28), el("span", "valar-name", t("rail.valar")));

  const connSec = el("div", "conn-sec");
  const conn = el("div", "conn online");
  conn.append(el("span", "conn-ico", "✓"), document.createTextNode(t("rail.connected")));
  connSec.append(conn);

  const newChatBtn = el("button", "rail-btn primary");
  newChatBtn.type = "button";
  newChatBtn.append(icon("plus", 16), el("span", undefined, t("rail.newChat")));
  // Search reveals the daemon history search (available only while the daemon answers).
  const searchBtn = el("button", "rail-btn");
  searchBtn.type = "button";
  searchBtn.disabled = true;
  searchBtn.append(icon("search", 16), el("span", undefined, t("rail.search")));
  const railActions = el("div", "rail-actions");
  railActions.append(newChatBtn, searchBtn);

  // Chat sessions (design v3 TODAY / EARLIER). List + switching live here;
  // the store itself is the pure, tested module in sessions.ts.
  const sessionStore = resolveSessionStore(cfg);
  const storageNotice = el("div", "storage-notice");
  storageNotice.setAttribute("role", "status");
  const exportHistory = el("button", "set-btn", t("sessions.export"));
  exportHistory.addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([sessionStore.export()], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "braavolabs-transcript.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  // Local braavo daemon (plan 1.3): when it answers, chat history lives in its
  // SQLite store and turns stream through it. Reached only via the Rust host
  // (daemon-client.ts); absent outside Tauri, offline until probed.
  const daemonTransport = resolveDaemonTransport();
  const daemon: DaemonClient | null = daemonTransport ? createDaemonClient(daemonTransport) : null;
  let daemonOnline = false;
  let daemonConversations: Conversation[] = [];
  let activeDaemonConv: Conversation | null = null;
  let daemonTurn: { conversationId: string } | null = null;
  let daemonModelOptions: ModelOption[] = [];
  let migrationNote = "";
  const updateStorageNotice = () => {
    const status = sessionStore.status();
    const localText = t(status.persistence === "corrupt" ? "sessions.corrupt"
      : status.persistence === "failed" ? "sessions.unsaved" : status.persistence === "volatile" ? "sessions.volatile" : status.truncated ? "sessions.truncated" : "sessions.limits");
    if (daemonOnline) {
      storageNotice.textContent = t("sessions.daemonStore");
      if (migrationNote) storageNotice.append(el("span", undefined, ` ${migrationNote}`));
      if (sessionStore.list().length) {
        storageNotice.append(el("span", undefined, ` ${localText}`));
        if (status.legacy) storageNotice.append(el("span", undefined, t("sessions.legacy")));
        storageNotice.append(exportHistory);
      }
      return;
    }
    storageNotice.textContent = localText;
    if (status.legacy) storageNotice.append(el("span", undefined, t("sessions.legacy")));
    storageNotice.append(exportHistory);
  };
  let activeSession: ChatSession | null = null;
  const sessionsSec = el("div", "sessions-sec");
  const historySearch = el("input", "company-input history-search") as HTMLInputElement;
  historySearch.type = "search";
  historySearch.placeholder = t("sessions.search");
  historySearch.setAttribute("aria-label", t("sessions.search"));
  historySearch.style.display = "none"; // daemon search only
  searchBtn.addEventListener("click", () => { if (daemonOnline) { historySearch.style.display = ""; historySearch.focus(); } });

  // Configuration moved out of the rail and into Settings (design v3): the
  // rail is for what you're working on, Settings for how the app is wired.
  const keysSec = renderKeysSection(deps);
  const laneBSec = renderLaneBSection(deps);
  const mcpSec = renderMcpSection(deps);

  // Lane-B lives in the Code surface, so it is moved (not copied) out of the
  // settings sheet — one instance, one source of truth for its state.
  const codePane = el("div", "code-pane");
  codePane.style.display = "none";
  codePane.append(laneBSec);

  /**
   * Changed files in the workspace. The Lane-B session runs in the user's OWN
   * terminal (this UI reveals the launch command; it does not drive a PTY), so
   * the comp's in-thread tool/diff feed has no data source here — parsing the
   * vendor stream is forbidden by contract. Git does have the answer, so this
   * shows what the session actually changed on disk. Honest subset, real data.
   */
  const changesSec = el("div", "changes-sec");
  const changesHead = el("div", "rail-section-label", t("changes.title"));
  const changesPathInput = ltr(el("input", "changes-path"));
  changesPathInput.type = "text";
  changesPathInput.placeholder = t("changes.pathPlaceholder");
  try {
    changesPathInput.value = globalThis.localStorage?.getItem("bv.changes.cwd") ?? "";
  } catch {
    /* no storage — the field just starts empty */
  }
  const changesBtn = el("button", "set-btn", t("changes.refresh"));
  const changesRow = el("div", "changes-row");
  changesRow.append(changesPathInput, changesBtn);
  const changesBody = el("div", "changes-body");
  changesSec.append(changesHead, changesRow, changesBody);
  changesSec.style.display = "none"; // sağ panelin "Değişiklikler" sekmesi

  // BRA-UI-10: "Yayına hazırla", behind a default-OFF local flag (PUBLISH_FLAG_KEY in publish.ts; UI-10b merge edildi; açma kurucu kararı). Flag off: nothing below is created.
  let lastViews: ChangeView[] = [];
  let publishUi: PublishUi | null = null;
  if (isPublishEnabled()) {
    const invokeFn = (globalThis as Record<string, any>)?.__TAURI__?.core?.invoke as ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | undefined;
    if (invokeFn) {
      publishUi = createPublishUi({
        t, invoke: invokeFn, get gov() { return deps.gov; }, cwd: () => changesPathInput.value.trim(), views: () => lastViews, contain: containDialog,
        setListHidden: (hidden: boolean) => { changesHead.hidden = hidden; changesRow.hidden = hidden; changesBody.hidden = hidden; publishUi?.button && (publishUi.button.hidden = hidden); publishUi?.note && (publishUi.note.hidden = hidden || lastViews.length !== 0); },
      });
      changesSec.append(publishUi.button, publishUi.note, publishUi.panel);
    }
  }
  const renderChanges = (views: ChangeView[], error?: string) => {
    lastViews = error ? [] : views;
    publishUi?.sync();
    changesBody.replaceChildren();
    if (error) {
      changesBody.append(el("div", "changes-error", error));
      return;
    }
    if (views.length === 0) {
      changesBody.append(el("div", "changes-empty", t("changes.clean")));
      return;
    }
    const sum = changeSummary(views);
    changesBody.append(
      el(
        "div",
        "changes-summary mono",
        t("changes.summary", {
          files: sum.files,
          added: sum.added,
          removed: sum.removed,
        }),
      ),
    );
    // Dosya ağacı: klasöre göre gruplu; içerik çizgileri serbest kenar (diff renkleri yalnız sayılarda).
    const dirOf = (path: string) => {
      const clean = path.replace(/^\.?\//, "").replace(/\/+$/, "");
      return clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "";
    };
    const byDir = new Map<string, ChangeView[]>();
    for (const v of views) {
      const d = dirOf(v.path);
      const list = byDir.get(d);
      if (list) list.push(v); else byDir.set(d, [v]);
    }
    const tree = el("div", "changes-tree");
    for (const [dir, files] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
      const group = el("div", "changes-dir");
      const head = el("div", "changes-dir-head mono");
      const dirLabel = el("span", undefined, dir ? `${dir}/` : t("changes.root"));
      head.append(icon("folder", 14), dir ? ltr(dirLabel) : dirLabel);
      group.append(head);
      for (const v of files) {
        const row = el("div", "changes-item");
        const name = ltr(el("span", "changes-file mono", v.file));
        name.title = v.path; // full path without widening the row
        const counts = el("span", `changes-counts mono${v.countless ? " faint" : ""}`);
        if (v.countless) counts.textContent = changeCounts(v);
        else counts.append(el("span", "diff-add", `+${v.added}`), document.createTextNode(" "), el("span", "diff-del", `−${v.removed}`));
        row.append(icon("file", 14), el("span", "changes-status mono", v.status), name, counts);
        group.append(row);
      }
      tree.append(group);
    }
    changesBody.append(tree);
  };

  const loadChanges = async () => {
    const cwd = changesPathInput.value.trim();
    if (!cwd) {
      renderChanges([], t("changes.needPath"));
      return;
    }
    try {
      globalThis.localStorage?.setItem("bv.changes.cwd", cwd);
    } catch {
      /* not persisted — not worth failing the read for */
    }
    changesBody.replaceChildren(el("div", "changes-empty", t("changes.loading")));
    const g = globalThis as Record<string, any>;
    const inv = g?.__TAURI__?.core?.invoke as
      | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>)
      | undefined;
    if (!inv) {
      // Dev/browser build: say so rather than showing an empty "clean" list.
      renderChanges([], t("changes.hostOnly"));
      return;
    }
    try {
      const raw = await inv("git_changed_files", { cwd });
      renderChanges(toChangeViews(raw));
    } catch (e) {
      renderChanges([], String(e instanceof Error ? e.message : e));
    }
  };
  changesBtn.addEventListener("click", () => void loadChanges());
  changesPathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void loadChanges();
  });

  // Company surface (design v3 "Company"): read-only cloud state + the two
  // lifecycle actions the API actually exposes. Every value comes from the
  // server via the pure mappers in company.ts — nothing is invented here.
  const companyPane = el("div", "company-pane");
  companyPane.style.display = "none";
  // Plan 2.5 (D1/D2): the local daemon's company panel, the first React island
  // (K9). Only inside Tauri — the daemon is reachable solely through the Rust
  // proxy. The cloud list below keeps its own box.
  const panelTransport = resolvePanelTransport();
  const companyPanelHost = el("div", "company-panel-host");
  const cloudBox = el("div", "company-cloud");
  if (panelTransport) companyPane.append(companyPanelHost, el("div", "rail-section-label cp-cloud-label", t("panel.cloudSection")));
  companyPane.append(cloudBox);
  // Plan 5.1: the Braavo browser (own Chromium profile, governed CDP); Tauri only.
  const tauriInvoke = (globalThis as Record<string, any>)?.__TAURI__?.core?.invoke as ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | undefined;
  if (tauriInvoke) {
    const browserPane = createBrowserPane({
      t, invoke: tauriInvoke,
      gate: (kind, detail) => gateForToken(deps, kind, detail),
      addToMessage: (text) => { applySurface("chat"); ta.value = ta.value ? `${ta.value}\n\n${text}` : text; ta.dispatchEvent(new Event("input")); ta.focus(); },
    });
    companyPane.append(browserPane.element);
    // Plan 5.8: computer control — off until the user starts a session; each action approved.
    const computerPane = createComputerPane({ t, invoke: tauriInvoke, gate: (kind, detail) => gateForToken(deps, kind, detail) });
    companyPane.append(computerPane.element);
    void computerPane.refresh();
  }
  let companyPanel: CompanyPanelHandle | null = null;
  let companyPanelLoading = false;
  let companyPanelWanted = false;
  const setCompanyPanelActive = (active: boolean) => {
    companyPanelWanted = active;
    if (!panelTransport || workspaceDisposed) return;
    if (companyPanel) { companyPanel.setActive(active); return; }
    if (!active || companyPanelLoading) return;
    companyPanelLoading = true;
    // React loads on first entry only: most sessions never open this surface.
    void import("./company-panel/mount").then(({ mountCompanyPanel }) => {
      if (workspaceDisposed) return;
      companyPanel = mountCompanyPanel(companyPanelHost, {
        t, locale: getLocale(), transport: panelTransport,
        // "Chat with this agent" / a task's conversation: the daemon chat surface shows it.
        openConversation: (id) => { applySurface("chat"); void loadDaemonConversation(id); },
      });
      companyPanel.setActive(companyPanelWanted);
    }).catch(() => {
      companyPanelHost.replaceChildren(el("div", "company-error", t("panel.loadFailed")));
    }).finally(() => { companyPanelLoading = false; });
  };

  const spacer = el("div", "rail-spacer");

  const savingsCard = el("div", "savings-card");
  savingsCard.append(el("div", "rail-section-label", t("rail.savings")));
  const savingsAmount = el("div", "savings-amount", "—");
  const savingsSub = el("div", "savings-sub", t("rail.noSavings"));
  savingsCard.append(savingsAmount, savingsSub);

  const signOutBtn = el("button", "rail-icon-btn");
  signOutBtn.type = "button";
  signOutBtn.setAttribute("aria-label", t("rail.signOut"));
  signOutBtn.title = t("rail.signOut");
  signOutBtn.append(icon("logout", 16));
  const settingsBtn = el("button", "rail-icon-btn");
  settingsBtn.type = "button";
  settingsBtn.setAttribute("aria-label", t("titlebar.settings"));
  settingsBtn.title = t("titlebar.settings");
  settingsBtn.append(icon("settings", 16));

  // Account row (design v3 footer): who is signed in + the BYOK badge.
  let accountEmail = "";
  try {
    accountEmail = globalThis.localStorage?.getItem("bv.account.email") ?? "";
  } catch {
    /* no storage — generic row */
  }
  const account = el("div", "account-row");
  const avatar = el("div", "account-avatar mono", (t("rail.profileName")[0] ?? "•").toUpperCase());
  const accountMeta = el("div", "account-meta");
  accountMeta.append(
    el("div", "account-email", t("rail.profileName")),
    el("div", "account-sub mono", accountEmail || "BYOK"),
  );
  account.append(avatar, accountMeta, settingsBtn, signOutBtn);

  rail.append(seg, valarCard, railActions, historySearch, sessionsSec, spacer, connSec, savingsCard, account);

  // --- center chat ---
  const chat = el("div", "chat");
  const scroll = el("div", "chat-scroll");
  const composer = el("div", "composer");
  const chatPresence = el("div", "chat-presence");
  const chatMascot = trackMotion(createBrandMotion());
  const chatPresenceLabel = el("span", "chat-presence-label", t("app.tagline"));
  chatPresence.append(chatMascot.element, chatPresenceLabel);
  let chatMotionVersion = 0;
  const setChatMotion = (state: MotionState, label: string) => {
    if (workspaceDisposed) return;
    chatMascot.setState(state);
    chatPresence.dataset.state = state;
    chatPresenceLabel.textContent = label;
  };

  const hint = el("div", "composer-hint"); hint.setAttribute("role", "status");
  hint.style.display = "none";

  const companyInput = el("input", "company-input") as HTMLInputElement;
  companyInput.dir = "ltr";
  companyInput.placeholder = t("chat.companyId");
  companyInput.setAttribute("aria-label", t("chat.companyId"));
  companyInput.style.display = "none"; // only for compare mode
  const compareControls = createCompareControls(cfg, t, () => companyInput.value.trim(), () => !workspaceDisposed);
  compareControls.element.style.display = "none";
  companyInput.addEventListener("input", compareControls.invalidate);
  companyInput.addEventListener("change", compareControls.invalidate);

  // Local (Ollama): optional model override.
  const localModelInput = el("input", "company-input") as HTMLInputElement;
  localModelInput.dir = "ltr";
  localModelInput.placeholder = t("chat.localModel");
  localModelInput.setAttribute("aria-label", t("chat.localModel"));
  localModelInput.style.display = "none";

  // Direct (BYOK): provider select + optional model override.
  const directProviderSel = el("select", "company-input") as HTMLSelectElement;
  for (const p of DIRECT_PROVIDERS) {
    const opt = el("option", undefined, p) as HTMLOptionElement;
    opt.value = p;
    directProviderSel.append(opt);
  }
  directProviderSel.setAttribute("aria-label", t("keys.provider")); directProviderSel.dir = "ltr";
  directProviderSel.style.display = "none";
  const directModelInput = el("input", "company-input") as HTMLInputElement;
  directModelInput.dir = "ltr";
  directModelInput.placeholder = t("chat.directModel");
  directModelInput.setAttribute("aria-label", t("chat.directModel"));
  directModelInput.style.display = "none";

  // Daemon: model from GET /v1/models (the user's own keys/local models, K3)
  // plus an optional typed PROVIDER/model for providers without a known model.
  const daemonModelSel = el("select", "company-input") as HTMLSelectElement;
  daemonModelSel.setAttribute("aria-label", t("chat.daemonModel")); daemonModelSel.dir = "ltr";
  daemonModelSel.style.display = "none";
  const daemonModelInput = el("input", "company-input") as HTMLInputElement;
  daemonModelInput.dir = "ltr";
  daemonModelInput.placeholder = t("chat.daemonModelCustom");
  daemonModelInput.setAttribute("aria-label", t("chat.daemonModelCustom"));
  daemonModelInput.style.display = "none";

  const modeToggle = el("div", "mode-toggle");
  const cascadeBtn = el("button", undefined, t("chat.modeCascade"));
  const compareBtn = el("button", undefined, t("chat.modeCompare"));
  const localBtn = el("button", undefined, t("chat.modeLocal"));
  const directBtn = el("button", undefined, t("chat.modeDirect"));
  const daemonBtn = el("button", undefined, t("chat.modeDaemon"));
  cascadeBtn.classList.add("active");
  for (const button of [cascadeBtn, compareBtn, localBtn, directBtn, daemonBtn]) button.setAttribute("aria-pressed", String(button === cascadeBtn));
  let modeChosenByUser = false;
  const applyMode = (m: Mode) => {
    mode = m;
    for (const [button, value] of [[cascadeBtn, "cascade"], [compareBtn, "compare"], [localBtn, "local"], [directBtn, "direct"], [daemonBtn, "daemon"]] as const) button.setAttribute("aria-pressed", String(value === m));
    cascadeBtn.classList.toggle("active", m === "cascade");
    compareBtn.classList.toggle("active", m === "compare");
    localBtn.classList.toggle("active", m === "local");
    directBtn.classList.toggle("active", m === "direct");
    daemonBtn.classList.toggle("active", m === "daemon");
    companyInput.style.display = m === "compare" ? "block" : "none";
    compareControls.element.style.display = m === "compare" ? "" : "none";
    if (m !== "compare") compareControls.invalidate();
    localModelInput.style.display = m === "local" ? "block" : "none";
    directProviderSel.style.display = m === "direct" ? "block" : "none";
    directModelInput.style.display = m === "direct" ? "block" : "none";
    daemonModelSel.style.display = m === "daemon" && daemonModelOptions.length ? "block" : "none";
    daemonModelInput.style.display = m === "daemon" ? "block" : "none";
    if (m !== "daemon" && daemonHintShown) { hint.textContent = ""; hint.style.display = "none"; daemonHintShown = false; }
  };
  /** True while the composer hint shows a daemon setup message (cleared on mode change). */
  let daemonHintShown = false;
  const showDaemonHint = (message: string) => {
    hint.textContent = message;
    hint.style.display = "block";
    daemonHintShown = true;
  };
  const pickMode = (m: Mode) => { modeChosenByUser = true; applyMode(m); };
  cascadeBtn.addEventListener("click", () => pickMode("cascade"));
  compareBtn.addEventListener("click", () => pickMode("compare"));
  localBtn.addEventListener("click", () => pickMode("local"));
  directBtn.addEventListener("click", () => pickMode("direct"));
  daemonBtn.addEventListener("click", () => {
    pickMode("daemon");
    // Re-probe on every explicit pick: the user may have just started it.
    void connectDaemon(true);
  });
  modeToggle.append(cascadeBtn, compareBtn, localBtn, directBtn, daemonBtn);

  const topRow = el("div", "composer-row");
  topRow.append(modeToggle, companyInput, localModelInput, directProviderSel, directModelInput, daemonModelSel, daemonModelInput);

  const ta = el("textarea") as HTMLTextAreaElement;
  ta.placeholder = t("chat.placeholder");
  ta.setAttribute("aria-label", t("chat.placeholder"));
  scroll.setAttribute("role", "log");
  scroll.setAttribute("aria-live", "polite");
  const sendBtn = el("button", "send-btn", t("chat.send"));
  const cancelBtn = el("button", "set-btn cancel-btn", t("chat.cancel"));
  cancelBtn.style.display = "none";
  let dispatchController: AbortController | null = null;
  let compareOperation: { controller: AbortController; cancel(): Promise<void> } | null = null;
  const clearCompareOperation = () => {
    const operation = compareOperation;
    compareOperation = null;
    operation?.controller.abort();
    cancelBtn.style.display = "none";
    hint.textContent = "";
    hint.style.display = "none";
  };
  /** Stop the in-flight daemon turn: graceful abort (partial answer kept) plus a host-side disconnect. */
  const stopDaemonTurn = (disconnect: boolean) => {
    const turn = daemonTurn;
    if (!turn || !daemon) return;
    void daemon.abort(turn.conversationId).catch(() => daemon.cancelStream(turn.conversationId));
    if (disconnect) { daemonTurn = null; void daemon.cancelStream(turn.conversationId); }
  };
  const stopDispatch = () => {
    chatMotionVersion += 1;
    stopDaemonTurn(true);
    dispatchController?.abort(); dispatchController = null;
    clearCompareOperation(); dispatching = false; sendBtn.disabled = false;
    for (const row of thinkingMotions.keys()) removeThinking(row);
    setChatMotion("idle", t("chat.stopped"));
    // The old run's finally will not free voice chat's lane (it no longer owns the workspace): drop a waiting sentence and listen.
    voiceChat?.cancelTurn();
  };
  activeDispatchStopper = stopDispatch;
  const cancelCurrentCompare = () => {
    if (daemonTurn) { cancelBtn.disabled = true; stopDaemonTurn(false); return; }
    void compareOperation?.cancel();
  };
  cancelBtn.addEventListener("click", cancelCurrentCompare);
  const enterHint = el("span", "enter-hint mono", t("chat.enterHint"));
  const bottomRow = el("div", "composer-row");
  // Dictation fills the composer (interim words included); sending stays the user's action.
  const micBtn = voice.canDictate ? el("button", "set-btn mic-btn") : null;
  if (micBtn) {
    micBtn.type = "button";
    micBtn.title = t("chat.voiceNote");
    micBtn.append(icon("mic", 20));
    micBtn.setAttribute("aria-label", t("chat.voiceStart"));
    micBtn.setAttribute("aria-pressed", "false");
    const idle = () => { micBtn.setAttribute("aria-pressed", "false"); micBtn.setAttribute("aria-label", t("chat.voiceStart")); };
    micBtn.addEventListener("click", () => {
      if (voice.listening) { voice.stopDictation(); return; }
      const started = voice.dictate(getLocale(), ta.value, {
        onText: (text) => { if (!workspaceDisposed) { ta.value = text; ta.dispatchEvent(new Event("input")); } },
        onEnd: (error) => {
          if (workspaceDisposed) return;
          idle();
          if (!error || error.kind === "no-speech") return;
          hint.textContent = error.kind === "denied" ? t("chat.voiceDenied") : t("chat.voiceFailed", { detail: error.detail });
          hint.style.display = "block";
        },
      });
      if (started) { micBtn.setAttribute("aria-pressed", "true"); micBtn.setAttribute("aria-label", t("chat.voiceStop")); ta.focus(); }
    });
  }
  // BRA-UI-08: voice chat, behind a default-OFF flag (bv.flags.voiceChat = "1"). Flag off: nothing below is created.
  let voiceChat: VoiceChat | null = null;
  /** Token of the voice turn whose answer we are waiting for (0 = none). Per turn, so a cancelled turn's late finally cannot clear a newer one. */
  let voiceCurrent = 0;
  let voiceSeq = 0;
  let waveBtn: HTMLButtonElement | null = null;
  let vcHost: HTMLElement | null = null;
  if (isVoiceChatEnabled()) {
    waveBtn = el("button", "vc-wave-btn");
    waveBtn.type = "button";
    waveBtn.title = t("voiceChat.button");
    waveBtn.setAttribute("aria-label", t("voiceChat.button"));
    waveBtn.setAttribute("aria-pressed", "false");
    waveBtn.append(vcIcon("wave", 16));
    const strip = el("div", "vc-strip");
    strip.hidden = true;
    vcHost = el("div", "vc-host");
    vcHost.append(strip);
    let intro: HTMLElement | null = null;
    const dismissIntro = () => { intro?.remove(); intro = null; };
    const onAction = (id: VcAction) => {
      const vc = voiceChat;
      if (!vc) return;
      if (id === "end") vc.end();
      else if (id === "cancel") {
        // A busy sentence is still waiting; the running reply belongs to something else: leave it alone.
        if (!vc.model.busy) { voiceCurrent = 0; stopDispatch(); }
        vc.cancelTurn();
      }
      else if (id === "pause" || id === "resume") vc.togglePause();
      else if (id === "interrupt") vc.interrupt();
      else if (id === "typeInstead" || id === "backToChat") { vc.dismiss(); ta.focus(); }
      else if (id === "retry" || id === "replay") vc.retry();
      else if (id === "close") vc.closeError();
      else if (id === "restart") vc.start();
    };
    voiceChat = createVoiceChat({
      voice,
      locale: getLocale,
      online: () => globalThis.navigator?.onLine !== false,
      // The heard sentence goes straight to run(); the composer draft is never read or written.
      send: (text) => {
        if (dispatching) return "busy";
        const token = ++voiceSeq;
        voiceCurrent = token;
        void run(undefined, { text, token });
        // run() returns before dispatching on a validation hint (hint stays visible in the chat).
        if (!dispatching) { voiceCurrent = 0; return "rejected"; }
        return "sent";
      },
      // The run voice chat was waiting for is orphaned: its token dies, so a late answer is never read as the new question's.
      onAbandon: () => { voiceCurrent = 0; },
      onChange: (model) => {
        if (workspaceDisposed) return;
        const view = stripView(model, t);
        const strip = vcHost!.querySelector<HTMLElement>(".vc-strip")!;
        renderStrip(strip, view, t, onAction);
        waveBtn!.setAttribute("aria-pressed", String(voiceChat?.active ?? false));
        if (view && !intro && !voiceChatIntroSeen() && model.state === "listening") {
          intro = renderIntro(t, dismissIntro);
          vcHost!.insertBefore(intro, strip);
          markVoiceChatIntroSeen();
        }
      },
      onEnded: ({ turns, seconds }) => {
        if (workspaceDisposed) return;
        scroll.append(el("div", "vc-summary", summaryLine(t, turns, seconds)));
        scrollToEnd();
      },
    });
    waveBtn.addEventListener("click", () => {
      const vc = voiceChat;
      if (!vc) return;
      if (vc.active) { vc.end(); return; }
      if (voice.listening) voice.stopDictation();
      voice.stopSpeaking();
      vc.start();
    });
  }
  // BRA-UI-09: "+" menu and text-file attachments, behind a default-OFF flag (bv.flags.attachments = "1"). Flag off: nothing below is created.
  let attachTray: AttachmentTray | null = null;
  let attachUi: AttachUi | null = null;
  if (isAttachmentsEnabled()) {
    attachTray = createTray();
    attachUi = createAttachUi({ t, tray: attachTray, locale: getLocale });
  }
  bottomRow.append(...(attachUi ? [attachUi.anchor] : []), ta, enterHint, ...(micBtn ? [micBtn] : []), ...(waveBtn ? [waveBtn] : []), cancelBtn, sendBtn);

  composer.append(storageNotice, hint, ...(vcHost ? [vcHost] : []), ...(attachUi ? [attachUi.noteHost] : []), topRow, compareControls.element, ...(attachUi ? [attachUi.chipsHost] : []), bottomRow);
  chat.append(chatPresence, scroll, composer);

  // Boş sohbet (D5): karşılama + 3 sade öneri. Mesaj gelince kendiliğinden kaybolur.
  const emptyState = el("div", "chat-empty");
  const emptyMark = valarIcon(48);
  emptyMark.classList.add("ce-mark");
  const emptyGrid = el("div", "ce-grid");
  for (const k of ["a", "b", "c"] as const) {
    const card = el("button", "ce-card") as HTMLButtonElement;
    card.type = "button";
    card.append(el("span", "ce-t", t(`chat.suggest.${k}.title`)), el("span", "ce-d", t(`chat.suggest.${k}.body`)));
    card.addEventListener("click", () => { ta.value = t(`chat.suggest.${k}.prompt`); ta.dispatchEvent(new Event("input")); ta.focus(); });
    emptyGrid.append(card);
  }
  emptyState.append(emptyMark, el("h2", undefined, t("chat.emptyTitle")), el("p", undefined, t("chat.emptyBody")), emptyGrid);
  chat.insertBefore(emptyState, composer);
  const syncEmpty = () => {
    const empty = scroll.childElementCount === 0 && surface === "chat";
    emptyState.classList.toggle("show", empty);
    scroll.classList.toggle("is-empty", empty);
  };
  new MutationObserver(syncEmpty).observe(scroll, { childList: true });

  // --- right inspector (Inspector | Activity tabs) ---
  const inspector = el("aside", "inspector");
  const inspTabs = el("div", "insp-tabs");
  const inspTabDetail = el("button", "insp-tab active", t("gov.inspectorTab"));
  const inspTabActivity = el("button", "insp-tab", t("gov.activity"));
  inspTabDetail.setAttribute("aria-pressed", "true"); inspTabActivity.setAttribute("aria-pressed", "false");
  const inspTabChanges = el("button", "insp-tab", t("changes.tab"));
  inspTabChanges.setAttribute("aria-pressed", "false");
  inspTabs.append(inspTabDetail, inspTabActivity, inspTabChanges);
  const inspectorBody = el("div", "insp-detail");
  inspectorBody.append(el("div", "inspector-empty", t("inspector.empty")));
  const activityBody = el("div", "insp-activity");
  activityBody.style.display = "none";
  inspector.append(inspTabs, inspectorBody, activityBody, changesSec);

  chat.append(codePane);
  chat.append(companyPane);

  shell.append(rail, chat, inspector);
  // BRA-UI-11: new-version banner, behind a default-OFF flag (bv.flags.updateBanner = "1"). Flag off: no banner, no request.
  const update = mountUpdate({ t, version: APP_VERSION, invoke: tauriInvoke });
  const win = el("div", "win");
  win.append(titlebar, ...(update ? [update.banner] : []), shell);
  root.append(win);
  // BRA-UI-11: first-run setup, behind a default-OFF flag (bv.flags.setup = "1"). Flag off: nothing below is created.
  let setupUi: ReturnType<typeof mountSetup> | null = null;
  if (isSetupEnabled() && !isSetupDone()) {
    const setup = setupUi = mountSetup({ t, invoke: tauriInvoke, vault: deps.vault, providers: DIRECT_PROVIDERS, nav: globalThis.navigator as never, contain: containDialog });
    root.append(setup.element);
  }

  // --- settings sheet (design v3) ---
  // One modal for everything configurable: keys, MCP servers, governance
  // policy. Opened from the title bar, dismissed with Esc / backdrop click.
  let settingsOpen = false;
  const backdrop = el("div", "sheet-backdrop");
  backdrop.style.display = "none";
  const sheet = el("div", "sheet");
  const sheetHead = el("div", "sheet-head");
  sheetHead.append(el("b", "sheet-title", t("settings.title")), el("div", "tb-spacer"));
  const sheetClose = el("button", "sheet-close mono", t("settings.close"));
  sheetHead.append(sheetClose);
  const sheetBody = el("div", "sheet-body");

  // Design-v3 settings IA: four labelled sections. Rows are thin wiring —
  // anything with behavior delegates to tested modules (vault/mcp/gov/prefs).
  const setRow = (title: string, sub: string, control?: HTMLElement): HTMLElement => {
    const row = el("div", "set-row");
    const meta = el("div", "set-meta");
    meta.append(el("b", "set-title", title), el("span", "set-sub", sub));
    row.append(meta);
    if (control) row.append(control);
    return row;
  };

  // MODELS & KEYS — vault + the Lane-B pointer (single source: Code surface).
  const openCodeBtn = el("button", "set-btn", t("settings.openCode"));
  openCodeBtn.addEventListener("click", () => {
    sheetClose.click();
    segCodeBtn.click();
  });
  const secModels = el("div", "sheet-sec");
  secModels.append(
    keysSec,
    setRow(t("settings.vendorCli"), t("settings.vendorCliSub"), openCodeBtn),
  );

  // CONNECTORS & HOSTS — MCP registry + the host-runtime disclosure line.
  const secConn = el("div", "sheet-sec");
  secConn.append(
    mcpSec,
    setRow(t("settings.hosts"), t("settings.hostsSub")),
  );

  // COMPANION — broadcast THIS workspace session to the relay so the phone
  // (same account — owner-binding needs no pairing) can watch, steer and
  // answer approvals. deps.gov is swapped to the bridgeGovernance decorator
  // while live so approval requests + audit mirror up; the swap is reversed
  // on stop. NOTE: a companion approve still lands on the Rust NATIVE dialog
  // (R4) — remote approval without the native confirm is a founder decision.
  let compBridge: RelayBridge | null = null;
  let startingCompanion: RelayBridge | null = null;
  const baseGov = deps.gov;
  const compToggle = el("button", "toggle");
  const compStatus = el("div", "set-sub mono", t("settings.companionOff"));
  compToggle.setAttribute("aria-label", t("settings.companionTitle"));
  const syncComp = () => { compToggle.classList.toggle("on", !!compBridge); compToggle.setAttribute?.("aria-pressed", String(!!compBridge)); };
  syncComp();
  const stopCompanion = async () => {
    deps.gov = baseGov;
    activeRelayStopper = null;
    const b = compBridge;
    const pending = startingCompanion;
    compBridge = null;
    startingCompanion = null;
    compToggle.disabled = false;
    syncComp();
    compStatus.textContent = t("settings.companionOff");
    await b?.stop().catch(() => {});
    await pending?.stop().catch(() => {});
  };
  const startCompanion = async () => {
    if (workspaceDisposed || compToggle.disabled || compBridge || startingCompanion) return;
    const owner = captureSession(cfg);
    const current = () => !workspaceDisposed && isCurrentSession(cfg, owner);
    let pending: RelayBridge | null = null;
    compToggle.disabled = true;
    try {
      const transport = createRelayTransport({ cfg });
      const b = new RelayBridge(transport, {
        /**
         * Owner-bound remote steer behaves like a typed prompt: fill + run.
         * Two guards the local path gets for free but this one doesn't:
         * (a) refuse while a dispatch is in flight — a burst of steer frames
         *     would otherwise fan out into concurrent paid dispatches;
         * (b) mirror an audit line so the ledger and the phone both record
         *     that THIS dispatch was remote-initiated, not typed here.
         */
        onSteer: (m) => {
          if (!ownsBridge()) return;
          if (dispatching) {
            void b?.emitAudit("steer: refused — a dispatch is already running").catch(() => {});
            return;
          }
          void b?.emitAudit(`steer: remote prompt accepted (${mode})`).catch(() => {});
          nextDispatchRemote = true;
          if (mode !== "daemon") record("user", `↯ ${m}`); // ↯ marks remote origin in the transcript (the daemon stores its own)
          ta.value = m;
          void run();
        },
        onApprove: async (id) => {
          if (!ownsBridge()) return;
          // Hand the minted token to the modal that is still waiting locally,
          // otherwise the phone's "Allow" burns the pending record and the
          // local flow fails with "resolved elsewhere" — approving would
          // cancel the very action the user approved.
          const r = await resolveApproval(deps.gov, id);
          if (!ownsBridge()) return;
          const settle = openApprovals.get(id);
          if (r.resolved && settle) settle({ approved: true, token: r.token });
          else if (r.resolved) {
            // No modal waiting (app re-rendered): the grant is unusable, so
            // say so rather than leaving a silent dangling token.
            void b?.emitAudit(`approve: no local request waiting for ${id}`).catch(() => {});
          }
        },
        onReject: async (id) => {
          if (!ownsBridge()) return;
          await resolveRejection(deps.gov, id);
          if (!ownsBridge()) return;
          openApprovals.get(id)?.({ approved: false });
        },
        onKill: async () => {
          if (!ownsBridge()) return;
          await killEverything(deps.gov);
        },
      });
      const ownsBridge = () => current() && (compBridge === b || startingCompanion === b);
      pending = b;
      startingCompanion = b;
      activeRelayStopper = stopCompanion;
      const { sessionId } = await b.start({
        surface: "desktop",
        label: (activeSession?.title || t("app.name")).slice(0, 200),
      });
      if (!current() || startingCompanion !== b) {
        if (startingCompanion === b) {
          startingCompanion = null;
          if (!compBridge && activeRelayStopper === stopCompanion) activeRelayStopper = null;
        }
        await b.stop().catch(() => {});
        return;
      }
      startingCompanion = null;
      compBridge = b;
      deps.gov = bridgeGovernance(baseGov, b);
      activeRelayStopper = stopCompanion;
      compStatus.textContent = t("settings.companionOn", { id: sessionId.slice(0, 12) });
    } catch {
      if (pending && startingCompanion !== pending) return;
      if (!current()) {
        startingCompanion = null;
        if (!compBridge && activeRelayStopper === stopCompanion) activeRelayStopper = null;
        await pending?.stop().catch(() => {});
        return;
      }
      await stopCompanion();
      if (current() && !startingCompanion && !compBridge) compStatus.textContent = t("settings.companionErr");
    } finally {
      if (current() && (!startingCompanion || startingCompanion === pending)) {
        compToggle.disabled = false;
        syncComp();
      }
    }
  };
  compToggle.addEventListener("click", () => (compBridge ? void stopCompanion() : void startCompanion()));
  const secComp = el("div", "sheet-sec");
  const compRow = setRow(t("settings.companionTitle"), t("settings.companionSub"), compToggle);
  secComp.append(
    compRow,
    compStatus,
    setRow(t("settings.companionPhone"), t("settings.companionPhoneSub")),
  );

  // GOVERNANCE — the real per-action policy table (gov.policy(), pure) + kill.
  const policyList = el("div", "policy-list");
  for (const row of deps.gov.policy()) {
    const r = el("div", "policy-row");
    r.append(el("span", "policy-kind mono", row.kind));
    const chipCls =
      row.decision === "auto-allow" ? "chip chip-safe" : row.decision === "deny" ? "chip chip-risk" : "chip chip-ask";
    const chipText =
      row.decision === "auto-allow"
        ? t("settings.policyAuto")
        : row.decision === "deny"
          ? t("settings.policyDeny")
          : t("settings.policyAsk");
    r.append(el("span", chipCls, chipText));
    policyList.append(r);
  }
  const killBtn = el("button", "kill-btn", t("settings.killBtn"));
  killBtn.addEventListener("click", () => void showKillDialog(deps));
  const secGov = el("div", "sheet-sec");
  secGov.append(
    setRow(t("settings.policyTitle"), t("settings.policySub")),
    policyList,
    setRow(t("settings.killTitle"), t("settings.killSub"), killBtn),
  );

  // APP & DATA — a WORKING reduced-motion toggle + the honest telemetry line.
  const rmToggle = el("button", "toggle");
  const rmNotice = el("div", "storage-notice"); rmNotice.setAttribute("role", "status");
  const syncRm = () => { rmToggle.classList.toggle("on", prefs.reducedMotion()); rmToggle.setAttribute("aria-label", t("settings.reducedMotion")); rmToggle.setAttribute("aria-pressed", String(prefs.reducedMotion())); };
  syncRm();
  rmToggle.addEventListener("click", () => {
    const persisted = prefs.setReducedMotion(!prefs.reducedMotion());
    rmNotice.textContent = persisted ? "" : t("settings.preferenceUnsaved");
    applyReducedMotion(document.documentElement, effectiveReducedMotion(prefs, osPrefersReducedMotion()));
    notifyBrandMotionPreference();
    syncRm();
  });
  const secAppearance = el("div", "sheet-sec");
  secAppearance.append(
    languageSelector(deps),
    themeSelector(deps),
    setRow(t("settings.reducedMotion"), t("settings.reducedMotionSub"), rmToggle),
    rmNotice,
  );
  const secPrivacy = el("div", "sheet-sec");
  secPrivacy.append(setRow(t("settings.telemetry"), t("settings.telemetrySub")));

  // Sol sayfa listesi + sağ sayfa paneli (Ilık Grafit D13–D24). Yalnız koda karşılığı
  // olan sayfalar var; her mevcut ayar tam olarak bir sayfada durur.
  // BRA-UI-11: About (version). The update check inside it exists only while bv.flags.updateBanner = "1".
  const secAbout = update ? update.about() : buildAbout({ t, version: APP_VERSION, invoke: tauriInvoke }, null, () => "");
  const pageContent: Record<SettingsPageId, { icon: keyof typeof ICONS; sections: HTMLElement[] }> = {
    appearance: { icon: "sun", sections: [secAppearance] },
    keys: { icon: "key", sections: [secModels] },
    connectors: { icon: "plug", sections: [secConn] },
    approvals: { icon: "shield", sections: [secGov] },
    companion: { icon: "phone", sections: [secComp] },
    privacy: { icon: "lock", sections: [secPrivacy] },
    about: { icon: "info", sections: [secAbout] },
  };
  const sheetMain = el("div", "sheet-main");
  const pageNav = el("div", "set-nav");
  pageNav.setAttribute("role", "tablist");
  const narrow = typeof matchMedia === "function" ? matchMedia("(max-width: 640px)") : null;
  const syncOrientation = () => pageNav.setAttribute("aria-orientation", narrow?.matches ? "horizontal" : "vertical");
  syncOrientation(); narrow?.addEventListener?.("change", syncOrientation);
  pageNav.setAttribute("aria-label", t("settings.title"));
  const pageTabs = new Map<SettingsPageId, HTMLButtonElement>();
  const pagePanels = new Map<SettingsPageId, HTMLElement>();
  let currentPage: SettingsPageId = SETTINGS_PAGE_IDS[0];
  const showPage = (id: SettingsPageId, focus = false) => {
    currentPage = id;
    for (const pid of SETTINGS_PAGE_IDS) {
      const on = pid === id;
      const tab = pageTabs.get(pid)!, panel = pagePanels.get(pid)!;
      tab.classList.toggle("active", on); tab.setAttribute("aria-selected", String(on)); tab.tabIndex = on ? 0 : -1;
      panel.hidden = !on;
    }
    if (focus) pageTabs.get(id)!.focus();
  };
  for (const pid of SETTINGS_PAGE_IDS) {
    const tab = el("button", "set-nav-item");
    tab.type = "button"; tab.id = `set-tab-${pid}`;
    tab.setAttribute("role", "tab"); tab.setAttribute("aria-controls", `set-panel-${pid}`);
    tab.append(icon(pageContent[pid].icon, 16), el("span", undefined, t(`settings.page.${pid}`)));
    tab.addEventListener("click", () => showPage(pid));
    tab.addEventListener("keydown", (e) => {
      const next = nextSettingsPage(SETTINGS_PAGE_IDS, pid, e.key, { horizontal: !!narrow?.matches, rtl: document.documentElement.dir === "rtl" }) as SettingsPageId | null;
      if (next) { e.preventDefault(); showPage(next, true); }
    });
    pageNav.append(tab); pageTabs.set(pid, tab);
    const panel = el("div", "set-page");
    panel.id = `set-panel-${pid}`; panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", tab.id);
    panel.append(el("h2", "set-page-title", t(`settings.page.${pid}`)), ...pageContent[pid].sections);
    sheetBody.append(panel); pagePanels.set(pid, panel);
  }
  showPage(currentPage);
  sheetMain.append(pageNav, sheetBody);
  sheet.append(sheetHead, sheetMain);
  backdrop.append(sheet);
  root.append(backdrop);

  let releaseSettingsFocus: (() => void) | undefined;
  sheet.setAttribute("aria-label", t("settings.title"));
  const setSettings = (open: boolean) => {
    settingsOpen = open;
    backdrop.style.display = open ? "flex" : "none";
    releaseSettingsFocus?.(); releaseSettingsFocus = undefined;
    if (open) { releaseSettingsFocus = containDialog(sheet, () => setSettings(false)); sheetClose.focus(); }
  };
  settingsBtn.addEventListener("click", () => setSettings(true));
  // Şirket sayfasındaki "Ayarlar'ı aç" bağlantısı (bütçe/bağlayıcı/kural sekmeleri Ayarlar'da).
  const onOpenSettings = () => setSettings(true);
  globalThis.addEventListener?.("bv:open-settings", onOpenSettings);
  // BRA-P0-04i: jobs inbox, behind a default-OFF flag (bv.flags.jobsInbox = "1").
  if (isInboxEnabled()) {
    const inbox = mountInbox(root, cfg, t, deps.persist);
    const inboxBtn = el("button", "tb-settings", t("inbox.title"));
    inboxBtn.addEventListener("click", () => inbox.open());
    titlebar.insertBefore(inboxBtn, nowWrap);
  }
  sheetClose.addEventListener("click", () => setSettings(false));
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) setSettings(false);
  });
  // Sheet-local Esc handler; registered once per workspace render.
  const onWorkspaceKey = (e: KeyboardEvent) => {
    // Esc ends voice chat only when nothing else claims it: no open sheet/panel, not already handled,
    // and focus is in the chat (or nowhere in particular), never inside another dialog.
    const focus = document.activeElement;
    const inChat = !focus || focus === document.body || chat.contains(focus);
    if (e.key === "Escape" && voiceChat?.active && !e.defaultPrevented && !settingsOpen && !nowOpen && inChat) voiceChat.end();
    else if (e.key === "Escape" && settingsOpen) setSettings(false);
    else if (e.key === "Escape" && nowOpen) { setNow(false); nowBtn.focus(); }
  };
  window.addEventListener("keydown", onWorkspaceKey);

  // --- "Şu an" panel: read-only view over existing sources (no new backend) ---
  let nowOpen = false;
  let nowSeq = 0;
  const nowRow = (kind: NowKind, text: string) => {
    const row = el("div", `now-row now-${kind}`);
    const wordKey = { run: "now.running", approval: "now.approval", error: "now.error", done: "now.done", queue: "now.queued" }[kind];
    row.append(el("span", "now-glyph", NOW_GLYPH[kind]), el("span", "now-text", text), el("span", "now-word mono", t(wordKey)));
    return row;
  };
  let lastInboxRows: Array<[NowKind, string]> = [];
  let nowCleanup: (() => void) | null = null;
  const renderNow = (inboxRows: Array<[NowKind, string]> = lastInboxRows) => {
    lastInboxRows = inboxRows;
    nowPop.replaceChildren(el("div", "now-title", t("now.title")));
    const rows: HTMLElement[] = [];
    if (dispatching) rows.push(nowRow("run", t("now.chatTurn")));
    if (openApprovals.size) rows.push(nowRow("approval", t("now.localApproval")));
    // Company data is only trustworthy while the panel is live (Company surface); otherwise say where to look.
    const data = surface === "company" ? companyPanel?.state() : undefined;
    if (!data) rows.push(el("div", "now-hint", t("now.companyHint")));
    else {
      for (const a of data.approvals) rows.push(nowRow("approval", a.title));
      for (const task of data.tasks) {
        const kind: NowKind | null = task.status === "RUNNING" ? "run" : task.status === "OPEN" ? "queue" : task.status === "FAILED" ? "error" : task.status === "DONE" ? "done" : null;
        if (kind) rows.push(nowRow(kind, task.title));
      }
    }
    for (const [kind, text] of inboxRows) rows.push(nowRow(kind, text));
    const live = rows.filter(r => !r.classList.contains("now-hint"));
    if (!live.length) nowPop.append(el("div", "now-empty", t("now.empty")));
    else nowPop.append(...live.slice(0, 12));
    if (live.length > 12) nowPop.append(el("div", "now-more", t("now.more", { n: live.length - 12 })));
    if (!data) nowPop.append(rows.find(r => r.classList.contains("now-hint"))!);
  };
  const setNow = (open: boolean) => {
    nowOpen = open;
    nowBtn.setAttribute("aria-expanded", String(open));
    nowPop.style.display = open ? "" : "none";
    nowCleanup?.(); nowCleanup = null;
    if (!open) return;
    lastInboxRows = [];
    renderNow();
    nowPop.focus();
    // Redraw while open: company store changes and chat-turn start/stop (send button's disabled flips with the turn).
    const unsub = surface === "company" ? companyPanel?.subscribe(() => renderNow()) : undefined;
    const observer = new MutationObserver(() => renderNow());
    observer.observe(sendBtn, { attributes: true, attributeFilter: ["disabled"] });
    nowCleanup = () => { unsub?.(); observer.disconnect(); };
    if (!isInboxEnabled()) return;
    const seq = ++nowSeq;
    void loadBuckets(cfg, { save: deps.persist, limit: 6 }).then((buckets) => {
      if (workspaceDisposed || !nowOpen || seq !== nowSeq) return;
      const kindOf = { working: "run", needs_approval: "approval", stuck: "error", done: "done" } as const;
      const out: Array<[NowKind, string]> = [];
      for (const b of ["needs_approval", "working", "stuck", "done"] as const) {
        for (const r of buckets[b] ?? []) out.push([kindOf[b], r.pipeline?.name ?? r.id]);
      }
      renderNow(out);
    }).catch(() => { /* keep the local view; the inbox reports its own errors */ });
  };
  nowBtn.addEventListener("click", (e) => { e.stopPropagation(); setNow(!nowOpen); });
  nowPop.addEventListener("click", (e) => e.stopPropagation());
  nowPop.tabIndex = -1;
  nowWrap.addEventListener("focusout", (e) => { if (nowOpen && !nowWrap.contains(e.relatedTarget as Node | null)) setNow(false); });
  const onNowOutside = () => { if (nowOpen) setNow(false); };
  window.addEventListener("click", onNowOutside);

  // --- company surface ---
  let companyBusy = false;
  const renderCompany = (companies: CompanyView[], jobs: JobView[], error?: string) => {
    cloudBox.replaceChildren();

    if (error) {
      const err = el("div", "company-error", error);
      cloudBox.append(err);
      return;
    }

    const sum = companySummary(companies, jobs);
    cloudBox.append(
      el(
        "div",
        "company-summary mono",
        t("company.summary", {
          total: sum.total,
          active: sum.active,
          jobs: sum.jobs,
          scheduled: sum.scheduled,
        }),
      ),
    );

    if (companies.length === 0) {
      // Authoring lives on the web; the desktop reads and controls.
      cloudBox.append(el("div", "company-empty", t("company.empty")));
    }

    cloudBox.append(el("div", "rail-section-label", t("company.companies")));
    for (const c of companies) {
      const row = el("div", "company-row");
      row.append(el("span", `dot dot-${c.tone === "arc" ? "done" : c.tone === "ember" ? "run" : c.tone === "molten" ? "risk" : "idle"}`));
      const meta = el("div", "company-meta");
      meta.append(
        el("div", "company-name", c.name),
        el(
          "div",
          "company-sub mono",
          t("company.counts", { agents: c.agentCount ?? t("common.unknown"), pipelines: c.pipelineCount ?? t("common.unknown") }),
        ),
      );
      row.append(meta);
      const statusKey = ({ ACTIVE: "company.statusActive", PAUSED: "company.statusPaused", DRAFT: "company.statusDraft", ARCHIVED: "company.statusArchived" } as Record<string, string>)[c.status.toUpperCase()];
      row.append(el("span", "company-status mono", statusKey ? t(statusKey) : c.status || t("common.unknown")));

      // Only render an action the server will actually accept (pause 404s on a
      // non-ACTIVE company, resume on a non-PAUSED one) — a button that always
      // fails is worse than no button.
      if (c.canPause || c.canResume) {
        const btn = el("button", "set-btn", c.canPause ? t("company.pause") : t("company.resume"));
        btn.addEventListener("click", async () => {
          if (companyBusy) return;
          companyBusy = true;
          btn.disabled = true;
          try {
            if (c.canPause) await pauseCompany(cfg, c.id, { save: deps.persist });
            else await resumeCompany(cfg, c.id, { save: deps.persist });
            await loadCompany();
          } catch (e) {
            const msg = redactSummary(e instanceof ApiError ? `${e.status} · ${e.message}` : String(e));
            renderCompany(companies, jobs, msg);
          } finally {
            companyBusy = false;
          }
        });
        row.append(btn);
      }
      cloudBox.append(row);
    }

    cloudBox.append(el("div", "rail-section-label", t("company.jobs")));
    if (jobs.length === 0) {
      cloudBox.append(el("div", "company-empty", t("company.noJobs")));
    }
    const now = Date.now();
    for (const j of jobs) {
      const row = el("div", "company-row");
      const meta = el("div", "company-meta");
      const age = relativeAge(j.lastRunAt, now);
      meta.append(
        el("div", "company-name", j.name),
        el(
          "div",
          "company-sub mono",
          [j.schedule, age ? t("company.lastRun", { age }) : ""].filter(Boolean).join(" · "),
        ),
      );
      row.append(meta);
      // "unscheduled" is its own word on purpose: an enabled job whose cron
      // never reached the scheduler is a real bug, not the same as paused.
      const stateText =
        j.state === "scheduled"
          ? relativeAge(j.nextRunAt, now)
            ? t("company.nextRun", { age: relativeAge(j.nextRunAt, now) })
            : t("company.stateScheduled")
          : j.state === "paused"
            ? t("company.statePaused")
            : t("company.stateUnscheduled");
      row.append(
        el(
          "span",
          `company-status mono${j.state === "unscheduled" ? " bad" : ""}`,
          stateText,
        ),
      );
      cloudBox.append(row);
    }
  };

  const loadCompany = async () => {
    cloudBox.replaceChildren(el("div", "company-empty", t("company.loading")));
    try {
      const [rawCompanies, rawJobs] = await Promise.all([
        listCompanies(cfg, { save: deps.persist }),
        // Jobs are a nice-to-have: if the scheduled endpoint fails we still show
        // the companies rather than blanking the whole surface.
        listScheduledPipelines(cfg, { save: deps.persist }).catch(() => null),
      ]);
      renderCompany(toCompanyViews(rawCompanies), toJobViews(rawJobs));
    } catch (e) {
      const msg = redactSummary(e instanceof ApiError ? `${e.status} · ${e.message}` : String(e));
      renderCompany([], [], t("company.loadFailed", { reason: msg }));
    }
  };

  // --- surface switch ---
  let surface: "chat" | "company" | "code" = "chat";
  const applySurface = (s: "chat" | "company" | "code") => {
    surface = s;
    for (const [button, value] of [[segChatBtn, "chat"], [segCompanyBtn, "company"], [segCodeBtn, "code"]] as const) button.setAttribute("aria-selected", String(value === s));
    segChatBtn.classList.toggle("active", s === "chat");
    segCompanyBtn.classList.toggle("active", s === "company");
    segCodeBtn.classList.toggle("active", s === "code");
    scroll.style.display = s === "chat" ? "" : "none";
    composer.style.display = s === "chat" ? "" : "none";
    chatPresence.style.display = s === "chat" ? "" : "none";
    chatMascot.setVisible(s === "chat");
    for (const motion of thinkingMotions.values()) motion.setVisible(s === "chat");
    syncEmpty();
    codePane.style.display = s === "code" ? "" : "none";
    companyPane.style.display = s === "company" ? "" : "none";
    crumb.textContent =
      s === "chat"
        ? activeSession?.title || t("app.name")
        : s === "company"
          ? t("surface.companyCrumb")
          : t("surface.codeCrumb");
    // Fetch on entry, not on mount: the Company surface costs two requests and
    // most sessions never open it.
    if (s === "company") void loadCompany();
    setCompanyPanelActive(s === "company");
    if (s === "code") showTab("changes");
  };
  segChatBtn.addEventListener("click", () => applySurface("chat"));
  segCompanyBtn.addEventListener("click", () => applySurface("company"));
  segCodeBtn.addEventListener("click", () => applySurface("code"));
  applySurface(surface);

  // --- governance activity view (policy visibility + audit ledger) ---
  let activeTab: "detail" | "activity" | "changes" = "detail";
  const refreshActivity = async () => {
    activityBody.innerHTML = "";
    // Policy visibility — which kinds auto-run vs ask; a constant, not host-trusted.
    const pol = el("div", "policy-sec");
    pol.append(el("div", "insp-h", t("gov.policyTitle")));
    pol.append(el("div", "policy-hint", t("gov.policyHint")));
    for (const rowSpec of deps.gov.policy()) {
      const r = el("div", "policy-row");
      r.append(el("span", "policy-kind mono", rowSpec.kind));
      const cls =
        rowSpec.decision === "auto-allow" ? "policy-badge auto" : rowSpec.decision === "deny" ? "policy-badge deny" : "policy-badge ask";
      const txt =
        rowSpec.decision === "auto-allow" ? t("gov.decisionAuto") : rowSpec.decision === "deny" ? t("gov.decisionDeny") : t("gov.decisionApproval");
      r.append(el("span", cls, txt));
      pol.append(r);
    }
    activityBody.append(pol);
    // Audit ledger — newest first, secret-free by construction.
    const aud = el("div", "audit-sec");
    aud.append(el("div", "insp-h", t("gov.auditTitle")));
    const entries = await deps.gov.recent(30);
    if (!entries.length) {
      aud.append(el("div", "inspector-empty", t("gov.auditEmpty")));
    } else {
      for (const e of [...entries].reverse()) aud.append(renderAuditRow(e));
    }
    activityBody.append(aud);
  };
  const showTab = (tab: "detail" | "activity" | "changes") => {
    activeTab = tab;
    inspTabDetail.setAttribute("aria-pressed", String(tab === "detail"));
    inspTabActivity.setAttribute("aria-pressed", String(tab === "activity"));
    inspTabDetail.classList.toggle("active", tab === "detail");
    inspTabActivity.classList.toggle("active", tab === "activity");
    inspTabChanges.setAttribute("aria-pressed", String(tab === "changes"));
    inspTabChanges.classList.toggle("active", tab === "changes");
    changesSec.style.display = tab === "changes" ? "flex" : "none";
    if (tab === "changes" && changesPathInput.value.trim()) void loadChanges();
    inspectorBody.style.display = tab === "detail" ? "block" : "none";
    activityBody.style.display = tab === "activity" ? "block" : "none";
    if (tab === "activity") void refreshActivity();
  };
  inspTabDetail.addEventListener("click", () => showTab("detail"));
  inspTabActivity.addEventListener("click", () => showTab("activity"));
  inspTabChanges.addEventListener("click", () => showTab("changes"));
  const bumpActivity = () => {
    if (activeTab === "activity") void refreshActivity();
  };

  // --- behavior ---
  const scrollToEnd = () => (scroll.scrollTop = scroll.scrollHeight);

  // --- chat sessions: list, switch, record ---
  const sessionItem = (s: ChatSession): HTMLElement => {
    const item = el("button", "session-item");
    if (activeSession?.id === s.id) item.classList.add("active");
    item.append(el("span", "session-title", s.title || t("sessions.untitled")));
    item.addEventListener("click", () => loadSession(s.id));
    return item;
  };

  const historyItem = (h: HistoryItem): HTMLElement => {
    if (h.kind === "local") {
      const s = sessionStore.get(h.id);
      if (s) return sessionItem(s);
    }
    const item = el("button", "session-item");
    if (activeDaemonConv?.id === h.id) item.classList.add("active");
    item.append(el("span", "session-title", h.title || t("sessions.untitled")));
    item.addEventListener("click", () => void loadDaemonConversation(h.id));
    return item;
  };

  let searchResults: SearchResult[] | null = null;
  const refreshSessionList = () => {
    sessionsSec.replaceChildren();
    if (daemonOnline && searchResults) {
      if (!searchResults.length) sessionsSec.append(el("div", "rail-section-label", t("sessions.noResults")));
      for (const r of searchResults) {
        const item = el("button", "session-item");
        if (activeDaemonConv?.id === r.conversationId) item.classList.add("active");
        const title = daemonConversations.find(c => c.id === r.conversationId)?.title;
        item.append(el("span", "session-title", title || t("sessions.untitled")));
        item.title = r.snippet;
        item.addEventListener("click", () => void loadDaemonConversation(r.conversationId));
        sessionsSec.append(item);
      }
      return;
    }
    const appendBuckets = <T extends { updatedAt: number }>(items: T[], make: (item: T) => HTMLElement) => {
      const g = groupSessions(items, Date.now());
      for (const [label, rows] of [["sessions.today", g.today], ["sessions.yesterday", g.yesterday], ["sessions.last7", g.last7], ["sessions.older", g.older]] as const) {
        if (!rows.length) continue;
        sessionsSec.append(el("div", "rail-section-label", t(label)));
        for (const row of rows) sessionsSec.append(make(row));
      }
    };
    if (daemonOnline) appendBuckets(mergeHistory(daemonConversations, sessionStore.list()), historyItem);
    else appendBuckets(sessionStore.list(), sessionItem);
  };

  const syncCrumb = () => {
    if (surface !== "chat") return;
    crumb.textContent = activeDaemonConv?.title || activeSession?.title || t("app.name");
  };

  // --- local daemon: probe, migrate, models, conversations, search ---
  const refreshDaemonConversations = async () => {
    if (!daemon || !daemonOnline) return;
    try {
      const list = await daemon.listConversations({ limit: 50 });
      if (workspaceDisposed) return;
      daemonConversations = list;
    } catch { /* keep the last list; the next turn or probe retries */ }
    refreshSessionList();
  };
  const fillDaemonModels = (options: ModelOption[]) => {
    const previous = daemonModelSel.value;
    daemonModelOptions = options;
    daemonModelSel.replaceChildren();
    options.forEach((o, index) => {
      const opt = el("option", undefined, o.label) as HTMLOptionElement;
      opt.value = String(index);
      daemonModelSel.append(opt);
    });
    if (previous && Number(previous) < options.length) daemonModelSel.value = previous;
    daemonModelSel.style.display = mode === "daemon" && options.length ? "block" : "none";
  };
  const refreshDaemonModels = async () => {
    if (!daemon) return;
    try { fillDaemonModels(modelOptions(await daemon.models())); }
    catch { fillDaemonModels([]); }
  };
  /** Selected model: a typed PROVIDER/model wins over the suggestion list. */
  const readDaemonModel = (): { provider: string; model: string } | { error: string } => {
    const typed = daemonModelInput.value.trim();
    if (typed) return parseModelRef(typed) ?? { error: t("chat.daemonModelInvalid") };
    const option = daemonModelOptions[Number(daemonModelSel.value)];
    return option ? { provider: option.provider, model: option.model } : { error: t("chat.daemonNoModels") };
  };
  const showDaemonModel = (provider: string | null, model: string | null) => {
    if (!provider || !model) return;
    const index = daemonModelOptions.findIndex(o => o.provider === provider && o.model === model);
    if (index >= 0) { daemonModelSel.value = String(index); daemonModelInput.value = ""; }
    else daemonModelInput.value = `${provider}/${model}`;
  };
  let daemonProbe: Promise<void> | null = null;
  const connectDaemon = (explicit = false): Promise<void> => daemonProbe ??= (async () => {
    try {
      if (!daemon) { daemonOnline = false; return; }
      const status = await daemon.status();
      if (workspaceDisposed) return;
      daemonOnline = status.running;
      if (!daemonOnline) return;
      // One-time move of the localStorage transcript into the daemon. Each
      // session is cleared only after the daemon confirmed it; re-runs skip.
      const report = await migrateLocalSessions(daemon, sessionStore, { exclude: activeSession ? [activeSession.id] : [] }).catch(() => null);
      if (workspaceDisposed) return;
      if (report?.failed) migrationNote = t("sessions.importPartial");
      else if (report?.cleared) migrationNote = t("sessions.imported", { n: report.cleared });
      await Promise.all([refreshDaemonModels(), refreshDaemonConversations()]);
    } catch {
      daemonOnline = false;
    } finally {
      daemonProbe = null;
      if (!workspaceDisposed) {
        historySearch.style.display = daemonOnline ? "" : "none";
        searchBtn.disabled = !daemonOnline;
        if (daemonOnline && !modeChosenByUser && mode === "cascade" && !dispatching) applyMode("daemon");
        if (mode === "daemon") {
          if (!daemonOnline) showDaemonHint(t("chat.daemonOffline"));
          else if (!daemonModelOptions.length && !daemonModelInput.value.trim()) showDaemonHint(t("chat.daemonNoModels"));
          else if (daemonHintShown) { hint.textContent = ""; hint.style.display = "none"; daemonHintShown = false; }
        } else if (explicit && !daemonOnline) showDaemonHint(t("chat.daemonOffline"));
        updateStorageNotice();
        refreshSessionList();
      }
    }
  })();
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchVersion = 0;
  historySearch.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = historySearch.value.trim();
    const version = ++searchVersion;
    if (!q || !daemon) { searchResults = null; refreshSessionList(); return; }
    searchTimer = setTimeout(async () => {
      try {
        const results = await daemon.search(q, 20);
        if (workspaceDisposed || version !== searchVersion) return;
        searchResults = results;
      } catch {
        if (version !== searchVersion) return;
        searchResults = [];
      }
      refreshSessionList();
    }, 250);
  });
  let daemonLoadVersion = 0;
  const loadDaemonConversation = async (id: string) => {
    if (!daemon) return;
    const version = ++daemonLoadVersion;
    let loaded: Awaited<ReturnType<DaemonClient["getConversation"]>>;
    try { loaded = await daemon.getConversation(id); }
    catch (e) {
      if (workspaceDisposed || version !== daemonLoadVersion) return;
      showDaemonHint(daemonErrorText(e));
      return;
    }
    if (workspaceDisposed || version !== daemonLoadVersion) return;
    chatMotionVersion += 1;
    clearCompareOperation();
    dispatching = false;
    sendBtn.disabled = false;
    setChatMotion("idle", t("app.tagline"));
    for (const row of thinkingMotions.keys()) removeThinking(row);
    activeSession = null;
    activeDaemonConv = loaded.conversation;
    scroll.replaceChildren();
    for (const m of loaded.messages) {
      if (m.role === "user") {
        // A turn sent with attachments is stored by the daemon with the file text inside: show the words and name/size chips only.
        const { text: said, files } = splitWire(m.content);
        scroll.append(el("div", "msg-user", said));
        if (files.length) scroll.append(renderSentChips(files, t, getLocale()));
      }
      else renderPlainAnswer(scroll, m.content, t);
    }
    showDaemonModel(loaded.conversation.provider, loaded.conversation.model);
    applyMode("daemon");
    inspectorBody.replaceChildren(el("div", "inspector-empty", t("inspector.empty")));
    if (loaded.conversation.provider) renderSourceInspector(inspectorBody, t("chat.daemonSource", { provider: loaded.conversation.provider }), loaded.conversation.model ?? "", t);
    refreshSessionList();
    syncCrumb();
    scrollToEnd();
  };
  const daemonErrorText = (e: unknown): string => {
    if (!(e instanceof DaemonError)) return t("chat.daemonFailed", { detail: redactSummary(String(e instanceof Error ? e.message : e)) });
    switch (e.code) {
      case "busy": return t("chat.daemonBusy");
      case "missing-key": return t("chat.daemonMissingKey", { detail: redactSummary(e.message) });
      case "model-required": return t("chat.daemonModelRequired");
      case "budget": return t("chat.daemonBudget", { detail: redactSummary(e.message) });
      case "not-running": return t("chat.daemonOffline");
      default: return t("chat.daemonFailed", { detail: redactSummary(e.message) });
    }
  };

  // Replays a stored transcript as plain lines — deliberately NOT the rich
  // cascade/compare cards (their payloads aren't persisted; see sessions.ts).
  // All text lands via el()/textContent, never markup.
  const loadSession = (id: string) => {
    const s = sessionStore.get(id);
    if (!s) return;
    chatMotionVersion += 1;
    clearCompareOperation();
    dispatching = false;
    sendBtn.disabled = false;
    setChatMotion("idle", t("app.tagline"));
    for (const row of thinkingMotions.keys()) removeThinking(row);
    activeSession = s;
    activeDaemonConv = null;
    scroll.replaceChildren();
    for (const e of s.entries) {
      if (e.role === "user") scroll.append(el("div", "msg-user", e.text));
      else if (e.role === "assistant") renderPlainAnswer(scroll, e.text, t);
      else renderErrorCard(scroll, e.text); // kayıtlı geçmiş: isteği artık bu oturumun işi değil, yeniden dene yok
    }
    refreshSessionList();
    syncCrumb();
    scrollToEnd();
  };

  const startNewSession = () => {
    stopDispatch();
    clearCompareOperation();
    dispatching = false;
    sendBtn.disabled = false;
    setChatMotion("idle", t("app.tagline"));
    for (const row of thinkingMotions.keys()) removeThinking(row);
    activeSession = null; // created lazily on first send, so empty chats don't pile up
    activeDaemonConv = null; // likewise created by the daemon on first send
    scroll.replaceChildren();
    inspectorBody.replaceChildren(el("div", "inspector-empty", t("inspector.empty")));
    refreshSessionList();
    syncCrumb();
    ta.focus();
  };
  newChatBtn.addEventListener("click", startNewSession);

  // In-flight guard for run(). The local path is accidentally safe (the
  // textarea is cleared first) but a remote steer SETS the textarea, so
  // without this a burst of relay frames would dispatch concurrently.
  let dispatching = false;
  /** Set by onSteer for exactly one dispatch, so the audit line names the origin. */
  let nextDispatchRemote = false;

  /**
   * Hata kartının "Yeniden dene"si: kartın KENDİ isteğini ve hata anındaki modu yeniden çalıştırır.
   * Yazma kutusundaki taslağa dokunmaz, kullanıcı mesajını çoğaltmaz. Başka bir tur sürerken
   * false döner (kart yerinde kalır).
   */
  const retryLast = (text: string, retryMode: Mode): boolean => {
    if (dispatching || workspaceDisposed || !text) return false;
    // run() ön denetimlerde (boş şirket, model/çevrimdışı hatası) dağıtıma geçmeden çıkabilir;
    // dağıtım başlayınca dispatching eşzamanlı olarak true olur, kart yalnız o zaman silinir.
    void run({ text, mode: retryMode });
    return dispatching as boolean;
  };
  // Hedef kart oluşturulurken bir kez seçilir: etiket ve tıklama hiçbir zaman ayrışmaz.
  const seeDetails = {
    target: (): "changes" | "detail" => (changesPathInput.value.trim() ? "changes" : "detail"),
    label: (target: "changes" | "detail") => t(target === "changes" ? "chat.seeChanges" : "chat.seeDetails"),
    open: (target: "changes" | "detail") => { showTab(target); },
  };

  const record = (role: SessionRole, text: string, entryMode: Mode = mode) => {
    if (workspaceDisposed || !text) return;
    if (!activeSession) activeSession = sessionStore.create();
    const before = activeSession.title;
    activeSession =
      sessionStore.append(activeSession.id, { role, mode: entryMode, text, at: Date.now() }) ?? activeSession;
    if (activeSession.title !== before) syncCrumb();
    refreshSessionList();
    updateStorageNotice();
  };

  const refreshSavings = async () => {
    if (workspaceDisposed) return;
    const owner = captureSession(cfg);
    const current = () => !workspaceDisposed && isCurrentSession(cfg, owner);
    try {
      const raw = await savingsCall(cfg, { days: 30 });
      if (!current()) return;
      const v = toSavingsView(raw);
      if (v.hasSavings) {
        savingsAmount.textContent = formatUsd(v.savedUsd);
        savingsSub.textContent = t("rail.savingsWindow", { days: 30 });
      } else {
        savingsAmount.textContent = "—";
        savingsSub.textContent = t("rail.noSavings");
      }
    } catch {
      if (!current()) return;
      savingsAmount.textContent = "—";
      savingsSub.textContent = t("rail.noSavings");
    }
  };

  /**
   * One daemon turn. Governed as `local.dispatch` (auto-allow, audited): the
   * desktop's own action is a loopback call to a local process and it never
   * handles a provider key; the ledger summary names the model so the record is
   * truthful about where the turn went. The daemon stores both messages.
   */
  const runDaemonTurn = async (
    text: string,
    ownsRun: () => boolean,
    thinkingRow: (label: string) => HTMLElement,
    setRunMotion: (state: MotionState, label: string) => void,
    showAnswerMotion: (answer: string) => void,
    onAnswer?: (answer: string) => void,
  ) => {
    const fail = (message: string, retryable = true) => {
      setRunMotion("error", message);
      renderErrorCard(scroll, message, retryable ? () => retryLast(text, "daemon") : undefined);
    };
    if (!daemon || !daemonOnline) {
      fail(t("chat.daemonOffline"));
      void connectDaemon(true);
      return;
    }
    const choice = readDaemonModel();
    if ("error" in choice) { fail(choice.error); return; }
    const modelLabel = `${choice.provider}/${choice.model}`;
    const detail: ActionDetail = { summary: t("gov.kindDaemonDispatch", { model: modelLabel }) };
    const gate = await gateAction(deps, "local.dispatch", detail);
    if (!ownsRun()) return;
    if (!gate.ok) { fail(gate.reason, false); return; } // onay/politika reddi: yeniden dene yok
    const thinking = thinkingRow(t("chat.daemonThinking", { model: modelLabel }));
    scroll.append(thinking);
    scrollToEnd();
    const card = el("div", "msg-final");
    card.append(el("div", "msg-label", t("chat.finalAnswer")));
    const body = document.createTextNode("");
    card.append(body);
    const speak = speakButton(t, () => body.textContent ?? "");
    if (speak) card.append(speak);
    let cardShown = false;
    const showCard = (full: string) => {
      if (!cardShown) { removeThinking(thinking); scroll.append(card); cardShown = true; }
      body.textContent = full;
      scrollToEnd();
    };
    let conversationId: string | null = null;
    try {
      let conversation = activeDaemonConv;
      if (!conversation) {
        conversation = await daemon.createConversation({ title: deriveTitle(text) || undefined, provider: choice.provider, model: choice.model });
      } else if (conversation.provider !== choice.provider || conversation.model !== choice.model) {
        conversation = await daemon.updateConversation(conversation.id, { provider: choice.provider, model: choice.model });
      }
      if (!ownsRun()) return;
      activeDaemonConv = conversation;
      conversationId = conversation.id;
      syncCrumb();
      daemonTurn = { conversationId };
      cancelBtn.textContent = t("chat.stop");
      cancelBtn.disabled = false;
      cancelBtn.style.display = "";
      const result = await daemon.sendMessage(conversationId, text, {
        onDelta: (_chunk, full) => { if (ownsRun()) showCard(full); },
      });
      if (!ownsRun()) return;
      removeThinking(thinking);
      if (result.text) showCard(result.text);
      renderSourceInspector(inspectorBody, t("chat.daemonSource", { provider: choice.provider }), choice.model, t);
      if (result.usage) inspectorBody.append(kv(t("chat.daemonTokens"), t("chat.daemonUsage", { input: result.usage.inputTokens, output: result.usage.outputTokens })));
      if (result.error) {
        fail(daemonErrorText(result.error));
        await deps.gov.settle("local.dispatch", "error", detail);
      } else if (result.stopReason === "aborted") {
        setRunMotion("idle", t("chat.daemonStopped"));
        await deps.gov.settle("local.dispatch", "error", detail);
      } else {
        if (!cardShown) renderPlainAnswer(scroll, "", t);
        showAnswerMotion(result.text);
        if (result.text) onAnswer?.(result.text); // daemon turns are stored by the daemon, so this is their only voice hook
        if (result.text) renderStatusCard(scroll, t, `${choice.provider}/${choice.model}`, seeDetails);
        await deps.gov.settle("local.dispatch", "success", detail);
      }
    } catch (e) {
      if (!ownsRun()) return;
      removeThinking(thinking);
      fail(daemonErrorText(e));
      if (e instanceof DaemonError && e.code === "not-running") {
        daemonOnline = false;
        historySearch.style.display = "none";
        searchBtn.disabled = true;
        updateStorageNotice();
      }
      await deps.gov.settle("local.dispatch", "error", detail);
    } finally {
      if (conversationId && daemonTurn?.conversationId === conversationId) daemonTurn = null;
      cancelBtn.disabled = false;
      void refreshDaemonConversations();
    }
  };

  const run = async (retry?: { text: string; mode: Mode }, voiceTurn?: { text: string; token: number }) => {
    if (workspaceDisposed || dispatching) return;
    const runMode = retry?.mode ?? mode;
    const text = retry?.text ?? voiceTurn?.text ?? ta.value.trim();
    if (!text) {
      // A file alone is not a message: say so instead of doing nothing.
      if (attachTray?.items().length) { hint.textContent = t("attach.needText"); hint.style.display = "block"; }
      return;
    }
    if (runMode === "compare" && !companyInput.value.trim()) {
      hint.textContent = t("chat.companyNeeded");
      hint.style.display = "block";
      return;
    }
    if (runMode === "daemon") {
      // Like compare's checks: block an unready daemon lane before governance
      // or clearing the draft, and say how to fix it.
      const choice = daemonOnline ? readDaemonModel() : { error: t("chat.daemonOffline") };
      if ("error" in choice) {
        showDaemonHint(choice.error);
        if (!daemonOnline) void connectDaemon(true);
        return;
      }
    }
    const runCompanyId = companyInput.value.trim();
    let runSelections: ModelSelection[] | undefined;
    if (runMode === "compare") {
      try { runSelections = compareControls.read(runCompanyId); }
      catch (error) {
        hint.textContent = error instanceof Error ? error.message : t("chat.modelsNeeded");
        hint.style.display = "block";
        return;
      }
    }
    // BRA-UI-09: only a typed send carries the pending attachments (a voice turn or a retry never does). The tray is
    // emptied after the checks below, so a refused send keeps the files. The size is measured as it goes on the wire.
    const pendingFiles = retry || voiceTurn ? [] : attachTray?.items() ?? [];
    const wire = retry ? text : composeWire(text, pendingFiles);
    if (pendingFiles.length && wireExceeds(wire, runMode === "daemon")) {
      hint.textContent = t("attach.errWireTooBig");
      hint.style.display = "block";
      return;
    }
    const owner = captureSession(cfg);
    dispatchController?.abort();
    const controller = new AbortController();
    dispatchController = controller;
    const motionVersion = ++chatMotionVersion;
    const ownsRun = () => !workspaceDisposed && isCurrentSession(cfg, owner) && motionVersion === chatMotionVersion;
    // Voice chat: only the turn that still owns the token may answer or end the strip.
    const voiceLive = () => voiceTurn !== undefined && voiceTurn.token === voiceCurrent;
    const voiceAnswer = (answer: string) => {
      if (voiceLive() && ownsRun()) { voiceCurrent = 0; voiceChat?.reply(answer); }
    };
    const recordRun = (role: SessionRole, text: string) => {
      if (role === "assistant") voiceAnswer(text);
      if (ownsRun()) record(role, text, runMode);
    };
    hint.style.display = "none";
    dispatching = true;
    sendBtn.disabled = true;
    if (!retry && !voiceTurn) ta.value = "";
    // The chat shows/stores `text`; only the request carries the files.
    const sentFiles = pendingFiles.length ? attachTray?.take() ?? [] : [];
    const ownsMotion = ownsRun;
    const setRunMotion = (state: MotionState, label: string) => {
      if (ownsMotion()) setChatMotion(state, label);
    };
    setRunMotion("idle", t("app.tagline"));
    const showAnswerMotion = (answer: string) => {
      const state = answerMotion(answer);
      setRunMotion(state, t(state === "success" ? "chat.finalAnswer" : "chat.empty"));
    };
    const runThinkingRows: HTMLElement[] = [];
    const thinkingRow = (label: string | Text, state: MotionState = "thinking") => {
      const row = el("div", "thinking");
      const coin = createOwnedBrandMotion(ownsMotion, { kind: "coin", state });
      if (coin) {
        trackMotion(coin);
        coin.setVisible(surface === "chat");
        thinkingMotions.set(row, coin);
        row.append(coin.element);
      }
      runThinkingRows.push(row);
      row.append(typeof label === "string" ? document.createTextNode(label) : label);
      setRunMotion(state, typeof label === "string" ? label : label.textContent ?? "");
      return row;
    };

    if (!retry) {
      scroll.append(el("div", "msg-user", text));
      if (sentFiles.length) scroll.append(renderSentChips(sentFiles, t, getLocale()));
    }
    scrollToEnd();

    try {
      // Inside the try: a storage failure here must not strand sendBtn
      // disabled with the user's text already cleared.
      if (runMode !== "daemon" && !retry) recordRun("user", text); // daemon turns are stored by the daemon
      const origin = nextDispatchRemote ? "companion" : "local";
      nextDispatchRemote = false;

      if (runMode === "cascade" || runMode === "compare") {
        // Governed (auto-allow) so the ledger has evidence of every server-lane
        // dispatch — including one a companion steer initiated while nobody was
        // at the desk. See ACTION_KINDS "server.dispatch" in governance.ts.
        const serverDetail: ActionDetail = {
          summary: t("gov.kindServerDispatch", { mode: runMode, origin }),
        };
        const gate = await gateAction(deps, "server.dispatch", serverDetail);
        if (!ownsRun()) return;
        if (!gate.ok) {
          setRunMotion("error", gate.reason);
          renderErrorCard(scroll, gate.reason); // onay/politika reddi: yeniden denemek anlamsız (kurucu kararı gerekir)
          recordRun("error", gate.reason);
          bumpActivity();
          return;
        }
      }

      if (runMode === "cascade") {
        const thinking = thinkingRow(t("chat.thinking", { n: 1 }));
        scroll.append(thinking);
        scrollToEnd();
        const raw = await cascade(cfg, { prompt: wire }, { signal: controller.signal });
        if (!ownsRun()) return;
        removeThinking(thinking);
        const view = toCascadeView(raw);
        showAnswerMotion(view.answer);
        renderCascadeAnswer(scroll, view, t);
        if (view.answer) renderStatusCard(scroll, t, view.totalCostUsd ? `${view.provider} · ${view.model}` : "", seeDetails);
        renderCascadeInspector(inspectorBody, view, t);
        recordRun("assistant", view.answer);
        await deps.gov.settle("server.dispatch", "success", {
          summary: t("gov.kindServerDispatch", { mode: runMode, origin }),
        });
      } else if (runMode === "local") {
        // Lane-A local — governed (auto-allow), keyless, offline. Even an
        // auto-allowed action is audited so the ledger is a complete record.
        const localDetail: ActionDetail = { summary: t("gov.kindLocalDispatch") };
        const gate = await gateAction(deps, "local.dispatch", localDetail);
        if (!ownsRun()) return;
        if (!gate.ok) {
          setRunMotion("error", gate.reason);
          renderErrorCard(scroll, gate.reason);
          recordRun("error", gate.reason);
        } else {
          const host = resolveOllamaHost();
          const thinking = thinkingRow(t("chat.localThinking"));
          scroll.append(thinking);
          scrollToEnd();
          try {
            const model = await resolveOllamaModel(host, localModelInput.value.trim() || undefined, { signal: controller.signal });
            if (!ownsRun()) return;
            const res = await ollamaChat(host, model, wire, { signal: controller.signal });
            if (!ownsRun()) return;
            removeThinking(thinking);
            showAnswerMotion(res.content);
            renderPlainAnswer(scroll, res.content, t);
            renderStatusCard(scroll, t, res.model ?? "", seeDetails);
            renderSourceInspector(inspectorBody, t("chat.localSource"), res.model, t);
            recordRun("assistant", res.content);
            await deps.gov.settle("local.dispatch", "success", localDetail);
          } catch (e) {
            if (!ownsRun()) return;
            removeThinking(thinking);
            setRunMotion("error", e instanceof OllamaUnreachableError
              ? t("chat.localUnreachable", { host: e.host }) : String(e instanceof Error ? e.message : e));
            if (e instanceof OllamaUnreachableError) {
              renderErrorCard(scroll, t("chat.localUnreachable", { host: e.host }), () => retryLast(wire, runMode));
              recordRun("error", t("chat.localUnreachable", { host: e.host }));
            } else {
              renderErrorCard(scroll, String(e instanceof Error ? e.message : e), () => retryLast(wire, runMode));
              recordRun("error", String(e instanceof Error ? e.message : e));
            }
            await deps.gov.settle("local.dispatch", "error", localDetail);
          }
        }
        if (ownsRun()) bumpActivity();
      } else if (runMode === "direct") {
        // Lane-A direct — BYOK egress. GOVERNED: a human must approve before the
        // key leaves the box (the moat vs an allow-all host). The raw key is
        // fetched one-time only AFTER approval, and never reaches the DOM/audit.
        const providerRaw = directProviderSel.value;
        if (!isDirectProvider(providerRaw)) {
          setRunMotion("error", t("chat.empty"));
          renderErrorCard(scroll, t("chat.empty"));
          recordRun("error", t("chat.empty"));
        } else {
          const provider: DirectProvider = providerRaw;
          const directDetail: ActionDetail = { provider, summary: t("gov.kindDirectDispatch", { provider }) };
          // gateForToken (not gateAction): keep the one-time token UNCONSUMED so
          // the HOST spends it at key_get — the raw key is only released when the
          // host verifies this exact governance grant (R4). A webview that skips
          // the gate has no token, so key_get rejects it.
          const gate = await gateForToken(deps, "direct.dispatch", directDetail);
          if (!ownsRun()) return;
          if (!gate.ok) {
            setRunMotion("error", gate.reason);
            renderErrorCard(scroll, gate.reason);
            recordRun("error", gate.reason);
          } else {
            // One-time raw key retrieval at dispatch — never rendered to the DOM.
            // The host consumes gate.token inside key_get before returning it.
            const apiKey = await deps.vault.get(provider, gate.token);
            if (!ownsRun()) return;
            if (!apiKey) {
              setRunMotion("error", t("chat.noKey", { provider }));
              renderErrorCard(scroll, t("chat.noKey", { provider })); // anahtar eksik: önce Ayarlar, yeniden dene değil
              recordRun("error", t("chat.noKey", { provider }));
              await deps.gov.settle("direct.dispatch", "error", directDetail);
            } else {
              const model = resolveDirectModel(provider, directModelInput.value.trim() || undefined);
              const thinking = thinkingRow(t("chat.directThinking", { provider }));
              scroll.append(thinking);
              scrollToEnd();
              try {
                const res = await directChat(provider, apiKey, model, wire, { signal: controller.signal });
                if (!ownsRun()) return;
                removeThinking(thinking);
                showAnswerMotion(res.content);
                renderPlainAnswer(scroll, res.content, t);
                renderStatusCard(scroll, t, res.model ?? "", seeDetails);
                renderSourceInspector(inspectorBody, t("chat.directSource", { provider }), res.model, t);
                recordRun("assistant", res.content);
                await deps.gov.settle("direct.dispatch", "success", directDetail);
              } catch (e) {
                if (!ownsRun()) return;
                removeThinking(thinking);
                const msg = e instanceof DirectApiError ? `${e.status} · ${e.message}` : String(e instanceof Error ? e.message : e);
                setRunMotion("error", msg);
                renderErrorCard(scroll, msg, () => retryLast(wire, runMode));
                recordRun("error", msg);
                await deps.gov.settle("direct.dispatch", "error", directDetail);
              }
            }
          }
        }
        if (ownsRun()) bumpActivity();
      } else if (runMode === "daemon") {
        await runDaemonTurn(wire, ownsRun, thinkingRow, setRunMotion, showAnswerMotion, voiceAnswer);
        if (ownsRun()) bumpActivity();
      } else {
        const stub = await startCompare(cfg, { companyId: runCompanyId, query: wire,
          ...(runSelections !== undefined ? { selections: runSelections } : {}) }, { signal: controller.signal });
        if (!ownsRun()) return;
        let finishCancellation!: (result: { status: "CANCELLED"; error: string }) => void;
        const cancelled = new Promise<{ status: "CANCELLED"; error: string }>(resolve => { finishCancellation = resolve; });
        let cancelling = false;
        const operation = {
          controller,
          cancel: async () => {
            const current = () => ownsRun() && compareOperation === operation;
            if (!current() || cancelling) return;
            hint.textContent = "";
            hint.style.display = "none";
            cancelling = true;
            cancelBtn.disabled = true;
            cancelBtn.textContent = t("chat.cancelling");
            try {
              const result = await cancelCompare(cfg, stub.id, { save: deps.persist, signal: controller.signal });
              if (!current()) return;
              if (result.status === "CANCELLED") {
                finishCancellation({ status: "CANCELLED", error: t("chat.cancelled") });
              } else {
                // Completion can race the cancel request. Poll the real result
                // and preserve its findings instead of reporting cancellation.
                hint.textContent = t("chat.cancelTooLate");
                hint.style.display = "block";
              }
            } catch {
              if (!current()) return;
              hint.textContent = t("chat.cancelFailed");
              hint.style.display = "block";
              cancelling = false;
              cancelBtn.disabled = false;
            } finally {
              if (current()) cancelBtn.textContent = t("chat.cancel");
            }
          },
        };
        compareOperation = operation;
        cancelBtn.disabled = false;
        cancelBtn.textContent = t("chat.cancel");
        cancelBtn.style.display = "";
        const progressLabel = (status: string) => status === "RUNNING"
          ? runSelections ? t("chat.thinking", { n: runSelections.length }) : t("chat.modelsWorking") : t("chat.polling", { status });
        const label = document.createTextNode(progressLabel(stub.status));
        const thinking = thinkingRow(label, compareProgressMotion(stub.status));
        scroll.append(thinking);
        scrollToEnd();
        const session = await Promise.race([pollCompare(cfg, stub.id, {
          signal: controller.signal,
          isCurrent: ownsRun,
          onTick: (status) => {
            if (!ownsRun()) return;
            const progressMotion = compareProgressMotion(status);
            label.textContent = progressLabel(status);
            thinkingMotions.get(thinking)?.setState(progressMotion);
            setRunMotion(progressMotion, label.textContent);
          },
        }), cancelled]);
        if (!ownsRun()) return;
        clearCompareOperation();
        removeThinking(thinking);
        // Polling may observe cancellation before the POST acknowledgement.
        // Both terminal paths must explain its soft-cancel/cost semantics.
        const view = toCompareView(session?.status === "CANCELLED"
          ? { ...session, error: t("chat.cancelled") } : session);
        const resultMotion = compareMotion(view);
        setRunMotion(resultMotion, resultMotion === "success" ? t("chat.finalAnswer")
          : resultMotion === "error" ? view.error || t("chat.empty") : t("app.tagline"));
        renderCompareAnswer(scroll, view, t);
        if (view.hasResult && view.status === "COMPLETED") renderStatusCard(scroll, t, "", seeDetails);
        renderCompareInspector(inspectorBody, view, t);
        const succeeded = resultMotion === "success";
        recordRun(succeeded ? "assistant" : "error", succeeded
          ? view.finalAnswer || view.synthesis
          : view.error || view.status || t("chat.empty"));
        await deps.gov.settle("server.dispatch", succeeded ? "success" : "error", {
          summary: t("gov.kindServerDispatch", { mode: runMode, origin }),
        });
      }
      if (ownsRun()) void refreshSavings();
    } catch (e) {
      if (!ownsRun()) return;
      const msg = redactSummary(e instanceof ApiError ? `${e.status} · ${e.message}` : String(e));
      setRunMotion("error", msg);
      recordRun("error", msg);
      renderErrorCard(scroll, msg, () => retryLast(wire, runMode));
    } finally {
      // Voice chat: a turn that ended without an answer (error card, cancel) goes back to listening.
      if (voiceLive()) { voiceCurrent = 0; voiceChat?.turnEnded(); }
      for (const row of runThinkingRows) removeThinking(row);
      if (ownsRun()) {
        clearCompareOperation();
        dispatching = false;
        sendBtn.disabled = false;
        scrollToEnd();
        voiceChat?.laneFree(); // a sentence heard while this reply ran goes out now
      }
    }
  };

  sendBtn.addEventListener("click", () => void run());
  ta.addEventListener("keydown", (e) => {
    // Design v3: Enter sends, Shift+Enter inserts a newline (Cmd/Ctrl+Enter
    // kept for muscle memory from the previous build).
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void run();
    }
  });
  // Thin wiring only — the revoke-then-clear logic + its ordering/gate
  // invariants live in the unit-tested performSignOut (session.ts), which is
  // where the C3/#1 regression is guarded.
  signOutBtn.addEventListener("click", () => performSignOut(cfg, deps));

  // --- çevrimdışı bandı (D30): tarayıcının ağ olayları; sahte durum yok ---
  const offlineBanner = el("div", "offline-banner");
  offlineBanner.setAttribute("role", "status");
  offlineBanner.append(el("span", "offline-glyph", "■"), el("b", undefined, t("offline.title")), el("span", undefined, t("offline.sub")));
  offlineBanner.hidden = typeof navigator === "undefined" || navigator.onLine !== false;
  win.prepend(offlineBanner);
  // Tek duyuru kanalı: bant. Çevrimiçi olunca bant "geri geldi" der ve kısa süre sonra kapanır.
  const offlineTitle = offlineBanner.querySelector("b") as HTMLElement;
  const offlineSub = offlineBanner.lastElementChild as HTMLElement;
  let backTimer: ReturnType<typeof setTimeout> | undefined;
  const onOffline = () => {
    clearTimeout(backTimer);
    offlineTitle.textContent = t("offline.title"); offlineSub.textContent = t("offline.sub"); offlineBanner.classList.remove("back"); offlineBanner.hidden = false;
  };
  const onOnline = () => {
    offlineTitle.textContent = t("offline.back"); offlineSub.textContent = ""; offlineBanner.classList.add("back");
    clearTimeout(backTimer); backTimer = setTimeout(() => { offlineBanner.hidden = true; offlineBanner.classList.remove("back"); }, 4000);
  };
  window.addEventListener("offline", onOffline);
  window.addEventListener("online", onOnline);

  // --- komut paleti ⌘K / Ctrl+K (D6): küçük, klavye gezinmeli, role=dialog + odak tuzağı ---
  const paletteCommands = (): PaletteCommand[] => [
    { id: "new", label: t("rail.newChat"), run: () => { applySurface("chat"); startNewSession(); } },
    { id: "settings", label: t("titlebar.settings"), run: () => setSettings(true) },
    { id: "chat", label: t("surface.chat"), run: () => applySurface("chat") },
    { id: "company", label: t("surface.company"), run: () => applySurface("company") },
    { id: "code", label: t("surface.code"), run: () => applySurface("code") },
    { id: "theme", label: t("palette.toggleTheme"), run: () => {
      const th = resolveTheme(); const next = th.choice() === "dark" ? "light" : "dark";
      if (!th.set(next)) notify(t, "error", t("settings.preferenceUnsaved"));
    } },
  ];
  let paintPalette: () => void = () => {};
  // Açık onay/kill modalı (.approve-overlay), ayarlar ya da palet varken palet açılmaz:
  // bekleyen onay varken arkadaki "Yeni sohbet" çalıştırılamaz.
  const palette = createPaletteController({
    commands: paletteCommands,
    blocked: () => paletteBlocked({ paletteOpen: false, settingsOpen, modalOpen: !!document.querySelector(".approve-overlay") }),
    onChange: () => paintPalette(),
  });
  const openPalette = () => {
    if (!palette.open()) return;
    const pBackdrop = el("div", "pal-backdrop");
    const paletteCard = el("div", "pal-card");
    paletteCard.setAttribute("aria-label", t("palette.title"));
    const input = el("input", "pal-input") as HTMLInputElement;
    input.type = "text"; input.placeholder = t("palette.placeholder");
    input.setAttribute("role", "combobox"); input.setAttribute("aria-expanded", "true"); input.setAttribute("aria-controls", "pal-list"); input.setAttribute("aria-label", t("palette.title"));
    const list = el("div", "pal-list"); list.id = "pal-list"; list.setAttribute("role", "listbox");
    const empty = el("div", "pal-empty", t("palette.empty")); empty.setAttribute("role", "status");
    let release: (() => void) | undefined;
    const teardown = () => { paintPalette = () => {}; release?.(); release = undefined; pBackdrop.remove(); };
    paintPalette = () => {
      if (!palette.isOpen()) { teardown(); return; }
      const shown = palette.shown(), active = palette.active();
      list.replaceChildren();
      shown.forEach((c, i) => {
        const row = el("div", `pal-row${i === active ? " active" : ""}`);
        row.id = `pal-opt-${c.id}`; row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(i === active));
        row.append(el("span", undefined, c.label));
        row.addEventListener("click", () => palette.choose(i));
        row.addEventListener("mousemove", () => palette.setActive(i));
        list.append(row);
      });
      empty.hidden = shown.length > 0;
      if (shown[active]) input.setAttribute("aria-activedescendant", `pal-opt-${shown[active].id}`); else input.removeAttribute("aria-activedescendant");
    };
    input.addEventListener("input", () => palette.setQuery(input.value));
    input.addEventListener("keydown", (e) => { if (palette.key(e)) e.preventDefault(); });
    pBackdrop.addEventListener("click", (e) => { if (e.target === pBackdrop) palette.close(); });
    paletteCard.append(input, list, empty); pBackdrop.append(paletteCard); root.append(pBackdrop);
    release = containDialog(paletteCard, () => palette.close());
    paintPalette(); input.focus();
  };
  const onPaletteKey = (e: KeyboardEvent) => { if (isPaletteShortcut(e)) { e.preventDefault(); openPalette(); } };
  window.addEventListener("keydown", onPaletteKey);

  // Everything this render owns beyond the DOM: the companion bridge + the
  // governance decorator installed with it, and the window key listener.
  disposeWorkspace = () => {
    stopDispatch();
    if (activeDispatchStopper === stopDispatch) activeDispatchStopper = null;
    void deps.gov.invalidate().catch(() => {});
    workspaceDisposed = true;
    update?.dispose();
    setupUi?.dispose();
    voiceChat?.dismiss();
    attachUi?.dispose();
    attachTray?.take();
    globalThis.removeEventListener?.("bv:open-settings", onOpenSettings);
    companyPanel?.unmount();
    companyPanel = null;
    clearCompareOperation();
    for (const motion of motions) motion.dispose();
    motions.clear();
    thinkingMotions.clear();
    window.removeEventListener("keydown", onWorkspaceKey);
    window.removeEventListener("keydown", onPaletteKey);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("online", onOnline);
    clearTimeout(backTimer);
    window.removeEventListener("click", onNowOutside);
    clearTimeout(searchTimer);
    if (compBridge || startingCompanion) void stopCompanion();
    else deps.gov = baseGov;
  };

  void refreshSavings();
  updateStorageNotice();
  refreshSessionList();
  void connectDaemon();
}

// ── answer renderers (center) ───────────────────────────────────────────────
function renderCascadeAnswer(scroll: HTMLElement, v: CascadeView, t: Translator): void {
  const card = el("div", "msg-final");
  card.append(el("div", "msg-label", t("chat.finalAnswer")));
  card.append(document.createTextNode(v.answer || t("chat.empty")));
  scroll.append(card);
  if (v.totalCostUsd !== null && v.totalCostUsd > 0) {
    scroll.append(el("div", "saved-footer", `${v.provider} · ${v.model} · ${formatUsd(v.totalCostUsd)}`));
  }
}

function renderCompareAnswer(scroll: HTMLElement, v: CompareView, t: Translator): void {
  if (!v.hasResult) {
    const card = el("div", "msg-final is-error");
    card.append(el("div", "msg-label", v.status), document.createTextNode(v.error || t("chat.empty")));
    scroll.append(card);
    return;
  }
  // per-model arc-rim cards
  const grid = el("div", "model-grid");
  for (const m of v.perModel) {
    const cardEl = el("div", "model-card");
    const head = el("div", "model-head");
    head.append(el("span", "model-name", `${m.provider}/${m.model}`), el("span", "model-cost", `${formatUsd(m.costUsd)}`));
    cardEl.append(head, el("div", "model-answer", m.answer));
    grid.append(cardEl);
  }
  for (const f of v.failed) {
    const cardEl = el("div", "model-card failed");
    const head = el("div", "model-head");
    head.append(el("span", "model-name", `${f.provider}/${f.model}`));
    cardEl.append(head, el("div", "model-answer", f.error));
    grid.append(cardEl);
  }
  scroll.append(grid);

  if (v.status !== "COMPLETED") {
    const card = el("div", "msg-final is-error");
    card.append(el("div", "msg-label", v.status), document.createTextNode(v.error || t("chat.empty")));
    scroll.append(card);
    return;
  }

  const finalCard = el("div", "msg-final");
  finalCard.append(el("div", "msg-label", t("chat.finalAnswer")));
  finalCard.append(document.createTextNode(v.finalAnswer || t("chat.empty")));
  const speakFinal = v.finalAnswer ? speakButton(t, () => v.finalAnswer) : null;
  if (speakFinal) finalCard.append(speakFinal);
  if (!v.synthesisParsed) finalCard.append(el("div", "composer-hint", t("chat.unparsed")));
  scroll.append(finalCard);

  if (v.consensus.length) scroll.append(chipBlock(t("chat.consensus"), v.consensus, false));
  if (v.disagreements.length) scroll.append(chipBlock(t("chat.disagreements"), v.disagreements, true));
}

function chipBlock(label: string, items: string[], warn: boolean): HTMLElement {
  const box = el("div", "msg-final");
  box.append(el("div", "msg-label", label));
  const list = el("div", "chip-list");
  for (const it of items) list.append(el("div", warn ? "chip warn" : "chip", it));
  box.append(list);
  return box;
}

/** Plain single-model answer card (Lane-A local / direct). */
function renderPlainAnswer(scroll: HTMLElement, content: string, t: Translator): void {
  const card = el("div", "msg-final");
  card.append(el("div", "msg-label", t("chat.finalAnswer")));
  card.append(document.createTextNode(content || t("chat.empty")));
  const speak = content ? speakButton(t, () => content) : null;
  if (speak) card.append(speak);
  scroll.append(card);
}

/** Hata kartı (■ + sözcük): dürüst başarısızlık; yeniden dene + iptal. Asla uydurma cevap yok. */
function renderErrorCard(scroll: HTMLElement, message: string, onRetry?: () => boolean): void {
  const t = makeT(getLocale());
  const card = el("div", "error-card");
  card.setAttribute("role", "alert");
  const state = el("span", "st-state");
  state.append(icon("stop", 14), el("span", undefined, t("common.error")));
  card.append(state, el("span", "st-text", message));
  const actions = el("div", "st-actions");
  if (onRetry) {
    const retry = el("button", "st-btn primary", t("chat.retry")) as HTMLButtonElement;
    retry.type = "button";
    retry.addEventListener("click", () => { if (onRetry()) card.remove(); });
    actions.append(retry);
  }
  const dismiss = el("button", "st-btn", t("chat.dismiss")) as HTMLButtonElement;
  dismiss.type = "button";
  dismiss.addEventListener("click", () => card.remove());
  actions.append(dismiss);
  card.append(actions);
  scroll.append(card);
}

/** Tek durum kartı: sohbette yalnız bu; ayrıntı sağ panelde (ilke 4). */
function renderStatusCard(scroll: HTMLElement, t: Translator, detail: string, see: { target(): "changes" | "detail"; label(target: "changes" | "detail"): string; open(target: "changes" | "detail"): void }): void {
  const card = el("div", "status-card");
  const state = el("span", "st-state");
  state.append(icon("check", 14), el("span", undefined, t("chat.statusDone")));
  card.append(state);
  if (detail) card.append(el("span", "st-text", detail));
  const target = see.target();
  const seeBtn = el("button", "st-btn", see.label(target)) as HTMLButtonElement;
  seeBtn.type = "button";
  seeBtn.addEventListener("click", () => see.open(target));
  const actions = el("div", "st-actions");
  actions.append(seeBtn);
  card.append(actions);
  scroll.append(card);
}

/** Inspector view for Lane-A: just the source + resolved model (no cost/tier). */
function renderSourceInspector(body: HTMLElement, source: string, model: string, t: Translator): void {
  body.innerHTML = "";
  body.append(
    kv(t("inspector.provider"), source),
    kv(t("inspector.model"), model || "—"),
  );
}

// ── governance (approval gate + audit) ──────────────────────────────────────

/**
 * Drive one side-effecting action through the governance gate. Returns ok only
 * when the action may proceed — auto-allowed, or human-approved — and the
 * one-time token has ALREADY been consumed here, so the caller runs its effect
 * exactly once. A deny (policy) or a reject (human) returns an honest reason and
 * NOTHING runs. This is the single chokepoint the UI funnels effects through.
 */
async function gateAction(
  deps: UiDeps,
  kind: string,
  detail: ActionDetail,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { gov, t } = deps;
  const res = await gov.request(kind, detail);
  if (res.decision === "deny") {
    return { ok: false, reason: t("gov.denied", { reason: res.reason }) };
  }
  let token = res.token;
  if (res.decision === "require-approval") {
    const outcome = await showApprovalModal(deps, res.actionId, detail, res.reason);
    if (!outcome.approved) {
      await gov.reject(res.actionId);
      return { ok: false, reason: t("gov.rejectedByUser") };
    }
    if (outcome.token) {
      // Approved on the companion: the token was minted THERE. Reusing it is
      // what makes a phone approval actually run the action (calling approve()
      // again would throw — the pending record is already spent).
      token = outcome.token;
    } else {
      try {
        const r = await gov.approve(res.actionId);
        token = r.token;
      } catch {
        // First-resolver-wins: something else settled this actionId — the local
        // click loses, fail-closed with an honest message, not a throw.
        return { ok: false, reason: t("gov.resolvedElsewhere") };
      }
    }
  }
  if (!token) return { ok: false, reason: t("gov.rejectedByUser") };
  const consumed = await gov.consume(token, kind, detail);
  // A failed consume (replay/forgery/mismatch) means the effect must NOT run.
  if (!consumed) return { ok: false, reason: t("gov.rejectedByUser") };
  return { ok: true };
}

/**
 * Drive an action through the gate for a HOST-EXECUTED effect (MCP tool call,
 * governed command). Identical to gateAction up to approval, but returns the
 * one-time token UNCONSUMED — the host (Rust) spends it at execution time, so a
 * compromised webview can never run the effect without a real host-side consume.
 * (Contrast gateAction, which consumes here for webview-executed lanes.)
 */
async function gateForToken(
  deps: UiDeps,
  kind: string,
  detail: ActionDetail,
  prepared?: Awaited<ReturnType<Governance["request"]>>,
): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  const { gov, t } = deps;
  const res = prepared ?? await gov.request(kind, detail);
  if (prepared) { try { gov.observePrepared?.(prepared, detail); } catch { /* non-authoritative mirror */ } }
  if (res.decision === "deny") return { ok: false, reason: t("gov.denied", { reason: res.reason }) };
  let token = res.token;
  if (res.decision === "require-approval") {
    const outcome = await showApprovalModal(deps, res.actionId, detail, res.reason);
    if (!outcome.approved) {
      await gov.reject(res.actionId);
      return { ok: false, reason: t("gov.rejectedByUser") };
    }
    if (outcome.token) {
      token = outcome.token; // companion-minted (see gateAction)
    } else {
      try {
        token = (await gov.approve(res.actionId)).token;
      } catch {
        return { ok: false, reason: t("gov.resolvedElsewhere") };
      }
    }
  }
  if (!token) return { ok: false, reason: t("gov.rejectedByUser") };
  return { ok: true, token };
}

/**
 * Arc-rim approval modal with a molten accent — the "coin-flip" moment where the
 * user decides. Blocks on a promise until Approve or Reject. The action summary
 * is the only thing shown; no secret ever reaches this surface.
 */
function showApprovalModal(
  deps: UiDeps,
  actionId: string,
  detail: ActionDetail,
  reason: string,
): Promise<ApprovalOutcome> {
  const { t, root } = deps;
  return new Promise<ApprovalOutcome>((resolve) => {
    const overlay = el("div", "approve-overlay");
    const card = el("div", "approve-card");
    const flip = el("div", "approve-flip");
    const approvalMotion = createBrandMotion({ state: "attention", size: 96 });
    flip.append(approvalMotion.element);
    card.append(flip);
    card.append(el("h2", "approve-title", t("gov.approveTitle")));
    card.append(el("div", "approve-body", t("gov.approveBody")));

    const detailBox = el("div", "approve-detail");
    const actionRow = el("div", "approve-kv");
    actionRow.append(el("span", "approve-k", t("gov.approveAction")), el("span", "approve-v", detail.summary ?? ""));
    const reasonRow = el("div", "approve-kv");
    reasonRow.append(el("span", "approve-k", t("gov.approveReason")), el("span", "approve-v mono", reason));
    detailBox.append(actionRow, reasonRow);
    card.append(detailBox);

    const btns = el("div", "approve-btns");
    const rejectBtn = el("button", "approve-reject", t("gov.rejectBtn"));
    const approveBtn = el("button", "approve-approve", t("gov.approveBtn"));
    btns.append(rejectBtn, approveBtn);
    card.append(btns);

    let releaseFocus: (() => void) | undefined;
    const close = (o: ApprovalOutcome) => {
      releaseFocus?.();
      approvalMotion.dispose();
      openApprovals.delete(actionId);
      overlay.remove();
      resolve(o);
    };
    // Registered so a companion decision (with its already-minted token) or the
    // kill switch can settle this modal without a local click.
    openApprovals.set(actionId, close);
    rejectBtn.addEventListener("click", () => close({ approved: false }));
    approveBtn.addEventListener("click", () => close({ approved: true }));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close({ approved: false }); // click-outside = reject (fail-closed)
    });

    overlay.append(card);
    root.append(overlay);
    card.setAttribute("aria-label", t("gov.approveTitle"));
    releaseFocus = containDialog(card, () => close({ approved: false }));
    rejectBtn.focus();
  });
}

/**
 * Two-step kill switch. Step one is the molten button in Settings; THIS dialog
 * is step two — it lists exactly what will be stopped (honest scope: open
 * approvals, local requests, managed processes and companion) and only acts on the explicit confirm. Afterwards it
 * reports what actually happened instead of claiming "everything".
 */
function showKillDialog(deps: UiDeps): Promise<void> {
  const { t, root } = deps;
  return new Promise<void>((resolve) => {
    const overlay = el("div", "approve-overlay");
    const card = el("div", "approve-card kill-card");
    card.append(el("h2", "approve-title", t("kill.title")));
    card.append(el("div", "approve-body", t("kill.body")));

    const scope = el("div", "kill-scope mono"); scope.setAttribute("role", "status");
    scope.append(
      el("div", undefined, `• ${t("kill.scopeApprovals")}`),
      el("div", undefined, `• ${t("kill.scopeRelay")}`),
      el("div", "kill-scope-note", t("kill.scopeNote")),
    );
    card.append(scope);

    const btns = el("div", "approve-btns");
    const cancelBtn = el("button", "approve-reject", t("kill.cancel"));
    const confirmBtn = el("button", "kill-confirm", t("kill.confirm"));
    btns.append(cancelBtn, confirmBtn);
    card.append(btns);

    let releaseFocus: (() => void) | undefined;
    const close = () => {
      releaseFocus?.();
      overlay.remove();
      resolve();
    };
    cancelBtn.addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    confirmBtn.addEventListener("click", () => {
      confirmBtn.disabled = true;
      void killEverything(deps.gov).then((r) => {
        scope.replaceChildren(
          el("div", undefined, `✓ ${t("kill.doneApprovals", { n: r.approvals })}`),
          el("div", undefined, t(r.native ? "kill.doneNative" : "kill.failedNative")),
          el("div", undefined, t("chat.stopped")),
          el(
            "div",
            undefined,
            r.relay === "stopped"
              ? `✓ ${t("kill.doneRelay")}`
              : r.relay === "failed"
                ? `! ${t("kill.failedRelay")}`
                : `— ${t("kill.doneNoRelay")}`,
          ),
        );
        btns.replaceChildren(cancelBtn);
        cancelBtn.textContent = t("kill.closeBtn");
      });
    });

    overlay.append(card);
    root.append(overlay);
    card.setAttribute("aria-label", t("kill.title"));
    releaseFocus = containDialog(card, close);
    cancelBtn.focus(); // default focus on the SAFE action
  });
}

/** One audit-log row: time · kind · outcome, molten when the outcome is a block. */
function renderAuditRow(e: AuditEntry): HTMLElement {
  const row = el("div", "audit-row");
  const localizedTime = formatTime(e.ts);
  row.append(el("span", "audit-ts mono", localizedTime));
  row.append(el("span", "audit-kind mono", e.kind));
  const blocked = e.outcome === "denied" || e.outcome === "rejected" || e.outcome === "replay-rejected" || e.outcome === "error";
  row.append(el("span", blocked ? "audit-outcome bad" : "audit-outcome", e.outcome));
  return row;
}

/**
 * Left-rail BYOK keys section: masked list + add/remove. Delegates every
 * mutation to the injected vault; a raw key value is NEVER rendered (only the
 * masked fingerprint the vault returns). The secret input is cleared the instant
 * a key is added so it never lingers in the DOM.
 */
function renderKeysSection(deps: UiDeps): HTMLElement {
  const { t, vault } = deps;
  const sec = el("div", "keys-sec");
  sec.append(el("div", "rail-section-label", t("keys.title")));

  const listEl = el("div", "keys-list");
  const emptyEl = el("div", "keys-empty", t("keys.empty"));

  const refresh = async () => {
    listEl.innerHTML = "";
    let entries;
    try { entries = await vault.list(); } catch { listEl.append(el("div", "keys-empty", t("keys.failed"))); return; }
    if (!entries.length) {
      listEl.append(emptyEl);
      return;
    }
    for (const e of entries) {
      const row = el("div", "key-row");
      row.append(
        el("span", "key-provider", e.provider),
        el("span", "key-masked mono", e.masked),
      );
      const rm = el("button", "key-remove", "×");
      rm.title = t("keys.remove"); rm.setAttribute("aria-label", `${t("keys.remove")} · ${e.provider}`);
      rm.addEventListener("click", () => {
        void (async () => {
          try { await vault.remove(e.provider); await refresh(); }
          catch { listEl.append(el("div", "keys-empty", t("keys.failed"))); }
        })();
      });
      row.append(rm);
      listEl.append(row);
    }
  };

  const providerSel = el("select", "key-input") as HTMLSelectElement;
  for (const p of DIRECT_PROVIDERS) {
    const opt = el("option", undefined, p) as HTMLOptionElement;
    opt.value = p;
    providerSel.append(opt);
  }
  const secretInput = el("input", "key-input") as HTMLInputElement;
  secretInput.type = "password";
  secretInput.placeholder = t("keys.secret");
  secretInput.setAttribute("aria-label", t("keys.secret"));
  providerSel.setAttribute("aria-label", t("keys.provider"));
  secretInput.autocomplete = "off";

  const addBtn = el("button", "key-add-btn", t("keys.add"));
  const doAdd = async () => {
    const secret = secretInput.value.trim();
    if (!secret) return;
    addBtn.disabled = true;
    try {
      await vault.add(providerSel.value, secret);
      secretInput.value = ""; // never linger a raw secret in the DOM
      await refresh();
    } catch { listEl.append(el("div", "keys-empty", t("keys.failed"))); } finally {
      secretInput.value = "";
      addBtn.disabled = false;
    }
  };
  addBtn.addEventListener("click", () => void doAdd());
  secretInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void doAdd();
  });

  const addRow = el("div", "key-add-row");
  addRow.append(providerSel, secretInput, addBtn);

  const note = el("div", "keys-note", t("keys.stored"));

  sec.append(listEl, addRow, note);
  void refresh();
  return sec;
}

/**
 * Left-rail Lane-B section: per-vendor "your own CLI" detection. For each vendor
 * it shows installed/version + the steel ToS-risk note. When installed, a "Copy
 * launch command" action reveals the argv (never a shell string) and copies the
 * proven `braavo spawn <vendor>` delegation — the interactive session runs in the
 * user's terminal, never captured here. When absent, it degrades to the honest
 * API-key path (→ Direct). No vendor token/output ever crosses into this UI.
 */
function renderLaneBSection(deps: UiDeps): HTMLElement {
  const { t, spawn } = deps;
  const sec = el("div", "laneb-sec");
  sec.append(el("div", "rail-section-label", t("laneB.title")));
  sec.append(el("div", "laneb-subtitle", t("laneB.subtitle")));

  const listEl = el("div", "laneb-list");
  sec.append(listEl);

  const renderVendor = (status: VendorStatus): HTMLElement => {
    const row = el("div", "laneb-vendor");
    const head = el("div", "laneb-head");
    head.append(el("span", "laneb-name mono", status.vendor));
    const badge = el(
      "span",
      status.installed ? "laneb-badge on" : "laneb-badge off",
      status.installed ? t("laneB.installed") : t("laneB.notInstalled"),
    );
    head.append(badge);
    row.append(head);

    if (status.version) row.append(el("div", "laneb-version mono", status.version));
    // ToS-risk note — plain text, painted steel (rule f).
    row.append(el("div", "laneb-risk", status.risk));

    if (status.installed) {
      const plan = buildLaunchCommand(status.vendor);
      const cmdText = plan.cliDelegation.join(" ");
      const copyBtn = el("button", "laneb-btn", t("laneB.copy"));
      copyBtn.append(el("span", "laneb-gov-badge", t("gov.governedBadge")));
      const cmdBox = el("div", "laneb-cmd mono");
      cmdBox.style.display = "none";
      cmdBox.append(el("div", "laneb-cmd-hint", t("laneB.launchHint")));
      cmdBox.append(ltr(el("code", undefined, cmdText)));
      const gateErr = el("div", "laneb-gate-err");
      gateErr.style.display = "none";
      copyBtn.addEventListener("click", () => {
        void (async () => {
          // Revealing/copying a launch command is a GOVERNED action — a human
          // approves before Braavolabs surfaces a command it could run for you.
          const detail: ActionDetail = {
            vendor: status.vendor,
            summary: t("gov.kindSpawnLaunch", { vendor: status.vendor }),
          };
          const gate = await gateAction(deps, "spawn.launch", detail);
          if (!gate.ok) {
            gateErr.textContent = gate.reason;
            gateErr.style.display = "block";
            await deps.gov.settle("spawn.launch", "error", detail);
            return;
          }
          gateErr.style.display = "none";
          cmdBox.style.display = "block";
          // Best-effort clipboard; the visible command is the reliable fallback.
          void navigator.clipboard?.writeText(cmdText).then(
            () => {
              copyBtn.textContent = t("laneB.copied");
              setTimeout(() => (copyBtn.textContent = t("laneB.copy")), 1600);
            },
            () => {},
          );
          await deps.gov.settle("spawn.launch", "success", detail);
        })();
      });
      row.append(copyBtn, cmdBox, gateErr);
    } else {
      const fb = spawnFallbackMessage(status.vendor);
      const fbBox = el("div", "laneb-fallback");
      fbBox.append(el("div", "laneb-notfound", t("laneB.notFound", { bin: status.vendor })));
      fbBox.append(el("div", "laneb-usekey mono", fb.useApiKey));
      row.append(fbBox);
    }
    return row;
  };

  void (async () => {
    try {
      const statuses = await spawn.probeAll();
      listEl.innerHTML = "";
      for (const s of statuses) listEl.append(renderVendor(s));
    } catch {
      // Detection is best-effort; a probe failure must never break the rail.
      listEl.innerHTML = "";
      for (const vendor of SPAWN_VENDORS) {
        listEl.append(renderVendor({ vendor, installed: false, risk: spawnRiskNote(vendor) }));
      }
    }
  })();

  return sec;
}

/**
 * Left-rail MCP section: register stdio MCP servers (add/list/remove), load a
 * selected server's tools, and call a tool. A tool call is a side effect, so it
 * is funnelled through the governance gate (the moat applied to MCP too): the
 * approval modal must be accepted before Braavolabs will spawn the server and run the
 * tool. The one-time token is NOT consumed in the webview — the host spends it at
 * spawn time (createTauriMcpBridge), so a compromised webview can't run a tool
 * without a real host-side consume. Errors are honest, molten-rimmed — never a
 * green success, never a fabricated result.
 */
function renderMcpSection(deps: UiDeps): HTMLElement {
  const { t, mcp } = deps;
  const sec = el("div", "mcp-sec");
  sec.append(el("div", "rail-section-label", t("mcp.title")));

  const listEl = el("div", "mcp-list");
  const emptyEl = el("div", "mcp-empty", t("mcp.empty"));
  const toolsPanel = el("div", "mcp-tools");
  toolsPanel.style.display = "none";

  const capabilityNote = el("div", "mcp-empty"); sec.append(capabilityNote);
  const checkCapability = async () => {
    try {
      const capability = await mcp.capabilities();
      capabilityNote.textContent = capability.launchEnabled ? "" : t(capability.reasonCode === "MCP_WINDOWS_HOLD" ? "mcp.windowsHold" : capability.reasonCode === "MCP_HOST_REQUIRED" ? "mcp.unreachable" : "mcp.capabilityUnavailable");
      return capability.launchEnabled;
    } catch { capabilityNote.textContent = t("mcp.capabilityUnavailable"); return false; }
  };
  void checkCapability();
  let selected: string | null = null;

  // --- tool-call form for the currently selected server ---
  const showTools = async (server: string, tools: McpTool[]) => {
    toolsPanel.innerHTML = "";
    toolsPanel.style.display = "block";
    toolsPanel.append(el("div", "mcp-tools-head mono", `${server} · ${t("mcp.tools")} (${formatNumber(tools.length)})`));
    if (!tools.length) {
      toolsPanel.append(el("div", "mcp-empty", t("mcp.noTools")));
      return;
    }
    for (const tool of tools) {
      const row = el("div", "mcp-tool-row");
      const head = el("div", "mcp-tool-head");
      head.append(ltr(el("span", "mcp-tool-name mono", tool.name)));
      row.append(head);
      if (typeof tool.description === "string" && tool.description) {
        row.append(el("div", "mcp-tool-desc", tool.description.split("\n")[0]));
      }
      // Per-tool call form: JSON args → gate → call → molten-aware result card.
      const argsTa = el("textarea", "mcp-args") as HTMLTextAreaElement;
      argsTa.placeholder = t("mcp.argsJson");
      argsTa.setAttribute("aria-label", `${tool.name} · ${t("mcp.argsJson")}`);
      argsTa.dir = "ltr";
      const callBtn = el("button", "mcp-call-btn", t("mcp.call"));
      callBtn.append(el("span", "laneb-gov-badge", t("gov.governedBadge")));
      const resultBox = el("div", "mcp-result");
      resultBox.style.display = "none";

      const doCall = async () => {
        if (!await checkCapability()) return;
        const parsed = parseToolArgs(argsTa.value);
        resultBox.style.display = "block";
        resultBox.style.borderLeftColor = "var(--error)";
        if (!parsed.ok) {
          resultBox.innerHTML = "";
          resultBox.append(el("div", "msg-label", t("mcp.errorResult")), document.createTextNode(t("mcp.invalidArgs")));
          return;
        }
        // GATE: a tool call is a side effect — a human approves first.
        const detail: ActionDetail = {
          server,
          tool: tool.name,
          summary: t("gov.kindMcpTool", { tool: tool.name, server }),
        };
        callBtn.disabled = true;
        try {
          const prepared = await mcp.prepareCall(server, tool.name, parsed.value);
          const gate = await gateForToken(deps, "mcp.tool", detail, prepared);
          if (!gate.ok) {
            resultBox.innerHTML = "";
            resultBox.append(el("div", "msg-label", t("mcp.errorResult")), document.createTextNode(gate.reason));
            return;
          }
          const res = await mcp.executeCall(gate.token);
          const view = summarizeCallResult(res);
          resultBox.innerHTML = "";
          resultBox.style.borderLeftColor = resultBorderColor(view.isError);
          resultBox.append(el("div", "msg-label", view.isError ? t("mcp.errorResult") : t("mcp.result")));
          resultBox.append(document.createTextNode(view.text || t("mcp.empty2")));
          await deps.gov.settle("mcp.tool", view.isError ? "error" : "success", detail);
        } catch (e) {
          resultBox.innerHTML = "";
          resultBox.style.borderLeftColor = "var(--error)";
          const msg = e instanceof McpGateError ? t("gov.rejectedByUser") : t("mcp.actionFailed");
          resultBox.append(el("div", "msg-label", t("mcp.errorResult")), document.createTextNode(msg));
          await deps.gov.settle("mcp.tool", "error", detail);
        } finally {
          callBtn.disabled = false;
        }
      };
      callBtn.addEventListener("click", () => void doCall());
      row.append(argsTa, callBtn, resultBox);
      toolsPanel.append(row);
    }
  };

  const loadTools = async (server: string) => {
    if (!await checkCapability()) return;
    selected = server;
    toolsPanel.innerHTML = "";
    toolsPanel.style.display = "block";
    toolsPanel.append(el("div", "mcp-tools-head mono", `${server} · ${t("mcp.loading")}`));
    try {
      // GATE: discovery spawns the server too — a human approves first, bound
      // to the server's CURRENT resolved command+args.
      const cfg = await mcp.listServers();
      const def = cfg[server];
      const detail: ActionDetail = {
        server,
        argv: def ? [def.command, ...def.args] : undefined,
        summary: t("gov.kindMcpDiscover", { server }),
      };
      const gate = await gateForToken(deps, "mcp.discover", detail);
      if (!gate.ok) {
        toolsPanel.innerHTML = "";
        const err = el("div", "mcp-result");
        err.style.borderLeftColor = "var(--error)";
        err.append(el("div", "msg-label", t("mcp.errorResult")), document.createTextNode(gate.reason));
        toolsPanel.append(err);
        return;
      }
      const tools = await mcp.listTools(server, gate.token);
      await showTools(server, tools);
    } catch (e) {
      toolsPanel.innerHTML = "";
      const err = el("div", "mcp-result");
      err.style.borderLeftColor = "var(--error)";
      err.append(el("div", "msg-label", t("mcp.errorResult")), document.createTextNode(t("mcp.actionFailed")));
      toolsPanel.append(err);
    }
  };

  const refresh = async () => {
    listEl.innerHTML = "";
    const cfg = await mcp.listServers();
    const names = Object.keys(cfg);
    if (!names.length) {
      listEl.append(emptyEl);
      toolsPanel.style.display = "none";
      return;
    }
    for (const name of names) {
      const def = cfg[name];
      const row = el("div", "mcp-row");
      const info = el("div", "mcp-row-info");
      info.append(ltr(el("span", "mcp-name mono", name)));
      info.append(ltr(el("span", "mcp-cmd mono", [def.command, ...def.args].join(" "))));
      info.setAttribute("role", "button"); info.tabIndex = 0;
      info.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void loadTools(name); } });
      info.addEventListener("click", () => void loadTools(name));
      const rm = el("button", "key-remove", "×");
      rm.title = t("mcp.remove"); rm.setAttribute("aria-label", `${t("mcp.remove")} · ${name}`);
      rm.addEventListener("click", () => {
        void (async () => {
          await mcp.removeServer(name);
          if (selected === name) {
            selected = null;
            toolsPanel.style.display = "none";
          }
          await refresh();
        })();
      });
      row.append(info, rm);
      listEl.append(row);
    }
  };

  // --- add-server form ---
  const nameInput = el("input", "key-input") as HTMLInputElement;
  nameInput.placeholder = t("mcp.name");
  nameInput.setAttribute("aria-label", t("mcp.name"));
  const cmdInput = el("input", "key-input") as HTMLInputElement;
  cmdInput.dir = "ltr";
  cmdInput.placeholder = t("mcp.command");
  cmdInput.setAttribute("aria-label", t("mcp.command"));
  const argsInput = el("input", "key-input") as HTMLInputElement;
  argsInput.dir = "ltr";
  argsInput.placeholder = t("mcp.args");
  argsInput.setAttribute("aria-label", t("mcp.args"));
  const addBtn = el("button", "key-add-btn", t("mcp.add"));
  const doAdd = async () => {
    const name = nameInput.value.trim();
    const command = cmdInput.value.trim();
    if (!name || !command) return;
    addBtn.disabled = true;
    try {
      await mcp.addServer(name, command, parseArgsInput(argsInput.value));
      nameInput.value = "";
      cmdInput.value = "";
      argsInput.value = "";
      await refresh();
    } finally {
      addBtn.disabled = false;
    }
  };
  addBtn.addEventListener("click", () => void doAdd());
  argsInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void doAdd();
  });

  const addRow = el("div", "mcp-add-row");
  addRow.append(nameInput, cmdInput, argsInput, addBtn);

  sec.append(listEl, toolsPanel, addRow);
  void refresh();
  return sec;
}

// ── inspector renderers (right) ─────────────────────────────────────────────
function kv(k: string, v: string, escalated = false): HTMLElement {
  const row = el("div", "kv");
  row.append(el("span", "k", k), el("span", escalated ? "v escalated" : "v", v));
  return row;
}

function renderCascadeInspector(body: HTMLElement, v: CascadeView, t: Translator): void {
  body.innerHTML = "";
  body.append(
    kv(t("inspector.provider"), v.provider || "—"),
    kv(t("inspector.model"), v.model || "—"),
    kv(t("inspector.tier"), v.tier || "—"),
    kv(t("inspector.confidence"), formatNumber(v.confidence, { maximumFractionDigits: 2 })),
    kv(t("inspector.escalated"), v.escalated === null ? t("common.unknown") : t(v.escalated ? "common.yes" : "common.no"), v.escalated === true),
    kv(t("inspector.cost"), formatUsd(v.totalCostUsd)),
    kv(t("inspector.stoppedReason"), v.stoppedReason || "—"),
  );
  if (v.attempts.length) {
    body.append(el("h2", undefined, t("inspector.attempts")));
    for (const a of v.attempts) {
      const box = el("div", "attempt");
      const top = el("div", "a-top");
      top.append(el("span", undefined, `${a.provider}/${a.model}`), el("span", undefined, formatUsd(a.costUsd)));
      box.append(top, el("div", "a-sub", `${a.tier} · ${t("inspector.confidence")} ${formatNumber(a.confidence, { maximumFractionDigits: 2 })}`));
      body.append(box);
    }
  }
}

function renderCompareInspector(body: HTMLElement, v: CompareView, t: Translator): void {
  body.innerHTML = "";
  if (!v.hasResult) {
    body.append(el("div", "inspector-empty", v.error || v.status));
    return;
  }
  body.append(
    kv(t("chat.perModel"), formatNumber(v.perModel.length)),
    kv(t("chat.failed"), formatNumber(v.failed.length), v.failed.length > 0),
    kv(t("inspector.cost"), formatUsd(v.totalCostUsd)),
    kv(t("chat.synthesis"), v.status !== "COMPLETED" ? v.status : t(v.synthesisParsed ? "chat.parsed" : "chat.raw"), v.status !== "COMPLETED" || !v.synthesisParsed),
  );
}
