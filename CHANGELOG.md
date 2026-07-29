# Changelog

All notable changes to `@braavolabs/desktop` (the Tauri v2 native app, bundle id
`com.braavolabs.desktop`) are documented here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/). The app is not yet published, so
entries are grouped by date; versioned sections start when releases do.

The governance moat is the through-line: every side effect (key access, command
run, PTY session, browser action) passes the same fail-closed approval gate +
append-only audit ledger. PR numbers refer to `kocakkmustafa/braavolabs-desktop`.

## [Unreleased]

- **Distribution groundwork** (branch `feat/desktop-distribution`): the repo can
  now actually produce shippable native bundles. Previously `tauri:dev` was a
  human-gate `echo`, there was no `@tauri-apps/cli`, no build script, and the
  `bundle` block carried no per-platform sections — so no artifact had ever been
  built. Added the CLI, real `tauri:build` scripts (incl. a
  `universal-apple-darwin` target), and filled the macOS + Windows bundle
  sections. macOS declares `hardenedRuntime` (a notarization precondition) and a
  10.15 floor; Windows NSIS installs per-user so an unsigned build does not also
  demand elevation. The Linux section is deliberately left empty — Tauri derives
  `libwebkit2gtk-4.1-0, libgtk-3-0` correctly on its own, and hand-written
  package names would be a guess.
- **App icon was the Tauri placeholder.** `icon.png` was a plain orange square,
  so every bundle would have shipped with it in the Dock, Finder and installers.
  Regenerated the full icon set (`.icns` with a 1024px representation, `.ico`,
  Windows Store logos) from the brand mark already used by the mobile app
  (`mobile/assets/icon.png` — the Faceless Envoy). Signing is env-driven
  (`APPLE_SIGNING_IDENTITY`), so no machine-specific identity enters the repo.
- **R6 governed computer-use — host runtime** (branch `feat/r6-host-runtime`):
  the Rust host now *enforces* the pure-core contracts. Increment A wraps every
  `governed_command` spawn in a real OS sandbox (macOS `sandbox-exec` / Linux
  `bwrap`) built from a realpath-resolved least-privilege policy; increment B
  adds real-PTY vendor-CLI sessions (`portable-pty`) behind the same gate.
  Headed runtime verification (CDP browser driver + live sessions) is the
  remaining human-gated step.

## 2026-07-18 → 2026-07-19

### Added
- **R6 governed computer-use pure-core** — three self-contained increments,
  each opus-adversarial reviewed:
  - Lane-C governed computer-control action model (`src/browser.ts`) — every
    CDP action passes the approval gate; non-http(s) navigation hard-denied;
    typed values shown as length only; url-bound one-time token (#4).
  - Lane-B real-PTY core (`src/pty.ts`) — governed interactive vendor-CLI
    sessions; approval covers the (vendor, cwd) session; redacted audit
    (byte counts only, never buffer content) (#5).
  - OS-sandbox policy + SBPL/bwrap profile generation (`src/sandbox.ts`) —
    least-privilege capability model, validate-before-generate, realpath
    delegated to the host (#6).

### Changed
- **Forge → Braavolabs rebrand** — productName, keychain service, i18n, config,
  bundle id `com.braavolabs.desktop`. The internal `src/forge/` module path is
  kept (not user-visible) (#3).

### Fixed
- Sign-out revokes the refresh token with a shared-client drift-guard, so logout
  works even with an expired access token (audit C3/#1) (#2).

## 2026-07-17

### Added
- **R4** — `key_get` is gated on a one-time `direct.dispatch` governance token,
  closing an audit HIGH where a secret could be read without an approval (#1).

### Changed
- Extracted from the `braavolabs` monorepo into the standalone
  `kocakkmustafa/braavolabs-desktop` repo, with its own CI (pnpm pinned).

## 2026-07-16

### Added
- Tauri v2 Rust host scaffold + build tooling.
- Forge API client + obsidian 3-pane UI.
- BYOK key OS-store commands + Lane-A CSP hosts; Lane-A local (Ollama) + BYOK
  direct + key vault.
- P-D3 Lane-B safe-spawn (vendor CLI detect + launch command).
- P-D4 governance-by-default + sandbox choke point.
- P-D5 MCP client — registered servers + gated `tools/call`.
- **S-010** — secrets in the OS keychain (macOS Keychain / Windows Credential
  Manager), with fail-closed keychain, crash-safe migration, honest scope.
- **S-012** — native OS approval dialog the webview cannot forge; the dialog
  shows the *enforced* action (argv/cwd/…), never the webview's free-text
  summary.

### Fixed
- **S-011** — commit `src-tauri/Cargo.lock` for reproducible Rust builds.
- P-D4 audit-log secret leak closed; audit `seq` kept monotonic across restarts.
- P-D5 MCP stdout decoded per-line (not per-chunk).
