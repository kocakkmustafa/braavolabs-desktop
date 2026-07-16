//! Forge Desktop — Rust host.
//!
//! Thin by design: window creation + OS-scoped secret commands (auth tokens +
//! BYOK provider keys) + the GOVERNANCE gate. The frontend (packages/desktop/ui)
//! owns every model call — Lane-A local (Ollama) and BYOK direct dispatch happen
//! in the webview; NO AI/orchestration logic lives here (server = orchestration).
//! The host persists secrets to disk with owner-only perms, and — legitimately —
//! owns the security-critical governance: a FAIL-CLOSED policy gate, one-time
//! approval tokens, an append-only audit log, and the single command choke point.
//! Permission/sandbox logic on the host is deliberate (a webview can't forge a
//! host token); AI/orchestration stays out. See the "GOVERNANCE-BY-DEFAULT"
//! section below.
//!
//! ## Secret storage (S-010: OS keychain)
//! Raw secrets — the bearer + refresh tokens and the BYOK provider keys — live
//! in the OS keychain on the platforms this app ships to: the macOS Keychain and
//! the Windows Credential Manager (via the `keyring` crate), where they are
//! encrypted at rest and OS-gated. On any other platform, or if the keychain is
//! unreachable, they fall back to a single owner-only (`0600`) `vault.json`. The
//! `secret_backend_secure` command reports which backend is live, HONESTLY, so
//! the UI never claims OS-grade protection it doesn't actually have.
//!
//! The keychain is not enumerable by service, so the set of BYOK provider names
//! is tracked in a plaintext `keys-index.json` that holds provider → MASKED
//! fingerprint ONLY (never a secret) — mirroring the CLI's proven `forge/keys.ts`
//! design. `key_list` reads the index and thus never touches a raw secret; the
//! raw value leaves the host solely via `key_get`, at BYOK direct-dispatch time.
//!
//! On first access any legacy `secrets.json` / `keys.json` (the earlier 0600
//! plaintext files) are migrated into the backend and then deleted — the write
//! into the backend happens BEFORE the legacy file is removed, so a crash
//! mid-migration can only leave the old file behind (safe to retry), never lose
//! a secret.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

/// Token bundle mirrored to the CLI's config field names ({token, refreshToken})
/// so the two clients share one mental model. Serialized as camelCase so the
/// JS store (store.ts) reads `token` / `refreshToken` directly.
#[derive(Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Secrets {
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
}

// ── Secret backend abstraction ───────────────────────────────────────────────

const VAULT_SERVICE: &str = "forge-desktop";
const ACCT_TOKEN: &str = "auth.token";
const ACCT_REFRESH: &str = "auth.refreshToken";

/// Keychain account name for a BYOK provider's secret.
fn byok_account(provider: &str) -> String {
    format!("byok.{provider}")
}

/// An account-keyed secret store. Two production impls: the OS keychain
/// (`KeychainBackend`, macOS/Windows) and a 0600 JSON file (`FileBackend`,
/// every platform). The command layer resolves one via `make_backend`.
trait SecretBackend: Send + Sync {
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn delete(&self, account: &str) -> Result<(), String>;
    /// True ONLY when backed by the OS keychain (encrypted at rest, OS-gated).
    /// The webview surfaces this so it never over-claims protection.
    fn secure(&self) -> bool;
}

/// OS keychain backend — macOS Keychain / Windows Credential Manager. Each
/// (service, account) pair is one credential. `keyring` access is synchronous.
#[cfg(any(target_os = "macos", target_os = "windows"))]
struct KeychainBackend;

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl SecretBackend for KeychainBackend {
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        keyring::Entry::new(VAULT_SERVICE, account)
            .and_then(|e| e.set_password(secret))
            .map_err(|e| e.to_string())
    }
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        match keyring::Entry::new(VAULT_SERVICE, account).and_then(|e| e.get_password()) {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        match keyring::Entry::new(VAULT_SERVICE, account).and_then(|e| e.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
    fn secure(&self) -> bool {
        true
    }
}

/// 0600 fallback: a single JSON `{ account: secret }` map so the token and BYOK
/// keys share one owner-only artifact. The active backend on non-mac/win
/// platforms (Linux/other — not a shipping target); on macOS/Windows it exists
/// only as a test fixture (those platforms are keychain-only, fail-closed), so
/// it reads as dead code in a non-test mac/win `cargo check` — hence the scoped
/// allow rather than deleting a genuinely-used-elsewhere type.
#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
struct FileBackend {
    path: PathBuf,
}

#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
impl FileBackend {
    fn read_map(&self) -> Result<BTreeMap<String, String>, String> {
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
            Err(_) => Ok(BTreeMap::new()),
        }
    }
    fn write_map(&self, map: &BTreeMap<String, String>) -> Result<(), String> {
        if map.is_empty() {
            let _ = fs::remove_file(&self.path);
            return Ok(());
        }
        let data = serde_json::to_vec(map).map_err(|e| e.to_string())?;
        write_private(&self.path, &data)
    }
}

impl SecretBackend for FileBackend {
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        let mut map = self.read_map()?;
        map.insert(account.to_string(), secret.to_string());
        self.write_map(&map)
    }
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.read_map()?.get(account).cloned())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        let mut map = self.read_map()?;
        if map.remove(account).is_some() {
            self.write_map(&map)?;
        }
        Ok(())
    }
    fn secure(&self) -> bool {
        false
    }
}

/// Resolve the live backend for this platform. On macOS/Windows it is ALWAYS
/// the OS keychain — FAIL-CLOSED: if the keychain is momentarily unreachable a
/// secret operation returns an error, it does NOT silently downgrade to a
/// plaintext file. That silent-downgrade path (an earlier design) caused a
/// split-brain: a transient keychain hiccup would write some secrets to the
/// keychain and others to plaintext `vault.json`, and a later delete on the
/// keychain backend would leave the plaintext copy orphaned. On platforms with
/// no keychain (Linux/other — not a shipping target) it is the 0600 file, and
/// `secure()` reports that honestly.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn make_backend(_config_dir: &Path) -> Box<dyn SecretBackend> {
    Box::new(KeychainBackend)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn make_backend(config_dir: &Path) -> Box<dyn SecretBackend> {
    Box::new(FileBackend {
        path: config_dir.join("vault.json"),
    })
}

#[cfg(unix)]
fn write_private(path: &Path, data: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600) // owner read/write only — applied on CREATE
        .open(path)
        .map_err(|e| e.to_string())?;
    f.write_all(data).map_err(|e| e.to_string())?;
    // .mode() only takes effect when the file is created; a pre-existing file
    // (e.g. one written by an older build with looser perms) keeps its mode.
    // Re-assert 0600 idempotently so an existing file is tightened too.
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    Ok(())
}

#[cfg(not(unix))]
fn write_private(path: &Path, data: &[u8]) -> Result<(), String> {
    // Windows ACL hardening is a follow-up; app-config dir is already per-user.
    fs::write(path, data).map_err(|e| e.to_string())
}

// ── One-time legacy migration (0600 files → backend) ─────────────────────────

/// Move any pre-S-010 `secrets.json` / `keys.json` into the backend + masked
/// index, then delete them. Idempotent (missing files are a no-op). Runs on
/// every secret command; once the legacy files are gone it's two cheap
/// `fs::read` misses.
///
/// Data-safety invariants (each legacy file is handled independently):
///   - The backend write happens BEFORE the file is removed, so a crash between
///     them can only leave the old file behind (safe to retry), never lose a
///     secret. If `backend.set` errors, we `?`-return with the file INTACT.
///   - A file that fails to PARSE is NOT deleted — it is renamed to
///     `<name>.corrupt` and left in place. A truncated write from an earlier
///     crash is exactly this case; deleting it (the earlier behaviour) would be
///     permanent secret loss. Renaming keeps it recoverable without letting it
///     re-trigger migration on every call.
fn migrate_legacy(backend: &dyn SecretBackend, config_dir: &Path) -> Result<(), String> {
    let secrets_file = config_dir.join("secrets.json");
    if let Ok(bytes) = fs::read(&secrets_file) {
        match serde_json::from_slice::<Secrets>(&bytes) {
            Ok(s) => {
                if let Some(t) = s.token {
                    backend.set(ACCT_TOKEN, &t)?; // file intact if this errors
                }
                if let Some(r) = s.refresh_token {
                    backend.set(ACCT_REFRESH, &r)?;
                }
                let _ = fs::remove_file(&secrets_file); // only after successful set(s)
            }
            Err(_) => quarantine_corrupt(&secrets_file),
        }
    }

    let keys_file = config_dir.join("keys.json");
    if let Ok(bytes) = fs::read(&keys_file) {
        match serde_json::from_slice::<BTreeMap<String, String>>(&bytes) {
            Ok(map) => {
                let mut index = read_index(config_dir);
                for (provider, secret) in map {
                    backend.set(&byok_account(&provider), &secret)?; // file intact if this errors
                    index.insert(provider, mask_key(&secret));
                }
                write_index(config_dir, &index)?;
                let _ = fs::remove_file(&keys_file); // only after every set + index write
            }
            Err(_) => quarantine_corrupt(&keys_file),
        }
    }
    Ok(())
}

/// A legacy file we couldn't parse is renamed aside (never deleted) so its
/// bytes stay recoverable, and it stops re-triggering migration every call.
fn quarantine_corrupt(path: &Path) {
    let quarantined = path.with_extension("corrupt");
    // If the rename fails, leave the original untouched — losing nothing is the
    // whole point; the file simply gets retried next time.
    let _ = fs::rename(path, quarantined);
}

// ── Auth token store (secure_store_*) ────────────────────────────────────────

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
fn secure_store_get(app: AppHandle) -> Result<Secrets, String> {
    let dir = config_dir(&app)?;
    let backend = make_backend(&dir);
    migrate_legacy(backend.as_ref(), &dir)?;
    Ok(Secrets {
        token: backend.get(ACCT_TOKEN)?,
        refresh_token: backend.get(ACCT_REFRESH)?,
    })
}

#[tauri::command]
fn secure_store_set(
    app: AppHandle,
    token: Option<String>,
    refresh_token: Option<String>,
) -> Result<(), String> {
    let dir = config_dir(&app)?;
    let backend = make_backend(&dir);
    // Per-account set/delete mirrors the old whole-struct write: a field passed
    // as None clears that account (the previous code stored a struct with the
    // field absent, i.e. logged out of that token).
    set_or_delete(backend.as_ref(), ACCT_TOKEN, token)?;
    set_or_delete(backend.as_ref(), ACCT_REFRESH, refresh_token)?;
    Ok(())
}

fn set_or_delete(backend: &dyn SecretBackend, account: &str, value: Option<String>) -> Result<(), String> {
    match value {
        Some(v) => backend.set(account, &v),
        None => backend.delete(account),
    }
}

#[tauri::command]
fn secure_store_clear(app: AppHandle) -> Result<(), String> {
    let dir = config_dir(&app)?;
    let backend = make_backend(&dir);
    // Idempotent — clearing already-clear accounts is fine.
    let _ = backend.delete(ACCT_TOKEN);
    let _ = backend.delete(ACCT_REFRESH);
    Ok(())
}

/// Honest backend indicator for the UI ("OS keychain" vs "encrypted file").
#[tauri::command]
fn secret_backend_secure(app: AppHandle) -> Result<bool, String> {
    let dir = config_dir(&app)?;
    Ok(make_backend(&dir).secure())
}

// ── BYOK provider keys ───────────────────────────────────────────────────────
//
// Secrets live in the backend under `byok.<provider>`. `keys-index.json` holds
// provider → MASKED fingerprint (never a secret), so `key_list` enumerates
// without ever reading a raw secret. `key_get` returns the raw value and is
// called ONLY at direct-dispatch time.

/// One masked entry for the Settings → Keys list. `masked` is first4…last4 (or
/// "…" for short values) — never the raw secret.
#[derive(Serialize)]
struct KeyEntry {
    provider: String,
    masked: String,
}

/// Reveal nothing meaningful: first4…last4 only when there's a real hidden
/// middle (≥5 chars hidden ⇒ len ≥ 13), otherwise just "…". A shorter key would
/// leak most of its entropy through first4…last4, so it shows nothing at all.
/// Char-based so multibyte keys never panic on a byte-boundary slice.
fn mask_key(secret: &str) -> String {
    let s = secret.trim();
    let chars: Vec<char> = s.chars().collect();
    if chars.len() < 13 {
        return "…".to_string();
    }
    let first: String = chars[..4].iter().collect();
    let last: String = chars[chars.len() - 4..].iter().collect();
    format!("{first}…{last}")
}

fn index_file(config_dir: &Path) -> PathBuf {
    config_dir.join("keys-index.json")
}

/// provider → masked fingerprint. Masked values are NOT secrets, but the file
/// is still written 0600 for tidiness.
fn read_index(config_dir: &Path) -> BTreeMap<String, String> {
    match fs::read(index_file(config_dir)) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => BTreeMap::new(),
    }
}

fn write_index(config_dir: &Path, index: &BTreeMap<String, String>) -> Result<(), String> {
    if index.is_empty() {
        let _ = fs::remove_file(index_file(config_dir));
        return Ok(());
    }
    let data = serde_json::to_vec(index).map_err(|e| e.to_string())?;
    write_private(&index_file(config_dir), &data)
}

#[tauri::command]
fn key_add(app: AppHandle, provider: String, secret: String) -> Result<(), String> {
    let provider = provider.trim().to_string();
    if provider.is_empty() {
        return Err("provider is required".into());
    }
    if secret.trim().is_empty() {
        return Err("secret is required".into());
    }
    let dir = config_dir(&app)?;
    let backend = make_backend(&dir);
    migrate_legacy(backend.as_ref(), &dir)?;
    // Secret into the backend FIRST; only then record it in the index, so the
    // index never advertises a provider whose secret failed to persist.
    backend.set(&byok_account(&provider), &secret)?;
    let mut index = read_index(&dir);
    index.insert(provider, mask_key(&secret));
    write_index(&dir, &index)
}

#[tauri::command]
fn key_list(app: AppHandle) -> Result<Vec<KeyEntry>, String> {
    let dir = config_dir(&app)?;
    let backend = make_backend(&dir);
    migrate_legacy(backend.as_ref(), &dir)?;
    // Reads ONLY the masked index — never a raw secret.
    Ok(read_index(&dir)
        .into_iter()
        .map(|(provider, masked)| KeyEntry { provider, masked })
        .collect())
}

#[tauri::command]
fn key_remove(app: AppHandle, provider: String) -> Result<(), String> {
    let provider = provider.trim().to_string();
    let dir = config_dir(&app)?;
    let backend = make_backend(&dir);
    backend.delete(&byok_account(&provider))?;
    let mut index = read_index(&dir);
    index.remove(&provider);
    write_index(&dir, &index)
}

/// Raw secret for a single provider — call ONLY at direct-dispatch time.
/// Returns `None` when the provider has no stored key (webview renders an
/// honest "no key" error rather than dispatching).
#[tauri::command]
fn key_get(app: AppHandle, provider: String) -> Result<Option<String>, String> {
    let dir = config_dir(&app)?;
    let backend = make_backend(&dir);
    migrate_legacy(backend.as_ref(), &dir)?;
    backend.get(&byok_account(provider.trim()))
}

// ── Lane-B SAFE-SPAWN — vendor CLI detection ─────────────────────────────────
//
// The ONLY host-side Lane-B surface. It answers exactly one question about the
// user's OWN official vendor CLI (claude / codex): "installed? which path? what
// version?" — and NOTHING else. It NEVER spawns an interactive session, never
// captures a vendor session's stdout/stderr, and never reads a token/credential
// file: discovery looks only at PATH + neutral, tool-agnostic bin prefixes
// (mirroring the TS `knownPaths` contract in src/spawn.ts). The actual
// interactive session is delegated to the proven `forge spawn` CLI (see the
// desktop README "Lane-B safety contract"); no AI/orchestration logic lives here.

/// One vendor's detection result. camelCase so the webview (spawn.ts) reads
/// `installed` / `path` / `version` directly.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VendorProbe {
    installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
}

/// Map a vendor name to its bare executable name. Unknown vendors are rejected
/// (the webview only ever sends "claude" / "codex", but the host does not trust
/// input) — this bounds the set of binaries the host will ever probe.
fn vendor_bin(vendor: &str) -> Option<&'static str> {
    match vendor {
        "claude" => Some("claude"),
        "codex" => Some("codex"),
        _ => None,
    }
}

/// Resolve a bare binary via PATH (the equivalent of `which`), platform-aware.
/// Returns the first PATH entry that holds an existing file. Never a config dir.
fn find_on_path(bin: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let cand = dir.join(bin);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// Neutral install prefixes to probe when a binary is not on PATH. Deliberately
/// NOT vendor config/token dirs (rule d) — the exact mirror of TS `knownPaths`.
fn neutral_prefixes(app: &AppHandle, vendor: &str, bin: &str) -> Vec<PathBuf> {
    let mut paths = vec![
        PathBuf::from(format!("/opt/homebrew/bin/{bin}")),
        PathBuf::from(format!("/usr/local/bin/{bin}")),
    ];
    if let Ok(home) = app.path().home_dir() {
        paths.push(home.join(".local/bin").join(bin));
        paths.push(home.join(".bun/bin").join(bin));
        if vendor == "codex" {
            paths.push(home.join(".cargo/bin").join(bin));
        }
    }
    paths
}

/// Read a version line from the resolved binary (`<bin> --version`). This reads
/// ONLY the binary itself — never a token/login file (rule d). A binary present
/// but without a working `--version` still counts as installed (version None).
fn read_version(path: &std::path::Path) -> Option<String> {
    let out = std::process::Command::new(path)
        .arg("--version")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        None
    } else {
        Some(line.to_string())
    }
}

/// Detect whether the user's official vendor CLI is installed, and its version.
/// Reports installed-or-not ONLY — it never probes login state (that would mean
/// reading a token/cookie file, rule d). An unknown vendor yields not-installed.
#[tauri::command]
fn spawn_probe(app: AppHandle, vendor: String) -> Result<VendorProbe, String> {
    let bin = match vendor_bin(vendor.trim()) {
        Some(b) => b,
        None => return Ok(VendorProbe { installed: false, path: None, version: None }),
    };
    let resolved = find_on_path(bin).or_else(|| {
        neutral_prefixes(&app, vendor.trim(), bin)
            .into_iter()
            .find(|p| p.is_file())
    });
    match resolved {
        None => Ok(VendorProbe { installed: false, path: None, version: None }),
        Some(path) => {
            let version = read_version(&path);
            Ok(VendorProbe {
                installed: true,
                path: Some(path.to_string_lossy().into_owned()),
                version,
            })
        }
    }
}

// ── GOVERNANCE-BY-DEFAULT — the host-side enforcement point ───────────────────
//
// This is the security MOAT: every side-effecting action passes a FAIL-CLOSED
// policy gate before it can run, and a command can ONLY run through one governed
// choke point. The webview cannot forge a token — tokens live here, behind a
// Mutex, and are spent exactly once. `classify` mirrors src/governance.ts (the
// single source of truth); if the two ever diverge, the TS tests + these Rust
// tests are the tripwire.
//
// HONEST BOUNDARY: this layer is "governed + choke-point". It is NOT OS-level
// sandbox isolation (container / seatbelt / AppContainer) — that is a documented
// roadmap/human-gate (see README "Governance & sandbox"). What IS enforced here:
// fail-closed policy, one-time approval tokens, an append-only 0600 audit log,
// and a command choke point with a working-dir allowlist, argv arrays (no shell
// string), optional env-clean, and a timeout.

/// Policy decision, mirroring the TS `Decision` union. `&'static str` values are
/// serialized to the webview verbatim.
fn classify(kind: &str, argv: &[String], path: Option<&str>) -> (&'static str, &'static str) {
    // 1. Hard denies first (a denied action is never approvable).
    if kind == "command.run" && is_destructive(&argv.join(" ")) {
        return ("deny", "destructive command pattern");
    }
    if kind == "file.write" {
        if let Some(p) = path {
            if is_traversal(p) {
                return ("deny", "path traversal blocked");
            }
        }
    }
    // 2. Explicit auto-allow set (read-only / local-keyless only).
    if kind == "probe.detect" || kind == "local.dispatch" {
        return ("auto-allow", "read-only / local-keyless");
    }
    // 3. FAIL-CLOSED default — unknown kinds land here too.
    let known = matches!(
        kind,
        "direct.dispatch" | "spawn.launch" | "command.run" | "mcp.tool" | "file.write"
    );
    if known {
        ("require-approval", "side-effecting action")
    } else {
        ("require-approval", "unknown action (fail-closed)")
    }
}

/// True when a joined command line matches an obviously destructive pattern.
/// Substring/keyword checks kept simple + dependency-free (no regex crate).
fn is_destructive(joined: &str) -> bool {
    let s = joined.to_lowercase();
    s.contains("rm -rf")
        || s.contains("rm -r ")
        || s.contains("mkfs")
        || s.contains("dd if=")
        || s.contains("> /dev/sd")
        || s.contains("> /dev/nvme")
        || s.contains("> /dev/disk")
        || s.replace(' ', "").contains(":(){:|:&};:") // fork bomb
}

/// True when a path tries to escape its base via a `..` segment.
fn is_traversal(path: &str) -> bool {
    path.split(['/', '\\']).any(|seg| seg == "..")
}

/// Strip anything credential-shaped from free text before it enters the ledger.
///
/// SUBSTRING-based, not word-based. `governed_command` redacts `argv.join(" ")`
/// into the audit log, and command arguments routinely glue a secret to
/// punctuation — `--api-key=sk-…`, `token:…`, a dotted JWT after `Bearer`. A
/// whitespace-word scan misses every one of those (the token is not its own
/// word). This mirrors the TS `redactSummary` regex semantics (governance.ts)
/// so the two enforcement paths scrub identically, dependency-free (no regex crate).
fn redact(s: &str) -> String {
    // Pass 1: `Bearer <token>` — the token class includes '.' (JWTs), so it must
    // run before the key-char scan (which stops at a dot).
    let s = redact_bearer(s);
    // Pass 2: maximal runs of key-chars [A-Za-z0-9_-]; redact a long opaque token
    // (>=32) or an `sk-` prefixed key (sk- + >=6). Scanning runs — not words —
    // means a secret bounded by `=`, `:`, `"`, etc. is still caught.
    redact_key_runs(&s)
}

fn is_key_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// Emit one accumulated key-char run, redacting it iff it looks like a secret.
fn push_redacted_run(run: &str, out: &mut String) {
    if run.is_empty() {
        return;
    }
    // run is all-ASCII key chars, so byte len == char len.
    let secret = run.len() >= 32 || (run.starts_with("sk-") && run.len() >= 9);
    out.push_str(if secret { "«redacted»" } else { run });
}

fn redact_key_runs(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut run = String::new();
    for c in s.chars() {
        if is_key_char(c) {
            run.push(c);
        } else {
            push_redacted_run(&run, &mut out);
            run.clear();
            out.push(c);
        }
    }
    push_redacted_run(&run, &mut out);
    out
}

/// Replace the token after a `Bearer ` label (case-insensitive) with a marker.
/// Char-indexed (never byte-indexed) so multibyte input can never split a scalar.
fn redact_bearer(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let n = chars.len();
    const WORD: [char; 6] = ['b', 'e', 'a', 'r', 'e', 'r'];
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < n {
        let is_bearer = i + 6 <= n && (0..6).all(|k| chars[i + k].to_ascii_lowercase() == WORD[k]);
        if is_bearer {
            let mut j = i + 6;
            let mut saw_ws = false;
            while j < n && chars[j].is_ascii_whitespace() {
                j += 1;
                saw_ws = true;
            }
            let tok_start = j;
            while j < n && (chars[j].is_ascii_alphanumeric() || matches!(chars[j], '.' | '_' | '-')) {
                j += 1;
            }
            if saw_ws && j - tok_start >= 6 {
                out.push_str("Bearer «redacted»");
                i = j;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// True iff `cwd` canonicalizes inside one of the allowlisted roots.
fn workdir_allowed(cwd: &Path, allow: &[PathBuf]) -> bool {
    let real = match cwd.canonicalize() {
        Ok(p) => p,
        Err(_) => return false, // non-existent / unreadable dir → refuse
    };
    allow.iter().any(|root| {
        root.canonicalize()
            .map(|r| real.starts_with(r))
            .unwrap_or(false)
    })
}

/// Detail meta crossing from the webview — NEVER a secret (only action meta).
#[derive(Deserialize, Default, Clone)]
#[serde(default, rename_all = "camelCase")]
struct ActionDetail {
    summary: Option<String>,
    argv: Option<Vec<String>>,
    cwd: Option<String>,
    path: Option<String>,
    tool: Option<String>,
    server: Option<String>,
    vendor: Option<String>,
    provider: Option<String>,
}

impl ActionDetail {
    /// Stable binding key so a token issued for action A can't authorize B.
    fn binding(&self, kind: &str) -> String {
        format!(
            "{kind}|{:?}|{:?}|{:?}|{:?}|{:?}|{:?}|{:?}",
            self.argv, self.cwd, self.path, self.tool, self.server, self.vendor, self.provider
        )
    }
    fn summary_or(&self, kind: &str) -> String {
        redact(self.summary.as_deref().unwrap_or(kind))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GateResult {
    action_id: String,
    decision: String,
    reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AuditEntry {
    seq: u64,
    ts: u64,
    kind: String,
    decision: String,
    outcome: String,
    summary: String,
}

#[derive(Clone)]
struct Bound {
    /// Kept for audit correlation / future use; not read on the hot path.
    #[allow(dead_code)]
    action_id: String,
    kind: String,
    binding: String,
}

/// The host-owned gate state. Behind a Mutex; the webview never sees it.
#[derive(Default)]
struct GateState {
    pending: HashMap<String, Bound>, // actionId → awaiting approval
    tokens: HashMap<String, Bound>,  // token → bound action (spent on consume)
    seq: u64,
}

struct Governance(Mutex<GateState>);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn audit_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("audit.log"))
}

/// Highest `seq` already persisted in the append-only log. Pure over the file
/// text so it is unit-testable without a real AppHandle/disk.
fn max_seq_in_log(text: &str) -> u64 {
    text.lines()
        .filter_map(|l| serde_json::from_str::<AuditEntry>(l).ok())
        .map(|e| e.seq)
        .max()
        .unwrap_or(0)
}

/// Append one JSON line to the 0600 audit log. Best-effort — an audit failure
/// must never crash a decision, but a secret must never be written: `summary`
/// is redacted by the caller and no token/secret field exists on the entry.
fn audit_append(app: &AppHandle, gate: &mut GateState, kind: &str, decision: &str, outcome: &str, summary: &str, ts: u64) -> AuditEntry {
    // GateState is in-memory and resets to seq=0 on every launch, but audit.log
    // PERSISTS. Seed the counter from the existing log on the first append of a
    // run so `seq` stays strictly monotonic across restarts (the documented
    // "reliable order key") instead of restarting at 1 and colliding.
    if gate.seq == 0 {
        if let Ok(path) = audit_path(app) {
            if let Ok(text) = fs::read_to_string(&path) {
                gate.seq = max_seq_in_log(&text);
            }
        }
    }
    gate.seq += 1;
    let entry = AuditEntry {
        seq: gate.seq,
        ts: if ts == 0 { now_ms() } else { ts },
        kind: kind.to_string(),
        decision: decision.to_string(),
        outcome: outcome.to_string(),
        summary: redact(summary),
    };
    if let Ok(path) = audit_path(app) {
        if let Ok(mut line) = serde_json::to_vec(&entry) {
            line.push(b'\n');
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).mode(0o600).open(&path) {
                    let _ = f.write_all(&line);
                }
            }
            #[cfg(not(unix))]
            {
                if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
                    let _ = f.write_all(&line);
                }
            }
        }
    }
    entry
}

fn mint_id(prefix: &str, seq: u64) -> String {
    // Counter + nanos nonce. One-time-use is enforced by removal from the map
    // (the tested property); this is a replay nonce, NOT a cryptographic secret.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{prefix}_{seq}_{nanos}")
}

#[tauri::command]
fn request_action(app: AppHandle, gov: State<'_, Governance>, kind: String, detail: Option<ActionDetail>, ts: Option<u64>) -> Result<GateResult, String> {
    let detail = detail.unwrap_or_default();
    let ts = ts.unwrap_or(0);
    let (decision, reason) = classify(&kind, detail.argv.as_deref().unwrap_or(&[]), detail.path.as_deref());
    let mut gate = gov.0.lock().map_err(|_| "gate poisoned")?;
    let action_id = mint_id("act", gate.seq + 1);
    let binding = detail.binding(&kind);
    let summary = detail.summary_or(&kind);

    match decision {
        "deny" => {
            audit_append(&app, &mut gate, &kind, decision, "denied", &summary, ts);
            Ok(GateResult { action_id, decision: decision.into(), reason: reason.into(), token: None })
        }
        "auto-allow" => {
            let token = mint_id("tok", gate.seq + 1);
            gate.tokens.insert(token.clone(), Bound { action_id: action_id.clone(), kind: kind.clone(), binding });
            audit_append(&app, &mut gate, &kind, decision, "granted", &summary, ts);
            Ok(GateResult { action_id, decision: decision.into(), reason: reason.into(), token: Some(token) })
        }
        _ => {
            gate.pending.insert(action_id.clone(), Bound { action_id: action_id.clone(), kind: kind.clone(), binding });
            audit_append(&app, &mut gate, &kind, decision, "pending", &summary, ts);
            Ok(GateResult { action_id, decision: "require-approval".into(), reason: reason.into(), token: None })
        }
    }
}

#[tauri::command]
fn approve_action(app: AppHandle, gov: State<'_, Governance>, action_id: String, ts: Option<u64>) -> Result<serde_json::Value, String> {
    let ts = ts.unwrap_or(0);
    let mut gate = gov.0.lock().map_err(|_| "gate poisoned")?;
    let rec = gate.pending.remove(&action_id).ok_or("no pending action for that id")?;
    let token = mint_id("tok", gate.seq + 1);
    gate.tokens.insert(token.clone(), rec.clone());
    audit_append(&app, &mut gate, &rec.kind, "require-approval", "approved", &rec.kind, ts);
    Ok(serde_json::json!({ "token": token }))
}

#[tauri::command]
fn reject_action(app: AppHandle, gov: State<'_, Governance>, action_id: String, ts: Option<u64>) -> Result<(), String> {
    let ts = ts.unwrap_or(0);
    let mut gate = gov.0.lock().map_err(|_| "gate poisoned")?;
    if let Some(rec) = gate.pending.remove(&action_id) {
        audit_append(&app, &mut gate, &rec.kind, "require-approval", "rejected", &rec.kind, ts);
    }
    Ok(())
}

#[tauri::command]
fn consume_action(app: AppHandle, gov: State<'_, Governance>, token: String, kind: String, detail: Option<ActionDetail>, ts: Option<u64>) -> Result<bool, String> {
    let detail = detail.unwrap_or_default();
    let ts = ts.unwrap_or(0);
    let mut gate = gov.0.lock().map_err(|_| "gate poisoned")?;
    match gate.tokens.get(&token).cloned() {
        // Missing = replay (already spent) or forgery (never issued).
        None => {
            audit_append(&app, &mut gate, &kind, "-", "replay-rejected", &kind, ts);
            Ok(false)
        }
        Some(rec) if rec.kind != kind || rec.binding != detail.binding(&kind) => {
            audit_append(&app, &mut gate, &kind, "-", "replay-rejected", &kind, ts);
            Ok(false)
        }
        Some(_) => {
            gate.tokens.remove(&token); // one-time
            let summary = detail.summary_or(&kind);
            audit_append(&app, &mut gate, &kind, "-", "consumed", &summary, ts);
            Ok(true)
        }
    }
}

#[tauri::command]
fn settle_action(app: AppHandle, gov: State<'_, Governance>, kind: String, outcome: String, detail: Option<ActionDetail>, ts: Option<u64>) -> Result<(), String> {
    let detail = detail.unwrap_or_default();
    let ts = ts.unwrap_or(0);
    // Only terminal outcomes may be settled — never fabricate a decision here.
    let outcome = if outcome == "success" || outcome == "error" { outcome } else { "error".to_string() };
    let mut gate = gov.0.lock().map_err(|_| "gate poisoned")?;
    let summary = detail.summary_or(&kind);
    audit_append(&app, &mut gate, &kind, "-", &outcome, &summary, ts);
    Ok(())
}

/// Read the last `n` audit lines. Parses the append-only log; malformed lines
/// are skipped rather than failing the read. Never returns a secret (the log
/// itself never contains one).
#[tauri::command]
fn audit_recent(app: AppHandle, n: Option<usize>) -> Result<Vec<AuditEntry>, String> {
    let n = n.unwrap_or(50);
    let path = audit_path(&app)?;
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return Ok(vec![]), // no log yet ⇒ empty
    };
    let mut entries: Vec<AuditEntry> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<AuditEntry>(l).ok())
        .collect();
    let from = entries.len().saturating_sub(n);
    Ok(entries.split_off(from))
}

/// Outcome of a governed command run.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandResult {
    code: Option<i32>,
    timed_out: bool,
    /// stdout is returned to the caller but NEVER written to the audit log.
    stdout: String,
    stderr: String,
}

/// THE COMMAND CHOKE POINT. The single path through which a command may ever run.
/// It requires a valid one-time token (from an approved request), enforces a
/// working-dir allowlist (canonicalized — no `..` escape), builds an argv ARRAY
/// (never a shell string), optionally clears the environment, and applies a
/// timeout. This is the enforcement surface; a real OS sandbox around it is a
/// documented human-gate.
#[tauri::command]
fn governed_command(
    app: AppHandle,
    gov: State<'_, Governance>,
    token: String,
    argv: Vec<String>,
    cwd: String,
    clean_env: Option<bool>,
    timeout_ms: Option<u64>,
    ts: Option<u64>,
) -> Result<CommandResult, String> {
    use std::process::{Command, Stdio};
    let ts = ts.unwrap_or(0);

    // 1. Spend the token — a command CANNOT run without passing the gate.
    let detail = ActionDetail { argv: Some(argv.clone()), cwd: Some(cwd.clone()), ..Default::default() };
    {
        let mut gate = gov.0.lock().map_err(|_| "gate poisoned")?;
        let ok = match gate.tokens.get(&token).cloned() {
            Some(rec) if rec.kind == "command.run" && rec.binding == detail.binding("command.run") => true,
            _ => false,
        };
        if !ok {
            audit_append(&app, &mut gate, "command.run", "-", "replay-rejected", "command.run", ts);
            return Err("invalid or already-spent token".into());
        }
        gate.tokens.remove(&token);
        audit_append(&app, &mut gate, "command.run", "-", "consumed", &redact(&argv.join(" ")), ts);
    }

    // 2. Re-validate at the choke point (defense-in-depth, independent of policy).
    if argv.is_empty() {
        return Err("empty argv".into());
    }
    if is_destructive(&argv.join(" ")) {
        return Err("destructive command refused at choke point".into());
    }
    let allow = command_allowlist(&app);
    let cwd_path = PathBuf::from(&cwd);
    if !workdir_allowed(&cwd_path, &allow) {
        return Err("working directory is not in the allowlist".into());
    }

    // 3. Build the child from an argv ARRAY — never a shell string.
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]).current_dir(&cwd_path).stdout(Stdio::piped()).stderr(Stdio::piped());
    if clean_env.unwrap_or(false) {
        cmd.env_clear();
        // Keep a minimal PATH so the binary resolves; nothing else leaks in.
        if let Some(p) = std::env::var_os("PATH") {
            cmd.env("PATH", p);
        }
    }

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    // 4. Timeout: poll try_wait to a deadline, then kill.
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms.unwrap_or(30_000));
    let mut timed_out = false;
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(_) => break,
            None => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    let result = CommandResult {
        code: output.status.code(),
        timed_out,
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    };
    {
        let mut gate = gov.0.lock().map_err(|_| "gate poisoned")?;
        let outcome = if timed_out || result.code != Some(0) { "error" } else { "success" };
        audit_append(&app, &mut gate, "command.run", "-", outcome, "command.run", ts);
    }
    Ok(result)
}

/// Allowlisted roots a governed command may run inside. Conservative by default:
/// the app-config dir + the user's home. Widening this is a deliberate change.
fn command_allowlist(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = vec![];
    if let Ok(dir) = app.path().app_config_dir() {
        roots.push(dir);
    }
    if let Ok(home) = app.path().home_dir() {
        roots.push(home);
    }
    roots
}

// ── MCP client — stdio JSON-RPC 2.0, spawned + framed HERE in the host ─────────
//
// A webview cannot spawn a child process; only the host can. So the desktop's
// MCP client lives here: it registers servers (mcp.json, 0600), and runs the
// line-delimited JSON-RPC 2.0 stdio session (initialize handshake →
// notifications/initialized → tools/list | tools/call) with partial-line
// buffering and a timeout→kill (no zombie). stderr is DRAINED AND DISCARDED —
// it is opaque debug output, NEVER parsed as JSON-RPC (only stdout carries the
// protocol). This mirrors the CLI's forge/mcp.ts and the desktop's src/mcp.ts
// dev/test analogue.
//
// THE MOAT APPLIES TO MCP TOO: `mcp_call_tool` is a side effect, so it spends a
// one-time `mcp.tool` governance token (bound to {server, tool}) BEFORE it will
// spawn the server — exactly like `governed_command`. `mcp_list_tools` is
// read-only discovery and is not gated.

const MCP_PROTOCOL_VERSION: &str = "2024-11-05";
const MCP_TIMEOUT_MS: u64 = 10_000;

/// A registered MCP server: launch command + discrete argument ARRAY (never a
/// joined string — so there is no shell and no injection seam at spawn time).
#[derive(Serialize, Deserialize, Clone)]
struct McpServerDef {
    command: String,
    #[serde(default)]
    args: Vec<String>,
}

/// One row for the webview's server list (camelCase → JS reads it directly).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McpServerEntry {
    name: String,
    command: String,
    args: Vec<String>,
}

fn mcp_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("mcp.json"))
}

fn read_mcp(app: &AppHandle) -> Result<BTreeMap<String, McpServerDef>, String> {
    let path = mcp_path(app)?;
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(_) => Ok(BTreeMap::new()), // no file yet ⇒ empty registry
    }
}

fn write_mcp(app: &AppHandle, map: &BTreeMap<String, McpServerDef>) -> Result<(), String> {
    let path = mcp_path(app)?;
    let data = serde_json::to_vec_pretty(map).map_err(|e| e.to_string())?;
    write_private(&path, &data)
}

#[tauri::command]
fn mcp_list_servers(app: AppHandle) -> Result<Vec<McpServerEntry>, String> {
    let map = read_mcp(&app)?;
    Ok(map
        .into_iter()
        .map(|(name, d)| McpServerEntry { name, command: d.command, args: d.args })
        .collect())
}

#[tauri::command]
fn mcp_add_server(app: AppHandle, name: String, command: String, args: Option<Vec<String>>) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("name is required".into());
    }
    if command.trim().is_empty() {
        return Err("command is required".into());
    }
    let mut map = read_mcp(&app)?;
    map.insert(name, McpServerDef { command: command.trim().to_string(), args: args.unwrap_or_default() });
    write_mcp(&app, &map)
}

#[tauri::command]
fn mcp_remove_server(app: AppHandle, name: String) -> Result<(), String> {
    let mut map = read_mcp(&app)?;
    map.remove(name.trim());
    write_mcp(&app, &map)
}

/// Accumulates raw stdout BYTES and yields complete '\n'-terminated lines,
/// retaining any trailing PARTIAL line across chunks. Buffering bytes (not a
/// per-chunk String) is load-bearing: a multibyte UTF-8 scalar split across two
/// read() boundaries must NOT be lossy-decoded twice into U+FFFD — each line is
/// decoded exactly once, only after all of its bytes have arrived. Pure —
/// unit-tested without a process.
#[derive(Default)]
struct LineBuffer {
    buf: Vec<u8>,
}
impl LineBuffer {
    fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut out = vec![];
        while let Some(idx) = self.buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = self.buf.drain(..=idx).collect();
            // idx bytes precede the '\n'; decode the complete line as UTF-8.
            let line = String::from_utf8_lossy(&line_bytes[..idx]).trim().to_string();
            if !line.is_empty() {
                out.push(line);
            }
        }
        out
    }
}

/// Match one JSON-RPC line against an expected request id. Returns None when the
/// line is not a response to `id` (a notification, a different id, or non-JSON) —
/// the caller keeps reading. Some(Ok/Err) is the matched success/error result.
fn parse_rpc_response(line: &str, id: u64) -> Option<Result<serde_json::Value, String>> {
    let msg: serde_json::Value = serde_json::from_str(line).ok()?;
    let msg_id = msg.get("id")?.as_u64()?; // notifications have no id → None
    if msg_id != id {
        return None;
    }
    if let Some(err) = msg.get("error") {
        let m = err.get("message").and_then(|v| v.as_str()).unwrap_or("JSON-RPC error");
        return Some(Err(m.to_string()));
    }
    Some(Ok(msg.get("result").cloned().unwrap_or(serde_json::Value::Null)))
}

fn send_line(stdin: &mut impl std::io::Write, msg: &serde_json::Value) -> Result<(), String> {
    let line = format!("{}\n", serde_json::to_string(msg).map_err(|e| e.to_string())?);
    stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

/// Block until a response for `id` arrives on `rx` or the deadline passes.
/// Notifications / other-id lines are skipped (kept reading), never mis-matched.
fn await_response(
    rx: &std::sync::mpsc::Receiver<String>,
    id: u64,
    deadline: std::time::Instant,
) -> Result<serde_json::Value, String> {
    use std::sync::mpsc::RecvTimeoutError;
    loop {
        let now = std::time::Instant::now();
        if now >= deadline {
            return Err(format!("MCP request timed out (id {id})"));
        }
        match rx.recv_timeout(deadline - now) {
            Ok(line) => {
                if let Some(res) = parse_rpc_response(&line, id) {
                    return res;
                }
                // not our id / a notification — keep reading until deadline
            }
            Err(RecvTimeoutError::Timeout) => return Err(format!("MCP request timed out (id {id})")),
            Err(RecvTimeoutError::Disconnected) => return Err("MCP server closed the stream".into()),
        }
    }
}

/// Spawn the server, run initialize → notifications/initialized → `method`, and
/// return the method's result. ALWAYS kills + reaps the child before returning
/// (timeout or not) — a wedged server never becomes a zombie. stderr is drained
/// on a thread and discarded; only stdout is parsed as JSON-RPC.
fn run_mcp_session(
    def: &McpServerDef,
    method: &str,
    params: serde_json::Value,
    timeout_ms: u64,
) -> Result<serde_json::Value, String> {
    use std::io::{BufReader, Read};
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let mut child = Command::new(&def.command)
        .args(&def.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn MCP server: {e}"))?;

    let mut stdin = child.stdin.take().ok_or("no stdin on MCP child")?;
    let stdout = child.stdout.take().ok_or("no stdout on MCP child")?;
    let stderr = child.stderr.take().ok_or("no stderr on MCP child")?;

    // stderr is OPAQUE — drain and DISCARD it, never parse it as JSON-RPC.
    let stderr_handle = std::thread::spawn(move || {
        let mut r = BufReader::new(stderr);
        let mut sink = Vec::new();
        let _ = r.read_to_end(&mut sink);
    });

    // Reader thread: byte chunks → LineBuffer → complete lines over a channel.
    let (tx, rx) = mpsc::channel::<String>();
    let reader_handle = std::thread::spawn(move || {
        let mut r = BufReader::new(stdout);
        let mut lb = LineBuffer::default();
        let mut buf = [0u8; 4096];
        loop {
            match r.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    for line in lb.push(&buf[..n]) {
                        if tx.send(line).is_err() {
                            return;
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });

    let outcome = (|| -> Result<serde_json::Value, String> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        // 1. initialize (id 1)
        send_line(
            &mut stdin,
            &serde_json::json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": { "protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {},
                            "clientInfo": { "name": "forge", "version": "0.1.0" } }
            }),
        )?;
        await_response(&rx, 1, deadline)?;
        // 2. notifications/initialized (NOTIFICATION — no id)
        send_line(&mut stdin, &serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))?;
        // 3. the method (id 2)
        send_line(
            &mut stdin,
            &serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": method, "params": params }),
        )?;
        await_response(&rx, 2, deadline)
    })();

    // Teardown — ALWAYS. Kill first so the reader thread's stdout closes.
    let _ = child.kill();
    let _ = child.wait();
    drop(rx);
    let _ = reader_handle.join();
    let _ = stderr_handle.join();
    outcome
}

/// Discovery — spawn, handshake, tools/list. Read-only; NOT gated. Returns the
/// tools array (or [] if the server reports none).
#[tauri::command]
fn mcp_list_tools(app: AppHandle, server: String) -> Result<serde_json::Value, String> {
    let map = read_mcp(&app)?;
    let def = map
        .get(server.trim())
        .ok_or_else(|| format!("no MCP server named \"{}\"", server.trim()))?;
    let result = run_mcp_session(def, "tools/list", serde_json::json!({}), MCP_TIMEOUT_MS)?;
    Ok(result.get("tools").cloned().unwrap_or(serde_json::json!([])))
}

/// One tool-call result crossing back to the webview (camelCase → `isError`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McpCallResult {
    content: serde_json::Value,
    is_error: bool,
}

/// THE GATED MCP CALL. Spends a one-time `mcp.tool` token (bound to {server,
/// tool}) BEFORE spawning the server — a webview cannot forge a host token, so a
/// tools/call can never run without passing the governance gate. Mirrors
/// `governed_command`'s consume-then-run choke-point shape.
#[tauri::command]
fn mcp_call_tool(
    app: AppHandle,
    gov: State<'_, Governance>,
    token: String,
    server: String,
    tool: String,
    args: Option<serde_json::Value>,
    ts: Option<u64>,
) -> Result<McpCallResult, String> {
    let ts = ts.unwrap_or(0);
    // 1. Spend the token. Binding is {tool, server} for kind mcp.tool.
    let detail = ActionDetail {
        tool: Some(tool.clone()),
        server: Some(server.clone()),
        ..Default::default()
    };
    {
        let mut gate = gov.0.lock().map_err(|_| "gate poisoned")?;
        let ok = matches!(
            gate.tokens.get(&token).cloned(),
            Some(rec) if rec.kind == "mcp.tool" && rec.binding == detail.binding("mcp.tool")
        );
        if !ok {
            audit_append(&app, &mut gate, "mcp.tool", "-", "replay-rejected", "mcp.tool", ts);
            return Err("invalid or already-spent token".into());
        }
        gate.tokens.remove(&token); // one-time
        let summary = format!("mcp {} · {}", server.trim(), tool.trim());
        audit_append(&app, &mut gate, "mcp.tool", "-", "consumed", &summary, ts);
    }

    // 2. Resolve the server + run the tools/call session.
    let map = read_mcp(&app)?;
    let def = match map.get(server.trim()) {
        Some(d) => d.clone(),
        None => {
            let mut gate = gov.0.lock().map_err(|_| "gate poisoned")?;
            audit_append(&app, &mut gate, "mcp.tool", "-", "error", "mcp.tool", ts);
            return Err(format!("no MCP server named \"{}\"", server.trim()));
        }
    };
    let params = serde_json::json!({ "name": tool, "arguments": args.unwrap_or(serde_json::json!({})) });
    let run = run_mcp_session(&def, "tools/call", params, MCP_TIMEOUT_MS);

    let mut gate = gov.0.lock().map_err(|_| "gate poisoned")?;
    match run {
        Ok(result) => {
            let is_error = result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);
            let content = result.get("content").cloned().unwrap_or(serde_json::json!([]));
            let outcome = if is_error { "error" } else { "success" };
            audit_append(&app, &mut gate, "mcp.tool", "-", outcome, "mcp.tool", ts);
            Ok(McpCallResult { content, is_error })
        }
        Err(e) => {
            audit_append(&app, &mut gate, "mcp.tool", "-", "error", "mcp.tool", ts);
            Err(e)
        }
    }
}

#[cfg(test)]
mod mcp_tests {
    use super::*;

    #[test]
    fn linebuffer_retains_partial_line_across_chunks() {
        let mut lb = LineBuffer::default();
        // First chunk: one full line + the start of a second.
        let out = lb.push(b"{\"a\":1}\n{\"b\"");
        assert_eq!(out, vec!["{\"a\":1}".to_string()]);
        // Second chunk completes the partial line.
        let out2 = lb.push(b":2}\n");
        assert_eq!(out2, vec!["{\"b\":2}".to_string()]);
    }

    #[test]
    fn linebuffer_reassembles_multibyte_scalar_split_across_reads() {
        // "é" is 0xC3 0xA9 in UTF-8. Split it across two read() boundaries — the
        // byte buffer must reassemble it, never lossy-decode each half into U+FFFD.
        let mut lb = LineBuffer::default();
        let s = "café";
        let bytes = s.as_bytes();
        let out = lb.push(&bytes[..bytes.len() - 1]); // first byte of 'é' only
        assert!(out.is_empty()); // no newline yet, and no corruption
        let out2 = lb.push(&[bytes[bytes.len() - 1], b'\n']); // second byte + newline
        assert_eq!(out2, vec!["café".to_string()]);
    }

    #[test]
    fn linebuffer_splits_multiple_lines_in_one_chunk_and_skips_blanks() {
        let mut lb = LineBuffer::default();
        let out = lb.push(b"one\n\ntwo\n");
        assert_eq!(out, vec!["one".to_string(), "two".to_string()]);
    }

    #[test]
    fn parse_rpc_response_matches_id_and_reads_result() {
        let line = "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[]}}";
        let r = parse_rpc_response(line, 2).expect("should match id 2");
        assert!(r.is_ok());
        assert!(r.unwrap().get("tools").is_some());
    }

    #[test]
    fn parse_rpc_response_ignores_other_ids_and_notifications() {
        let other = "{\"jsonrpc\":\"2.0\",\"id\":9,\"result\":{}}";
        assert!(parse_rpc_response(other, 2).is_none());
        let notif = "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\",\"params\":{}}";
        assert!(parse_rpc_response(notif, 2).is_none());
        let junk = "not json at all }{";
        assert!(parse_rpc_response(junk, 2).is_none());
    }

    #[test]
    fn parse_rpc_response_surfaces_an_error_object() {
        let line = "{\"jsonrpc\":\"2.0\",\"id\":2,\"error\":{\"code\":-32601,\"message\":\"no such tool\"}}";
        let r = parse_rpc_response(line, 2).expect("matches id 2");
        assert_eq!(r.unwrap_err(), "no such tool");
    }

    #[test]
    fn mcp_tool_token_binding_differs_by_tool_and_server() {
        let a = ActionDetail { tool: Some("read".into()), server: Some("fs".into()), ..Default::default() };
        let b = ActionDetail { tool: Some("write".into()), server: Some("fs".into()), ..Default::default() };
        let c = ActionDetail { tool: Some("read".into()), server: Some("git".into()), ..Default::default() };
        assert_ne!(a.binding("mcp.tool"), b.binding("mcp.tool"));
        assert_ne!(a.binding("mcp.tool"), c.binding("mcp.tool"));
        assert_eq!(a.binding("mcp.tool"), a.binding("mcp.tool"));
    }

    #[test]
    fn mcp_tool_classifies_as_require_approval() {
        assert_eq!(classify("mcp.tool", &[], None).0, "require-approval");
    }
}

#[cfg(test)]
mod secret_store_tests {
    use super::*;
    use std::collections::BTreeMap as Map;
    use std::sync::Mutex as StdMutex;

    /// In-memory backend that records every operation, so tests exercise the
    /// vault logic (migration, index, set/delete semantics) without touching a
    /// real OS keychain. Backed by a `Mutex` so it is naturally `Send + Sync`
    /// (no `unsafe`). `secure` is configurable to test both the honest
    /// keychain-on and file-fallback answers.
    struct MockBackend {
        store: StdMutex<Map<String, String>>,
        secure: bool,
    }
    impl MockBackend {
        fn new(secure: bool) -> Self {
            Self { store: StdMutex::new(Map::new()), secure }
        }
        fn snapshot(&self) -> Map<String, String> {
            self.store.lock().unwrap().clone()
        }
    }
    impl SecretBackend for MockBackend {
        fn set(&self, account: &str, secret: &str) -> Result<(), String> {
            self.store.lock().unwrap().insert(account.to_string(), secret.to_string());
            Ok(())
        }
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self.store.lock().unwrap().get(account).cloned())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.store.lock().unwrap().remove(account);
            Ok(())
        }
        fn secure(&self) -> bool {
            self.secure
        }
    }

    fn tmpdir() -> PathBuf {
        let mut p = std::env::temp_dir();
        // Unique-ish per test via nanos; tests don't run the same instant twice
        // for the same name and each cleans its own files.
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        p.push(format!("forge-s010-{n}"));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn mask_key_reveals_only_first4_last4() {
        assert_eq!(mask_key("sk-ant-1234567890ABCD"), "sk-a…ABCD");
        assert_eq!(mask_key("short"), "…");
        assert_eq!(mask_key("  sk-ant-1234567890ABCD  "), "sk-a…ABCD"); // trims
    }

    #[test]
    fn file_backend_roundtrip_and_delete_removes_empty_file() {
        let dir = tmpdir();
        let be = FileBackend { path: dir.join("vault.json") };
        assert_eq!(be.get("auth.token").unwrap(), None);
        be.set("auth.token", "tok-abc").unwrap();
        assert_eq!(be.get("auth.token").unwrap(), Some("tok-abc".into()));
        assert!(be.secure() == false);
        be.delete("auth.token").unwrap();
        assert_eq!(be.get("auth.token").unwrap(), None);
        // Last account removed ⇒ the file is deleted, not left as `{}`.
        assert!(!dir.join("vault.json").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn file_backend_writes_owner_only_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmpdir();
        let be = FileBackend { path: dir.join("vault.json") };
        be.set("byok.fal", "secret-value").unwrap();
        let mode = fs::metadata(dir.join("vault.json")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn key_index_stores_masked_never_the_secret() {
        let dir = tmpdir();
        let be = MockBackend::new(true);
        // Simulate key_add's core: backend.set then index insert of the MASK.
        be.set(&byok_account("openai"), "sk-openai-verysecret-1234").unwrap();
        let mut index = read_index(&dir);
        index.insert("openai".into(), mask_key("sk-openai-verysecret-1234"));
        write_index(&dir, &index).unwrap();

        let raw = fs::read_to_string(index_file(&dir)).unwrap();
        assert!(!raw.contains("verysecret"), "index must never contain the raw secret");
        assert!(raw.contains("sk-o…1234"), "index holds the masked fingerprint");
        // And the raw secret IS retrievable from the backend for dispatch.
        assert_eq!(be.get(&byok_account("openai")).unwrap(), Some("sk-openai-verysecret-1234".into()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migration_moves_legacy_secrets_into_backend_and_deletes_files() {
        let dir = tmpdir();
        // Seed the pre-S-010 plaintext files.
        fs::write(
            dir.join("secrets.json"),
            serde_json::to_vec(&Secrets { token: Some("legacy-tok".into()), refresh_token: Some("legacy-ref".into()) }).unwrap(),
        ).unwrap();
        let mut legacy_keys = BTreeMap::new();
        legacy_keys.insert("anthropic".to_string(), "sk-ant-legacy-secret-9999".to_string());
        fs::write(dir.join("keys.json"), serde_json::to_vec(&legacy_keys).unwrap()).unwrap();

        let be = MockBackend::new(true);
        migrate_legacy(&be, &dir).unwrap();

        // Secrets landed in the backend under the new account names.
        assert_eq!(be.get(ACCT_TOKEN).unwrap(), Some("legacy-tok".into()));
        assert_eq!(be.get(ACCT_REFRESH).unwrap(), Some("legacy-ref".into()));
        assert_eq!(be.get(&byok_account("anthropic")).unwrap(), Some("sk-ant-legacy-secret-9999".into()));
        // The BYOK provider is now in the masked index.
        assert_eq!(read_index(&dir).get("anthropic"), Some(&mask_key("sk-ant-legacy-secret-9999")));
        // Legacy plaintext files are GONE.
        assert!(!dir.join("secrets.json").exists());
        assert!(!dir.join("keys.json").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migration_is_idempotent_and_noop_without_legacy_files() {
        let dir = tmpdir();
        let be = MockBackend::new(true);
        migrate_legacy(&be, &dir).unwrap(); // nothing to do
        assert!(be.snapshot().is_empty());
        migrate_legacy(&be, &dir).unwrap(); // still fine on a second pass
        let _ = fs::remove_dir_all(&dir);
    }

    /// Backend that fails every write — models a keychain hiccup mid-migration.
    struct FailingBackend;
    impl SecretBackend for FailingBackend {
        fn set(&self, _a: &str, _s: &str) -> Result<(), String> {
            Err("keychain unavailable".into())
        }
        fn get(&self, _a: &str) -> Result<Option<String>, String> {
            Ok(None)
        }
        fn delete(&self, _a: &str) -> Result<(), String> {
            Ok(())
        }
        fn secure(&self) -> bool {
            true
        }
    }

    #[test]
    fn migration_keeps_legacy_file_when_backend_write_fails() {
        // Crash-safety: if the backend can't persist the secret, the legacy
        // plaintext file MUST survive so the secret isn't lost (retry next run).
        let dir = tmpdir();
        fs::write(
            dir.join("keys.json"),
            serde_json::to_vec(&{
                let mut m = BTreeMap::new();
                m.insert("openai".to_string(), "sk-openai-secret-12345".to_string());
                m
            }).unwrap(),
        ).unwrap();

        let err = migrate_legacy(&FailingBackend, &dir);
        assert!(err.is_err(), "a failed backend write must propagate, not swallow");
        // File intact — nothing lost.
        assert!(dir.join("keys.json").exists(), "legacy file must survive a failed migration");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migration_quarantines_a_corrupt_legacy_file_instead_of_deleting_it() {
        // A truncated write from an older crash produces unparseable JSON. It
        // must NOT be silently deleted (permanent secret loss) — it is renamed
        // aside, recoverable, and no longer re-triggers migration.
        let dir = tmpdir();
        fs::write(dir.join("keys.json"), b"{\"anthropic\":\"sk-ant-REAL-999").unwrap(); // truncated
        let be = MockBackend::new(true);
        migrate_legacy(&be, &dir).unwrap();

        assert!(!dir.join("keys.json").exists(), "corrupt file is moved aside");
        assert!(dir.join("keys.corrupt").exists(), "corrupt file is preserved, not lost");
        // Its bytes are intact for recovery.
        let recovered = fs::read_to_string(dir.join("keys.corrupt")).unwrap();
        assert!(recovered.contains("sk-ant-REAL-999"));
        // Backend stayed empty (nothing parseable to migrate).
        assert!(be.snapshot().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mask_key_hides_short_secrets_entirely() {
        // A short secret would leak most of its entropy through first4…last4,
        // so anything under 13 chars shows nothing.
        assert_eq!(mask_key("abcdefghi"), "…"); // 9 chars → fully hidden
        assert_eq!(mask_key("hunter1234567"), "hunt…4567"); // 13 chars → revealed
    }

    #[test]
    fn set_or_delete_mirrors_whole_struct_semantics() {
        let be = MockBackend::new(true);
        set_or_delete(&be, ACCT_TOKEN, Some("t1".into())).unwrap();
        assert_eq!(be.get(ACCT_TOKEN).unwrap(), Some("t1".into()));
        // Passing None for a field clears that account (logged out of it).
        set_or_delete(&be, ACCT_TOKEN, None).unwrap();
        assert_eq!(be.get(ACCT_TOKEN).unwrap(), None);
    }

    #[test]
    fn key_remove_clears_both_backend_and_index() {
        let dir = tmpdir();
        let be = MockBackend::new(true);
        be.set(&byok_account("groq"), "sk-groq-abcdefgh1234").unwrap();
        let mut index = read_index(&dir);
        index.insert("groq".into(), mask_key("sk-groq-abcdefgh1234"));
        write_index(&dir, &index).unwrap();

        // Simulate key_remove's core.
        be.delete(&byok_account("groq")).unwrap();
        let mut index = read_index(&dir);
        index.remove("groq");
        write_index(&dir, &index).unwrap();

        assert_eq!(be.get(&byok_account("groq")).unwrap(), None);
        assert!(read_index(&dir).get("groq").is_none());
        // Index empty ⇒ file removed.
        assert!(!index_file(&dir).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    /// Real OS-keychain round-trip. `#[ignore]` so the default `cargo test`
    /// never touches the developer's login keychain; run explicitly with
    /// `cargo test --ignored keychain_roundtrip` on macOS/Windows to verify.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    #[ignore]
    fn keychain_roundtrip() {
        let be = KeychainBackend;
        assert!(be.secure());
        let acct = "test.s010.roundtrip";
        be.set(acct, "keychain-secret-xyz").unwrap();
        assert_eq!(be.get(acct).unwrap(), Some("keychain-secret-xyz".into()));
        be.delete(acct).unwrap();
        assert_eq!(be.get(acct).unwrap(), None);
        // Deleting an absent credential is a no-op, not an error.
        be.delete(acct).unwrap();
    }
}

#[cfg(test)]
mod governance_tests {
    use super::*;

    #[test]
    fn fails_closed_on_unknown_kind() {
        let (d, r) = classify("totally.unknown", &[], None);
        assert_eq!(d, "require-approval");
        assert!(r.contains("unknown"));
    }

    #[test]
    fn auto_allows_only_the_explicit_set() {
        assert_eq!(classify("probe.detect", &[], None).0, "auto-allow");
        assert_eq!(classify("local.dispatch", &[], None).0, "auto-allow");
        assert_eq!(classify("direct.dispatch", &[], None).0, "require-approval");
        assert_eq!(classify("spawn.launch", &[], None).0, "require-approval");
        assert_eq!(classify("mcp.tool", &[], None).0, "require-approval");
    }

    #[test]
    fn hard_denies_destructive_and_traversal() {
        let argv = vec!["rm".to_string(), "-rf".to_string(), "/".to_string()];
        assert_eq!(classify("command.run", &argv, None).0, "deny");
        assert_eq!(classify("file.write", &[], Some("../../etc/passwd")).0, "deny");
        assert_eq!(classify("file.write", &[], Some("notes/x.md")).0, "require-approval");
    }

    #[test]
    fn destructive_and_traversal_helpers() {
        assert!(is_destructive("sudo rm -rf /var"));
        assert!(!is_destructive("ls -la"));
        assert!(is_traversal("a/../b"));
        assert!(!is_traversal("a/b/c"));
    }

    #[test]
    fn redact_scrubs_secrets_keeps_plain_text() {
        assert!(!redact("key sk-ant-ABCDEF0123456789ABCDEF").contains("sk-ant"));
        assert_eq!(redact("plain human summary"), "plain human summary");
        assert!(redact("tok abcdefghijklmnopqrstuvwxyz012345").contains("«redacted»"));
    }

    #[test]
    fn redact_scrubs_secrets_glued_to_punctuation() {
        // The audit log stores `argv.join(" ")`; secrets in command args are
        // routinely glued to `=` / `:` / no-space and MUST still be scrubbed
        // (a whitespace-word scan would leak every one of these).
        assert!(!redact("tool --api-key=sk-ant-ABCDEF0123456789ABCDEF").contains("sk-ant"));
        assert!(!redact("run --token=abcdefghijklmnopqrstuvwxyzABCDEF012").contains("abcdefghij"));
        // Dotted JWT after Bearer (the '.' would end a key-char run early).
        assert!(!redact("hdr Bearer eyJhbGci.eyJzdWIi.sigABCDEF012345").contains("eyJ"));
    }

    #[test]
    fn max_seq_in_log_reads_highest_persisted_seq() {
        let log = "{\"seq\":1,\"ts\":0,\"kind\":\"probe.detect\",\"decision\":\"auto-allow\",\"outcome\":\"granted\",\"summary\":\"x\"}\n\
                   {\"seq\":7,\"ts\":0,\"kind\":\"command.run\",\"decision\":\"-\",\"outcome\":\"consumed\",\"summary\":\"y\"}\n\
                   garbage-line\n";
        assert_eq!(max_seq_in_log(log), 7);
        assert_eq!(max_seq_in_log(""), 0);
    }

    #[test]
    fn workdir_allowlist_rejects_outside_and_missing() {
        let tmp = std::env::temp_dir();
        let allow = vec![tmp.clone()];
        assert!(workdir_allowed(&tmp, &allow));
        assert!(!workdir_allowed(&PathBuf::from("/definitely/not/a/real/dir/xyz"), &allow));
        // A sibling outside the allowlist root is refused.
        assert!(!workdir_allowed(&PathBuf::from("/"), &allow));
    }

    #[test]
    fn binding_differs_by_detail() {
        let a = ActionDetail { argv: Some(vec!["echo".into(), "a".into()]), ..Default::default() };
        let b = ActionDetail { argv: Some(vec!["echo".into(), "b".into()]), ..Default::default() };
        assert_ne!(a.binding("command.run"), b.binding("command.run"));
        assert_eq!(a.binding("command.run"), a.binding("command.run"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Governance(Mutex::new(GateState::default())))
        .invoke_handler(tauri::generate_handler![
            secure_store_get,
            secure_store_set,
            secure_store_clear,
            secret_backend_secure,
            key_add,
            key_list,
            key_remove,
            key_get,
            spawn_probe,
            request_action,
            approve_action,
            reject_action,
            consume_action,
            settle_action,
            audit_recent,
            governed_command,
            mcp_list_servers,
            mcp_add_server,
            mcp_remove_server,
            mcp_list_tools,
            mcp_call_tool
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Forge desktop application");
}
