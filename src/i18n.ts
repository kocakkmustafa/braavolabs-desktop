/** Eight complete catalogues. Explicit preference precedes device negotiation. */
import en from "./locales/en.json";
import tr from "./locales/tr.json";
import es from "./locales/es-419.json";
import pt from "./locales/pt-BR.json";
import de from "./locales/de.json";
import fr from "./locales/fr.json";
import ja from "./locales/ja.json";
import ar from "./locales/ar.json";
import { EXTRA_MESSAGES, LANGUAGES } from "./i18n-extra";
export const LOCALES = LANGUAGES;
export type Locale = typeof LOCALES[number];
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", tr: "Türkçe", "es-419": "Español (Latinoamérica)", "pt-BR": "Português (Brasil)", de: "Deutsch", fr: "Français", ja: "日本語", ar: "العربية" };
const base: Record<Locale, Record<string, string>> = { en, tr, "es-419": es, "pt-BR": pt, de, fr, ja, ar };
export const MESSAGES = Object.fromEntries(LOCALES.map(locale => [locale, { ...base[locale], ...EXTRA_MESSAGES[locale] }])) as typeof base;
const KEY = "bv.locale";
let activeLocale: Locale = "en";
export function normalizeLocale(value?: string): Locale | undefined {
  const normalized = value?.replaceAll("_", "-").toLowerCase();
  if (!normalized) return undefined;
  return LOCALES.find(locale => locale.toLowerCase() === normalized)
    ?? ({ es: "es-419", pt: "pt-BR", tr: "tr", en: "en", de: "de", fr: "fr", ja: "ja", ar: "ar" } as Record<string, Locale>)[normalized.split("-")[0]];
}
export function detectLocale(): Locale {
  try {
    // A saved value must be one of our exact supported preferences.
    const saved = globalThis.localStorage?.getItem(KEY);
    if (LOCALES.includes(saved as Locale)) return saved as Locale;
  } catch { /* storage blocked: use device preference */ }
  try {
    for (const value of globalThis.navigator?.languages ?? [globalThis.navigator?.language]) {
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
export function saveLocale(locale: Locale): void {
  if (!LOCALES.includes(locale)) throw new Error("unsupported locale");
  try { globalThis.localStorage?.setItem(KEY, locale); } catch { /* device fallback next launch */ }
  applyLocale(locale);
}
export function getLocale(): Locale { return activeLocale; }
export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(activeLocale, options).format(value);
}
export function formatUsd(value: number): string {
  return formatNumber(value, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
}
export function formatTime(value: number): string {
  return new Intl.DateTimeFormat(activeLocale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(value);
}
export function makeT(locale: Locale) {
  const dict = MESSAGES[locale];
  return (key: string, vars?: Record<string, string | number>): string => {
    const raw = dict[key] ?? MESSAGES.en[key] ?? key;
    return !vars ? raw : raw.replace(/\{(\w+)\}/g, (_m, name) => !(name in vars) ? `{${name}}`
      : typeof vars[name] === "number" ? new Intl.NumberFormat(locale).format(vars[name]) : String(vars[name]));
  };
}
export type Translator = ReturnType<typeof makeT>;
