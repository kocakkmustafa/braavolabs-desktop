/**
 * DOM shell for the 3-pane obsidian UI. Deliberately thin: every decision that
 * matters (what to render, honesty gates, error mapping) lives in the pure,
 * unit-tested modules (client.ts / render.ts / i18n.ts). This file only wires
 * those outputs into elements and forwards user intent back to the client.
 * Login handlers have source-executing regression tests; real WebView paint,
 * native validity bubbles and keyboard behavior still need native UI checks.
 */
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
  cascade,
  savings as savingsCall,
  listCompanies,
  listScheduledPipelines,
  pauseCompany,
  resumeCompany,
} from "./client";
import { performSignOut } from "./session";
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
import type { Translator } from "./i18n";
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
  groupSessions,
  type ChatSession,
  type SessionRole,
} from "./sessions";
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
 * open approval requests (rejected, fail-closed) and the governed browser
 * connection (host audits the disconnect). PTY/relay sessions are not yet
 * launchable from this UI, so there is nothing of theirs to stop here; the
 * scope grows with those surfaces.
 */
async function killEverything(): Promise<{ approvals: number; relay: "stopped" | "failed" | "inactive" }> {
  const approvals = settleAllApprovals({ approved: false });

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

  return { approvals, relay };
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
  /** Persist secrets after login/refresh/logout. */
  persist: (c: Config) => Promise<void> | void;
  onSignedOut: () => void;
  onSignOutError?: (message: string) => void;
}

/** Dispatch lane: server cascade/compare, local Ollama, or BYOK direct. */
type Mode = "compare" | "cascade" | "local" | "direct";

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
  const sub = el("div", "sub", t("app.tagline"));

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
  apiInput.type = "text";
  apiInput.value = cfg.apiUrl;

  const field = (labelKey: string, input: HTMLInputElement) => {
    const f = el("div", "field");
    const l = el("label", undefined, t(labelKey));
    input.id = labelKey.replaceAll(".", "-");
    l.htmlFor = input.id;
    f.append(l, input);
    return f;
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
    errBox,
    field("login.email", emailInput),
    field("login.password", pwInput),
    field("login.apiUrl", apiInput),
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
  const settingsBtn = el("button", "tb-settings", t("titlebar.settings"));
  titlebar.append(lights, crumb, el("div", "tb-spacer"), settingsBtn);

  // --- left rail ---
  const rail = el("aside", "rail");
  const brand = el("div", "brand");
  brand.append(el("span", "brand-dot"), document.createTextNode(t("app.name")));

  // Surface switch. Chat is the everyday surface; Code is the vendor-CLI
  // (Lane-B) surface — the same panel that used to live inline in the rail.
  const seg = el("div", "seg");
  const segChatBtn = el("button", "seg-btn active", t("surface.chat"));
  const segCodeBtn = el("button", "seg-btn", t("surface.code"));
  const segCompanyBtn = el("button", "seg-btn", t("surface.company"));
  seg.append(segChatBtn, segCompanyBtn, segCodeBtn);

  const connSec = el("div");
  connSec.append(el("div", "rail-section-label", t("rail.connection")));
  const conn = el("div", "conn online");
  conn.append(el("span", "conn-dot"), document.createTextNode(t("rail.connected")));
  connSec.append(conn);

  const newChatBtn = el("button", "rail-btn primary", t("rail.newChat"));
  const memoryBtn = el("button", "rail-btn", t("rail.memory"));

  // Chat sessions (design v3 TODAY / EARLIER). List + switching live here;
  // the store itself is the pure, tested module in sessions.ts.
  const sessionStore = resolveSessionStore();
  let activeSession: ChatSession | null = null;
  const sessionsSec = el("div", "sessions-sec");

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
  const changesPathInput = el("input", "changes-path");
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
  codePane.append(changesSec);

  const renderChanges = (views: ChangeView[], error?: string) => {
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
          files: String(sum.files),
          added: String(sum.added),
          removed: String(sum.removed),
        }),
      ),
    );
    for (const v of views) {
      const row = el("div", "changes-item");
      const name = el("span", "changes-file mono", v.file);
      name.title = v.path; // full path without widening the row
      row.append(el("span", "changes-status mono", v.status), name);
      row.append(el("span", `changes-counts mono${v.countless ? " faint" : ""}`, changeCounts(v)));
      changesBody.append(row);
    }
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

  const spacer = el("div", "rail-spacer");

  const savingsCard = el("div", "savings-card");
  savingsCard.append(el("div", "rail-section-label", t("rail.savings")));
  const savingsAmount = el("div", "savings-amount", "—");
  const savingsSub = el("div", "savings-sub", t("rail.noSavings"));
  savingsCard.append(savingsAmount, savingsSub);

  const signOutBtn = el("button", "rail-btn", t("rail.signOut"));

  // Account row (design v3 footer): who is signed in + the BYOK badge.
  let accountEmail = "";
  try {
    accountEmail = globalThis.localStorage?.getItem("bv.account.email") ?? "";
  } catch {
    /* no storage — generic row */
  }
  const account = el("div", "account-row");
  const avatar = el("div", "account-avatar mono", (accountEmail[0] ?? "•").toUpperCase());
  const accountMeta = el("div", "account-meta");
  accountMeta.append(
    el("div", "account-email", accountEmail || t("app.name")),
    el("div", "account-sub mono", "BYOK"),
  );
  account.append(avatar, accountMeta);

  rail.append(brand, seg, newChatBtn, memoryBtn, sessionsSec, connSec, spacer, savingsCard, account, signOutBtn);

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

  const hint = el("div", "composer-hint");
  hint.style.display = "none";

  const companyInput = el("input", "company-input") as HTMLInputElement;
  companyInput.placeholder = t("chat.companyId");
  companyInput.style.display = "none"; // only for compare mode
  const compareControls = createCompareControls(cfg, t, () => companyInput.value.trim(), () => !workspaceDisposed);
  compareControls.element.style.display = "none";
  companyInput.addEventListener("input", compareControls.invalidate);
  companyInput.addEventListener("change", compareControls.invalidate);

  // Local (Ollama): optional model override.
  const localModelInput = el("input", "company-input") as HTMLInputElement;
  localModelInput.placeholder = t("chat.localModel");
  localModelInput.style.display = "none";

  // Direct (BYOK): provider select + optional model override.
  const directProviderSel = el("select", "company-input") as HTMLSelectElement;
  for (const p of DIRECT_PROVIDERS) {
    const opt = el("option", undefined, p) as HTMLOptionElement;
    opt.value = p;
    directProviderSel.append(opt);
  }
  directProviderSel.style.display = "none";
  const directModelInput = el("input", "company-input") as HTMLInputElement;
  directModelInput.placeholder = t("chat.directModel");
  directModelInput.style.display = "none";

  const modeToggle = el("div", "mode-toggle");
  const cascadeBtn = el("button", undefined, t("chat.modeCascade"));
  const compareBtn = el("button", undefined, t("chat.modeCompare"));
  const localBtn = el("button", undefined, t("chat.modeLocal"));
  const directBtn = el("button", undefined, t("chat.modeDirect"));
  cascadeBtn.classList.add("active");
  const applyMode = (m: Mode) => {
    mode = m;
    cascadeBtn.classList.toggle("active", m === "cascade");
    compareBtn.classList.toggle("active", m === "compare");
    localBtn.classList.toggle("active", m === "local");
    directBtn.classList.toggle("active", m === "direct");
    companyInput.style.display = m === "compare" ? "block" : "none";
    compareControls.element.style.display = m === "compare" ? "" : "none";
    if (m !== "compare") compareControls.invalidate();
    localModelInput.style.display = m === "local" ? "block" : "none";
    directProviderSel.style.display = m === "direct" ? "block" : "none";
    directModelInput.style.display = m === "direct" ? "block" : "none";
  };
  cascadeBtn.addEventListener("click", () => applyMode("cascade"));
  compareBtn.addEventListener("click", () => applyMode("compare"));
  localBtn.addEventListener("click", () => applyMode("local"));
  directBtn.addEventListener("click", () => applyMode("direct"));
  modeToggle.append(cascadeBtn, compareBtn, localBtn, directBtn);

  const topRow = el("div", "composer-row");
  topRow.append(modeToggle, companyInput, localModelInput, directProviderSel, directModelInput);

  const ta = el("textarea") as HTMLTextAreaElement;
  ta.placeholder = t("chat.placeholder");
  const sendBtn = el("button", "send-btn", t("chat.send"));
  const enterHint = el("span", "enter-hint mono", t("chat.enterHint"));
  const bottomRow = el("div", "composer-row");
  bottomRow.append(ta, enterHint, sendBtn);

  composer.append(hint, topRow, compareControls.element, bottomRow);
  chat.append(chatPresence, scroll, composer);

  // --- right inspector (Inspector | Activity tabs) ---
  const inspector = el("aside", "inspector");
  const inspTabs = el("div", "insp-tabs");
  const inspTabDetail = el("button", "insp-tab active", t("gov.inspectorTab"));
  const inspTabActivity = el("button", "insp-tab", t("gov.activity"));
  inspTabs.append(inspTabDetail, inspTabActivity);
  const inspectorBody = el("div", "insp-detail");
  inspectorBody.append(el("div", "inspector-empty", t("inspector.empty")));
  const activityBody = el("div", "insp-activity");
  activityBody.style.display = "none";
  inspector.append(inspTabs, inspectorBody, activityBody);

  chat.append(codePane);
  chat.append(companyPane);

  shell.append(rail, chat, inspector);
  const win = el("div", "win");
  win.append(titlebar, shell);
  root.append(win);

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
    el("div", "sheet-sec-label mono", t("settings.secModels")),
    keysSec,
    setRow(t("settings.vendorCli"), t("settings.vendorCliSub"), openCodeBtn),
  );

  // CONNECTORS & HOSTS — MCP registry + the host-runtime disclosure line.
  const secConn = el("div", "sheet-sec");
  secConn.append(
    el("div", "sheet-sec-label mono", t("settings.secConnectors")),
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
  const baseGov = deps.gov;
  const compToggle = el("button", "toggle");
  const compStatus = el("div", "set-sub mono", t("settings.companionOff"));
  const syncComp = () => compToggle.classList.toggle("on", !!compBridge);
  const stopCompanion = async () => {
    deps.gov = baseGov;
    activeRelayStopper = null;
    const b = compBridge;
    compBridge = null;
    syncComp();
    compStatus.textContent = t("settings.companionOff");
    await b?.stop().catch(() => {});
  };
  const startCompanion = async () => {
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
          if (dispatching) {
            void b?.emitAudit("steer: refused — a dispatch is already running").catch(() => {});
            return;
          }
          void b?.emitAudit(`steer: remote prompt accepted (${mode})`).catch(() => {});
          nextDispatchRemote = true;
          record("user", `↯ ${m}`); // ↯ marks remote origin in the transcript
          ta.value = m;
          void run();
        },
        onApprove: async (id) => {
          // Hand the minted token to the modal that is still waiting locally,
          // otherwise the phone's "Allow" burns the pending record and the
          // local flow fails with "resolved elsewhere" — approving would
          // cancel the very action the user approved.
          const r = await resolveApproval(deps.gov, id);
          const settle = openApprovals.get(id);
          if (r.resolved && settle) settle({ approved: true, token: r.token });
          else if (r.resolved) {
            // No modal waiting (app re-rendered): the grant is unusable, so
            // say so rather than leaving a silent dangling token.
            void b?.emitAudit(`approve: no local request waiting for ${id}`).catch(() => {});
          }
        },
        onReject: async (id) => {
          await resolveRejection(deps.gov, id);
          openApprovals.get(id)?.({ approved: false });
        },
        onKill: async () => {
          await killEverything();
        },
      });
      const { sessionId } = await b.start({
        surface: "desktop",
        label: (activeSession?.title || t("app.name")).slice(0, 200),
      });
      compBridge = b;
      deps.gov = bridgeGovernance(baseGov, b);
      activeRelayStopper = stopCompanion;
      compStatus.textContent = t("settings.companionOn", { id: sessionId.slice(0, 12) });
    } catch {
      compStatus.textContent = t("settings.companionErr");
      await stopCompanion();
    } finally {
      compToggle.disabled = false;
      syncComp();
    }
  };
  compToggle.addEventListener("click", () => (compBridge ? void stopCompanion() : void startCompanion()));
  const secComp = el("div", "sheet-sec");
  const compRow = setRow(t("settings.companionTitle"), t("settings.companionSub"), compToggle);
  secComp.append(
    el("div", "sheet-sec-label mono", t("settings.secCompanion")),
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
    el("div", "sheet-sec-label mono", t("settings.secGovernance")),
    setRow(t("settings.policyTitle"), t("settings.policySub")),
    policyList,
    setRow(t("settings.killTitle"), t("settings.killSub"), killBtn),
  );

  // APP & DATA — a WORKING reduced-motion toggle + the honest telemetry line.
  const rmToggle = el("button", "toggle");
  const syncRm = () => rmToggle.classList.toggle("on", prefs.reducedMotion());
  syncRm();
  rmToggle.addEventListener("click", () => {
    prefs.setReducedMotion(!prefs.reducedMotion());
    applyReducedMotion(document.documentElement, effectiveReducedMotion(prefs, osPrefersReducedMotion()));
    notifyBrandMotionPreference();
    syncRm();
  });
  const secApp = el("div", "sheet-sec");
  secApp.append(
    el("div", "sheet-sec-label mono", t("settings.secApp")),
    setRow(t("settings.reducedMotion"), t("settings.reducedMotionSub"), rmToggle),
    setRow(t("settings.telemetry"), t("settings.telemetrySub")),
  );

  sheetBody.append(secModels, secConn, secComp, secGov, secApp);
  sheet.append(sheetHead, sheetBody);
  backdrop.append(sheet);
  root.append(backdrop);

  const setSettings = (open: boolean) => {
    settingsOpen = open;
    backdrop.style.display = open ? "flex" : "none";
  };
  settingsBtn.addEventListener("click", () => setSettings(true));
  sheetClose.addEventListener("click", () => setSettings(false));
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) setSettings(false);
  });
  // Sheet-local Esc handler; registered once per workspace render.
  const onWorkspaceKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && settingsOpen) setSettings(false);
  };
  window.addEventListener("keydown", onWorkspaceKey);

  // --- company surface ---
  let companyBusy = false;
  const renderCompany = (companies: CompanyView[], jobs: JobView[], error?: string) => {
    companyPane.replaceChildren();

    if (error) {
      const err = el("div", "company-error", error);
      companyPane.append(err);
      return;
    }

    const sum = companySummary(companies, jobs);
    companyPane.append(
      el(
        "div",
        "company-summary mono",
        t("company.summary", {
          total: String(sum.total),
          active: String(sum.active),
          jobs: String(sum.jobs),
          scheduled: String(sum.scheduled),
        }),
      ),
    );

    if (companies.length === 0) {
      // Authoring lives on the web; the desktop reads and controls.
      companyPane.append(el("div", "company-empty", t("company.empty")));
    }

    companyPane.append(el("div", "rail-section-label", t("company.companies")));
    for (const c of companies) {
      const row = el("div", "company-row");
      row.append(el("span", `dot dot-${c.tone === "arc" ? "done" : c.tone === "ember" ? "run" : c.tone === "molten" ? "risk" : "idle"}`));
      const meta = el("div", "company-meta");
      meta.append(
        el("div", "company-name", c.name),
        el(
          "div",
          "company-sub mono",
          t("company.counts", { agents: String(c.agentCount), pipelines: String(c.pipelineCount) }),
        ),
      );
      row.append(meta);
      row.append(el("span", "company-status mono", c.status.toLowerCase()));

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
            const msg = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
            renderCompany(companies, jobs, msg);
          } finally {
            companyBusy = false;
          }
        });
        row.append(btn);
      }
      companyPane.append(row);
    }

    companyPane.append(el("div", "rail-section-label", t("company.jobs")));
    if (jobs.length === 0) {
      companyPane.append(el("div", "company-empty", t("company.noJobs")));
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
      companyPane.append(row);
    }
  };

  const loadCompany = async () => {
    companyPane.replaceChildren(el("div", "company-empty", t("company.loading")));
    try {
      const [rawCompanies, rawJobs] = await Promise.all([
        listCompanies(cfg, { save: deps.persist }),
        // Jobs are a nice-to-have: if the scheduled endpoint fails we still show
        // the companies rather than blanking the whole surface.
        listScheduledPipelines(cfg, { save: deps.persist }).catch(() => null),
      ]);
      renderCompany(toCompanyViews(rawCompanies), toJobViews(rawJobs));
    } catch (e) {
      const msg = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
      renderCompany([], [], t("company.loadFailed", { reason: msg }));
    }
  };

  // --- surface switch ---
  let surface: "chat" | "company" | "code" = "chat";
  const applySurface = (s: "chat" | "company" | "code") => {
    surface = s;
    segChatBtn.classList.toggle("active", s === "chat");
    segCompanyBtn.classList.toggle("active", s === "company");
    segCodeBtn.classList.toggle("active", s === "code");
    scroll.style.display = s === "chat" ? "" : "none";
    composer.style.display = s === "chat" ? "" : "none";
    chatPresence.style.display = s === "chat" ? "" : "none";
    chatMascot.setVisible(s === "chat");
    for (const motion of thinkingMotions.values()) motion.setVisible(s === "chat");
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
    if (s === "code" && changesPathInput.value.trim()) void loadChanges();
  };
  segChatBtn.addEventListener("click", () => applySurface("chat"));
  segCompanyBtn.addEventListener("click", () => applySurface("company"));
  segCodeBtn.addEventListener("click", () => applySurface("code"));
  applySurface(surface);

  // --- governance activity view (policy visibility + audit ledger) ---
  let activeTab: "detail" | "activity" = "detail";
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
  const showTab = (tab: "detail" | "activity") => {
    activeTab = tab;
    inspTabDetail.classList.toggle("active", tab === "detail");
    inspTabActivity.classList.toggle("active", tab === "activity");
    inspectorBody.style.display = tab === "detail" ? "block" : "none";
    activityBody.style.display = tab === "activity" ? "block" : "none";
    if (tab === "activity") void refreshActivity();
  };
  inspTabDetail.addEventListener("click", () => showTab("detail"));
  inspTabActivity.addEventListener("click", () => showTab("activity"));
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

  const refreshSessionList = () => {
    sessionsSec.replaceChildren();
    const { today, earlier } = groupSessions(sessionStore.list(), Date.now());
    if (today.length) {
      sessionsSec.append(el("div", "rail-section-label", t("sessions.today")));
      for (const s of today) sessionsSec.append(sessionItem(s));
    }
    if (earlier.length) {
      sessionsSec.append(el("div", "rail-section-label", t("sessions.earlier")));
      for (const s of earlier) sessionsSec.append(sessionItem(s));
    }
  };

  const syncCrumb = () => {
    if (surface !== "chat") return;
    crumb.textContent = activeSession?.title || t("app.name");
  };

  // Replays a stored transcript as plain lines — deliberately NOT the rich
  // cascade/compare cards (their payloads aren't persisted; see sessions.ts).
  // All text lands via el()/textContent, never markup.
  const loadSession = (id: string) => {
    const s = sessionStore.get(id);
    if (!s) return;
    chatMotionVersion += 1;
    dispatching = false;
    sendBtn.disabled = false;
    setChatMotion("idle", t("app.tagline"));
    for (const row of thinkingMotions.keys()) removeThinking(row);
    activeSession = s;
    scroll.replaceChildren();
    for (const e of s.entries) {
      if (e.role === "user") scroll.append(el("div", "msg-user", e.text));
      else if (e.role === "assistant") renderPlainAnswer(scroll, e.text, t);
      else renderErrorCard(scroll, e.text);
    }
    refreshSessionList();
    syncCrumb();
    scrollToEnd();
  };

  const startNewSession = () => {
    chatMotionVersion += 1;
    dispatching = false;
    sendBtn.disabled = false;
    setChatMotion("idle", t("app.tagline"));
    for (const row of thinkingMotions.keys()) removeThinking(row);
    activeSession = null; // created lazily on first send, so empty chats don't pile up
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

  const record = (role: SessionRole, text: string, entryMode: Mode = mode) => {
    if (workspaceDisposed || !text) return;
    if (!activeSession) activeSession = sessionStore.create();
    const before = activeSession.title;
    activeSession =
      sessionStore.append(activeSession.id, { role, mode: entryMode, text, at: Date.now() }) ?? activeSession;
    if (activeSession.title !== before) syncCrumb();
    refreshSessionList();
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
        savingsAmount.textContent = `$${v.savedUsd.toFixed(v.savedUsd < 1 ? 4 : 2)}`;
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

  const run = async () => {
    if (workspaceDisposed || dispatching) return;
    const runMode = mode;
    const text = ta.value.trim();
    if (!text) return;
    if (runMode === "compare" && !companyInput.value.trim()) {
      hint.textContent = t("chat.companyNeeded");
      hint.style.display = "block";
      return;
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
    const owner = captureSession(cfg);
    const motionVersion = ++chatMotionVersion;
    const ownsRun = () => !workspaceDisposed && isCurrentSession(cfg, owner) && motionVersion === chatMotionVersion;
    const recordRun = (role: SessionRole, text: string) => {
      if (ownsRun()) record(role, text, runMode);
    };
    hint.style.display = "none";
    dispatching = true;
    sendBtn.disabled = true;
    ta.value = "";
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

    const userMsg = el("div", "msg-user", text);
    scroll.append(userMsg);
    scrollToEnd();

    try {
      // Inside the try: a storage failure here must not strand sendBtn
      // disabled with the user's text already cleared.
      recordRun("user", text);
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
          renderErrorCard(scroll, gate.reason);
          recordRun("error", gate.reason);
          bumpActivity();
          return;
        }
      }

      if (runMode === "cascade") {
        const thinking = thinkingRow(t("chat.thinking", { n: 1 }));
        scroll.append(thinking);
        scrollToEnd();
        const raw = await cascade(cfg, { prompt: text });
        if (!ownsRun()) return;
        removeThinking(thinking);
        const view = toCascadeView(raw);
        showAnswerMotion(view.answer);
        renderCascadeAnswer(scroll, view, t);
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
            const model = await resolveOllamaModel(host, localModelInput.value.trim() || undefined);
            if (!ownsRun()) return;
            const res = await ollamaChat(host, model, text);
            if (!ownsRun()) return;
            removeThinking(thinking);
            showAnswerMotion(res.content);
            renderPlainAnswer(scroll, res.content, t);
            renderSourceInspector(inspectorBody, t("chat.localSource"), res.model, t);
            recordRun("assistant", res.content);
            await deps.gov.settle("local.dispatch", "success", localDetail);
          } catch (e) {
            if (!ownsRun()) return;
            removeThinking(thinking);
            setRunMotion("error", e instanceof OllamaUnreachableError
              ? t("chat.localUnreachable", { host: e.host }) : String(e instanceof Error ? e.message : e));
            if (e instanceof OllamaUnreachableError) {
              renderErrorCard(scroll, t("chat.localUnreachable", { host: e.host }));
              recordRun("error", t("chat.localUnreachable", { host: e.host }));
            } else {
              renderErrorCard(scroll, String(e instanceof Error ? e.message : e));
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
              renderErrorCard(scroll, t("chat.noKey", { provider }));
              recordRun("error", t("chat.noKey", { provider }));
              await deps.gov.settle("direct.dispatch", "error", directDetail);
            } else {
              const model = resolveDirectModel(provider, directModelInput.value.trim() || undefined);
              const thinking = thinkingRow(t("chat.directThinking", { provider }));
              scroll.append(thinking);
              scrollToEnd();
              try {
                const res = await directChat(provider, apiKey, model, text);
                if (!ownsRun()) return;
                removeThinking(thinking);
                showAnswerMotion(res.content);
                renderPlainAnswer(scroll, res.content, t);
                renderSourceInspector(inspectorBody, t("chat.directSource", { provider }), res.model, t);
                recordRun("assistant", res.content);
                await deps.gov.settle("direct.dispatch", "success", directDetail);
              } catch (e) {
                if (!ownsRun()) return;
                removeThinking(thinking);
                const msg = e instanceof DirectApiError ? `${e.status} · ${e.message}` : String(e instanceof Error ? e.message : e);
                setRunMotion("error", msg);
                renderErrorCard(scroll, msg);
                recordRun("error", msg);
                await deps.gov.settle("direct.dispatch", "error", directDetail);
              }
            }
          }
        }
        if (ownsRun()) bumpActivity();
      } else {
        const stub = await startCompare(cfg, { companyId: runCompanyId, query: text,
          ...(runSelections !== undefined ? { selections: runSelections } : {}) });
        if (!ownsRun()) return;
        const progressLabel = (status: string) => status === "RUNNING"
          ? t("chat.thinking", { n: 2 }) : t("chat.polling", { status });
        const label = document.createTextNode(progressLabel(stub.status));
        const thinking = thinkingRow(label, compareProgressMotion(stub.status));
        scroll.append(thinking);
        scrollToEnd();
        const session = await pollCompare(cfg, stub.id, {
          isCurrent: ownsRun,
          onTick: (status) => {
            if (!ownsRun()) return;
            const progressMotion = compareProgressMotion(status);
            label.textContent = progressLabel(status);
            thinkingMotions.get(thinking)?.setState(progressMotion);
            setRunMotion(progressMotion, label.textContent);
          },
        });
        if (!ownsRun()) return;
        removeThinking(thinking);
        const view = toCompareView(session);
        const resultMotion = compareMotion(view);
        setRunMotion(resultMotion, resultMotion === "success" ? t("chat.finalAnswer")
          : resultMotion === "error" ? view.error || t("chat.empty") : t("app.tagline"));
        renderCompareAnswer(scroll, view, t);
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
      const msg = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
      setRunMotion("error", msg);
      recordRun("error", msg);
      const errCard = el("div", "msg-final");
      errCard.style.borderLeftColor = "var(--molten)";
      errCard.append(el("div", "msg-label", "error"), document.createTextNode(msg));
      scroll.append(errCard);
    } finally {
      for (const row of runThinkingRows) removeThinking(row);
      if (ownsRun()) {
        dispatching = false;
        sendBtn.disabled = false;
        scrollToEnd();
      }
    }
  };

  sendBtn.addEventListener("click", () => void run());
  ta.addEventListener("keydown", (e) => {
    // Design v3: Enter sends, Shift+Enter inserts a newline (Cmd/Ctrl+Enter
    // kept for muscle memory from the previous build).
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void run();
    }
  });
  // Thin wiring only — the revoke-then-clear logic + its ordering/gate
  // invariants live in the unit-tested performSignOut (session.ts), which is
  // where the C3/#1 regression is guarded.
  signOutBtn.addEventListener("click", () => performSignOut(cfg, deps));

  // Everything this render owns beyond the DOM: the companion bridge + the
  // governance decorator installed with it, and the window key listener.
  disposeWorkspace = () => {
    workspaceDisposed = true;
    for (const motion of motions) motion.dispose();
    motions.clear();
    thinkingMotions.clear();
    window.removeEventListener("keydown", onWorkspaceKey);
    if (compBridge) void stopCompanion();
    else deps.gov = baseGov;
  };

  void refreshSavings();
  refreshSessionList();
}

// ── answer renderers (center) ───────────────────────────────────────────────
function renderCascadeAnswer(scroll: HTMLElement, v: CascadeView, t: Translator): void {
  const card = el("div", "msg-final");
  card.append(el("div", "msg-label", t("chat.finalAnswer")));
  card.append(document.createTextNode(v.answer || t("chat.empty")));
  scroll.append(card);
  if (v.totalCostUsd > 0) {
    scroll.append(el("div", "saved-footer", `${v.provider} · ${v.model} · $${v.totalCostUsd.toFixed(4)}`));
  }
}

function renderCompareAnswer(scroll: HTMLElement, v: CompareView, t: Translator): void {
  if (!v.hasResult) {
    const card = el("div", "msg-final");
    card.style.borderLeftColor = "var(--molten)";
    card.append(el("div", "msg-label", v.status), document.createTextNode(v.error || t("chat.empty")));
    scroll.append(card);
    return;
  }
  // per-model arc-rim cards
  const grid = el("div", "model-grid");
  for (const m of v.perModel) {
    const cardEl = el("div", "model-card");
    const head = el("div", "model-head");
    head.append(el("span", "model-name", `${m.provider}/${m.model}`), el("span", "model-cost", `$${m.costUsd.toFixed(4)}`));
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
    const card = el("div", "msg-final");
    card.style.borderLeftColor = "var(--molten)";
    card.append(el("div", "msg-label", v.status), document.createTextNode(v.error || t("chat.empty")));
    scroll.append(card);
    return;
  }

  const finalCard = el("div", "msg-final");
  finalCard.append(el("div", "msg-label", t("chat.finalAnswer")));
  finalCard.append(document.createTextNode(v.finalAnswer || t("chat.empty")));
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
  scroll.append(card);
}

/** Molten-rimmed error card (honest failure, never a fabricated answer). */
function renderErrorCard(scroll: HTMLElement, message: string): void {
  const card = el("div", "msg-final");
  card.style.borderLeftColor = "var(--molten)";
  card.append(el("div", "msg-label", "error"), document.createTextNode(message));
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
): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  const { gov, t } = deps;
  const res = await gov.request(kind, detail);
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

    const close = (o: ApprovalOutcome) => {
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
    approveBtn.focus();
  });
}

/**
 * Two-step kill switch. Step one is the molten button in Settings; THIS dialog
 * is step two — it lists exactly what will be stopped (honest scope: open
 * approvals + the governed browser connection; PTY/relay aren't launchable
 * from this UI yet) and only acts on the explicit confirm. Afterwards it
 * reports what actually happened instead of claiming "everything".
 */
function showKillDialog(deps: UiDeps): Promise<void> {
  const { t, root } = deps;
  return new Promise<void>((resolve) => {
    const overlay = el("div", "approve-overlay");
    const card = el("div", "approve-card kill-card");
    card.append(el("h2", "approve-title", t("kill.title")));
    card.append(el("div", "approve-body", t("kill.body")));

    const scope = el("div", "kill-scope mono");
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

    const close = () => {
      overlay.remove();
      resolve();
    };
    cancelBtn.addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    confirmBtn.addEventListener("click", () => {
      confirmBtn.disabled = true;
      void killEverything().then((r) => {
        scope.replaceChildren(
          el("div", undefined, `✓ ${t("kill.doneApprovals", { n: String(r.approvals) })}`),
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
    cancelBtn.focus(); // default focus on the SAFE action
  });
}

/** One audit-log row: time · kind · outcome, molten when the outcome is a block. */
function renderAuditRow(e: AuditEntry): HTMLElement {
  const row = el("div", "audit-row");
  const time = new Date(e.ts);
  const hh = String(time.getHours()).padStart(2, "0");
  const mm = String(time.getMinutes()).padStart(2, "0");
  const ss = String(time.getSeconds()).padStart(2, "0");
  row.append(el("span", "audit-ts mono", `${hh}:${mm}:${ss}`));
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
    const entries = await vault.list();
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
      rm.title = t("keys.remove");
      rm.addEventListener("click", () => {
        void (async () => {
          await vault.remove(e.provider);
          await refresh();
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
    } finally {
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
      cmdBox.append(el("code", undefined, cmdText));
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

  let selected: string | null = null;

  // --- tool-call form for the currently selected server ---
  const showTools = async (server: string, tools: McpTool[]) => {
    toolsPanel.innerHTML = "";
    toolsPanel.style.display = "block";
    toolsPanel.append(el("div", "mcp-tools-head mono", `${server} · ${t("mcp.tools")} (${tools.length})`));
    if (!tools.length) {
      toolsPanel.append(el("div", "mcp-empty", t("mcp.noTools")));
      return;
    }
    for (const tool of tools) {
      const row = el("div", "mcp-tool-row");
      const head = el("div", "mcp-tool-head");
      head.append(el("span", "mcp-tool-name mono", tool.name));
      row.append(head);
      if (typeof tool.description === "string" && tool.description) {
        row.append(el("div", "mcp-tool-desc", tool.description.split("\n")[0]));
      }
      // Per-tool call form: JSON args → gate → call → molten-aware result card.
      const argsTa = el("textarea", "mcp-args") as HTMLTextAreaElement;
      argsTa.placeholder = t("mcp.argsJson");
      const callBtn = el("button", "mcp-call-btn", t("mcp.call"));
      callBtn.append(el("span", "laneb-gov-badge", t("gov.governedBadge")));
      const resultBox = el("div", "mcp-result");
      resultBox.style.display = "none";

      const doCall = async () => {
        const parsed = parseToolArgs(argsTa.value);
        resultBox.style.display = "block";
        resultBox.style.borderLeftColor = "var(--molten)";
        if (!parsed.ok) {
          resultBox.innerHTML = "";
          resultBox.append(el("div", "msg-label", t("mcp.errorResult")), document.createTextNode(parsed.error));
          return;
        }
        // GATE: a tool call is a side effect — a human approves first.
        const detail: ActionDetail = {
          server,
          tool: tool.name,
          summary: t("gov.kindMcpTool", { tool: tool.name, server }),
        };
        const gate = await gateForToken(deps, "mcp.tool", detail);
        if (!gate.ok) {
          resultBox.innerHTML = "";
          resultBox.append(el("div", "msg-label", t("mcp.errorResult")), document.createTextNode(gate.reason));
          return;
        }
        callBtn.disabled = true;
        try {
          const res = await mcp.callTool(server, tool.name, parsed.value, gate.token);
          const view = summarizeCallResult(res);
          resultBox.innerHTML = "";
          resultBox.style.borderLeftColor = resultBorderColor(view.isError);
          resultBox.append(el("div", "msg-label", view.isError ? t("mcp.errorResult") : t("mcp.result")));
          resultBox.append(document.createTextNode(view.text || t("mcp.empty2")));
          await deps.gov.settle("mcp.tool", view.isError ? "error" : "success", detail);
        } catch (e) {
          resultBox.innerHTML = "";
          resultBox.style.borderLeftColor = "var(--molten)";
          const msg = e instanceof McpGateError ? t("gov.rejectedByUser") : String(e instanceof Error ? e.message : e);
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
        err.style.borderLeftColor = "var(--molten)";
        err.append(el("div", "msg-label", t("mcp.errorResult")), document.createTextNode(gate.reason));
        toolsPanel.append(err);
        return;
      }
      const tools = await mcp.listTools(server, gate.token);
      await showTools(server, tools);
    } catch (e) {
      toolsPanel.innerHTML = "";
      const err = el("div", "mcp-result");
      err.style.borderLeftColor = "var(--molten)";
      err.append(el("div", "msg-label", t("mcp.errorResult")), document.createTextNode(String(e instanceof Error ? e.message : e)));
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
      info.append(el("span", "mcp-name mono", name));
      info.append(el("span", "mcp-cmd mono", [def.command, ...def.args].join(" ")));
      info.addEventListener("click", () => void loadTools(name));
      const rm = el("button", "key-remove", "×");
      rm.title = t("mcp.remove");
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
  const cmdInput = el("input", "key-input") as HTMLInputElement;
  cmdInput.placeholder = t("mcp.command");
  const argsInput = el("input", "key-input") as HTMLInputElement;
  argsInput.placeholder = t("mcp.args");
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
    kv(t("inspector.confidence"), v.confidence.toFixed(2)),
    kv(t("inspector.escalated"), v.escalated ? "yes" : "no", v.escalated),
    kv(t("inspector.cost"), `$${v.totalCostUsd.toFixed(4)}`),
    kv(t("inspector.stoppedReason"), v.stoppedReason || "—"),
  );
  if (v.attempts.length) {
    body.append(el("h2", undefined, t("inspector.attempts")));
    for (const a of v.attempts) {
      const box = el("div", "attempt");
      const top = el("div", "a-top");
      top.append(el("span", undefined, `${a.provider}/${a.model}`), el("span", undefined, `$${a.costUsd.toFixed(4)}`));
      box.append(top, el("div", "a-sub", `${a.tier} · conf ${a.confidence.toFixed(2)}`));
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
    kv(t("chat.perModel"), String(v.perModel.length)),
    kv(t("chat.failed"), String(v.failed.length), v.failed.length > 0),
    kv(t("inspector.cost"), `$${v.totalCostUsd.toFixed(4)}`),
    kv(t("chat.synthesis"), v.status !== "COMPLETED" ? v.status : v.synthesisParsed ? "parsed" : "raw", v.status !== "COMPLETED" || !v.synthesisParsed),
  );
}
