import { readFileSync } from "node:fs";
import { PLURAL_MESSAGES } from "../i18n-plurals";
import { afterEach, describe, it, expect, vi } from "vitest";
import { detectLocale, makeT, LOCALES, MESSAGES, applyLocale, normalizeLocale, saveLocale, getLocale, formatNumber, formatUsd, formatTime } from "../i18n";

afterEach(() => { vi.unstubAllGlobals(); applyLocale("en"); });
describe("all fourteen desktop catalogues", () => {
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
    expect([...array.matchAll(/<string>(.*?)<\/string>/g)].map(match => match[1])).toEqual(LOCALES);
  });
  it.each([
    ["tr-TR", "tr"], ["en-US", "en"], ["es-MX", "es-419"], ["es-ES", "es-419"], ["pt-PT", "pt-BR"],
    ["pt-BR", "pt-BR"], ["de-DE", "de"], ["fr-CA", "fr"], ["ja-JP", "ja"], ["ar-SA", "ar"], ["zh-CN", "zh-Hans"], ["zh", "zh-Hans"], ["zh-SG", "zh-Hans"], ["zh-Hans-CN", "zh-Hans"], ["zh-TW", undefined], ["zh-HK", undefined], ["zh-Hant-CN", undefined], ["zh_Hans_HK", "zh-Hans"], ["ZH-cn-u-nu-hanidec", "zh-Hans"], ["invalid_locale_!", undefined], ["it-IT", "it"], ["ko-KR", "ko"], ["id-ID", "id"], ["pl-PL", "pl"], ["hi-IN", "hi"],
  ])("negotiates %s to %s", (input, expected) => expect(normalizeLocale(input)).toBe(expected));
  it("prefers an explicit saved choice over the device and supports a later device preference", () => {
    vi.stubGlobal("localStorage", { getItem: () => "ja" }); vi.stubGlobal("navigator", { languages: ["tr-TR"] });
    expect(detectLocale()).toBe("ja");
    vi.stubGlobal("localStorage", { getItem: () => null }); vi.stubGlobal("navigator", { languages: ["zh-TW", "ar-SA"] });
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

it("preserves the active language if preference persistence fails", () => {
  applyLocale("tr"); vi.stubGlobal("localStorage", { setItem: () => { throw Error("blocked"); } });
  expect(saveLocale("pl")).toBe(false);
  // No reload into a different locale may be acknowledged on a failed save.
  expect(getLocale()).toBe("tr");
});
it("uses navigator.language when navigator.languages is empty and does not force Hant into Hans", () => {
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("navigator", { languages: [], language: "ko-KR" }); expect(detectLocale()).toBe("ko");
  vi.stubGlobal("navigator", { languages: ["zh-Hant-TW", "pl-PL"] }); expect(detectLocale()).toBe("pl");
});
it("executes each count-sensitive key through locale plural rules with identical placeholders", () => {
  for (const locale of LOCALES) for (const [key, rule] of Object.entries(PLURAL_MESSAGES)) {
    const forms = rule.messages[locale];
    for (const text of Object.values(forms)) expect([...text.matchAll(/\{(\w+)\}/g)].map(m => m[1])).toEqual([rule.argument]);
    for (const n of [0, 1, 2, 3, 5, 11, 21, 22, 101, 102, 1.5, -2]) {
      const category = new Intl.PluralRules(locale).select(n);
      const raw = forms[category] ?? forms.other;
      expect(makeT(locale)(key, { [rule.argument]: n })).toBe(raw.replace(`{${rule.argument}}`, new Intl.NumberFormat(locale).format(n)));
    }
  }
  expect(makeT("pl")("chat.thinking", { n: 1 })).toBe("1 model rozumuje…");
  expect(makeT("pl")("chat.thinking", { n: 2 })).toBe("2 modele rozumują…");
  expect(makeT("pl")("chat.thinking", { n: 5 })).toBe("5 modeli rozumuje…");
  expect(makeT("ar")("chat.thinking", { n: 2 })).toContain("نموذجان");
  expect(makeT("ar")("chat.thinking", { n: 0 })).toContain("لا توجد");
});
it("keeps the frontend and native exact registries aligned without touching native action values", () => {
  const source = readFileSync(new URL("../../src-tauri/src/native_presentation.rs", import.meta.url), "utf8");
  const native = JSON.parse(source.match(/LOCALES: \[&str; 14\] = (\[[^;]+\]);/)![1]);
  expect(native).toEqual(LOCALES);
  for (const match of source.matchAll(/Some\(\[([\s\S]*?)\]\)/g)) {
    const values: string[] = JSON.parse(`[${match[1]}]`); expect(values).toHaveLength(14);
    for (const text of values) expect(text.trim()).not.toBe("");
  }
});

it("formats absent/invalid observations as unknown while retaining zero, negative and fractional values", () => {
  for (const locale of LOCALES) {
    applyLocale(locale); const unknown = makeT(locale)("common.unknown");
    expect(formatNumber(null)).toBe(unknown); expect(formatUsd(null)).toBe(unknown);
    expect(formatNumber(NaN)).toBe(unknown); expect(formatTime(Infinity)).toBe(unknown); expect(formatTime(1e30)).toBe(unknown);
    for (const n of [0, -1, 1.5, 1000000]) expect(formatNumber(n)).toBe(new Intl.NumberFormat(locale).format(n));
    expect(makeT(locale)("company.counts", { agents: NaN, pipelines: 0 })).toContain(unknown);
  }
});
