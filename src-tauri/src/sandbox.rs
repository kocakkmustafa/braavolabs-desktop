//! OS-sandbox — the HOST-side enforcement of the policy the webview's
//! `src/sandbox.ts` only models. governance.rs answers "may this run?"; this
//! module bounds "what can it touch if it does": every spawned command
//! (`governed_command`) is wrapped in an OS sandbox built from a least-privilege
//! POLICY, so even a human-APPROVED command cannot write outside its project
//! roots, read the user's secrets, or reach the network unless the policy grants
//! it. Defense in depth, not a replacement for the approval gate.
//!
//! This is the Rust MIRROR of `src/sandbox.ts` (the pure, unit-tested source of
//! truth) PLUS the two host-only duties that file explicitly delegates:
//!
//!   * `resolve_policy` (LOAD-BEARING, BR-003): the TS validator is string-only,
//!     so it cannot see that a write root spelled `~/project` is a SYMLINK whose
//!     real target is `~/.ssh`, nor that a macOS firmlink (`/etc`→`/private/etc`)
//!     aliases a denied tree. The host resolves every root to its real inode path
//!     with `std::fs::canonicalize` — following symlinks AND mount aliases —
//!     BEFORE validation runs, so validation checks the ACTUAL target. An
//!     unresolvable WRITE root fails closed (write authority is never granted to
//!     a path we can't pin down); an absent READ root is dropped, mirroring
//!     bubblewrap's `--ro-bind-try` and an unmatched seatbelt subpath (the
//!     default read set is a superset — `/lib`, `/opt` … don't exist on every OS
//!     — so failing closed on a missing one would wedge every command).
//!   * `wrap_command`: turns a policy into the real launcher prefix
//!     (`sandbox-exec -p <profile> --` on macOS, `bwrap <args> --` on Linux) and
//!     FAILS CLOSED when the sandbox binary is missing or the platform is
//!     unsupported (never spawns unsandboxed).
//!
//! The pure pieces (`validate`, `to_seatbelt_profile`, `to_bubblewrap_args`,
//! `describe_sandbox`) are byte-for-byte faithful to the TS so the two ends can't
//! silently diverge; the Rust unit tests below mirror `src/__tests__/sandbox.test.ts`.

use std::fs;
use std::path::{Path, PathBuf};

/// The capability model a spawned child is bounded by. Mirrors TS `SandboxPolicy`.
#[derive(Clone, Debug)]
pub struct SandboxPolicy {
    /// Absolute dirs the child may READ (subpaths included).
    pub read_roots: Vec<PathBuf>,
    /// Absolute dirs the child may WRITE (subpaths). Least privilege = cwd only.
    pub write_roots: Vec<PathBuf>,
    /// Outbound network. Default DENY — a sandboxed build/agent step shouldn't exfil.
    pub allow_network: bool,
}

/// Read-only system roots a typical CLI needs (shared libs, interpreters, TLS
/// roots, /dev/null+urandom). Trimmed vs the naive set: NO /private, /var, /tmp
/// (macOS /private/var/folders/<user> holds session tokens/cookies; /tmp is other
/// processes' scratch), NO $HOME. A policy needing a specific extra read adds it
/// explicitly — and `validate` still forbids naming a secrets dir. This is a
/// SUPERSET across OSes (e.g. macOS has no /lib); `resolve_policy` drops the
/// members that don't exist on this machine.
pub const SYSTEM_READ_ROOTS: &[&str] = &[
    "/usr", "/bin", "/sbin", "/lib", "/opt", "/etc", "/dev", "/System", "/Library",
];

/// The governed least-privilege default for a process spawned in `cwd`: a trimmed
/// system read set + cwd; write = cwd ONLY; network OFF.
pub fn default_policy(cwd: &Path) -> SandboxPolicy {
    let mut read_roots: Vec<PathBuf> = SYSTEM_READ_ROOTS.iter().map(PathBuf::from).collect();
    read_roots.push(cwd.to_path_buf());
    SandboxPolicy {
        read_roots,
        write_roots: vec![cwd.to_path_buf()],
        allow_network: false,
    }
}

// ── local mirrors of governance.ts's path helpers (sandbox.ts imports these) ──

/// Absolute path on either platform (`/…` posix, `C:\…`/`C:/…` windows).
fn is_absolute_path(path: &str) -> bool {
    let b = path.as_bytes();
    if b.first() == Some(&b'/') {
        return true;
    }
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\')
}

/// True when a path tries to escape its base via a `..` segment.
fn is_traversal(path: &str) -> bool {
    path.split(['/', '\\']).any(|seg| seg == "..")
}

/// Control char (NUL, newline, U+2028/2029, DEL) — never a real path, exactly what
/// a profile-injection attempt smuggles. Rejected at the validation boundary.
fn has_control_chars(s: &str) -> bool {
    s.chars()
        .any(|c| (c as u32) < 0x20 || c == '\u{7f}' || c == '\u{2028}' || c == '\u{2029}')
}

/// Fold a leading firmlink alias (`/private/etc`→`/etc`) — only at the start, and
/// only when the alias is a whole prefix (followed by `/` or end).
fn fold_prefix(s: &str, from: &str, to: &str) -> String {
    if s == from {
        return to.to_string();
    }
    if let Some(rest) = s.strip_prefix(from) {
        if rest.starts_with('/') {
            return format!("{to}{rest}");
        }
    }
    s.to_string()
}

/// Structural path canonicalization for policy CHECKS (not fs resolution — that is
/// `resolve_policy`'s job). Collapses `//`, strips a trailing `/`, and folds the
/// macOS firmlink aliases so a denylist can't be bypassed by spelling `/etc` as
/// `/private/etc` or `//etc`. Case-preserving; callers lowercase to compare.
/// Mirror of governance.ts `canonicalizePath`.
fn canonicalize_path(path: &str) -> String {
    let mut s = path.replace('\\', "/");
    while s.contains("//") {
        s = s.replace("//", "/");
    }
    if s.len() > 1 && s.ends_with('/') {
        s = s.trim_end_matches('/').to_string();
    }
    s = fold_prefix(&s, "/private/etc", "/etc");
    s = fold_prefix(&s, "/private/var", "/var");
    s = fold_prefix(&s, "/private/tmp", "/tmp");
    if s.is_empty() {
        "/".to_string()
    } else {
        s
    }
}

/// A segment that is NEVER a legitimate WRITE target at any depth (writing under
/// it = system tamper). Compared against the canonical, lowercased first segment.
const SYSTEM_WRITE_TREES: &[&str] = &[
    "usr", "bin", "sbin", "lib", "opt", "etc", "dev", "proc", "sys", "system", "library", "boot",
    "root", "var", "windows",
];
/// Home CONTAINERS: "/Users", "/home" (all users) and a bare "/Users/<name>" are
/// too broad to grant — the secret dirs live directly inside.
const HOME_CONTAINERS: &[&str] = &["users", "home"];

/// pty/write sensitive-dir set (governance.ts `isSensitiveDir`). Narrower than the
/// read-secret set below: e.g. `.config` alone is fine to WRITE (a project may put
/// scratch there) but `.config/gcloud` is not. `pub(crate)` so the pty.spawn gate
/// (lib.rs) reuses the SAME sensitive-cwd rule the sandbox write-root check uses —
/// one source of truth, no drift between the two enforcement points.
pub(crate) fn is_sensitive_dir(cwd: &str) -> bool {
    let p = canonicalize_path(cwd).to_lowercase();
    const EXACT: &[&str] = &[
        "/", "/etc", "/var", "/usr", "/bin", "/sbin", "/lib", "/boot", "/dev", "/proc", "/sys",
        "/root", "c:", "c:/windows", "c:/windows/system32",
    ];
    if EXACT.contains(&p.as_str()) {
        return true;
    }
    const PREFIX: &[&str] = &[
        "/etc/", "/root/", "/boot/", "/dev/", "/proc/", "/sys/", "/var/root/", "c:/windows/",
    ];
    let p_slash = format!("{p}/");
    if PREFIX.iter().any(|pre| p_slash.starts_with(pre)) {
        return true;
    }
    // SECRET_DIR_SEGMENT: /.(ssh|aws|gnupg|gpg|kube|docker|config/gcloud)(/|$)
    let segs: Vec<&str> = p.split('/').filter(|s| !s.is_empty()).collect();
    const SINGLES: &[&str] = &[".ssh", ".aws", ".gnupg", ".gpg", ".kube", ".docker"];
    if segs.iter().any(|s| SINGLES.contains(s)) {
        return true;
    }
    segs.windows(2).any(|w| w[0] == ".config" && w[1] == "gcloud")
}

/// A WRITE grant is safe only if it's a real project/scratch subtree, not a
/// system tree, a home root, or a bare top-level dir. Canonicalizes first so
/// /private/etc, //etc, and trailing-slash spellings can't slip past. Mirror of
/// TS `isSafeWriteRoot`.
fn is_safe_write_root(root: &str) -> bool {
    if !is_absolute_path(root) || is_traversal(root) || has_control_chars(root) {
        return false;
    }
    let canon = canonicalize_path(root);
    let lc = canon.to_lowercase();
    if is_sensitive_dir(&canon) {
        return false;
    }
    let mut segs: Vec<&str> = lc.split('/').filter(|s| !s.is_empty()).collect();
    // Drop a leading Windows drive letter ("c:") so the depth/home/system-tree
    // heuristics see the REAL segments (else "C:\Users\me" reads as depth-3).
    if segs.first().is_some_and(|s| is_drive_letter(s)) {
        segs.remove(0);
    }
    if segs.len() <= 1 {
        return false; // "/", "/Users", "/opt", "C:\", "C:\Users" — too broad
    }
    if SYSTEM_WRITE_TREES.contains(&segs[0]) {
        return false; // /usr/local/bin, /Library/LaunchAgents…
    }
    if segs.len() == 2 && HOME_CONTAINERS.contains(&segs[0]) {
        return false; // whole home "/Users/me"
    }
    true
}

/// A lowercased "c:"-style Windows drive-letter segment.
fn is_drive_letter(seg: &str) -> bool {
    let b = seg.as_bytes();
    b.len() == 2 && b[0].is_ascii_lowercase() && b[1] == b':'
}

/// A read root that is a whole home or all-homes container exposes every
/// dotfile-secret — too broad. Home-specific (system roots are depth-1 but
/// legitimate). Mirror of TS `isBroadHomeReadRoot`.
fn is_broad_home_read_root(root: &str) -> bool {
    let lc = canonicalize_path(root).to_lowercase();
    let mut segs: Vec<&str> = lc.split('/').filter(|s| !s.is_empty()).collect();
    if segs.first().is_some_and(|s| is_drive_letter(s)) {
        segs.remove(0);
    }
    !segs.is_empty() && segs.len() <= 2 && HOME_CONTAINERS.contains(&segs[0])
}

/// True when `anc` is a STRICT ancestor of `desc` (canonical, case-folded).
/// Mirror of TS `isStrictAncestor`.
fn is_strict_ancestor(anc: &str, desc: &str) -> bool {
    let a = canonicalize_path(anc).to_lowercase();
    let d = canonicalize_path(desc).to_lowercase();
    a != d && format!("{d}/").starts_with(&format!("{a}/"))
}

/// Secret stores a READ root must not name — a SUPERSET of the write/pty secret
/// set (a read grant + the always-writable cwd is an exfil path even with network
/// off). Manual, regex-free port of TS `SECRET_READ_SEGMENT`. Input is the
/// canonicalized path; matching is case-insensitive.
fn names_secret_read_segment(canon_path: &str) -> bool {
    let lc = canon_path.to_lowercase();
    let segs: Vec<&str> = lc.split('/').filter(|s| !s.is_empty()).collect();
    const DOTFILE_SECRETS: &[&str] = &[
        ".ssh", ".aws", ".gnupg", ".gpg", ".kube", ".docker", ".config", ".netrc",
        ".git-credentials", ".npmrc", ".password-store",
    ];
    if segs.iter().any(|s| DOTFILE_SECRETS.contains(s)) {
        return true;
    }
    // library/keychains
    if segs.windows(2).any(|w| w[0] == "library" && w[1] == "keychains") {
        return true;
    }
    // library/application support/<profile>/(cookies|login data)
    for i in 0..segs.len() {
        if segs[i] == "library"
            && i + 1 < segs.len()
            && segs[i + 1] == "application support"
            && i + 3 < segs.len()
            && (segs[i + 3] == "cookies" || segs[i + 3] == "login data")
        {
            return true;
        }
    }
    false
}

/// A policy the host will ENFORCE must itself be safe. Write roots go through the
/// allowlist-shaped `is_safe_write_root` (a denylist is bypassable by granting a
/// parent). Read roots must be absolute, clean, and not name a secrets dir. No
/// write root may be a strict ancestor of a read root. Mirror of TS
/// `validateSandboxPolicy`. Runs on the RESOLVED paths in the host flow, so it
/// catches the "symlinked write root really points at ~/.ssh" class the TS
/// string-check cannot see.
pub fn validate(p: &SandboxPolicy) -> Result<(), String> {
    for w in &p.write_roots {
        let ws = path_str(w);
        if !is_safe_write_root(&ws) {
            return Err(format!("unsafe write root (system/home/too-broad/dirty): {ws}"));
        }
    }
    for r in &p.read_roots {
        let rs = path_str(r);
        if !is_absolute_path(&rs) || is_traversal(&rs) || has_control_chars(&rs) {
            return Err(format!("read root not absolute/clean: {rs}"));
        }
        if names_secret_read_segment(&canonicalize_path(&rs)) {
            return Err(format!("read root names a secrets dir: {rs}"));
        }
        if is_broad_home_read_root(&rs) {
            return Err(format!("read root is a whole home / all-homes dir: {rs}"));
        }
    }
    for w in &p.write_roots {
        for r in &p.read_roots {
            if is_strict_ancestor(&path_str(w), &path_str(r)) {
                return Err(format!(
                    "write root {} is an ancestor of read root {}",
                    path_str(w),
                    path_str(r)
                ));
            }
        }
    }
    Ok(())
}

/// Render a policy path for a profile/bind. In the host flow the roots have
/// ALREADY been realpath-resolved by `resolve_policy`, so they are emitted
/// verbatim — deliberately NOT re-folded through `canonicalize_path`, because
/// folding a resolved `/private/etc` back to `/etc` would make a seatbelt subpath
/// stop matching the kernel's post-resolution access path.
fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

// ── macOS: sandbox-exec SBPL profile ─────────────────────────────────────────

/// Escape a path for an SBPL double-quoted string literal. Backslash first (so we
/// don't double-escape), then the quote — the complete terminator set for an SBPL
/// string. Control chars are already rejected in validation before generation.
#[cfg(any(target_os = "macos", test))]
fn sbpl_quote(path: &str) -> String {
    format!("\"{}\"", path.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Build the SBPL profile. VALIDATES first (a generator must never emit an unsafe
/// profile) — an unsafe policy is an error, never a silently-permissive profile.
/// Mirror of TS `toSeatbeltProfile`.
#[cfg(any(target_os = "macos", test))]
pub fn to_seatbelt_profile(p: &SandboxPolicy) -> Result<String, String> {
    validate(p)?;
    let read: Vec<String> = p.read_roots.iter().map(|r| path_str(r)).collect();
    let write: Vec<String> = p.write_roots.iter().map(|w| path_str(w)).collect();
    let mut lines = vec![
        "(version 1)".to_string(),
        "(deny default)".to_string(),
        "(allow process-fork)".to_string(),
        "(allow process-exec)".to_string(),
        "(allow sysctl-read)".to_string(),
        "(allow signal (target self))".to_string(),
        // Root-dir traversal: exec + dyld resolve every path THROUGH `/`, so
        // without read on the root NODE itself even `/usr/bin/true` SIGABRTs at
        // launch (empirically verified: file-read-metadata is NOT enough; the
        // dynamic linker needs file-read* on `/`). `literal` (not `subpath`)
        // grants ONLY the `/` node — the entry needed to walk into the allowed
        // subpaths — never its subtree, so nothing outside the read roots leaks.
        "(allow file-read* (literal \"/\"))".to_string(),
    ];
    if !read.is_empty() {
        let subs: Vec<String> = read.iter().map(|r| format!("(subpath {})", sbpl_quote(r))).collect();
        lines.push(format!("(allow file-read* {})", subs.join(" ")));
    }
    if !write.is_empty() {
        let subs: Vec<String> = write.iter().map(|w| format!("(subpath {})", sbpl_quote(w))).collect();
        lines.push(format!("(allow file-write* {})", subs.join(" ")));
    }
    // Network + socket creation are covered by (deny default); only opened on grant.
    if p.allow_network {
        lines.push("(allow network*)".to_string());
        lines.push("(allow system-socket)".to_string());
    }
    Ok(lines.join("\n") + "\n")
}

// ── Linux: bubblewrap argv ───────────────────────────────────────────────────

/// A minimal, secret-free env the child gets after --clearenv. HOME points at the
/// first write root (the project dir), never the real $HOME.
#[cfg(any(target_os = "linux", test))]
fn sandbox_env_args(p: &SandboxPolicy) -> Vec<String> {
    let home = p.write_roots.first().map(|w| path_str(w)).unwrap_or_else(|| "/tmp".to_string());
    vec![
        "--clearenv".to_string(),
        "--setenv".to_string(),
        "PATH".to_string(),
        "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin".to_string(),
        "--setenv".to_string(),
        "HOME".to_string(),
        home,
        "--setenv".to_string(),
        "TERM".to_string(),
        "xterm-256color".to_string(),
    ]
}

/// bwrap argv (array form → no shell, no injection). --unshare-pid (no sibling
/// /proc/<pid>/environ snoop), --unshare-ipc (no shm snoop), --unshare-net when
/// network is denied, --cap-drop ALL, minimal --dev/--proc, and --clearenv so
/// host secret env doesn't leak in. Read roots are ro-bound FIRST, then write
/// roots, so a rw project subdir overrides its ro parent. VALIDATES first. Mirror
/// of TS `toBubblewrapArgs`.
#[cfg(any(target_os = "linux", test))]
pub fn to_bubblewrap_args(p: &SandboxPolicy) -> Result<Vec<String>, String> {
    validate(p)?;
    let mut args: Vec<String> = [
        "--die-with-parent",
        "--new-session",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--cap-drop",
        "ALL",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.extend(sandbox_env_args(p));
    for r in &p.read_roots {
        let c = path_str(r);
        // Skip /dev: the minimal `--dev /dev` above already mounts a fresh, safe
        // devtmpfs (null/zero/full/random/urandom/tty). A `--ro-bind-try /dev /dev`
        // of the HOST /dev would REPLACE that minimal mount with the host's full
        // device tree, undoing the isolation. Deliberate divergence from the TS
        // generator: the TS is the reference MODEL, the Rust generator is the
        // ENFORCER and owns this host-only hardening.
        if canonicalize_path(&c) == "/dev" {
            continue;
        }
        args.push("--ro-bind-try".to_string());
        args.push(c.clone());
        args.push(c);
    }
    for w in &p.write_roots {
        let c = path_str(w);
        args.push("--bind-try".to_string());
        args.push(c.clone());
        args.push(c);
    }
    if !p.allow_network {
        args.push("--unshare-net".to_string());
    }
    Ok(args)
}

// ── honest summary ───────────────────────────────────────────────────────────

/// One-line human summary for the audit line / approval modal. Spells out write
/// roots + any read root OUTSIDE the standard system set (the exfil source a
/// reviewer needs to see) + network state. No secrets. Mirror of TS
/// `describeSandbox`.
pub fn describe_sandbox(p: &SandboxPolicy) -> String {
    let write = if p.write_roots.is_empty() {
        "(nothing)".to_string()
    } else {
        p.write_roots.iter().map(|w| path_str(w)).collect::<Vec<_>>().join(", ")
    };
    let sys: Vec<String> = SYSTEM_READ_ROOTS.iter().map(|r| canonicalize_path(r).to_lowercase()).collect();
    let extra: Vec<String> = p
        .read_roots
        .iter()
        .filter(|r| !sys.contains(&canonicalize_path(&path_str(r)).to_lowercase()))
        .map(|r| path_str(r))
        .collect();
    let reads = if extra.is_empty() {
        "system only".to_string()
    } else {
        format!("system + {}", extra.join(", "))
    };
    format!(
        "sandbox: write→{write}, read {reads}, network {}",
        if p.allow_network { "ON" } else { "OFF" }
    )
}

// ── host-only: realpath resolution (BR-003) + command wrapping ────────────────

/// Resolve a root that MUST exist (write roots, cwd): control-char reject → real
/// canonicalize (symlinks + firmlinks). Any failure is a hard error — write
/// authority is never granted to a path we can't pin to a real inode.
fn resolve_required(root: &Path) -> Result<PathBuf, String> {
    let raw = root.to_string_lossy();
    if has_control_chars(&raw) {
        return Err(format!("sandbox root has control characters: {raw}"));
    }
    let real = fs::canonicalize(root).map_err(|e| format!("cannot resolve sandbox root {raw}: {e}"))?;
    if has_control_chars(&real.to_string_lossy()) {
        return Err(format!("resolved sandbox root has control characters: {}", real.display()));
    }
    Ok(real)
}

/// Resolve a read root: a control char is still a hard error (an injection
/// attempt), but a path that simply does not resolve (missing/inaccessible) is
/// DROPPED (`Ok(None)`) rather than failing the policy — the default read set is
/// a superset and the generators tolerate absent reads (`--ro-bind-try` /
/// unmatched subpath). A symlink to an EXISTING secret still resolves to its real
/// target and is then caught by `validate`.
fn resolve_optional(root: &Path) -> Result<Option<PathBuf>, String> {
    let raw = root.to_string_lossy();
    if has_control_chars(&raw) {
        return Err(format!("sandbox root has control characters: {raw}"));
    }
    match fs::canonicalize(root) {
        Ok(real) => {
            if has_control_chars(&real.to_string_lossy()) {
                return Err(format!("resolved sandbox root has control characters: {}", real.display()));
            }
            Ok(Some(real))
        }
        Err(_) => Ok(None), // absent read root → simply not granted (not unsandboxed)
    }
}

/// BR-003 GATE. Realpath-resolve every root BEFORE validation/generation so the
/// checks see through symlinks and mount aliases to the real target. Write roots
/// (and cwd) fail closed if unresolvable; absent read roots are dropped. The
/// returned policy carries only real, canonical inode paths.
pub fn resolve_policy(p: &SandboxPolicy) -> Result<SandboxPolicy, String> {
    let write_roots = p
        .write_roots
        .iter()
        .map(|w| resolve_required(w))
        .collect::<Result<Vec<_>, _>>()?;
    let mut read_roots = Vec::with_capacity(p.read_roots.len());
    for r in &p.read_roots {
        if let Some(real) = resolve_optional(r)? {
            read_roots.push(real);
        }
    }
    Ok(SandboxPolicy {
        read_roots,
        write_roots,
        allow_network: p.allow_network,
    })
}

/// Wrap `argv` in the OS sandbox launcher for this platform: macOS
/// `[sandbox-exec, -p, <profile>, --, ...argv]`. Validates + builds the profile,
/// then requires the launcher to exist — FAIL CLOSED otherwise. The launcher
/// path is HARD-CODED to the SIP-protected `/usr/bin/sandbox-exec`, never
/// resolved via PATH: a PATH-first lookup would let a hijacked PATH shadow the
/// launcher with an attacker binary that "runs" the command with no sandbox.
#[cfg(target_os = "macos")]
pub fn wrap_command(argv: &[String], policy: &SandboxPolicy) -> Result<Vec<String>, String> {
    const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";
    let profile = to_seatbelt_profile(policy)?;
    if !Path::new(SANDBOX_EXEC).is_file() {
        return Err(format!("{SANDBOX_EXEC} not found — refusing to run unsandboxed"));
    }
    let mut out = Vec::with_capacity(argv.len() + 4);
    out.push(SANDBOX_EXEC.to_string());
    out.push("-p".to_string());
    out.push(profile);
    out.push("--".to_string());
    out.extend(argv.iter().cloned());
    Ok(out)
}

/// Linux `[bwrap, ...args, --, ...argv]`. Same fail-closed contract; the launcher
/// is looked up ONLY in fixed root-owned locations (`/usr/bin`, `/usr/local/bin`),
/// never via PATH, so a hijacked PATH can't substitute the sandbox launcher.
#[cfg(target_os = "linux")]
pub fn wrap_command(argv: &[String], policy: &SandboxPolicy) -> Result<Vec<String>, String> {
    let exe = ["/usr/bin/bwrap", "/usr/local/bin/bwrap"]
        .into_iter()
        .find(|p| Path::new(p).is_file())
        .ok_or_else(|| "bwrap not found in /usr/bin or /usr/local/bin — refusing to run unsandboxed".to_string())?;
    let bwrap_args = to_bubblewrap_args(policy)?;
    let mut out = Vec::with_capacity(bwrap_args.len() + argv.len() + 2);
    out.push(exe.to_string());
    out.extend(bwrap_args);
    out.push("--".to_string());
    out.extend(argv.iter().cloned());
    Ok(out)
}

/// Unsupported platform (Windows: AppContainer / Job Object wrapping is a
/// documented follow-up) — FAIL CLOSED so the host refuses to spawn unsandboxed.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub const SANDBOX_UNSUPPORTED: &str =
    "OS sandbox not implemented on this platform — host must fail-closed (refuse to spawn unsandboxed)";

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn wrap_command(_argv: &[String], _policy: &SandboxPolicy) -> Result<Vec<String>, String> {
    Err(SANDBOX_UNSUPPORTED.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CWD: &str = "/Users/me/project";

    /// A clean project policy (mirror of the TS test's `policy()` helper).
    fn policy() -> SandboxPolicy {
        SandboxPolicy {
            read_roots: vec![PathBuf::from("/usr"), PathBuf::from(CWD)],
            write_roots: vec![PathBuf::from(CWD)],
            allow_network: false,
        }
    }

    fn unique_tmpdir() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::{SystemTime, UNIX_EPOCH};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let c = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut p = std::env::temp_dir();
        p.push(format!("braavolabs-sandbox-{n}-{c}"));
        fs::create_dir_all(&p).unwrap();
        p
    }

    // ── default_policy — least privilege (mirror TS) ──

    #[test]
    fn default_policy_is_least_privilege() {
        let cwd = PathBuf::from(CWD);
        let p = default_policy(&cwd);
        assert_eq!(p.write_roots, vec![cwd.clone()]);
        assert!(!p.allow_network);
        assert!(p.read_roots.contains(&cwd));
        for sys in SYSTEM_READ_ROOTS {
            assert!(p.read_roots.iter().any(|r| r == Path::new(sys)), "reads {sys}");
        }
        for leaky in ["/private", "/var", "/tmp", "/Users/me", "/Users"] {
            assert!(!p.read_roots.iter().any(|r| r == Path::new(leaky)), "must not read {leaky}");
        }
        assert!(validate(&p).is_ok());
    }

    // ── is_safe_write_root — allowlist-shaped (mirror TS adversarial B) ──

    #[test]
    fn safe_write_root_accepts_real_project_subtrees() {
        for ok in ["/Users/me/project", "/home/x/proj", "/tmp/scratch/build", "/Users/me/a/b"] {
            assert!(is_safe_write_root(ok), "{ok}");
        }
    }

    #[test]
    fn safe_write_root_rejects_home_roots() {
        for bad in ["/Users", "/home", "/Users/me", "/home/x"] {
            assert!(!is_safe_write_root(bad), "{bad}");
        }
    }

    #[test]
    fn safe_write_root_rejects_windows_home_and_system() {
        for bad in ["C:/Users", "C:/Users/me", "C:\\Users\\me", "C:/Windows/System32"] {
            assert!(!is_safe_write_root(bad), "{bad}");
        }
        assert!(is_safe_write_root("C:/Users/me/project"));
    }

    #[test]
    fn safe_write_root_rejects_system_trees_at_any_depth() {
        for bad in ["/usr/local/bin", "/Library/LaunchAgents", "/etc/cron.d", "/opt", "/var/root"] {
            assert!(!is_safe_write_root(bad), "{bad}");
        }
    }

    #[test]
    fn safe_write_root_rejects_private_aliases_and_double_slash() {
        assert!(!is_safe_write_root("/private/etc"));
        assert!(!is_safe_write_root("//etc"));
        assert!(!is_safe_write_root("/private/var"));
    }

    #[test]
    fn safe_write_root_rejects_shallow_relative_traversal_control() {
        for bad in ["/", "/opt", "rel/dir", "/a/../b"] {
            assert!(!is_safe_write_root(bad), "{bad}");
        }
        assert!(!is_safe_write_root("/Users/me/pr\0oj"));
    }

    // ── validate (mirror TS) ──

    #[test]
    fn validate_accepts_clean_policy() {
        assert!(validate(&policy()).is_ok());
    }

    #[test]
    fn validate_rejects_unsafe_write_root_with_honest_reason() {
        let p = SandboxPolicy { write_roots: vec![PathBuf::from("/Users/me")], ..policy() };
        let err = validate(&p).unwrap_err();
        assert!(err.contains("unsafe write root"), "{err}");
    }

    #[test]
    fn validate_rejects_read_root_naming_a_secrets_dir() {
        for secret in [
            "/Users/me/.ssh",
            "/home/x/.aws",
            "/Users/me/.config",
            "/Users/me/.netrc",
            "/Users/me/.git-credentials",
            "/Users/me/.npmrc",
            "/Users/me/Library/Keychains",
            "/Users/me/Library/Application Support/Google/Cookies",
        ] {
            let p = SandboxPolicy {
                read_roots: vec![PathBuf::from("/usr"), PathBuf::from(secret)],
                ..policy()
            };
            assert!(validate(&p).is_err(), "{secret}");
        }
    }

    #[test]
    fn validate_rejects_whole_home_read_root() {
        for home in ["/Users", "/home", "/Users/me", "C:/Users/me"] {
            let p = SandboxPolicy {
                read_roots: vec![PathBuf::from("/usr"), PathBuf::from(home)],
                ..policy()
            };
            let err = validate(&p).unwrap_err();
            assert!(err.contains("whole home"), "{home}: {err}");
        }
        // A deeper home subdir (not the whole home, not under the write root) is fine.
        let ok = SandboxPolicy {
            read_roots: vec![PathBuf::from("/usr"), PathBuf::from("/Users/me/shared-docs")],
            ..policy()
        };
        assert!(validate(&ok).is_ok());
    }

    #[test]
    fn validate_rejects_nonabsolute_traversal_control_read_root() {
        for bad in ["usr", "/a/../etc", "/u\n(x)"] {
            let p = SandboxPolicy { read_roots: vec![PathBuf::from(bad)], ..policy() };
            assert!(validate(&p).is_err(), "{bad}");
        }
    }

    #[test]
    fn validate_rejects_write_root_that_is_ancestor_of_read_root() {
        let p = SandboxPolicy {
            write_roots: vec![PathBuf::from("/Users/me/proj")],
            read_roots: vec![PathBuf::from("/Users/me/proj/vendor")],
            allow_network: false,
        };
        let err = validate(&p).unwrap_err();
        assert!(err.contains("ancestor"), "{err}");
        // Equal write+read root (the default cwd case) is fine — not a STRICT ancestor.
        assert!(validate(&policy()).is_ok());
    }

    // ── seatbelt (macOS SBPL) — mirror TS ──

    #[test]
    fn seatbelt_denies_default_allows_subpaths_omits_network_when_off() {
        let prof = to_seatbelt_profile(&policy()).unwrap();
        assert!(prof.contains("(deny default)"));
        // Root-dir traversal grant (P2-1) — without it every spawned child SIGABRTs.
        assert!(prof.contains("(allow file-read* (literal \"/\"))"));
        assert!(prof.contains(&format!(
            "(allow file-read* (subpath \"/usr\") (subpath \"{CWD}\"))"
        )));
        assert!(prof.contains(&format!("(allow file-write* (subpath \"{CWD}\"))")));
        assert!(!prof.contains("(allow network*)"));
        assert!(!prof.contains("(allow system-socket)"));
    }

    #[test]
    fn seatbelt_grants_network_only_when_allowed() {
        let p = SandboxPolicy { allow_network: true, ..policy() };
        let prof = to_seatbelt_profile(&p).unwrap();
        assert!(prof.contains("(allow network*)"));
        assert!(prof.contains("(allow system-socket)"));
    }

    #[test]
    fn seatbelt_errors_rather_than_emit_unsafe_profile() {
        let p = SandboxPolicy { write_roots: vec![PathBuf::from("/etc")], ..policy() };
        assert!(to_seatbelt_profile(&p).is_err());
        let p2 = SandboxPolicy { write_roots: vec![PathBuf::from("/Users/me")], ..policy() };
        assert!(to_seatbelt_profile(&p2).is_err());
    }

    #[test]
    fn seatbelt_escapes_injection_path() {
        let evil = "/Users/me/pr\")(allow default)(\"";
        let p = SandboxPolicy {
            write_roots: vec![PathBuf::from(evil)],
            read_roots: vec![PathBuf::from("/usr")],
            allow_network: false,
        };
        let prof = to_seatbelt_profile(&p).unwrap();
        assert!(prof.contains("\\\""), "embedded quote must be escaped");
        assert!(!prof.contains("\n(allow default)"), "must NOT become a top-level directive");
        assert_eq!(sbpl_quote("a\"b\\c"), "\"a\\\"b\\\\c\"");
    }

    // ── bubblewrap (Linux) — mirror TS ──

    #[test]
    fn bubblewrap_unshares_clears_env_binds_reads_and_writes() {
        let args = to_bubblewrap_args(&policy()).unwrap();
        for flag in ["--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-net", "--clearenv"] {
            assert!(args.iter().any(|a| a == flag), "{flag}");
        }
        assert!(args.windows(2).any(|w| w == ["--cap-drop", "ALL"]));
        assert!(args.windows(3).any(|w| w == ["--setenv", "HOME", CWD]));
        assert!(args.windows(3).any(|w| w == ["--ro-bind-try", "/usr", "/usr"]));
        assert!(args.windows(3).any(|w| w == ["--bind-try", CWD, CWD]));
    }

    #[test]
    fn bubblewrap_omits_unshare_net_when_network_allowed() {
        let p = SandboxPolicy { allow_network: true, ..policy() };
        assert!(!to_bubblewrap_args(&p).unwrap().contains(&"--unshare-net".to_string()));
    }

    #[test]
    fn bubblewrap_errors_on_unsafe_policy() {
        let p = SandboxPolicy { write_roots: vec![PathBuf::from("/usr/local/bin")], ..policy() };
        assert!(to_bubblewrap_args(&p).is_err());
    }

    #[test]
    fn bubblewrap_skips_dev_read_root_to_preserve_minimal_dev() {
        let p = SandboxPolicy {
            read_roots: vec![PathBuf::from("/usr"), PathBuf::from("/dev")],
            write_roots: vec![PathBuf::from(CWD)],
            allow_network: false,
        };
        let args = to_bubblewrap_args(&p).unwrap();
        // The minimal --dev mount survives, but the host /dev is NOT ro-bound over it.
        assert!(args.windows(2).any(|w| w == ["--dev", "/dev"]));
        assert!(args.windows(3).any(|w| w == ["--ro-bind-try", "/usr", "/usr"]));
        assert!(
            !args.windows(3).any(|w| w == ["--ro-bind-try", "/dev", "/dev"]),
            "host /dev must not override the minimal --dev"
        );
    }

    #[test]
    fn bubblewrap_is_argv_form_never_shell_split() {
        let evil = "/Users/me/x; rm -rf ~";
        let p = SandboxPolicy {
            write_roots: vec![PathBuf::from(evil)],
            read_roots: vec![],
            allow_network: false,
        };
        let args = to_bubblewrap_args(&p).unwrap();
        // Appears verbatim as discrete argv elements (setenv HOME + the bind pair),
        // never word-split into `rm`,`-rf`,`~`.
        assert_eq!(args.iter().filter(|a| a.as_str() == evil).count(), 3);
        assert!(!args.contains(&"rm".to_string()));
    }

    // ── describe_sandbox — honest (mirror TS) ──

    #[test]
    fn describe_spells_out_writes_nonsystem_reads_and_network() {
        assert_eq!(
            describe_sandbox(&policy()),
            format!("sandbox: write→{CWD}, read system + {CWD}, network OFF")
        );
        let sys_only = SandboxPolicy {
            read_roots: SYSTEM_READ_ROOTS.iter().map(PathBuf::from).collect(),
            write_roots: vec![PathBuf::from(CWD)],
            allow_network: true,
        };
        assert_eq!(
            describe_sandbox(&sys_only),
            format!("sandbox: write→{CWD}, read system only, network ON")
        );
    }

    #[test]
    fn describe_does_not_hide_a_nonsystem_read_behind_a_count() {
        let p = SandboxPolicy {
            read_roots: vec![PathBuf::from("/usr"), PathBuf::from("/Users/me/secrets-cache")],
            write_roots: vec![PathBuf::from(CWD)],
            allow_network: false,
        };
        assert!(describe_sandbox(&p).contains("/Users/me/secrets-cache"));
    }

    // ── host-only: resolve_policy realpath (BR-003) ──

    #[cfg(unix)]
    #[test]
    fn resolve_policy_follows_symlink_so_validate_flags_the_secret_target() {
        use std::os::unix::fs::symlink;
        let base = unique_tmpdir();
        // A real directory whose name makes it a secrets dir.
        let secret = base.join("home").join(".ssh");
        fs::create_dir_all(&secret).unwrap();
        // An innocent-looking symlinked write root that actually points at it.
        let link = base.join("project-link");
        symlink(&secret, &link).unwrap();
        let proj = base.join("proj");
        fs::create_dir_all(&proj).unwrap();

        let p = SandboxPolicy {
            read_roots: vec![proj.clone()],
            write_roots: vec![link.clone()],
            allow_network: false,
        };
        let resolved = resolve_policy(&p).expect("roots exist → resolves");
        // The symlink was followed to its REAL target (BR-003) — the string-only
        // TS check could never have seen through it.
        assert_eq!(resolved.write_roots[0], fs::canonicalize(&secret).unwrap());
        // And validation on the RESOLVED path rejects the secret target.
        assert!(validate(&resolved).is_err(), "resolved secret write root must be rejected");
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_policy_fails_closed_on_unresolvable_write_root() {
        let base = unique_tmpdir();
        let p = SandboxPolicy {
            read_roots: vec![],
            write_roots: vec![base.join("does-not-exist")],
            allow_network: false,
        };
        assert!(resolve_policy(&p).is_err(), "an unresolvable write root must fail closed");
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_policy_drops_absent_read_root_keeps_present() {
        let base = unique_tmpdir();
        let present = base.join("present");
        fs::create_dir_all(&present).unwrap();
        let p = SandboxPolicy {
            read_roots: vec![present.clone(), base.join("absent")],
            write_roots: vec![present.clone()],
            allow_network: false,
        };
        let resolved = resolve_policy(&p).expect("present roots resolve");
        assert_eq!(resolved.read_roots, vec![fs::canonicalize(&present).unwrap()]);
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_policy_rejects_control_char_root() {
        let p = SandboxPolicy {
            read_roots: vec![],
            write_roots: vec![PathBuf::from("/tmp/pr\noj")],
            allow_network: false,
        };
        assert!(resolve_policy(&p).is_err());
    }

    // ── host-only: wrap_command ──

    #[cfg(target_os = "macos")]
    #[test]
    fn wrap_command_macos_wraps_argv_in_sandbox_exec() {
        let argv = vec!["echo".to_string(), "hi".to_string()];
        let wrapped = wrap_command(&argv, &policy()).expect("sandbox-exec present on macOS");
        assert!(wrapped[0].contains("sandbox-exec"), "first element is the sandbox-exec binary");
        assert!(wrapped.contains(&"-p".to_string()));
        assert!(wrapped.contains(&"--".to_string()));
        // The user's argv survives verbatim after the `--` separator.
        let sep = wrapped.iter().position(|a| a == "--").unwrap();
        assert_eq!(&wrapped[sep + 1..], &["echo".to_string(), "hi".to_string()]);
        // The profile string is the -p argument and denies by default.
        let p = wrapped.iter().position(|a| a == "-p").unwrap();
        assert!(wrapped[p + 1].contains("(deny default)"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn wrap_command_macos_fails_closed_on_unsafe_policy() {
        let bad = SandboxPolicy { write_roots: vec![PathBuf::from("/etc")], ..policy() };
        assert!(wrap_command(&["ls".to_string()], &bad).is_err());
    }

    // ── macOS REAL-SPAWN regression (P2-1): the generated profile must let a
    //    child actually launch, and must actually confine writes to cwd. Gated to
    //    macOS + skipped when sandbox-exec is absent, so a Linux CI never runs it.
    //    cwd lives UNDER $HOME (a /var/folders temp dir is — correctly — rejected
    //    as a write root by validate, mirror-consistent), created + cleaned here.

    #[cfg(target_os = "macos")]
    fn home_test_dir() -> PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let home = std::env::var("HOME").expect("HOME is set on macOS");
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = PathBuf::from(home).join(format!("braavo-test-{n}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_real_spawn_true_exits_zero_under_generated_profile() {
        use std::process::Command;
        if !Path::new("/usr/bin/sandbox-exec").is_file() {
            return; // no launcher (unexpected on macOS) → skip rather than fail
        }
        let cwd = home_test_dir();
        let resolved = resolve_policy(&default_policy(&cwd)).expect("cwd resolves");
        let wrapped = wrap_command(&["/usr/bin/true".to_string()], &resolved).expect("wraps");
        let status = Command::new(&wrapped[0])
            .args(&wrapped[1..])
            .current_dir(&cwd)
            .status()
            .expect("spawn sandbox-exec");
        assert!(
            status.success(),
            "a sandboxed /usr/bin/true must exit 0 — root-dir traversal must be granted"
        );
        let _ = fs::remove_dir_all(&cwd);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_sandbox_allows_write_in_cwd_but_denies_outside() {
        use std::process::Command;
        if !Path::new("/usr/bin/sandbox-exec").is_file() {
            return;
        }
        let cwd = home_test_dir();
        let resolved = resolve_policy(&default_policy(&cwd)).expect("cwd resolves");

        // Write INSIDE cwd → allowed (cwd is the sole write root).
        let inside = cwd.join("probe.txt");
        let w_in = wrap_command(
            &["/usr/bin/touch".to_string(), inside.to_string_lossy().into_owned()],
            &resolved,
        )
        .unwrap();
        let ok = Command::new(&w_in[0]).args(&w_in[1..]).current_dir(&cwd).status().unwrap();
        assert!(ok.success(), "touch inside cwd must succeed");
        assert!(inside.is_file(), "the file must actually exist inside cwd");

        // Write OUTSIDE cwd (its parent $HOME, not a write root) → denied.
        let outside = cwd
            .parent()
            .unwrap()
            .join(format!("braavo-outside-{}.txt", std::process::id()));
        let _ = fs::remove_file(&outside);
        let w_out = wrap_command(
            &["/usr/bin/touch".to_string(), outside.to_string_lossy().into_owned()],
            &resolved,
        )
        .unwrap();
        let denied = Command::new(&w_out[0]).args(&w_out[1..]).current_dir(&cwd).status().unwrap();
        assert!(!denied.success(), "touch outside cwd must be denied by the sandbox");
        assert!(!outside.is_file(), "the outside file must NOT have been created");

        let _ = fs::remove_file(&outside);
        let _ = fs::remove_dir_all(&cwd);
    }
}
