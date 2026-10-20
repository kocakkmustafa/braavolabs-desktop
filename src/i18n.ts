/** Fourteen frontend catalogues. Explicit preference precedes device negotiation. */
import en from "./locales/en.json";
import tr from "./locales/tr.json";
import es from "./locales/es-419.json";
import pt from "./locales/pt-BR.json";
import de from "./locales/de.json";
import fr from "./locales/fr.json";
import ja from "./locales/ja.json";
import ar from "./locales/ar.json";
import it from "./locales/it.json";
import ko from "./locales/ko.json";
import id from "./locales/id.json";
import pl from "./locales/pl.json";
import hi from "./locales/hi.json";
import zhHans from "./locales/zh-Hans.json";
import { pluralMessage } from "./i18n-plurals";
import { EXTRA_MESSAGES, LANGUAGES } from "./i18n-extra";
export const LOCALES = LANGUAGES;
export type Locale = typeof LOCALES[number];
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", tr: "Türkçe", "es-419": "Español (Latinoamérica)", "pt-BR": "Português (Brasil)", de: "Deutsch", fr: "Français", ja: "日本語", ar: "العربية", it: "Italiano", ko: "한국어", id: "Bahasa Indonesia", pl: "Polski", hi: "हिन्दी", "zh-Hans": "简体中文" };
const base: Record<Locale, Record<string, string>> = { en, tr, "es-419": es, "pt-BR": pt, de, fr, ja, ar, it, ko, id, pl, hi, "zh-Hans": zhHans };
export const MESSAGES = Object.fromEntries(LOCALES.map(locale => [locale, { ...base[locale], ...(EXTRA_MESSAGES as Partial<typeof base>)[locale] }])) as typeof base;
const KEY = "bv.locale";
let activeLocale: Locale = "en";
export function normalizeLocale(value?: string): Locale | undefined {
  if (!value) return undefined;
  try {
    const canonical = Intl.getCanonicalLocales(value.replaceAll("_", "-"))[0];
    const parsed = new Intl.Locale(canonical);
    // Traditional-script preferences must not silently become Simplified Chinese.
    if (parsed.language === "zh") return parsed.maximize().script === "Hans" ? "zh-Hans" : undefined;
    return LOCALES.find(locale => locale.toLowerCase() === canonical.toLowerCase())
      ?? ({ es: "es-419", pt: "pt-BR", tr: "tr", en: "en", de: "de", fr: "fr", ja: "ja", ar: "ar", it: "it", ko: "ko", id: "id", pl: "pl", hi: "hi" } as Record<string, Locale>)[parsed.language];
  } catch { return undefined; }
}
export function detectLocale(): Locale {
  try {
    // A saved value must be one of our exact supported preferences.
    const saved = globalThis.localStorage?.getItem(KEY);
    if (LOCALES.includes(saved as Locale)) return saved as Locale;
  } catch { /* storage blocked: use device preference */ }
  try {
    for (const value of (globalThis.navigator?.languages?.length ? globalThis.navigator.languages : [globalThis.navigator?.language])) {
      const locale = normalizeLocale(value); if (locale) return locale;
    }
  } catch { /* navigator unavailable */ }
  return "en";
}
export function applyLocale(locale: Locale): void {
  activeLocale = locale;
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
  }
}
export function saveLocale(locale: Locale): boolean {
  if (!LOCALES.includes(locale)) throw new Error("unsupported locale");
  try {
    if (!globalThis.localStorage) return false;
    globalThis.localStorage.setItem(KEY, locale);
  } catch { return false; }
  applyLocale(locale);
  return true;
}
export function getLocale(): Locale { return activeLocale; }
export function formatNumber(value: number | null, options: Intl.NumberFormatOptions = {}): string {
  if (value === null || !Number.isFinite(value)) return makeT(activeLocale)("common.unknown");
  return new Intl.NumberFormat(activeLocale, options).format(value);
}
export function formatUsd(value: number | null): string {
  return formatNumber(value, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
}
export function formatTime(value: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) return makeT(activeLocale)("common.unknown");
  return new Intl.DateTimeFormat(activeLocale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(value);
}
export function makeT(locale: Locale) {
  const dict = MESSAGES[locale];
  return (key: string, vars?: Record<string, string | number>): string => {
    const raw = pluralMessage(locale, key, vars) ?? dict[key] ?? MESSAGES.en[key] ?? key;
    return !vars ? raw : raw.replace(/\{(\w+)\}/g, (_m, name) => !(name in vars) ? `{${name}}`
      : typeof vars[name] === "number" ? Number.isFinite(vars[name]) ? new Intl.NumberFormat(locale).format(vars[name]) : dict["common.unknown"] : String(vars[name]));
  };
}
export type Translator = ReturnType<typeof makeT>;
