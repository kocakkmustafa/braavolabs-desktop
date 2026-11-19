//! BRA-UI-10 "Yayına hazırla" — the host half of the publish flow (default OFF in the UI).
//!
//! Deliberately NOT a general git or HTTP bridge. Three governed actions, each with fixed argv and
//! a one-time approval token bound to its exact fields (see `lib.rs`):
//!   * `git.commit` — `git switch -c <branch>`, `git add -- <changed files>`, `git commit`
//!   * `git.push`   — `git push --no-verify <verified github.com url> <branch>` (never force, delete or a refspec; no token)
//!   * `github.pr`  — `POST /repos/{owner}/{repo}/pulls` on api.github.com with the user's own PAT
//!
//! The PAT lives only in the OS keychain. It is read here, inside the host, for exactly ONE use: the
//! `POST /pulls` call (a stdin curl config). It never touches `git push`, which authenticates with the
//! user's own git identity (credential helper or SSH). It is never returned to the webview, logged,
//! put in argv, or put in an error string. Errors cross the boundary as
//! stable codes (`publish:<code>`), never as git/curl output (which can echo a remote URL).

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};

pub const MAX_BRANCH: usize = 100;
pub const MAX_TITLE: usize = 200;
pub const MAX_BODY: usize = 4000;
/// The only host the PR call may reach.
pub const GITHUB_API: &str = "https://api.github.com";

/// Stable error codes shown (as words) by the UI. Raw git/curl output never leaves this module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PubErr {
    InvalidBranch,
    InvalidText,
    NothingToPublish,
    TooMany,
    SecretFile,
    NotGithub,
    NoPat,
    KeychainUnavailable,
    BranchExists,
    Identity,
    CommitFailed,
    WrongBranch,
    PushRejected,
    NoWriteAccess,
    Unauthorized,
    NotFound,
    RateLimit,
    Network,
    Conflict,
    UnsafeConfig,
    GitAuth,
    ChangesChanged,
    Unknown,
}

impl PubErr {
    pub fn code(self) -> &'static str {
        match self {
            PubErr::InvalidBranch => "invalidBranch",
            PubErr::InvalidText => "invalidText",
            PubErr::NothingToPublish => "nothingToPublish",
            PubErr::TooMany => "tooMany",
            PubErr::SecretFile => "secretFile",
            PubErr::NotGithub => "notGithub",
            PubErr::NoPat => "noPat",
            PubErr::KeychainUnavailable => "keychainUnavailable",
            PubErr::BranchExists => "branchExists",
            PubErr::Identity => "identity",
            PubErr::CommitFailed => "commitFailed",
            PubErr::WrongBranch => "wrongBranch",
            PubErr::PushRejected => "pushRejected",
            PubErr::NoWriteAccess => "noWriteAccess",
            PubErr::Unauthorized => "unauthorized",
            PubErr::NotFound => "notFound",
            PubErr::RateLimit => "rateLimit",
            PubErr::Network => "network",
            PubErr::Conflict => "conflict",
            PubErr::UnsafeConfig => "unsafeConfig",
            PubErr::GitAuth => "gitAuth",
            PubErr::ChangesChanged => "changesChanged",
            PubErr::Unknown => "unknown",
        }
    }
    pub fn msg(self) -> String {
        format!("publish:{}", self.code())
    }
}

// ── validation ───────────────────────────────────────────────────────────────

/// Branch names the flow may create or push. Stricter than git: letters, digits and `._/-` only, so a
/// name can never be an option (`-x`), a refspec (`+a:b`, `a:b`), a revision expression (`a..b`, `@{`),
/// or carry a shell/ref-injection character. Mirrors `isValidBranch` in `src/publish.ts`.
pub fn is_valid_branch(b: &str) -> bool {
    if b.is_empty() || b.len() > MAX_BRANCH || b == "HEAD" || b == "@" {
        return false;
    }
    if !b.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-')) {
        return false;
    }
    let first = b.chars().next().unwrap_or('-');
    if matches!(first, '-' | '/' | '.') || b.ends_with('/') || b.ends_with('.') || b.ends_with(".lock") {
        return false;
    }
    if b.contains("..") || b.contains("//") {
        return false;
    }
    b.split('/').all(|seg| !seg.is_empty() && !seg.starts_with('.') && !seg.ends_with(".lock"))
}

/// PR/commit text: bounded, no NUL. Newlines are fine in the body only.
pub fn valid_title(t: &str) -> bool {
    let n = t.trim().chars().count();
    n >= 1 && n <= MAX_TITLE && !t.chars().any(|c| c == '\0' || c == '\n' || c == '\r')
}
pub fn valid_body(b: &str) -> bool {
    b.chars().count() <= MAX_BODY && !b.contains('\0')
}

fn base_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Names and folders that commonly hold secrets. Same family as the attachment guard (UI-09), plus
/// the credential folders. A match stops the commit before anything is staged.
pub fn is_secret_path(path: &str) -> bool {
    let p = path.replace('\\', "/").to_ascii_lowercase();
    if p.split('/').any(|seg| matches!(seg, ".ssh" | ".aws" | ".gnupg" | ".kube" | ".docker")) {
        return true;
    }
    let b = base_name(&p);
    if b == ".env" || b.starts_with(".env.") || b.ends_with(".env") || b == ".envrc" || b.starts_with("config.env") {
        return true;
    }
    if [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"].iter().any(|e| b.ends_with(e)) || b.contains(".key.") {
        return true;
    }
    for pre in ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"] {
        if b == pre || b.starts_with(&format!("{pre}.")) {
            return true;
        }
    }
    for stem in ["credential", "credentials", "secret", "secrets"] {
        if b == stem || b.starts_with(&format!("{stem}.")) {
            return true;
        }
    }
    b == ".npmrc" || b == ".netrc" || b == ".pypirc"
}

/// THE canonical order of the file list: plain UTF-8 byte order, duplicates dropped. The UI sorts with the same rule
/// (`byteSort` in publish.ts) and the host sorts before it builds the token binding, so both sides bind the same bytes
/// whatever order git or the changes list produced them in.
pub fn canonical_files(mut files: Vec<String>) -> Vec<String> {
    files.sort();
    files.dedup();
    files
}

/// The paths `git add` may receive. They come from `changed_files_in`, and are re-checked here so the
/// choke point does not trust its caller: relative, no `..`, not an option, not inside `.git`.
pub fn validate_publish_files(files: &[String]) -> Result<(), PubErr> {
    if files.is_empty() {
        return Err(PubErr::NothingToPublish);
    }
    for f in files {
        let norm = f.replace('\\', "/");
        let bad = f.is_empty()
            || f.contains('\0')
            || f.contains('\n')
            || f.starts_with('"') // git quoted an unusual name (quote/control char): refuse rather than guess
            || norm.starts_with('/')
            || norm.starts_with('-')
            || norm.starts_with(':') // pathspec magic (`:(glob)…`, `:/…`)
            || norm.split('/').any(|s| s == ".." || s == ".git")
            || (norm.len() > 1 && norm.as_bytes()[1] == b':'); // C:\...
        if bad {
            return Err(PubErr::InvalidText);
        }
    }
    if files.iter().any(|f| is_secret_path(f)) {
        return Err(PubErr::SecretFile);
    }
    Ok(())
}

/// True when a `git push` argv carries anything but the one allowed shape. Defence in depth: the argv is
/// built from fixed pieces plus a validated branch, and still checked here before it runs.
pub fn push_argv_denied(argv: &[String], expected_url: &str) -> bool {
    let a: Vec<&str> = argv.iter().map(|s| s.as_str()).collect();
    for s in &a {
        let l = s.to_ascii_lowercase();
        if l.starts_with("--force") || l == "-f" || l.starts_with("--delete") || l == "-d" || l.starts_with("--mirror")
            || l.starts_with("--prune") || l.starts_with("--receive-pack") || l.starts_with("--exec")
            || s.starts_with('+') || s.starts_with(':')
        {
            return true;
        }
    }
    // exactly: push --no-verify <the verified explicit URL> <branch>. Never the `origin` name: its URL, pushurl and any
    // insteadOf rewrite live in repo config the user's tooling (or a hostile repo) controls.
    !(a.len() == 4 && a[0] == "push" && a[1] == "--no-verify" && a[2] == expected_url && is_valid_branch(a[3]))
}

/// The one URL a push may go to, built from the approved owner/repo (never from `origin`'s raw string).
pub fn push_url(owner: &str, repo: &str, https: bool) -> String {
    if https { format!("https://github.com/{owner}/{repo}.git") } else { format!("git@github.com:{owner}/{repo}.git") }
}

// ── remote parsing ───────────────────────────────────────────────────────────

/// `(owner, repo)` of a github.com remote; the credential part of a URL is dropped here, never kept.
/// Accepts https://[user[:pw]@]github.com/o/r[.git] and git@github.com:o/r[.git] / ssh://git@github.com/o/r.
pub fn parse_github_remote(url: &str) -> Option<(String, String, bool)> {
    let u = url.trim();
    if u.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '?' | '#' | '\\')) {
        return None;
    }
    let (rest, https) = if let Some(r) = u.strip_prefix("https://") {
        // The authority is everything before the FIRST '/'. userinfo is stripped from it alone, and what
        // is left must be exactly `github.com` (no port, no lookalike): `https://evil.com/x@github.com/o/r`
        // has authority `evil.com` and is refused.
        let (authority, path) = r.split_once('/')?;
        let host = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
        if host != "github.com" {
            return None;
        }
        (path.to_string(), true)
    } else if let Some(r) = u.strip_prefix("git@github.com:") {
        (r.to_string(), false)
    } else if let Some(r) = u.strip_prefix("ssh://git@github.com/") {
        (r.to_string(), false)
    } else {
        return None;
    };
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let mut it = rest.split('/');
    let (o, r) = (it.next()?, it.next()?);
    if it.next().is_some() || !slug_ok(o) || !slug_ok(r) {
        return None;
    }
    Some((o.to_string(), r.to_string(), https))
}

fn slug_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s != "." && s != ".." && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

// ── PAT shape ────────────────────────────────────────────────────────────────

/// A pasted token: printable ASCII, no spaces, sane length. Not a validity check (GitHub decides that).
pub fn pat_shape_ok(pat: &str) -> bool {
    let p = pat.trim();
    p.len() >= 20 && p.len() <= 255 && p.bytes().all(|b| b.is_ascii_graphic())
}

// ── git ──────────────────────────────────────────────────────────────────────

pub struct GitOut {
    pub ok: bool,
    /// Exit code (`None` when killed by a signal). `git config` exit 1 means "no such key"; anything else is a read error.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Run `git` with fixed args (no shell), never prompting. `extra_env` carries nothing secret.
pub fn run_git(cwd: &str, args: &[&str]) -> Result<GitOut, PubErr> {
    run_git_with(cwd, args, &[], None)
}

#[cfg(windows)]
const NULL_CONFIG: &str = "NUL";
#[cfg(not(windows))]
const NULL_CONFIG: &str = "/dev/null";

/// `hardened` is for the push: the repo's own config must not run a hook on it (hooks point at an EMPTY dir) or switch TLS
/// verification off. No token is involved: the push authenticates with the user's own git identity (credential helper or
/// SSH), so the user's global config is read as usual. `extra_env` carries nothing secret.
pub fn run_git_with(cwd: &str, args: &[&str], extra_env: &[(&str, &str)], hardened: Option<&Path>) -> Result<GitOut, PubErr> {
    run_git_full(cwd, args, extra_env, hardened, None)
}

/// Like `run_git_with`, with an optional overall deadline: past it the child is killed and the result is `Network` (a push that
/// stops answering must not hang the app). Output is drained on threads so a full pipe cannot stall the child.
pub fn run_git_full(cwd: &str, args: &[&str], extra_env: &[(&str, &str)], hardened: Option<&Path>, timeout: Option<std::time::Duration>) -> Result<GitOut, PubErr> {
    let mut cmd = Command::new("git");
    if let Some(hooks) = hardened {
        for c in ["http.sslVerify=true", "http.https://github.com/.sslVerify=true", "http.followRedirects=false"] {
            cmd.arg("-c").arg(c);
        }
        cmd.arg("-c").arg(format!("core.hooksPath={}", hooks.display()));
        cmd.env_remove("GIT_SSL_NO_VERIFY");
    }
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let mut child = cmd
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_EDITOR", "true")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| PubErr::Unknown)?;
    fn drain<R: Read + Send + 'static>(r: Option<R>) -> std::sync::mpsc::Receiver<Vec<u8>> {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut b = Vec::new();
            if let Some(mut r) = r {
                let _ = r.read_to_end(&mut b);
            }
            let _ = tx.send(b);
        });
        rx
    }
    let (out_rx, err_rx) = (drain(child.stdout.take()), drain(child.stderr.take()));
    let deadline = timeout.map(|t| std::time::Instant::now() + t);
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {
                if deadline.map_or(false, |d| std::time::Instant::now() >= d) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(PubErr::Network); // readers are left to end on their own (a grandchild may hold the pipe)
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(_) => return Err(PubErr::Unknown),
        }
    };
    let grab = |rx: std::sync::mpsc::Receiver<Vec<u8>>| rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap_or_default();
    Ok(GitOut {
        ok: status.success(),
        code: status.code(),
        stdout: String::from_utf8_lossy(&grab(out_rx)).to_string(),
        stderr: String::from_utf8_lossy(&grab(err_rx)).to_string(),
    })
}

/// Parse the `remote.*` keys of the repo config. Refuses: a section name that is not a plain alias (contains ':' or
/// '/'), any `pushurl`/`proxy`/`receivepack`/`uploadpack`, and any `url` whose value is not the SAME github owner/repo
/// as the explicit push URL (so a normal `origin` clone passes, a re-pointed or extra remote does not).
fn remote_keys_ok(listing: &str, expected: &(String, String)) -> bool {
    for line in listing.lines() {
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        let key = key.to_ascii_lowercase();
        let Some(rest) = key.strip_prefix("remote.") else { continue };
        let Some((name, var)) = rest.rsplit_once('.') else { return false };
        if name.is_empty() || name.contains(':') || name.contains('/') {
            return false;
        }
        match var {
            "pushurl" | "proxy" | "receivepack" | "uploadpack" => return false,
            "url" => match parse_github_remote(value.trim()) {
                Some((o, r, _)) if o == expected.0 && r == expected.1 => {}
                _ => return false,
            },
            _ => {}
        }
    }
    true
}

/// A push is only made from a repo whose own config cannot redirect or weaken it. Any repo-level `http.*`,
/// `url.*` (insteadOf/pushInsteadOf), `include.*`, `credential.*` (a repo-level helper runs a command with the user's identity), `protocol.*` or `core.sshCommand/hooksPath/gitProxy/askPass/fsmonitor/editor` key refuses it, and the
/// `remote.*` keys must pass `remote_keys_ok` (system/global config is not read: env switches them off).
/// `git config` exit 1 with no output = no such key.
pub fn push_config_clean(cwd: &str, expected: &(String, String)) -> bool {
    // No `-c` pins here (they would show up in the listing themselves).
    let re = r"^(http\.|url\.|include\.|includeif\.|credential\.|protocol\.|core\.(sshcommand|hookspath|gitproxy|askpass|fsmonitor|editor))";
    let env = [("GIT_CONFIG_NOSYSTEM", "1"), ("GIT_CONFIG_GLOBAL", NULL_CONFIG)];
    if !matches!(run_git_with(cwd, &["config", "--get-regexp", re], &env, None), Ok(o) if !o.ok && o.code == Some(1) && o.stdout.trim().is_empty()) {
        return false;
    }
    match run_git_with(cwd, &["config", "--get-regexp", r"^remote\."], &env, None) {
        Ok(o) if o.ok => remote_keys_ok(&o.stdout, expected),
        Ok(o) => o.code == Some(1) && o.stdout.trim().is_empty(), // exit 1 only: no remote keys at all (128 = unreadable config, not clean)
        Err(_) => false,
    }
}

/// Remove leftovers of a crashed push: hooks dirs (`hooks-*`) older than `min_age` (zero at startup). Best effort; never
/// touches anything else.
pub fn sweep_stale(tmp_root: &Path, min_age: std::time::Duration) {
    let Ok(rd) = std::fs::read_dir(tmp_root) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map_or(true, |a| a >= min_age);
        if !old {
            continue;
        }
        if name.starts_with("hooks-") && e.path().is_dir() {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// A fresh, empty, owner-only hooks directory for ONE push; removed on drop.
struct TempHooks(std::path::PathBuf);
impl TempHooks {
    fn create(root: &Path) -> Result<Self, PubErr> {
        std::fs::create_dir_all(root).map_err(|_| PubErr::Unknown)?;
        let ns = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = root.join(format!("hooks-{}-{ns}", std::process::id()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new().mode(0o700).create(&dir).map_err(|_| PubErr::Unknown)?;
        }
        #[cfg(not(unix))]
        std::fs::create_dir(&dir).map_err(|_| PubErr::Unknown)?;
        Ok(TempHooks(dir))
    }
}
impl Drop for TempHooks {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The push, as ONE call: re-check the repo config, push to the explicit URL with the hardened flags (a fresh empty hooks
/// dir under `tmp_root`, deleted afterwards), then re-check that the config did not change during the push. No token is
/// involved: authentication is the user's own git identity (credential helper or SSH), never prompted for (`GIT_TERMINAL_PROMPT=0`).
pub fn guarded_push(cwd: &str, url: &str, branch: &str, tmp_root: &Path) -> Result<GitOut, PubErr> {
    guarded_push_inner(cwd, url, branch, tmp_root, true, PUSH_TIMEOUT)
}

/// Overall limit for one push; past it the child is killed and the step fails as `Network`.
pub const PUSH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// ssh must never wait for a passphrase or a host-key question (no terminal): `BatchMode=yes` plus a connect timeout, unless the
/// user set their own ssh command (`GIT_SSH_COMMAND`, `GIT_SSH`, global `core.sshCommand`). Then theirs stays and only the overall
/// timeout bounds the push.
fn ssh_batch_env(cwd: &str) -> Vec<(&'static str, String)> {
    let own = std::env::var_os("GIT_SSH_COMMAND").is_some() || std::env::var_os("GIT_SSH").is_some()
        || matches!(run_git(cwd, &["config", "--get", "core.sshCommand"]), Ok(o) if o.ok && !o.stdout.trim().is_empty());
    if own { vec![] } else { vec![("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o ConnectTimeout=15".to_string())] }
}

/// `verify_target` is false only in tests that push to a local bare repository (not a github.com URL).
fn guarded_push_inner(cwd: &str, url: &str, branch: &str, tmp_root: &Path, verify_target: bool, timeout: std::time::Duration) -> Result<GitOut, PubErr> {
    let argv: Vec<String> = ["push", "--no-verify", url, branch].iter().map(|s| s.to_string()).collect();
    if argv[3] != branch || !is_valid_branch(branch) || argv.iter().any(|a| a.starts_with('+') || a.starts_with("--force") || a == "--delete") {
        return Err(PubErr::InvalidBranch);
    }
    let expected = parse_github_remote(url).map(|(o, r, _)| (o, r)).unwrap_or_default();
    if !push_config_clean(cwd, &expected) || (verify_target && !push_target_matches(cwd, url, &expected)) {
        return Err(PubErr::UnsafeConfig);
    }
    let hooks = TempHooks::create(tmp_root)?;
    let args: Vec<&str> = argv.iter().map(|s| s.as_str()).collect();
    let ssh = ssh_batch_env(cwd);
    let env: Vec<(&str, &str)> = ssh.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let out = run_git_full(cwd, &args, &env, Some(&hooks.0), Some(timeout));
    drop(hooks);
    let out = out?;
    if !push_config_clean(cwd, &expected) {
        return Err(PubErr::UnsafeConfig);
    }
    Ok(out)
}

/// The push goes where the user approved: `origin`'s push URL (as git resolves it, rewrites included) and the explicit URL
/// (resolved the same way, so a global `insteadOf` is seen) must both name the approved owner/repo on github.com. A rewrite
/// to another repository or host means no push. https and ssh forms of the same repository are the same target.
pub fn push_target_matches(cwd: &str, url: &str, expected: &(String, String)) -> bool {
    let same = |o: &GitOut| {
        o.ok && matches!(parse_github_remote(o.stdout.trim()), Some((a, b, _)) if a == expected.0 && b == expected.1)
    };
    match run_git(cwd, &["remote", "get-url", "--push", "origin"]) {
        Ok(o) if same(&o) => {}
        _ => return false,
    }
    matches!(run_git(cwd, &["ls-remote", "--get-url", url]), Ok(o) if same(&o))
}

pub fn current_branch(cwd: &str) -> Option<String> {
    let o = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    let b = o.stdout.trim().to_string();
    (o.ok && !b.is_empty() && b != "HEAD").then_some(b)
}

/// The repository root. `git status` reports paths relative to it, so `git add` must run there, not in a subfolder.
pub fn repo_root(cwd: &str) -> Option<String> {
    let o = run_git(cwd, &["rev-parse", "--show-toplevel"]).ok()?;
    let r = o.stdout.trim().to_string();
    (o.ok && !r.is_empty()).then_some(r)
}

pub fn origin_remote(cwd: &str) -> Option<(String, String, bool)> {
    let o = run_git(cwd, &["remote", "get-url", "origin"]).ok()?;
    if !o.ok {
        return None;
    }
    parse_github_remote(o.stdout.trim())
}

/// The repository's default branch (what a PR targets). Falls back to `main`.
pub fn default_base(cwd: &str) -> String {
    if let Ok(o) = run_git(cwd, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) {
        if o.ok {
            if let Some(b) = o.stdout.trim().strip_prefix("origin/") {
                if is_valid_branch(b) {
                    return b.to_string();
                }
            }
        }
    }
    "main".to_string()
}

/// Classify a failed `git commit` / `git switch` from its stderr. Only the code leaves this module.
pub fn classify_commit_failure(stderr: &str) -> PubErr {
    let s = stderr.to_ascii_lowercase();
    if s.contains("already exists") {
        PubErr::BranchExists
    } else if s.contains("tell me who you are") || s.contains("empty ident") || s.contains("unable to auto-detect email") {
        PubErr::Identity
    } else if s.contains("nothing to commit") || s.contains("no changes added") {
        PubErr::NothingToPublish
    } else {
        PubErr::CommitFailed
    }
}

/// True when `code` appears in `line` as a standalone number: not part of a longer word or path (`app404`, `/404/`, `1.404`).
fn has_status_code(line: &str, code: &str) -> bool {
    let bytes = line.as_bytes();
    let mut from = 0;
    while let Some(i) = line[from..].find(code) {
        let at = from + i;
        let before = if at == 0 { b' ' } else { bytes[at - 1] };
        let after = bytes.get(at + code.len()).copied().unwrap_or(b' ');
        let edge = |c: u8| !(c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b'/' | b':'));
        if edge(before) && edge(after) {
            return true;
        }
        from = at + code.len();
    }
    false
}

/// Classify a failed `git push` (authentication problems all become `GitAuth`: the app's key plays no part in the push). Only git's own diagnostic lines count (`remote:`, `fatal:`, `error:`, ` ! [...]`), and
/// HTTP codes only as whole numbers, so a repository called `app404` or a number in a URL cannot steer the result.
pub fn classify_push_failure(stderr: &str) -> PubErr {
    let lines: Vec<String> = stderr
        .lines()
        .map(|l| l.trim().to_ascii_lowercase())
        .filter(|l| l.starts_with("remote:") || l.starts_with("fatal:") || l.starts_with("error:") || l.starts_with("! [") || l.starts_with("ssh:")
            || l.contains("permission denied (publickey") || l.contains("host key verification failed"))
        .collect();
    let any = |f: &dyn Fn(&str) -> bool| lines.iter().any(|l| f(l));
    let has = |w: &str| any(&|l: &str| l.contains(w));
    let code = |c: &str| any(&|l: &str| has_status_code(l, c));
    if has("could not resolve host") || any(&|l: &str| l.contains("unable to access") && (l.contains("timed out") || l.contains("resolve") || l.contains("connect"))) || has("network is unreachable") || has("connection refused")
        || has("could not resolve hostname") || has("no route to host") || any(&|l: &str| l.contains("connect to host") && (l.contains("timed out") || l.contains("refused") || l.contains("unreachable") || l.contains("no route"))) {
        PubErr::Network
    } else if has("could not read username") || has("could not read password") || has("terminal prompts disabled") || has("no such device or address")
        || has("permission denied (publickey") || has("host key verification failed")
        || code("401") || code("403") || code("404") || has("bad credentials") || has("authentication failed") || has("invalid username or password")
        || has("permission to") || has("write access") || has("repository not found")
    {
        // The push signs in with the user's own git identity, never with the app's access key: a missing or refused identity, a
        // wrong account or a repository this account cannot see all need the same fix, in Git.
        PubErr::GitAuth
    } else if has("non-fast-forward") || has("fetch first") || has("[rejected]") || has("protected branch") || has("hook declined") || has("denied to") {
        PubErr::PushRejected
    } else {
        PubErr::Unknown
    }
}

/// The commit half, after approval: `git switch -c`, `git add -- <files>`, `git commit`. Returns the short SHA.
/// On a failure after the switch it goes back to the previous branch and removes the new one with the safe `-d`.
pub fn commit_on_new_branch(cwd: &str, branch: &str, title: &str, body: &str, files: &[String]) -> Result<String, PubErr> {
    let prev = current_branch(cwd);
    // Detached HEAD has no branch to go back to: remember the commit instead.
    let prev_sha = run_git(cwd, &["rev-parse", "HEAD"]).ok().filter(|o| o.ok).map(|o| o.stdout.trim().to_string());
    let sw = run_git(cwd, &["switch", "-c", branch])?;
    if !sw.ok {
        return Err(classify_commit_failure(&sw.stderr));
    }
    let undo = || {
        let back = match (&prev, &prev_sha) {
            (Some(p), _) => run_git(cwd, &["switch", p]),
            (None, Some(sha)) => run_git(cwd, &["switch", "--detach", sha]),
            _ => return,
        };
        if back.map(|o| o.ok).unwrap_or(false) {
            let _ = run_git(cwd, &["branch", "-d", branch]);
        }
    };
    // Literal pathspecs: a changed file named `:(top)x` or `*.ts` is that file, never pathspec magic or a glob.
    let mut add: Vec<&str> = vec!["--literal-pathspecs", "add", "--"];
    add.extend(files.iter().map(|s| s.as_str()));
    match run_git_with(cwd, &add, &[("GIT_LITERAL_PATHSPECS", "1")], None) {
        Ok(o) if o.ok => {}
        _ => {
            undo();
            return Err(PubErr::CommitFailed);
        }
    }
    let mut commit: Vec<&str> = vec!["commit", "-m", title.trim()];
    if !body.trim().is_empty() {
        commit.push("-m");
        commit.push(body.trim());
    }
    match run_git(cwd, &commit) {
        Ok(o) if o.ok => {}
        Ok(o) => {
            undo();
            return Err(classify_commit_failure(&o.stderr));
        }
        Err(e) => {
            undo();
            return Err(e);
        }
    }
    Ok(run_git(cwd, &["rev-parse", "--short", "HEAD"]).map(|o| o.stdout.trim().to_string()).unwrap_or_default())
}

// ── GitHub PR over curl (no new crate; the token travels on stdin only) ──────

#[derive(Debug, PartialEq, Eq)]
pub struct PrOut {
    pub number: u64,
    pub url: String,
}

/// curl config string quoting: backslash and double quote escaped; JSON has no raw newlines.
fn cfg_quote(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '\\' => o.push_str("\\\\"),
            '"' => o.push_str("\\\""),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

pub fn pr_payload(title: &str, body: &str, head: &str, base: &str, draft: bool) -> String {
    serde_json::json!({ "title": title.trim(), "body": body, "head": head, "base": base, "draft": draft }).to_string()
}

/// Map an HTTP status (+ message text) to a code. Pure, so the table is tested.
pub fn classify_http(status: u16, message: &str) -> PubErr {
    let m = message.to_ascii_lowercase();
    match status {
        401 => PubErr::Unauthorized,
        429 => PubErr::RateLimit,
        403 if m.contains("rate limit") || m.contains("abuse") || m.contains("secondary") => PubErr::RateLimit,
        403 => PubErr::NoWriteAccess,
        404 | 301 | 307 | 308 => PubErr::NotFound, // 30x: the repository moved or was renamed
        422 if m.contains("already exists") => PubErr::Conflict,
        422 if m.contains("no commits between") => PubErr::NothingToPublish,
        422 => PubErr::Conflict,
        409 => PubErr::Conflict,
        _ => PubErr::Unknown,
    }
}

fn curl_bin() -> &'static str {
    #[cfg(windows)]
    {
        "curl.exe"
    }
    #[cfg(not(windows))]
    {
        if Path::new("/usr/bin/curl").exists() { "/usr/bin/curl" } else { "curl" }
    }
}

/// POST the PR. `api_base` is `GITHUB_API` in production; tests pass a loopback http base. The token and the
/// body go in as a curl config on stdin: nothing secret in argv, env or a file.
pub fn open_pr(api_base: &str, pat: &str, owner: &str, repo: &str, payload: &str) -> Result<PrOut, PubErr> {
    if !(api_base == GITHUB_API || api_base.starts_with("http://127.0.0.1:")) || !slug_ok(owner) || !slug_ok(repo) {
        return Err(PubErr::Unknown);
    }
    let mut cfg = String::new();
    cfg.push_str(&format!("url = {}\n", cfg_quote(&format!("{api_base}/repos/{owner}/{repo}/pulls"))));
    cfg.push_str("request = \"POST\"\nsilent\nmax-time = 30\nconnect-timeout = 10\n");
    if api_base == GITHUB_API {
        cfg.push_str("proto = \"=https\"\n");
    }
    cfg.push_str("write-out = \"\\n%{http_code}\"\n");
    cfg.push_str(&format!("header = {}\n", cfg_quote(&format!("Authorization: Bearer {}", pat.trim()))));
    for h in ["Accept: application/vnd.github+json", "X-GitHub-Api-Version: 2022-11-28", "User-Agent: braavolabs-desktop", "Content-Type: application/json"] {
        cfg.push_str(&format!("header = {}\n", cfg_quote(h)));
    }
    cfg.push_str(&format!("data-binary = {}\n", cfg_quote(payload)));
    // `-q` MUST be the first argument: curl then ignores ~/.curlrc (a proxy or extra header there must not apply).
    let mut child = Command::new(curl_bin())
        .args(["-q", "--config", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| PubErr::Network)?;
    let mut out = String::new();
    let io = (|| -> Result<(), PubErr> {
        child.stdin.take().ok_or(PubErr::Unknown)?.write_all(cfg.as_bytes()).map_err(|_| PubErr::Unknown)?;
        child.stdout.take().ok_or(PubErr::Unknown)?.take(1 << 20).read_to_string(&mut out).map_err(|_| PubErr::Network)?;
        Ok(())
    })();
    if let Err(e) = io {
        // never leave the child (and its stdin config) behind
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }
    let status = child.wait().map_err(|_| PubErr::Network)?;
    if !status.success() {
        return Err(PubErr::Network); // DNS, connect, TLS, timeout: no HTTP answer at all
    }
    parse_pr_response(&out)
}

pub fn parse_pr_response(out: &str) -> Result<PrOut, PubErr> {
    let (body, code) = out.rsplit_once('\n').ok_or(PubErr::Unknown)?;
    let status: u16 = code.trim().parse().map_err(|_| PubErr::Unknown)?;
    let v: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    if status == 201 {
        let number = v.get("number").and_then(|n| n.as_u64()).ok_or(PubErr::Unknown)?;
        let url = v.get("html_url").and_then(|u| u.as_str()).unwrap_or("");
        // Only a github.com page may be shown or opened from here.
        if !url.starts_with("https://github.com/") || url.len() > 300 || url.chars().any(|c| c.is_control() || c == ' ') {
            return Err(PubErr::Unknown);
        }
        return Ok(PrOut { number, url: url.to_string() });
    }
    let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or("");
    let detail = v.get("errors").map(|e| e.to_string()).unwrap_or_default();
    Err(classify_http(status, &format!("{msg} {detail}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;

    #[test]
    fn branch_validation_rejects_injection_shapes() {
        for ok in ["braavo/satis-ozeti", "feat/a_b.c", "fix-1", "a/b/c"] {
            assert!(is_valid_branch(ok), "{ok}");
        }
        for bad in [
            "", "-x", "--force", "+a:b", "a:b", "a..b", "a//b", "/a", "a/", "a.", ".a", "a/.b", "x.lock", "a/x.lock", "HEAD", "@", "a b", "a;b", "a$(x)",
            "a\nb", "a@{1}", "a~1", "a^", "a?", "a*", "a[", "a\\b", "ş", &"a".repeat(101),
        ] {
            assert!(!is_valid_branch(bad), "{bad:?}");
        }
    }

    #[test]
    fn push_argv_only_the_one_shape() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let url = push_url("o", "r", true);
        assert_eq!(url, "https://github.com/o/r.git");
        assert!(!push_argv_denied(&a(&["push", "--no-verify", &url, "braavo/x"]), &url));
        assert!(push_argv_denied(&a(&["push", &url, "braavo/x"]), &url), "--no-verify is part of the shape");
        for bad in [
            a(&["push", "--force", &url, "x"]),
            a(&["push", &url, "+x"]),
            a(&["push", &url, "x:y"]),
            a(&["push", &url, "--delete"]),
            a(&["push", "--force-with-lease", &url, "x"]),
            a(&["push", "-f", &url, "x"]),
            a(&["push", &url, ":x"]),
            a(&["push", &url, "x", "y"]),
            a(&["push", "-u", &url, "x"]),
            a(&["push", "origin", "x"]),
            a(&["push", "https://github.com/evil/r.git", "x"]),
            a(&["push", "--mirror"]),
        ] {
            assert!(push_argv_denied(&bad, &url), "{bad:?}");
        }
    }

    #[test]
    fn secret_paths_and_file_checks() {
        for s in [".env", "app/.env.local", "a/prod.env", "k/server.pem", "id_rsa", ".ssh/config", "x/credentials.json", "secrets.yml", ".npmrc", "a/.aws/credentials"] {
            assert!(is_secret_path(s), "{s}");
        }
        for s in ["src/a.ts", "README.md", "keyboard.ts", "environment.md", "src/secret_santa.ts"] {
            assert!(!is_secret_path(s), "{s}");
        }
        assert_eq!(validate_publish_files(&[]), Err(PubErr::NothingToPublish));
        assert_eq!(validate_publish_files(&["../x".into()]), Err(PubErr::InvalidText));
        assert_eq!(validate_publish_files(&["/etc/passwd".into()]), Err(PubErr::InvalidText));
        assert_eq!(validate_publish_files(&["-rf".into()]), Err(PubErr::InvalidText));
        assert_eq!(validate_publish_files(&[".git/config".into()]), Err(PubErr::InvalidText));
        assert_eq!(validate_publish_files(&[":(top)x".into()]), Err(PubErr::InvalidText));
        assert_eq!(validate_publish_files(&[":/x".into()]), Err(PubErr::InvalidText));
        assert_eq!(validate_publish_files(&["a.ts".into(), ".env".into()]), Err(PubErr::SecretFile));
        assert_eq!(validate_publish_files(&["a.ts".into(), "b/c.ts".into()]), Ok(()));
    }

    #[test]
    fn remote_parsing_drops_credentials_and_rejects_other_hosts() {
        let p = |u: &str| parse_github_remote(u).map(|(o, r, h)| (o, r, h));
        assert_eq!(p("https://github.com/aisirketim/satis-paneli.git"), Some(("aisirketim".into(), "satis-paneli".into(), true)));
        assert_eq!(p("https://user:SECRET@github.com/o/r"), Some(("o".into(), "r".into(), true)));
        assert_eq!(p("git@github.com:o/r.git"), Some(("o".into(), "r".into(), false)));
        assert_eq!(p("ssh://git@github.com/o/r"), Some(("o".into(), "r".into(), false)));
        for bad in ["https://gitlab.com/o/r", "https://github.com.evil.com/o/r", "https://evil.com/github.com/o/r", "https://evil.com/x@github.com/o/r", "https://evil.com/u:p@github.com/o/r", "https://github.com:8443/o/r", "https://github.com@evil.com/o/r", "https://github.com/o/r?x=1", "https://github.com\\@evil.com/o/r", "https://github.com/o", "https://github.com/o/r/x", "file:///tmp/x", ""] {
            assert_eq!(p(bad), None, "{bad}");
        }
    }

    #[test]
    fn http_status_table() {
        assert_eq!(classify_http(401, ""), PubErr::Unauthorized);
        assert_eq!(classify_http(403, "Resource not accessible by personal access token"), PubErr::NoWriteAccess);
        assert_eq!(classify_http(403, "API rate limit exceeded"), PubErr::RateLimit);
        assert_eq!(classify_http(429, ""), PubErr::RateLimit);
        assert_eq!(classify_http(404, "Not Found"), PubErr::NotFound);
        assert_eq!(classify_http(422, "A pull request already exists for o:b"), PubErr::Conflict);
        assert_eq!(classify_http(422, "No commits between main and b"), PubErr::NothingToPublish);
        assert_eq!(classify_http(500, ""), PubErr::Unknown);
    }

    #[test]
    fn push_failures_classified_without_exposing_output() {
        assert_eq!(classify_push_failure("fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com"), PubErr::Network);
        assert_eq!(classify_push_failure("remote: Permission to o/r.git denied to u.\nfatal: unable to access '...': The requested URL returned error: 403"), PubErr::GitAuth);
        assert_eq!(classify_push_failure("fatal: Authentication failed for 'https://github.com/o/r.git/'"), PubErr::GitAuth);
        assert_eq!(classify_push_failure("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), PubErr::GitAuth);
        assert_eq!(classify_push_failure("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository."), PubErr::GitAuth);
        assert_eq!(classify_push_failure(" ! [rejected]        x -> x (non-fast-forward)"), PubErr::PushRejected);
        assert_eq!(classify_push_failure("remote: error: GH006: Protected branch update failed"), PubErr::PushRejected);
        assert_eq!(classify_commit_failure("fatal: a branch named 'x' already exists"), PubErr::BranchExists);
        assert_eq!(classify_commit_failure("*** Please tell me who you are."), PubErr::Identity);
        for c in [PubErr::NoPat, PubErr::Network, PubErr::Unauthorized, PubErr::GitAuth, PubErr::SecretFile] {
            assert!(c.msg().starts_with("publish:") && !c.msg().to_lowercase().contains("ghp_"));
        }
    }

    #[test]
    fn parse_response_accepts_only_github_urls() {
        let ok = "{\"number\":42,\"html_url\":\"https://github.com/o/r/pull/42\"}\n201";
        assert_eq!(parse_pr_response(ok), Ok(PrOut { number: 42, url: "https://github.com/o/r/pull/42".into() }));
        assert_eq!(parse_pr_response("{\"number\":1,\"html_url\":\"https://evil.com/x\"}\n201"), Err(PubErr::Unknown));
        assert_eq!(parse_pr_response("{\"message\":\"Bad credentials\"}\n401"), Err(PubErr::Unauthorized));
        assert_eq!(parse_pr_response("garbage"), Err(PubErr::Unknown));
    }

    #[test]
    fn pat_shape() {
        assert!(pat_shape_ok("github_pat_11ABCDEFG0123456789_abcdefghijklmnop"));
        assert!(!pat_shape_ok("short"));
        assert!(!pat_shape_ok("has space in it 0123456789012345"));
    }

    /// Local mock of the GitHub pulls endpoint: checks the request shape and that the token is on the wire only
    /// as the Authorization header (no query string, not in the URL).
    fn mock(status: &str, reply: &'static str) -> (String, std::thread::JoinHandle<String>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", l.local_addr().unwrap().port());
        let st = status.to_string();
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut r = BufReader::new(s.try_clone().unwrap());
            let mut head = String::new();
            let mut len = 0usize;
            loop {
                let mut line = String::new();
                r.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap();
                }
                head.push_str(&line);
            }
            let mut body = vec![0u8; len];
            r.read_exact(&mut body).unwrap();
            head.push_str(&String::from_utf8_lossy(&body));
            write!(s, "HTTP/1.1 {st}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len()).unwrap();
            head
        });
        (base, h)
    }

    #[test]
    fn open_pr_against_a_local_mock_sends_the_token_only_as_a_header() {
        if !Path::new(curl_bin()).exists() && Command::new("curl").arg("--version").output().is_err() {
            return;
        }
        let pat = "ghp_TESTTOKEN0123456789abcdefghijklmnop";
        let (base, h) = mock("201 Created", "{\"number\":7,\"html_url\":\"https://github.com/o/r/pull/7\"}");
        let payload = pr_payload("Başlık \"q\"", "açıklama\nsatır", "feat/x", "main", true);
        let r = open_pr(&base, pat, "o", "r", &payload).unwrap();
        assert_eq!(r.number, 7);
        let wire = h.join().unwrap();
        assert!(wire.starts_with("POST /repos/o/r/pulls HTTP/1.1"), "{wire}");
        assert!(wire.contains(&format!("Authorization: Bearer {pat}")));
        assert!(wire.contains("\"draft\":true") && wire.contains("\"head\":\"feat/x\""));
        assert!(!wire.lines().next().unwrap().contains("ghp_"));
    }

    #[test]
    fn open_pr_maps_error_statuses_and_never_echoes_the_token() {
        if Command::new("curl").arg("--version").output().is_err() {
            return;
        }
        let pat = "ghp_TESTTOKEN0123456789abcdefghijklmnop";
        for (st, reply, want) in [
            ("401 Unauthorized", "{\"message\":\"Bad credentials\"}", PubErr::Unauthorized),
            ("403 Forbidden", "{\"message\":\"Resource not accessible\"}", PubErr::NoWriteAccess),
            ("403 Forbidden", "{\"message\":\"API rate limit exceeded\"}", PubErr::RateLimit),
            ("404 Not Found", "{\"message\":\"Not Found\"}", PubErr::NotFound),
            ("422 Unprocessable Entity", "{\"message\":\"Validation Failed\",\"errors\":[{\"message\":\"A pull request already exists\"}]}", PubErr::Conflict),
        ] {
            let (base, h) = mock(st, reply);
            let e = open_pr(&base, pat, "o", "r", &pr_payload("t", "", "b", "main", false)).unwrap_err();
            h.join().unwrap();
            assert_eq!(e, want, "{st}");
            let shown = format!("{e:?} {}", e.msg());
            for needle in ["ghp_", "github_pat_", "Authorization", "Bearer"] {
                assert!(!shown.contains(needle));
            }
        }
        // nothing is listening: a network error, not a panic
        assert_eq!(open_pr("http://127.0.0.1:1", pat, "o", "r", "{}").unwrap_err(), PubErr::Network);
    }

    #[test]
    fn open_pr_refuses_any_host_but_github() {
        for base in ["https://evil.example", "http://api.github.com", "https://api.github.com.evil.com", "http://localhost:1"] {
            assert_eq!(open_pr(base, "x", "o", "r", "{}").unwrap_err(), PubErr::Unknown, "{base}");
        }
        assert_eq!(open_pr(GITHUB_API, "x", "../..", "r", "{}").unwrap_err(), PubErr::Unknown);
    }

    fn sh(cwd: &Path, args: &[&str]) {
        let o = Command::new("git").args(args).current_dir(cwd).env("GIT_CONFIG_GLOBAL", NULL_CONFIG).output().unwrap();
        assert!(o.status.success(), "{args:?}: {}", String::from_utf8_lossy(&o.stderr));
    }
    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("bv-pub-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn init_repo(d: &Path) {
        sh(d, &["init", "-q", "-b", "main"]);
        sh(d, &["config", "user.email", "t@example.test"]);
        sh(d, &["config", "user.name", "T"]);
        std::fs::write(d.join("a.txt"), "1\n").unwrap();
        sh(d, &["add", "a.txt"]);
        sh(d, &["commit", "-q", "-m", "init"]);
    }

    #[test]
    fn commit_flow_on_a_local_repo_then_push_to_a_local_bare_remote() {
        let root = tmp("flow");
        let (work, bare) = (root.join("w"), root.join("origin.git"));
        std::fs::create_dir_all(&work).unwrap();
        std::fs::create_dir_all(&bare).unwrap();
        sh(&bare, &["init", "-q", "--bare", "-b", "main"]);
        init_repo(&work);
        sh(&work, &["remote", "add", "origin", bare.to_str().unwrap()]);
        std::fs::write(work.join("a.txt"), "2\n").unwrap();
        std::fs::write(work.join("b ü.txt"), "new\n").unwrap();
        let cwd = work.to_str().unwrap();
        let files = vec!["a.txt".to_string(), "b ü.txt".to_string()];
        let sha = commit_on_new_branch(cwd, "braavo/x", "Başlık", "açıklama", &files).unwrap();
        assert!(!sha.is_empty());
        assert_eq!(current_branch(cwd).as_deref(), Some("braavo/x"));
        // the branch the user was on is untouched
        let on_main = Command::new("git").args(["rev-parse", "main"]).current_dir(&work).output().unwrap();
        let on_new = Command::new("git").args(["rev-parse", "HEAD"]).current_dir(&work).output().unwrap();
        assert_ne!(on_main.stdout, on_new.stdout);
        // a second commit on the same branch name is refused (branchExists), nothing changes
        std::fs::write(work.join("c.txt"), "x").unwrap();
        assert_eq!(commit_on_new_branch(cwd, "braavo/x", "t", "", &["c.txt".to_string()]), Err(PubErr::BranchExists));
        assert_eq!(current_branch(cwd).as_deref(), Some("braavo/x"));
        // push with the exact allowed argv to the local bare remote
        let o = run_git(cwd, &["push", "-u", "origin", "braavo/x"]).unwrap();
        assert!(o.ok, "{}", o.stderr);
        let heads = Command::new("git").args(["branch", "--list"]).current_dir(&bare).output().unwrap();
        assert!(String::from_utf8_lossy(&heads.stdout).contains("braavo/x"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)] // the hook is a /bin/sh script made executable with chmod
    #[test]
    fn failed_commit_goes_back_to_the_previous_branch_and_drops_the_new_one() {
        let d = tmp("undo");
        init_repo(&d);
        let hook = d.join(".git/hooks/pre-commit");
        std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::fs::write(d.join("a.txt"), "3\n").unwrap();
        let cwd = d.to_str().unwrap();
        assert_eq!(commit_on_new_branch(cwd, "braavo/y", "t", "", &["a.txt".to_string()]), Err(PubErr::CommitFailed));
        assert_eq!(current_branch(cwd).as_deref(), Some("main"));
        let l = Command::new("git").args(["branch", "--list", "braavo/y"]).current_dir(&d).output().unwrap();
        assert!(l.stdout.is_empty());
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap(), "3\n", "the user's edit is kept");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn add_treats_names_literally_so_a_glob_or_magic_name_cannot_widen_the_commit() {
        let d = tmp("lit");
        init_repo(&d);
        // `[ab].txt` is a valid file name on every OS but a glob that would match a.txt and b.txt if it were not literal.
        std::fs::write(d.join("[ab].txt"), "bracket").unwrap();
        std::fs::write(d.join("a.txt"), "a-changed").unwrap();
        std::fs::write(d.join("b.txt"), "b").unwrap();
        let cwd = d.to_str().unwrap();
        commit_on_new_branch(cwd, "braavo/lit", "t", "", &["[ab].txt".to_string()]).unwrap();
        let tracked = Command::new("git").args(["ls-files"]).current_dir(&d).output().unwrap();
        let t = String::from_utf8_lossy(&tracked.stdout).to_string();
        assert!(t.contains("[ab].txt"), "{t}");
        assert!(!t.lines().any(|l| l == "b.txt"), "a glob name must not pull in other files: {t}");
        let st = Command::new("git").args(["status", "--porcelain"]).current_dir(&d).output().unwrap();
        assert!(String::from_utf8_lossy(&st.stdout).contains("a.txt"), "a.txt stays uncommitted");
        let _ = std::fs::remove_dir_all(&d);
    }

    fn exp() -> (String, String) {
        ("o".to_string(), "r".to_string())
    }

    #[test]
    fn push_config_check_refuses_every_redirecting_repo_key() {
        let root = tmp("cfg");
        let d = root.join("w");
        std::fs::create_dir_all(&d).unwrap();
        init_repo(&d);
        sh(&d, &["remote", "add", "origin", "https://github.com/o/r.git"]);
        let cwd = d.to_str().unwrap();
        assert!(push_config_clean(cwd, &exp()), "a normal clone (origin url only) is clean");
        assert!(!push_config_clean(cwd, &("o".into(), "other".into())), "origin pointing at another repo is refused");
        for (key, val) in [
            ("url.https://evil.example/.insteadOf", "https://github.com/"),
            ("url.https://evil.example/.pushInsteadOf", "https://github.com/"),
            ("http.proxy", "http://127.0.0.1:9"),
            ("http.sslVerify", "false"),
            ("http.https://github.com/.sslVerify", "false"),
            ("http.https://github.com/.proxy", "http://127.0.0.1:9"),
            ("http.sslCAInfo", "/tmp/evil.pem"),
            ("remote.origin.pushurl", "https://evil.example/o/r.git"),
            ("remote.origin.proxy", "http://127.0.0.1:9"),
            ("remote.origin.receivepack", "/tmp/evil"),
            ("remote.https://evil.example/.url", "https://evil.example/o/r.git"),
            ("remote.a/b.fetch", "+refs/heads/*:refs/remotes/a/*"),
            ("remote.evil.url", "https://github.com/evil/r.git"),
            ("core.sshCommand", "/tmp/evil"),
            ("core.hooksPath", "/tmp/evil-hooks"),
            ("core.gitProxy", "/tmp/evil"),
            ("include.path", "/tmp/evil.cfg"),
            ("credential.helper", "!echo pwned"),
            ("credential.useHttpPath", "true"),
            ("credential.username", "evil"),
            ("credential.https://github.com.helper", "!echo pwned"),
            ("core.askPass", "/tmp/evil"),
            ("core.fsmonitor", "/tmp/evil"),
            ("core.editor", "/tmp/evil"),
            ("protocol.ext.allow", "always"),
        ] {
            sh(&d, &["config", key, val]);
            assert!(!push_config_clean(cwd, &exp()), "{key} must refuse the push");
            sh(&d, &["config", "--unset", key]);
            assert!(push_config_clean(cwd, &exp()), "clean again after unsetting {key}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_push_path_has_no_token_header_include_or_temp_config() {
        // Source lock: whatever builds or runs `git push` (publish.rs from run_git_with to current_branch, and the
        // push command in lib.rs) never reads the keychain or writes an auth header, include or temp config file.
        let lib = include_str!("lib.rs");
        let pub_src = include_str!("publish.rs");
        let a = pub_src.find("pub fn run_git_with").unwrap();
        let b = pub_src.find("pub fn current_branch").unwrap();
        let push_a = lib.find("fn publish_push_blocking").unwrap();
        let push_b = lib.find("struct PrResult").unwrap();
        let bad = ["extra".to_string() + "header", "include".to_string() + ".path", "Authori".to_string() + "zation", "AuthInc".to_string() + "lude", "gh-push".to_string(), "GH_PAT_ACCOUNT".to_string(), "make_backend".to_string(), "credential.helper".to_string()];
        for (name, part) in [("publish.rs push half", &pub_src[a..b]), ("lib.rs push command", &lib[push_a..push_b])] {
            for w in &bad {
                // the doc comments may name what is absent; code lines may not
                let hit = part.lines().filter(|l| !l.trim_start().starts_with("//")).any(|l| l.contains(w.as_str()));
                assert!(!hit, "{name} must not mention {w}");
            }
        }
        assert!(!pub_src.contains(&("fn base".to_string() + "64(")), "the header encoder is gone");
        assert!(pub_src.contains("Bearer"), "the PAT is still used by the PR call");
        let open_pr_pos = pub_src.find("pub fn open_pr").unwrap();
        assert!(pub_src[..open_pr_pos].find("Bearer").is_none(), "the PAT appears only inside the PR call");
    }

    #[test]
    fn push_target_must_match_the_approved_repo_whatever_rewrites_it() {
        let root = tmp("tgt");
        let d = root.join("w");
        std::fs::create_dir_all(&d).unwrap();
        init_repo(&d);
        sh(&d, &["remote", "add", "origin", "https://github.com/o/r.git"]);
        let cwd = d.to_str().unwrap();
        let url = "https://github.com/o/r.git";
        assert!(push_target_matches(cwd, url, &exp()), "origin and the explicit url name the approved repository");
        assert!(!push_target_matches(cwd, url, &("o".into(), "other".into())));
        // a pushurl to another repository: no push
        sh(&d, &["config", "remote.origin.pushurl", "https://github.com/evil/r.git"]);
        assert!(!push_target_matches(cwd, url, &exp()), "origin's push URL points elsewhere");
        sh(&d, &["config", "--unset", "remote.origin.pushurl"]);
        // an insteadOf that rewrites the explicit url: no push
        sh(&d, &["config", "url.https://github.com/evil/r.git.insteadOf", url]);
        assert!(!push_target_matches(cwd, url, &exp()), "the explicit url is rewritten to another repository");
        sh(&d, &["config", "--unset", "url.https://github.com/evil/r.git.insteadOf"]);
        // the ssh form of the same repository is the same target
        sh(&d, &["config", "remote.origin.pushurl", "git@github.com:o/r.git"]);
        assert!(push_target_matches(cwd, url, &exp()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn classification_separates_network_from_git_auth_from_local_errors() {
        assert_eq!(classify_push_failure("ssh: connect to host github.com port 22: Connection timed out\nfatal: Could not read from remote repository."), PubErr::Network);
        assert_eq!(classify_push_failure("ssh: Could not resolve hostname github.com: Name or service not known\nfatal: Could not read from remote repository."), PubErr::Network);
        assert_eq!(classify_push_failure("ssh: connect to host github.com port 22: No route to host"), PubErr::Network);
        assert_eq!(classify_push_failure("ssh: connect to host github.com port 22: Connection refused"), PubErr::Network);
        assert_eq!(classify_push_failure("fatal: Could not read from remote repository."), PubErr::Unknown, "alone it says nothing about identity");
        assert_eq!(classify_push_failure("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository."), PubErr::GitAuth);
        assert_eq!(classify_push_failure("error: unable to create file x: Permission denied"), PubErr::Unknown, "a local file error is not an identity problem");
    }

    #[test]
    fn a_push_that_never_answers_is_killed_at_the_deadline() {
        // a loopback server that accepts and stays silent
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let _srv = std::thread::spawn(move || {
            let mut held = Vec::new();
            for _ in 0..2 {
                if let Ok((c, _)) = listener.accept() { held.push(c); }
            }
            std::thread::sleep(std::time::Duration::from_secs(30));
        });
        let root = tmp("hang");
        let d = root.join("w");
        std::fs::create_dir_all(&d).unwrap();
        init_repo(&d);
        sh(&d, &["checkout", "-q", "-b", "braavo/h"]);
        let url = format!("http://127.0.0.1:{port}/o/r.git");
        let t0 = std::time::Instant::now();
        let r = run_git_full(d.to_str().unwrap(), &["push", "--no-verify", &url, "braavo/h"], &[("GIT_CONFIG_NOSYSTEM", "1"), ("GIT_CONFIG_GLOBAL", NULL_CONFIG), ("NO_PROXY", "127.0.0.1"), ("no_proxy", "127.0.0.1")], None, Some(std::time::Duration::from_secs(2)));
        assert_eq!(r.err(), Some(PubErr::Network));
        assert!(t0.elapsed() < std::time::Duration::from_secs(15));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unreadable_config_is_not_clean() {
        let root = tmp("badcfg");
        let d = root.join("w");
        std::fs::create_dir_all(&d).unwrap();
        init_repo(&d);
        sh(&d, &["remote", "add", "origin", "https://github.com/o/r.git"]);
        let cwd = d.to_str().unwrap();
        assert!(push_config_clean(cwd, &exp()));
        let cfg = d.join(".git").join("config");
        let good = std::fs::read_to_string(&cfg).unwrap();
        std::fs::write(&cfg, format!("{good}[broken\n")).unwrap(); // git config exits 128 on a malformed file
        assert!(!push_config_clean(cwd, &exp()), "exit 128 is a read error, never 'clean'");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_push_without_git_credentials_fails_fast_and_is_classified_as_git_auth() {
        // A loopback http "remote" that always answers 401: git must not prompt (GIT_TERMINAL_PROMPT=0) and must not hang.
        use std::io::{Read as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let srv = std::thread::spawn(move || {
            for _ in 0..4 {
                if let Ok((mut c, _)) = listener.accept() {
                    let mut buf = [0u8; 4096];
                    let _ = c.read(&mut buf);
                    let _ = c.write_all(b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"x\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                }
            }
        });
        let root = tmp("noauth");
        let d = root.join("w");
        std::fs::create_dir_all(&d).unwrap();
        init_repo(&d);
        sh(&d, &["checkout", "-q", "-b", "braavo/n"]);
        let url = format!("http://127.0.0.1:{port}/o/r.git");
        let t0 = std::time::Instant::now();
        let o = run_git_with(d.to_str().unwrap(), &["push", "--no-verify", &url, "braavo/n"], &[("GIT_CONFIG_NOSYSTEM", "1"), ("GIT_CONFIG_GLOBAL", NULL_CONFIG), ("NO_PROXY", "127.0.0.1"), ("no_proxy", "127.0.0.1")], None).unwrap();
        assert!(!o.ok);
        assert!(t0.elapsed() < std::time::Duration::from_secs(20), "no prompt, no hang");
        assert_eq!(classify_push_failure(&o.stderr), PubErr::GitAuth, "{}", o.stderr);
        drop(srv);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)] // the hook is a /bin/sh script made executable with chmod
    #[test]
    fn guarded_push_checks_and_pushes_in_one_call_with_a_fresh_hooks_dir() {
        let root = tmp("guard");
        let (work, bare) = (root.join("w"), root.join("o.git"));
        std::fs::create_dir_all(&work).unwrap();
        std::fs::create_dir_all(&bare).unwrap();
        sh(&bare, &["init", "-q", "--bare", "-b", "main"]);
        init_repo(&work);
        sh(&work, &["checkout", "-q", "-b", "braavo/g"]);
        let marker = root.join("hook-ran");
        let hook = work.join(".git/hooks/pre-push");
        std::fs::write(&hook, format!("#!/bin/sh\ntouch {}\nexit 0\n", marker.display())).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let tmp_root = root.join("tmp");
        let (cwd, url) = (work.to_str().unwrap(), bare.to_str().unwrap());
        sh(&work, &["config", "credential.helper", "!echo pwned"]);
        assert_eq!(guarded_push_inner(cwd, url, "braavo/g", &tmp_root, false, PUSH_TIMEOUT).err(), Some(PubErr::UnsafeConfig), "a repo-level credential helper refuses the push");
        sh(&work, &["config", "--unset", "credential.helper"]);
        sh(&work, &["config", "http.proxy", "http://127.0.0.1:9"]);
        assert_eq!(guarded_push_inner(cwd, url, "braavo/g", &tmp_root, false, PUSH_TIMEOUT).err(), Some(PubErr::UnsafeConfig));
        sh(&work, &["config", "--unset", "http.proxy"]);
        assert_eq!(guarded_push_inner(cwd, url, "+x:y", &tmp_root, false, PUSH_TIMEOUT).err(), Some(PubErr::InvalidBranch));
        assert_eq!(guarded_push(cwd, url, "braavo/g", &tmp_root).err(), Some(PubErr::UnsafeConfig), "a target that is not the approved github.com repository is never pushed to");
        let o = guarded_push_inner(cwd, url, "braavo/g", &tmp_root, false, PUSH_TIMEOUT).unwrap();
        assert!(o.ok, "{}", o.stderr);
        assert!(!marker.exists(), "the repo's pre-push hook must not run on the push");
        assert_eq!(std::fs::read_dir(&tmp_root).unwrap().count(), 0, "the per-push hooks dir is deleted afterwards");
        let heads = Command::new("git").args(["branch", "--list"]).current_dir(&bare).output().unwrap();
        assert!(String::from_utf8_lossy(&heads.stdout).contains("braavo/g"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn temp_hooks_dir_is_private_and_unique() {
        let root = tmp("th");
        let (a, b) = (TempHooks::create(&root).unwrap(), TempHooks::create(&root).unwrap());
        assert_ne!(a.0, b.0);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&a.0).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let p = a.0.clone();
        drop(a);
        assert!(!p.exists());
        let _ = std::fs::remove_dir_all(&root);
    }
    #[test]
    fn push_failure_ignores_numbers_in_urls_and_non_git_lines() {
        // a repository literally named app404 / a 403 inside a URL must not decide the class
        assert_eq!(classify_push_failure("fatal: unable to access 'https://github.com/o/app404.git/': Could not resolve host: github.com"), PubErr::Network);
        assert_eq!(classify_push_failure("remote: Permission to o/app403.git denied to u.\nfatal: unable to access 'https://github.com/o/app403.git/': The requested URL returned error: 403"), PubErr::GitAuth);
        assert_eq!(classify_push_failure(" ! [rejected]        braavo/x404 -> braavo/x404 (non-fast-forward)"), PubErr::PushRejected);
        assert_eq!(classify_push_failure("fatal: could not read from https://github.com/o/r401/info"), PubErr::Unknown);
        assert_eq!(classify_push_failure("hint: tried 404 times 403 401"), PubErr::Unknown, "hint lines are not diagnostics");
        assert_eq!(classify_push_failure("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 404"), PubErr::GitAuth);
        assert!(has_status_code("returned error: 403", "403") && !has_status_code("o/app403.git", "403") && !has_status_code("v1.403", "403"));
    }

    #[test]
    fn canonical_order_is_byte_order_and_stable_for_any_input_order() {
        let a = vec!["src/z.ts".to_string(), "README.md".to_string(), "src/a.ts".to_string(), "ü.txt".to_string(), "src/a.ts".to_string(), "Z.md".to_string()];
        let mut b = a.clone();
        b.reverse();
        let ca = canonical_files(a);
        assert_eq!(ca, canonical_files(b));
        assert_eq!(ca, vec!["README.md", "Z.md", "src/a.ts", "src/z.ts", "ü.txt"]);
    }

    #[test]
    fn stale_hooks_dirs_are_swept_but_nothing_else() {
        let d = tmp("sweep");
        std::fs::create_dir_all(d.join("hooks-1-2")).unwrap();
        std::fs::write(d.join("keep.txt"), "x").unwrap();
        sweep_stale(&d, std::time::Duration::from_secs(3600));
        assert!(d.join("hooks-1-2").exists(), "a fresh dir is not swept when min_age is large");
        sweep_stale(&d, std::time::Duration::ZERO);
        assert!(!d.join("hooks-1-2").exists());
        assert!(d.join("keep.txt").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn commit_from_a_subfolder_and_from_detached_head() {
        let d = tmp("sub");
        init_repo(&d);
        std::fs::create_dir_all(d.join("pkg")).unwrap();
        std::fs::write(d.join("pkg/x.ts"), "x").unwrap();
        let root = repo_root(d.join("pkg").to_str().unwrap()).unwrap();
        assert_eq!(std::fs::canonicalize(&root).unwrap(), std::fs::canonicalize(&d).unwrap());
        commit_on_new_branch(&root, "braavo/sub", "t", "", &["pkg/x.ts".to_string()]).unwrap();
        // detached HEAD + failing commit goes back to the same commit and drops the new branch
        sh(&d, &["checkout", "-q", "--detach", "main"]);
        // a failing hook is a /bin/sh script: unix only; elsewhere an invalid identity makes the commit fail the same way
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let hook = d.join(".git/hooks/pre-commit");
            std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        #[cfg(not(unix))]
        {
            sh(&d, &["config", "user.useConfigOnly", "true"]);
            sh(&d, &["config", "--unset", "user.email"]);
        }
        std::fs::write(d.join("a.txt"), "changed\n").unwrap();
        let before = Command::new("git").args(["rev-parse", "HEAD"]).current_dir(&d).output().unwrap().stdout;
        assert!(commit_on_new_branch(d.to_str().unwrap(), "braavo/det", "t", "", &["a.txt".to_string()]).is_err());
        assert_eq!(Command::new("git").args(["rev-parse", "HEAD"]).current_dir(&d).output().unwrap().stdout, before);
        assert_eq!(current_branch(d.to_str().unwrap()), None, "still detached");
        let l = Command::new("git").args(["branch", "--list", "braavo/det"]).current_dir(&d).output().unwrap();
        assert!(l.stdout.is_empty());
        assert_eq!(classify_http(301, ""), PubErr::NotFound);
        let _ = std::fs::remove_dir_all(&d);
    }
}
