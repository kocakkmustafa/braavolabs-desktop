/**
 * Ayarlar penceresinin sayfa listesi (Ilık Grafit, D13–D24).
 * Yalnız koda karşılığı olan sayfalar vardır; tasarımdaki Kişiselleştirme, Valar,
 * Bütçe, Abonelik, Bildirimler, Profil ve Şirket › Genel sayfaları için henüz
 * bir ayar yok — sahte kontrol yerine gizli bırakıldı (ayrı bilet).
 */
export type SettingsPageId = "appearance" | "keys" | "connectors" | "approvals" | "companion" | "privacy";

export const SETTINGS_PAGE_IDS: readonly SettingsPageId[] = ["appearance", "keys", "connectors", "approvals", "companion", "privacy"];

/** Dikey sayfa listesinde klavye gezintisi: yukarı/aşağı, Home/End. Başka tuş → null. */
export function nextSettingsPage(ids: readonly string[], current: string, key: string): string | null {
  if (!ids.length) return null;
  const at = Math.max(0, ids.indexOf(current));
  if (key === "ArrowDown") return ids[(at + 1) % ids.length];
  if (key === "ArrowUp") return ids[(at - 1 + ids.length) % ids.length];
  if (key === "Home") return ids[0];
  if (key === "End") return ids[ids.length - 1];
  return null;
}
