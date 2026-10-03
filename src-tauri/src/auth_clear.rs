//! Auth-only deletion policy. The marker contains no credentials.
use std::{fs, io::ErrorKind, path::Path};
const MARKER: &str = "auth-signed-out";
const LEGACY_BLOCK: &str = "auth-legacy-disabled";
const FAILURE: &str = "Saved credentials could not be cleared. They may remain on this device.";

fn marker_exists(dir: &Path, name: &str) -> Result<bool, String> {
    match fs::metadata(dir.join(name)) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(_) => Err("Could not check saved sign-out state.".into()),
    }
}
pub fn is_signed_out(dir: &Path) -> Result<bool, String> {
    marker_exists(dir, MARKER)
}
pub fn may_migrate_auth(dir: &Path) -> Result<bool, String> {
    Ok(!marker_exists(dir, LEGACY_BLOCK)? && !is_signed_out(dir)?)
}
pub fn allow_rehydrate(dir: &Path) -> Result<(), String> {
    // A fresh login must never be overwritten by a retained legacy account.
    fs::write(dir.join(LEGACY_BLOCK), b"disabled\n").map_err(|_| "Could not save signed-in state.".to_string())?;
    match fs::remove_file(dir.join(MARKER)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Could not save signed-in state.".into()),
    }
}
pub fn clear_auth(dir: &Path, accounts: [&str; 2], mut delete: impl FnMut(&str) -> Result<(), String>) -> Result<(), String> {
    // Persist intent before touching the backend; retained credentials must not
    // silently restore a signed-out session after a failed deletion/restart.
    let mut failed = fs::write(dir.join(LEGACY_BLOCK), b"disabled\n").is_err();
    failed |= fs::write(dir.join(MARKER), b"signed-out\n").is_err();
    for account in accounts { if delete(account).is_err() { failed = true; } }
    if failed { Err(FAILURE.into()) } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        loop {
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("braavo-auth-clear-{}-{}-{id}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
            match fs::create_dir(&dir) {
                Ok(()) => return dir,
                Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
                Err(e) => panic!("could not create synthetic test directory: {e}"),
            }
        }
    }
    #[test]
    fn success_and_absent_are_idempotent_and_signed_out() {
        let dir = temp(); let mut entries = vec!["token", "refresh"];
        for _ in 0..2 {
            clear_auth(&dir, ["token", "refresh"], |a| { entries.retain(|v| *v != a); Ok(()) }).unwrap();
            assert!(entries.is_empty()); assert!(is_signed_out(&dir).unwrap());
            assert!(!may_migrate_auth(&dir).unwrap());
        }
        allow_rehydrate(&dir).unwrap(); assert!(!is_signed_out(&dir).unwrap());
        assert!(!may_migrate_auth(&dir).unwrap());
        allow_rehydrate(&dir).unwrap(); fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn either_backend_failure_is_honest_bounded_and_attempts_both() {
        for failing in ["token", "refresh"] {
            let dir = temp(); let mut calls = vec![];
            let error = clear_auth(&dir, ["token", "refresh"], |a| {
                calls.push(a.to_string()); if a == failing { Err("sensitive-backend-detail".into()) } else { Ok(()) }
            }).unwrap_err();
            assert_eq!(calls, ["token", "refresh"]); assert_eq!(error, FAILURE);
            // A retained credential cannot be rehydrated after restart.
            assert!(is_signed_out(&dir).unwrap()); fs::remove_dir_all(dir).unwrap();
        }
    }
    #[test]
    fn absent_marker_write_failure_still_attempts_both_deletions() {
        let parent = temp(); let dir = parent.join("missing-directory"); let mut calls = vec![];
        assert!(clear_auth(&dir, ["token", "refresh"], |a| {calls.push(a.to_string()); Ok(())}).is_err());
        assert_eq!(calls, ["token", "refresh"]); assert!(!is_signed_out(&dir).unwrap());
        fs::remove_dir_all(parent).unwrap();
    }
}
