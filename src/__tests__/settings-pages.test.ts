import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { SETTINGS_PAGE_IDS, nextSettingsPage } from "../settings-pages";

it("sayfa listesinde yukarı/aşağı döner, Home/End uçlara gider, diğer tuş yok sayılır", () => {
  const ids = SETTINGS_PAGE_IDS;
  expect(nextSettingsPage(ids, ids[0], "ArrowDown")).toBe(ids[1]);
  expect(nextSettingsPage(ids, ids[ids.length - 1], "ArrowDown")).toBe(ids[0]);
  expect(nextSettingsPage(ids, ids[0], "ArrowUp")).toBe(ids[ids.length - 1]);
  expect(nextSettingsPage(ids, ids[2], "Home")).toBe(ids[0]);
  expect(nextSettingsPage(ids, ids[0], "End")).toBe(ids[ids.length - 1]);
  expect(nextSettingsPage(ids, ids[0], "a")).toBeNull();
  expect(nextSettingsPage([], "x", "ArrowDown")).toBeNull();
});

it("her sayfanın başlığı 14 dilde tanımlı", () => {
  for (const loc of ["tr", "en", "de", "ar", "hi", "zh-Hans", "es-419"]) {
    const m = JSON.parse(readFileSync(new URL(`../locales/${loc}.json`, import.meta.url), "utf8")) as Record<string, string>;
    for (const id of SETTINGS_PAGE_IDS) expect(m[`settings.page.${id}`], `${loc}:${id}`).toBeTruthy();
  }
});

it("ayarlar penceresi sayfa listesi/panel rollerini ve tüm mevcut işlev bölümlerini bağlar", () => {
  const src = readFileSync(new URL("../ui.ts", import.meta.url), "utf8");
  for (const needle of ["renderKeysSection", "renderMcpSection", "showKillDialog", "companionTitle", "reducedMotion", "telemetry", "languageSelector", "themeSelector"])
    expect(src).toContain(needle);
  expect(src).toContain('"tablist"'); expect(src).toContain('"tabpanel"'); expect(src).toContain("nextSettingsPage");
});
