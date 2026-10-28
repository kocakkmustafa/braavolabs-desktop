/** Count-sensitive text uses the runtime's CLDR-backed category, not English rules. */
import type { Locale } from "./i18n";
type Forms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
const thinking: Record<Locale, Forms> = {
  en: { one: "{n} model thinking…", other: "{n} models thinking…" },
  tr: { other: "{n} model düşünüyor…" },
  "es-419": { one: "{n} modelo está pensando…", other: "{n} modelos están pensando…" },
  "pt-BR": { one: "{n} modelo pensando…", other: "{n} modelos pensando…" },
  de: { one: "{n} Modell denkt nach…", other: "{n} Modelle denken nach…" },
  fr: { one: "{n} modèle réfléchit…", other: "{n} modèles réfléchissent…" },
  ja: { other: "{n}個のモデルが思考中…" },
  ar: { zero: "لا توجد نماذج قيد التفكير ({n})…", one: "نموذج واحد قيد التفكير ({n})…", two: "نموذجان قيد التفكير ({n})…", few: "{n} نماذج قيد التفكير…", many: "{n} نموذجًا قيد التفكير…", other: "{n} نموذج قيد التفكير…" },
  it: { one: "{n} modello sta elaborando…", other: "{n} modelli stanno elaborando…" },
  ko: { other: "모델 {n}개가 생각 중…" },
  id: { other: "{n} model sedang berpikir…" },
  pl: { one: "{n} model rozumuje…", few: "{n} modele rozumują…", many: "{n} modeli rozumuje…", other: "{n} modelu rozumuje…" },
  hi: { one: "{n} मॉडल सोच रहा है…", other: "{n} मॉडल सोच रहे हैं…" },
  "zh-Hans": { other: "{n} 个模型正在思考…" },
};
const approvals: Record<Locale, Forms> = {
  en: { one: "{n} open approval rejected", other: "{n} open approvals rejected" },
  tr: { other: "{n} açık onay isteği reddedildi" },
  "es-419": { one: "{n} solicitud de aprobación pendiente rechazada", other: "{n} solicitudes de aprobación pendientes rechazadas" },
  "pt-BR": { one: "{n} solicitação de aprovação pendente rejeitada", other: "{n} solicitações de aprovação pendentes rejeitadas" },
  de: { one: "{n} offene Zustimmungsanfrage abgelehnt", other: "{n} offene Zustimmungsanfragen abgelehnt" },
  fr: { one: "{n} demande d’approbation ouverte rejetée", other: "{n} demandes d’approbation ouvertes rejetées" },
  ja: { other: "未処理の承認リクエストを{n}件拒否しました" },
  ar: { zero: "لم تُرفض أي طلبات موافقة مفتوحة ({n})", one: "رُفض طلب موافقة مفتوح واحد ({n})", two: "رُفض طلبا موافقة مفتوحان ({n})", few: "رُفضت {n} طلبات موافقة مفتوحة", many: "رُفض {n} طلب موافقة مفتوحًا", other: "طلبات الموافقة المفتوحة المرفوضة: {n}" },
  it: { one: "{n} richiesta di approvazione aperta rifiutata", other: "{n} richieste di approvazione aperte rifiutate" },
  ko: { other: "열린 승인 요청 {n}개 거부됨" },
  id: { other: "{n} permintaan persetujuan terbuka ditolak" },
  pl: { one: "Odrzucono {n} otwartą prośbę o zgodę", few: "Odrzucono {n} otwarte prośby o zgodę", many: "Odrzucono {n} otwartych próśb o zgodę", other: "Odrzucone otwarte prośby o zgodę: {n}" },
  hi: { other: "{n} खुले अनुमोदन अनुरोध अस्वीकार किए गए" },
  "zh-Hans": { other: "已拒绝 {n} 个待审批请求" },
};
const windows: Record<Locale, Forms> = {
  en: { one: "Last {days} day", other: "Last {days} days" },
  tr: { other: "Son {days} gün" },
  "es-419": { one: "Último {days} día", other: "Últimos {days} días" },
  "pt-BR": { one: "Último {days} dia", other: "Últimos {days} dias" },
  de: { one: "Letzter {days} Tag", other: "Letzte {days} Tage" },
  fr: { one: "Dernier {days} jour", other: "Derniers {days} jours" },
  ja: { other: "過去{days}日間" },
  ar: { zero: "آخر {days} يوم", one: "آخر يوم واحد ({days})", two: "آخر يومين ({days})", few: "آخر {days} أيام", many: "آخر {days} يومًا", other: "آخر {days} يوم" },
  it: { one: "Ultimo {days} giorno", other: "Ultimi {days} giorni" },
  ko: { other: "최근 {days}일" },
  id: { other: "{days} hari terakhir" },
  pl: { one: "Ostatni {days} dzień", few: "Ostatnie {days} dni", many: "Ostatnie {days} dni", other: "Ostatnie {days} dnia" },
  hi: { other: "पिछले {days} दिन" },
  "zh-Hans": { other: "最近 {days} 天" },
};
export const PLURAL_MESSAGES = {
  "chat.thinking": { argument: "n", messages: thinking },
  "kill.doneApprovals": { argument: "n", messages: approvals },
  "rail.savingsWindow": { argument: "days", messages: windows },
} as const;
export function pluralMessage(locale: Locale, key: string, vars?: Record<string, string | number>): string | undefined {
  const rule = PLURAL_MESSAGES[key as keyof typeof PLURAL_MESSAGES];
  if (!rule) return undefined;
  const count = vars?.[rule.argument];
  if (typeof count !== "number" || !Number.isFinite(count)) return undefined;
  const forms = rule.messages[locale];
  return forms[new Intl.PluralRules(locale).select(count)] ?? forms.other;
}
