//! Local daemon client (plan 1.3, contract: CLI `docs/DAEMON-CHAT.md`).
//!
//! The `braavo daemon` owns chat conversations (SQLite) and calls the user's own
//! provider key. It refuses any request carrying an `Origin` header, so the
//! webview cannot `fetch` it; this module is the desktop's only way in.
//!
//! Boundaries this module enforces (the webview cannot widen them):
//! - **Host is fixed**: `127.0.0.1:<port>` where the port comes from
//!   `~/.braavo/daemon/state.json`. The webview never supplies a host or URL.
//! - **Routes are allow-listed**: only the chat endpoints of the contract
//!   (`validate_route`). A turn (`POST …/messages`) goes only through the
//!   streaming command, never the generic request command.
//! - **The bearer token is read at call time** from `~/.braavo/daemon/token`
//!   and lives only inside the request bytes. It is never returned to the
//!   webview, logged, cached, or written anywhere; `Endpoint`'s `Debug` redacts it.
//!
//! HTTP is hand-rolled over a loopback `TcpStream` (same dependency-frugal
//! approach as browser.rs's DevTools discovery): HTTP/1.1, `Connection: close`,
//! with Content-Length, chunked and read-to-EOF bodies, plus an SSE parser for
//! streamed turns.

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use futures_util::future::{select, Either};

/// Connecting to a loopback port either succeeds at once or the daemon is down.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
/// Whole-request bound for the JSON endpoints.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Max silence between bytes of a streamed turn. Reasoning models can think for
/// a while before the first delta, so this is generous; the user can always abort.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(300);
/// OOM guards.
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_JSON_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 1024 * 1024;
const MAX_SSE_EVENT_BYTES: usize = 1024 * 1024;
/// Contract §2: message content is at most 100 000 characters.
pub const MAX_CONTENT_CHARS: usize = 100_000;

pub const ERR_NOT_RUNNING: &str = "daemon-not-running";
pub const ERR_TIMEOUT: &str = "daemon-timeout";
pub const ERR_PROTOCOL: &str = "daemon-protocol";
pub const ERR_ROUTE: &str = "daemon-route-refused";

/// Where the daemon publishes its port and token.
pub fn daemon_dir(home: &Path) -> PathBuf {
    home.join(".braavo").join("daemon")
}

/// Port + bearer token for one call. Built per call, dropped right after.
pub struct Endpoint {
    pub port: u16,
    token: String,
}

impl fmt::Debug for Endpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Endpoint").field("port", &self.port).field("token", &"<redacted>").finish()
    }
}

impl Endpoint {
    #[cfg(test)]
    pub fn for_test(port: u16, token: &str) -> Self {
        Self { port, token: token.to_string() }
    }
}

/// A token goes verbatim into a header line, so anything outside visible ASCII
/// (CR/LF in particular) is refused rather than risking header injection.
fn valid_token(token: &str) -> bool {
    token.len() >= 16 && token.len() <= 512 && token.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

/// Read `state.json` (port) and `token` from the daemon dir. Missing or
/// malformed files mean the daemon is not running (or not set up) — a single
/// error code, never file contents.
pub fn read_endpoint(dir: &Path) -> Result<Endpoint, String> {
    let state = std::fs::read_to_string(dir.join("state.json")).map_err(|_| ERR_NOT_RUNNING.to_string())?;
    let parsed: Value = serde_json::from_str(&state).map_err(|_| ERR_NOT_RUNNING.to_string())?;
    let port = parsed
        .get("port")
        .and_then(Value::as_u64)
        .filter(|p| (1..=65535).contains(p))
        .ok_or_else(|| ERR_NOT_RUNNING.to_string())? as u16;
    let raw = std::fs::read_to_string(dir.join("token")).map_err(|_| ERR_NOT_RUNNING.to_string())?;
    let token = raw.trim().to_string();
    if !valid_token(&token) {
        return Err(ERR_NOT_RUNNING.to_string());
    }
    Ok(Endpoint { port, token })
}

// ── route allow-list ─────────────────────────────────────────────────────────

fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Query strings are built by the TS client with `encodeURIComponent`, so only
/// unreserved characters, `%XX` escapes and the `&`/`=` separators can appear.
fn valid_query(query: &str, allowed_keys: &[&str]) -> bool {
    if query.len() > 2048 {
        return false;
    }
    if !query.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~%&=+*".contains(&b)) {
        return false;
    }
    query.split('&').filter(|p| !p.is_empty()).all(|pair| {
        let key = pair.split('=').next().unwrap_or("");
        allowed_keys.contains(&key)
    })
}

/// Only the chat routes of the contract. Everything else (companies, routines,
/// events, a turn via the generic command, any other host) is refused.
pub fn validate_route(method: &str, path_and_query: &str) -> Result<(), String> {
    let refuse = || Err(ERR_ROUTE.to_string());
    let (path, query) = match path_and_query.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (path_and_query, None),
    };
    if !path.starts_with("/v1/") || path.contains("//") || path.ends_with('/') {
        return refuse();
    }
    let parts: Vec<&str> = path[1..].split('/').collect();
    let query_ok = |keys: &[&str]| query.map_or(true, |q| valid_query(q, keys));
    let ok = match (method, parts.as_slice()) {
        ("GET", ["v1", "health"]) => query.is_none(),
        ("GET", ["v1", "models"]) => query.is_none(),
        ("GET", ["v1", "conversations"]) => query_ok(&["limit", "before"]),
        ("POST", ["v1", "conversations"]) => query.is_none(),
        ("POST", ["v1", "conversations", "import"]) => query.is_none(),
        ("GET" | "PATCH" | "DELETE", ["v1", "conversations", id]) => *id != "import" && valid_id(id) && query.is_none(),
        ("POST", ["v1", "conversations", id, "abort"]) => valid_id(id) && query.is_none(),
        ("GET", ["v1", "search"]) => query_ok(&["q", "limit"]),
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        refuse()
    }
}

// ── HTTP/1.1 over loopback ───────────────────────────────────────────────────

/// Request bytes. Never an `Origin` header (the daemon refuses it), Host is the
/// literal loopback address. The token appears only here.
pub fn build_request(method: &str, path: &str, ep: &Endpoint, accept: &str, body: Option<&[u8]>) -> Vec<u8> {
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nAccept: {accept}\r\nConnection: close\r\n",
        port = ep.port,
        token = ep.token
    );
    match body {
        Some(b) => {
            head.push_str("Content-Type: application/json\r\n");
            head.push_str(&format!("Content-Length: {}\r\n", b.len()));
        }
        None if method == "POST" || method == "PATCH" => head.push_str("Content-Length: 0\r\n"),
        None => {}
    }
    head.push_str("\r\n");
    let mut out = head.into_bytes();
    if let Some(b) = body {
        out.extend_from_slice(b);
    }
    out
}

#[derive(Debug)]
pub struct ResponseHead {
    pub status: u16,
    pub headers: Vec<(String, String)>,
}

impl ResponseHead {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

pub fn parse_head(raw: &str) -> Result<ResponseHead, String> {
    let mut lines = raw.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let mut parts = status_line.splitn(3, ' ');
    let version = parts.next().unwrap_or("");
    if !version.starts_with("HTTP/1.") {
        return Err(format!("{ERR_PROTOCOL}: bad status line"));
    }
    let status = parts
        .next()
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| format!("{ERR_PROTOCOL}: bad status code"))?;
    let headers = lines
        .filter(|l| !l.is_empty())
        .filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string())))
        .collect();
    Ok(ResponseHead { status, headers })
}

/// Incremental body decoder: Content-Length, chunked, or read-to-EOF.
pub enum BodyDecoder {
    Length { remaining: usize },
    Chunked { state: ChunkState, pending: Vec<u8> },
    Eof,
}

pub enum ChunkState {
    Size,
    Data(usize),
    DataEnd,
    Done,
}

impl BodyDecoder {
    pub fn for_head(head: &ResponseHead) -> Self {
        if head.header("transfer-encoding").map_or(false, |v| v.to_ascii_lowercase().contains("chunked")) {
            BodyDecoder::Chunked { state: ChunkState::Size, pending: Vec::new() }
        } else if let Some(len) = head.header("content-length").and_then(|v| v.parse::<usize>().ok()) {
            BodyDecoder::Length { remaining: len }
        } else if head.status == 204 || head.status == 304 {
            BodyDecoder::Length { remaining: 0 }
        } else {
            BodyDecoder::Eof
        }
    }

    /// True once the framing says the body is complete (EOF mode never is).
    pub fn done(&self) -> bool {
        matches!(self, BodyDecoder::Length { remaining: 0 } | BodyDecoder::Chunked { state: ChunkState::Done, .. })
    }

    /// Feed raw socket bytes, appending decoded body bytes to `out`.
    pub fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), String> {
        match self {
            BodyDecoder::Eof => out.extend_from_slice(input),
            BodyDecoder::Length { remaining } => {
                let take = (*remaining).min(input.len());
                out.extend_from_slice(&input[..take]);
                *remaining -= take;
            }
            BodyDecoder::Chunked { state, pending } => {
                pending.extend_from_slice(input);
                loop {
                    match state {
                        ChunkState::Done => {
                            pending.clear();
                            return Ok(());
                        }
                        ChunkState::Size => {
                            let Some(pos) = find_subslice(pending, b"\r\n") else {
                                if pending.len() > 1024 {
                                    return Err(format!("{ERR_PROTOCOL}: chunk size line too long"));
                                }
                                return Ok(());
                            };
                            let line = String::from_utf8_lossy(&pending[..pos]).into_owned();
                            let hex = line.split(';').next().unwrap_or("").trim();
                            let size = usize::from_str_radix(hex, 16).map_err(|_| format!("{ERR_PROTOCOL}: bad chunk size"))?;
                            pending.drain(..pos + 2);
                            *state = if size == 0 { ChunkState::Done } else { ChunkState::Data(size) };
                        }
                        ChunkState::Data(n) => {
                            if pending.is_empty() {
                                return Ok(());
                            }
                            let take = (*n).min(pending.len());
                            out.extend(pending.drain(..take));
                            *n -= take;
                            if *n == 0 {
                                *state = ChunkState::DataEnd;
                            }
                        }
                        ChunkState::DataEnd => {
                            if pending.len() < 2 {
                                return Ok(());
                            }
                            if &pending[..2] != b"\r\n" {
                                return Err(format!("{ERR_PROTOCOL}: missing chunk terminator"));
                            }
                            pending.drain(..2);
                            *state = ChunkState::Size;
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

async fn connect(ep: &Endpoint) -> Result<TcpStream, String> {
    match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(("127.0.0.1", ep.port))).await {
        Ok(Ok(s)) => Ok(s),
        // Refused / timed out on loopback: the state file is stale or the daemon is down.
        Ok(Err(_)) | Err(_) => Err(ERR_NOT_RUNNING.to_string()),
    }
}

/// Read until the end of the headers; returns the head and any body bytes
/// already received.
async fn read_head<S: AsyncRead + Unpin>(stream: &mut S, idle: Duration) -> Result<(ResponseHead, Vec<u8>), String> {
    let mut buf: Vec<u8> = Vec::new();
    let mut tmp = [0u8; 8192];
    let end = loop {
        if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > MAX_HEADER_BYTES {
            return Err(format!("{ERR_PROTOCOL}: headers too large"));
        }
        let n = match tokio::time::timeout(idle, stream.read(&mut tmp)).await {
            Ok(r) => r.map_err(|_| ERR_NOT_RUNNING.to_string())?,
            Err(_) => return Err(ERR_TIMEOUT.to_string()),
        };
        if n == 0 {
            return Err(format!("{ERR_PROTOCOL}: closed before headers"));
        }
        buf.extend_from_slice(&tmp[..n]);
    };
    let head = parse_head(&String::from_utf8_lossy(&buf[..end]))?;
    Ok((head, buf[end + 4..].to_vec()))
}

/// Read a whole (bounded) body.
async fn read_body<S: AsyncRead + Unpin>(stream: &mut S, head: &ResponseHead, initial: Vec<u8>) -> Result<Vec<u8>, String> {
    let mut decoder = BodyDecoder::for_head(head);
    let mut body = Vec::new();
    decoder.feed(&initial, &mut body)?;
    let mut tmp = [0u8; 8192];
    while !decoder.done() {
        let n = stream.read(&mut tmp).await.map_err(|_| ERR_NOT_RUNNING.to_string())?;
        if n == 0 {
            break;
        }
        decoder.feed(&tmp[..n], &mut body)?;
        if body.len() > MAX_JSON_BODY_BYTES {
            return Err(format!("{ERR_PROTOCOL}: body too large"));
        }
    }
    Ok(body)
}

/// Status + parsed JSON body (Null for an empty body, e.g. `204`). Errors are
/// part of the reply (`{ error, code }` with a 4xx/5xx status), not an `Err`:
/// the TS client maps them per the contract.
#[derive(Debug, Serialize, PartialEq)]
pub struct Reply {
    pub status: u16,
    pub body: Value,
}

fn parse_json_body(bytes: &[u8]) -> Value {
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Value::Null;
    }
    serde_json::from_slice(bytes).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(bytes).chars().take(500).collect()))
}

pub async fn request_on<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    ep: &Endpoint,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Reply, String> {
    let bytes = body.map(|b| serde_json::to_vec(b).unwrap_or_default());
    if bytes.as_ref().map_or(false, |b| b.len() > MAX_REQUEST_BODY_BYTES) {
        return Err(format!("{ERR_PROTOCOL}: request body too large"));
    }
    let req = build_request(method, path, ep, "application/json", bytes.as_deref());
    stream.write_all(&req).await.map_err(|_| ERR_NOT_RUNNING.to_string())?;
    let (head, initial) = read_head(stream, REQUEST_TIMEOUT).await?;
    let raw = read_body(stream, &head, initial).await?;
    Ok(Reply { status: head.status, body: parse_json_body(&raw) })
}

/// One JSON request to an allow-listed route.
pub async fn request(ep: &Endpoint, method: &str, path: &str, body: Option<&Value>) -> Result<Reply, String> {
    validate_route(method, path)?;
    let fut = async {
        let mut stream = connect(ep).await?;
        request_on(&mut stream, ep, method, path, body).await
    };
    match tokio::time::timeout(REQUEST_TIMEOUT, fut).await {
        Ok(r) => r,
        Err(_) => Err(ERR_TIMEOUT.to_string()),
    }
}

// ── Server-sent events ───────────────────────────────────────────────────────

/// One SSE event as forwarded to the webview: `data` is the parsed JSON when
/// it parses, else the raw string.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct StreamEvent {
    pub event: String,
    pub data: Value,
}

#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
}

impl SseParser {
    /// Feed decoded body bytes; returns every complete event.
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<StreamEvent>, String> {
        self.buf.extend_from_slice(bytes);
        let mut events = Vec::new();
        loop {
            // Normalise CRLF lazily: look for a blank line in either style.
            let lf = find_subslice(&self.buf, b"\n\n").map(|p| (p, 2));
            let crlf = find_subslice(&self.buf, b"\r\n\r\n").map(|p| (p, 4));
            let next = match (lf, crlf) {
                (Some(a), Some(b)) => Some(if a.0 <= b.0 { a } else { b }),
                (a, b) => a.or(b),
            };
            let Some((pos, sep)) = next else { break };
            let block: Vec<u8> = self.buf.drain(..pos + sep).take(pos).collect();
            if let Some(ev) = parse_event_block(&String::from_utf8_lossy(&block)) {
                events.push(ev);
            }
        }
        if self.buf.len() > MAX_SSE_EVENT_BYTES {
            return Err(format!("{ERR_PROTOCOL}: event too large"));
        }
        Ok(events)
    }
}

fn parse_event_block(block: &str) -> Option<StreamEvent> {
    let mut event = String::from("message");
    let mut data: Vec<&str> = Vec::new();
    for line in block.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match field {
            "event" => event = value.to_string(),
            "data" => data.push(value),
            _ => {}
        }
    }
    if data.is_empty() {
        return None;
    }
    let joined = data.join("\n");
    let parsed = serde_json::from_str(&joined).unwrap_or(Value::String(joined));
    Some(StreamEvent { event, data: parsed })
}

/// Local status for a turn the user dropped (never sent by the daemon).
fn cancelled_reply() -> Reply {
    Reply { status: 499, body: serde_json::json!({ "error": "cancelled", "code": "cancelled" }) }
}

/// Stream one turn on an already-connected socket. `emit` gets every event;
/// `cancel` firing drops the connection, which the daemon treats as an abort
/// (partial text kept, `stopReason: "aborted"`). A non-SSE response (busy 409,
/// missing-key 400, …) is returned as a normal `Reply`.
pub async fn stream_on<S, F>(
    stream: &mut S,
    ep: &Endpoint,
    conversation_id: &str,
    content: &str,
    mut cancel: oneshot::Receiver<()>,
    mut emit: F,
) -> Result<Reply, String>
where
    S: AsyncRead + AsyncWrite + Unpin,
    F: FnMut(StreamEvent),
{
    let path = format!("/v1/conversations/{conversation_id}/messages");
    let body = serde_json::to_vec(&serde_json::json!({ "content": content })).unwrap_or_default();
    let req = build_request("POST", &path, ep, "text/event-stream", Some(&body));
    stream.write_all(&req).await.map_err(|_| ERR_NOT_RUNNING.to_string())?;
    let (head, initial) = {
        let head = std::pin::pin!(read_head(stream, STREAM_IDLE_TIMEOUT));
        match select(head, &mut cancel).await {
            Either::Left((r, _)) => r?,
            Either::Right(_) => return Ok(cancelled_reply()),
        }
    };
    let is_sse = head.header("content-type").map_or(false, |v| v.to_ascii_lowercase().starts_with("text/event-stream"));
    if !(200..300).contains(&head.status) || !is_sse {
        let raw = read_body(stream, &head, initial).await?;
        return Ok(Reply { status: head.status, body: parse_json_body(&raw) });
    }
    let mut decoder = BodyDecoder::for_head(&head);
    let mut parser = SseParser::default();
    let mut decoded = Vec::new();
    decoder.feed(&initial, &mut decoded)?;
    for ev in parser.feed(&decoded)? {
        emit(ev);
    }
    let mut tmp = [0u8; 8192];
    while !decoder.done() {
        let read = std::pin::pin!(tokio::time::timeout(STREAM_IDLE_TIMEOUT, stream.read(&mut tmp)));
        let n = match select(read, &mut cancel).await {
            Either::Left((Ok(Ok(n)), _)) => n,
            Either::Left((Ok(Err(_)), _)) => return Err(ERR_NOT_RUNNING.to_string()),
            Either::Left((Err(_), _)) => return Err(ERR_TIMEOUT.to_string()),
            // Dropping the socket is the abort signal the daemon listens for.
            Either::Right(_) => return Ok(cancelled_reply()),
        };
        if n == 0 {
            break;
        }
        decoded.clear();
        decoder.feed(&tmp[..n], &mut decoded)?;
        for ev in parser.feed(&decoded)? {
            emit(ev);
        }
    }
    Ok(Reply { status: head.status, body: Value::Null })
}

/// In-flight turns, keyed by conversation id, so the webview can drop a stream
/// (kill switch / new chat) even when `POST …/abort` cannot be delivered.
#[derive(Default)]
pub struct DaemonStreams(pub Mutex<HashMap<String, oneshot::Sender<()>>>);

impl DaemonStreams {
    pub fn register(&self, id: &str) -> Option<oneshot::Receiver<()>> {
        let mut map = self.0.lock().ok()?;
        if map.contains_key(id) {
            return None;
        }
        let (tx, rx) = oneshot::channel();
        map.insert(id.to_string(), tx);
        Some(rx)
    }
    pub fn finish(&self, id: &str) {
        if let Ok(mut map) = self.0.lock() {
            map.remove(id);
        }
    }
    pub fn cancel(&self, id: &str) -> bool {
        let tx = self.0.lock().ok().and_then(|mut map| map.remove(id));
        tx.map_or(false, |tx| tx.send(()).is_ok())
    }
    pub fn cancel_all(&self) -> usize {
        let drained: Vec<_> = match self.0.lock() {
            Ok(mut map) => map.drain().map(|(_, tx)| tx).collect(),
            Err(_) => Vec::new(),
        };
        drained.into_iter().map(|tx| tx.send(())).filter(Result::is_ok).count()
    }
}

pub fn validate_turn(conversation_id: &str, content: &str) -> Result<(), String> {
    if !valid_id(conversation_id) {
        return Err(ERR_ROUTE.to_string());
    }
    let chars = content.chars().count();
    if chars == 0 || chars > MAX_CONTENT_CHARS {
        return Err(format!("{ERR_PROTOCOL}: content must be 1–{MAX_CONTENT_CHARS} characters"));
    }
    Ok(())
}

pub async fn stream_turn<F: FnMut(StreamEvent)>(
    ep: &Endpoint,
    conversation_id: &str,
    content: &str,
    cancel: oneshot::Receiver<()>,
    emit: F,
) -> Result<Reply, String> {
    validate_turn(conversation_id, content)?;
    let mut stream = connect(ep).await?;
    stream_on(&mut stream, ep, conversation_id, content, cancel, emit).await
}

// ── Tauri commands ───────────────────────────────────────────────────────────

use tauri::{AppHandle, Manager, State};

fn endpoint_for(app: &AppHandle) -> Result<Endpoint, String> {
    let home = app.path().home_dir().map_err(|_| ERR_NOT_RUNNING.to_string())?;
    read_endpoint(&daemon_dir(&home))
}

#[derive(Debug, Serialize)]
pub struct DaemonStatus {
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Why it is not usable: `daemon-not-running`, `unauthorized`, …
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Probe: state file + token present AND an authenticated `/v1/health` answers.
#[tauri::command]
pub async fn daemon_status(app: AppHandle) -> DaemonStatus {
    let ep = match endpoint_for(&app) {
        Ok(ep) => ep,
        Err(reason) => return DaemonStatus { running: false, version: None, reason: Some(reason) },
    };
    match request(&ep, "GET", "/v1/health", None).await {
        Ok(Reply { status: 200, body }) => DaemonStatus {
            running: true,
            version: body.get("version").and_then(Value::as_str).map(|v| v.chars().take(64).collect()),
            reason: None,
        },
        Ok(Reply { status: 401, .. }) => DaemonStatus { running: false, version: None, reason: Some("unauthorized".into()) },
        Ok(Reply { status, .. }) => DaemonStatus { running: false, version: None, reason: Some(format!("status-{status}")) },
        Err(reason) => DaemonStatus { running: false, version: None, reason: Some(reason) },
    }
}

/// Generic JSON call to an allow-listed chat route.
#[tauri::command]
pub async fn daemon_request(app: AppHandle, method: String, path: String, body: Option<Value>) -> Result<Reply, String> {
    validate_route(&method, &path)?;
    let ep = endpoint_for(&app)?;
    request(&ep, &method, &path, body.as_ref()).await
}

/// Stream one turn; events go to `on_event` as they arrive. Resolves when the
/// stream ends (or with the error reply that replaced it).
#[tauri::command]
pub async fn daemon_send_message(
    app: AppHandle,
    streams: State<'_, DaemonStreams>,
    conversation_id: String,
    content: String,
    on_event: tauri::ipc::Channel<StreamEvent>,
) -> Result<Reply, String> {
    validate_turn(&conversation_id, &content)?;
    let ep = endpoint_for(&app)?;
    let Some(cancel) = streams.register(&conversation_id) else {
        // Same shape as the daemon's own one-turn-per-conversation refusal.
        return Ok(Reply { status: 409, body: serde_json::json!({ "error": "a turn is already streaming", "code": "busy" }) });
    };
    let result = stream_turn(&ep, &conversation_id, &content, cancel, |ev| {
        let _ = on_event.send(ev);
    })
    .await;
    streams.finish(&conversation_id);
    result
}

/// Drop the stream for one conversation (the daemon aborts on disconnect).
#[tauri::command]
pub fn daemon_stream_cancel(streams: State<'_, DaemonStreams>, conversation_id: String) -> bool {
    streams.cancel(&conversation_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    const TOKEN: &str = "test-token-abcdefghijklmnopqrstuvwxyz";

    #[test]
    fn endpoint_debug_never_prints_the_token() {
        let ep = Endpoint::for_test(1234, TOKEN);
        let shown = format!("{ep:?}");
        assert!(!shown.contains(TOKEN));
        assert!(shown.contains("1234"));
    }

    #[test]
    fn read_endpoint_requires_state_and_a_sane_token() {
        let dir = std::env::temp_dir().join(format!("bv-daemon-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_endpoint(&dir).unwrap_err(), ERR_NOT_RUNNING);
        std::fs::write(dir.join("state.json"), r#"{"pid":1,"port":4321,"startedAt":"x","version":"1"}"#).unwrap();
        assert_eq!(read_endpoint(&dir).unwrap_err(), ERR_NOT_RUNNING, "token missing");
        std::fs::write(dir.join("token"), "short\n").unwrap();
        assert_eq!(read_endpoint(&dir).unwrap_err(), ERR_NOT_RUNNING, "token too short");
        std::fs::write(dir.join("token"), "abcdefghijklmnop\r\nX-Evil: 1\n").unwrap();
        assert_eq!(read_endpoint(&dir).unwrap_err(), ERR_NOT_RUNNING, "header injection refused");
        std::fs::write(dir.join("token"), format!("{TOKEN}\n")).unwrap();
        let ep = read_endpoint(&dir).unwrap();
        assert_eq!(ep.port, 4321);
        std::fs::write(dir.join("state.json"), r#"{"port":70000}"#).unwrap();
        assert!(read_endpoint(&dir).is_err(), "port out of range");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn route_allow_list() {
        for (m, p) in [
            ("GET", "/v1/models"),
            ("GET", "/v1/health"),
            ("GET", "/v1/conversations"),
            ("GET", "/v1/conversations?limit=50&before=2026-11-01T00%3A00%3A00.000Z"),
            ("POST", "/v1/conversations"),
            ("POST", "/v1/conversations/import"),
            ("GET", "/v1/conversations/cv_abc-1"),
            ("PATCH", "/v1/conversations/cv_abc"),
            ("DELETE", "/v1/conversations/cv_abc"),
            ("POST", "/v1/conversations/cv_abc/abort"),
            ("GET", "/v1/search?q=hello%20world&limit=20"),
        ] {
            assert!(validate_route(m, p).is_ok(), "{m} {p}");
        }
        for (m, p) in [
            ("POST", "/v1/conversations/cv_abc/messages"), // turns only via the stream command
            ("GET", "/v1/events"),
            ("GET", "/v1/companies"),
            ("POST", "/v1/routines/x/run"),
            ("GET", "http://evil.example/v1/models"),
            ("GET", "/v1/conversations/../companies"),
            ("GET", "/v1/conversations/a b"),
            ("GET", "/v1/conversations/x\r\nHost: evil"),
            ("GET", "/v1/search?q=a&token=x"),
            ("GET", "/v1/search?q=<script>"),
            ("GET", "/v1/models?x=1"),
            ("DELETE", "/v1/conversations/import"),
            ("PUT", "/v1/conversations/cv"),
            ("GET", "/v1//models"),
            ("GET", "/v2/models"),
        ] {
            assert!(validate_route(m, p).is_err(), "{m} {p}");
        }
    }

    #[test]
    fn request_has_no_origin_and_a_loopback_host() {
        let ep = Endpoint::for_test(9999, TOKEN);
        let raw = String::from_utf8(build_request("POST", "/v1/conversations", &ep, "application/json", Some(b"{}"))).unwrap();
        assert!(raw.starts_with("POST /v1/conversations HTTP/1.1\r\n"));
        assert!(raw.contains("\r\nHost: 127.0.0.1:9999\r\n"));
        assert!(!raw.to_ascii_lowercase().contains("origin:"));
        assert!(raw.contains("Content-Length: 2\r\n"));
        assert!(raw.ends_with("\r\n\r\n{}"));
    }

    #[test]
    fn chunked_decoder_handles_split_frames() {
        let head = parse_head("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked").unwrap();
        let mut dec = BodyDecoder::for_head(&head);
        let wire = b"5\r\nhello\r\n6;ext=1\r\n world\r\n0\r\n\r\n";
        let mut out = Vec::new();
        for byte in wire.iter() {
            dec.feed(std::slice::from_ref(byte), &mut out).unwrap();
        }
        assert_eq!(out, b"hello world");
        assert!(dec.done());
        let mut bad = BodyDecoder::for_head(&head);
        assert!(bad.feed(b"zz\r\n", &mut Vec::new()).is_err());
    }

    #[test]
    fn length_and_empty_bodies() {
        let head = parse_head("HTTP/1.1 200 OK\r\ncontent-length: 3").unwrap();
        let mut dec = BodyDecoder::for_head(&head);
        let mut out = Vec::new();
        dec.feed(b"abcdef", &mut out).unwrap();
        assert_eq!(out, b"abc");
        assert!(dec.done());
        let no_content = parse_head("HTTP/1.1 204 No Content").unwrap();
        assert!(BodyDecoder::for_head(&no_content).done());
        assert_eq!(parse_json_body(b""), Value::Null);
    }

    #[test]
    fn sse_parser_splits_events_across_feeds() {
        let mut p = SseParser::default();
        let mut events = p.feed(b": hi\n\nevent: delta\ndata: {\"te").unwrap();
        assert!(events.is_empty());
        events.extend(p.feed(b"xt\":\"a\"}\n\nevent: done\r\ndata: {\"stopReason\":\"end_turn\"}\r\n\r\n").unwrap());
        assert_eq!(
            events,
            vec![
                StreamEvent { event: "delta".into(), data: serde_json::json!({ "text": "a" }) },
                StreamEvent { event: "done".into(), data: serde_json::json!({ "stopReason": "end_turn" }) },
            ]
        );
        let raw = p.feed(b"data: line1\ndata: line2\n\n").unwrap();
        assert_eq!(raw[0].event, "message");
        assert_eq!(raw[0].data, Value::String("line1\nline2".into()));
    }

    /// A fake daemon on a real loopback socket: asserts the request shape, then
    /// answers with `response` written in two pieces.
    fn chunked(head: &str, parts: &[&str]) -> Vec<u8> {
        let mut out = head.as_bytes().to_vec();
        for p in parts {
            out.extend_from_slice(format!("{:x}\r\n{p}\r\n", p.len()).as_bytes());
        }
        out.extend_from_slice(b"0\r\n\r\n");
        out
    }

    fn serve_once(response: impl Into<Vec<u8>>) -> (u16, std::thread::JoinHandle<String>) {
        let response: Vec<u8> = response.into();
        let std_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = std_listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            use std::io::{Read, Write};
            let (mut sock, _) = std_listener.accept().unwrap();
            let mut req = Vec::new();
            let mut tmp = [0u8; 4096];
            loop {
                let n = sock.read(&mut tmp).unwrap();
                req.extend_from_slice(&tmp[..n]);
                if let Some(pos) = find_subslice(&req, b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&req[..pos]).to_string();
                    let len = parse_head(&format!("HTTP/1.1 200 X\r\n{}", head.split_once("\r\n").map(|x| x.1).unwrap_or("")))
                        .ok()
                        .and_then(|h| h.header("content-length").and_then(|v| v.parse::<usize>().ok()))
                        .unwrap_or(0);
                    if req.len() >= pos + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let mid = response.len() / 2;
            sock.write_all(&response[..mid]).unwrap();
            sock.flush().unwrap();
            std::thread::sleep(Duration::from_millis(20));
            sock.write_all(&response[mid..]).unwrap();
            String::from_utf8_lossy(&req).to_string()
        });
        (port, handle)
    }

    #[test]
    fn json_request_round_trip() {
        let (port, server) = serve_once(b"HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: 27\r\n\r\n{\"conversation\":{\"id\":\"c\"}}");
        let ep = Endpoint::for_test(port, TOKEN);
        let body = serde_json::json!({ "provider": "ANTHROPIC", "model": "m" });
        let reply = rt().block_on(request(&ep, "POST", "/v1/conversations", Some(&body))).unwrap();
        assert_eq!(reply, Reply { status: 201, body: serde_json::json!({ "conversation": { "id": "c" } }) });
        let seen = server.join().unwrap();
        assert!(seen.contains(&format!("Authorization: Bearer {TOKEN}\r\n")));
        assert!(!seen.to_ascii_lowercase().contains("origin:"));
        assert!(seen.ends_with(r#"{"model":"m","provider":"ANTHROPIC"}"#) || seen.ends_with(r#"{"provider":"ANTHROPIC","model":"m"}"#));
    }

    #[test]
    fn refused_route_never_connects() {
        let ep = Endpoint::for_test(1, TOKEN);
        assert_eq!(rt().block_on(request(&ep, "GET", "/v1/events", None)).unwrap_err(), ERR_ROUTE);
    }

    #[test]
    fn connection_refused_is_not_running() {
        // Bind then drop to get a (very likely) closed port.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let ep = Endpoint::for_test(port, TOKEN);
        assert_eq!(rt().block_on(request(&ep, "GET", "/v1/models", None)).unwrap_err(), ERR_NOT_RUNNING);
    }

    #[test]
    fn streamed_turn_over_chunked_sse() {
        let (port, server) = serve_once(chunked(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n",
            &[
                "event: message\ndata: {\"id\":\"m1\",\"role\":\"user\"}\n\n",
                // One event split across two chunks, two events in one chunk.
                "event: delta\ndata: {\"te",
                "xt\":\"Hi\"}\n\nevent: done\ndata: {\"messageId\":\"m2\",\"stopReason\":\"end_turn\"}\n\n",
            ],
        ));
        let ep = Endpoint::for_test(port, TOKEN);
        let (_tx, rx) = oneshot::channel();
        let mut seen = Vec::new();
        let reply = rt().block_on(stream_turn(&ep, "cv_1", "hello", rx, |e| seen.push(e))).unwrap();
        assert_eq!(reply.status, 200);
        let names: Vec<_> = seen.iter().map(|e| e.event.as_str()).collect();
        assert_eq!(names, ["message", "delta", "done"]);
        assert_eq!(seen[1].data, serde_json::json!({ "text": "Hi" }));
        let req = server.join().unwrap();
        assert!(req.starts_with("POST /v1/conversations/cv_1/messages HTTP/1.1\r\n"));
        assert!(req.contains("Accept: text/event-stream\r\n"));
        assert!(req.ends_with(r#"{"content":"hello"}"#));
    }

    #[test]
    fn busy_turn_returns_the_json_error_reply() {
        let (port, server) = serve_once(b"HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: 32\r\n\r\n{\"error\":\"busy\",\"code\":\"busy\"}  ");
        let ep = Endpoint::for_test(port, TOKEN);
        let (_tx, rx) = oneshot::channel();
        let mut seen = 0;
        let reply = rt().block_on(stream_turn(&ep, "cv_1", "x", rx, |_| seen += 1)).unwrap();
        assert_eq!(reply.status, 409);
        assert_eq!(reply.body["code"], "busy");
        assert_eq!(seen, 0);
        server.join().unwrap();
    }

    #[test]
    fn cancel_drops_the_stream() {
        rt().block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut tmp = [0u8; 4096];
                let _ = sock.read(&mut tmp).await;
                sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\nevent: delta\ndata: {\"text\":\"a\"}\n\n").await.unwrap();
                // Never finish: the client must hang up. Read returns 0 when it does.
                let mut rest = [0u8; 16];
                loop {
                    match sock.read(&mut rest).await {
                        Ok(0) | Err(_) => break true,
                        Ok(_) => continue,
                    }
                }
            });
            let ep = Endpoint::for_test(port, TOKEN);
            let streams = DaemonStreams::default();
            let rx = streams.register("cv_1").unwrap();
            assert!(streams.register("cv_1").is_none(), "one turn per conversation");
            let mut got = Vec::new();
            let turn = stream_turn(&ep, "cv_1", "x", rx, |e| got.push(e));
            let canceller = async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                assert!(streams.cancel("cv_1"));
            };
            let (reply, _) = futures_util::future::join(turn, canceller).await;
            assert_eq!(reply.unwrap().status, 499);
            assert_eq!(got.len(), 1);
            assert!(server.await.unwrap(), "server saw the disconnect");
            assert!(!streams.cancel("cv_1"));
        });
    }

    /// End-to-end against a REAL `braavo daemon run` (CLI branch feat/chat).
    /// Opt-in: `BRAAVO_E2E_DAEMON_DIR=<HOME>/.braavo/daemon cargo test -- --ignored live_daemon`.
    /// Point it at a throwaway HOME: it creates, imports and deletes conversations.
    #[test]
    #[ignore]
    fn live_daemon_e2e() {
        let dir = std::env::var("BRAAVO_E2E_DAEMON_DIR").expect("set BRAAVO_E2E_DAEMON_DIR");
        let ep = read_endpoint(Path::new(&dir)).expect("daemon state + token");
        rt().block_on(async {
            let health = request(&ep, "GET", "/v1/health", None).await.unwrap();
            assert_eq!(health.status, 200, "{health:?}");
            let models = request(&ep, "GET", "/v1/models", None).await.unwrap();
            assert_eq!(models.status, 200);
            assert!(models.body["suggestions"].is_object(), "{:?}", models.body);

            let created = request(&ep, "POST", "/v1/conversations", Some(&serde_json::json!({ "title": "e2e", "provider": "ANTHROPIC", "model": "claude-test" }))).await.unwrap();
            assert_eq!(created.status, 201, "{created:?}");
            let id = created.body["conversation"]["id"].as_str().unwrap().to_string();
            assert!(validate_route("GET", &format!("/v1/conversations/{id}")).is_ok(), "daemon ids pass the allow-list");

            // No key in the throwaway HOME: refused before any stream starts.
            let (_tx, rx) = oneshot::channel();
            let mut events = Vec::new();
            let turn = stream_turn(&ep, &id, "hello", rx, |e| events.push(e)).await.unwrap();
            assert_eq!(turn.status, 400, "{turn:?}");
            assert_eq!(turn.body["code"], "missing-key");
            assert!(events.is_empty());

            let import = serde_json::json!({ "source": "desktop-localstorage", "conversations": [
                { "externalId": "s-e2e-1", "title": "imported", "messages": [{ "role": "user", "content": "quasar lighthouse" }, { "role": "assistant", "content": "ok" }] }
            ] });
            let first = request(&ep, "POST", "/v1/conversations/import", Some(&import)).await.unwrap();
            assert_eq!((first.status, first.body["imported"].as_u64(), first.body["skipped"].as_u64()), (200, Some(1), Some(0)), "{first:?}");
            let again = request(&ep, "POST", "/v1/conversations/import", Some(&import)).await.unwrap();
            assert_eq!((again.body["imported"].as_u64(), again.body["skipped"].as_u64()), (Some(0), Some(1)), "idempotent on externalId");
            let imported_id = first.body["ids"][0].as_str().unwrap().to_string();

            let found = request(&ep, "GET", "/v1/search?q=quasar&limit=5", None).await.unwrap();
            assert_eq!(found.status, 200);
            assert_eq!(found.body["results"][0]["conversationId"], imported_id.as_str(), "{found:?}");

            let list = request(&ep, "GET", "/v1/conversations?limit=50", None).await.unwrap();
            assert!(list.body["conversations"].as_array().unwrap().len() >= 2);
            let patched = request(&ep, "PATCH", &format!("/v1/conversations/{id}"), Some(&serde_json::json!({ "model": "claude-other" }))).await.unwrap();
            assert_eq!(patched.body["conversation"]["model"], "claude-other");
            let aborted = request(&ep, "POST", &format!("/v1/conversations/{id}/abort"), None).await.unwrap();
            assert_eq!(aborted.body["aborted"], false, "nothing in flight");
            for cid in [&id, &imported_id] {
                let gone = request(&ep, "DELETE", &format!("/v1/conversations/{cid}"), None).await.unwrap();
                assert_eq!(gone.status, 204);
            }
        });
    }

    /// Streaming end-to-end against a real daemon whose OLLAMA provider is a
    /// local fake (OpenAI-compatible SSE on :11434; prompts containing "slow"
    /// stream slowly). Opt-in, same env var as `live_daemon_e2e`.
    #[test]
    #[ignore]
    fn live_daemon_stream_e2e() {
        let dir = std::env::var("BRAAVO_E2E_DAEMON_DIR").expect("set BRAAVO_E2E_DAEMON_DIR");
        let ep = read_endpoint(Path::new(&dir)).expect("daemon state + token");
        rt().block_on(async {
            let models = request(&ep, "GET", "/v1/models", None).await.unwrap();
            assert_eq!(models.body["local"]["OLLAMA"][0], "fake-llm", "{:?}", models.body);
            let created = request(&ep, "POST", "/v1/conversations", Some(&serde_json::json!({ "provider": "OLLAMA", "model": "fake-llm" }))).await.unwrap();
            let id = created.body["conversation"]["id"].as_str().unwrap().to_string();

            // 1. A full turn: user message, deltas, usage, done.
            let (_tx, rx) = oneshot::channel();
            let mut events = Vec::new();
            let reply = stream_turn(&ep, &id, "hi", rx, |e| events.push(e)).await.unwrap();
            assert_eq!(reply.status, 200, "{reply:?}");
            let names: Vec<_> = events.iter().map(|e| e.event.clone()).collect();
            assert_eq!(names.first().map(String::as_str), Some("message"), "{names:?}");
            assert_eq!(names.last().map(String::as_str), Some("done"), "{names:?}");
            let text: String = events.iter().filter(|e| e.event == "delta").filter_map(|e| e.data["text"].as_str()).collect();
            assert_eq!(text, "Hello from fake");
            assert_eq!(events.last().unwrap().data["stopReason"], "end_turn");

            // 2. Slow turn: busy while streaming, then a host-side disconnect aborts it.
            let streams = DaemonStreams::default();
            let rx = streams.register(&id).unwrap();
            let mut partial = String::new();
            let slow = stream_turn(&ep, &id, "please be slow", rx, |e| {
                if e.event == "delta" { partial.push_str(e.data["text"].as_str().unwrap_or("")); }
            });
            let probe = async {
                tokio::time::sleep(Duration::from_millis(600)).await;
                let (_tx2, rx2) = oneshot::channel();
                let busy = stream_turn(&ep, &id, "second", rx2, |_| {}).await.unwrap();
                assert!(streams.cancel(&id));
                busy
            };
            let (slow_reply, busy) = futures_util::future::join(slow, probe).await;
            assert_eq!(busy.status, 409, "{busy:?}");
            assert_eq!(busy.body["code"], "busy");
            assert_eq!(slow_reply.unwrap().status, 499);
            assert!(!partial.is_empty());

            // The daemon kept the partial answer as an aborted assistant message.
            tokio::time::sleep(Duration::from_millis(300)).await;
            let got = request(&ep, "GET", &format!("/v1/conversations/{id}"), None).await.unwrap();
            let messages = got.body["messages"].as_array().unwrap();
            let last = messages.last().unwrap();
            assert_eq!(last["role"], "assistant", "{messages:?}");
            assert_eq!(last["stopReason"], "aborted", "{messages:?}");
            assert!(last["content"].as_str().unwrap().starts_with("w0 "));

            // 3. Graceful abort over the API while a slow turn streams: done(aborted).
            let (_tx3, rx3) = oneshot::channel();
            let mut tail = Vec::new();
            let slow2 = stream_turn(&ep, &id, "slow again", rx3, |e| tail.push(e));
            let aborter = async {
                tokio::time::sleep(Duration::from_millis(400)).await;
                request(&ep, "POST", &format!("/v1/conversations/{id}/abort"), None).await.unwrap()
            };
            let (r2, aborted) = futures_util::future::join(slow2, aborter).await;
            assert_eq!(aborted.body["aborted"], true, "{aborted:?}");
            assert_eq!(r2.unwrap().status, 200);
            assert_eq!(tail.last().unwrap().event, "done", "{tail:?}");
            assert_eq!(tail.last().unwrap().data["stopReason"], "aborted");

            assert_eq!(request(&ep, "DELETE", &format!("/v1/conversations/{id}"), None).await.unwrap().status, 204);
        });
    }

    #[test]
    fn turn_validation() {
        assert!(validate_turn("cv_1", "hi").is_ok());
        assert!(validate_turn("cv_1", "").is_err());
        assert!(validate_turn("../x", "hi").is_err());
        assert!(validate_turn("cv_1", &"a".repeat(MAX_CONTENT_CHARS + 1)).is_err());
        assert!(validate_turn("cv_1", &"ğ".repeat(MAX_CONTENT_CHARS)).is_ok(), "counted in characters, not bytes");
    }
}
