import { describe, it, expect, vi } from "vitest";
import { performSignOut } from "../session";
import type { Config } from "../config";
describe("sign-out storage failure", () => {
  it.each(["async", "sync"])("clears live session and reports %s failure without backend details", async mode => {
    const cfg: Config = { apiUrl: "https://fixture", token: "synthetic-token", refreshToken: "synthetic-refresh" };
    const onSignedOut = vi.fn(); const onSignOutError = vi.fn();
    const persist = () => { if (mode === "sync") throw new Error("sensitive-backend-detail"); return Promise.reject(new Error("sensitive-backend-detail")); };
    expect(() => performSignOut(cfg, { persist, onSignedOut, onSignOutError } as any, async () => {})).not.toThrow();
    await Promise.resolve(); await Promise.resolve();
    expect(cfg.token).toBeUndefined(); expect(cfg.refreshToken).toBeUndefined(); expect(onSignedOut).toHaveBeenCalledOnce();
    expect(onSignOutError).toHaveBeenCalledOnce(); expect(onSignOutError.mock.calls[0][0]).not.toContain("sensitive-backend-detail");
  });
  it("does not show an old sign-out failure over a newer account", async () => {
    const cfg: Config = { apiUrl: "https://fixture", token: "old" }; let reject!: (v: unknown) => void;
    const onSignOutError = vi.fn();
    performSignOut(cfg, { persist: () => new Promise<void>((_, r) => { reject = r; }), onSignedOut: vi.fn(), onSignOutError } as any, async () => {});
    cfg.token = "new"; reject(new Error("failure")); await Promise.resolve(); await Promise.resolve();
    expect(onSignOutError).not.toHaveBeenCalled();
  });
});
