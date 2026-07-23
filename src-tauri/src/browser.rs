//! Lane-C governed CDP browser HOST — the Rust half of the governed
//! computer-control surface. `src/browser.ts` is the pure, unit-tested webview
//! core (the action model + `browserActionToGate` redacted summaries + the
//! `governedBrowser` chokepoint); THIS module is the real `BrowserDriver` that
//! core INJECTS — a Chrome DevTools Protocol (CDP) client the webview physically
//! cannot be: it opens a TCP/WebSocket connection to a browser's DevTools
//! endpoint and drives a page, host-side.
//!
//! The security shape mirrors `governed_command` / `pty_spawn` (the other
//! host-side chokepoints):
//!   * An action drives a page ONLY on an approved, one-time governance token the
//!     host spends (`try_consume_token`) — a compromised webview that skips the
//!     gate hands over a token that fails to consume, so nothing runs.
//!   * The non-http(s) navigation HARD-DENY is re-checked HOST-side BEFORE the
//!     token is spent (see lib.rs `browser_dispatch`). This is LOAD-BEARING:
//!     production `createTauriGovernance.request()` delegates straight to the Rust
//!     `classify`, so the TS `isSafeHttpUrl` never runs there — the host copy is
//!     the real enforcement (the exact lesson from the pty dangerous-flag deny).
//!   * The audit trail carries ONLY the op + (for navigate) the URL — never the
//!     raw typed value (it may be a password) or eval JS (arbitrary code); those
//!     reach the CDP driver SEPARATELY and never touch the ledger.
//!
//! The `#[tauri::command]` wiring (token spend, connection registry, audit) lives
//! in lib.rs where the governance state is owned; this module holds the reusable,
//! headlessly-testable pieces: the pure `is_safe_http_url` (byte-parity mirror of
//! governance.ts), the DevTools endpoint discovery, and the async CDP connection
//! that actually navigates / reads / interacts / evals a page.
//!
//! ## CDP model (why these domains/methods)
//! A DevTools endpoint exposes an HTTP discovery URL (`http://127.0.0.1:<port>/json`)
//! listing per-page WebSocket targets, and a JSON-RPC-ish protocol over each
//! target's WebSocket: `{id, method, params}` requests, `{id, result|error}`
//! responses, and id-less `{method, params}` events. We enable `Page` + `Runtime`
//! and drive:
//!   * navigate → `Page.navigate` + wait for `Page.loadEventFired`, then read the
//!     final `location.href`;
//!   * read     → `Page.captureScreenshot` (data-uri) · `document.documentElement
//!     .outerHTML` (dom) · `location.href` (url) via `Runtime.evaluate`;
//!   * interact → `Runtime.evaluate` of a snippet that `querySelector`s the target
//!     and clicks/types/scrolls/selects it (selector+value embedded as JSON string
//!     literals — no injection seam);
//!   * eval     → `Runtime.evaluate(js, returnByValue, awaitPromise)`.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

/// Upper bound for a single CDP request→response round-trip. Generous (page
/// operations can be slow) but bounded so a wedged endpoint can't hang a command.
const CDP_TIMEOUT: Duration = Duration::from_secs(30);
/// How long to wait for `Page.loadEventFired` after a navigate before reading the
/// final URL anyway. NON-fatal: a page that never fires load (or already fired it)
/// still yields its `location.href`.
const LOAD_TIMEOUT: Duration = Duration::from_secs(10);
/// Bound on the DevTools HTTP discovery fetch so a non-responding port can't hang.
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

// ── non-http(s) hard-deny (byte-parity mirror of governance.ts isSafeHttpUrl) ──

/// ONLY http/https navigations are ever approvable. Everything else — file://
/// (read local disk), javascript: (script injection), data: (inline payload),
/// chrome://, chrome-extension://, about: (privileged/internal surfaces) — is
/// denied, so a browser-control agent cannot pivot off the web into the local
/// machine or the browser's own internals. An unparseable / scheme-less string
/// fails closed (false).
///
/// LOAD-BEARING host-side copy: production `createTauriGovernance.request()`
/// delegates straight to the Rust `classify`, so the TS `isSafeHttpUrl` never runs
/// there — this is the real enforcement point (same lesson as the pty
/// dangerous-flag hard-deny). Deliberately STRICTER than `new URL()` on exotic
/// inputs (e.g. an embedded tab/newline the WHATWG parser would strip): the
/// stricter direction is the safe one for a deny gate. The documented parity cases
/// (http/https true; file/javascript/data/chrome/chrome-extension/about false;
/// empty/malformed false) match `new URL()` exactly.
pub fn is_safe_http_url(url: Option<&str>) -> bool {
    let raw = match url {
        Some(u) => u,
        None => return false,
    };
    // WHATWG URL strips leading/trailing C0-control-or-space before parsing; mirror
    // that so " http://x" is judged on its scheme, not the leading space.
    let trimmed = raw.trim_matches(|c: char| c <= ' ');
    // The scheme is the run before the first ':'. No ':' ⇒ not an absolute URL
    // (a bare "example.com" throws in `new URL`) ⇒ fail-closed.
    let scheme = match trimmed.split_once(':') {
        Some((s, _)) => s,
        None => return false,
    };
    // A valid URL scheme is ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ). Anything
    // else in the "scheme" slot (a space, a slash, an empty run) means it was never
    // a scheme at all → fail-closed.
    let mut chars = scheme.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) {
        return false;
    }
    let lower = scheme.to_ascii_lowercase();
    lower == "http" || lower == "https"
}

// ── DevTools endpoint discovery ───────────────────────────────────────────────

/// Discover a page target's WebSocket debugger URL from a DevTools HTTP endpoint
/// on `127.0.0.1:<port>`. Fetches `/json` (the target list) and picks a page
/// target's `webSocketDebuggerUrl`. Host is HARD-CODED to loopback — this never
/// reaches out beyond the local machine.
pub async fn discover_ws_endpoint(port: u16) -> Result<String, String> {
    let body = http_get_json(port, "/json").await?;
    pick_page_ws_url(&body).ok_or_else(|| "no CDP page target found on the DevTools endpoint".into())
}

/// Minimal loopback HTTP/1.1 GET returning the response body. Hand-rolled over a
/// TCP stream (same dependency-frugal spirit as the regex-free `redact` and the
/// dependency-free base64) rather than pulling a full HTTP client for one request.
/// Chrome's DevTools HTTP server keeps the socket alive (it ignores `Connection:
/// close`) and always sends a `Content-Length`, so we read the headers, then
/// exactly that many body bytes — a `read_to_end` here would block forever on the
/// kept-alive connection. Wrapped in a timeout so a non-responding port can't hang.
async fn http_get_json(port: u16, path: &str) -> Result<String, String> {
    let fut = async {
        let mut stream = TcpStream::connect(("127.0.0.1", port))
            .await
            .map_err(|e| format!("CDP HTTP connect failed: {e}"))?;
        let req = format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(req.as_bytes()).await.map_err(|e| e.to_string())?;

        // 1. Read until the end of the headers (CRLF CRLF).
        let mut buf: Vec<u8> = Vec::new();
        let mut tmp = [0u8; 4096];
        let header_end = loop {
            if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
                break pos + 4;
            }
            if buf.len() > 1 << 20 {
                return Err("CDP HTTP headers too large".into());
            }
            let n = stream.read(&mut tmp).await.map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("CDP HTTP closed before headers".into());
            }
            buf.extend_from_slice(&tmp[..n]);
        };

        // 2. Honour Content-Length (Chrome always sends it). Absent ⇒ read to EOF
        //    (bounded by the outer timeout) as a best-effort fallback.
        let header_text = String::from_utf8_lossy(&buf[..header_end]).into_owned();
        let mut body = buf[header_end..].to_vec();
        match parse_content_length(&header_text) {
            Some(len) => {
                while body.len() < len {
                    let n = stream.read(&mut tmp).await.map_err(|e| e.to_string())?;
                    if n == 0 {
                        break;
                    }
                    body.extend_from_slice(&tmp[..n]);
                }
                body.truncate(len.min(body.len()));
            }
            None => loop {
                let n = stream.read(&mut tmp).await.map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                body.extend_from_slice(&tmp[..n]);
            },
        }
        Ok::<String, String>(String::from_utf8_lossy(&body).into_owned())
    };
    match tokio::time::timeout(HTTP_TIMEOUT, fut).await {
        Ok(r) => r,
        Err(_) => Err("CDP HTTP discovery timed out".into()),
    }
}

/// First index of `needle` in `haystack` (small, dependency-free — used only to
/// find the header terminator in a short DevTools response).
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Parse the `Content-Length` from raw header text (case-insensitive header name,
/// tolerant of a missing space after the colon — Chrome sends `Content-Length:2108`).
fn parse_content_length(headers: &str) -> Option<usize> {
    headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.trim().eq_ignore_ascii_case("content-length") {
            value.trim().parse::<usize>().ok()
        } else {
            None
        }
    })
}

/// Extract a page target's WebSocket debugger URL from a `/json` response body.
/// Pure (so it is unit-tested with a static string): slices out the JSON array
/// (robust against HTTP headers / trailing chunk markers around it), prefers a
/// `"type":"page"` target, and falls back to any target exposing a
/// `webSocketDebuggerUrl`.
pub fn pick_page_ws_url(body: &str) -> Option<String> {
    // A `webSocketDebuggerUrl` never contains an unescaped ']', so first-'[' to
    // last-']' isolates the array even if HTTP headers or chunk terminators frame it.
    let start = body.find('[')?;
    let end = body.rfind(']')?;
    if end < start {
        return None;
    }
    let arr: Value = serde_json::from_str(&body[start..=end]).ok()?;
    let targets = arr.as_array()?;
    // Prefer an actual page target…
    for t in targets {
        if t.get("type").and_then(Value::as_str) == Some("page") {
            if let Some(u) = t.get("webSocketDebuggerUrl").and_then(Value::as_str) {
                return Some(u.to_string());
            }
        }
    }
    // …else any target that exposes a ws debugger url.
    targets
        .iter()
        .find_map(|t| t.get("webSocketDebuggerUrl").and_then(Value::as_str).map(str::to_string))
}

// ── the CDP connection ────────────────────────────────────────────────────────

/// A live CDP session over one page target's WebSocket. Owns the socket + a
/// monotonic request-id counter. Not `Clone` — there is at most one active
/// connection, taken out of the host state for the duration of a dispatch.
pub struct CdpConnection {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    id: u64,
}

impl CdpConnection {
    /// Connect to a `ws://` / `wss://` DevTools page target and enable the domains
    /// we drive. Enabling `Page`/`Runtime` twice is harmless, so failures here are
    /// tolerated — the per-action methods surface any real protocol error.
    pub async fn connect(ws_url: &str) -> Result<Self, String> {
        let (ws, _resp) = connect_async(ws_url)
            .await
            .map_err(|e| format!("CDP connect failed: {e}"))?;
        let mut conn = CdpConnection { ws, id: 0 };
        let _ = conn.send("Page.enable", json!({})).await;
        let _ = conn.send("Runtime.enable", json!({})).await;
        Ok(conn)
    }

    /// Send one CDP command and return its `result`, skipping interleaved events /
    /// other-id responses until the matching id arrives (or the timeout elapses).
    /// A CDP `error` object becomes an `Err` — a protocol/transport failure the
    /// caller treats as invalidating the session.
    async fn send(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.id += 1;
        let id = self.id;
        let payload = json!({ "id": id, "method": method, "params": params });
        self.ws
            .send(Message::Text(payload.to_string()))
            .await
            .map_err(|e| format!("CDP send failed: {e}"))?;

        let deadline = tokio::time::Instant::now() + CDP_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(format!("CDP method {method} timed out"));
            }
            let frame = match tokio::time::timeout(remaining, self.ws.next()).await {
                Ok(Some(Ok(m))) => m,
                Ok(Some(Err(e))) => return Err(format!("CDP stream error: {e}")),
                Ok(None) => return Err("CDP stream closed".into()),
                Err(_) => return Err(format!("CDP method {method} timed out")),
            };
            let text = match frame {
                Message::Text(t) => t,
                Message::Close(_) => return Err("CDP connection closed".into()),
                // Ping/Pong/Binary/Frame carry no protocol response — keep reading.
                _ => continue,
            };
            let v: Value = match serde_json::from_str(&text) {
                Ok(v) => v,
                Err(_) => continue, // non-JSON line — ignore
            };
            if v.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(err) = v.get("error") {
                    let msg = err.get("message").and_then(Value::as_str).unwrap_or("CDP error");
                    return Err(format!("CDP {method} error: {msg}"));
                }
                return Ok(v.get("result").cloned().unwrap_or(Value::Null));
            }
            // an event or a different id — keep reading until our response arrives.
        }
    }

    /// Navigate to `url` and return the resulting `location.href`. Waits
    /// (best-effort) for `Page.loadEventFired` so the read reflects the new page.
    /// NOTE: the driver itself does NOT restrict the scheme — the non-http(s)
    /// hard-deny is a GOVERNANCE concern enforced in `browser_dispatch` before the
    /// token is spent (this raw method is also what the headless smoke test drives
    /// against a `data:` URL, deliberately below the gate).
    pub async fn navigate(&mut self, url: &str) -> Result<String, String> {
        let res = self.send("Page.navigate", json!({ "url": url })).await?;
        if let Some(err) = res.get("errorText").and_then(Value::as_str) {
            if !err.is_empty() {
                return Err(format!("navigation failed: {err}"));
            }
        }
        self.wait_for_load().await;
        self.current_url().await
    }

    /// Read events until `Page.loadEventFired` or `LOAD_TIMEOUT`. Non-fatal: a page
    /// that already fired (or never fires) load simply falls through to the URL read.
    async fn wait_for_load(&mut self) {
        let deadline = tokio::time::Instant::now() + LOAD_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return;
            }
            match tokio::time::timeout(remaining, self.ws.next()).await {
                Ok(Some(Ok(Message::Text(t)))) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&t) {
                        if v.get("method").and_then(Value::as_str) == Some("Page.loadEventFired") {
                            return;
                        }
                    }
                }
                Ok(Some(Ok(_))) => continue, // non-text frame — keep waiting
                _ => return,                 // stream end / error / timeout — give up (non-fatal)
            }
        }
    }

    /// The page's current URL (`location.href`).
    pub async fn current_url(&mut self) -> Result<String, String> {
        self.eval_string("location.href").await
    }

    /// The page's serialized DOM (`document.documentElement.outerHTML`). Simpler
    /// than DOM.getDocument + DOM.getOuterHTML and returns the same text.
    pub async fn dom(&mut self) -> Result<String, String> {
        self.eval_string("document.documentElement.outerHTML").await
    }

    /// A full-page PNG screenshot as a `data:image/png;base64,…` URI.
    pub async fn screenshot(&mut self) -> Result<String, String> {
        let res = self.send("Page.captureScreenshot", json!({ "format": "png" })).await?;
        let data = res
            .get("data")
            .and_then(Value::as_str)
            .ok_or("screenshot returned no data")?;
        Ok(format!("data:image/png;base64,{data}"))
    }

    /// Evaluate arbitrary JS in the page and return its by-value result. A thrown
    /// exception becomes an `Err` (the highest-risk op, but still governed: this
    /// method only runs after `browser_dispatch` has spent a `browser.eval` token).
    pub async fn eval(&mut self, js: &str) -> Result<Value, String> {
        let res = self
            .send(
                "Runtime.evaluate",
                json!({ "expression": js, "returnByValue": true, "awaitPromise": true }),
            )
            .await?;
        if let Some(exc) = res.get("exceptionDetails") {
            let txt = exc
                .get("exception")
                .and_then(|e| e.get("description"))
                .and_then(Value::as_str)
                .or_else(|| exc.get("text").and_then(Value::as_str))
                .unwrap_or("evaluation threw");
            return Err(format!("eval exception: {txt}"));
        }
        Ok(res
            .get("result")
            .and_then(|r| r.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }

    /// `eval` a snippet whose result is a string; a non-string result is stringified
    /// (defensive — the callers here always evaluate string expressions).
    async fn eval_string(&mut self, js: &str) -> Result<String, String> {
        match self.eval(js).await? {
            Value::String(s) => Ok(s),
            other => Ok(other.to_string()),
        }
    }

    /// Click / type / scroll / select the element matching `selector`. The selector
    /// and value are embedded as JSON string LITERALS (`serde_json::to_string`),
    /// which are valid JS string literals — so a hostile selector/value cannot break
    /// out of the snippet (no injection seam). The RAW value is used HERE and never
    /// enters the governance/audit layer. Returns `{ok:true}` or, when the selector
    /// misses, `{ok:false, error:"selector not found"}` — a page-level outcome the
    /// caller reports as a normal result (the connection stays alive).
    pub async fn interact(&mut self, kind: &str, selector: &str, value: Option<&str>) -> Result<Value, String> {
        let sel = serde_json::to_string(selector).map_err(|e| e.to_string())?;
        let val = serde_json::to_string(value.unwrap_or("")).map_err(|e| e.to_string())?;
        let js = match kind {
            "click" => format!(
                "(function(){{var el=document.querySelector({sel});if(!el)return{{ok:false,error:'selector not found'}};el.click();return{{ok:true}};}})()"
            ),
            "type" => format!(
                "(function(){{var el=document.querySelector({sel});if(!el)return{{ok:false,error:'selector not found'}};if(el.focus)el.focus();el.value={val};el.dispatchEvent(new Event('input',{{bubbles:true}}));el.dispatchEvent(new Event('change',{{bubbles:true}}));return{{ok:true}};}})()"
            ),
            "scroll" => format!(
                "(function(){{var el=document.querySelector({sel});if(!el)return{{ok:false,error:'selector not found'}};el.scrollIntoView({{block:'center'}});return{{ok:true}};}})()"
            ),
            "select" => format!(
                "(function(){{var el=document.querySelector({sel});if(!el)return{{ok:false,error:'selector not found'}};el.value={val};el.dispatchEvent(new Event('change',{{bubbles:true}}));return{{ok:true}};}})()"
            ),
            other => return Err(format!("unknown interact kind: {other}")),
        };
        self.eval(&js).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── is_safe_http_url: byte-parity with governance.ts isSafeHttpUrl ──

    #[test]
    fn is_safe_http_url_allows_only_http_and_https() {
        // http/https (any case, with surrounding whitespace) → true.
        assert!(is_safe_http_url(Some("http://example.com")));
        assert!(is_safe_http_url(Some("https://example.com/path?q=1")));
        assert!(is_safe_http_url(Some("HTTP://EXAMPLE.COM")));
        assert!(is_safe_http_url(Some("  https://x  ")));
    }

    #[test]
    fn is_safe_http_url_denies_every_other_scheme() {
        // The exact set governance.ts calls out — each a pivot off the web.
        assert!(!is_safe_http_url(Some("file:///etc/passwd")));
        assert!(!is_safe_http_url(Some("javascript:alert(1)")));
        assert!(!is_safe_http_url(Some("data:text/html,<h1>x</h1>")));
        assert!(!is_safe_http_url(Some("chrome://settings")));
        assert!(!is_safe_http_url(Some("chrome-extension://abcdef/page.html")));
        assert!(!is_safe_http_url(Some("about:blank")));
    }

    #[test]
    fn is_safe_http_url_fails_closed_on_empty_and_malformed() {
        assert!(!is_safe_http_url(None));
        assert!(!is_safe_http_url(Some("")));
        assert!(!is_safe_http_url(Some("   ")));
        assert!(!is_safe_http_url(Some("example.com"))); // scheme-less → not absolute
        assert!(!is_safe_http_url(Some("not a url")));
        assert!(!is_safe_http_url(Some("ht tp://x"))); // space inside "scheme" → invalid
        assert!(!is_safe_http_url(Some("httpsx://x"))); // scheme is "httpsx", not https
    }

    // ── pick_page_ws_url: picks a page target, falls back, tolerates framing ──

    #[test]
    fn pick_page_ws_url_prefers_a_page_target() {
        let body = r#"[
            {"type":"background_page","webSocketDebuggerUrl":"ws://127.0.0.1:9/bg"},
            {"type":"page","id":"P","webSocketDebuggerUrl":"ws://127.0.0.1:9/devtools/page/P"}
        ]"#;
        assert_eq!(
            pick_page_ws_url(body).as_deref(),
            Some("ws://127.0.0.1:9/devtools/page/P")
        );
    }

    #[test]
    fn pick_page_ws_url_falls_back_and_tolerates_http_framing() {
        // No page target, but a ws url exists → fall back to it. And the array is
        // wrapped in HTTP headers + a trailing chunk marker, which the slice ignores.
        let body = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n[{\"type\":\"other\",\"webSocketDebuggerUrl\":\"ws://127.0.0.1:9/x\"}]\r\n0\r\n\r\n";
        assert_eq!(pick_page_ws_url(body).as_deref(), Some("ws://127.0.0.1:9/x"));
    }

    #[test]
    fn pick_page_ws_url_none_when_no_ws_url() {
        assert!(pick_page_ws_url("[]").is_none());
        assert!(pick_page_ws_url("[{\"type\":\"page\"}]").is_none());
        assert!(pick_page_ws_url("not json").is_none());
    }

    // ── HTTP helpers: Content-Length parse (Chrome sends it without a space) ──

    #[test]
    fn parse_content_length_is_case_insensitive_and_space_tolerant() {
        assert_eq!(parse_content_length("Content-Length:2108\r\n"), Some(2108));
        assert_eq!(parse_content_length("content-length: 42\r\n"), Some(42));
        assert_eq!(parse_content_length("HTTP/1.1 200 OK\r\nCONTENT-LENGTH:7\r\n"), Some(7));
        assert_eq!(parse_content_length("Content-Type: application/json\r\n"), None);
    }

    #[test]
    fn find_subslice_locates_the_header_terminator() {
        assert_eq!(find_subslice(b"ab\r\n\r\ncd", b"\r\n\r\n"), Some(2));
        assert_eq!(find_subslice(b"no terminator", b"\r\n\r\n"), None);
        assert_eq!(find_subslice(b"", b"\r\n\r\n"), None);
    }

    // ── real headless-CDP smoke: launch Chrome, drive a page, assert ──────────
    //
    // Drives the RAW CdpConnection directly (below the governance gate) — the exact
    // analogue of pty.rs's `pty_smoke_echo_*` driving `open_pty_child`. The gate's
    // non-http(s) hard-deny is verified separately (is_safe_http_url + the classify
    // test in lib.rs), so this test may navigate a `data:` URL to exercise the CDP
    // mechanics with NO network. Skips cleanly when Chrome is absent (CI-linux).

    #[test]
    fn cdp_headless_smoke_navigate_eval_dom() {
        use std::fs;
        use std::path::Path;
        use std::time::{Instant, SystemTime, UNIX_EPOCH};

        const CHROME: &str = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
        if !Path::new(CHROME).is_file() {
            return; // no Chrome on this machine (e.g. CI-linux) → SKIP, don't fail
        }

        // Unique temp user-data-dir (Chrome writes DevToolsActivePort there).
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let udd = std::env::temp_dir().join(format!("braavo-cdp-{n}-{}", std::process::id()));
        fs::create_dir_all(&udd).unwrap();

        let mut child = std::process::Command::new(CHROME)
            .args([
                "--headless=new",
                "--remote-debugging-port=0", // let Chrome pick a free port
                "--remote-allow-origins=*",  // permit the WS upgrade from a non-browser client
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-gpu",
                &format!("--user-data-dir={}", udd.display()),
                "about:blank",
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("launch headless chrome");

        // Read the chosen port from DevToolsActivePort (first line), polling briefly.
        let port = {
            let file = udd.join("DevToolsActivePort");
            let deadline = Instant::now() + Duration::from_secs(15);
            let mut found = None;
            while Instant::now() < deadline {
                if let Ok(text) = fs::read_to_string(&file) {
                    if let Some(p) = text.lines().next().and_then(|l| l.trim().parse::<u16>().ok()) {
                        if p != 0 {
                            found = Some(p);
                            break;
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            found
        };

        // Single-thread tokio runtime (net + time) to drive the async CDP client.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let outcome: Result<(String, String, Value, String), String> = rt.block_on(async {
            let port = port.ok_or("Chrome never wrote a DevToolsActivePort")?;
            let ws = discover_ws_endpoint(port).await?;
            let mut conn = CdpConnection::connect(&ws).await?;
            let final_url = conn.navigate("data:text/html,<h1 id=x>hi</h1>").await?;
            let loc = conn.current_url().await?;
            let two = conn.eval("1+1").await?;
            let dom = conn.dom().await?;
            Ok((final_url, loc, two, dom))
        });

        // Always tear down Chrome + temp dir BEFORE asserting (a failed assert must
        // not leak a headless browser). These are our OWN processes/files — no git.
        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_dir_all(&udd);

        let (final_url, loc, two, dom) = outcome.expect("CDP smoke should drive headless Chrome");
        assert!(final_url.starts_with("data:text/html"), "navigate returns the final url: {final_url}");
        assert!(loc.starts_with("data:text/html"), "location.href reflects the navigation: {loc}");
        assert_eq!(two, json!(2), "eval(1+1) returns 2 by-value");
        assert!(dom.contains("hi"), "dom read sees the page body: {dom}");
    }
}
