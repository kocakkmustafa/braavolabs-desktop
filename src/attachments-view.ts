/**
 * "+" menu, attachment chips and the notes around them (BRA-UI-09). Plain DOM, no network.
 * Every file name goes in through `textContent` or an attribute, never as markup.
 * Status is colour + icon + word: colour only touches the icon, the words stay in text colour.
 */
import {
  MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_TOTAL_BYTES, attachNoticeSeen, formatSize, inspectFile, isAttachError, isSecretName,
  markAttachNoticeSeen, readAttachment, type AttachError, type AttachStorage, type Attachment, type AttachmentTray, type PickedFile,
} from "./attachments";

type Translate = (key: string, vars?: Record<string, string | number>) => string;
type IconName = "plus" | "file" | "x" | "warn" | "lock" | "retry";

const SVG_NS = "http://www.w3.org/2000/svg";
const PATHS: Record<IconName, string[]> = {
  plus: ["M12 5v14", "M5 12h14"],
  file: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4", "M8 13h8", "M8 17h5"],
  x: ["M18 6 6 18", "M6 6l12 12"],
  warn: ["M5 3.5h14a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5Z", "M12 8v5", "M12 16.2h.01"],
  lock: ["M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z", "M7 11V7a5 5 0 0 1 10 0v4"],
  retry: ["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5"],
};

function icon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: String(size), height: String(size), fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  for (const d of PATHS[name]) { const p = document.createElementNS(SVG_NS, "path"); p.setAttribute("d", d); svg.append(p); }
  return svg;
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function button(cls: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = make("button", cls, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

// ── chips ────────────────────────────────────────────────────────────────────
function chip(name: string, size: number, locale: string, remove: HTMLButtonElement | null): HTMLElement {
  const c = make("span", "att-chip");
  c.append(icon("file", 15), make("span", "att-nm", name), make("span", "att-sz mono", formatSize(size, locale)));
  if (remove) c.append(remove);
  return c;
}

export function renderChips(host: HTMLElement, items: readonly Attachment[], t: Translate, locale: string, onRemove: (id: number) => void): void {
  host.replaceChildren();
  host.hidden = items.length === 0;
  for (const a of items) {
    const rm = make("button", "att-rm");
    rm.type = "button";
    rm.setAttribute("aria-label", t("attach.chipRemove", { name: a.name }));
    rm.title = t("attach.chipRemove", { name: a.name });
    rm.append(icon("x", 14));
    rm.addEventListener("click", () => onRemove(a.id));
    host.append(chip(a.name, a.size, locale, rm));
  }
}

/** Chips shown under the user's message in the chat: names and sizes only, never the content. */
export function renderSentChips(items: ReadonlyArray<Pick<Attachment, "name" | "size">>, t: Translate, locale: string): HTMLElement {
  const row = make("div", "att-sent");
  row.setAttribute("aria-label", t("attach.chipsLabel"));
  for (const a of items) row.append(chip(a.name, a.size, locale, null));
  return row;
}

// ── notes ────────────────────────────────────────────────────────────────────
interface NoteButton { label: string; primary?: boolean; onClick: () => void }
interface NoteSpec { tone: "err" | "info"; icon: IconName; title?: string; text: string; buttons: NoteButton[]; closable?: boolean }

function renderNote(host: HTMLElement, spec: NoteSpec, t: Translate): void {
  host.replaceChildren();
  host.hidden = false;
  const row = make("div", `att-note att-${spec.tone}`);
  row.setAttribute("role", spec.tone === "err" ? "alert" : "note");
  const badge = make("span", "att-badge");
  badge.append(icon(spec.icon, 18));
  const txt = make("span", "att-txt");
  if (spec.title) {
    const w = make("span", "att-word", spec.title);
    if (spec.tone === "err") w.append(make("span", "att-st", `■ ${t("now.error")}`));
    txt.append(w);
  }
  txt.append(make("span", "att-cap", spec.text));
  const acts = make("span", "att-acts");
  for (const b of spec.buttons) acts.append(button(`att-btn${b.primary ? " att-primary" : " att-ghost"}`, b.label, b.onClick));
  row.append(badge, txt, acts);
  host.append(row);
}

const clearNote = (host: HTMLElement) => { host.replaceChildren(); host.hidden = true; };

// ── controller ───────────────────────────────────────────────────────────────
export interface AttachUiDeps {
  t: Translate;
  tray: AttachmentTray;
  locale(): string;
  storage?: AttachStorage;
  /** Replaceable in tests. */
  read?: (file: PickedFile) => Promise<Attachment | AttachError>;
}
export interface AttachUi {
  /** The "+" button with its menu: goes first in the composer's bottom row. */
  anchor: HTMLElement;
  plusButton: HTMLButtonElement;
  menu: HTMLElement;
  /** Errors, the secret-name question and the first-use notice. */
  noteHost: HTMLElement;
  chipsHost: HTMLElement;
  menuOpen(): boolean;
  openMenu(): void;
  closeMenu(): void;
  /** Same path the file input takes. */
  handleFiles(files: PickedFile[]): Promise<void>;
  dispose(): void;
}

export function createAttachUi(deps: AttachUiDeps): AttachUi {
  const { t, tray } = deps;
  const read = deps.read ?? readAttachment;
  let disposed = false;
  const maxFile = formatSize(MAX_ATTACHMENT_BYTES, deps.locale());

  const anchor = make("div", "att-anchor");
  const plusButton = make("button", "att-plus");
  plusButton.type = "button";
  plusButton.title = t("attach.button");
  plusButton.setAttribute("aria-label", t("attach.button"));
  plusButton.setAttribute("aria-haspopup", "menu");
  plusButton.setAttribute("aria-expanded", "false");
  plusButton.append(icon("plus", 15));

  const menu = make("div", "att-menu");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", t("attach.menuLabel"));
  menu.hidden = true;
  const item = make("button", "att-item");
  item.type = "button";
  item.setAttribute("role", "menuitem");
  const itemText = make("span", "att-item-t");
  itemText.append(make("span", undefined, t("attach.menuFile")), make("span", "att-item-sub", t("attach.menuFileHint", { max: maxFile })));
  item.append(icon("file", 18), itemText);
  menu.append(item, make("div", "att-menu-note", t("attach.menuTypes")));
  anchor.append(plusButton, menu);

  const noteHost = make("div", "att-note-host");
  noteHost.hidden = true;
  const chipsHost = make("div", "att-chips");
  chipsHost.setAttribute("role", "list");
  chipsHost.setAttribute("aria-label", t("attach.chipsLabel"));
  chipsHost.hidden = true;

  const input = make("input");
  input.type = "file";
  input.multiple = true;
  input.hidden = true;
  input.setAttribute("tabindex", "-1");
  input.setAttribute("aria-hidden", "true");
  anchor.append(input);

  let open = false;
  const onDocClick = (e: Event) => { if (open && !anchor.contains(e.target as Node)) closeMenu(false); };
  function closeMenu(refocus = true) {
    if (!open) return;
    open = false;
    menu.hidden = true;
    plusButton.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDocClick);
    if (refocus) plusButton.focus();
  }
  function openMenu() {
    if (open || disposed) return;
    open = true;
    menu.hidden = false;
    plusButton.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onDocClick);
    item.focus();
  }
  const pick = () => { closeMenu(false); input.click(); };

  plusButton.addEventListener("click", () => (open ? closeMenu() : openMenu()));
  plusButton.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); openMenu(); }
    else if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); closeMenu(); }
  });
  menu.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") { e.preventDefault(); item.focus(); }
    else if (e.key === "Tab") closeMenu(false);
  });
  item.addEventListener("click", pick);

  const sync = () => {
    if (disposed) return;
    renderChips(chipsHost, tray.items(), t, deps.locale(), id => { tray.remove(id); });
    for (const c of chipsHost.children ?? []) c.setAttribute("role", "listitem");
  };
  tray.subscribe(sync);

  const errorNote = (e: AttachError, retry?: () => void) => {
    const vars = { name: e.name, size: formatSize(e.size, deps.locale()), max: maxFile, total: formatSize(MAX_TOTAL_BYTES, deps.locale()), n: MAX_ATTACHMENTS };
    const key = { tooBig: "errTooBig", unsupported: "errUnsupported", unreadable: "errUnreadable", tooMany: "errTooMany", total: "errTotal" }[e.kind];
    const buttons: NoteButton[] = [{ label: t("attach.close"), onClick: () => clearNote(noteHost) }];
    if (retry) buttons.push({ label: t("attach.retry"), primary: true, onClick: retry });
    else if (e.kind !== "tooMany") buttons.push({ label: t("attach.chooseOther"), primary: true, onClick: () => { clearNote(noteHost); input.click(); } });
    renderNote(noteHost, { tone: "err", icon: "warn", title: t(`attach.${key}`), text: t(`attach.${key}Hint`, vars), buttons }, t);
  };

  const askSecret = (name: string): Promise<boolean> => new Promise(resolve => {
    renderNote(noteHost, {
      tone: "err", icon: "lock", title: t("attach.secretTitle"), text: name,
      buttons: [
        { label: t("attach.cancel"), onClick: () => { clearNote(noteHost); resolve(false); } },
        { label: t("attach.secretAdd"), primary: true, onClick: () => { clearNote(noteHost); resolve(true); } },
      ],
    }, t);
  });

  const showNoticeOnce = () => {
    if (attachNoticeSeen(deps.storage)) return;
    const dismiss = () => clearNote(noteHost);
    renderNote(noteHost, { tone: "info", icon: "lock", text: t("attach.notice"), buttons: [{ label: t("attach.noticeOk"), onClick: dismiss }] }, t);
    markAttachNoticeSeen(deps.storage);
  };

  async function addOne(file: PickedFile): Promise<void> {
    const err = inspectFile(file, tray);
    if (err) { errorNote(err); return; }
    // A secret-looking name is asked about BEFORE the file is read: declined = the content is never loaded.
    if (isSecretName(file.name) && !(await askSecret(file.name.split(/[\\/]/).pop() ?? file.name))) return;
    if (disposed) return;
    const res = await read(file);
    if (disposed) return;
    if (isAttachError(res)) { errorNote(res, res.kind === "unreadable" ? () => { clearNote(noteHost); void addOne(file); } : undefined); return; }
    // The tray may have filled up while the secret question or the read was pending.
    const late = inspectFile({ name: res.name, size: res.size, type: "text/plain" }, tray);
    if (late) { errorNote(late); return; }
    clearNote(noteHost);
    tray.add(res);
    showNoticeOnce();
  }

  const handleFiles = async (files: PickedFile[]) => { for (const f of files) { if (disposed) return; await addOne(f); } };
  input.addEventListener("change", () => {
    const files = Array.from((input as HTMLInputElement).files ?? []) as PickedFile[];
    input.value = "";
    void handleFiles(files);
  });

  return {
    anchor, plusButton, menu, noteHost, chipsHost, handleFiles, openMenu, closeMenu: () => closeMenu(), menuOpen: () => open,
    dispose() { disposed = true; closeMenu(false); },
  };
}
