import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { SETTINGS_PAGE_IDS, nextSettingsPage } from "../settings-pages";

// Repoda DOM kütüphanesi yok: klavye mantığı gerçek saf fonksiyondur; ui.ts bağlantısı kaynak denetimiyle ek olarak doğrulanır.
it("dikey listede yukarı/aşağı döner, Home/End uçlara gider, yatay oklar yok sayılır", () => {
  const ids = SETTINGS_PAGE_IDS;
  expect(nextSettingsPage(ids, ids[0], "ArrowDown")).toBe(ids[1]);
  expect(nextSettingsPage(ids, ids[ids.length - 1], "ArrowDown")).toBe(ids[0]);
  expect(nextSettingsPage(ids, ids[0], "ArrowUp")).toBe(ids[ids.length - 1]);
  expect(nextSettingsPage(ids, ids[2], "Home")).toBe(ids[0]);
  expect(nextSettingsPage(ids, ids[0], "End")).toBe(ids[ids.length - 1]);
  expect(nextSettingsPage(ids, ids[0], "ArrowRight")).toBeNull();
  expect(nextSettingsPage(ids, ids[0], "a")).toBeNull();
  expect(nextSettingsPage([], "x", "ArrowDown")).toBeNull();
});

it("yatay listede (dar pencere) sol/sağ gezinir; RTL'de yön ters; dikey oklar yok sayılır", () => {
  const ids = SETTINGS_PAGE_IDS;
  expect(nextSettingsPage(ids, ids[0], "ArrowRight", { horizontal: true })).toBe(ids[1]);
  expect(nextSettingsPage(ids, ids[0], "ArrowLeft", { horizontal: true })).toBe(ids[ids.length - 1]);
  expect(nextSettingsPage(ids, ids[0], "ArrowLeft", { horizontal: true, rtl: true })).toBe(ids[1]);
  expect(nextSettingsPage(ids, ids[1], "ArrowRight", { horizontal: true, rtl: true })).toBe(ids[0]);
  expect(nextSettingsPage(ids, ids[0], "ArrowDown", { horizontal: true })).toBeNull();
  expect(nextSettingsPage(ids, ids[3], "Home", { horizontal: true })).toBe(ids[0]);
});

it("her sayfanın başlığı 14 dilin tamamında tanımlı", () => {
  const files = readdirSync(new URL("../locales/", import.meta.url)).filter(f => f.endsWith(".json"));
  expect(files.length).toBe(14);
  for (const f of files) {
    const m = JSON.parse(readFileSync(new URL(`../locales/${f}`, import.meta.url), "utf8")) as Record<string, string>;
    for (const id of SETTINGS_PAGE_IDS) expect(m[`settings.page.${id}`], `${f}:${id}`).toBeTruthy();
  }
});

it("ayarlar penceresi tablist/tabpanel, yön eşitleme ve tüm mevcut işlev bölümlerini bağlar", () => {
  const src = readFileSync(new URL("../ui.ts", import.meta.url), "utf8");
  for (const needle of ["renderKeysSection", "renderMcpSection", "showKillDialog", "companionTitle", "reducedMotion", "telemetry", "languageSelector", "themeSelector", '"aria-orientation"', "aria-pressed"])
    expect(src).toContain(needle);
  expect(src).toContain('"tablist"'); expect(src).toContain('"tabpanel"'); expect(src).toContain("nextSettingsPage");
});
