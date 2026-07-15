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
import type { Translator } from "./i18n";

export interface UiDeps {
  root: HTMLElement;
  cfg: Config;
  t: Translator;
  /** Persist secrets after login/refresh/logout. */
  persist: (c: Config) => Promise<void> | void;
  onSignedOut: () => void;
}

type Mode = "compare" | "cascade";

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

  const spacer = el("div", "rail-spacer");

  const savingsCard = el("div", "savings-card");
  savingsCard.append(el("div", "rail-section-label", t("rail.savings")));
  const savingsAmount = el("div", "savings-amount", "—");
  const savingsSub = el("div", "savings-sub", t("rail.noSavings"));
  savingsCard.append(savingsAmount, savingsSub);

  const signOutBtn = el("button", "rail-btn", t("rail.signOut"));

  rail.append(brand, connSec, newChatBtn, memoryBtn, spacer, savingsCard, signOutBtn);

  // --- center chat ---
  const chat = el("div", "chat");
  const scroll = el("div", "chat-scroll");
  const composer = el("div", "composer");

  const hint = el("div", "composer-hint");
  hint.style.display = "none";

  const companyInput = el("input", "company-input") as HTMLInputElement;
  companyInput.placeholder = t("chat.companyId");
  companyInput.style.display = "none"; // only for compare mode

  const modeToggle = el("div", "mode-toggle");
  const cascadeBtn = el("button", undefined, t("chat.modeCascade"));
  const compareBtn = el("button", undefined, t("chat.modeCompare"));
  cascadeBtn.classList.add("active");
  const applyMode = (m: Mode) => {
    mode = m;
    cascadeBtn.classList.toggle("active", m === "cascade");
    compareBtn.classList.toggle("active", m === "compare");
    companyInput.style.display = m === "compare" ? "block" : "none";
  };
  cascadeBtn.addEventListener("click", () => applyMode("cascade"));
  compareBtn.addEventListener("click", () => applyMode("compare"));
  modeToggle.append(cascadeBtn, compareBtn);

  const topRow = el("div", "composer-row");
  topRow.append(modeToggle, companyInput);

  const ta = el("textarea") as HTMLTextAreaElement;
  ta.placeholder = t("chat.placeholder");
  const sendBtn = el("button", "send-btn", t("chat.send"));
  const bottomRow = el("div", "composer-row");
  bottomRow.append(ta, sendBtn);

  composer.append(hint, topRow, bottomRow);
  chat.append(scroll, composer);

  // --- right inspector ---
  const inspector = el("aside", "inspector");
  inspector.append(el("h2", undefined, t("inspector.title")));
  const inspectorBody = el("div");
  inspectorBody.append(el("div", "inspector-empty", t("inspector.empty")));
  inspector.append(inspectorBody);

  shell.append(rail, chat, inspector);
  root.append(shell);

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
