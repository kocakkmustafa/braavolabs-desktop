import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { createPaletteController, filterCommands, isPaletteShortcut, movePaletteIndex, paletteBlocked } from "../palette";
import { createToaster, TOAST_MAX, TOAST_TTL_MS } from "../toast";
import { createTheme, THEME_KEY } from "../theme";

// Repoda DOM kütüphanesi (jsdom/happy-dom) yok; denetleyiciler gerçek modüllerdir, düğümler sahtedir.

it("⌘K ve Ctrl+K paleti açar; Alt/Shift ile ya da başka tuşla açmaz", () => {
  const e = (o: object) => ({ key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
  expect(isPaletteShortcut(e({ metaKey: true }))).toBe(true);
  expect(isPaletteShortcut(e({ ctrlKey: true, key: "K" }))).toBe(true);
  expect(isPaletteShortcut(e({}))).toBe(false);
  expect(isPaletteShortcut(e({ ctrlKey: true, shiftKey: true }))).toBe(false);
  expect(isPaletteShortcut(e({ ctrlKey: true, key: "j" }))).toBe(false);
});

it("komutlar süzülür: baştan eşleşen önce, Türkçe büyük/küçük harf doğru", () => {
  const cmds = [{ label: "Ayarlar" }, { label: "Yeni sohbet" }, { label: "Sohbet yüzeyi" }, { label: "İçerik" }];
  expect(filterCommands(cmds, "").length).toBe(4);
  expect(filterCommands(cmds, "sohbet").map(c => c.label)).toEqual(["Sohbet yüzeyi", "Yeni sohbet"]);
  expect(filterCommands(cmds, "içerik").map(c => c.label)).toEqual(["İçerik"]);
  expect(filterCommands(cmds, "zzz")).toEqual([]);
});

it("liste gezintisi döner ve uçlara gider", () => {
  expect(movePaletteIndex(0, 3, "ArrowDown")).toBe(1);
  expect(movePaletteIndex(2, 3, "ArrowDown")).toBe(0);
  expect(movePaletteIndex(0, 3, "ArrowUp")).toBe(2);
  expect(movePaletteIndex(1, 3, "End")).toBe(2);
  expect(movePaletteIndex(0, 0, "ArrowDown")).toBeNull();
});

function palette(blocked = { v: false }) {
  const run = { new: vi.fn(), settings: vi.fn() };
  const onChange = vi.fn();
  const ctl = createPaletteController({
    commands: () => [{ id: "new", label: "Yeni sohbet", run: run.new }, { id: "settings", label: "Ayarlar", run: run.settings }],
    blocked: () => blocked.v, onChange,
  });
  return { ctl, run, onChange, blocked };
}

it("palet denetleyicisi: açılır, sorguyla süzülür, ok tuşlarıyla gezilir, Enter çalıştırıp kapatır", () => {
  const { ctl, run } = palette();
  expect(ctl.open()).toBe(true); expect(ctl.isOpen()).toBe(true); expect(ctl.shown().length).toBe(2);
  expect(ctl.open()).toBe(false); // zaten açık
  expect(ctl.key({ key: "ArrowDown" })).toBe(true); expect(ctl.active()).toBe(1);
  ctl.setQuery("yeni"); expect(ctl.shown().map(c => c.id)).toEqual(["new"]); expect(ctl.active()).toBe(0);
  ctl.setQuery("zzz"); expect(ctl.shown()).toEqual([]); expect(ctl.key({ key: "Enter" })).toBe(true); expect(run.new).not.toHaveBeenCalled(); expect(ctl.isOpen()).toBe(true);
  ctl.setQuery(""); expect(ctl.key({ key: "Enter" })).toBe(true);
  expect(run.new).toHaveBeenCalledOnce(); expect(ctl.isOpen()).toBe(false);
  expect(ctl.key({ key: "ArrowDown" })).toBe(false); // kapalıyken tuş işlenmez
});

it("IME bileşimi sırasında Enter komutu çalıştırmaz", () => {
  const { ctl, run } = palette(); ctl.open();
  expect(ctl.key({ key: "Enter", isComposing: true })).toBe(false); expect(run.new).not.toHaveBeenCalled(); expect(ctl.isOpen()).toBe(true);
});

it("Escape/dış tıklama close() ile kapatır; satır tıklaması komutu çalıştırır", () => {
  const { ctl, run } = palette(); ctl.open(); ctl.close(); expect(ctl.isOpen()).toBe(false);
  ctl.open(); ctl.choose(1); expect(run.settings).toHaveBeenCalledOnce(); expect(ctl.isOpen()).toBe(false);
});

it("onay/kill modalı, ayarlar ya da başka palet açıkken palet AÇILMAZ (bekleyen onayda Yeni sohbet çalışmaz)", () => {
  expect(paletteBlocked({ paletteOpen: false, settingsOpen: false, modalOpen: true })).toBe(true);
  expect(paletteBlocked({ paletteOpen: false, settingsOpen: true, modalOpen: false })).toBe(true);
  expect(paletteBlocked({ paletteOpen: false, settingsOpen: false, modalOpen: false })).toBe(false);
  const blocked = { v: true }; const { ctl, run } = palette(blocked);
  expect(ctl.open()).toBe(false); expect(ctl.isOpen()).toBe(false); expect(run.new).not.toHaveBeenCalled();
  blocked.v = false; expect(ctl.open()).toBe(true);
});

it("tema tek kaynaktan: palet temayı değiştirince abone (ayarlar seçicisi) gerçek temaya eşitlenir", () => {
  const root = { dataset: {} as Record<string, string>, style: { colorScheme: "" } };
  const mem = new Map<string, string>(); const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
  const theme = createTheme(root as never, storage, { matches: true, addEventListener() {}, removeEventListener() {} });
  const select = { value: theme.choice() }; const off = theme.subscribe(() => { select.value = theme.choice(); });
  expect(select.value).toBe("system");
  theme.set("light"); expect(select.value).toBe("light"); expect(root.dataset.theme).toBe("light"); expect(mem.get(THEME_KEY)).toBe("light");
  off(); theme.set("dark"); expect(select.value).toBe("light");
});

function fakeDoc() {
  const mk = (): any => { const n: any = { className: "", textContent: "", attrs: {} as Record<string, string>, kids: [] as any[], handlers: {} as Record<string, () => void>, removed: false,
    append(...k: any[]) { n.kids.push(...k); }, remove() { n.removed = true; }, setAttribute(k: string, v: string) { n.attrs[k] = v; }, addEventListener(t: string, f: () => void) { n.handlers[t] = f; } }; return n; };
  const host = mk();
  return { host, doc: { createElement: () => mk(), host: () => host } };
}
const words = { info: "Bilgi", done: "Tamam", error: "Hata" };

it("toast: hata role=alert ve kalıcı; bilgi role=status ve süre dolunca kapanır; sözcük + simge var", () => {
  const { host, doc } = fakeDoc(); const timers: Array<() => void> = []; const ms: number[] = [];
  const toaster = createToaster(doc as any, words, "Kapat", (f, t) => { timers.push(f); ms.push(t); });
  toaster.show("error", "Kaydedilemedi");
  expect(timers.length).toBe(0);
  const err = host.kids[0];
  expect(err.attrs.role).toBe("alert");
  expect(err.kids[0].textContent).toBe("■"); expect(err.kids[1].textContent).toBe("Hata"); expect(err.kids[2].textContent).toBe("Kaydedilemedi");
  toaster.show("info", "Kaydedildi");
  expect(host.kids[1].attrs.role).toBe("status"); expect(ms).toEqual([TOAST_TTL_MS]);
  timers[0](); expect(host.kids[1].removed).toBe(true); expect(toaster.count()).toBe(1);
  err.kids[3].handlers.click(); expect(err.removed).toBe(true); expect(toaster.count()).toBe(0);
});

it("toast: hata toast'ı sınır yüzünden ASLA atılmaz; aynı hata ×n sayacıyla birleşir; sınırda en eski bilgi atılır", () => {
  const { host, doc } = fakeDoc(); const toaster = createToaster(doc as any, words, "Kapat", vi.fn());
  toaster.show("info", "i0"); toaster.show("done", "d0");
  for (let i = 0; i < TOAST_MAX; i++) toaster.show("error", `e${i}`);
  const nodes = host.kids as any[];
  expect(nodes[0].removed).toBe(true); expect(nodes[1].removed).toBe(true); // en eski iki bilgi atıldı
  expect(nodes.filter(n => n.attrs.role === "alert" && !n.removed).length).toBe(TOAST_MAX);
  toaster.show("error", "e-fazla"); // hepsi hata: hiçbiri atılmaz
  expect(nodes.filter(n => n.attrs.role === "alert" && !n.removed).length).toBe(TOAST_MAX + 1);
  toaster.show("error", "e0"); toaster.show("error", "e0");
  expect(nodes[2].kids[2].textContent).toBe("e0 ×3"); expect(toaster.count()).toBe(TOAST_MAX + 1);
});

it("ui.ts: palet denetleyicisi, modal engeli, tek kanallı çevrimdışı bandı ve tema aboneliği bağlı", () => {
  const src = readFileSync(new URL("../ui.ts", import.meta.url), "utf8");
  for (const n of ["createPaletteController(", 'document.querySelector(".approve-overlay")', "containDialog(paletteCard", 'addEventListener("offline"', "theme.subscribe"]) expect(src).toContain(n);
  expect(src).not.toMatch(/onOffline = \(\) => \{[^}]*notify\(/);
});
