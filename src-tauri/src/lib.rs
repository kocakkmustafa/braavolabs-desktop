//! Forge Desktop — Rust host.
//!
//! Thin by design: window creation + three OS-scoped secret commands. The
//! frontend (packages/desktop/ui) talks to the Forge SERVER for every model
//! call; NO AI/orchestration logic lives here (server = orchestration).
//!
//! ## Secret storage
//! `secure_store_{get,set,clear}` persist the bearer + refresh tokens to a
//! `secrets.json` in the OS app-config dir, written with `0600` perms on unix.
//! This is an INTERIM measure that keeps tokens off localStorage / out of the
//! webview: it is strictly better than a world-readable file, but the real
//! production target is the OS keychain (macOS Keychain / Windows Credential
//! Manager) via a keyring/stronghold plugin — a documented HUMAN GATE in the
//! README, deliberately not wired here to keep the crate's dependency surface
//! (and `cargo check` time) minimal.

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            secure_store_get,
            secure_store_set,
            secure_store_clear
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Forge desktop application");
}
