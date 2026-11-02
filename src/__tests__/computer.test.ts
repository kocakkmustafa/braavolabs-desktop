import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BLOCKED_APPS, BLOCKED_KEYS, BROWSER_PREFIXES, blockedReason, computerActionToGate, governedComputer, normalizeKeys,
  type ComputerAction, type ComputerDriver,
} from "../computer";
import { classifyAction, createMemoryGovernance } from "../governance";

const notes = { bundleId: "com.apple.Notes", name: "Notes" };

describe("never-controllable apps", () => {
  it("blocks system, security, terminals, browsers, finance/identity and Braavolabs itself", () => {
    for (const id of ["com.apple.Terminal", "com.apple.systempreferences", "com.1password.1password", "com.braavolabs.desktop"]) {
      expect(blockedReason({ bundleId: id }), id).toMatch(/cannot be controlled/);
    }
    expect(blockedReason({ bundleId: "com.google.Chrome" })).toMatch(/Braavo browser/);
    expect(blockedReason({ bundleId: "com.example.app", name: "Ziraat Bankası" })).toMatch(/finance or identity/);
    expect(blockedReason({ bundleId: "tr.gov.turkiye.edevlet" })).toMatch(/finance or identity/);
    expect(blockedReason(notes)).toBeNull();
    expect(blockedReason({ bundleId: "com.example.otherwise", name: "Otherwise" })).toBeNull();
    expect(blockedReason(undefined)).toMatch(/needs the target app/);
  });

  it("keeps the TS and Rust lists identical (the host is the enforcement point)", () => {
    const rust = readFileSync(join(process.cwd(), "src-tauri/src/computer.rs"), "utf8");
    const list = (name: string) => [...(new RegExp(`pub const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`).exec(rust)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(m => m[1]);
    expect(list("BLOCKED_APPS")).toEqual([...BLOCKED_APPS]);
    expect(list("BROWSER_PREFIXES")).toEqual([...BROWSER_PREFIXES]);
    expect(list("BLOCKED_KEYS")).toEqual([...BLOCKED_KEYS]);
  });

  it("normalizes key names and modifier order", () => {
    expect(normalizeKeys("Shift+Cmd+S")).toBe("cmd+shift+s");
    expect(normalizeKeys("⌘ + Space")).toBe("cmd+space");
    expect(normalizeKeys("Enter")).toBe("return");
  });
});

describe("gate mapping and policy", () => {
  it("binds app + point + text; the audit summary never carries typed text", () => {
    const click = computerActionToGate({ op: "click", x: 10.4, y: 20.6 }, notes, "cs_1");
    expect(click).toEqual({ kind: "computer.interact", detail: { app: "com.apple.Notes", interactKind: "click", x: 10, y: 21, summary: "click at 10,21 in Notes" } });
    const typed = computerActionToGate({ op: "type", text: "hunter2" }, notes, "cs_1");
    expect(typed.detail.value).toBe("hunter2");
    expect(typed.detail.summary).toBe("type 7 chars in Notes");
    expect(computerActionToGate({ op: "screenshot" }, notes, "cs_1")).toMatchObject({ kind: "computer.read", detail: { app: "com.apple.Notes", selector: "cs_1" } });
  });

  it("denies blocked apps and launcher keys, and asks for everything else", () => {
    expect(classifyAction("computer.interact", { app: "com.apple.Terminal", interactKind: "type", value: "ls" }).decision).toBe("deny");
    expect(classifyAction("computer.read", {}).decision).toBe("deny");
    expect(classifyAction("computer.interact", { app: "com.apple.Notes", interactKind: "key", value: "cmd+space" }).decision).toBe("deny");
    expect(classifyAction("computer.interact", { app: "com.apple.Notes", interactKind: "click", x: 1, y: 1 }).decision).toBe("require-approval");
    expect(classifyAction("computer.read", { app: "com.apple.Notes", selector: "cs_1" }).decision).toBe("require-approval");
  });

  it("a token for one point cannot be spent on another", async () => {
    const gov = createMemoryGovernance();
    const { kind, detail } = computerActionToGate({ op: "click", x: 10, y: 20 }, notes, "cs_1");
    const req = await gov.request(kind, detail);
    expect(req.decision).toBe("require-approval");
    const { token } = await gov.approve(req.actionId);
    const other = computerActionToGate({ op: "click", x: 11, y: 20 }, notes, "cs_1").detail;
    expect(await gov.consume(token, kind, other)).toBe(false);
    const again = await gov.request(kind, detail);
    const { token: t2 } = await gov.approve(again.actionId);
    expect(await gov.consume(t2, kind, detail)).toBe(true);
    expect(await gov.consume(t2, kind, detail)).toBe(false);
  });
});

describe("governedComputer", () => {
  const driver = () => {
    const calls: Array<{ op: string; token: string | null }> = [];
    const d: ComputerDriver = { dispatch: vi.fn(async (a: ComputerAction, _app, _s, token) => { calls.push({ op: a.op, token }); return { ok: true, png: a.op === "screenshot" ? "iVBOR" : undefined }; }) };
    return { d, calls };
  };

  it("asks once per session to read the screen and every time to act", async () => {
    const { d, calls } = driver();
    const gate = vi.fn(async () => ({ ok: true as const, token: "tok" }));
    const session = { id: "cs_1", readGranted: false };
    await governedComputer({ op: "screenshot" }, notes, session, gate, d);
    await governedComputer({ op: "screenshot" }, notes, session, gate, d);
    await governedComputer({ op: "click", x: 1, y: 2 }, notes, session, gate, d);
    await governedComputer({ op: "click", x: 1, y: 2 }, notes, session, gate, d);
    expect(gate).toHaveBeenCalledTimes(3);
    expect(calls).toEqual([{ op: "screenshot", token: "tok" }, { op: "screenshot", token: null }, { op: "click", token: "tok" }, { op: "click", token: "tok" }]);
  });

  it("never reaches the driver on a deny, a reject or a launcher key", async () => {
    const { d, calls } = driver();
    const session = { id: "cs_1", readGranted: true };
    expect(await governedComputer({ op: "click", x: 1, y: 1 }, { bundleId: "com.apple.Terminal" }, session, async () => ({ ok: true, token: "t" }), d)).toMatchObject({ ok: false });
    expect(await governedComputer({ op: "key", keys: "Cmd+Space" }, notes, session, async () => ({ ok: true, token: "t" }), d)).toEqual({ ok: false, reason: "cmd+space is never sent" });
    expect(await governedComputer({ op: "type", text: "x" }, notes, session, async () => ({ ok: false, reason: "rejected" }), d)).toEqual({ ok: false, reason: "rejected" });
    expect(calls).toEqual([]);
  });
});

describe("host driver", () => {
  it("sends the host exactly the fields the gate bound, so the token consumes", async () => {
    const { tauriComputerDriver } = await import("../computer-pane");
    const invoke = vi.fn(async () => ({ ok: true, png: "iVBOR", width: 2880, height: 1800, pointsWidth: 1440 }));
    const driver = tauriComputerDriver(invoke);
    expect(await driver.dispatch({ op: "screenshot" }, notes, "cs_1", "tok")).toEqual({ ok: true, png: "iVBOR", width: 2880, height: 1800, scale: 2 });
    await driver.dispatch({ op: "key", keys: "Shift+Cmd+S" }, notes, "cs_1", "tok");
    await driver.dispatch({ op: "scroll", x: 5.2, y: 6, dx: 0, dy: -300 }, notes, "cs_1", "tok");
    const inputs = invoke.mock.calls.map(c => (c as unknown as [string, { input: unknown }])[1].input);
    expect(inputs[1]).toEqual({ op: "key", app: "com.apple.Notes", sessionId: "cs_1", x: undefined, y: undefined, value: "cmd+shift+s" });
    expect(inputs[2]).toEqual({ op: "scroll", app: "com.apple.Notes", sessionId: "cs_1", x: 5, y: 6, value: "0,-300" });
  });
});
