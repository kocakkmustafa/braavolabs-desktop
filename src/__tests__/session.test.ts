import { describe, it, expect, vi } from "vitest";
import { performSignOut } from "../session";
import type { Config } from "../config";

/**
 * Covers the audit C-1 gap: the sign-out logic was previously inline in the
 * untested ui.ts handler, so a regression that dropped the server-side revoke
 * (re-opening C3) would ship green. These tests pin the revoke-then-clear
 * ordering, the OR-gate (#4), and the fail-safe local clear (#2/#3).
 */
const cfg = (over: Partial<Config> = {}): Config => ({ apiUrl: "https://host/api/v1", ...over });

describe("performSignOut", () => {
  it("revokes server-side, then clears + persists + signals out (happy path)", async () => {
    const seen: Array<{ token?: string; refreshToken?: string }> = [];
    const doLogout = vi.fn((c: Config, _o?: { save?: (c: Config) => void }) => {
      // Snapshot SYNCHRONOUSLY at call-time — proves logout ran BEFORE the clear
      // and still saw the credentials it must send (audit #2 ordering).
      seen.push({ token: c.token, refreshToken: c.refreshToken });
      return Promise.resolve();
    });
    const persist = vi.fn();
    const onSignedOut = vi.fn();
    const c = cfg({ token: "acc", refreshToken: "ref" });

    performSignOut(c, { persist, onSignedOut }, doLogout);

    expect(doLogout).toHaveBeenCalledTimes(1);
    expect(seen[0]).toEqual({ token: "acc", refreshToken: "ref" }); // captured pre-clear
    expect(c.token).toBeUndefined(); // cleared after
    expect(c.refreshToken).toBeUndefined();
    expect(persist).toHaveBeenCalledWith(c);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    // logout got the persist callback so a rotation mid-logout is saved.
    expect(doLogout.mock.calls[0][1]).toEqual({ save: persist });
  });

  it("still revokes when ONLY a refresh token remains (expired access — audit #4)", () => {
    const doLogout = vi.fn(() => Promise.resolve());
    const c = cfg({ refreshToken: "ref" }); // no access token
    performSignOut(c, { persist: vi.fn(), onSignedOut: vi.fn() }, doLogout);
    expect(doLogout).toHaveBeenCalledTimes(1); // gate is token OR refreshToken
  });

  it("does NOT call logout when there is no credential at all", () => {
    const doLogout = vi.fn(() => Promise.resolve());
    const onSignedOut = vi.fn();
    performSignOut(cfg(), { persist: vi.fn(), onSignedOut }, doLogout);
    expect(doLogout).not.toHaveBeenCalled();
    expect(onSignedOut).toHaveBeenCalledTimes(1); // local sign-out still completes
  });

  it("clears local creds + signals out even if logout REJECTS (offline — no half-signed-in state)", async () => {
    const doLogout = vi.fn(() => Promise.reject(new Error("network down")));
    const persist = vi.fn();
    const onSignedOut = vi.fn();
    const c = cfg({ token: "acc", refreshToken: "ref" });

    // Must not throw despite the rejected logout (the .catch swallows it).
    expect(() => performSignOut(c, { persist, onSignedOut }, doLogout)).not.toThrow();
    // Give the rejected microtask a tick to settle — proves it's swallowed.
    await Promise.resolve();

    expect(c.token).toBeUndefined();
    expect(c.refreshToken).toBeUndefined();
    expect(persist).toHaveBeenCalledWith(c);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });
});
