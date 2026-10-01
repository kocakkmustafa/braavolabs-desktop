import { describe, it, expect } from "vitest";
import { toHoldingView, toneForRun, headline } from "../holding";

/**
 * Bu suite'in tek derdi DÜRÜSTLÜK: görünüm katmanı, sunucunun söylemediği
 * hiçbir şeyi uydurmamalı ve birbirine benzeyen ama farklı olan durumları
 * (etkin/koşmuş, işlenmemiş/toplam, yok/bilinmiyor) ayırt etmeli.
 */

const ORNEK = {
  enabled: true,
  workflows: {
    toplam: 33, etkin: 26, kosmus: 20,
    etkinAmaKosmamis: [{ key: "haftalik-scorecard", name: "Scorecard", riskClass: "R2" }],
    liste: [
      { key: "kapi-duman-testi", name: "Duman", riskClass: "R1", enabled: true, kosmus: true },
      { key: "haftalik-scorecard", name: "Scorecard", riskClass: "R2", enabled: true, kosmus: false },
    ],
  },
  kosular: {
    durumlar: { SUCCEEDED: 52, WAITING_APPROVAL: 2 },
    basarisizAdim: 0, toplamHarcamaUsd: 0,
    son: [{ id: "r1", key: "gunluk-brief", ad: "Brief", durum: "WAITING_APPROVAL",
            venture: "holding", basladi: "2026-08-08T08:14:34Z", bitti: null }],
  },
  onaylar: [{ id: "a1", aciklama: "Brief onayı", riskClass: "R2", olusturuldu: "2026-08-08T08:14:00Z" }],
  sinyaller: {
    toplam: 29, islenmemis: 3,
    gruplar: [
      { kind: "ci-failure-mail", severity: "SEV2", status: "NEW", adet: 2 },
      { kind: "store-apple-durum", severity: "SEV1", status: "NEW", adet: 1 },
      { kind: "defter-p1-birikim", severity: "SEV2", status: "CLASSIFIED", adet: 9 },
    ],
  },
  sensorler: [{ id: "holding-sensor-sweep", sonAtis: "2026-08-08T08:05:00Z", bayat: false }],
  kadro: { runtimeAjan: 7, runbookVar: true },
};

describe("toHoldingView", () => {
  it("ETKİN ile KOŞMUŞ'u ayırır — açık ama hiç tetiklenmemiş workflow ayrıca listelenir", () => {
    const v = toHoldingView(ORNEK);
    expect(v.workflowEnabled).toBe(26);
    expect(v.workflowRan).toBe(20);
    // 26 açık ama 20 koşmuş: aradaki fark sessizce yutulmamalı.
    expect(v.enabledNeverRan.map((x) => x.key)).toEqual(["haftalik-scorecard"]);
  });

  it("yalnız İŞLENMEMİŞ sinyalleri listeler, arşivi ekrana taşımaz", () => {
    const v = toHoldingView(ORNEK);
    expect(v.signals.map((s) => s.kind)).toEqual(["ci-failure-mail", "store-apple-durum"]);
    // Arşivdeki 9 kayıt listede yok ama toplam sayıda duruyor.
    expect(v.signalsTotal).toBe(29);
    expect(v.signalsUnprocessed).toBe(3);
  });

  it("sunucu söylemediyse UYDURMAZ: eksik alanlar 0 değil null/boş kalır", () => {
    const v = toHoldingView({ enabled: true });
    expect(v.runtimeAgents).toBeNull();   // "bilinmiyor" — sıfır DEĞİL
    expect(v.runs).toEqual([]);
    expect(v.approvals).toEqual([]);
    expect(v.workflowTotal).toBe(0);
  });

  it("runtimeAgents=0 ile alan yok'u ayırır (ölçüm vs eksik veri)", () => {
    expect(toHoldingView({ kadro: { runtimeAjan: 0 } }).runtimeAgents).toBe(0);
    expect(toHoldingView({ kadro: {} }).runtimeAgents).toBeNull();
  });

  it("bozuk/eksik girdide çökmez", () => {
    expect(() => toHoldingView(null)).not.toThrow();
    expect(() => toHoldingView({ workflows: "bozuk", kosular: 5 })).not.toThrow();
    expect(toHoldingView(null).enabled).toBe(false);
  });
});

describe("toneForRun", () => {
  it("bilinmeyen durumu ne HATA ne BAŞARI sayar", () => {
    expect(toneForRun("SUCCEEDED")).toBe("arc");
    expect(toneForRun("FAILED")).toBe("molten");
    expect(toneForRun("RUNNING")).toBe("ember");
    // Yanlış alarm da yalan da olmasın diye nötr:
    expect(toneForRun("WAITING_APPROVAL")).toBe("steel");
    expect(toneForRun("KİMSENİN_BİLMEDİĞİ_DURUM")).toBe("steel");
  });
});

describe("headline", () => {
  it("motor uykudayken sayı göstermez", () => {
    expect(headline(toHoldingView({ enabled: false }))).toBe("Holding motoru uykuda");
  });

  it("sorunları yalnız VARSA yazar — sıfırları satır olarak göstermez", () => {
    const saglikli = headline(toHoldingView({ ...ORNEK, onaylar: [], sinyaller: { toplam: 0, islenmemis: 0, gruplar: [] } }));
    expect(saglikli).toBe("26/33 etkin · 20 koşmuş");
    const sorunlu = headline(toHoldingView(ORNEK));
    expect(sorunlu).toContain("1 onay bekliyor");
    expect(sorunlu).toContain("3 işlenmemiş sinyal");
  });
});
