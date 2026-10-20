import { readFileSync } from "node:fs";
import { afterEach, describe, it, expect, vi } from "vitest";
import { detectLocale, makeT, LOCALES, MESSAGES, applyLocale, normalizeLocale, saveLocale, formatNumber, formatUsd, formatTime } from "../i18n";

afterEach(() => { vi.unstubAllGlobals(); applyLocale("en"); });
describe("all eight desktop catalogues", () => {
  it("has identical keys and placeholder identities with no missing/empty values", () => {
    const keys = Object.keys(MESSAGES.en).sort();
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(MESSAGES[locale]).sort(), locale).toEqual(keys);
      for (const key of keys) {
        expect(MESSAGES[locale][key].trim(), `${locale}:${key}`).not.toBe("");
        expect(placeholders(MESSAGES[locale][key]), `${locale}:${key}`).toEqual(placeholders(MESSAGES.en[key]));
        expect(makeT(locale)(key), `${locale}:${key}`).not.toBe(key);
      }
    }
  });
  it("declares precisely the approved native bundle localizations", () => {
    const plist = readFileSync(new URL("../../src-tauri/Info.plist", import.meta.url), "utf8");
    const array = plist.match(/<array>([\s\S]*?)<\/array>/)![1];
    expect([...array.matchAll(/<string>(.*?)<\/string>/g)].map(match => match[1])).toEqual(["en", "tr", "es-419", "pt-BR", "de", "fr", "ja", "ar"]);
  });
  it.each([
    ["tr-TR", "tr"], ["en-US", "en"], ["es-MX", "es-419"], ["es-ES", "es-419"], ["pt-PT", "pt-BR"],
    ["pt-BR", "pt-BR"], ["de-DE", "de"], ["fr-CA", "fr"], ["ja-JP", "ja"], ["ar-SA", "ar"], ["zh-CN", undefined],
  ])("negotiates %s to %s", (input, expected) => expect(normalizeLocale(input)).toBe(expected));
  it("prefers an explicit saved choice over the device and supports a later device preference", () => {
    vi.stubGlobal("localStorage", { getItem: () => "ja" }); vi.stubGlobal("navigator", { languages: ["tr-TR"] });
    expect(detectLocale()).toBe("ja");
    vi.stubGlobal("localStorage", { getItem: () => null }); vi.stubGlobal("navigator", { languages: ["zh-CN", "ar-SA"] });
    expect(detectLocale()).toBe("ar");
  });
  it("sets Arabic RTL and returns to LTR without changing credentials", () => {
    const html = { lang: "", dir: "" }, setItem = vi.fn();
    vi.stubGlobal("document", { documentElement: html }); vi.stubGlobal("localStorage", { setItem });
    saveLocale("ar"); expect(html).toEqual({ lang: "ar", dir: "rtl" }); expect(setItem).toHaveBeenCalledWith("bv.locale", "ar");
    applyLocale("ja"); expect(html).toEqual({ lang: "ja", dir: "ltr" });
  });
  it("formats numbers, USD, times and numeric placeholders for the chosen locale", () => {
    for (const locale of LOCALES) {
      applyLocale(locale);
      expect(formatNumber(1234.5)).toBe(new Intl.NumberFormat(locale).format(1234.5));
      expect(formatUsd(1.25)).toBe(new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(1.25));
      expect(formatTime(0)).toBe(new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(0));
      expect(makeT(locale)("chat.thinking", { n: 1234 })).toContain(new Intl.NumberFormat(locale).format(1234));
    }
  });
  it("keeps expected EN/TR values and unknown-key diagnostics", () => {
    expect(makeT("en")("login.submit")).toBe("Sign in"); expect(makeT("tr")("login.submit")).toBe("Giriş yap");
    expect(makeT("en")("nope.missing")).toBe("nope.missing");
  });
});
