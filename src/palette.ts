/** Komut paleti (⌘K / Ctrl+K) saf mantığı: kısayol tanıma, süzme, klavye gezintisi. */
export interface PaletteCommand { id: string; label: string; hint?: string; run: () => void }

export function isPaletteShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}

/** Büyük/küçük harf duyarsız; başta eşleşen önce, sonra içinde geçen. Boş sorgu hepsini verir. */
const norm = (v: string) => v.toLowerCase().normalize("NFD").replace(/\u0307/g, "").normalize("NFC");

export function filterCommands<T extends { label: string }>(cmds: readonly T[], query: string): T[] {
  const q = norm(query.trim());
  if (!q) return [...cmds];
  const starts: T[] = [], inside: T[] = [];
  for (const c of cmds) {
    const l = norm(c.label);
    if (l.startsWith(q)) starts.push(c); else if (l.includes(q)) inside.push(c);
  }
  return [...starts, ...inside];
}

/** Liste içi gezinti: aşağı/yukarı döner, Home/End uçlara gider; başka tuş null. */
export function movePaletteIndex(index: number, length: number, key: string): number | null {
  if (length <= 0) return null;
  if (key === "ArrowDown") return (index + 1) % length;
  if (key === "ArrowUp") return (index - 1 + length) % length;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  return null;
}
