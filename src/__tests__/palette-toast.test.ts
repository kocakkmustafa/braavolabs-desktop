import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { filterCommands, isPaletteShortcut, movePaletteIndex } from "../palette";
import { createToaster, TOAST_MAX, TOAST_TTL_MS } from "../toast";

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
  expect(movePaletteIndex(1, 3, "Home")).toBe(0);
  expect(movePaletteIndex(0, 3, "x")).toBeNull();
  expect(movePaletteIndex(0, 0, "ArrowDown")).toBeNull();
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

it("toast: en çok TOAST_MAX görünür, en eskisi atılır", () => {
  const { host, doc } = fakeDoc(); const toaster = createToaster(doc as any, words, "Kapat", vi.fn());
  for (let i = 0; i < TOAST_MAX + 2; i++) toaster.show("error", `m${i}`);
  expect(toaster.count()).toBe(TOAST_MAX); expect(host.kids[0].removed).toBe(true); expect(host.kids[TOAST_MAX + 1].removed).toBe(false);
});

it("ui.ts paleti dialog + odak tuzağı + Escape ile bağlar, çevrimdışı olaylarını dinler ve ayar bildirimlerini toast'a iletir", () => {
  const src = readFileSync(new URL("../ui.ts", import.meta.url), "utf8");
  for (const n of ["isPaletteShortcut(e)", "filterCommands(all", "movePaletteIndex(active", "createToaster(", "containDialog(paletteCard, close)", 'addEventListener("offline"', 'notify(t, "error"'])
    expect(src).toContain(n);
});
