//! BRA-UI-11: open a release page in the system browser (manual install; there is no updater).
//!
//! The only caller is the "Download" button of the new-version banner. The URL must be a plain
//! https link under the project's own GitHub account; nothing else is ever opened. The process is
//! started with a fixed argv (no shell), so the URL is one argument and cannot be read as a command.

use std::process::Command;

/// Every opened link must start with this prefix (the project's GitHub account).
pub const ALLOWED_PREFIX: &str = "https://github.com/kocakkmustafa/";

/// True for a short, plain https URL under [`ALLOWED_PREFIX`]: printable ASCII only, no spaces,
/// quotes, backslashes, angle brackets, userinfo and no `..` path step.
pub fn release_url_ok(url: &str) -> bool {
    if url.len() <= ALLOWED_PREFIX.len() || url.len() > 300 || !url.starts_with(ALLOWED_PREFIX) {
        return false;
    }
    let rest = &url[ALLOWED_PREFIX.len()..];
    if rest.contains("..") || rest.contains('@') {
        return false;
    }
    url.bytes().all(|b| b.is_ascii_graphic() && !matches!(b, b'"' | b'\\' | b'<' | b'>' | b'`' | b'^' | b'{' | b'}' | b'|'))
}

/// Open `url` in the default browser. Refuses anything [`release_url_ok`] refuses.
pub fn open_in_browser(url: &str) -> Result<(), String> {
    if !release_url_ok(url) {
        return Err("this link cannot be opened".into());
    }
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("/usr/bin/open");
        c.arg(url);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", url]);
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_https_links_under_the_project_account() {
        assert!(release_url_ok("https://github.com/kocakkmustafa/braavolabs-desktop/releases/tag/v1.2.0"));
        assert!(release_url_ok("https://github.com/kocakkmustafa/braavolabs-desktop/releases"));
        for bad in [
            "",
            "https://github.com/kocakkmustafa/",
            "http://github.com/kocakkmustafa/braavolabs-desktop",
            "https://github.com/other/braavolabs-desktop",
            "https://github.com.evil.example/kocakkmustafa/x",
            "https://github.com/kocakkmustafa/../evil/x",
            "https://github.com/kocakkmustafa/x y",
            "https://github.com/kocakkmustafa/x\\y",
            "https://github.com/kocakkmustafa/x\"y",
            "https://github.com/kocakkmustafa/x\ny",
            "https://github.com/kocakkmustafa/x@evil.example",
            "HTTPS://github.com/kocakkmustafa/x",
            "https://GITHUB.COM/kocakkmustafa/x",
            "https://github.com/KocakKMustafa/x",
            "https://github.com@evil.example/kocakkmustafa/x",
            "https://github.com:443@evil.example/kocakkmustafa/x",
            "https://github.com.evil.example/kocakkmustafa/x",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "-https://github.com/kocakkmustafa/x",
        ] {
            assert!(!release_url_ok(bad), "{bad:?}");
        }
        assert!(!release_url_ok(&format!("{ALLOWED_PREFIX}{}", "a".repeat(300))));
    }

    #[test]
    fn open_refuses_a_disallowed_link_before_starting_anything() {
        assert!(open_in_browser("https://example.com/").is_err());
        assert!(open_in_browser("https://github.com/kocakkmustafa/x y").is_err());
    }
}
