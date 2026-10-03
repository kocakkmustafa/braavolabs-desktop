# CLAUDE.md — Braavolabs Desktop (Tauri v2)

Ortak şirket/ürün/servis/durum bağlamı için önce [YULAlab ortak girişini](../../../AGENTS.md) oku. Teknik yöntemi model seçer; bu dosya işlem yetkisi üretmez. Yerel ürün ve güvenlik bilgileri aşağıdadır.

Çok-modelli sohbet + cascade routing + governance-moat masaüstü uygulaması. CLI ile aynı orkestrasyon sunucusu. Bundle id: `com.braavolabs.desktop`. Vizyon/durum: `../VENTURE.md` + `../workspace/` defterleri.


## Bilinmesi gerekenler
- **Governance çekirdeği burada:** OS-keychain sır saklama + native onay-dialog + server-lane spend-kanıtı. Bu yüzeylere dokunan iş = riskli sınıf (kanıtlı güvenlik incelemesi + mevcut kurucu onayı sınırı).
- İç modül adlandırmasında tarihsel `forge` kalıntıları olabilir (rebrand 2026-07-18; kullanıcı-görünür değil — kullanıcı-görünür markayla karıştırılmaz).
- `src-tauri/target/` türetilmiş çıktılar taşır; ignored olması temizlik yetkisi değildir. Native GUI çalışması uygun GUI oturumu/erişimi gerektirir; insan erişim sınırı korunur.
- Ana dal `main`; PR akışıyla merge (PR #10 v3-shell, #11 server-lane-gate örnek). Push öncesi kurucuya sor.
