# YULAlab — yerel Codex girişi

Önce [ortak bağlam girişini](../../../AGENTS.md), ardından [bu reponun tek yerel ürün/güvenlik kaynağını](CLAUDE.md) oku. CLAUDE.md içindeki yerel bilgiler Codex ve Claude için aynıdır; teknik yöntemi model seçer, dosya işlem yetkisi üretmez.

Bu dosya Codex ve diğer kod ajanları içindir. Kısa tutulur; ayrıntı `CLAUDE.md`'dedir, çelişkide `CLAUDE.md` doğrudur.

## Yığın
- Tauri v2 (Rust, `src-tauri/`) + React 19 + Vite + TypeScript · durum: zustand · şema: zod
- pnpm 10.33.0 · Node 26.9.0 · Kurulum: `pnpm install --frozen-lockfile`
- Analiz + derleme (CI ile aynı): `pnpm build` (= `tsc --noEmit && vite build`)
- Test (CI ile aynı): `pnpm test` (= `vitest run`) · Rust: `cd src-tauri && cargo check --locked && cargo test --locked`

## Kurallar
- **Minimal diff:** yalnız istenen dosyalara dokun; biçimlendirme/yeniden adlandırma turu yapma.
- Yerelleştirme: `src/locales/<dil>.json` (14 dil); kayıt `src/i18n.ts` ve `src/i18n-extra.ts`; doğrulama `src/__tests__/i18n.test.ts`. Yeni anahtarı tüm dillere ekle, çeviri yoksa İngilizce bırak.
- Testler: `src/__tests__/` (Vitest); yeni davranışa test ekle, mevcut testi silme ya da atlatma.
- `pnpm tauri dev` GUI oturumu ister (insan kapısı); çalıştırma. İç `forge` adlandırması kasıtlıdır, değiştirme.
- Bitirmeden: analiz ve test temiz olmalı; çıktının son 5 satırını rapora koy.

## Dokunulmaz
- Governance çekirdeği: OS-keychain sır saklama, native onay-diyaloğu, server-lane spend-kanıtı (riskli sınıf; kurucu onayı).
- Sürüm numarası (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`), imzalama ve yayın iş akışları (`.github/workflows/`) — yalnız açık talimatla.
- `src-tauri/target/` çıktılarını silme; sır dosyaları (`.env*`, anahtarlar, `~/.secrets`).
- Burun Farkı ve Iron Bank.
