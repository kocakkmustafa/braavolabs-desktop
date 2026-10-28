# @braavolabs/desktop — Braavolabs Desktop

Native desktop app (Tauri v2) for multi-model chat, cascade, and savings —
the same Braavolabs server that powers the CLI, in an obsidian three-pane UI.

Support: [support@yulalab.com](mailto:support@yulalab.com).

> **Server = orchestration.** The Braavolabs server owns multi-model routing,
> cascade, and savings. The desktop adds two **Lane-A** side-channels that do
> NOT touch the server — **Local (Ollama)** and **BYOK Direct** — but even these
> carry no AI/orchestration logic in the Rust host: dispatch and provider request
> shaping live in the frontend TypeScript; the host is a thin secret-store pipe.

---

## Architecture

```
desktop/
├── index.html              webview entry (mirrors the Tauri CSP)
├── vite.config.ts          builds ui → dist/, hosts the vitest suite
├── src/                    frontend (TypeScript, no framework)
│   ├── client.ts           Shared API endpoints (single-401 refresh, ApiError,
│   │                       raw mode) plus company-scoped compare discovery.
│   ├── compare-selection.ts typed model/effort metadata validation.
│   ├── compare-controls.ts  server-discovered exact model/effort controls.
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
│   ├── i18n.ts             eight catalogues, explicit locale preference, Intl and RTL.
│   ├── ui.ts               DOM shell (3-pane + keys + Lane-B + approval modal);
│   │                       source-executing handler regression tests.
│   ├── main.ts             entry: hydrate → login or workspace.
│   ├── styles.css          obsidian palette (arc-blue / ember / molten; NO green).
│   └── __tests__/          client / UI handlers / render / store / i18n / keyvault /
│                           local / direct / identity / spawn / governance / mcp.
└── src-tauri/              Rust host (STANDALONE cargo package)
    ├── Cargo.toml          tauri = "2"; not part of any cargo workspace.
    ├── tauri.conf.json      window + CSP (self + HTTPS endpoints + loopback).
    ├── capabilities/default.json  core webview permissions for "main".
    ├── icons/              app icons (ember mark).
    └── src/{main,lib}.rs   window + token + BYOK-key OS-scoped commands +
                            Lane-B spawn_probe + the GOVERNANCE gate (policy
                            mirror, one-time tokens, 0600 audit log, command
                            choke point) + the MCP stdio client (mcp.json,
                            spawn + JSON-RPC session, gated tools/call) and Rust
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
| `GET /research/compare/options?companyId=…` | token | available exact tenant-owned pairs, per-pair `reasoningEfforts`, `maxCandidates`; advisory metadata, no inference. |
| `POST /research/compare/selected` | async | explicit `selections: [{provider,model,reasoningEffort?}]`; server revalidates before starting. Unsupported endpoint fails without automatic fallback. |
| `POST /research/cascade` | sync | **no `companyId`** — tenant-scoped via JWT. |
| `GET /billing/savings?days=N` | token | tenant-scoped tokens-saved report. |
| `GET /memory?companyId=…` | token | company-scoped memory rows (needs an active company). |

Compare defaults to automatic server routing. To choose models, enter the company
ID, select **Select exact models**, and load available models. Choose 1–3 exact
provider/model pairs. Effort appears only where discovery advertises support;
**Provider default effort** omits `reasoningEffort`. Levels are server-defined
controls, not measured reasoning or token budgets. Effort applies to each selected
candidate; synthesis continues to use the server default. Company, account or lane
changes invalidate the choices. Failed/empty discovery cannot start explicit
compare; retry discovery or deliberately choose automatic mode.

These controls apply only to server Compare. Cascade, Local and Direct keep their
existing contracts. Mock transport/DOM tests and a frontend build do not establish
live provider acceptance or native WebView behavior.

Base URL: `VITE_BRAAVOLABS_API_URL` at build time, else `https://braavolabs.com/api/v1`
(overridable on the login screen; remembered in localStorage — non-secret only).

---

## Lane-A — Local (Ollama) & BYOK Direct (server-bypassing)

The chat composer has four source lanes: **Cascade** and **Compare** hit the
Braavolabs server (above); **Local** and **Direct** bypass it entirely.

### Local · Ollama (`local.ts`)

After an initial account sign-in and model installation, Local is keyless and runs without the Braavolabs API. Sign-in itself requires a connection. It talks straight to a local Ollama daemon:

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
Braavolabs server. Providers and their **dated, conservative default models** (NOT a
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
auth token/refresh — in the **macOS Keychain** or **Windows Credential Manager**
on those operating systems (via the `keyring`
crate), encrypted at rest and OS-gated. On macOS/Windows, an unreachable keychain
returns an error; there is no plaintext fallback. Other platforms use a single
owner-only `vault.json` (`0600` on unix); `secret_backend_secure` reports the
backend to the UI. The keychain isn't enumerable, so a
`keys-index.json` holds provider → **masked** fingerprint (`first4…last4`) ONLY —
never a secret — which is all Settings → **BYOK keys** ever reads for its list.
The raw value leaves the store solely via `key_get`, retrieved **one-time at
dispatch** and passed straight into the provider's auth header — never rendered to
the DOM, never logged. Any legacy `keys.json` / `secrets.json` (the earlier 0600
plaintext files) are migrated into the keychain and deleted on first access
(backend write precedes file removal, so a mid-migration crash can only leave the
old file, never lose a secret). The current Tauri `connect-src` permits HTTPS
endpoints and loopback, including configured self-hosts. Direct provider request
URLs remain defined in `src/direct.ts`; `default-src 'self'`, `object-src 'none'`
and `frame-ancestors 'none'` are preserved.

---

## Lane-B · your own CLIs (SAFE-SPAWN)

Lane-B lets Braavolabs run **your OWN, already-signed-in vendor CLI** (`claude` /
`codex`) instead of a key or the Braavolabs server. It is a thin, opaque passthrough —
NOT a re-implementation of the vendor and NOT an OAuth client. The contract
(ported from the CLI's adversarially-verified `forge/spawn.ts`; enforced by
construction in `src/spawn.ts` + `src-tauri/src/lib.rs`):

| # | Rule | How it's enforced |
|---|---|---|
| a | **No vendor OAuth.** You must have logged in with the official binary yourself. | Lane-B never initiates/brokers a vendor sign-in — there is no auth code path. |
| b | **Only the official binary is a target; launch is an argv ARRAY.** | `buildLaunchCommand` returns `{argv, cliDelegation}` arrays — never a shell string, so `"hi; rm -rf /"` stays one inert element (no injection seam). |
| c | **A vendor session's stdout/stderr is OPAQUE.** | The desktop never opens a vendor session in-process; the real interactive run is delegated to `braavo spawn`, which uses `stdio:"inherit"` and captures/parses nothing. |
| d | **Token/cookie files are NEVER touched.** | Detection (`spawn_probe`) probes ONLY `PATH` + neutral bin prefixes (`knownPaths` — homebrew, `/usr/local/bin`, `~/.local/bin`, `~/.bun/bin`, `~/.cargo/bin` for codex). It never reads `~/.claude*`, `~/.codex*`, `auth.json`, or any config dir. Version comes from `<bin> --version` only. |
| f | **Per-vendor ToS-risk is surfaced.** | `VENDOR_SPECS.risk` — claude = *SAFE, volatile*; codex = *SAFE, lowest risk* — shown steel in the rail. |
| g | **Absent binary degrades to the API-key path.** | `spawnFallbackMessage` → "use API key → Direct" (`braavo direct anthropic\|openai …`); never a fabricated result. |

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
   `braavo spawn <vendor>`, which you paste into your terminal. That CLI path
   already implements the opaque `stdio:"inherit"` passthrough (rules b, c).

This keeps the Rust host thin (no AI/orchestration, no captured vendor output)
and reuses the CLI's already-verified spawn path. A full native-terminal Lane-B
inside the window is a future **human gate** (needs a PTY plugin + a GUI session).

---

## Governance & sandbox — governed by default (the moat)

Where "allow-all" agent hosts (Hermes, OpenClaw, …) run whatever an action asks,
Braavolabs Desktop is **governed by default**: every side-effecting action passes a
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

The default is the third row's **and every unknown kind**: an action Braavolabs has
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
outside the webview's reach), and mints a token ONLY on a real human "Allow".
Deny, dismiss, or a 120s timeout → **fail-closed** (no token, audited `rejected`).
The dialog runs async off the main thread (non-blocking `show()` + oneshot channel)
so it can't deadlock the event loop.

The dialog body is derived from the **enforced binding fields** — the actual
`argv` + `cwd` (for a command), the complete immutable invocation (for MCP), `path` (for a
file write) — the exact things the token binds to and the host runs. It is **never**
the webview's free-text `summary`: a compromised webview could set `summary` to
"Sync notes folder" while requesting `rm -rf` in `argv`, so the human must see
what actually runs. Generic fields are sanitized to a bounded line; MCP uses
complete JSON-quoted fields and refuses a preview that cannot fit so the webview can't inject fake dialog
chrome. The in-app arc-rim modal remains a rich preview, but the native dialog is
the **trust anchor** — a webview can neither forge an OS click nor control what the
dialog says. The Lane-A Direct, Lane-B launch, and Local lanes funnel through this
gate.

> **Human gate:** the native dialog's actual rendering and click flow require
> verification in a GUI session (`cargo tauri dev`). Host wiring, fail-closed
> timeout and token logic have headless tests; those do not establish current
> native UI acceptance.

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

Braavolabs Desktop is itself an **MCP client**: register a stdio Model Context
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

Both discovery and calls launch a native process and require native approval.
The Rust host prepares a one-use, 120-second invocation: resolved executable,
launch argv, working directory, inherited environment snapshot and JSON tool
arguments. The complete JSON-quoted effective fields appear in the native
preview; oversized previews are refused. The renderer executes with only the
token. The legacy name-only tool-call IPC no longer exists.

Registry edits (including A→B→A), credential changes, explicit rejection and Kill
invalidate outstanding plans. Final validation, token consumption and OS spawn
share one host lock. Raw arguments and environment stay out of audit/relay; an
action ID links the redacted lifecycle records. This is an ordinary OS process,
not a sandbox or a verified cloud account. Unix executable device/inode identity is also checked. External binary replacement between
check and exec, interpreters, scripts and descendants remain residual risks.
Native concurrency, dialogs and real process teardown require separate
acceptance. Windows MCP launch is held closed in host prepare/execute until
executable-identity and native approval acceptance; provider/chat modes remain
available. The capability read is descriptive and cannot mint a grant; headless adapters do not establish these properties.

Kill aborts local HTTP work, revokes host approvals, requests managed command/MCP
cancellation, kills managed PTYs and stops the companion locally. Independent
cleanup continues when another part fails. Remote provider work, external
terminals and descendants may continue; cancellation does not prove no billing.
Direct/Local and server dispatch use a 120-second whole-response deadline; JSON
provider/local bodies and native retained output are capped at 1 MiB. Native RPC/command waits run on
blocking workers so the IPC dispatcher can process Kill. MCP stdin uses one
bounded writer queue/ack with the same deadline/cancel checks; a blocked write
does not own the reader/deadline loop. There is
no automatic inference retry after these failures.

Local transcripts retain up to 50 chats, 200 entries/chat and 4,000 characters per
entry. The UI reports truncation, quota failure and unreadable history, and can
export retained content. Quota failure keeps the conversation in memory without
automatically evicting 3/4 of persisted history. A corrupt original is preserved
for export/recovery; this is bounded convenience history, not an archive. New
runtime history is partitioned by API base + userId/tenantId only after a
successful login/profile reply matches the exact API/token snapshot. Decoded
JWT labels are never an identity proof or permission to load disk history.
Hydrated boot checks the existing authenticated /users/me route with a 5-second
bound; offline/failed/unknown identity leaves existing bytes untouched and uses
volatile history for new Local work. A changed token/API requires a fresh
verified binding before another namespace can be opened. The old shared v1 record is preserved
and never silently loaded as another account; recovering it requires owner
verification. Ordinary scoped logout never deletes that ownerless legacy
record. Logout reports scoped disk cleanup failure; in-memory history is cleared.

The supported catalogues are `tr`, `en`, `es-419`, `pt-BR`, `de`, `fr`, `ja`, `ar`.
A saved explicit choice takes precedence over device negotiation. Arabic sets
RTL; code/JSON remains LTR. Numbers, USD and times use Intl. Native approval
buttons and host field labels use the chosen locale without changing authority.
Catalogue parity and helper tests do not replace native-speaker, keyboard,
screen-reader or native WebView acceptance.

---

## Develop & verify (headless)

```bash
# From this repository's root; use each run's report for current test counts.
pnpm test                               # vitest
pnpm build                              # tsc --noEmit && vite build → dist/
pnpm lint                               # tsc --noEmit

# Rust host (cargo/rustc live in ~/.cargo/bin — not on PATH by default):
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri
cargo check --locked                    # requires dist/ to exist first
cargo test --locked --lib                # default suite skips real Keychain test
```

`cargo check` compiles `tauri::generate_context!`, which reads
`build.frontendDist = "../dist"` — run the frontend `build` first so `dist/`
exists.

## Secret storage (OS keychain, S-010 implementation)

Two kinds of secret, same host-side backend:

- **Auth token + refresh** → `secure_store_{get,set,clear}` (accounts `auth.token` / `auth.refreshToken`).
- **BYOK provider keys** → `key_{add,list,remove,get}` (accounts `byok.<provider>`).

Both use the **macOS Keychain** or **Windows Credential Manager** on those
operating systems (via the `keyring` crate), encrypted at rest
and OS-gated. This is **fail-closed**: on macOS/Windows a keychain hiccup returns
an error, it never silently writes plaintext. On Linux/other platforms it uses
a single `0600` `vault.json`; `secret_backend_secure`
reports which backend is live so the UI never over-claims. `key_list` reads only
the masked `keys-index.json` (provider → `first4…last4`, never a secret); the raw
value leaves the host solely via `key_get`, one-time at direct-dispatch. Legacy
`secrets.json` / `keys.json` are migrated in and deleted on first access
(backend-write before file-removal; an unparseable file is quarantined to
`.corrupt`, never deleted). Outside Tauri (vitest / `vite` browser preview) the TS
store uses an in-memory map, so a secret never lands on disk in dev/test.

**Protection scope.** The native backend uses OS credential storage rather than
plaintext application files on macOS/Windows. Actual access and backup protection
depend on the OS policy and environment; source and mock tests do not establish
blanket isolation from other processes or forensic recovery.

**Runtime gate (R4 — closed).** `key_get` is **no longer un-gated**: it now consumes
a one-time `direct.dispatch` governance token **bound to the requested provider**
before it will touch the vault (`try_consume_token`). The webview obtains that token
by passing the `direct.dispatch` gate — the **native approval dialog** (S-012) — via
`gateForToken`, and the HOST spends it inside `key_get`. So a compromised webview that
defeats the CSP and calls `key_get` directly has no valid token → the call is rejected
(missing/forged/replayed/mis-bound all fail; verified by cargo tests). The residual
hardening — moving the provider HTTP dispatch fully host-side so the raw key never
enters the webview heap at all — is the documented next layer (still webview-executed
today, but only after a real, provider-bound, human-approved grant).

## Human gates (NOT done here — require a GUI session / signing identity / live services)

- `cargo tauri dev` launches the actual window and needs a desktop session.
  `cargo tauri build` produces native artifacts; successful compilation does not
  establish GUI or signed-distribution acceptance. (`pnpm --filter
  @braavolabs/desktop dev:ui` serves just the frontend in a browser.)
- **Live Lane-A dispatch** — driving a real Ollama daemon (Local) or a real BYOK
  key against a provider (Direct) needs those services present; the request
  shaping is unit-tested with injected fetch, but an end-to-end round-trip is a
  GUI/live-service gate.
- **Signed build** — Apple Developer ID / Windows code-signing cert.
- **Notarization** — Apple notary submission + stapling.
- **Real OS credential storage on macOS and Windows** — production storage has
  mock-backed tests; default `cargo test --locked` does not establish live OS
  acceptance. The test-only `keychain_fixture` module has standalone mock tests
  (`rustc --edition 2021 --test src-tauri/src/keychain_fixture.rs`) and a macOS
  live test that is both `#[ignore]` and guarded by an explicit opt-in.
  When separately authorized, from `src-tauri`:
  ```bash
  BRAAVO_SYNTHETIC_KEYCHAIN_TEST=allow-one-owned-fixture \
    cargo test --locked keychain_fixture::macos::keychain_roundtrip -- \
    --ignored --exact --test-threads=1
  ```
  This creates one fresh account `test.s010.roundtrip.desktop-keychain-test.<nonce>`
  under service `braavolabs-desktop`, using an atomic add that refuses collisions.
  It reads only the newly owned item's synthetic value, deletes by that owned
  native reference and verifies metadata-only absence. It never selects auth or
  BYOK accounts. Errors, unwinding panics and cooperative SIGINT/SIGTERM requests
  go through checked cleanup; cleanup failure fails acceptance and reports only
  the fixture identifier. SIGKILL, abort or OS failure can still leave a fixture;
  never delete an unknown/pre-existing item to recover it. This is OS primitive
  acceptance, not app login/BYOK persistence or provider acceptance.
  The live fixture is macOS-only: Windows needs a separately reviewed adapter
  that can preserve existing credentials and a real Windows session. The former
  fixed-name, overwriting Keychain/Credential Manager test was removed. Production
  storage and its native permission policies are unchanged.
- **Real OS sandbox** — wrapping the `governed_command` choke point in a
  platform sandbox (container / macOS seatbelt / Windows AppContainer). The
  governance enforcement points (policy, one-time tokens, audit, workdir
  allowlist, argv arrays, env-clean, timeout) are in place today; OS-level
  isolation around them is the remaining hardening — see "Governance & sandbox".


## Direct distribution outside app stores

A local build, a signing identity, an OS credential fixture, notarization and a
public release each provide different evidence. Authorize the exact action and
artifact before signing, using credentials, uploading or running real accounts.
Existing signed packages and installed apps remain protected; a valid old app
signature does not identify a new build's source.

### macOS app and DMG

1. Freeze the source commit/tree and lockfile hashes. Confirm the version in
   `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` agrees.
   Record the intended bundle ID `com.braavolabs.desktop`, architecture(s) and
   current source assets. Use the canonical checkout and one bounded output
   location; preserve any existing build cache and unique artifacts.
2. Inspect existing identity metadata with `security find-identity -v -p
   codesigning`. Select the intended team's **Developer ID Application** identity
   for the app, rather than a development or installer identity. Metadata presence
   does not prove permission to use its private key. Do not create/import a
   certificate, unlock a keychain, export a key or change a profile to clear a
   blocker. Apple describes the distinct certificate roles in its
   [Developer ID guide](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/).
3. After separate native-build/signing approval, the existing
   `pnpm tauri:build:mac` script builds `universal-apple-darwin`. A deliberately
   selected single architecture must have a separate acceptance label. Tauri
   accepts an existing signing identity through `APPLE_SIGNING_IDENTITY`;
   keep identity selection local and do not add credentials to the repo.
   The build configuration already enables hardened runtime. Before running a
   bundle command, establish whether existing notarization settings would also
   cause an Apple upload; that upload needs its own approval. See
   [Tauri's local signing guide](https://v2.tauri.app/distribute/sign/macos/).
4. Bind each produced app/archive to the source receipt: SHA256, size, bundle ID,
   version, architectures, signing team, hardened runtime and timestamp. Verify
   the new app with `codesign --verify --deep --strict --all-architectures` and
   inspect its non-secret signature metadata. A failed Apple system control
   makes that execution context inconclusive; stop without changing trust or
   re-signing an old installed app. Keep unsigned/ad-hoc and Developer ID
   artifacts explicitly distinguishable.
5. Notarization is an Apple upload. Use only a separately authorized, existing
   Apple authentication path; do not create a key, password or keychain profile.
   Record the exact submitted archive hash and submission result, then validate
   the stapled ticket and Gatekeeper assessment of the final delivered artifact.
   Follow [Apple's distribution guidance](https://developer.apple.com/developer-id/).
   Missing notarization access remains a blocker even when identity metadata and
   local signature checks pass. No Mac App Store upload is part of this path.
6. Run separately approved native user acceptance on that exact artifact: launch,
   error handling, account transition and companion reconnect/cancel behavior.
   The one-owned-item synthetic Keychain fixture described above proves only an
   OS primitive round trip. Real login/BYOK persistence and provider requests
   need their own scope; provider costs require an explicit bound. Browser/mock
   results and an old installed app cannot replace this artifact's acceptance.
7. Approve the final artifact hashes and destination before public release.
   Keep a source-to-artifact receipt and hash-check cleanup of this run's own
   temporary output; retain unique signed packages and protected user data.

### Windows and Linux

| Target | Existing build evidence path | Additional distribution acceptance |
| --- | --- | --- |
| Windows x64 | `.github/workflows/ci.yml` defines native tests and NSIS build on `windows-2022`, with a SHA256 receipt and recorded Authenticode status. | Recording a status does not require it to be `Valid`. Verify the intended signer and final installer on Windows, then installation/launch/uninstall and real Credential Manager behavior. The macOS fixture does not cover Windows. |
| Linux amd64 | `.github/workflows/release-linux.yml` builds `.deb` and AppImage, verifies files/architecture and runs a native Linux smoke. | Bind the selected source and final hashes to installation/launch on the supported host. Store and public-host uploads need a separate destination decision. |

Remote workflows are not a prerequisite for local signing. This repository is
private: confirm cost/authorization before dispatching CI, opening a PR or
pushing a release tag. The Linux release workflow can run for `v*` tags or manual
dispatch; do not use a tag as a harmless documentation check. A Windows CI build
is not physical Windows distribution acceptance. Neither route authorizes store
upload, profile changes or new signing credentials.
