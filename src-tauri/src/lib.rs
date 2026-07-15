//! Forge Desktop — Rust host.
//!
//! Thin by design: window creation + OS-scoped secret commands (auth tokens +
//! BYOK provider keys). The frontend (packages/desktop/ui) owns every model
//! call — Lane-A local (Ollama) and BYOK direct dispatch happen in the webview;
//! NO AI/orchestration logic lives here (server = orchestration). The host only
//! persists secrets to disk with owner-only perms and hands them back on demand.
//!
//! ## Secret storage
//! `secure_store_{get,set,clear}` persist the bearer + refresh tokens to a
//! `secrets.json`, and `key_{add,list,remove,get}` persist BYOK provider keys
//! to a `keys.json` — both in the OS app-config dir, written with `0600` perms
//! on unix. This mirrors the CLI's `forge/keys.ts` (macOS Keychain + 0600
//! fallback) design in the desktop's Tauri context.
//!
//! `key_list` returns only MASKED fingerprints (first4…last4) — a raw key value
//! is never surfaced to the webview by `list`. `key_get` returns the raw secret
//! and is called ONLY at the moment of a BYOK direct dispatch (Lane-A), never to
//! populate UI. This is an INTERIM measure: it keeps keys off localStorage / out
//! of a world-readable file. The production target is the OS keychain (macOS
//! Keychain / Windows Credential Manager) via a keyring/stronghold plugin — a
//! documented HUMAN GATE in the README, deliberately not wired here to keep the
//! crate's dependency surface (and `cargo check` time) minimal.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

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

fn secrets_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("secrets.json"))
}

#[tauri::command]
fn secure_store_get(app: AppHandle) -> Result<Secrets, String> {
    let path = secrets_path(&app)?;
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        // No file yet ⇒ signed out; return empty rather than erroring.
        Err(_) => Ok(Secrets::default()),
    }
}

#[tauri::command]
fn secure_store_set(
    app: AppHandle,
    token: Option<String>,
    refresh_token: Option<String>,
) -> Result<(), String> {
    let path = secrets_path(&app)?;
    let secrets = Secrets { token, refresh_token };
    let data = serde_json::to_vec(&secrets).map_err(|e| e.to_string())?;
    write_private(&path, &data)
}

#[tauri::command]
fn secure_store_clear(app: AppHandle) -> Result<(), String> {
    let path = secrets_path(&app)?;
    // Missing file is fine — clearing an already-cleared store is idempotent.
    let _ = fs::remove_file(path);
    Ok(())
}

#[cfg(unix)]
fn write_private(path: &PathBuf, data: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600) // owner read/write only
        .open(path)
        .map_err(|e| e.to_string())?;
    f.write_all(data).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn write_private(path: &PathBuf, data: &[u8]) -> Result<(), String> {
    // Windows ACL hardening is a follow-up; app-config dir is already per-user.
    fs::write(path, data).map_err(|e| e.to_string())
}

// ── BYOK provider keys ───────────────────────────────────────────────────────
//
// Stored as a flat { provider: secret } map in `keys.json` (0600 on unix). The
// masked list is the only thing the webview sees for enumeration; the raw secret
// leaves the host solely via `key_get`, at direct-dispatch time.

/// One masked entry for the Settings → Keys list. `masked` is first4…last4 (or
/// "…" for short values) — never the raw secret.
#[derive(Serialize)]
struct KeyEntry {
    provider: String,
    masked: String,
}

/// Reveal nothing meaningful: first4…last4 for long keys, just "…" for short.
/// Char-based so multibyte keys never panic on a byte-boundary slice.
fn mask_key(secret: &str) -> String {
    let s = secret.trim();
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= 8 {
        return "…".to_string();
    }
    let first: String = chars[..4].iter().collect();
    let last: String = chars[chars.len() - 4..].iter().collect();
    format!("{first}…{last}")
}

fn keys_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("keys.json"))
}

fn read_keys(app: &AppHandle) -> Result<BTreeMap<String, String>, String> {
    let path = keys_path(app)?;
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        // No file yet ⇒ empty store rather than an error.
        Err(_) => Ok(BTreeMap::new()),
    }
}

fn write_keys(app: &AppHandle, map: &BTreeMap<String, String>) -> Result<(), String> {
    let path = keys_path(app)?;
    let data = serde_json::to_vec(map).map_err(|e| e.to_string())?;
    write_private(&path, &data)
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
    let mut map = read_keys(&app)?;
    map.insert(provider, secret);
    write_keys(&app, &map)
}

#[tauri::command]
fn key_list(app: AppHandle) -> Result<Vec<KeyEntry>, String> {
    let map = read_keys(&app)?;
    Ok(map
        .into_iter()
        .map(|(provider, secret)| KeyEntry {
            provider,
            masked: mask_key(&secret),
        })
        .collect())
}

#[tauri::command]
fn key_remove(app: AppHandle, provider: String) -> Result<(), String> {
    let mut map = read_keys(&app)?;
    map.remove(provider.trim());
    write_keys(&app, &map)
}

/// Raw secret for a single provider — call ONLY at direct-dispatch time.
/// Returns `None` when the provider has no stored key (webview renders an
/// honest "no key" error rather than dispatching).
#[tauri::command]
fn key_get(app: AppHandle, provider: String) -> Result<Option<String>, String> {
    let map = read_keys(&app)?;
    Ok(map.get(provider.trim()).cloned())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            secure_store_get,
            secure_store_set,
            secure_store_clear,
            key_add,
            key_list,
            key_remove,
            key_get,
            spawn_probe
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Forge desktop application");
}
