# Yayın akışı — imzalı güncelleme (yarı elle, BRA-UI-11c)

Yol A: macOS Developer ID imzalı + notarize, Windows kod imzasız, Linux AppImage, barındırma GitHub Releases. Güncelleme bütünlüğü Tauri imzasıyla korunur (kapatılamaz). Bu akış kurucunun makinesinde çalışır; CI'ya imza anahtarı konmaz.

## Kurallar
- Gizli anahtar yalnız ortam değişkeniyle verilir: `TAURI_SIGNING_PRIVATE_KEY` (anahtarın kendisi) ve varsa `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Anahtar dosyası depoya, sohbete, loglara, `.env`'e girmez.
- `src-tauri/tauri.conf.json` içinde `createUpdaterArtifacts` KAPALIDIR (CI Windows NSIS'i anahtarsız derler). Yayın derlemesi `src-tauri/tauri.updater.conf.json` ile açar.
- Açık anahtar `plugins.updater.pubkey` içindedir; gizli anahtar değişirse yeni sürümü kullanıcılara elle kurdurmak gerekir.

## Adımlar
1. Sürümü `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` içinde yükselt; PR ile main'e al.
2. Kendi makinende anahtarı ortama ver (kabuk geçmişine yazılmayacak biçimde, ör. parola yöneticisinden okuyarak) ve derle:
   - macOS: `pnpm tauri build --target universal-apple-darwin --config src-tauri/tauri.updater.conf.json`
   - Windows: `pnpm tauri build --bundles nsis --config src-tauri/tauri.updater.conf.json`
   - Linux (AppImage): `pnpm tauri build --bundles appimage --config src-tauri/tauri.updater.conf.json`
3. Çıktılar (`src-tauri/target/.../release/bundle/`): macOS `Braavolabs.app.tar.gz` + `.sig`; Windows `Braavolabs_<sürüm>_x64-setup.exe` + `.exe.sig`; Linux `Braavolabs_<sürüm>_amd64.AppImage` + `.AppImage.sig`.
4. `latest.json` yaz (aşağıdaki şablon). Her `signature` değeri ilgili `.sig` DOSYASININ içeriğidir (yol değil). Universal macOS için `darwin-aarch64` ve `darwin-x86_64` aynı `.app.tar.gz`'yi gösterir; bu, resmî belgede doğrulanmadığı için ilk gerçek güncellemede hem arm64 hem Intel Mac'te denenir.
5. Doğrula: `node scripts/verify-latest-json.mjs latest.json` → `latest.json: OK`. Eksik platform, boş/yer tutucu imza, projenin indirme adresi dışındaki bağlantı ya da sürümle uyuşmayan bağlantı çıkış kodu 1 verir.
6. GitHub Releases'te `v<sürüm>` sürümünü oluştur (taslak/ön-sürüm değil: updater `releases/latest/download/latest.json` adresini okur); paketleri, `.sig` dosyalarını, `SHA256SUMS.txt` ve `latest.json`'ı yükle.
7. Eski kurulumdan güncellemeyi dene; imzası bozulmuş bir kopyanın reddedildiğini de dene. İlk updater'lı sürüm kullanıcıya elle kurdurulur (eski sürümlerde motor yok).

## `latest.json` şablonu
```json
{
  "version": "X.Y.Z",
  "notes": "Kısa sürüm notu",
  "pub_date": "2026-01-01T00:00:00Z",
  "platforms": {
    "darwin-aarch64": { "url": "https://github.com/kocakkmustafa/braavolabs-desktop/releases/download/vX.Y.Z/Braavolabs.app.tar.gz", "signature": "<.sig dosyasının içeriği>" },
    "darwin-x86_64": { "url": "https://github.com/kocakkmustafa/braavolabs-desktop/releases/download/vX.Y.Z/Braavolabs.app.tar.gz", "signature": "<.sig dosyasının içeriği>" },
    "windows-x86_64": { "url": "https://github.com/kocakkmustafa/braavolabs-desktop/releases/download/vX.Y.Z/Braavolabs_X.Y.Z_x64-setup.exe", "signature": "<.sig dosyasının içeriği>" },
    "linux-x86_64": { "url": "https://github.com/kocakkmustafa/braavolabs-desktop/releases/download/vX.Y.Z/Braavolabs_X.Y.Z_amd64.AppImage", "signature": "<.sig dosyasının içeriği>" }
  }
}
```

## Geri alma
Yanlış sürümde silmek yerine `latest.json`'ı önceki sürümü gösterecek biçimde yeniden yükle ya da daha yüksek numaralı düzeltme yayımla (updater yalnız ileri gider). Önceki sürümler silinmez.
