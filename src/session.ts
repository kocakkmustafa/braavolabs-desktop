/**
 * Session lifecycle — the load-bearing sign-out logic, extracted from the DOM
 * handler in ui.ts so it is UNIT-TESTED. ui.ts "has no test of its own" (see its
 * header), and the audit C3/#1 bug lived in exactly this handler: sign-out
 * cleared local tokens but never revoked the refresh token server-side. Keeping
 * the decision here (not inline in the untested view) means a regression fails a
 * test instead of silently re-opening the hole.
 */
import type { Config } from "./config";
import { invalidateSession, logout as apiLogout } from "./client";

type SignOutDeps = {
  persist: (c: Config) => Promise<void> | void;
  onSignedOut: () => void;
  onSignOutError?: (message: string) => void;
};

// The logout call is injectable so session.test.ts can assert the ordering
// (invoked-before-clear) without a real network round-trip. Defaults to the
// real API logout, which itself sends the bearer + refresh token in the body.
type DoLogout = (c: Config, o?: { save?: (c: Config) => void }) => Promise<unknown>;

/**
 * Sign the user out. Invariants (pinned by session.test.ts):
 *   1. Revoke server-side (logout) whenever ANY credential is present — gate on
 *      access OR refresh token, because an expired access token with a live
 *      refresh token still needs revoking (audit #4).
 *   2. logout runs BEFORE the local clear, so it still sees the credentials it
 *      must send (audit #2 — the ordering was previously untested).
 *   3. Local creds are cleared + persisted UNCONDITIONALLY, even if logout
 *      rejects or the network is offline — never a half-signed-in state.
 *   4. onSignedOut() always fires; failed storage clearing is reported honestly.
 */
export function performSignOut(
  cfg: Config,
  deps: SignOutDeps,
  doLogout: DoLogout = apiLogout,
): void {
  invalidateSession(cfg);
  if (cfg.token || cfg.refreshToken) {
    // Best-effort + fire-and-forget: apiFetch reads cfg.token/refreshToken
    // synchronously when invoked here, so it captures them before the clear
    // below runs. A rejection (offline / already-expired) must not block or
    // revert the local sign-out.
    void doLogout({ ...cfg }, { save: deps.persist }).catch(() => {});
  }
  cfg.token = undefined;
  cfg.refreshToken = undefined;
  const reportFailure = () => {
    // Do not replace a newer signed-in account's UI with an old clear failure.
    if (!cfg.token && !cfg.refreshToken) {
      deps.onSignOutError?.("Saved credentials could not be cleared. They may remain on this device. Retry clearing saved credentials before reopening the app.");
    }
  };
  try {
    void Promise.resolve(deps.persist(cfg)).catch(reportFailure);
  } catch {
    queueMicrotask(reportFailure);
  }
  deps.onSignedOut();
}
