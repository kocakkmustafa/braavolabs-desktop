/**
 * Bildirim / toast bileşeni (D7). Durum = renk + simge + sözcük. Hata toast'ı kullanıcı
 * kapatana dek kalır (role=alert); bilgi/tamam kısa süre kalır (role=status).
 */
export type ToastKind = "info" | "done" | "error";
export const TOAST_GLYPH: Record<ToastKind, string> = { info: "●", done: "✓", error: "■" };
export const TOAST_TTL_MS = 5000;
export const TOAST_MAX = 4;

interface ToastNode {
  className: string; textContent: string | null; hidden?: boolean;
  append(...n: unknown[]): void; remove(): void; setAttribute(k: string, v: string): void;
  addEventListener(t: string, f: () => void): void; children?: unknown;
}
export interface ToastDoc { createElement(tag: string): ToastNode; host(): ToastNode }

export function createToaster(doc: ToastDoc, words: Record<ToastKind, string>, dismissLabel: string, setTimer: (f: () => void, ms: number) => unknown = setTimeout) {
  const live: Array<{ node: ToastNode }> = [];
  return {
    count: () => live.length,
    show(kind: ToastKind, text: string): () => void {
      const node = doc.createElement("div");
      node.className = `toast toast-${kind}`;
      node.setAttribute("role", kind === "error" ? "alert" : "status");
      const glyph = doc.createElement("span"); glyph.className = "toast-glyph"; glyph.textContent = TOAST_GLYPH[kind]; glyph.setAttribute("aria-hidden", "true");
      const word = doc.createElement("b"); word.className = "toast-word"; word.textContent = words[kind];
      const body = doc.createElement("span"); body.className = "toast-text"; body.textContent = text;
      const close = doc.createElement("button"); close.className = "toast-close"; close.textContent = "×"; close.setAttribute("aria-label", dismissLabel); close.setAttribute("type", "button");
      node.append(glyph, word, body, close);
      const entry = { node };
      const dismiss = () => { const i = live.indexOf(entry); if (i < 0) return; live.splice(i, 1); node.remove(); };
      close.addEventListener("click", dismiss);
      live.push(entry);
      doc.host().append(node);
      while (live.length > TOAST_MAX) { const old = live.shift()!; old.node.remove(); }
      if (kind !== "error") setTimer(dismiss, TOAST_TTL_MS);
      return dismiss;
    },
  };
}
