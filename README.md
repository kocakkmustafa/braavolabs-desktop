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
│   │                       get at dispatch. Tauri OS keychain / memory (dev).
│   ├── local.ts            Lane-A local: Ollama /api/tags + /api/chat
│   │                       (stream:false). Keyless, offline. Port of CLI local.ts.
│   ├── direct.ts           Lane-A direct: BYOK single-shot to anthropic /
│   │                       openai / groq. Port of CLI direct.ts.
│   ├── render.ts           pure view-model mappers (savings honesty gate,
│   │                       cascade / compare / login-error mapping). Tested.
│   ├── spawn.ts            Lane-B SAFE-SPAWN: vendor CLI detection + launch
│   │                       command. Port of CLI spawn.ts contract; Rust
│   │                       spawn_probe backing / memory fallback. Tested.
│   ├── governance.ts       GOVERNANCE-BY-DEFAULT: fail-closed policy + one-time
│   │                       approval gate + append-only audit ledger. Rust-host
│   │                       backed / memory fallback. The moat. Tested (18).
│   ├── mcp.ts              MCP stdio client: register servers, tools/list, gated
│   │                       tools/call (JSON-RPC 2.0, partial-line, timeout→kill).
│   │                       Rust-host session / memory-mirror fallback. Tested (21).
│   ├── i18n.ts             single messages object, en + tr (i18n-ready).
│   ├── ui.ts               thin DOM shell (3-pane + keys + Lane-B + approval
│   │                       modal + Activity/audit tab) — not unit-tested.
│   ├── main.ts             entry: hydrate → login or workspace.
│   ├── styles.css          obsidian palette (arc-blue / ember / molten; NO green).
│   └── __tests__/          115 tests (client / render / store / i18n / keyvault /
│                           local / direct / identity / spawn / governance / mcp).
└── src-tauri/              Rust host (STANDALONE cargo package)
    ├── Cargo.toml          tauri = "2"; not part of any cargo workspace.
    ├── tauri.conf.json      window + CSP (self + braavolabs.com + Ollama
    │                        localhost + 3 BYOK provider API hosts).
    ├── capabilities/default.json  core webview permissions for "main".
    ├── icons/              app icons (ember mark).
    └── src/{main,lib}.rs   window + token + BYOK-key OS-scoped commands +
                            Lane-B spawn_probe + the GOVERNANCE gate (policy
                            mirror, one-time tokens, 0600 audit log, command
                            choke point) + the MCP stdio client (mcp.json,
                            spawn + JSON-RPC session, gated tools/call) + 16 Rust
                            unit tests. THIN on AI, but legitimately owns
                            permission/sandbox + host-side process enforcement.
```

### Panes (obsidian identity, §5)

- **Left rail** — connection status, New chat, memory-vault link, **BYOK keys**
  (masked list + add/remove), **Lane-B · your CLIs** (claude/codex detection +
  ToS-risk + launch command), savings summary.
- **Center** — multi-model chat, four source lanes. Server: **Cascade** (sync
  `/research/cascade`) and **Compare** (async `/research/compare` → poll
  `/research/:id`, ember "N faces thinking" spinner) — each candidate an arc-rim
  card, final synthesis card, ember `≈ saved $X` footer shown **only when the
  server reports a real positive figure** (never fabricated). Lane-A (server
  bypass): **Local** (Ollama) and **Direct** (BYOK provider) — see below.
- **Right inspector** — two tabs. **Inspector**: last call's tier / model /
  provider / confidence / escalated / cost breakdown (cascade), or per-model /
  synthesis / cost (compare). **Activity**: the governance **Policy** table
  (which kinds auto-run vs. ask) + the append-only **audit** ledger (newest
  first). Side-effecting lanes (Direct, Lane-B launch) carry a `governed` badge
  and pop the **approval modal** before running.

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

**Key storage (OS keychain, S-010).** The Rust host stores BYOK keys — and the
auth token/refresh — in the **OS keychain** on the platforms this app ships to:
the **macOS Keychain** and the **Windows Credential Manager** (via the `keyring`
crate), encrypted at rest and OS-gated. On any other platform, or if the keychain
is unreachable, it falls back to a single owner-only `vault.json` (`0600` on
unix); the `secret_backend_secure` command reports which backend is live so the
UI never over-claims protection. The keychain isn't enumerable, so a
`keys-index.json` holds provider → **masked** fingerprint (`first4…last4`) ONLY —
never a secret — which is all Settings → **BYOK keys** ever reads for its list.
The raw value leaves the store solely via `key_get`, retrieved **one-time at
dispatch** and passed straight into the provider's auth header — never rendered to
the DOM, never logged. Any legacy `keys.json` / `secrets.json` (the earlier 0600
plaintext files) are migrated into the keychain and deleted on first access
(backend write precedes file removal, so a mid-migration crash can only leave the
old file, never lose a secret). Only the three provider API hosts above are added
to the CSP `connect-src`; the closed `default-src 'self'` / `object-src 'none'` /
`frame-ancestors 'none'` policy is otherwise preserved.

---

## Lane-B · your own CLIs (SAFE-SPAWN)

Lane-B lets Forge run **your OWN, already-signed-in vendor CLI** (`claude` /
`codex`) instead of a key or the Forge server. It is a thin, opaque passthrough —
NOT a re-implementation of the vendor and NOT an OAuth client. The contract
(ported from the CLI's adversarially-verified `forge/spawn.ts`; enforced by
construction in `src/spawn.ts` + `src-tauri/src/lib.rs`):

| # | Rule | How it's enforced |
|---|---|---|
| a | **No vendor OAuth.** You must have logged in with the official binary yourself. | Lane-B never initiates/brokers a vendor sign-in — there is no auth code path. |
| b | **Only the official binary is a target; launch is an argv ARRAY.** | `buildLaunchCommand` returns `{argv, cliDelegation}` arrays — never a shell string, so `"hi; rm -rf /"` stays one inert element (no injection seam). |
| c | **A vendor session's stdout/stderr is OPAQUE.** | The desktop never opens a vendor session in-process; the real interactive run is delegated to `forge spawn`, which uses `stdio:"inherit"` and captures/parses nothing. |
| d | **Token/cookie files are NEVER touched.** | Detection (`spawn_probe`) probes ONLY `PATH` + neutral bin prefixes (`knownPaths` — homebrew, `/usr/local/bin`, `~/.local/bin`, `~/.bun/bin`, `~/.cargo/bin` for codex). It never reads `~/.claude*`, `~/.codex*`, `auth.json`, or any config dir. Version comes from `<bin> --version` only. |
| f | **Per-vendor ToS-risk is surfaced.** | `VENDOR_SPECS.risk` — claude = *SAFE, volatile*; codex = *SAFE, lowest risk* — shown steel in the rail. |
| g | **Absent binary degrades to the API-key path.** | `spawnFallbackMessage` → "use API key → Direct" (`forge direct anthropic\|openai …`); never a fabricated result. |

### Why detection + launch-command (not an in-process PTY)

A webview cannot spawn a child process — only the Rust host can — and a FULL
interactive PTY bridged into a webview (raw-mode stdio, terminal emulation,
resize/signal handling) is a large, security-sensitive surface. So this desktop
version does the two meaningful, safe things and **delegates the actual
interactive session to the proven CLI**:

1. **Detect** — the Rust `spawn_probe` command answers *installed? which path?
   what version?* and NOTHING else. Its discovery mirrors the TS `knownPaths`
   contract (neutral paths only) and it never streams a vendor session.
2. **Launch** — the rail's **Copy launch command** reveals the argv and copies
   `forge spawn <vendor>`, which you paste into your terminal. That CLI path
   already implements the opaque `stdio:"inherit"` passthrough (rules b, c).

This keeps the Rust host thin (no AI/orchestration, no captured vendor output)
and reuses the CLI's already-verified spawn path. A full native-terminal Lane-B
inside the window is a future **human gate** (needs a PTY plugin + a GUI session).

---

## Governance & sandbox — governed by default (the moat)

Where "allow-all" agent hosts (Hermes, OpenClaw, …) run whatever an action asks,
Forge Desktop is **governed by default**: every side-effecting action passes a
**fail-closed** policy gate *before* it can run, each grant is a **one-time
token**, and every decision lands in an **append-only audit log**. The security
enforcement lives in the **Rust host** — legitimately, because a compromised
webview must not be able to forge a grant. (AI/orchestration still never touches
the host; permission/sandbox logic is a different concern and belongs there.)

### 1. Fail-closed policy (`governance.ts` · mirrored in `lib.rs::classify`)

`classifyAction(kind, detail)` → `auto-allow` | `require-approval` | `deny`.

| Bucket | Kinds | Rule |
|---|---|---|
| **auto-allow** (explicit, tiny) | `probe.detect`, `local.dispatch` | read-only detection + local keyless dispatch only |
| **require-approval** | `direct.dispatch`, `spawn.launch`, `command.run`, `mcp.tool`, `file.write`, **and every unknown kind** | a human taps before it runs |
| **deny** (hard) | `command.run` matching a destructive pattern (`rm -rf`, `mkfs`, `dd if=`, fork bomb…); `file.write` with `..` path traversal | never even offered for approval |

The default is the third row's **and every unknown kind**: an action Forge has
not explicitly reasoned about is **never auto-allowed** — it falls through to
require-approval. Widening the auto-allow set is a deliberate, reviewable change
(one `Set` in `governance.ts`, one `matches!` arm in `lib.rs` — the two are kept
in lock-step, and the TS + Rust test suites are the tripwire if they drift).

The Settings → **Activity → Policy** panel renders this table live, straight
from the compile-time constant — so a compromised host can't misrepresent which
actions auto-run.

### 2. One-time approval tokens + native approval dialog (S-012)

`request → (native approve | reject) → consume`. `request()` classifies + audits;
`approve()` mints a token bound to *that* action; `consume()` spends it **exactly
once** and refuses a replayed, forged, or mis-bound token. An executor that
requires a consumed token therefore **cannot run without passing the gate** —
verified by tests (replay-after-consume → refused; a token for action A → refused
for action B; a never-issued token → refused).

**The approval itself is a NATIVE OS dialog (S-012), not a webview modal.** The
old `approve_action` minted a token as soon as the webview called it — so a
compromised webview could skip its own HTML modal and self-approve. Now
`approve_action` shows a host-side native confirm ("Allow" / "Deny", OS chrome
outside the webview's reach, with the action summary), and mints a token ONLY on
a real human "Allow". Deny, dismiss, or a 120s timeout → **fail-closed** (no
token, audited `rejected`). The dialog runs async off the main thread (non-blocking
`show()` + oneshot channel) so it can't deadlock the event loop. The in-app arc-rim
modal remains a rich preview, but the native dialog is the **trust anchor** — a
webview cannot forge an OS click. The Lane-A Direct, Lane-B launch, and Local lanes
funnel through this gate.

> **Human gate:** the native dialog's actual rendering + click flow is verified in
> a GUI session (`cargo tauri dev`), like every other desktop runtime surface —
> the host wiring, fail-closed timeout, and token logic are unit-/compile-verified.

### 3. Append-only audit ledger (0600, secret-free)

Every transition appends one JSON line to `audit.log` in the app-config dir
(`0600` on unix): `{seq, ts, kind, decision, outcome, summary}`. **Ordering is by
the monotonic `seq`**, never the wall-clock `ts`. A **secret/token is never
written** — only the action type and a **redacted** meta summary (`sk-…`, Bearer
tokens, and long opaque strings are scrubbed by `redactSummary` / `redact`
before storage; a test asserts a canary secret never appears). The right
inspector's **Activity** tab renders the last N entries, newest first.

### 4. Command choke point (`lib.rs::governed_command`)

The single path through which a command may ever execute. It (1) spends a valid
one-time `command.run` token, (2) re-validates the destructive-pattern denylist,
(3) enforces a **working-dir allowlist** (canonicalized — no `..` escape;
non-existent dir refused), (4) builds the child from an **argv array** (never a
shell string — no injection seam), (5) optionally **clears the environment**
(keeping only `PATH` so the binary resolves), and (6) applies a **timeout**
(kill on deadline). The allowlist roots default to the app-config dir + home.

### Honest boundary — "governed + choke-point", NOT "sandboxed"

This layer is **governance + a choke point**, and the README calls it exactly
that. It is **not** OS-level process isolation — there is no container, macOS
seatbelt/`sandbox-exec`, or Windows AppContainer wrapping the child here. The
enforcement *points* (policy gate, one-time tokens, audit, workdir allowlist,
argv arrays, env-clean, timeout) are in place and unit-tested; wrapping the
choke point in a **real OS sandbox** is a documented **roadmap / human gate**
(needs a platform sandboxing layer + a GUI session to drive). No code here is
labelled "sandboxed" — the moat we ship today is *governed by default*.

---

## MCP — registered servers, gated tool calls (`mcp.ts` + `lib.rs`)

Forge Desktop is itself an **MCP client**: register a stdio Model Context
Protocol server, browse its tools, and call one. The rail's **MCP servers**
section adds/lists/removes servers; clicking a server loads its tools; a per-tool
form takes JSON arguments and runs the call.

**Where the work happens.** A webview cannot spawn a child process — only the
Rust host can — so the JSON-RPC session lives in `lib.rs`, not the webview:

- **Config** — `mcp.json` in the app-config dir (`0600` on unix, same pattern as
  `keys.json`), a `{ name: { command, args[] } }` map. `args` is a **discrete
  array**, never a joined string, so there is no shell and no injection seam when
  the server is spawned.
- **Session** — line-delimited **JSON-RPC 2.0** over the child's stdio:
  `initialize` → `notifications/initialized` → `tools/list` | `tools/call`, with
  **partial-line buffering** (a response split across read chunks is reassembled)
  and a **timeout → kill** (a wedged server is always reaped — no zombie).
- **stderr is opaque** — drained on a thread and **discarded**, never parsed as
  JSON-RPC. Only stdout carries the protocol.

`src/mcp.ts` is the dev/test **mirror**: the same JSON-RPC framing in pure
TypeScript over an *injected* spawn, so the handshake ordering, partial-line
buffering, timeout→kill and "stderr never parsed" contract are unit-tested
headlessly with a mock stdio server (21 vitest cases; the framing/partial-line/
id-matching helpers have 7 Rust cases).

### The moat applies to MCP too

A `tools/call` is a **side effect**, so it passes the same governance gate as
every other lane (§ Governance). `tools/list` is read-only discovery and is
**not** gated; `tools/call` is `mcp.tool` → **require-approval**:

```
request('mcp.tool', {server, tool}) → approval modal → one-time token
        → mcp_call_tool(token, …)  →  host consumes the token  →  spawn + call
```

Crucially, the token is **consumed host-side** (Rust), bound to `{server, tool}`,
exactly like `governed_command`. The webview never spends it — so a compromised
webview cannot run a tool without a real host-side consume, and a replayed,
forged, or mis-bound token is refused *before the server is ever spawned* (tested:
no-token → no-spawn; token-for-tool-A → refused for tool-B; replay-after-consume
→ refused). Tool errors are honest and **molten**-rimmed; a success is neutral
steel — there is no green anywhere.

---

## Develop & verify (headless)

```bash
pnpm --filter @ai-company-os/desktop test    # vitest — 115 tests
pnpm --filter @ai-company-os/desktop build   # tsc --noEmit && vite build → dist/
pnpm --filter @ai-company-os/desktop lint    # tsc --noEmit

# Rust host (cargo/rustc live in ~/.cargo/bin — not on PATH by default):
export PATH="$HOME/.cargo/bin:$PATH"
cd packages/desktop/src-tauri && cargo check   # requires dist/ to exist first
cargo test --lib                               # 16 governance + MCP unit tests
```

`cargo check` compiles `tauri::generate_context!`, which reads
`build.frontendDist = "../dist"` — run the frontend `build` first so `dist/`
exists.

## Secret storage (OS keychain, S-010 — DONE)

Two kinds of secret, same host-side backend:

- **Auth token + refresh** → `secure_store_{get,set,clear}` (accounts `auth.token` / `auth.refreshToken`).
- **BYOK provider keys** → `key_{add,list,remove,get}` (accounts `byok.<provider>`).

Both live in the **OS keychain** on the shipping platforms — **macOS Keychain**
and **Windows Credential Manager** (via the `keyring` crate) — encrypted at rest
and OS-gated. This is **fail-closed**: on macOS/Windows a keychain hiccup returns
an error, it never silently writes plaintext. On non-shipping platforms
(Linux/other) it falls back to a single `0600` `vault.json`; `secret_backend_secure`
reports which backend is live so the UI never over-claims. `key_list` reads only
the masked `keys-index.json` (provider → `first4…last4`, never a secret); the raw
value leaves the host solely via `key_get`, one-time at direct-dispatch. Legacy
`secrets.json` / `keys.json` are migrated in and deleted on first access
(backend-write before file-removal; an unparseable file is quarantined to
`.corrupt`, never deleted). Outside Tauri (vitest / `vite` browser preview) the TS
store uses an in-memory map, so a secret never lands on disk in dev/test.

**Threat-model scope (honest).** The keychain protects secrets **at rest** — from
disk theft, other local processes, Time Machine/backups, and forensic recovery —
which the old plaintext files did not. It is **not** a runtime barrier against a
compromised webview: `key_get` is deliberately un-gated so BYOK direct-dispatch
stays one-click, so an attacker who defeats the strict CSP (`default-src 'self'`)
and runs script inside the window could still call it. Closing that runtime gap is
the **native per-action approval dialog** follow-up (defter **S-012**), not part of
S-010.

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
- **OS-keychain on Windows** — the storage is DONE and unit-tested; the macOS
  Keychain round-trip is verified locally (`cargo test --ignored keychain_roundtrip`).
  The Windows Credential Manager path shares the same `keyring` API but its live
  round-trip needs a Windows session to confirm.
- **Real OS sandbox** — wrapping the `governed_command` choke point in a
  platform sandbox (container / macOS seatbelt / Windows AppContainer). The
  governance enforcement points (policy, one-time tokens, audit, workdir
  allowlist, argv arrays, env-clean, timeout) are in place today; OS-level
  isolation around them is the remaining hardening — see "Governance & sandbox".
