/**
 * Minimal i18n — a SINGLE messages object (not hardcoded strings sprinkled
 * through the DOM), en + tr only for the first desktop release but structured
 * so the other four ui locales (ar/de/es/fr) slot in later without touching
 * call sites. `t("path.to.key")` resolves dotted keys; unknown keys return the
 * key itself (visible-but-safe) rather than throwing.
 */

export type Locale = "en" | "tr";

type Dict = Record<string, unknown>;

const en: Dict = {
  app: { name: "Forge", tagline: "Multi-model chat, one workspace." },
  login: {
    title: "Sign in to Forge",
    email: "Email",
    password: "Password",
    apiUrl: "API URL",
    submit: "Sign in",
    signingIn: "Signing in…",
    errInvalid: "Invalid email or password.",
    errLocked: "Account temporarily locked. Try again later.",
    errRateLimited: "Too many attempts. Try again in a few minutes.",
    errUnavailable: "Authentication service is temporarily unavailable.",
    errUnknown: "Sign in failed.",
  },
  rail: {
    connection: "Connection",
    connected: "Connected",
    disconnected: "Signed out",
    newChat: "New chat",
    memory: "Memory vault",
    savings: "Savings",
    signOut: "Sign out",
    noSavings: "No savings data yet.",
    savingsWindow: "Last {days} days",
  },
  keys: {
    title: "BYOK keys",
    empty: "No keys stored. Add one to use Direct.",
    provider: "Provider",
    secret: "API key",
    add: "Add",
    remove: "Remove",
    stored: "Stored locally, never sent to the server.",
  },
  chat: {
    placeholder: "Ask across your models…",
    send: "Send",
    modeCompare: "Compare",
    modeCascade: "Cascade",
    modeLocal: "Local",
    modeDirect: "Direct",
    companyId: "Company ID",
    companyNeeded: "Compare needs an active company. Enter a Company ID or switch to Cascade.",
    localModel: "Model (optional)",
    directModel: "Model (optional override)",
    localUnreachable: "Ollama not reachable — is it running on {host}?",
    noKey: "No {provider} key stored. Add one under BYOK keys.",
    localSource: "Local · Ollama",
    directSource: "Direct · {provider}",
    thinking: "{n} faces thinking…",
    localThinking: "Local model thinking…",
    directThinking: "{provider} thinking…",
    polling: "Working… ({status})",
    finalAnswer: "Final answer",
    synthesis: "Synthesis",
    consensus: "Consensus",
    disagreements: "Disagreements",
    perModel: "Per model",
    failed: "Failed candidates",
    unparsed: "synthesis was not strict-JSON — raw fallback",
    empty: "No answer returned.",
  },
  inspector: {
    title: "Inspector",
    empty: "Run a query to see cost, tier & confidence.",
    tier: "Tier",
    model: "Model",
    provider: "Provider",
    confidence: "Confidence",
    escalated: "Escalated",
    cost: "Cost",
    attempts: "Attempts",
    stoppedReason: "Stopped",
    savingsBreakdown: "Savings breakdown",
    actual: "Actual",
    baseline: "Baseline",
    saved: "Saved",
  },
};

const tr: Dict = {
  app: { name: "Forge", tagline: "Çok-model sohbet, tek çalışma alanı." },
  login: {
    title: "Forge'a giriş yap",
    email: "E-posta",
    password: "Parola",
    apiUrl: "API adresi",
    submit: "Giriş yap",
    signingIn: "Giriş yapılıyor…",
    errInvalid: "E-posta veya parola hatalı.",
    errLocked: "Hesap geçici olarak kilitlendi. Daha sonra tekrar deneyin.",
    errRateLimited: "Çok fazla deneme. Birkaç dakika sonra tekrar deneyin.",
    errUnavailable: "Kimlik doğrulama servisi geçici olarak kullanılamıyor.",
    errUnknown: "Giriş başarısız.",
  },
  rail: {
    connection: "Bağlantı",
    connected: "Bağlı",
    disconnected: "Çıkış yapıldı",
    newChat: "Yeni sohbet",
    memory: "Hafıza kasası",
    savings: "Tasarruf",
    signOut: "Çıkış yap",
    noSavings: "Henüz tasarruf verisi yok.",
    savingsWindow: "Son {days} gün",
  },
  keys: {
    title: "BYOK anahtarları",
    empty: "Kayıtlı anahtar yok. Direct için bir tane ekle.",
    provider: "Sağlayıcı",
    secret: "API anahtarı",
    add: "Ekle",
    remove: "Sil",
    stored: "Yerelde saklanır, sunucuya asla gönderilmez.",
  },
  chat: {
    placeholder: "Modellerine sor…",
    send: "Gönder",
    modeCompare: "Karşılaştır",
    modeCascade: "Kademeli",
    modeLocal: "Yerel",
    modeDirect: "Doğrudan",
    companyId: "Şirket ID",
    companyNeeded: "Karşılaştırma aktif bir şirket gerektirir. Şirket ID gir ya da Kademeli'ye geç.",
    localModel: "Model (opsiyonel)",
    directModel: "Model (opsiyonel override)",
    localUnreachable: "Ollama erişilemiyor — {host} üzerinde çalışıyor mu?",
    noKey: "{provider} için kayıtlı anahtar yok. BYOK anahtarları'ndan ekle.",
    localSource: "Yerel · Ollama",
    directSource: "Doğrudan · {provider}",
    thinking: "{n} yüz düşünüyor…",
    localThinking: "Yerel model düşünüyor…",
    directThinking: "{provider} düşünüyor…",
    polling: "Çalışıyor… ({status})",
    finalAnswer: "Nihai yanıt",
    synthesis: "Sentez",
    consensus: "Uzlaşı",
    disagreements: "Ayrışmalar",
    perModel: "Model başına",
    failed: "Başarısız adaylar",
    unparsed: "sentez strict-JSON değildi — ham geri-dönüş",
    empty: "Yanıt dönmedi.",
  },
  inspector: {
    title: "Denetçi",
    empty: "Maliyet, kademe ve güveni görmek için bir sorgu çalıştır.",
    tier: "Kademe",
    model: "Model",
    provider: "Sağlayıcı",
    confidence: "Güven",
    escalated: "Yükseltildi",
    cost: "Maliyet",
    attempts: "Denemeler",
    stoppedReason: "Durma nedeni",
    savingsBreakdown: "Tasarruf dökümü",
    actual: "Gerçek",
    baseline: "Referans",
    saved: "Tasarruf",
  },
};

const MESSAGES: Record<Locale, Dict> = { en, tr };

export function detectLocale(): Locale {
  try {
    const lang = (globalThis.navigator?.language ?? "en").slice(0, 2).toLowerCase();
    return lang === "tr" ? "tr" : "en";
  } catch {
    return "en";
  }
}

function resolve(dict: Dict, path: string): string | undefined {
  const out = path.split(".").reduce<unknown>((acc, k) => {
    if (acc && typeof acc === "object" && k in (acc as Dict)) return (acc as Dict)[k];
    return undefined;
  }, dict);
  return typeof out === "string" ? out : undefined;
}

/** Translator for a locale. Interpolates {placeholders} from `vars`. */
export function makeT(locale: Locale) {
  const dict = MESSAGES[locale] ?? MESSAGES.en;
  return (key: string, vars?: Record<string, string | number>): string => {
    const raw = resolve(dict, key) ?? resolve(MESSAGES.en, key) ?? key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (_m, name) => (name in vars ? String(vars[name]) : `{${name}}`));
  };
}

export type Translator = ReturnType<typeof makeT>;
