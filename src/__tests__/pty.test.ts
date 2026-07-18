import { describe, it, expect, vi } from "vitest";
import {
  ptySpawnToGate,
  governedPtySpawn,
  PtySessions,
  MAX_RUNNING_SESSIONS,
  type PtyDriver,
  type PtySpawnRequest,
} from "../pty";
import { classifyAction, isAbsolutePath } from "../governance";

const req = (over: Partial<PtySpawnRequest> = {}): PtySpawnRequest => ({
  vendor: "claude",
  cwd: "/Users/me/project",
  ...over,
});

const okDriver = (): PtyDriver => ({
  spawn: vi.fn(async () => ({ ok: true as const, sessionId: "s1" })),
  write: vi.fn(async () => {}),
  resize: vi.fn(async () => {}),
  kill: vi.fn(async () => {}),
});

describe("ptySpawnToGate", () => {
  it("maps to pty.spawn with vendor + cwd + args (the token-binding fields) + honest summary", () => {
    const { kind, detail } = ptySpawnToGate(req({ args: ["--continue"] }));
    expect(kind).toBe("pty.spawn");
    expect(detail.vendor).toBe("claude");
    expect(detail.cwd).toBe("/Users/me/project");
    expect(detail.args).toEqual(["--continue"]); // bound → approved args == launched args
    expect(detail.summary).toBe("open interactive claude --continue session in /Users/me/project");
  });

  it("OMITS args when none, so a no-arg session's token binding is stable", () => {
    const { detail } = ptySpawnToGate(req({ vendor: "codex" }));
    expect(detail.args).toBeUndefined(); // absent, not [] — bindingKey uses null
    expect(detail.summary).toBe("open interactive codex session in /Users/me/project");
  });

  it("different args → different detail.args (so the bound token cannot be arg-swapped)", () => {
    const a = ptySpawnToGate(req({ args: ["--continue"] })).detail.args;
    const b = ptySpawnToGate(req({ args: ["--dangerously-skip"] })).detail.args;
    expect(a).not.toEqual(b); // governance.bindingKey folds args in → tokens don't cross
  });
});

describe("governance policy for pty.spawn", () => {
  it("requires approval for a known vendor in an absolute cwd (never auto-allow)", () => {
    const { kind, detail } = ptySpawnToGate(req());
    expect(classifyAction(kind, detail)).toEqual({
      decision: "require-approval",
      reason: "side-effecting action",
    });
  });

  it("hard-denies an unknown vendor (PTY host is not a general shell launcher)", () => {
    expect(classifyAction("pty.spawn", { vendor: "bash", cwd: "/tmp" })).toMatchObject({
      decision: "deny",
      reason: "unknown PTY vendor blocked",
    });
    expect(classifyAction("pty.spawn", { cwd: "/tmp" })).toMatchObject({ decision: "deny" });
  });

  it("hard-denies a relative or traversal cwd", () => {
    expect(classifyAction("pty.spawn", { vendor: "claude", cwd: "project" })).toMatchObject({
      decision: "deny",
      reason: "PTY cwd must be absolute (no traversal)",
    });
    expect(classifyAction("pty.spawn", { vendor: "claude", cwd: "/a/../etc" })).toMatchObject({
      decision: "deny",
    });
    expect(classifyAction("pty.spawn", { vendor: "claude" })).toMatchObject({ decision: "deny" });
  });

  it("isAbsolutePath accepts posix + windows roots, rejects relative", () => {
    expect(isAbsolutePath("/a/b")).toBe(true);
    expect(isAbsolutePath("C:\\work")).toBe(true);
    expect(isAbsolutePath("c:/work")).toBe(true);
    expect(isAbsolutePath("work/dir")).toBe(false);
    expect(isAbsolutePath("./x")).toBe(false);
  });
});

describe("governedPtySpawn (chokepoint)", () => {
  it("gates first; the driver spawns ONLY with the approved one-time token", async () => {
    const driver = okDriver();
    const gate = vi.fn(async () => ({ ok: true as const, token: "tok-1" }));
    const out = await governedPtySpawn(req(), gate, driver);
    expect(out).toEqual({ ok: true, sessionId: "s1" });
    expect(gate).toHaveBeenCalledWith("pty.spawn", expect.objectContaining({ vendor: "claude" }));
    expect(driver.spawn).toHaveBeenCalledWith(expect.objectContaining({ vendor: "claude" }), "tok-1");
  });

  it("NEVER calls the driver on a gate deny/reject (fail-closed)", async () => {
    const driver = okDriver();
    const gate = vi.fn(async () => ({ ok: false as const, reason: "denied: unknown PTY vendor blocked" }));
    const out = await governedPtySpawn(req(), gate, driver);
    expect(out).toEqual({ ok: false, reason: "denied: unknown PTY vendor blocked" });
    expect(driver.spawn).not.toHaveBeenCalled();
  });

  it("propagates an honest driver failure (token failed to consume host-side)", async () => {
    const driver = okDriver();
    (driver.spawn as any).mockResolvedValue({ ok: false, error: "pty denied: invalid or replayed token" });
    const gate = vi.fn(async () => ({ ok: true as const, token: "stale" }));
    const out = await governedPtySpawn(req(), gate, driver);
    expect(out).toEqual({ ok: false, reason: "pty denied: invalid or replayed token" });
  });
});

describe("PtySessions (registry / redaction)", () => {
  it("tracks lifecycle + byte counters; audit summary is REDACTED (no buffer content)", () => {
    const reg = new PtySessions();
    expect(reg.register("s1", "claude", "/w")).toEqual({ ok: true });
    reg.noteInput("s1", 12);
    reg.noteOutput("s1", 3400);
    reg.noteOutput("s1", 600);
    reg.noteExit("s1", 0);
    expect(reg.get("s1")).toMatchObject({ state: "exited", bytesIn: 12, bytesOut: 4000, exitCode: 0 });
    // The ONLY audit-visible string: vendor + cwd + counts + ending. If a secret
    // was typed/pasted, nothing of it can appear here.
    expect(reg.auditSummary("s1")).toBe("pty claude in /w — in 12B, out 4000B, exited (0)");
  });

  it("kill wins over a late exit (state machine is idempotent)", () => {
    const reg = new PtySessions();
    reg.register("s1", "codex", "/w");
    reg.noteKill("s1");
    reg.noteExit("s1", 137); // late exit event after the kill must not flip state
    expect(reg.get("s1")).toMatchObject({ state: "killed", exitCode: null });
    expect(reg.auditSummary("s1")).toContain("killed by user");
  });

  it("counters freeze after exit (no post-mortem drift)", () => {
    const reg = new PtySessions();
    reg.register("s1", "claude", "/w");
    reg.noteExit("s1", 1);
    reg.noteOutput("s1", 999);
    reg.noteInput("s1", 999);
    expect(reg.get("s1")).toMatchObject({ bytesIn: 0, bytesOut: 0 });
  });

  it(`enforces the running-session cap (${MAX_RUNNING_SESSIONS}) and frees a slot on exit`, () => {
    const reg = new PtySessions();
    for (let i = 0; i < MAX_RUNNING_SESSIONS; i++) {
      expect(reg.register(`s${i}`, "claude", "/w")).toEqual({ ok: true });
    }
    expect(reg.register("overflow", "claude", "/w")).toMatchObject({
      ok: false,
      reason: `session cap reached (${MAX_RUNNING_SESSIONS})`,
    });
    reg.noteExit("s0", 0); // one ends → a slot frees
    expect(reg.register("next", "codex", "/w")).toEqual({ ok: true });
  });

  it("rejects a duplicate session id honestly", () => {
    const reg = new PtySessions();
    reg.register("s1", "claude", "/w");
    expect(reg.register("s1", "codex", "/x")).toMatchObject({ ok: false, reason: "duplicate session id" });
  });
});
