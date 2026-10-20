//! Bounded retention, concurrent pipe draining. Never holds a gate lock.
use std::{io::Read, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}};
pub const OUTPUT_LIMIT: usize = 1_048_576;
#[derive(Clone, Default)]
pub struct Capture(Arc<Mutex<Vec<u8>>>, Arc<AtomicBool>);
impl Capture {
    pub fn text(&self) -> String {
        let mut text = String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned();
        if text.len() > OUTPUT_LIMIT { let mut end = OUTPUT_LIMIT; while !text.is_char_boundary(end) { end -= 1; } text.truncate(end); }
        text
    }
    pub fn finish(&self) -> (String, bool) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(100);
        while !self.1.load(Ordering::SeqCst) && std::time::Instant::now() < deadline { std::thread::sleep(std::time::Duration::from_millis(1)); }
        (self.text(), !self.1.load(Ordering::SeqCst))
    }
    fn push(&self, bytes: &[u8]) -> bool {
        let mut data = self.0.lock().unwrap();
        let remaining = OUTPUT_LIMIT.saturating_sub(data.len());
        data.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
        bytes.len() > remaining
    }
}
pub fn drain(mut input: impl Read + Send + 'static, cancel: Arc<AtomicBool>) -> Capture {
    let capture = Capture::default();
    let saved = capture.clone();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match input.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => if saved.push(&chunk[..n]) { cancel.store(true, Ordering::SeqCst); break; },
            }
        }
        saved.1.store(true, Ordering::SeqCst);
    });
    capture
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn retention_is_bounded_and_limit_is_visible() {
        let capture = Capture::default();
        assert!(!capture.push(&vec![b'x'; OUTPUT_LIMIT]));
        assert!(capture.push(b"overflow"));
        assert_eq!(capture.text().len(), OUTPUT_LIMIT);
    }
    #[test] fn utf8_text_is_safe_at_a_cut_boundary() {
        let capture = Capture::default(); capture.push(&[0xC3]);
        assert_eq!(capture.text(), "�");
    }
}

/// One bounded stdin queue plus a one-element acknowledgement channel. The
/// calling RPC loop keeps enforcing cancellation/deadline while OS write blocks.
/// No join is required during teardown: closing queue + killing/reaping the
/// direct child releases the ordinary pipe; descendants remain an explicit
/// platform acceptance limitation rather than an unbounded IPC wait.
pub struct Writer {
    queue: std::sync::mpsc::SyncSender<Vec<u8>>,
    ack: std::sync::mpsc::Receiver<Result<(), String>>,
}
impl Writer {
    pub fn new(mut output: impl std::io::Write + Send + 'static) -> Self {
        let (queue, incoming) = std::sync::mpsc::sync_channel::<Vec<u8>>(1);
        let (finished, ack) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            while let Ok(bytes) = incoming.recv() {
                let result = output.write_all(&bytes).map_err(|_| "MCP stdin write failed".to_string());
                let failed = result.is_err();
                if finished.send(result).is_err() || failed { break; }
            }
        });
        Self { queue, ack }
    }
    pub fn send(&self, bytes: Vec<u8>, deadline: std::time::Instant, cancel: &AtomicBool) -> Result<(), String> {
        if cancel.load(Ordering::SeqCst) { return Err("MCP write cancelled".into()); }
        if bytes.len() > OUTPUT_LIMIT { return Err("MCP write limit exceeded".into()); }
        if std::time::Instant::now() >= deadline { return Err("MCP stdin deadline exceeded".into()); }
        self.queue.try_send(bytes).map_err(|_| "MCP stdin queue unavailable")?;
        loop {
            if cancel.load(Ordering::SeqCst) { return Err("MCP write cancelled".into()); }
            let now = std::time::Instant::now();
            if now >= deadline { return Err("MCP stdin deadline exceeded".into()); }
            match self.ack.recv_timeout((deadline - now).min(std::time::Duration::from_millis(25))) {
                Ok(result) => return result,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => return Err("MCP stdin writer stopped".into()),
            }
        }
    }
}
#[cfg(test)] mod writer_tests {
    use super::*;
    struct HeldPipe(std::sync::mpsc::Receiver<()>);
    impl std::io::Write for HeldPipe {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> { let _ = self.0.recv(); Ok(bytes.len()) }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }
    #[test] fn blocked_write_does_not_block_the_callers_deadline() {
        let (release, held) = std::sync::mpsc::channel();
        let writer = Writer::new(HeldPipe(held));
        let result = writer.send(b"request".to_vec(), std::time::Instant::now() + std::time::Duration::from_millis(10), &AtomicBool::new(false));
        assert!(result.unwrap_err().contains("deadline"));
        drop(writer); let _ = release.send(()); // unblock the owned test worker
    }
    #[test] fn cancelled_write_never_enters_the_queue() {
        let output = Vec::<u8>::new(); let writer = Writer::new(output);
        assert!(writer.send(vec![1], std::time::Instant::now() + std::time::Duration::from_secs(1), &AtomicBool::new(true)).unwrap_err().contains("cancelled"));
    }
    #[test] fn legitimate_write_receives_one_acknowledgement() {
        let writer = Writer::new(Vec::<u8>::new());
        assert!(writer.send(b"JSON\\n".to_vec(), std::time::Instant::now() + std::time::Duration::from_secs(1), &AtomicBool::new(false)).is_ok());
    }
}
