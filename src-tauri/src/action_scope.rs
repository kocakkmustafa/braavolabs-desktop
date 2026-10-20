//! Host-owned approval lifetime. No renderer clock, account label or revision
//! participates in this authority. Kept std-only for isolated unit tests.
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Default)]
pub struct Scope {
    epoch: u64,
    registry: u64,
}

#[derive(Clone, Copy)]
pub struct Stamp {
    epoch: u64,
    registry: u64,
    expires: Instant,
}

impl Scope {
    pub fn stamp(&self, lifetime: Duration) -> Stamp {
        self.stamp_at(Instant::now(), lifetime)
    }
    fn stamp_at(&self, now: Instant, lifetime: Duration) -> Stamp {
        Stamp { epoch: self.epoch, registry: self.registry, expires: now + lifetime }
    }
    pub fn revoke(&mut self) { self.epoch = self.epoch.checked_add(1).expect("approval epoch exhausted"); }
    pub fn registry_changed(&mut self) { self.registry = self.registry.checked_add(1).expect("registry epoch exhausted"); }
    pub fn current(&self, stamp: Stamp, registry_bound: bool) -> bool {
        self.current_at(stamp, registry_bound, Instant::now())
    }
    fn current_at(&self, stamp: Stamp, registry_bound: bool, now: Instant) -> bool {
        self.epoch == stamp.epoch && (!registry_bound || self.registry == stamp.registry) && now < stamp.expires
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn approval_and_execution_share_a_bounded_monotonic_lifetime() {
        let scope = Scope::default();
        let now = Instant::now();
        let stamp = scope.stamp_at(now, Duration::from_secs(120));
        assert!(scope.current_at(stamp, true, now + Duration::from_secs(119)));
        assert!(!scope.current_at(stamp, true, now + Duration::from_secs(120)));
    }
    #[test]
    fn kill_invalidates_a_detached_native_dialog_and_an_existing_grant() {
        let mut scope = Scope::default();
        let detached = scope.stamp(Duration::from_secs(120));
        let granted = detached;
        scope.revoke();
        assert!(!scope.current(detached, false));
        assert!(!scope.current(granted, true));
        assert!(scope.current(scope.stamp(Duration::from_secs(120)), true));
    }
    #[test]
    fn registry_aba_cannot_revive_an_old_mcp_plan() {
        let mut scope = Scope::default();
        let stamp = scope.stamp(Duration::from_secs(120));
        scope.registry_changed();
        scope.registry_changed();
        assert!(!scope.current(stamp, true));
        assert!(scope.current(stamp, false));
    }
    #[test]
    fn credential_aba_is_a_new_host_scope_even_with_identical_strings() {
        let mut scope = Scope::default();
        let previous = scope.stamp(Duration::from_secs(120));
        scope.revoke();
        scope.revoke();
        assert!(!scope.current(previous, false));
    }
}
