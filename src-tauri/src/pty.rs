//! Lane-B real-PTY HOST — the Rust half of the governed interactive vendor-CLI
//! session. `src/pty.ts` is the pure, unit-tested webview core (gate mapping +
//! the session registry the UI drives); THIS module is what actually allocates a
//! pseudo-terminal, spawns the vendor CLI inside the OS sandbox, and streams its
//! output back — the host-only duties a webview physically cannot do.
//!
//! The security shape mirrors `governed_command` (the command choke point):
//!   * A session opens ONLY on an approved, one-time governance token the host
//!     spends (`try_consume_token`) — a compromised webview that skips the gate
//!     hands over a token that fails to consume, so no PTY is ever allocated.
//!   * The AUTHORITATIVE running-session cap lives HERE (`admission_check` +
//!     `PtyHostState::register`), checked BEFORE the token is spent, so a cap-full
//!     host never burns an approval it can't honour — the TS `MAX_RUNNING_SESSIONS`
//!     pre-check is only a UI throttle.
//!   * Every child is wrapped in a least-privilege OS sandbox (`pty_policy` →
//!     `sandbox::wrap_command`), FAIL-CLOSED — a vendor CLI is never spawned bare.
//!   * The audit trail carries ONLY vendor + cwd + byte counts + how it ended;
//!     terminal buffers (which can hold a pasted key or a vendor login) never
//!     reach the ledger.
//!
//! The `#[tauri::command]` wiring (token spend, vendor resolution, cwd allowlist,
//! the background reader thread, audit) lives in `lib.rs` where the governance
//! state is owned; this module holds the reusable, headlessly-testable pieces:
//! the session registry/state machine, the vendor sandbox policy, the low-level
//! PTY open, and a dependency-free base64 for the output event.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

// `Child` and `MasterPty` are named as trait-object types below; the other
// portable_pty traits (PtySystem/SlavePty/ChildKiller) are reached through the
// boxed `dyn` objects, so they need no `use`.
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

use super::sandbox::{SandboxPolicy, SYSTEM_READ_ROOTS};

/// Host-authoritative fork-bomb guard: the most concurrent interactive sessions
/// the host will hold. Mirrors the TS `MAX_RUNNING_SESSIONS`, but THIS is the
/// enforcing copy (the TS one is a best-effort UI throttle).
pub const MAX_PTY_SESSIONS: usize = 4;

// ── session state machine ─────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PtyState {
    Running,
    Exited,
    Killed,
}

/// One live session's host-side handles + counters. Holds the OS process handles
/// the registry owns (the webview never sees them). Byte counters are the ONLY
/// quantitative audit signal a redacted session has — buffer content is never
/// stored here.
pub struct Session {
    child: Box<dyn Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    vendor: String,
    cwd: String,
    bytes_in: u64,
    bytes_out: u64,
    state: PtyState,
    exit_code: Option<i32>,
}

impl Session {
    /// Build a running session from a freshly-opened PTY child. The reader half
    /// is deliberately NOT stored — the caller moves it into the background
    /// reader thread (one owner) so nothing contends on the output stream.
    pub fn new(
        child: Box<dyn Child + Send + Sync>,
        master: Box<dyn MasterPty + Send>,
        writer: Box<dyn Write + Send>,
        vendor: String,
        cwd: String,
    ) -> Self {
        Session {
            child,
            master,
            writer,
            vendor,
            cwd,
            bytes_in: 0,
            bytes_out: 0,
            state: PtyState::Running,
            exit_code: None,
        }
    }

    /// The REDACTED audit line for this session's lifetime — the ONLY string that
    /// may reach the ledger: vendor + cwd + byte counts + how it ended. Mirror of
    /// TS `PtySessions.auditSummary`. Terminal buffer content never appears.
    fn audit_summary(&self) -> String {
        let ending = match self.state {
            PtyState::Running => "running".to_string(),
            PtyState::Killed => "killed by user".to_string(),
            PtyState::Exited => format!(
                "exited ({})",
                self.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "signal".to_string())
            ),
        };
        format!(
            "pty {} in {} — in {}B, out {}B, {}",
            self.vendor, self.cwd, self.bytes_in, self.bytes_out, ending
        )
    }
}

/// The host-owned session registry. Behind a Mutex; managed by Tauri and shared
/// with the background reader threads. It OWNS the OS process handles (unlike the
/// TS `PtySessions`, which owns only the state the webview needs).
#[derive(Default)]
pub struct PtyHostState(pub Mutex<HashMap<String, Session>>);

/// The pre-consume admission decision, split out so the "cap is enforced BEFORE
/// the token is spent" ordering is unit-testable without a live gate/AppHandle.
/// A poisoned-lock caller passes `usize::MAX` (fail-closed → refuse).
pub fn admission_check(running: usize) -> Result<(), String> {
    if running >= MAX_PTY_SESSIONS {
        return Err(format!("session cap reached ({MAX_PTY_SESSIONS})"));
    }
    Ok(())
}

impl PtyHostState {
    /// Count of sessions still running. On a poisoned lock returns `usize::MAX` so
    /// the cap check that consumes this fails closed (refuses a new session).
    pub fn running_count(&self) -> usize {
        match self.0.lock() {
            Ok(map) => map.values().filter(|s| s.state == PtyState::Running).count(),
            Err(_) => usize::MAX,
        }
    }

    /// Register a freshly-spawned session. Defensive cap re-check (the command
    /// already gated on `admission_check` before spending the token, but a
    /// concurrent spawn could have filled the last slot in between). On ANY
    /// rejection the just-spawned child is TORN DOWN here — dropping a
    /// `portable_pty` Child does NOT kill the process, so a lost cap race would
    /// otherwise leak a live vendor CLI.
    pub fn register(&self, id: String, mut session: Session) -> Result<(), String> {
        let mut map = self.0.lock().map_err(|_| "pty state poisoned".to_string())?;
        let running = map.values().filter(|s| s.state == PtyState::Running).count();
        if running >= MAX_PTY_SESSIONS {
            let _ = session.child.kill();
            let _ = session.child.wait();
            return Err(format!("session cap reached ({MAX_PTY_SESSIONS})"));
        }
        if map.contains_key(&id) {
            let _ = session.child.kill();
            let _ = session.child.wait();
            return Err("duplicate session id".into());
        }
        map.insert(id, session);
        Ok(())
    }

    /// Count OUTPUT bytes (host → terminal) for the redacted audit trail. Buffer
    /// content itself is never stored. Called from the reader thread per chunk.
    pub fn note_output(&self, id: &str, byte_len: usize) {
        if let Ok(mut map) = self.0.lock() {
            if let Some(s) = map.get_mut(id) {
                if s.state == PtyState::Running {
                    s.bytes_out += byte_len as u64;
                }
            }
        }
    }

    /// Write user keystrokes into a running session + count INPUT bytes. Content
    /// is never stored; a non-running session is an honest error.
    pub fn write_input(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let mut map = self.0.lock().map_err(|_| "pty state poisoned".to_string())?;
        let s = map.get_mut(id).ok_or_else(|| format!("no such PTY session: {id}"))?;
        if s.state != PtyState::Running {
            return Err("PTY session is not running".into());
        }
        s.writer.write_all(data).map_err(|e| e.to_string())?;
        let _ = s.writer.flush();
        s.bytes_in += data.len() as u64;
        Ok(())
    }

    /// Resize the PTY (terminal panel resized). No-op error if the session is gone.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let map = self.0.lock().map_err(|_| "pty state poisoned".to_string())?;
        let s = map.get(id).ok_or_else(|| format!("no such PTY session: {id}"))?;
        s.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())
    }

    /// Terminate a session (safe direction — stopping needs no approval). Kills +
    /// reaps the child and marks the session `Killed`; the record is KEPT (not
    /// removed) so its audit summary survives and the reader thread's later EOF
    /// leaves the terminal state alone.
    pub fn kill(&self, id: &str) -> Result<(), String> {
        let mut map = self.0.lock().map_err(|_| "pty state poisoned".to_string())?;
        let s = map.get_mut(id).ok_or_else(|| format!("no such PTY session: {id}"))?;
        let _ = s.child.kill();
        let _ = s.child.wait();
        s.state = PtyState::Killed;
        Ok(())
    }

    /// App-shutdown cleanup: kill + reap EVERY running session so no vendor child
    /// outlives the app. macOS `sandbox-exec` has no `--die-with-parent` (Linux
    /// bwrap does), so without this an orphaned CLI would keep its network + vendor
    /// state-dir access after the window closes. Called from the `run()` exit hook.
    pub fn kill_all(&self) {
        if let Ok(mut map) = self.0.lock() {
            for s in map.values_mut() {
                if s.state == PtyState::Running {
                    let _ = s.child.kill();
                    let _ = s.child.wait();
                    s.state = PtyState::Killed;
                }
            }
        }
    }

    /// The reader thread hit EOF: reap the child, transition Running→Exited (a
    /// session the user already killed stays Killed), and hand back the final code
    /// + the REDACTED audit summary + whether it was killed, so the caller can
    /// emit the exit event and append the settle line. Returns None if the session
    /// vanished.
    pub fn mark_exited(&self, id: &str) -> Option<(Option<i32>, String, bool)> {
        let mut map = self.0.lock().ok()?;
        let s = map.get_mut(id)?;
        let killed = s.state == PtyState::Killed;
        if s.state == PtyState::Running {
            // EOF on the master means every slave fd is closed → the child has
            // exited, so this wait() returns promptly (no lock-held stall).
            let code = s.child.wait().ok().map(|st| st.exit_code() as i32);
            s.state = PtyState::Exited;
            s.exit_code = code;
        }
        Some((s.exit_code, s.audit_summary(), killed))
    }
}

// ── args normalization (binding parity with ptySpawnToGate) ───────────────────

/// Fold an absent/empty arg list to `None`. `ptySpawnToGate` OMITS `args` from
/// the gated detail when empty (so a no-arg session's token binds with args=null);
/// the host must normalize identically before rebuilding the binding, else a
/// no-arg approval could never be spent (Some([]) ≠ None in the binding string).
pub fn normalize_pty_args(args: Option<Vec<String>>) -> Option<Vec<String>> {
    match args {
        Some(a) if !a.is_empty() => Some(a),
        _ => None,
    }
}

// ── vendor sandbox policy ─────────────────────────────────────────────────────

/// The vendor CLI's own state dir ($HOME/.claude, $HOME/.codex) — session
/// history, config, and the OAuth login the CLI reads for itself. Returned ONLY
/// when it already exists: granting write to a non-existent path would trip
/// `resolve_policy`'s fail-closed check, and an absent read root is dropped
/// anyway, so there is nothing to gain from creating it. Never a token file WE
/// read — the sandbox merely lets the CLI reach its OWN dir.
pub fn vendor_state_dir(vendor: &str, home: &Path) -> Option<PathBuf> {
    let sub = match vendor {
        "claude" => ".claude",
        "codex" => ".codex",
        _ => return None,
    };
    let dir = home.join(sub);
    if dir.is_dir() {
        Some(dir)
    } else {
        None
    }
}

/// The sandbox policy for an interactive vendor-CLI session. DELIBERATELY wider
/// than `default_policy` (write→cwd, network OFF) on three axes, each a conscious
/// trade the human approves at session-open:
///   * read  = SYSTEM_READ_ROOTS + cwd + vendor state dir (if present)
///   * write = cwd + vendor state dir (if present)  — the CLI persists its own
///     session history/config under $HOME/.claude|.codex, so it needs write there
///   * network = ON — a vendor CLI is an interactive agent that MUST reach its
///     provider API; a one-shot build step (default_policy) has no such need.
/// The vendor state dir is included only when present (see `vendor_state_dir`).
/// This stays FAITHFUL to the least-privilege spirit: still no $HOME, no /var,
/// no /tmp, no secrets dirs — `validate` (run on the resolved paths) rejects any.
///
/// KNOWN RESIDUAL RISK — temporal escape via the vendor state dir (P2-3, ACCEPTED
/// + DOCUMENTED, not yet mitigated): granting WRITE to $HOME/.claude|.codex lets a
/// compromised in-session step drop a hook/config/settings file that the vendor
/// CLI will later execute on the user's NEXT run — including in the user's own,
/// UNSANDBOXED terminal, OUTSIDE this moat. The write is time-bounded to the
/// session only in that we don't hold it open, but its EFFECT persists on disk.
/// Why accepted for now: the CLI genuinely needs to persist its own session
/// history/config there, and distinguishing "history" (safe) from "hook/settings"
/// (dangerous) is vendor-internal knowledge that changes across CLI versions —
/// a wrong split silently breaks the CLI. FOLLOW-UP (headed session): narrow write
/// to a per-vendor session-history SUBDIR (e.g. .claude/history) once the vendor's
/// on-disk layout is pinned, leaving config/hooks read-only. Until then the
/// human's session-open approval + the dangerous-flag hard-deny are the guards.
pub fn pty_policy(cwd: &Path, vendor_state_dir: Option<&Path>) -> SandboxPolicy {
    let mut read_roots: Vec<PathBuf> = SYSTEM_READ_ROOTS.iter().map(PathBuf::from).collect();
    read_roots.push(cwd.to_path_buf());
    let mut write_roots = vec![cwd.to_path_buf()];
    if let Some(vdir) = vendor_state_dir {
        read_roots.push(vdir.to_path_buf());
        write_roots.push(vdir.to_path_buf());
    }
    SandboxPolicy { read_roots, write_roots, allow_network: true }
}

// ── low-level PTY open ────────────────────────────────────────────────────────

/// The host-side handles a freshly-opened PTY child hands back. `master`/`writer`
/// stay with the session (resize + keystroke input); `reader` is moved to the
/// background thread that streams output.
pub struct PtyChild {
    pub child: Box<dyn Child + Send + Sync>,
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub reader: Box<dyn Read + Send>,
}

/// Open a PTY of `cols`×`rows`, spawn `wrapped_argv` (already sandbox-wrapped by
/// the caller — this function never runs a bare command) inside it with a
/// cleared, explicit `env`, and hand back the process + I/O handles. The slave is
/// dropped right after spawn so the master reads EOF when the child exits
/// (retaining a slave fd keeps the master readable forever — the classic
/// portable_pty gotcha).
pub fn open_pty_child(
    wrapped_argv: &[String],
    cwd: &Path,
    env: &[(String, String)],
    cols: u16,
    rows: u16,
) -> Result<PtyChild, String> {
    if wrapped_argv.is_empty() {
        return Err("empty PTY argv".into());
    }
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&wrapped_argv[0]);
    for a in &wrapped_argv[1..] {
        cmd.arg(a);
    }
    cmd.cwd(cwd);
    // Clear the inherited env FIRST so no host secret leaks into the child, then
    // set only the explicit, secret-free entries the caller built (HOME/PATH/TERM).
    cmd.env_clear();
    for (k, v) in env {
        cmd.env(k, v);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // Drop the slave so the master sees EOF on child exit (see fn docs).
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    Ok(PtyChild { child, master: pair.master, writer, reader })
}

// ── dependency-free base64 (output event payload) ─────────────────────────────

/// Standard base64 (RFC 4648) encoder. Terminal output is arbitrary bytes (not
/// guaranteed UTF-8), so the `pty://output` event carries it base64-encoded.
/// Hand-rolled to stay dependency-frugal (same spirit as the regex-free
/// `redact`), avoiding a transitive-crate dependency for ~15 lines.
pub fn base64_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { ALPHABET[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[(n & 63) as usize] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_tmpdir() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let c = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut p = std::env::temp_dir();
        p.push(format!("braavolabs-pty-{n}-{c}"));
        fs::create_dir_all(&p).unwrap();
        p
    }

    // ── cap admission: enforced BEFORE the token is spent ──

    #[test]
    fn admission_check_refuses_at_the_cap_only() {
        assert!(admission_check(0).is_ok());
        assert!(admission_check(MAX_PTY_SESSIONS - 1).is_ok());
        assert!(admission_check(MAX_PTY_SESSIONS).is_err());
        assert!(admission_check(MAX_PTY_SESSIONS + 1).is_err());
    }

    // ── args normalization: binding parity with the no-arg gate token ──

    #[test]
    fn normalize_pty_args_folds_absent_and_empty_to_none() {
        assert_eq!(normalize_pty_args(None), None);
        assert_eq!(normalize_pty_args(Some(vec![])), None);
        assert_eq!(
            normalize_pty_args(Some(vec!["--continue".into()])),
            Some(vec!["--continue".to_string()])
        );
    }

    // ── unknown vendor is rejected (host does not trust the webview) ──

    #[test]
    fn unknown_vendor_has_no_bin() {
        assert_eq!(super::super::vendor_bin("claude"), Some("claude"));
        assert_eq!(super::super::vendor_bin("codex"), Some("codex"));
        assert!(super::super::vendor_bin("bash").is_none());
        assert!(super::super::vendor_bin("bogus").is_none());
    }

    // ── a cwd outside the command allowlist is refused ──

    #[cfg(unix)]
    #[test]
    fn cwd_outside_allowlist_is_refused() {
        let base = unique_tmpdir();
        let allowed = base.join("allowed");
        let outside = base.join("outside");
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let allow = vec![allowed.clone()];
        assert!(super::super::workdir_allowed(&allowed, &allow));
        assert!(!super::super::workdir_allowed(&outside, &allow));
        let _ = fs::remove_dir_all(&base);
    }

    // ── vendor_state_dir: present → Some(realpath); absent/unknown → None ──

    #[test]
    fn vendor_state_dir_only_when_present() {
        let home = unique_tmpdir();
        let claude = home.join(".claude");
        fs::create_dir_all(&claude).unwrap();
        assert_eq!(vendor_state_dir("claude", &home), Some(claude));
        // .codex was never created → not granted.
        assert_eq!(vendor_state_dir("codex", &home), None);
        // An unknown vendor never yields a dir.
        assert_eq!(vendor_state_dir("bogus", &home), None);
        let _ = fs::remove_dir_all(&home);
    }

    // ── pty_policy: passes validate, network ON, includes the vendor dir ──

    #[cfg(unix)]
    #[test]
    fn pty_policy_validates_with_network_on_and_vendor_dir() {
        // Structural check — validate is string-based, so synthetic $HOME paths
        // (need not exist) suffice; the smoke test below exercises real resolution.
        let home = PathBuf::from(std::env::var("HOME").expect("HOME set on unix"));
        let cwd = home.join("braavo-proj-xyz");
        let vdir = home.join(".claude");
        let pol = pty_policy(&cwd, Some(&vdir));
        assert!(pol.allow_network, "a vendor CLI must reach its provider API");
        assert!(pol.read_roots.contains(&cwd), "cwd is readable");
        assert!(pol.read_roots.contains(&vdir), "the vendor state dir is readable");
        assert_eq!(pol.write_roots, vec![cwd.clone(), vdir.clone()], "write = cwd + vendor dir");
        // The vendor profile must be a SAFE policy the host will enforce.
        assert!(super::super::sandbox::validate(&pol).is_ok(), "pty_policy must validate");

        // Without a vendor dir: still valid, write = cwd only.
        let pol2 = pty_policy(&cwd, None);
        assert_eq!(pol2.write_roots, vec![cwd]);
        assert!(super::super::sandbox::validate(&pol2).is_ok());
    }

    // ── base64: known RFC 4648 vectors ──

    #[test]
    fn base64_encodes_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"hi"), "aGk=");
        // Round-trip through a byte with the high bit set (non-UTF-8 territory).
        assert_eq!(base64_encode(&[0xff, 0x00]), "/wA=");
    }

    // ── cap enforcement with REAL children (register tears down the overflow) ──

    #[cfg(unix)]
    #[test]
    fn register_enforces_cap_and_kills_the_overflow_child() {
        // `cat` with no input on its PTY blocks reading → stays running, giving us
        // cheap long-lived sessions to fill the cap. No sandbox wrap here: this
        // exercises the REGISTRY cap, not the sandbox (covered by the smoke test).
        let state = PtyHostState::default();
        let cwd = unique_tmpdir();
        let mut ids = vec![];
        for i in 0..MAX_PTY_SESSIONS {
            let bundle = open_pty_child(&["/bin/cat".to_string()], &cwd, &[], 24, 80)
                .expect("open cat pty");
            let PtyChild { child, master, writer, .. } = bundle;
            let sess = Session::new(child, master, writer, "claude".into(), cwd.to_string_lossy().into());
            let id = format!("s{i}");
            state.register(id.clone(), sess).expect("under cap");
            ids.push(id);
        }
        assert_eq!(state.running_count(), MAX_PTY_SESSIONS);
        // The (cap+1)th registration is refused — and its child is torn down.
        let overflow = open_pty_child(&["/bin/cat".to_string()], &cwd, &[], 24, 80).unwrap();
        let PtyChild { child, master, writer, .. } = overflow;
        let sess = Session::new(child, master, writer, "claude".into(), cwd.to_string_lossy().into());
        let err = state
            .register("overflow".into(), sess)
            .expect_err("cap is full → must reject");
        assert!(err.contains("session cap reached"), "{err}");
        // Cleanup: kill the registered children so no `cat` lingers.
        for id in ids {
            let _ = state.kill(&id);
        }
        let _ = fs::remove_dir_all(&cwd);
    }

    // ── shutdown cleanup: kill_all terminates every running session ──

    #[cfg(unix)]
    #[test]
    fn kill_all_terminates_running_sessions_on_shutdown() {
        let state = PtyHostState::default();
        let cwd = unique_tmpdir();
        let bundle = open_pty_child(&["/bin/cat".to_string()], &cwd, &[], 24, 80).unwrap();
        let pid = bundle.child.process_id().expect("cat has a pid");
        let PtyChild { child, master, writer, .. } = bundle;
        let sess = Session::new(child, master, writer, "claude".into(), cwd.to_string_lossy().into());
        state.register("s".into(), sess).unwrap();
        assert_eq!(state.running_count(), 1);

        // Simulate the app-shutdown hook.
        state.kill_all();
        assert_eq!(state.running_count(), 0, "no session may stay running after shutdown");

        // The OS process is actually gone — `kill -0 <pid>` fails (ESRCH) once the
        // child has been killed + reaped.
        let alive = std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(!alive, "the vendor child must be dead after kill_all");
        let _ = fs::remove_dir_all(&cwd);
    }

    // ── real-PTY smoke: /bin/echo runs in a PTY, output is read, exit captured ──

    #[cfg(unix)]
    fn read_to_end(reader: &mut Box<dyn Read + Send>) -> String {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                Err(_) => break,
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    }

    #[cfg(unix)]
    #[test]
    fn pty_smoke_echo_reads_output_and_captures_exit() {
        // Baseline (no sandbox): proves the PTY open / read / exit path on any unix.
        let cwd = unique_tmpdir();
        let mut bundle = open_pty_child(
            &["/bin/echo".to_string(), "pty-hi".to_string()],
            &cwd,
            &[],
            24,
            80,
        )
        .expect("open echo pty");
        let out = read_to_end(&mut bundle.reader);
        assert!(out.contains("pty-hi"), "PTY output must be readable: {out:?}");
        let status = bundle.child.wait().expect("reap echo");
        assert!(status.success(), "echo must exit 0");
        let _ = fs::remove_dir_all(&cwd);
    }

    // ── macOS: the SAME smoke through the real sandbox wrap ──

    #[cfg(target_os = "macos")]
    #[test]
    fn pty_smoke_echo_under_sandbox_wrap() {
        use super::super::sandbox;
        if !Path::new("/usr/bin/sandbox-exec").is_file() {
            return; // no launcher (unexpected on macOS) → skip rather than fail
        }
        // cwd MUST live under $HOME — a /var/folders temp dir is (correctly)
        // rejected as a write root by validate, so we build a home-anchored dir.
        let home = PathBuf::from(std::env::var("HOME").expect("HOME set on macOS"));
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let cwd = home.join(format!("braavo-pty-test-{n}-{}", std::process::id()));
        fs::create_dir_all(&cwd).unwrap();

        let resolved = sandbox::resolve_policy(&pty_policy(&cwd, None)).expect("cwd resolves");
        let wrapped = sandbox::wrap_command(
            &["/bin/echo".to_string(), "sandboxed-hi".to_string()],
            &resolved,
        )
        .expect("wrap");
        let env = vec![
            ("HOME".to_string(), home.to_string_lossy().into_owned()),
            ("PATH".to_string(), "/usr/bin:/bin".to_string()),
            ("TERM".to_string(), "xterm-256color".to_string()),
        ];
        let mut bundle = open_pty_child(&wrapped, &cwd, &env, 24, 80).expect("open sandboxed echo pty");
        let out = read_to_end(&mut bundle.reader);
        assert!(out.contains("sandboxed-hi"), "sandboxed PTY output must be readable: {out:?}");
        let status = bundle.child.wait().expect("reap sandboxed echo");
        assert!(status.success(), "sandboxed echo must exit 0 under the vendor profile");
        let _ = fs::remove_dir_all(&cwd);
    }
}
