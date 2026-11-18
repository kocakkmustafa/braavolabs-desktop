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

/** Paletteyi açmaya engel durumlar: palet zaten açık, ayarlar açık ya da onay/kill modalı (.approve-overlay) açık. */
export function paletteBlocked(s: { paletteOpen: boolean; settingsOpen: boolean; modalOpen: boolean }): boolean {
  return s.paletteOpen || s.settingsOpen || s.modalOpen;
}

/** Palet durumu (DOM'dan bağımsız): açık/kapalı, sorgu, etkin satır, Enter/ok tuşları. */
export function createPaletteController(opts: { commands: () => PaletteCommand[]; blocked: () => boolean; onChange?: () => void }) {
  let open = false, query = "", active = 0, all: PaletteCommand[] = [], shown: PaletteCommand[] = [];
  const refilter = () => { shown = filterCommands(all, query); active = 0; opts.onChange?.(); };
  return {
    isOpen: () => open,
    shown: () => shown,
    active: () => active,
    query: () => query,
    /** Engelliyse açmaz ve false döner. */
    open(): boolean { if (open || opts.blocked()) return false; open = true; query = ""; all = opts.commands(); refilter(); return true; },
    close() { if (!open) return; open = false; opts.onChange?.(); },
    setQuery(q: string) { query = q; refilter(); },
    setActive(i: number) { if (i >= 0 && i < shown.length && i !== active) { active = i; opts.onChange?.(); } },
    /** true: tuş palet tarafından işlendi (çağıran preventDefault eder). IME bileşimi sırasında Enter yok sayılır. */
    key(e: { key: string; isComposing?: boolean }): boolean {
      if (!open || e.isComposing) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const next = movePaletteIndex(active, shown.length, e.key);
        if (next === null) return true; active = next; opts.onChange?.(); return true;
      }
      if (e.key === "Enter") { const c = shown[active]; if (!c) return true; open = false; opts.onChange?.(); c.run(); return true; }
      return false;
    },
    /** Satıra tıklama. */
    choose(i: number) { const c = shown[i]; if (!open || !c) return; open = false; opts.onChange?.(); c.run(); },
  };
}
