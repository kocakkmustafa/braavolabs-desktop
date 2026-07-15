/**
 * DOM shell for the 3-pane obsidian UI. Deliberately thin: every decision that
 * matters (what to render, honesty gates, error mapping) lives in the pure,
 * unit-tested modules (client.ts / render.ts / i18n.ts). This file only wires
 * those outputs into elements and forwards user intent back to the client.
 * It has no test of its own — driving it end-to-end is the `cargo tauri dev`
 * HUMAN GATE documented in the README.
 */
import type { Config } from "./config";
import { saveApiUrl } from "./store";
import {
  ApiError,
  login,
  startCompare,
  pollCompare,
  cascade,
  savings as savingsCall,
} from "./client";
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
import type { Translator } from "./i18n";

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
  /** Persist secrets after login/refresh/logout. */
  persist: (c: Config) => Promise<void> | void;
  onSignedOut: () => void;
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
  root.innerHTML = "";
  const wrap = el("div", "login-wrap");
  const card = el("div", "login-card");

  const h1 = el("h1");
  const dot = el("span", "brand-dot");
  h1.append(dot, document.createTextNode(t("login.title")));
  const sub = el("div", "sub", t("app.tagline"));

  const errBox = el("div", "login-error");
  errBox.style.display = "none";

  const emailInput = el("input");
  emailInput.type = "email";
  emailInput.autocomplete = "username";
  const pwInput = el("input");
  pwInput.type = "password";
  pwInput.autocomplete = "current-password";
  const apiInput = el("input");
  apiInput.type = "text";
  apiInput.value = cfg.apiUrl;

  const field = (labelKey: string, input: HTMLInputElement) => {
    const f = el("div", "field");
    const l = el("label", undefined, t(labelKey));
    f.append(l, input);
    return f;
  };

  const btn = el("button", "login-btn", t("login.submit"));

  const submit = async () => {
    errBox.style.display = "none";
    btn.disabled = true;
    btn.textContent = t("login.signingIn");
    cfg.apiUrl = apiInput.value.trim() || cfg.apiUrl;
    saveApiUrl(cfg.apiUrl);
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

      if (!res.ok) {
        const view = toLoginError({ status: res.status, body: { error: res.message } });
        errBox.textContent = mapLoginErrorText(t, view);
        errBox.style.display = "block";
        return;
      }
      cfg.token = res.data.token;
      cfg.refreshToken = res.data.refreshToken;
      await deps.persist(cfg);
      renderWorkspace(deps);
    } finally {
      btn.disabled = false;
      btn.textContent = t("login.submit");
    }
  };

  btn.addEventListener("click", submit);
  pwInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit();
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
    case "invalid":
      return t("login.errInvalid");
    case "locked":
      return t("login.errLocked");
    case "rate_limited":
      return t("login.errRateLimited");
    case "unavailable":
      return t("login.errUnavailable");
    default:
      return view?.message || t("login.errUnknown");
  }
}

// ── workspace (3-pane) ──────────────────────────────────────────────────────
export function renderWorkspace(deps: UiDeps): void {
  const { root, cfg, t } = deps;
  root.innerHTML = "";
  let mode: Mode = "cascade";

  const shell = el("div", "shell");

  // --- left rail ---
  const rail = el("aside", "rail");
  const brand = el("div", "brand");
  brand.append(el("span", "brand-dot"), document.createTextNode(t("app.name")));

  const connSec = el("div");
  connSec.append(el("div", "rail-section-label", t("rail.connection")));
  const conn = el("div", "conn online");
  conn.append(el("span", "conn-dot"), document.createTextNode(t("rail.connected")));
  connSec.append(conn);

  const newChatBtn = el("button", "rail-btn", t("rail.newChat"));
  const memoryBtn = el("button", "rail-btn", t("rail.memory"));

  const keysSec = renderKeysSection(deps);
  const laneBSec = renderLaneBSection(deps);

  const spacer = el("div", "rail-spacer");

  const savingsCard = el("div", "savings-card");
  savingsCard.append(el("div", "rail-section-label", t("rail.savings")));
  const savingsAmount = el("div", "savings-amount", "—");
  const savingsSub = el("div", "savings-sub", t("rail.noSavings"));
  savingsCard.append(savingsAmount, savingsSub);

  const signOutBtn = el("button", "rail-btn", t("rail.signOut"));

  rail.append(brand, connSec, newChatBtn, memoryBtn, keysSec, laneBSec, spacer, savingsCard, signOutBtn);

  // --- center chat ---
  const chat = el("div", "chat");
  const scroll = el("div", "chat-scroll");
  const composer = el("div", "composer");

  const hint = el("div", "composer-hint");
  hint.style.display = "none";

  const companyInput = el("input", "company-input") as HTMLInputElement;
  companyInput.placeholder = t("chat.companyId");
  companyInput.style.display = "none"; // only for compare mode

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
  const bottomRow = el("div", "composer-row");
  bottomRow.append(ta, sendBtn);

  composer.append(hint, topRow, bottomRow);
  chat.append(scroll, composer);

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

  shell.append(rail, chat, inspector);
  root.append(shell);

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

  const refreshSavings = async () => {
    try {
      const raw = await savingsCall(cfg, { days: 30 });
      const v = toSavingsView(raw);
      if (v.hasSavings) {
        savingsAmount.textContent = `$${v.savedUsd.toFixed(v.savedUsd < 1 ? 4 : 2)}`;
        savingsSub.textContent = t("rail.savingsWindow", { days: 30 });
      } else {
        savingsAmount.textContent = "—";
        savingsSub.textContent = t("rail.noSavings");
      }
    } catch {
      savingsAmount.textContent = "—";
      savingsSub.textContent = t("rail.noSavings");
    }
  };

  const run = async () => {
    const text = ta.value.trim();
    if (!text) return;
    if (mode === "compare" && !companyInput.value.trim()) {
      hint.textContent = t("chat.companyNeeded");
      hint.style.display = "block";
      return;
    }
    hint.style.display = "none";
    sendBtn.disabled = true;
    ta.value = "";

    const userMsg = el("div", "msg-user", text);
    scroll.append(userMsg);
    scrollToEnd();

    try {
      if (mode === "cascade") {
        const thinking = el("div", "thinking");
        thinking.append(el("span", "spinner"), document.createTextNode(t("chat.thinking", { n: 1 })));
        scroll.append(thinking);
        scrollToEnd();
        const raw = await cascade(cfg, { prompt: text });
        thinking.remove();
        const view = toCascadeView(raw);
        renderCascadeAnswer(scroll, view, t);
        renderCascadeInspector(inspectorBody, view, t);
      } else if (mode === "local") {
        // Lane-A local — governed (auto-allow), keyless, offline. Even an
        // auto-allowed action is audited so the ledger is a complete record.
        const localDetail: ActionDetail = { summary: t("gov.kindLocalDispatch") };
        const gate = await gateAction(deps, "local.dispatch", localDetail);
        if (!gate.ok) {
          renderErrorCard(scroll, gate.reason);
        } else {
          const host = resolveOllamaHost();
          const thinking = el("div", "thinking");
          thinking.append(el("span", "spinner"), document.createTextNode(t("chat.localThinking")));
          scroll.append(thinking);
          scrollToEnd();
          try {
            const model = await resolveOllamaModel(host, localModelInput.value.trim() || undefined);
            const res = await ollamaChat(host, model, text);
            thinking.remove();
            renderPlainAnswer(scroll, res.content, t);
            renderSourceInspector(inspectorBody, t("chat.localSource"), res.model, t);
            await deps.gov.settle("local.dispatch", "success", localDetail);
          } catch (e) {
            thinking.remove();
            if (e instanceof OllamaUnreachableError) {
              renderErrorCard(scroll, t("chat.localUnreachable", { host: e.host }));
            } else {
              renderErrorCard(scroll, String(e instanceof Error ? e.message : e));
            }
            await deps.gov.settle("local.dispatch", "error", localDetail);
          }
        }
        bumpActivity();
      } else if (mode === "direct") {
        // Lane-A direct — BYOK egress. GOVERNED: a human must approve before the
        // key leaves the box (the moat vs an allow-all host). The raw key is
        // fetched one-time only AFTER approval, and never reaches the DOM/audit.
        const providerRaw = directProviderSel.value;
        if (!isDirectProvider(providerRaw)) {
          renderErrorCard(scroll, t("chat.empty"));
        } else {
          const provider: DirectProvider = providerRaw;
          const directDetail: ActionDetail = { provider, summary: t("gov.kindDirectDispatch", { provider }) };
          const gate = await gateAction(deps, "direct.dispatch", directDetail);
          if (!gate.ok) {
            renderErrorCard(scroll, gate.reason);
          } else {
            // One-time raw key retrieval at dispatch — never rendered to the DOM.
            const apiKey = await deps.vault.get(provider);
            if (!apiKey) {
              renderErrorCard(scroll, t("chat.noKey", { provider }));
              await deps.gov.settle("direct.dispatch", "error", directDetail);
            } else {
              const model = resolveDirectModel(provider, directModelInput.value.trim() || undefined);
              const thinking = el("div", "thinking");
              thinking.append(el("span", "spinner"), document.createTextNode(t("chat.directThinking", { provider })));
              scroll.append(thinking);
              scrollToEnd();
              try {
                const res = await directChat(provider, apiKey, model, text);
                thinking.remove();
                renderPlainAnswer(scroll, res.content, t);
                renderSourceInspector(inspectorBody, t("chat.directSource", { provider }), res.model, t);
                await deps.gov.settle("direct.dispatch", "success", directDetail);
              } catch (e) {
                thinking.remove();
                const msg = e instanceof DirectApiError ? `${e.status} · ${e.message}` : String(e instanceof Error ? e.message : e);
                renderErrorCard(scroll, msg);
                await deps.gov.settle("direct.dispatch", "error", directDetail);
              }
            }
          }
        }
        bumpActivity();
      } else {
        const companyId = companyInput.value.trim();
        const stub = await startCompare(cfg, { companyId, query: text });
        const thinking = el("div", "thinking");
        const label = document.createTextNode(t("chat.thinking", { n: 2 }));
        thinking.append(el("span", "spinner"), label);
        scroll.append(thinking);
        scrollToEnd();
        const session = await pollCompare(cfg, stub.id, {
          onTick: (status) => {
            label.textContent =
              status === "PENDING" || status === "RUNNING"
                ? t("chat.thinking", { n: 2 })
                : t("chat.polling", { status });
          },
        });
        thinking.remove();
        const view = toCompareView(session);
        renderCompareAnswer(scroll, view, t);
        renderCompareInspector(inspectorBody, view, t);
      }
      void refreshSavings();
    } catch (e) {
      const msg = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
      const errCard = el("div", "msg-final");
      errCard.style.borderLeftColor = "var(--molten)";
      errCard.append(el("div", "msg-label", "error"), document.createTextNode(msg));
      scroll.append(errCard);
    } finally {
      sendBtn.disabled = false;
      scrollToEnd();
    }
  };

  sendBtn.addEventListener("click", () => void run());
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void run();
    }
  });
  newChatBtn.addEventListener("click", () => {
    scroll.innerHTML = "";
    inspectorBody.innerHTML = "";
    inspectorBody.append(el("div", "inspector-empty", t("inspector.empty")));
  });
  signOutBtn.addEventListener("click", () => {
    cfg.token = undefined;
    cfg.refreshToken = undefined;
    void deps.persist(cfg);
    deps.onSignedOut();
  });

  void refreshSavings();
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
    const approved = await showApprovalModal(deps, detail, res.reason);
    if (!approved) {
      await gov.reject(res.actionId);
      return { ok: false, reason: t("gov.rejectedByUser") };
    }
    const r = await gov.approve(res.actionId);
    token = r.token;
  }
  if (!token) return { ok: false, reason: t("gov.rejectedByUser") };
  const consumed = await gov.consume(token, kind, detail);
  // A failed consume (replay/forgery/mismatch) means the effect must NOT run.
  if (!consumed) return { ok: false, reason: t("gov.rejectedByUser") };
  return { ok: true };
}

/**
 * Arc-rim approval modal with a molten accent — the "coin-flip" moment where the
 * user decides. Blocks on a promise until Approve or Reject. The action summary
 * is the only thing shown; no secret ever reaches this surface.
 */
function showApprovalModal(deps: UiDeps, detail: ActionDetail, reason: string): Promise<boolean> {
  const { t, root } = deps;
  return new Promise<boolean>((resolve) => {
    const overlay = el("div", "approve-overlay");
    const card = el("div", "approve-card");
    const flip = el("div", "approve-flip"); // coin-flip micro-animation host
    flip.append(el("span", "approve-coin"));
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

    const close = (v: boolean) => {
      overlay.remove();
      resolve(v);
    };
    rejectBtn.addEventListener("click", () => close(false));
    approveBtn.addEventListener("click", () => close(true));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false); // click-outside = reject (fail-closed)
    });

    overlay.append(card);
    root.append(overlay);
    approveBtn.focus();
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
 * proven `forge spawn <vendor>` delegation — the interactive session runs in the
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
          // approves before Forge surfaces a command it could run for you.
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
    kv(t("chat.synthesis"), v.synthesisParsed ? "parsed" : "raw", !v.synthesisParsed),
  );
}
