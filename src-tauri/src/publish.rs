//! BRA-UI-10 "Yayına hazırla" — the host half of the publish flow (default OFF in the UI).
//!
//! Deliberately NOT a general git or HTTP bridge. Three governed actions, each with fixed argv and
//! a one-time approval token bound to its exact fields (see `lib.rs`):
//!   * `git.commit` — `git switch -c <branch>`, `git add -- <changed files>`, `git commit`
//!   * `git.push`   — `git push -u origin <branch>` (never force, never delete, never a refspec)
//!   * `github.pr`  — `POST /repos/{owner}/{repo}/pulls` on api.github.com with the user's own PAT
//!
//! The PAT lives only in the OS keychain. It is read here, inside the host, for exactly two uses
//! (a 0600 git config include for the push, a stdin curl config for the PR) and is never returned
//! to the webview, logged, put in argv, or put in an error string. Errors cross the boundary as
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
    // exactly: push <the verified explicit URL> <branch>. Never the `origin` name: its URL, pushurl and any
    // insteadOf rewrite live in repo config the user's tooling (or a hostile repo) controls.
    !(a.len() == 3 && a[0] == "push" && a[1] == expected_url && is_valid_branch(a[2]))
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

// ── base64 (header only; no crate) ───────────────────────────────────────────

pub fn base64(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for c in input.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

// ── git ──────────────────────────────────────────────────────────────────────

pub struct GitOut {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Run `git` with fixed args (no shell), never prompting. `extra_env` carries nothing secret.
pub fn run_git(cwd: &str, args: &[&str], include: Option<&Path>) -> Result<GitOut, PubErr> {
    run_git_with(cwd, args, include, &[], false)
}

#[cfg(windows)]
const NULL_CONFIG: &str = "NUL";
#[cfg(not(windows))]
const NULL_CONFIG: &str = "/dev/null";

/// `hardened` is for the push that carries the token: repo-level config must not be able to redirect the
/// target, weaken TLS, add a proxy, run a hook or an ssh command, and the system/global config and
/// proxy environment are not consulted. `extra_env` carries nothing secret.
pub fn run_git_with(cwd: &str, args: &[&str], include: Option<&Path>, extra_env: &[(&str, &str)], hardened: bool) -> Result<GitOut, PubErr> {
    let mut cmd = Command::new("git");
    if hardened {
        for c in ["http.sslVerify=true", "http.proxy=", "core.hooksPath=/dev/null", "core.sshCommand=ssh", "credential.helper=", "http.followRedirects=false"] {
            cmd.arg("-c").arg(c);
        }
        cmd.env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_CONFIG_GLOBAL", NULL_CONFIG);
        for v in ["GIT_SSL_NO_VERIFY", "http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy", "GIT_SSH_COMMAND", "GIT_PROXY_COMMAND"] {
            cmd.env_remove(v);
        }
    }
    if let Some(p) = include {
        cmd.arg("-c").arg(format!("include.path={}", p.display()));
        cmd.arg("-c").arg("credential.helper=");
    }
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let out = cmd
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_EDITOR", "true")
        .stdin(Stdio::null())
        .output()
        .map_err(|_| PubErr::Unknown)?;
    Ok(GitOut {
        ok: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
    })
}

/// True only when git, with repo/global/system config neutralised and then with the repo's own config, resolves the
/// explicit push URL to itself: a `url.<x>.insteadOf` / `pushInsteadOf` rewrite in the repo would send the push (and
/// the token) elsewhere, so any difference refuses the push.
pub fn push_url_unrewritten(cwd: &str, url: &str) -> bool {
    match run_git_with(cwd, &["ls-remote", "--get-url", url], None, &[], true) {
        Ok(o) if o.ok && o.stdout.trim() == url => {}
        _ => return false,
    }
    // `ls-remote --get-url` ignores pushInsteadOf, so ANY url.*.insteadOf / pushInsteadOf in the repo's own config
    // refuses the push (exit 1 = no such key). Global/system config is not read on the hardened push, so it cannot matter.
    matches!(run_git_with(cwd, &["config", "--get-regexp", r"^url\..*\.(push)?insteadof$"], None, &[], true), Ok(o) if !o.ok && o.stdout.trim().is_empty())
}

pub fn current_branch(cwd: &str) -> Option<String> {
    let o = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"], None).ok()?;
    let b = o.stdout.trim().to_string();
    (o.ok && !b.is_empty() && b != "HEAD").then_some(b)
}

pub fn origin_remote(cwd: &str) -> Option<(String, String, bool)> {
    let o = run_git(cwd, &["remote", "get-url", "origin"], None).ok()?;
    if !o.ok {
        return None;
    }
    parse_github_remote(o.stdout.trim())
}

/// The repository's default branch (what a PR targets). Falls back to `main`.
pub fn default_base(cwd: &str) -> String {
    if let Ok(o) = run_git(cwd, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], None) {
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

/// Classify a failed `git push`.
pub fn classify_push_failure(stderr: &str) -> PubErr {
    let s = stderr.to_ascii_lowercase();
    if s.contains("could not resolve host") || s.contains("unable to access") && (s.contains("timed out") || s.contains("resolve") || s.contains("connect")) || s.contains("network is unreachable") || s.contains("connection refused") {
        PubErr::Network
    } else if s.contains("401") || s.contains("bad credentials") || s.contains("authentication failed") || s.contains("invalid username or password") {
        PubErr::Unauthorized
    } else if s.contains("403") || s.contains("permission to") || s.contains("permission denied") || s.contains("write access") {
        PubErr::NoWriteAccess
    } else if s.contains("repository not found") || s.contains("404") {
        PubErr::NotFound
    } else if s.contains("non-fast-forward") || s.contains("fetch first") || s.contains("[rejected]") || s.contains("protected branch") || s.contains("hook declined") || s.contains("denied to") {
        PubErr::PushRejected
    } else {
        PubErr::Unknown
    }
}

/// The commit half, after approval: `git switch -c`, `git add -- <files>`, `git commit`. Returns the short SHA.
/// On a failure after the switch it goes back to the previous branch and removes the new one with the safe `-d`.
pub fn commit_on_new_branch(cwd: &str, branch: &str, title: &str, body: &str, files: &[String]) -> Result<String, PubErr> {
    let prev = current_branch(cwd);
    let sw = run_git(cwd, &["switch", "-c", branch], None)?;
    if !sw.ok {
        return Err(classify_commit_failure(&sw.stderr));
    }
    let undo = || {
        if let Some(p) = &prev {
            if run_git(cwd, &["switch", p], None).map(|o| o.ok).unwrap_or(false) {
                let _ = run_git(cwd, &["branch", "-d", branch], None);
            }
        }
    };
    // Literal pathspecs: a changed file named `:(top)x` or `*.ts` is that file, never pathspec magic or a glob.
    let mut add: Vec<&str> = vec!["--literal-pathspecs", "add", "--"];
    add.extend(files.iter().map(|s| s.as_str()));
    match run_git_with(cwd, &add, None, &[("GIT_LITERAL_PATHSPECS", "1")], false) {
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
    match run_git(cwd, &commit, None) {
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
    Ok(run_git(cwd, &["rev-parse", "--short", "HEAD"], None).map(|o| o.stdout.trim().to_string()).unwrap_or_default())
}

/// A 0600 git config include holding the auth header for one push; removed on drop.
pub struct AuthInclude {
    path: std::path::PathBuf,
}
impl AuthInclude {
    pub fn create(dir: &Path, pat: &str, tag: &str) -> Result<Self, PubErr> {
        let path = dir.join(format!("gh-push-{tag}.cfg"));
        let b64 = base64(format!("x-access-token:{}", pat.trim()).as_bytes());
        let body = format!("[http \"https://github.com/\"]\n\textraheader = Authorization: Basic {b64}\n");
        #[cfg(unix)]
        let f = {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path)
        };
        #[cfg(not(unix))]
        let f = std::fs::OpenOptions::new().write(true).create_new(true).open(&path);
        let mut f = f.map_err(|_| PubErr::Unknown)?;
        let guard = AuthInclude { path };
        f.write_all(body.as_bytes()).map_err(|_| PubErr::Unknown)?;
        Ok(guard)
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
}
impl Drop for AuthInclude {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
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
        404 => PubErr::NotFound,
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
    let mut child = Command::new(curl_bin())
        .args(["--config", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| PubErr::Network)?;
    child.stdin.take().ok_or(PubErr::Unknown)?.write_all(cfg.as_bytes()).map_err(|_| PubErr::Unknown)?;
    let mut out = String::new();
    child.stdout.take().ok_or(PubErr::Unknown)?.take(1 << 20).read_to_string(&mut out).map_err(|_| PubErr::Network)?;
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
        assert!(!push_argv_denied(&a(&["push", &url, "braavo/x"]), &url));
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
    fn base64_matches_rfc4648() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
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
        assert_eq!(classify_push_failure("remote: Permission to o/r.git denied to u.\nfatal: unable to access '...': The requested URL returned error: 403"), PubErr::NoWriteAccess);
        assert_eq!(classify_push_failure("fatal: Authentication failed for 'https://github.com/o/r.git/'"), PubErr::Unauthorized);
        assert_eq!(classify_push_failure(" ! [rejected]        x -> x (non-fast-forward)"), PubErr::PushRejected);
        assert_eq!(classify_push_failure("remote: error: GH006: Protected branch update failed"), PubErr::PushRejected);
        assert_eq!(classify_commit_failure("fatal: a branch named 'x' already exists"), PubErr::BranchExists);
        assert_eq!(classify_commit_failure("*** Please tell me who you are."), PubErr::Identity);
        for c in [PubErr::NoPat, PubErr::Network, PubErr::Unauthorized, PubErr::SecretFile] {
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

    #[test]
    fn auth_include_is_0600_holds_no_token_in_the_path_and_is_removed() {
        let dir = std::env::temp_dir().join(format!("bv-pub-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p;
        {
            let inc = AuthInclude::create(&dir, "ghp_TESTTOKEN0123456789abcdefghijklmnop", "t1").unwrap();
            p = inc.path().to_path_buf();
            assert!(!p.to_string_lossy().contains("ghp_"));
            assert!(std::fs::read_to_string(&p).unwrap().contains("extraheader"));
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
            }
        }
        assert!(!p.exists(), "temp config removed on drop");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn sh(cwd: &Path, args: &[&str]) {
        let o = Command::new("git").args(args).current_dir(cwd).env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap();
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
        let o = run_git(cwd, &["push", "-u", "origin", "braavo/x"], None).unwrap();
        assert!(o.ok, "{}", o.stderr);
        let heads = Command::new("git").args(["branch", "--list"]).current_dir(&bare).output().unwrap();
        assert!(String::from_utf8_lossy(&heads.stdout).contains("braavo/x"));
        let _ = std::fs::remove_dir_all(&root);
    }

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
        std::fs::write(d.join("*.ts"), "star").unwrap();
        std::fs::write(d.join("other.ts"), "other").unwrap();
        std::fs::write(d.join("[id].tsx"), "bracket").unwrap();
        let cwd = d.to_str().unwrap();
        commit_on_new_branch(cwd, "braavo/lit", "t", "", &["*.ts".to_string(), "[id].tsx".to_string()]).unwrap();
        let tracked = Command::new("git").args(["ls-files"]).current_dir(&d).output().unwrap();
        let t = String::from_utf8_lossy(&tracked.stdout).to_string();
        assert!(t.contains("*.ts") && t.contains("[id].tsx"), "{t}");
        assert!(!t.contains("other.ts"), "a glob name must not pull in other files: {t}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn push_url_is_refused_when_repo_config_rewrites_it() {
        let d = tmp("rewrite");
        init_repo(&d);
        let cwd = d.to_str().unwrap();
        let url = push_url("o", "r", true);
        assert!(push_url_unrewritten(cwd, &url));
        sh(&d, &["config", "url.https://evil.example/.insteadOf", "https://github.com/"]);
        assert!(!push_url_unrewritten(cwd, &url), "insteadOf rewrite must be refused");
        sh(&d, &["config", "--unset", "url.https://evil.example/.insteadOf"]);
        sh(&d, &["config", "url.https://evil.example/.pushInsteadOf", "https://github.com/"]);
        assert!(!push_url_unrewritten(cwd, &url), "pushInsteadOf rewrite must be refused");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn hardened_push_ignores_repo_hooks_and_proxy_config() {
        let root = tmp("hard");
        let (work, bare) = (root.join("w"), root.join("o.git"));
        std::fs::create_dir_all(&work).unwrap();
        std::fs::create_dir_all(&bare).unwrap();
        sh(&bare, &["init", "-q", "--bare", "-b", "main"]);
        init_repo(&work);
        let marker = root.join("hook-ran");
        let hook = work.join(".git/hooks/pre-push");
        std::fs::write(&hook, format!("#!/bin/sh\ntouch {}\nexit 0\n", marker.display())).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        sh(&work, &["config", "http.proxy", "http://127.0.0.1:9"]);
        let o = run_git_with(work.to_str().unwrap(), &["push", bare.to_str().unwrap(), "main"], None, &[], true).unwrap();
        assert!(o.ok, "{}", o.stderr);
        assert!(!marker.exists(), "pre-push hook must not run on the hardened push");
        let _ = std::fs::remove_dir_all(&root);
    }
}
