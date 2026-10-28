# Distribution and privacy disclosure draft — 2026-10-27

Braavolabs Desktop is **not** distributed through the Mac App Store or the
Microsoft Store. The release path is a Developer ID–signed, notarized macOS DMG
(see `README.md` → "macOS app and DMG") and an NSIS current-user installer for
Windows (`src-tauri/tauri.conf.json` `bundle.windows.nsis`). There is no store
privacy questionnaire; this file is the source-bound disclosure for the download
page and the website privacy policy.

## Identity
| | |
|---|---|
| Bundle ID | `com.braavolabs.desktop` |
| Version | `0.1.1` (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`) |
| macOS | universal DMG, hardened runtime; signing identity supplied by `APPLE_SIGNING_IDENTITY` at build time, never stored in the repo |
| Windows | NSIS, current-user install; WebView2 via the Microsoft download bootstrapper when missing (`webviewInstallMode`); no code-signing certificate configured — SmartScreen will warn until one exists |
| Auto-update | none (no updater plugin in `src-tauri/Cargo.toml`, no `updater` block in `tauri.conf.json`) |

## What leaves the machine
| Data | Destination | When | Evidence |
|---|---|---|---|
| Email + password, refresh/logout | Braavolabs API (default `https://braavolabs.com/api/v1`, overridable by `VITE_BRAAVOLABS_API_URL` at build time) | sign-in, session refresh, logout | `src/config.ts`, `src/client.ts` |
| Profile (`/users/me`), companies, pipelines, memory, billing savings | Braavolabs API | user navigation | `src/client.ts` |
| Ask/cascade prompts | Braavolabs API | user action | `src/client.ts` |
| Companion relay events: approval requests, agent turns, output, audit, status | Braavolabs API (relay) | while a relay session is paired | `src/relay-transport.ts`, `src/relay-protocol.ts` |
| Prompts in direct (BYOK) mode | the provider the user picked: `api.anthropic.com`, `api.openai.com`, `api.groq.com`, with the user's own key | user action | `src/direct.ts` |
| Prompts in local mode | Ollama on `localhost:11434` (does not leave the machine) | user action | `src/local.ts` |

**Not collected:** no analytics, telemetry, crash reporter or tracking code
(`package.json`/`Cargo.toml`; the in-app Settings → Telemetry row states
"None — this app ships no analytics or tracking code", `src/locales/en.json`).

## Local storage
- API tokens and the user's own provider keys: OS keychain via `keyring`
  (service `braavolabs-desktop`; `src-tauri/src/lib.rs`, `src/keyvault.ts`).
- `localStorage`: API URL, locale, preferences, theme and companion sessions
  (`src/store.ts`, `src/i18n.ts`, `src/sessions.ts`).

## Download-page disclosure (EN, draft)
> Braavolabs Desktop sends your sign-in details and the requests you make to the
> Braavolabs service. If you add your own Anthropic, OpenAI or Groq key, prompts
> in direct mode go straight to that provider under your account; local mode
> talks only to Ollama on your computer. Keys and tokens stay in your system
> keychain. The app contains no analytics or tracking code. Privacy policy:
> https://braavolabs.com/privacy · Delete your account:
> https://braavolabs.com/legal/account-deletion · Support: support@yulalab.com

## Open gates
1. Developer ID signing + notarization of the exact release SHA (Management;
   notarytool profile name still UNKNOWN — `RELEASE-PACKAGES.tr.md` (c)).
2. Release channel decision (website download vs GitHub Release) — owner.
3. Windows code-signing certificate — owner decision; without it the
   installer ships with a SmartScreen warning.
4. Note for a later hardening pass (not a store gate): CSP `connect-src` allows
   any `https:` host (`src-tauri/tauri.conf.json`) because BYOK providers are
   called from the webview; it could be narrowed to the API host plus the three
   provider hosts.
