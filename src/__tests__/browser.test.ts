import { describe, it, expect, vi } from "vitest";
import {
  browserActionToGate,
  governedBrowser,
  opToKind,
  type BrowserAction,
  type BrowserDriver,
  type GateFn,
} from "../browser";
import { classifyAction, isSafeHttpUrl, createMemoryGovernance } from "../governance";

describe("browserActionToGate — mapping + redaction", () => {
  it("maps each op to its governance kind", () => {
    expect(opToKind("navigate")).toBe("browser.navigate");
    expect(opToKind("read")).toBe("browser.read");
    expect(opToKind("interact")).toBe("browser.interact");
    expect(opToKind("eval")).toBe("browser.eval");
  });

  it("navigate carries the url (for hard-deny + token binding) and a summary", () => {
    const { kind, detail } = browserActionToGate({ op: "navigate", url: "https://bank.example/login" });
    expect(kind).toBe("browser.navigate");
    expect(detail.url).toBe("https://bank.example/login");
    expect(detail.summary).toContain("bank.example");
  });

  it("REDACTS a typed value — summary shows the length, never the text", () => {
    const secret = "hunter2-super-secret";
    const { detail } = browserActionToGate({ op: "interact", kind: "type", selector: "#password", value: secret });
    expect(detail.summary).toBe(`type ${secret.length} chars into #password`);
    expect(detail.summary).not.toContain(secret); // the password never reaches governance/audit
    // and nothing on the detail object leaks the value
    expect(JSON.stringify(detail)).not.toContain(secret);
  });

  it("click/scroll summaries name the selector; select hides the option", () => {
    expect(browserActionToGate({ op: "interact", kind: "click", selector: "#delete" }).detail.summary).toBe("click #delete");
    expect(browserActionToGate({ op: "interact", kind: "select", selector: "#country", value: "TR" }).detail.summary).toBe("select an option in #country");
  });

  it("eval truncates a long JS body in the summary", () => {
    const js = "a".repeat(500);
    const s = browserActionToGate({ op: "eval", js }).detail.summary ?? "";
    expect(s.startsWith("eval JS: ")).toBe(true);
    expect(s.length).toBeLessThan(160); // truncated, not the full 500 chars
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("classification (governance) of browser kinds", () => {
  it("no browser kind is auto-allowed — all require approval by default", () => {
    for (const kind of ["browser.navigate", "browser.read", "browser.interact", "browser.eval"] as const) {
      const detail = kind === "browser.navigate" ? { url: "https://ok.example" } : {};
      expect(classifyAction(kind, detail).decision).toBe("require-approval");
    }
  });

  it("HARD-DENIES navigation to non-http(s) schemes (pivot off the web)", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "chrome://settings", "about:blank", "notaurl"]) {
      expect(classifyAction("browser.navigate", { url }).decision).toBe("deny");
    }
  });

  it("allows (for approval) an http/https navigation", () => {
    expect(classifyAction("browser.navigate", { url: "https://example.com" }).decision).toBe("require-approval");
    expect(classifyAction("browser.navigate", { url: "http://localhost:3000" }).decision).toBe("require-approval");
  });

  it("isSafeHttpUrl is fail-closed on unparseable / scheme-less input", () => {
    expect(isSafeHttpUrl(undefined)).toBe(false);
    expect(isSafeHttpUrl("example.com")).toBe(false); // no scheme
    expect(isSafeHttpUrl("ftp://x")).toBe(false);
    expect(isSafeHttpUrl("https://x")).toBe(true);
  });

  it("adversarial URL tricks: scheme is normalized, not string-matched", () => {
    // case + mixed-case schemes normalize — an allow-list on the raw string
    // would miss these, but URL().protocol lowercases them.
    expect(isSafeHttpUrl("HTTPS://ok.example")).toBe(true);
    expect(isSafeHttpUrl("HtTp://ok.example")).toBe(true);
    // dangerous schemes stay denied regardless of casing / obfuscation
    expect(isSafeHttpUrl("JavaScript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("FILE:///etc/passwd")).toBe(false);
    expect(isSafeHttpUrl("\tjavascript:alert(1)")).toBe(false); // leading control char
    expect(isSafeHttpUrl("blob:https://x/uuid")).toBe(false); // blob wrapper is not http(s)
    expect(isSafeHttpUrl("view-source:https://x")).toBe(false);
    // embedded credentials are still an http(s) URL (allowed — the host decides
    // whether to strip them; scheme is what THIS gate guards)
    expect(isSafeHttpUrl("https://user:pass@host.example")).toBe(true);
  });
});

describe("governedBrowser — the chokepoint", () => {
  const fakeDriver = (): BrowserDriver & { calls: Array<{ action: BrowserAction; token: string }> } => {
    const calls: Array<{ action: BrowserAction; token: string }> = [];
    return {
      calls,
      dispatch: vi.fn(async (action: BrowserAction, token: string) => {
        calls.push({ action, token });
        return { ok: true, value: "done" };
      }),
    };
  };

  it("drives the driver with the action + token ONLY after an approved gate", async () => {
    const driver = fakeDriver();
    const gate: GateFn = vi.fn(async () => ({ ok: true as const, token: "tok-123" }));
    const action: BrowserAction = { op: "navigate", url: "https://example.com" };
    const out = await governedBrowser(action, gate, driver);
    expect(out).toEqual({ ok: true, result: { ok: true, value: "done" } });
    expect(gate).toHaveBeenCalledWith("browser.navigate", expect.objectContaining({ url: "https://example.com" }));
    expect(driver.calls).toEqual([{ action, token: "tok-123" }]);
  });

  it("NEVER touches the driver when the gate denies/rejects (fail-closed)", async () => {
    const driver = fakeDriver();
    const gate: GateFn = vi.fn(async () => ({ ok: false as const, reason: "non-http(s) navigation blocked" }));
    const out = await governedBrowser({ op: "navigate", url: "file:///etc/passwd" }, gate, driver);
    expect(out).toEqual({ ok: false, reason: "non-http(s) navigation blocked" });
    expect(driver.dispatch).not.toHaveBeenCalled();
  });
});

describe("token URL-binding via the real memory governance", () => {
  it("a token approved for one URL cannot authorize navigation to another", async () => {
    const gov = createMemoryGovernance();
    const { kind, detail } = browserActionToGate({ op: "navigate", url: "https://bank.example" });
    const req = await gov.request(kind, detail);
    expect(req.decision).toBe("require-approval");
    const { token } = await gov.approve(req.actionId);

    // Swap the URL at consume time → binding mismatch → rejected, nothing runs.
    const swapped = await gov.consume(token, kind, { url: "https://evil.example", summary: detail.summary });
    expect(swapped).toBe(false);

    // The exact same action consumes once (and only once).
    const same = await gov.consume(token, kind, detail);
    expect(same).toBe(true);
  });
});
