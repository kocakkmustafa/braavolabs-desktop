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
            governed_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Forge desktop application");
}
