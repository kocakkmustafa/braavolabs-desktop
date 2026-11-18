/**
 * Ayarlar penceresinin sayfa listesi (Ilık Grafit, D13–D24).
 * Yalnız koda karşılığı olan sayfalar vardır; tasarımdaki Kişiselleştirme, Valar,
 * Bütçe, Abonelik, Bildirimler, Profil ve Şirket › Genel sayfaları için henüz
 * bir ayar yok — sahte kontrol yerine gizli bırakıldı (ayrı bilet).
 */
export type SettingsPageId = "appearance" | "keys" | "connectors" | "approvals" | "companion" | "privacy";

export const SETTINGS_PAGE_IDS: readonly SettingsPageId[] = ["appearance", "keys", "connectors", "approvals", "companion", "privacy"];

/**
 * Sayfa listesinde klavye gezintisi. Dikey liste (varsayılan): yukarı/aşağı. Yatay liste (dar pencere):
 * sol/sağ; RTL'de yön ters. Home/End her iki durumda uçlara gider. Başka tuş → null.
 */
export function nextSettingsPage(ids: readonly string[], current: string, key: string, opts: { horizontal?: boolean; rtl?: boolean } = {}): string | null {
  if (!ids.length) return null;
  const at = Math.max(0, ids.indexOf(current));
  const fwd = opts.horizontal ? (opts.rtl ? "ArrowLeft" : "ArrowRight") : "ArrowDown";
  const back = opts.horizontal ? (opts.rtl ? "ArrowRight" : "ArrowLeft") : "ArrowUp";
  if (key === fwd) return ids[(at + 1) % ids.length];
  if (key === back) return ids[(at - 1 + ids.length) % ids.length];
  if (key === "Home") return ids[0];
  if (key === "End") return ids[ids.length - 1];
  return null;
}
