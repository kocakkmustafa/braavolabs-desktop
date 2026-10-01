/**
 * Holding surface — pure view mappers (company.ts ile aynı sözleşme).
 *
 * Bu modül ASLA bir değer UYDURMAZ. Sunucu bir sayıyı göndermediyse görünüm
 * "bilinmiyor" der; sıfır yazmaz. Sıfır bir ÖLÇÜMDÜR, eksik veri değildir —
 * ikisini karıştırmak holding'de en pahalı yanılgıyı üretir: "hiçbir şey
 * olmuyor" ile "hiçbir şey ölçmüyoruz" aynı ekrana düşer.
 *
 * Ekranın taşıdığı üç dürüstlük ayrımı:
 *   1. ETKİN ≠ KOŞMUŞ — bir workflow açık olabilir ve hiç tetiklenmemiş
 *      olabilir. Sessizce çalışıyor sanmak buradan doğar.
 *   2. İŞLENMEMİŞ SİNYAL ≠ TOPLAM SİNYAL — kuyrukta bekleyen ile arşiv farklı.
 *   3. KADRO: runbook var ama çalışma-zamanı karşılığı yok (DEFTER H-025) —
 *      ekran bunu "0 ajan" diye değil, "runtime'a girmedi" diye söyler.
 */

export interface WorkflowRow {
  key: string;
  name: string;
  riskClass: string;
  enabled: boolean;
  /** Bu tanım en az bir kez koşmuş mu — "etkin" ile aynı şey DEĞİL. */
  ran: boolean;
}

export interface RunRow {
  id: string;
  key: string;
  name: string;
  status: string;
  venture: string | null;
  /** "steel" = bekliyor/park, "ember" = koşuyor, "arc" = başarılı, "molten" = hata. */
  tone: "steel" | "ember" | "arc" | "molten";
  startedAt: string | null;
}

export interface ApprovalRow {
  id: string;
  description: string;
  riskClass: string;
  createdAt: string | null;
}

export interface SignalRow {
  kind: string;
  severity: string;
  /** Yalnız işlenmemiş (NEW) olanlar; arşiv ayrı sayılır. */
  count: number;
}

export interface SensorRow {
  id: string;
  lastBeatAt: string | null;
  /** İki aralık geçtiyse sensör bayat — sunucu hesaplar, biz uydurmayız. */
  stale: boolean;
}

export interface AgentRow {
  id: string;
  name: string;
  role: string;
  model: string;
  /** Bu ajan ŞU AN bir adımda mı — sunucu söyler, biz tahmin etmeyiz. */
  running: boolean;
}

export interface SubCompanyRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  pipelineCount: number;
  agents: AgentRow[];
}

export interface WorkingRow {
  /** "holding" = yönetişim adımı · "pipeline" = üretim adımı. Ayrı tutulur. */
  layer: "holding" | "pipeline";
  runId: string;
  step: string;
  /** Ürün adımında hangi ajanın koştuğu; holding adımında ajan YOKTUR (null). */
  agent: string | null;
  agentModel: string | null;
  startedAt: string | null;
}

export interface HoldingView {
  /** Motor uykudaysa (HOLDING_ENABLED=false) hiçbir sayı gösterilmez. */
  enabled: boolean;
  workflowTotal: number;
  workflowEnabled: number;
  workflowRan: number;
  /** Etkin ama hiç koşmamışlar — ekranda AYRI bir uyarı satırı olur. */
  enabledNeverRan: WorkflowRow[];
  workflows: WorkflowRow[];
  runs: RunRow[];
  runStatusCounts: Array<{ status: string; count: number }>;
  failedSteps: number;
  spendUsd: number;
  approvals: ApprovalRow[];
  signalsTotal: number;
  signalsUnprocessed: number;
  signals: SignalRow[];
  sensors: SensorRow[];
  /** null = sunucu söylemedi. 0 = ölçüldü, gerçekten yok. */
  runtimeAgents: number | null;
  companies: SubCompanyRow[];
  /** Şu an koşan adımlar. Boş dizi = hiçbir şey koşmuyor (ölçüm), bilinmiyor değil. */
  working: WorkingRow[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
/** ISO tarih ya da null — geçersiz değeri "şimdi"ye çevirmeyiz. */
const iso = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export function toneForRun(status: string): RunRow["tone"] {
  switch (status) {
    case "SUCCEEDED":
      return "arc";
    case "RUNNING":
    case "PENDING":
      return "ember";
    case "FAILED":
      return "molten";
    default:
      // WAITING_APPROVAL, CANCELLED ve bilinmeyen her durum: nötr.
      // Bilinmeyeni "hata" saymak yanlış alarm, "başarı" saymak yalan olurdu.
      return "steel";
  }
}

export function toHoldingView(raw: unknown): HoldingView {
  const d = (raw ?? {}) as Record<string, any>;
  const w = (d.workflows ?? {}) as Record<string, any>;
  const k = (d.kosular ?? {}) as Record<string, any>;
  const s = (d.sinyaller ?? {}) as Record<string, any>;

  const mapWf = (x: any): WorkflowRow => ({
    key: str(x?.key),
    name: str(x?.name),
    riskClass: str(x?.riskClass),
    enabled: x?.enabled === true,
    ran: x?.kosmus === true,
  });

  return {
    enabled: d.enabled === true,
    workflowTotal: num(w.toplam),
    workflowEnabled: num(w.etkin),
    workflowRan: num(w.kosmus),
    enabledNeverRan: arr(w.etkinAmaKosmamis).map((x) => ({
      key: str(x?.key), name: str(x?.name), riskClass: str(x?.riskClass),
      enabled: true, ran: false,
    })),
    workflows: arr(w.liste).map(mapWf),
    runs: arr(k.son).map((r) => ({
      id: str(r?.id),
      key: str(r?.key),
      name: str(r?.ad),
      status: str(r?.durum),
      venture: iso(r?.venture),
      tone: toneForRun(str(r?.durum)),
      startedAt: iso(r?.basladi),
    })),
    runStatusCounts: Object.entries((k.durumlar ?? {}) as Record<string, unknown>)
      .map(([status, count]) => ({ status, count: num(count) }))
      .sort((a, b) => b.count - a.count),
    failedSteps: num(k.basarisizAdim),
    spendUsd: num(k.toplamHarcamaUsd),
    approvals: arr(d.onaylar).map((a) => ({
      id: str(a?.id), description: str(a?.aciklama),
      riskClass: str(a?.riskClass), createdAt: iso(a?.olusturuldu),
    })),
    signalsTotal: num(s.toplam),
    signalsUnprocessed: num(s.islenmemis),
    // Yalnız işlenmemiş sinyaller listelenir: arşivi göstermek ekranı
    // geçmişle doldurur, oysa ekranın sorusu "şu an ne bekliyor".
    signals: arr(s.gruplar)
      .filter((g) => str(g?.status) === "NEW")
      .map((g) => ({ kind: str(g?.kind), severity: str(g?.severity), count: num(g?.adet) }))
      .sort((a, b) => b.count - a.count),
    sensors: arr(d.sensorler).map((h) => ({
      id: str(h?.id), lastBeatAt: iso(h?.sonAtis), stale: h?.bayat === true,
    })),
    runtimeAgents:
      typeof d?.kadro?.runtimeAjan === "number" ? d.kadro.runtimeAjan : null,
    companies: arr(d.sirketler).map((c) => ({
      id: str(c?.id), name: str(c?.ad), slug: str(c?.slug), status: str(c?.durum),
      pipelineCount: num(c?.hatSayisi),
      agents: arr(c?.ajanlar).map((a) => ({
        id: str(a?.id), name: str(a?.ad), role: str(a?.rol),
        model: str(a?.model), running: a?.calisiyor === true,
      })),
    })),
    working: [
      ...arr(d?.calisan?.holdingAdimlari).map((x) => ({
        layer: "holding" as const, runId: str(x?.run), step: str(x?.ad),
        // Holding adımını bir ajana bağlamak YANLIŞ olurdu: yönetişim adımları
        // (noop/log/approval/patrol) model çalıştırmaz, kimse "koşmuyor".
        agent: null, agentModel: null, startedAt: iso(x?.baslangic),
      })),
      ...arr(d?.calisan?.hatAdimlari).map((x) => ({
        layer: "pipeline" as const, runId: str(x?.run), step: str(x?.ad),
        agent: x?.ajan ? `${str(x.ajan.ad)} (${str(x.ajan.rol)})` : null,
        agentModel: x?.ajan ? str(x.ajan.model) : null,
        startedAt: iso(x?.baslangic),
      })),
    ],
  };
}

/** Ekranın üst satırı: tek bakışta "sağlıklı mı" cevabı — abartmadan. */
export function headline(v: HoldingView): string {
  if (!v.enabled) return "Holding motoru uykuda";
  const parcalar = [
    `${v.workflowEnabled}/${v.workflowTotal} etkin`,
    `${v.workflowRan} koşmuş`,
  ];
  if (v.failedSteps > 0) parcalar.push(`${v.failedSteps} başarısız adım`);
  if (v.approvals.length > 0) parcalar.push(`${v.approvals.length} onay bekliyor`);
  if (v.signalsUnprocessed > 0) parcalar.push(`${v.signalsUnprocessed} işlenmemiş sinyal`);
  return parcalar.join(" · ");
}
