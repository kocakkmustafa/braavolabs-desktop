# CLAUDE.md — Braavolabs Desktop (Tauri v2)

Çok-modelli sohbet + cascade routing + governance-moat masaüstü uygulaması. CLI ile aynı orkestrasyon sunucusu. Bundle id: `com.braavolabs.desktop`. Vizyon/durum: `../VENTURE.md` + `../workspace/` defterleri.

## Komutlar (pnpm)
```bash
pnpm install
pnpm test          # vitest (TS testleri)
pnpm lint          # tsc --noEmit
pnpm build         # tsc + vite build
pnpm dev:ui        # yalnız web UI (vite)
# cargo tauri dev  → packages/desktop içinden, GUI oturumu ister (İNSAN-KAPILI)
cargo test         # src-tauri Rust testleri
```

## Bilinmesi gerekenler
- **Governance çekirdeği burada:** OS-keychain sır saklama + native onay-dialog + server-lane spend-kanıtı. Bu yüzeylere dokunan iş = riskli sınıf (Opus doğrulaması + kurucu onayı).
- İç modül adlandırmasında tarihsel `forge` kalıntıları olabilir (rebrand 2026-07-18; kullanıcı-görünür değil — yeniden adlandırmaya kalkışma).
- `src-tauri/target/` büyüktür ve gitignore'ludur; mutlak-yol taşıyan artefaktlar için `cargo clean` çözümdür.
- Ana dal `main`; PR akışıyla merge (PR #10 v3-shell, #11 server-lane-gate örnek). Push öncesi kurucuya sor.
