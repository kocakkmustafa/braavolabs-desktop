/**
 * Bildirim / toast bileşeni (D7). Durum = renk + simge + sözcük.
 * Hata toast'ı (role=alert) kullanıcı kapatana dek kalır ve ASLA sınır yüzünden atılmaz:
 * aynı metinli hatalar tek toast'ta "×n" sayacıyla birleşir; sınır (TOAST_MAX) aşılırsa
 * en eski BİLGİ/tamam toast'ı atılır. Bilgi/tamam (role=status) TOAST_TTL_MS sonra kapanır.
 */
export type ToastKind = "info" | "done" | "error";
export const TOAST_GLYPH: Record<ToastKind, string> = { info: "●", done: "✓", error: "■" };
export const TOAST_TTL_MS = 5000;
export const TOAST_MAX = 4;

interface ToastNode {
  className: string; textContent: string | null;
  append(...n: unknown[]): void; remove(): void; setAttribute(k: string, v: string): void;
  addEventListener(t: string, f: () => void): void;
}
export interface ToastDoc { createElement(tag: string): ToastNode; host(): ToastNode }

export function createToaster(doc: ToastDoc, words: Record<ToastKind, string>, dismissLabel: string, setTimer: (f: () => void, ms: number) => unknown = setTimeout) {
  const live: Array<{ node: ToastNode; kind: ToastKind; text: string; n: number; body: ToastNode }> = [];
  const dismissEntry = (entry: (typeof live)[number]) => { const i = live.indexOf(entry); if (i < 0) return; live.splice(i, 1); entry.node.remove(); };
  return {
    count: () => live.length,
    show(kind: ToastKind, text: string): () => void {
      if (kind === "error") {
        const same = live.find(e => e.kind === "error" && e.text === text);
        if (same) { same.n += 1; same.body.textContent = `${text} ×${same.n}`; return () => dismissEntry(same); }
      }
      const node = doc.createElement("div");
      node.className = `toast toast-${kind}`;
      node.setAttribute("role", kind === "error" ? "alert" : "status");
      const glyph = doc.createElement("span"); glyph.className = "toast-glyph"; glyph.textContent = TOAST_GLYPH[kind]; glyph.setAttribute("aria-hidden", "true");
      const word = doc.createElement("b"); word.className = "toast-word"; word.textContent = words[kind];
      const body = doc.createElement("span"); body.className = "toast-text"; body.textContent = text;
      const close = doc.createElement("button"); close.className = "toast-close"; close.textContent = "×"; close.setAttribute("aria-label", dismissLabel); close.setAttribute("type", "button");
      node.append(glyph, word, body, close);
      const entry = { node, kind, text, n: 1, body };
      const dismiss = () => dismissEntry(entry);
      close.addEventListener("click", dismiss);
      live.push(entry);
      doc.host().append(node);
      while (live.length > TOAST_MAX) {
        const evict = live.find(e => e.kind !== "error");
        if (!evict) break; // yalnız hata kaldı: hiçbiri görülmeden atılmaz
        dismissEntry(evict);
      }
      if (kind !== "error") setTimer(dismiss, TOAST_TTL_MS);
      return dismiss;
    },
  };
}
