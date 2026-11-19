/**
 * "Yayına hazırla" screens (BRA-UI-10): the button under the changes list, the hand-over screen, the in-app
 * confirmation, the GitHub key dialog, progress, done and the error cards. Plain DOM. Every name, title, path and
 * message goes in through `textContent`, never as markup. Status is glyph + word + colour; colour only touches the glyph.
 *
 * The in-app confirmation is a preview. The authority is the host's native dialog, which each step (commit, push, PR)
 * passes in `runPublish`; nothing is written or sent before it. See publish.ts.
 */
import type { Governance } from "./governance";
import type { ChangeView } from "./changes";
import {
  draftProblems, errorCode, publishSummary, runPublish, suggestBranch,
  type PublishDraft, type PublishErrorCode, type PublishFailure, type PublishInfo, type PublishStep,
} from "./publish";

type Translate = (key: string, vars?: Record<string, string | number>) => string;
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface PublishUiDeps {
  t: Translate;
  invoke: Invoke;
  gov: Governance;
  cwd: () => string;
  views: () => ChangeView[];
  /** Hides/shows the plain changes list while a publish screen is open. */
  setListHidden: (hidden: boolean) => void;
  /** Focus containment for the two modals (ui.ts `containDialog`). */
  contain: (card: HTMLElement, dismiss: () => void) => () => void;
  copy?: (text: string) => Promise<void>;
}
export interface PublishUi { button: HTMLButtonElement; note: HTMLElement; panel: HTMLElement; sync(): void }

function make<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function btn(cls: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = make("button", cls, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}
const GLYPH = { done: "✓", run: "●", wait: "○", err: "■", ask: "◆" } as const;
function status(kind: keyof typeof GLYPH, word: string): HTMLElement {
  const s = make("span", `pb-status pb-${kind}`);
  s.append(make("span", "pb-glyph", GLYPH[kind]), make("span", "pb-word", word));
  return s;
}

/** Host error code to its message key. Literal keys, so the unused-key test can see every one. */
function errorKey(code: PublishErrorCode): string {
  switch (code) {
    case "pushRejected": return "publish.err.pushRejected";
    case "network": return "publish.err.network";
    case "noWriteAccess": return "publish.err.noWriteAccess";
    case "unauthorized": case "noPat": return "publish.err.unauthorized";
    case "notFound": return "publish.err.notFound";
    case "rateLimit": return "publish.err.rateLimit";
    case "conflict": return "publish.err.conflict";
    case "branchExists": return "publish.err.branchExists";
    case "identity": return "publish.err.identity";
    case "commitFailed": return "publish.err.commitFailed";
    case "wrongBranch": return "publish.err.wrongBranch";
    case "nothingToPublish": return "publish.err.nothingToPublish";
    case "tooMany": return "publish.err.tooMany";
    case "unsafeConfig": return "publish.err.unsafeConfig";
    case "cancelled": return "publish.err.cancelled";
    case "keychainUnavailable": return "publish.err.keychain";
    case "invalidBranch": case "invalidText": case "secretFile": return "publish.err.invalid";
    case "notGithub": return "publish.noRepo";
    default: return "publish.err.unknown";
  }
}
const KEY_CODES: ReadonlySet<PublishErrorCode> = new Set(["unauthorized", "noWriteAccess", "noPat", "notFound"]);

export function createPublishUi(deps: PublishUiDeps): PublishUi {
  const { t } = deps;
  const button = btn("set-btn primary pb-open", t("publish.button"), () => void open());
  const note = make("div", "changes-empty pb-none", t("publish.none"));
  const panel = make("div", "pb-panel");
  panel.hidden = true;

  let draft: PublishDraft = { branch: "", title: "", body: "", draft: false };
  let info: PublishInfo = { branch: null, repo: null, base: "main" };
  let files: string[] = [];
  let branchTouched = false;
  let running = false;

  const show = (...nodes: Node[]) => { panel.replaceChildren(...nodes); panel.hidden = false; deps.setListHidden(true); };
  const close = () => { if (running) return; panel.replaceChildren(); panel.hidden = true; deps.setListHidden(false); };

  function sync() {
    const n = deps.views().length;
    button.disabled = n === 0 || running;
    note.hidden = n !== 0;
    button.hidden = n === 0 && false;
  }

  function header(title: string, back: boolean): HTMLElement {
    const h = make("div", "pb-head");
    if (back) h.append(btn("pb-back", t("publish.back"), close));
    h.append(make("h3", "pb-title", title));
    return h;
  }

  async function open() {
    const cwd = deps.cwd();
    const views = deps.views();
    if (!cwd || views.length === 0) return;
    try { info = (await deps.invoke("git_publish_info", { cwd })) as PublishInfo; } catch { info = { branch: null, repo: null, base: "main" }; }
    const sum = publishSummary(views);
    files = views.map(v => v.path);
    if (!info?.repo) return showError("notGithub", "commit", false);
    if (sum.secrets.length) return showSecrets(sum.secrets);
    const names = views.slice(0, 3).map(v => v.file).join(", ");
    draft = { branch: suggestBranch(names), title: names, body: "", draft: false };
    branchTouched = false;
    showPrepare(views);
  }

  function showSecrets(names: string[]) {
    const card = make("div", "pb-card pb-warn");
    card.setAttribute("role", "alert");
    card.append(status("err", t("publish.secretTitle")), make("p", "pb-text", t("publish.secretText", { names: names.slice(0, 5).join(", ") + (names.length > 5 ? ` +${names.length - 5}` : "") })));
    show(header(t("publish.title"), true), card, make("div", "pb-actions", undefined));
    panel.lastElementChild?.append(btn("set-btn", t("publish.cancel"), close));
  }

  function field(label: string, tag?: string): { wrap: HTMLElement; err: HTMLElement; head: HTMLElement } {
    const wrap = make("label", "pb-field");
    const head = make("span", "pb-label", label);
    if (tag) head.append(make("span", "pb-tag", tag));
    const err = make("span", "pb-err");
    err.setAttribute("role", "alert");
    wrap.append(head);
    return { wrap, err, head };
  }

  function showPrepare(views: ChangeView[], problems: string[] = []) {
    const sum = publishSummary(views);
    const summary = make("div", "pb-summary");
    const counts = make("div", "pb-line mono");
    counts.append(make("span", undefined, t("publish.filesChanged", { n: sum.files })), document.createTextNode("  "), make("span", "diff-add", `+${sum.added}`), document.createTextNode(" "), make("span", "diff-del", `−${sum.removed}`));
    summary.append(counts, make("div", "pb-line", t("publish.testsUnknown")));

    const b = field(t("publish.branch"), t("publish.branchAuto"));
    const branchIn = make("input", "pb-input mono"); branchIn.type = "text"; branchIn.value = draft.branch; branchIn.maxLength = 100; branchIn.spellcheck = false;
    b.wrap.append(branchIn, b.err);
    const ti = field(t("publish.prTitle"));
    const titleIn = make("input", "pb-input"); titleIn.type = "text"; titleIn.value = draft.title; titleIn.maxLength = 200;
    ti.wrap.append(titleIn, ti.err);
    const bo = field(t("publish.prBody"));
    const bodyIn = make("textarea", "pb-input pb-area"); bodyIn.value = draft.body; bodyIn.rows = 3; bodyIn.maxLength = 4000;
    bo.wrap.append(bodyIn, bo.err);
    const dr = make("label", "pb-check");
    const drIn = make("input"); drIn.type = "checkbox"; drIn.checked = draft.draft;
    dr.append(drIn, make("span", undefined, t("publish.draft")));

    const read = (): PublishDraft => ({ branch: branchIn.value.trim(), title: titleIn.value, body: bodyIn.value, draft: drIn.checked });
    branchIn.addEventListener("input", () => { branchTouched = true; });
    titleIn.addEventListener("input", () => { if (!branchTouched) { branchIn.value = suggestBranch(titleIn.value); } });
    const mark = (p: string[]) => {
      b.err.textContent = p.includes("branch") ? t("publish.branchBad") : "";
      ti.err.textContent = p.includes("title") ? t("publish.titleBad") : "";
      bo.err.textContent = p.includes("body") ? t("publish.bodyBad") : "";
      branchIn.setAttribute("aria-invalid", String(p.includes("branch")));
      titleIn.setAttribute("aria-invalid", String(p.includes("title")));
    };
    mark(problems);

    const info1 = make("div", "pb-info");
    info1.append(make("span", "pb-glyph", "ⓘ"), make("span", undefined, t("publish.notSent")));
    const actions = make("div", "pb-actions");
    actions.append(btn("set-btn", t("publish.cancel"), close), btn("set-btn primary", t("publish.continue"), () => {
      draft = read();
      const p = draftProblems(draft);
      mark(p);
      if (p.length) return;
      void proceed();
    }));
    show(header(t("publish.title"), true), summary, b.wrap, ti.wrap, bo.wrap, dr, info1, actions);
    titleIn.focus();
  }

  async function proceed() {
    let connected = false;
    try { connected = ((await deps.invoke("github_pat_status")) as { connected?: boolean })?.connected === true; } catch { connected = false; }
    if (!connected) return connectDialog(() => confirmDialog());
    confirmDialog();
  }

  function overlay(card: HTMLElement, onClose: () => void): () => void {
    const ov = make("div", "approve-overlay");
    ov.append(card);
    document.body.append(ov);
    const release = deps.contain(card, () => end());
    const end = () => { release(); ov.remove(); onClose(); };
    card.focus();
    return end;
  }

  function confirmDialog() {
    const card = make("div", "approve-card pb-modal");
    const title = make("h3", "approve-title", t("publish.confirmTitle"));
    const chip = status("ask", t("publish.pending"));
    const intro = make("div", "approve-body", t("publish.confirmIntro"));
    const kv = make("div", "approve-detail");
    const row = (k: string, v: string, mono = false) => { const r = make("div", "approve-kv"); r.append(make("span", "approve-k", k), make("span", `approve-v${mono ? " mono" : ""}`, v)); kv.append(r); };
    row(t("publish.repo"), info.repo ?? "", true);
    row(t("publish.branchRow"), `${draft.branch.trim()} → ${info.base}`, true);
    row(t("publish.prTitle"), draft.title.trim());
    row(t("publish.filesRow"), t("publish.filesChanged", { n: files.length }));
    const warn = make("div", "pb-info");
    warn.append(make("span", "pb-glyph", "▲"), make("span", undefined, t("publish.warn")));
    const btns = make("div", "approve-btns");
    let end = () => {};
    const cancel = btn("approve-reject", t("publish.cancel"), () => end());
    const ok = btn("approve-approve", t("publish.confirm"), () => { end(); void start("commit"); });
    btns.append(cancel, ok);
    card.append(title, chip, intro, kv, warn, btns);
    end = overlay(card, () => {});
    ok.focus();
  }

  function connectDialog(then: () => void) {
    const card = make("div", "approve-card pb-modal");
    const input = make("input", "pb-input mono"); input.type = "password"; input.autocomplete = "off"; input.spellcheck = false; input.maxLength = 255;
    input.placeholder = t("publish.keyPlaceholder");
    input.setAttribute("aria-label", t("publish.keyLabel"));
    const err = make("div", "pb-err"); err.setAttribute("role", "alert");
    const lab = make("div", "pb-label", t("publish.keyLabel"));
    const noteEl = make("div", "pb-info");
    noteEl.append(make("span", "pb-glyph", "ⓘ"), make("span", undefined, t("publish.keyNote")));
    let end = () => {};
    const cancel = btn("approve-reject", t("publish.cancel"), () => end());
    const save = btn("approve-approve", t("publish.keyConnect"), async () => {
      const value = input.value;
      input.value = ""; // the field never keeps it; the host stores it in the OS keychain
      err.textContent = "";
      try {
        await deps.invoke("github_pat_set", { pat: value });
        end();
        then();
      } catch (e) {
        const c = errorCode(e);
        err.textContent = c === "keychainUnavailable" ? t("publish.err.keychain") : t("publish.keyBad");
      }
    });
    const btns = make("div", "approve-btns");
    btns.append(cancel, save);
    card.append(make("h3", "approve-title", t("publish.connectTitle")), status("ask", t("publish.pending")), make("div", "approve-body", t("publish.connectText")), lab, input, err, noteEl, btns);
    end = overlay(card, () => {});
    input.focus();
  }

  const STEPS: PublishStep[] = ["commit", "push", "pr"];
  function showProgress(state: Record<PublishStep, "wait" | "run" | "done">) {
    const list = make("div", "pb-steps");
    const label: Record<PublishStep, string> = { commit: t("publish.stepCommit"), push: t("publish.stepPush"), pr: t("publish.stepPr") };
    for (const s of STEPS) {
      const row = make("div", "pb-step");
      const st = state[s];
      row.append(status(st === "done" ? "done" : st === "run" ? "run" : "wait", st === "done" ? t("publish.stateDone") : st === "run" ? t("publish.stateRun") : t("publish.stateWait")), make("span", "pb-step-name", label[s]));
      list.append(row);
    }
    const keep = make("div", "pb-info");
    keep.append(make("span", "pb-glyph", "ⓘ"), make("span", undefined, t("publish.keepOpen")));
    show(header(t("publish.progressTitle"), false), list, keep);
  }

  async function start(from: PublishStep) {
    running = true;
    sync();
    const state: Record<PublishStep, "wait" | "run" | "done"> = { commit: "wait", push: "wait", pr: "wait" };
    for (const s of STEPS.slice(0, STEPS.indexOf(from))) state[s] = "done";
    showProgress(state);
    const res = await runPublish({
      invoke: deps.invoke, gov: deps.gov,
      onStep: (s, st) => { state[s] = st; showProgress(state); },
    }, { cwd: deps.cwd(), info, draft, files, from });
    running = false;
    sync();
    if (res.ok) return showDone(res.number, res.url);
    showError(res.code, res.step, true, res);
  }

  function showDone(number: number, url: string) {
    const card = make("div", "pb-card");
    card.append(status("done", t("publish.doneTitle")), make("span", "pb-sub", ` · ${t("publish.doneSub")}`));
    const pr = make("div", "pb-line");
    pr.append(make("span", "mono", `#${number}`), document.createTextNode(` · ${draft.title.trim()}`));
    const br = make("div", "pb-line mono", `${draft.branch.trim()} → ${info.base}`);
    const link = make("div", "pb-line mono pb-url", url);
    const copied = make("span", "pb-copied"); copied.setAttribute("role", "status");
    const actions = make("div", "pb-actions");
    actions.append(
      btn("set-btn primary", t("publish.copy"), async () => {
        try { await (deps.copy ?? ((s: string) => navigator.clipboard.writeText(s)))(url); copied.textContent = t("publish.copied"); } catch { copied.textContent = ""; }
      }),
      btn("set-btn", t("publish.close"), close), copied,
    );
    card.append(pr, br, link, make("div", "pb-info", t("publish.doneNote")));
    show(header(t("publish.title"), false), card, actions);
    refreshList();
  }

  function showError(code: PublishErrorCode, step: PublishStep, retry: boolean, fail?: PublishFailure) {
    const card = make("div", "pb-card pb-failed");
    card.setAttribute("role", "alert");
    card.append(status("err", t("publish.errLabel")), make("p", "pb-text", t(errorKey(code))));
    const actions = make("div", "pb-actions");
    actions.append(btn("set-btn", t("publish.close"), () => { close(); refreshList(); }));
    if (KEY_CODES.has(code)) actions.append(btn("set-btn", t("publish.keyUpdate"), () => connectDialog(() => void start(fail?.step ?? step))));
    if (retry && step === "commit" && code !== "cancelled" && code !== "identity") actions.append(btn("set-btn", t("publish.changeBranch"), () => showPrepare(deps.views())));
    if (retry) actions.append(btn("set-btn primary", t("publish.retry"), () => void start(fail?.step ?? step)));
    show(header(t("publish.title"), false), card, actions);
  }

  function refreshList() { /* the host list re-reads on its own refresh button; nothing to do here */ }

  return { button, note, panel, sync };
}
