//! Plan 5.8: governed computer control (macOS first).
//!
//! The host side of src/computer.ts. The webview asks the gate for approval; this module is
//! the enforcement point:
//! - the never-controllable apps and blocked key combinations (mirrored in computer.ts; a TS
//!   test keeps the lists equal),
//! - the user's allow list (`~/.braavo/computer.json` → `{"allowApps": ["com.apple.Notes"]}`),
//! - the session (started by the user; at most 50 actions and 15 minutes),
//! - bringing the approved app to the front and refusing when it does not stay there,
//! - refusing to type into a password field,
//! - the actual screenshot (`screencapture`) and input (CGEvent).
//!
//! Screen Recording and Accessibility are the user's to grant in System Settings; the app
//! only reports their state and opens the right pane.

use std::time::{Duration, Instant};

use serde::Serialize;

pub const SESSION_MAX_ACTIONS: u32 = 50;
pub const SESSION_MAX_SECS: u64 = 15 * 60;

pub const BLOCKED_APPS: &[&str] = &[
    "com.apple.systempreferences", "com.apple.Settings", "com.apple.keychainaccess", "com.apple.Passwords",
    "com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "org.alacritty", "net.kovidgoyal.kitty",
    "com.mitchellh.ghostty", "com.github.wez.wezterm", "co.zeit.hyper", "com.apple.ScriptEditor2", "com.apple.Automator",
    "com.apple.shortcuts", "com.apple.AppStore", "com.apple.ActivityMonitor", "com.apple.DiskUtility", "com.apple.installer",
    "com.apple.MigrateAssistant", "com.apple.SecurityAgent", "com.apple.loginwindow", "com.apple.LocalAuthentication.UIAgent",
    "com.apple.coreautha", "com.apple.UserNotificationCenter", "com.apple.Passbook",
    "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop", "com.lastpass.LastPass",
    "com.dashlane.dashlanephonefinal", "org.keepassxc.keepassxc", "com.yubico.yubioath",
    "com.braavolabs.desktop",
];

pub const BROWSER_PREFIXES: &[&str] = &[
    "com.apple.Safari", "com.google.Chrome", "org.mozilla.firefox", "com.microsoft.edgemac", "com.brave.Browser",
    "company.thebrowser.", "com.operasoftware.", "com.vivaldi.", "org.chromium.", "app.zen-browser.",
];

/// Words that mark a finance or identity app (lower-case; matched against bundle id and name).
pub const FINANCE_IDENTITY_WORDS: &[&str] = &[
    "bank", "banka", "wallet", "cüzdan", "cuzdan", "crypto", "kripto", "coin", "paypal", "revolut", "ledger", "trezor",
    "exodus", "kraken", "robinhood", "broker", "borsa", "trading", "edevlet", "e-devlet", "devlet", "identity", "kimlik",
    "passport", "pasaport", "authenticator",
];
/// Whole-word only (they are common inside other words).
pub const FINANCE_IDENTITY_WHOLE: &[&str] = &["wise", "gov"];

pub const BLOCKED_KEYS: &[&str] = &["cmd+space", "ctrl+space", "cmd+alt+escape", "cmd+ctrl+q", "cmd+shift+q", "cmd+alt+shift+q", "cmd+ctrl+power", "cmd+alt+power"];

fn words(s: &str) -> Vec<String> {
    s.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(String::from).collect()
}

/// Why an app can never be controlled (static text for the gate), or None.
pub fn blocked_reason(bundle_id: Option<&str>, name: Option<&str>) -> Option<&'static str> {
    let id = match bundle_id {
        Some(id) if !id.trim().is_empty() => id.trim(),
        _ => return Some("computer control needs the target app"),
    };
    if BLOCKED_APPS.iter().any(|b| b.eq_ignore_ascii_case(id)) {
        return Some("this app cannot be controlled (system, security or Braavolabs itself)");
    }
    if BROWSER_PREFIXES.iter().any(|p| id.starts_with(p)) {
        return Some("web pages are driven only through the Braavo browser, whose URL policy blocks banking, payment and government sites");
    }
    for s in [Some(id), name].into_iter().flatten() {
        let lower = s.to_lowercase();
        if FINANCE_IDENTITY_WORDS.iter().any(|w| lower.contains(w)) || words(s).iter().any(|w| FINANCE_IDENTITY_WHOLE.contains(&w.as_str())) {
            return Some("this looks like a finance or identity app and cannot be controlled");
        }
    }
    None
}

/// The gate's hard-deny for computer.* (before anything is surfaced for approval).
pub fn deny_reason(app: Option<&str>, interact_kind: Option<&str>, value: Option<&str>) -> Option<&'static str> {
    if let Some(r) = blocked_reason(app, None) {
        return Some(r);
    }
    if interact_kind == Some("key") && BLOCKED_KEYS.contains(&value.unwrap_or("")) {
        return Some("launcher or log-out key combination blocked");
    }
    None
}

/// `{"allowApps": [...]}` from ~/.braavo/computer.json; anything malformed reads as empty.
pub fn parse_allow(text: Option<&str>) -> Vec<String> {
    let v: serde_json::Value = text.and_then(|t| serde_json::from_str(t).ok()).unwrap_or_default();
    v.get("allowApps")
        .and_then(|a| a.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).map(|s| s.trim().to_string()).filter(|s| is_bundle_id(s)).take(100).collect())
        .unwrap_or_default()
}

pub fn is_bundle_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 200 && s.contains('.') && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

// ── session ─────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct Session {
    pub id: String,
    pub started: Instant,
    pub actions: u32,
    pub read_granted: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub id: String,
    pub actions: u32,
    pub max_actions: u32,
    pub remaining_secs: u64,
    pub read_granted: bool,
}

impl Session {
    pub fn new(id: String) -> Self {
        Session { id, started: Instant::now(), actions: 0, read_granted: false }
    }
    /// Why the session cannot take another action, or None.
    pub fn exhausted(&self) -> Option<&'static str> {
        if self.started.elapsed() >= Duration::from_secs(SESSION_MAX_SECS) {
            return Some("the computer-control session ended (15 minutes)");
        }
        if self.actions >= SESSION_MAX_ACTIONS {
            return Some("the computer-control session ended (50 actions)");
        }
        None
    }
    pub fn view(&self) -> SessionView {
        SessionView {
            id: self.id.clone(),
            actions: self.actions,
            max_actions: SESSION_MAX_ACTIONS,
            remaining_secs: SESSION_MAX_SECS.saturating_sub(self.started.elapsed().as_secs()),
            read_granted: self.read_granted,
        }
    }
}

// ── keys ────────────────────────────────────────────────────────────────────

/// macOS virtual key codes (ANSI layout) for the keys an agent may press.
pub fn key_code(name: &str) -> Option<u16> {
    let letters = [
        ("a", 0), ("s", 1), ("d", 2), ("f", 3), ("h", 4), ("g", 5), ("z", 6), ("x", 7), ("c", 8), ("v", 9), ("b", 11),
        ("q", 12), ("w", 13), ("e", 14), ("r", 15), ("y", 16), ("t", 17), ("1", 18), ("2", 19), ("3", 20), ("4", 21),
        ("6", 22), ("5", 23), ("=", 24), ("9", 25), ("7", 26), ("-", 27), ("8", 28), ("0", 29), ("]", 30), ("o", 31),
        ("u", 32), ("[", 33), ("i", 34), ("p", 35), ("l", 37), ("j", 38), ("'", 39), ("k", 40), (";", 41), ("\\", 42),
        (",", 43), ("/", 44), ("n", 45), ("m", 46), (".", 47), ("`", 50),
        ("return", 36), ("tab", 48), ("space", 49), ("delete", 51), ("backspace", 51), ("escape", 53),
        ("forwarddelete", 117), ("home", 115), ("end", 119), ("pageup", 116), ("pagedown", 121),
        ("left", 123), ("right", 124), ("down", 125), ("up", 126),
        ("f1", 122), ("f2", 120), ("f3", 99), ("f4", 118), ("f5", 96), ("f6", 97), ("f7", 98), ("f8", 100),
    ];
    letters.iter().find(|(n, _)| *n == name).map(|(_, c)| *c)
}

/// "cmd+shift+s" → (modifier flags, key code). Modifiers: cmd, ctrl, alt, shift.
pub fn parse_combo(combo: &str) -> Option<(u64, u16)> {
    let mut flags = 0u64;
    let mut key = None;
    for part in combo.split('+') {
        match part {
            "cmd" => flags |= 0x0010_0000,
            "ctrl" => flags |= 0x0004_0000,
            "alt" => flags |= 0x0008_0000,
            "shift" => flags |= 0x0002_0000,
            other => {
                if key.is_some() {
                    return None;
                }
                key = Some(key_code(other)?);
            }
        }
    }
    key.map(|k| (flags, k))
}

/// Width and height from a PNG's IHDR chunk.
pub fn png_size(png: &[u8]) -> Option<(u32, u32)> {
    if png.len() < 24 || &png[1..4] != b"PNG" {
        return None;
    }
    Some((u32::from_be_bytes(png[16..20].try_into().ok()?), u32::from_be_bytes(png[20..24].try_into().ok()?)))
}

// ── macOS host ──────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
pub mod host {
    use core_foundation::base::{CFGetTypeID, CFRelease, CFTypeRef, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::{CFString, CFStringRef};
    use core_graphics::display::CGDisplay;
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField, ScrollEventUnit};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use core_graphics::geometry::CGPoint;
    use std::process::Command;
    use std::time::{Duration, Instant};

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
        fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> u8;
        fn AXUIElementCreateSystemWide() -> CFTypeRef;
        fn AXUIElementCopyAttributeValue(element: CFTypeRef, attribute: CFStringRef, value: *mut CFTypeRef) -> i32;
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> u8;
        fn CGRequestScreenCaptureAccess() -> u8;
    }

    pub fn accessibility_granted() -> bool {
        unsafe { AXIsProcessTrusted() != 0 }
    }
    pub fn screen_granted() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() != 0 }
    }
    /// Ask macOS to list the app in the pane (and show its own prompt once).
    pub fn request_accessibility() -> bool {
        let opts = CFDictionary::from_CFType_pairs(&[(CFString::new("AXTrustedCheckOptionPrompt"), CFBoolean::true_value())]);
        unsafe { AXIsProcessTrustedWithOptions(opts.as_CFTypeRef()) != 0 }
    }
    pub fn request_screen() -> bool {
        unsafe { CGRequestScreenCaptureAccess() != 0 }
    }
    pub fn open_settings(pane: &str) -> Result<(), String> {
        let anchor = if pane == "screen" { "Privacy_ScreenCapture" } else { "Privacy_Accessibility" };
        Command::new("/usr/bin/open")
            .arg(format!("x-apple.systempreferences:com.apple.preference.security?{anchor}"))
            .status()
            .map_err(|e| e.to_string())
            .map(|_| ())
    }

    /// (bundle id, name) of the frontmost app.
    pub fn frontmost() -> Option<(String, String)> {
        use objc2_app_kit::NSWorkspace;
        let ws = NSWorkspace::sharedWorkspace();
        let app = ws.frontmostApplication()?;
        let id = app.bundleIdentifier().map(|s| s.to_string()).unwrap_or_default();
        let name = app.localizedName().map(|s| s.to_string()).unwrap_or_default();
        Some((id, name))
    }

    /// Regular (Dock) apps that are running: (bundle id, name).
    pub fn running_apps() -> Vec<(String, String)> {
        use objc2_app_kit::{NSApplicationActivationPolicy, NSWorkspace};
        let ws = NSWorkspace::sharedWorkspace();
        let mut out: Vec<(String, String)> = ws
            .runningApplications()
            .iter()
            .filter(|a| a.activationPolicy() == NSApplicationActivationPolicy::Regular)
            .filter_map(|a| Some((a.bundleIdentifier()?.to_string(), a.localizedName().map(|s| s.to_string()).unwrap_or_default())))
            .collect();
        out.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()));
        out.dedup_by(|a, b| a.0 == b.0);
        out
    }

    /// Bring the approved app forward (LaunchServices, no Automation prompt) and wait until
    /// it really is frontmost. False when it does not get there within 1.5 s.
    pub fn bring_forward(bundle_id: &str) -> bool {
        if frontmost().map(|(id, _)| id == bundle_id).unwrap_or(false) {
            return true;
        }
        if Command::new("/usr/bin/open").args(["-b", bundle_id]).status().map(|s| !s.success()).unwrap_or(true) {
            return false;
        }
        let until = Instant::now() + Duration::from_millis(1500);
        while Instant::now() < until {
            std::thread::sleep(Duration::from_millis(100));
            if frontmost().map(|(id, _)| id == bundle_id).unwrap_or(false) {
                // Let the window settle before the event lands.
                std::thread::sleep(Duration::from_millis(150));
                return true;
            }
        }
        false
    }

    fn ax_string(el: CFTypeRef, name: &str) -> Option<String> {
        let mut v: CFTypeRef = std::ptr::null();
        let attr = CFString::new(name);
        let err = unsafe { AXUIElementCopyAttributeValue(el, attr.as_concrete_TypeRef(), &mut v) };
        if err != 0 || v.is_null() {
            return None;
        }
        unsafe {
            if CFGetTypeID(v) == CFString::type_id() {
                Some(CFString::wrap_under_create_rule(v as CFStringRef).to_string())
            } else {
                CFRelease(v);
                None
            }
        }
    }

    /// True when the focused element is a password field — or when that cannot be told
    /// (no Accessibility): typing is refused then (fail-closed).
    pub fn focused_is_secure() -> bool {
        if !accessibility_granted() {
            return true;
        }
        unsafe {
            let sys = AXUIElementCreateSystemWide();
            if sys.is_null() {
                return true;
            }
            let mut focused: CFTypeRef = std::ptr::null();
            let attr = CFString::new("AXFocusedUIElement");
            let err = AXUIElementCopyAttributeValue(sys, attr.as_concrete_TypeRef(), &mut focused);
            CFRelease(sys);
            if err != 0 || focused.is_null() {
                return false;
            }
            let secure = ax_string(focused, "AXSubrole").as_deref() == Some("AXSecureTextField")
                || ax_string(focused, "AXRole").as_deref() == Some("AXSecureTextField");
            CFRelease(focused);
            secure
        }
    }

    /// Main display in points (the space clicks use).
    pub fn display_points() -> (f64, f64) {
        let b = CGDisplay::main().bounds();
        (b.size.width, b.size.height)
    }

    /// A PNG of the main display, through the system `screencapture` tool.
    pub fn screenshot() -> Result<Vec<u8>, String> {
        let path = std::env::temp_dir().join(format!("braavo-shot-{}.png", std::process::id()));
        let ok = Command::new("/usr/sbin/screencapture").args(["-x", "-m", "-t", "png"]).arg(&path).status().map_err(|e| e.to_string())?.success();
        let bytes = std::fs::read(&path).map_err(|e| e.to_string());
        let _ = std::fs::remove_file(&path);
        if !ok {
            return Err("screencapture failed".into());
        }
        bytes
    }

    fn source() -> Result<CGEventSource, String> {
        CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| "no event source".to_string())
    }

    pub fn click(x: f64, y: f64, kind: &str) -> Result<(), String> {
        let p = CGPoint::new(x, y);
        let (down, up, button) = if kind == "right_click" {
            (CGEventType::RightMouseDown, CGEventType::RightMouseUp, CGMouseButton::Right)
        } else {
            (CGEventType::LeftMouseDown, CGEventType::LeftMouseUp, CGMouseButton::Left)
        };
        let mv = CGEvent::new_mouse_event(source()?, CGEventType::MouseMoved, p, CGMouseButton::Left).map_err(|_| "mouse event")?;
        mv.post(CGEventTapLocation::HID);
        let clicks = if kind == "double_click" { 2 } else { 1 };
        for n in 1..=clicks {
            for t in [down, up] {
                let e = CGEvent::new_mouse_event(source()?, t, p, button).map_err(|_| "mouse event")?;
                e.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, n);
                e.post(CGEventTapLocation::HID);
            }
        }
        Ok(())
    }

    pub fn type_text(text: &str) -> Result<(), String> {
        // A unicode string per key event; chunks keep each event small.
        let chars: Vec<char> = text.chars().collect();
        for chunk in chars.chunks(16) {
            let s: String = chunk.iter().collect();
            for down in [true, false] {
                let e = CGEvent::new_keyboard_event(source()?, 0, down).map_err(|_| "key event")?;
                e.set_string(&s);
                e.post(CGEventTapLocation::HID);
            }
            std::thread::sleep(Duration::from_millis(8));
        }
        Ok(())
    }

    pub fn key(flags: u64, code: u16) -> Result<(), String> {
        for down in [true, false] {
            let e = CGEvent::new_keyboard_event(source()?, code, down).map_err(|_| "key event")?;
            e.set_flags(CGEventFlags::from_bits_truncate(flags));
            e.post(CGEventTapLocation::HID);
        }
        Ok(())
    }

    pub fn scroll(x: f64, y: f64, dx: i32, dy: i32) -> Result<(), String> {
        let mv = CGEvent::new_mouse_event(source()?, CGEventType::MouseMoved, CGPoint::new(x, y), CGMouseButton::Left).map_err(|_| "mouse event")?;
        mv.post(CGEventTapLocation::HID);
        let e = CGEvent::new_scroll_event(source()?, ScrollEventUnit::PIXEL, 2, -dy, -dx, 0).map_err(|_| "scroll event")?;
        e.post(CGEventTapLocation::HID);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_system_security_browsers_finance_and_itself() {
        for id in ["com.apple.Terminal", "com.apple.systempreferences", "com.1password.1password", "com.braavolabs.desktop", "COM.APPLE.KEYCHAINACCESS"] {
            assert!(blocked_reason(Some(id), None).is_some(), "{id}");
        }
        assert!(blocked_reason(Some("com.google.Chrome.canary"), None).unwrap().contains("Braavo browser"));
        assert!(blocked_reason(Some("com.coinbase.app"), None).is_some());
        assert!(blocked_reason(Some("com.example.app"), Some("Ziraat Bankası")).is_some());
        assert!(blocked_reason(Some("uk.gov.verify"), None).is_some());
        assert!(blocked_reason(Some("com.wise.app"), None).is_some());
        assert!(blocked_reason(Some("com.apple.Notes"), Some("Notes")).is_none());
        assert!(blocked_reason(Some("com.example.otherwise"), Some("Otherwise")).is_none());
        assert!(blocked_reason(None, None).is_some());
        assert!(blocked_reason(Some("  "), None).is_some());
    }

    #[test]
    fn denies_launcher_keys_only_for_key_actions() {
        assert!(deny_reason(Some("com.apple.Notes"), Some("key"), Some("cmd+space")).is_some());
        assert!(deny_reason(Some("com.apple.Notes"), Some("key"), Some("cmd+s")).is_none());
        assert!(deny_reason(Some("com.apple.Notes"), Some("type"), Some("cmd+space")).is_none());
    }

    #[test]
    fn reads_the_allow_list_and_drops_junk() {
        assert_eq!(parse_allow(Some(r#"{"allowApps":["com.apple.Notes"," com.apple.TextEdit ","bad id","notadot"]}"#)), vec!["com.apple.Notes", "com.apple.TextEdit"]);
        assert!(parse_allow(Some("not json")).is_empty());
        assert!(parse_allow(None).is_empty());
    }

    #[test]
    fn parses_key_combinations() {
        assert_eq!(parse_combo("cmd+shift+s"), Some((0x0010_0000 | 0x0002_0000, 1)));
        assert_eq!(parse_combo("return"), Some((0, 36)));
        assert_eq!(parse_combo("cmd+s+a"), None);
        assert_eq!(parse_combo("cmd+launchpad"), None);
        assert_eq!(parse_combo("cmd"), None);
    }

    #[test]
    fn session_limits() {
        let mut s = Session::new("cs_1".into());
        assert!(s.exhausted().is_none());
        s.actions = SESSION_MAX_ACTIONS;
        assert!(s.exhausted().unwrap().contains("50 actions"));
        let v = s.view();
        assert_eq!((v.actions, v.max_actions), (50, 50));
    }

    /// Reads the real system (frontmost app, running apps, display, permissions); sends no
    /// input. Run by hand on a Mac: cargo test host_smoke -- --ignored --nocapture
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn host_smoke() {
        let front = host::frontmost();
        let apps = host::running_apps();
        let (w, h) = host::display_points();
        println!("front={front:?} apps={} display={w}x{h} ax={} screen={} secure={}", apps.len(), host::accessibility_granted(), host::screen_granted(), host::focused_is_secure());
        assert!(front.is_some() && !apps.is_empty() && w > 0.0 && h > 0.0);
    }

    #[test]
    fn reads_png_size() {
        let mut png = vec![0x89, b'P', b'N', b'G', 13, 10, 26, 10, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
        png.extend_from_slice(&2880u32.to_be_bytes());
        png.extend_from_slice(&1800u32.to_be_bytes());
        assert_eq!(png_size(&png), Some((2880, 1800)));
        assert_eq!(png_size(b"nope"), None);
    }
}
