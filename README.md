# @ai-company-os/desktop — Forge Desktop

Native desktop app (Tauri v2) for multi-model chat, cascade, and savings —
the same Forge server that powers the CLI, in an obsidian three-pane UI.

> **Server = orchestration.** The Forge server owns multi-model routing,
> cascade, and savings. The desktop adds two **Lane-A** side-channels that do
> NOT touch the server — **Local (Ollama)** and **BYOK Direct** — but even these
> carry no AI/orchestration logic in the Rust host: dispatch and provider request
> shaping live in the frontend TypeScript; the host is a thin secret-store pipe.

---

## Architecture

```
packages/desktop/
├── index.html              webview entry (mirrors the Tauri CSP)
├── vite.config.ts          builds ui → dist/, hosts the vitest suite
├── src/                    frontend (TypeScript, no framework)
│   ├── client.ts           API client — VERBATIM port of the CLI's
│   │                       forge/client.ts (dep-free fetch, single-401
│   │                       refresh, ApiError, raw mode). The contract.
│   ├── config.ts           { apiUrl, token, refreshToken } — CLI-parity
│   │                       field names; token persisted via the secure store.
│   ├── store.ts            token storage: Tauri OS-scoped command under the
│   │                       app, in-memory fallback in dev/test. NEVER
│   │                       localStorage / plaintext for the token.
│   ├── keyvault.ts         BYOK provider-key vault — masked list, one-time raw
│   │                       get at dispatch. Tauri keys.json (0600) / memory.
│   ├── local.ts            Lane-A local: Ollama /api/tags + /api/chat
│   │                       (stream:false). Keyless, offline. Port of CLI local.ts.
│   ├── direct.ts           Lane-A direct: BYOK single-shot to anthropic /
│   │                       openai / groq. Port of CLI direct.ts.
│   ├── render.ts           pure view-model mappers (savings honesty gate,
│   │                       cascade / compare / login-error mapping). Tested.
│   ├── i18n.ts             single messages object, en + tr (i18n-ready).
│   ├── ui.ts               thin DOM shell (3-pane + keys section) — not unit-tested.
│   ├── main.ts             entry: hydrate → login or workspace.
│   ├── styles.css          obsidian palette (arc-blue / ember / molten; NO green).
│   └── __tests__/          62 tests (client / render / store / i18n /
│                           keyvault / local / direct / identity).
└── src-tauri/              Rust host (STANDALONE cargo package)
    ├── Cargo.toml          tauri = "2"; not part of any cargo workspace.
    ├── tauri.conf.json      window + CSP (self + braavolabs.com + Ollama
    │                        localhost + 3 BYOK provider API hosts).
    ├── capabilities/default.json  core webview permissions for "main".
    ├── icons/              app icons (ember mark).
    └── src/{main,lib}.rs   window + token + BYOK-key OS-scoped commands. THIN.
```

### Panes (obsidian identity, §5)

- **Left rail** — connection status, New chat, memory-vault link, **BYOK keys**
  (masked list + add/remove), savings summary.
- **Center** — multi-model chat, four source lanes. Server: **Cascade** (sync
  `/research/cascade`) and **Compare** (async `/research/compare` → poll
  `/research/:id`, ember "N faces thinking" spinner) — each candidate an arc-rim
  card, final synthesis card, ember `≈ saved $X` footer shown **only when the
  server reports a real positive figure** (never fabricated). Lane-A (server
  bypass): **Local** (Ollama) and **Direct** (BYOK provider) — see below.
- **Right inspector** — last call's tier / model / provider / confidence /
  escalated / cost breakdown (cascade), or per-model / synthesis / cost
  (compare).

Palette: obsidian `#0A0B0F`, arc-blue `#3B82F6`/`#60A5FA`, ember `#F97316`
(running), molten `#FF4D4D` (error), steel greys; JetBrains-Mono for metrics.
**No green anywhere.**

---

## API contracts (read-only reference — server is authoritative)

| Endpoint | Mode | Notes |
|---|---|---|
| `POST /auth/login` | public | `{email,password}` → `{token,refreshToken,user,tenant}`. 401 bad creds, 429 lockout/rate-limit. |
| `POST /auth/refresh` | token | rotates the refresh token (new one must overwrite the old). 503 = fail closed → re-login. |
| `POST /research/compare` | async | company-scoped; returns `{id,status}`, poll `GET /research/:id`. Per-model answers land under `findings.multiModel`. |
| `POST /research/cascade` | sync | **no `companyId`** — tenant-scoped via JWT. |
| `GET /billing/savings?days=N` | token | tenant-scoped tokens-saved report. |
| `GET /memory?companyId=…` | token | company-scoped memory rows (needs an active company). |

Base URL: `VITE_FORGE_API_URL` at build time, else `https://braavolabs.com/api/v1`
(overridable on the login screen; remembered in localStorage — non-secret only).

---

## Lane-A — Local (Ollama) & BYOK Direct (server-bypassing)

The chat composer has four source lanes: **Cascade** and **Compare** hit the
Forge server (above); **Local** and **Direct** bypass it entirely.

### Local · Ollama (`local.ts`)

Keyless, offline. Talks straight to a local Ollama daemon:

| Call | Endpoint | Notes |
|---|---|---|
| model list | `GET http://localhost:11434/api/tags` | first installed model is the default; no guessing |
| completion | `POST /api/chat` `{stream:false}` | one-shot, non-streamed |

Base URL: `VITE_OLLAMA_HOST` at build time, else `http://localhost:11434`.
Only `localhost:11434` is allow-listed in the Tauri CSP `connect-src`; pointing
`OLLAMA_HOST` at another origin is a documented limitation (the CSP is static).
An unreachable daemon renders an honest "Ollama not reachable" error — never a
fabricated answer.

### Direct · BYOK (`direct.ts` + `keyvault.ts`)

Single-shot straight to a provider with a locally stored key, bypassing the
Forge server. Providers and their **dated, conservative default models** (NOT a
claim of "latest" — override per-call in the composer):

| Provider | Endpoint | Auth header | Default model (override-able) |
|---|---|---|---|
| `anthropic` | `api.anthropic.com/v1/messages` | `x-api-key` (+ `anthropic-version`) | `claude-3-5-sonnet-20241022` |
| `openai` | `api.openai.com/v1/chat/completions` | `Authorization: Bearer` | `gpt-4o-mini` |
| `groq` | `api.groq.com/openai/v1/chat/completions` | `Authorization: Bearer` | `llama-3.1-8b-instant` |

Pick a current model from each provider's own docs and paste it into the
composer's optional model field — the defaults above are pinned so a build never
silently changes behavior.

**Key storage.** BYOK keys are stored by the Rust host in `keys.json` (0600 on
unix) in the OS app-config dir — never localStorage, never a webview-readable
file. The Settings → **BYOK keys** rail section lists only **masked**
fingerprints (`first4…last4`); the raw value leaves the store solely via
`key_get`, retrieved **one-time at dispatch** and passed straight into the
provider's auth header — never rendered to the DOM, never logged. Only the three
provider API hosts above are added to the CSP `connect-src`; the closed
`default-src 'self'` / `object-src 'none'` / `frame-ancestors 'none'` policy is
otherwise preserved. Production hardening to the OS keychain is the same human
gate as the auth token (below).

---

## Develop & verify (headless)

```bash
pnpm --filter @ai-company-os/desktop test    # vitest — 62 tests
pnpm --filter @ai-company-os/desktop build   # tsc --noEmit && vite build → dist/
pnpm --filter @ai-company-os/desktop lint    # tsc --noEmit

# Rust host (cargo/rustc live in ~/.cargo/bin — not on PATH by default):
export PATH="$HOME/.cargo/bin:$PATH"
cd packages/desktop/src-tauri && cargo check   # requires dist/ to exist first
```

`cargo check` compiles `tauri::generate_context!`, which reads
`build.frontendDist = "../dist"` — run the frontend `build` first so `dist/`
exists.

## Secret storage

Two kinds of secret, same host-side pattern:

- **Auth token + refresh** → `secure_store_{get,set,clear}` → `secrets.json`.
- **BYOK provider keys** → `key_{add,list,remove,get}` → `keys.json`.

Both are written to the OS app-config dir with `0600` perms (unix) — an
**interim** measure that keeps secrets out of localStorage and the webview.
`key_list` returns masked fingerprints only; `key_get` returns a raw value and
is called only at direct-dispatch. Outside Tauri (vitest / `vite` browser
preview) storage falls back to an in-memory map, so a secret never lands on disk
in dev/test.

**Production hardening (human gate):** move both stores to the real OS keychain
(macOS Keychain / Windows Credential Manager) via a keyring/stronghold plugin.
Not wired here to keep the crate's dependency surface and `cargo check` time small.

## Human gates (NOT done here — require a GUI session / signing identity / live services)

- `cargo tauri dev` / `cargo tauri build` — launches the actual window; needs a
  desktop session. (`pnpm --filter @ai-company-os/desktop dev:ui` serves just
  the frontend in a browser for UI iteration.)
- **Live Lane-A dispatch** — driving a real Ollama daemon (Local) or a real BYOK
  key against a provider (Direct) needs those services present; the request
  shaping is unit-tested with injected fetch, but an end-to-end round-trip is a
  GUI/live-service gate.
- **Signed build** — Apple Developer ID / Windows code-signing cert.
- **Notarization** — Apple notary submission + stapling.
- **OS-keychain secret storage** — see above.
