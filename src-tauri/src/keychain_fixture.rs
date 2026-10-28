//! Test-only synthetic credential ownership. No production store is used here.
//! This file can be tested directly with `rustc --test`, without building Tauri.
use std::panic::{catch_unwind, AssertUnwindSafe};

#[cfg(target_os = "macos")]
const SERVICE: &str = "braavolabs-desktop";
const SYNTHETIC: &[u8] = b"braavo-owned-fixture-not-a-user-secret";

struct Spec {
    account: String,
}

impl Spec {
    fn new(owner: &str, nonce: [u8; 32]) -> Result<Self, Step> {
        if owner.is_empty()
            || owner.len() > 48
            || !owner.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(Step::InvalidOwner);
        }
        let nonce: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
        Ok(Self { account: format!("test.s010.roundtrip.{owner}.{nonce}") })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    InvalidOwner,
    Collision,
    Create,
    CreateUncertain,
    Read,
    Mismatch,
    Cancelled,
    Panicked,
    Cleanup,
}

/// Implementations must add atomically, never upsert or inspect an old secret.
/// Register the newly created handle in `owned` BEFORE any subsequent fallible
/// work. A partial-create error or unwind must leave this ownership available.
trait Store {
    type Handle;
    fn create_only(&mut self, spec: &Spec, owned: &mut Option<Self::Handle>) -> Result<(), Step>;
    fn matches_synthetic(&mut self, handle: &Self::Handle) -> Result<bool, Step>;
    fn delete_owned(&mut self, handle: &Self::Handle) -> Result<(), Step>;
    /// Metadata only. A replacement item must cause failure, never deletion.
    fn account_absent(&mut self, spec: &Spec) -> Result<bool, Step>;
}

#[derive(Debug)]
struct Failure {
    account: String,
    operation: Option<Step>,
    cleanup_failed: bool,
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Backend errors, secret values, native handles and panic payloads are
        // deliberately excluded. Account identifies only this synthetic run.
        write!(f, "synthetic fixture {}: operation={:?}; cleanup_failed={}",
            self.account, self.operation, self.cleanup_failed)
    }
}

struct Guard<'a, S: Store> {
    store: &'a mut S,
    spec: Spec,
    owned: Option<S::Handle>,
}

impl<S: Store> Guard<'_, S> {
    fn cleanup(&mut self) -> Result<(), Step> {
        let Some(handle) = self.owned.as_ref() else { return Ok(()); };
        // Always check absence, even when deletion reports an error.
        let deleted = self.store.delete_owned(handle);
        let absent = self.store.account_absent(&self.spec);
        if deleted.is_err() || !matches!(absent, Ok(true)) {
            return Err(Step::Cleanup);
        }
        // Exercise idempotence on the OWNED handle, not an account selector.
        let deleted_again = self.store.delete_owned(handle);
        let absent_again = self.store.account_absent(&self.spec);
        if deleted_again.is_err() || !matches!(absent_again, Ok(true)) {
            return Err(Step::Cleanup);
        }
        self.owned = None;
        Ok(())
    }
}

impl<S: Store> Drop for Guard<'_, S> {
    fn drop(&mut self) {
        if self.owned.is_some() {
            // A final best-effort retry cannot mask the explicit cleanup error
            // or double-panic during unwinding. Never switch to name deletion.
            let _ = catch_unwind(AssertUnwindSafe(|| self.cleanup()));
        }
    }
}

fn run<S: Store>(store: &mut S, spec: Spec, cancelled: impl Fn() -> bool) -> Result<(), Failure> {
    // Guard exists before creation, including a partial write followed by error.
    let mut guard = Guard { store, spec, owned: None };
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        if cancelled() { return Err(Step::Cancelled); }
        guard.store.create_only(&guard.spec, &mut guard.owned)?;
        if guard.owned.is_none() { return Err(Step::Create); }
        if cancelled() { return Err(Step::Cancelled); }
        if !guard.store.matches_synthetic(guard.owned.as_ref().unwrap())? {
            return Err(Step::Mismatch);
        }
        if cancelled() { return Err(Step::Cancelled); }
        Ok(())
    }));
    let mut operation = match outcome {
        Ok(Ok(())) => None,
        Ok(Err(step)) => Some(step),
        Err(_) => Some(Step::Panicked),
    };
    let cleanup_failed = if operation == Some(Step::CreateUncertain) && guard.owned.is_none() {
        // A native call with an ambiguous result cannot authorize deletion.
        // Verify metadata-only absence; a present/unreachable item fails cleanup
        // and retains just its synthetic identifier for human investigation.
        !matches!(catch_unwind(AssertUnwindSafe(|| guard.store.account_absent(&guard.spec))), Ok(Ok(true)))
    } else {
        !matches!(catch_unwind(AssertUnwindSafe(|| guard.cleanup())), Ok(Ok(())))
    };
    if operation.is_none() {
        // A cancellation received during teardown still fails the run, after
        // cleanup has been checked. A predicate panic cannot skip that check.
        operation = match catch_unwind(AssertUnwindSafe(&cancelled)) {
            Ok(false) => None,
            Ok(true) => Some(Step::Cancelled),
            Err(_) => Some(Step::Panicked),
        };
    }
    if operation.is_none() && !cleanup_failed { return Ok(()); }
    Err(Failure { account: guard.spec.account.clone(), operation, cleanup_failed })
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::{ffi::c_void, os::raw::{c_char, c_int}, ptr, sync::atomic::{AtomicBool, Ordering}};

    const NOT_FOUND: i32 = -25300;
    const DUPLICATE: i32 = -25299;
    const INVALID_ITEM: i32 = -25304;

    // Test-only declarations match the installed macOS SDK headers. Atomic
    // SecKeychainAddGenericPassword returns DUPLICATE without replacing data.
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecKeychainAddGenericPassword(keychain: *const c_void, service_len: u32,
            service: *const c_char, account_len: u32, account: *const c_char,
            secret_len: u32, secret: *const c_void, item: *mut *mut c_void) -> i32;
        fn SecKeychainFindGenericPassword(keychains: *const c_void, service_len: u32,
            service: *const c_char, account_len: u32, account: *const c_char,
            secret_len: *mut u32, secret: *mut *mut c_void, item: *mut *mut c_void) -> i32;
        fn SecKeychainItemCopyContent(item: *const c_void, class: *mut u32,
            attributes: *mut c_void, length: *mut u32, data: *mut *mut c_void) -> i32;
        fn SecKeychainItemFreeContent(attributes: *mut c_void, data: *mut c_void) -> i32;
        fn SecKeychainItemDelete(item: *const c_void) -> i32;
        fn SecRandomCopyBytes(random: *const c_void, length: usize, bytes: *mut c_void) -> c_int;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" { fn CFRelease(value: *const c_void); }

    struct Item(*mut c_void);
    impl Drop for Item { fn drop(&mut self) { unsafe { CFRelease(self.0); } } }
    struct MacStore;
    impl Store for MacStore {
        type Handle = Item;
        fn create_only(&mut self, spec: &Spec, owned: &mut Option<Item>) -> Result<(), Step> {
            // Metadata-only collision check also covers another search-list
            // keychain. The following atomic add remains the race barrier for
            // the default keychain; this preflight never grants ownership.
            if !self.account_absent(spec).map_err(|_| Step::Create)? {
                return Err(Step::Collision);
            }
            let mut item = ptr::null_mut();
            let status = unsafe { SecKeychainAddGenericPassword(ptr::null(),
                SERVICE.len() as u32, SERVICE.as_ptr().cast(),
                spec.account.len() as u32, spec.account.as_ptr().cast(),
                SYNTHETIC.len() as u32, SYNTHETIC.as_ptr().cast(), &mut item) };
            if status == DUPLICATE { return Err(Step::Collision); }
            if status != 0 || item.is_null() { return Err(Step::CreateUncertain); }
            // Only a successful add establishes ownership. No further operation
            // can look up/delete a different credential by its account name.
            *owned = Some(Item(item));
            Ok(())
        }
        fn matches_synthetic(&mut self, item: &Item) -> Result<bool, Step> {
            let mut length = 0;
            let mut data = ptr::null_mut();
            let status = unsafe { SecKeychainItemCopyContent(item.0, ptr::null_mut(),
                ptr::null_mut(), &mut length, &mut data) };
            if status != 0 { return Err(Step::Read); }
            let matches = !data.is_null() && length as usize == SYNTHETIC.len()
                && unsafe { std::slice::from_raw_parts(data.cast::<u8>(), length as usize) } == SYNTHETIC;
            let freed = unsafe { SecKeychainItemFreeContent(ptr::null_mut(), data) };
            if freed != 0 { return Err(Step::Read); }
            Ok(matches)
        }
        fn delete_owned(&mut self, item: &Item) -> Result<(), Step> {
            match unsafe { SecKeychainItemDelete(item.0) } {
                0 | NOT_FOUND | INVALID_ITEM => Ok(()),
                _ => Err(Step::Cleanup),
            }
        }
        fn account_absent(&mut self, spec: &Spec) -> Result<bool, Step> {
            // NULL password outputs: even a colliding replacement's secret is
            // never fetched. No reference is returned or adopted from a query.
            match unsafe { SecKeychainFindGenericPassword(ptr::null(),
                SERVICE.len() as u32, SERVICE.as_ptr().cast(), spec.account.len() as u32,
                spec.account.as_ptr().cast(), ptr::null_mut(), ptr::null_mut(), ptr::null_mut()) } {
                NOT_FOUND => Ok(true),
                0 => Ok(false),
                _ => Err(Step::Cleanup),
            }
        }
    }

    static CANCELLED: AtomicBool = AtomicBool::new(false);
    extern "C" fn cancel(_: c_int) { CANCELLED.store(true, Ordering::Relaxed); }
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct Sigaction { handler: usize, mask: u32, flags: c_int }
    extern "C" { fn sigaction(signal: c_int, action: *const Sigaction, previous: *mut Sigaction) -> c_int; }
    struct Signals(Vec<(c_int, Sigaction)>);
    impl Drop for Signals {
        fn drop(&mut self) {
            for (signal, action) in self.0.iter().rev() {
                unsafe { sigaction(*signal, action, ptr::null_mut()); }
            }
        }
    }
    impl Signals {
        fn install() -> Result<Self, &'static str> {
            CANCELLED.store(false, Ordering::Relaxed);
            let mut signals = Signals(Vec::with_capacity(2));
            for signal in [2, 15] { // SDK SIGINT / SIGTERM; cooperative cleanup.
                let action = Sigaction { handler: cancel as *const () as usize, ..Sigaction::default() };
                let mut previous = Sigaction::default();
                if unsafe { sigaction(signal, &action, &mut previous) } != 0 {
                    return Err("could not install fixture cancellation handler");
                }
                signals.0.push((signal, previous));
            }
            Ok(signals)
        }
    }

    /// OS primitive acceptance only; not production auth/BYOK persistence.
    #[test]
    #[ignore = "requires explicit authorization for one new synthetic Keychain item"]
    fn keychain_roundtrip() {
        assert_eq!(std::env::var("BRAAVO_SYNTHETIC_KEYCHAIN_TEST").as_deref(),
            Ok("allow-one-owned-fixture"), "explicit synthetic fixture opt-in required");
        let _signals = Signals::install().expect("fixture cancellation setup failed before creation");
        let mut nonce = [0u8; 32];
        assert_eq!(unsafe { SecRandomCopyBytes(ptr::null(), nonce.len(), nonce.as_mut_ptr().cast()) },
            0, "fixture nonce generation failed before creation");
        let spec = Spec::new("desktop-keychain-test", nonce).expect("static task owner is valid");
        if let Err(failure) = run(&mut MacStore, spec, || CANCELLED.load(Ordering::Relaxed)) {
            panic!("{failure}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, collections::BTreeMap};

    #[derive(Default)]
    struct Mock {
        // Identity is distinct from account: replacement cannot inherit a handle.
        entries: BTreeMap<u64, (String, Vec<u8>)>,
        next: u64,
        calls: Vec<&'static str>,
        fault: &'static str,
        fail_delete: bool,
        panic_delete_once: bool,
    }
    impl Store for Mock {
        type Handle = u64;
        fn create_only(&mut self, spec: &Spec, owned: &mut Option<u64>) -> Result<(), Step> {
            self.calls.push("create");
            if self.entries.values().any(|(account, _)| account == &spec.account) {
                return Err(Step::Collision);
            }
            if self.fault == "create" { return Err(Step::Create); }
            self.next += 1;
            self.entries.insert(self.next, (spec.account.clone(), SYNTHETIC.to_vec()));
            if self.fault == "ambiguous-create" { return Err(Step::CreateUncertain); }
            *owned = Some(self.next);
            if self.fault == "partial-create" { return Err(Step::Create); }
            if self.fault == "panic-create" { panic!("injected owned-create panic"); }
            Ok(())
        }
        fn matches_synthetic(&mut self, handle: &u64) -> Result<bool, Step> {
            self.calls.push("read-owned");
            match self.fault {
                "read" => Err(Step::Read),
                "mismatch" => Ok(false),
                "panic-read" => panic!("injected owned-read panic"),
                "replacement" => {
                    let (account, _) = self.entries.remove(handle).unwrap();
                    self.entries.insert(999, (account, b"foreign-value-must-not-be-read".to_vec()));
                    Err(Step::Read)
                }
                _ => Ok(self.entries.get(handle).unwrap().1 == SYNTHETIC),
            }
        }
        fn delete_owned(&mut self, handle: &u64) -> Result<(), Step> {
            self.calls.push("delete-owned");
            if self.panic_delete_once {
                self.panic_delete_once = false;
                panic!("injected cleanup panic");
            }
            if self.fault == "delete" || self.fail_delete { return Err(Step::Cleanup); }
            if self.fault != "lying-delete" { self.entries.remove(handle); }
            Ok(())
        }
        fn account_absent(&mut self, spec: &Spec) -> Result<bool, Step> {
            self.calls.push("absent-metadata");
            if self.fault == "absent" { return Err(Step::Cleanup); }
            Ok(!self.entries.values().any(|(account, _)| account == &spec.account))
        }
    }
    fn spec() -> Spec { Spec::new("mock-task", [7; 32]).unwrap() }

    #[test]
    fn owner_and_nonce_bind_the_account_and_exclude_production_names() {
        let a = spec();
        assert!(a.account.starts_with("test.s010.roundtrip.mock-task."));
        assert_eq!(a.account.len(), "test.s010.roundtrip.mock-task.".len() + 64);
        assert_ne!(a.account, Spec::new("other-task", [7; 32]).unwrap().account);
        assert_ne!(a.account, Spec::new("mock-task", [8; 32]).unwrap().account);
        for bad in ["", "auth.token", "auth.refreshToken", "byok.openai", "../x", "UPPER"] {
            assert!(matches!(Spec::new(bad, [0; 32]), Err(Step::InvalidOwner)));
        }
        assert!(Spec::new(&"a".repeat(49), [0; 32]).is_err());
    }
    #[test]
    fn success_checks_both_deletion_and_idempotent_absence() {
        let mut mock = Mock::default();
        run(&mut mock, spec(), || false).unwrap();
        assert!(mock.entries.is_empty());
        assert_eq!(mock.calls, ["create", "read-owned", "delete-owned", "absent-metadata",
            "delete-owned", "absent-metadata"]);
    }
    #[test]
    fn collision_does_not_read_write_delete_or_adopt_the_existing_item() {
        let mut mock = Mock::default();
        mock.entries.insert(999, (spec().account, b"existing-private-value".to_vec()));
        let snapshot = mock.entries.clone();
        let error = run(&mut mock, spec(), || false).unwrap_err();
        assert_eq!(error.operation, Some(Step::Collision));
        assert!(!error.cleanup_failed);
        assert_eq!(mock.entries, snapshot);
        assert_eq!(mock.calls, ["create"]);
    }
    #[test]
    fn ambiguous_creation_never_claims_or_deletes_an_unowned_item() {
        let mut mock = Mock { fault: "ambiguous-create", ..Mock::default() };
        let error = run(&mut mock, spec(), || false).unwrap_err();
        assert_eq!(error.operation, Some(Step::CreateUncertain));
        assert!(error.cleanup_failed);
        assert_eq!(mock.calls, ["create", "absent-metadata"]);
        assert_eq!(mock.entries.len(), 1);
    }
    #[test]
    fn errors_and_unwind_after_owned_creation_still_verify_cleanup() {
        for (fault, expected) in [("create", Step::Create), ("partial-create", Step::Create),
            ("panic-create", Step::Panicked), ("read", Step::Read),
            ("mismatch", Step::Mismatch), ("panic-read", Step::Panicked)] {
            let mut mock = Mock { fault, ..Mock::default() };
            let error = run(&mut mock, spec(), || false).unwrap_err();
            assert_eq!(error.operation, Some(expected), "{fault}");
            assert!(!error.cleanup_failed, "{fault}");
            assert!(mock.entries.is_empty(), "{fault}");
            assert_eq!(mock.calls.contains(&"absent-metadata"), fault != "create", "{fault}");
        }
    }
    #[test]
    fn cancellation_before_create_after_create_after_read_and_during_cleanup_is_clean() {
        for cancel_at in 1..=4 {
            let mut mock = Mock::default();
            let checks = Cell::new(0);
            let error = run(&mut mock, spec(), || {
                checks.set(checks.get() + 1); checks.get() == cancel_at
            }).unwrap_err();
            assert_eq!(error.operation, Some(Step::Cancelled));
            assert!(!error.cleanup_failed);
            assert!(mock.entries.is_empty());
            assert_eq!(mock.calls.contains(&"create"), cancel_at != 1);
            assert_eq!(mock.calls.contains(&"absent-metadata"), cancel_at != 1);
        }
    }
    #[test]
    fn a_cancellation_predicate_panic_does_not_skip_owned_cleanup() {
        for panic_at in 1..=4 {
            let mut mock = Mock::default();
            let checks = Cell::new(0);
            let error = run(&mut mock, spec(), || {
                checks.set(checks.get() + 1);
                assert_ne!(checks.get(), panic_at, "injected cancellation panic");
                false
            }).unwrap_err();
            assert_eq!(error.operation, Some(Step::Panicked));
            assert!(!error.cleanup_failed);
            assert!(mock.entries.is_empty());
        }
    }
    #[test]
    fn operation_and_cleanup_failures_are_both_reported() {
        let mut mock = Mock { fault: "read", fail_delete: true, ..Mock::default() };
        let error = run(&mut mock, spec(), || false).unwrap_err();
        assert_eq!(error.operation, Some(Step::Read));
        assert!(error.cleanup_failed);
        assert_eq!(mock.entries.len(), 1);
        assert!(mock.calls.contains(&"absent-metadata"));
    }
    #[test]
    fn a_cleanup_panic_fails_the_run_and_drop_retries_only_its_handle() {
        let mut mock = Mock { panic_delete_once: true, ..Mock::default() };
        let error = run(&mut mock, spec(), || false).unwrap_err();
        assert!(error.cleanup_failed);
        assert_eq!(error.operation, None);
        assert!(mock.entries.is_empty());
        assert_eq!(mock.calls.iter().filter(|call| **call == "delete-owned").count(), 3);
    }
    #[test]
    fn cleanup_errors_and_false_absence_never_report_success() {
        for fault in ["delete", "lying-delete", "absent"] {
            let mut mock = Mock { fault, ..Mock::default() };
            let error = run(&mut mock, spec(), || false).unwrap_err();
            assert!(error.cleanup_failed, "{fault}");
            assert_eq!(error.operation, None);
            assert!(mock.calls.contains(&"absent-metadata"));
            assert!(error.to_string().contains(&spec().account));
            assert!(!error.to_string().contains(std::str::from_utf8(SYNTHETIC).unwrap()));
        }
    }
    #[test]
    fn replacement_is_never_deleted_and_its_value_is_never_returned() {
        let mut mock = Mock { fault: "replacement", ..Mock::default() };
        let error = run(&mut mock, spec(), || false).unwrap_err();
        assert!(error.cleanup_failed);
        assert_eq!(mock.entries.len(), 1);
        assert!(mock.entries.contains_key(&999));
        assert!(!error.to_string().contains("foreign-value"));
    }
    #[test]
    fn early_scope_drop_cleans_only_the_registered_item() {
        let mut mock = Mock::default();
        mock.entries.insert(999, ("auth.token".into(), b"untouched".to_vec()));
        {
            let mut guard = Guard { store: &mut mock, spec: spec(), owned: None };
            guard.store.create_only(&guard.spec, &mut guard.owned).unwrap();
        }
        assert_eq!(mock.entries.len(), 1);
        assert_eq!(mock.entries[&999].0, "auth.token");
        assert!(mock.calls.contains(&"absent-metadata"));
    }
}
