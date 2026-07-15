# @ai-company-os/desktop — Forge Desktop

Native desktop app (Tauri v2) for multi-model chat, cascade, and savings —
the same Forge server that powers the CLI, in an obsidian three-pane UI.

> **Server = orchestration.** There is **no AI logic in this app** (neither the
> Rust host nor the frontend). Every model call is an authenticated request to
> the Forge API; the desktop only renders and steers.

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
│   ├── store.ts            secret storage: Tauri OS-scoped command under the
│   │                       app, in-memory fallback in dev/test. NEVER
│   │                       localStorage / plaintext for the token.
│   ├── render.ts           pure view-model mappers (savings honesty gate,
│   │                       cascade / compare / login-error mapping). Tested.
│   ├── i18n.ts             single messages object, en + tr (i18n-ready).
│   ├── ui.ts               thin DOM shell (3-pane) — not unit-tested.
│   ├── main.ts             entry: hydrate → login or workspace.
│   ├── styles.css          obsidian palette (arc-blue / ember / molten; NO green).
│   └── __tests__/          35 tests (client / render / store / i18n).
└── src-tauri/              Rust host (STANDALONE cargo package)
    ├── Cargo.toml          tauri = "2"; not part of any cargo workspace.
    ├── tauri.conf.json      window + CSP (self + braavolabs.com only).
    ├── capabilities/default.json  core webview permissions for "main".
    ├── icons/              app icons (ember mark).
    └── src/{main,lib}.rs   window + 3 OS-scoped secret commands. THIN.
```

### Panes (obsidian identity, §5)

- **Left rail** — connection status, New chat, memory-vault link, savings summary.
- **Center** — multi-model chat: **Cascade** (sync `/research/cascade`) and
  **Compare** (async `/research/compare` → poll `/research/:id`, ember
  "N faces thinking" spinner). Each candidate is an arc-rim card; a final
  synthesis card follows. An ember footer shows `≈ saved $X` **only when the
  server reports a real positive figure** (never fabricated).
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

## Develop & verify (headless)

```bash
pnpm --filter @ai-company-os/desktop test    # vitest — 35 tests
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

Tokens are handed to the Rust `secure_store_{get,set,clear}` commands, which
write `secrets.json` to the OS app-config dir with `0600` perms (unix) — an
**interim** measure that keeps tokens out of localStorage and the webview.
Outside Tauri (vitest / `vite` browser preview) storage falls back to memory,
so a token never lands on disk in dev/test.

**Production hardening (human gate):** move to the real OS keychain (macOS
Keychain / Windows Credential Manager) via a keyring/stronghold plugin. Not
wired here to keep the crate's dependency surface and `cargo check` time small.

## Human gates (NOT done here — require a GUI session / signing identity)

- `cargo tauri dev` / `cargo tauri build` — launches the actual window; needs a
  desktop session. (`pnpm --filter @ai-company-os/desktop dev:ui` serves just
  the frontend in a browser for UI iteration.)
- **Signed build** — Apple Developer ID / Windows code-signing cert.
- **Notarization** — Apple notary submission + stapling.
- **OS-keychain secret storage** — see above.
