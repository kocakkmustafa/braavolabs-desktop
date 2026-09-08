import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../client";
import { toLoginError } from "../render";
import { makeT } from "../i18n";

const source = ts.createSourceFile("ui.ts", readFileSync(new URL("../ui.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const functions = ["renderLogin", "mapLoginErrorText"].map(name => {
  const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!node) throw Error(`Missing real UI function ${name}`);
  return node.getText(source).replace(/^export\s+/, "");
}).join("\n");
const compiled = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

class Element {
  id = ""; type = ""; value = ""; required = false; disabled = false;
  textContent = ""; innerHTML = ""; autocomplete = "";
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: Element[] = [];
  handlers = new Map<string, (event: { preventDefault(): void }) => void>();
  reportValidity = vi.fn(() => true);
  constructor(readonly tagName: string, readonly className = "") {}
  append(...children: Element[]) { this.children.push(...children); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(name: string, handler: (event: { preventDefault(): void }) => void) { this.handlers.set(name, handler); }
}

function fixture(locale: "en" | "tr" = "en") {
  const nodes: Element[] = [];
  const el = (tag: string, cls = "", text = "") => {
    const node = new Element(tag.toUpperCase(), cls); node.textContent = text; nodes.push(node); return node;
  };
  const login = vi.fn().mockRejectedValue(new TypeError("PRIVATE_RAW_NETWORK_DETAIL"));
  const saveApiUrl = vi.fn(); const persist = vi.fn(); const renderWorkspace = vi.fn();
  const accountStore = vi.fn(); const cfg = { apiUrl: "https://api.braavolabs.com/api/v1" };
  const ui = runInNewContext(`${compiled}\n({renderLogin,mapLoginErrorText});`, {
    el, document: { createTextNode: (text: string) => el("text", "", text) },
    runWorkspaceTeardown() {}, initReducedMotion() {}, login, saveApiUrl,
    ApiError, toLoginError, renderWorkspace, localStorage: { setItem: accountStore },
  }) as { renderLogin(deps: unknown): void; mapLoginErrorText: (t: ReturnType<typeof makeT>, view: ReturnType<typeof toLoginError>) => string };
  ui.renderLogin({ root: el("div"), cfg, t: makeT(locale), persist });
  const field = (id: string) => nodes.find(node => node.id === id)!;
  const form = nodes.find(node => node.className === "login-card")!;
  const button = nodes.find(node => node.className === "login-btn")!;
  const error = nodes.find(node => node.className === "login-error")!;
  const submit = () => {
    const event = { preventDefault: vi.fn() };
    const handler = form.handlers.get("submit");
    expect(handler, "actual form owns the submit handler").toBeDefined();
    handler!(event); expect(event.preventDefault).toHaveBeenCalledOnce();
  };
  return { ...ui, nodes, form, button, error, field, submit, login, saveApiUrl, persist, renderWorkspace, cfg, accountStore };
}

describe("actual desktop login UI source functions", () => {
  it("uses native form validation, a submit button and an accessible error region", () => {
    const f = fixture();
    expect(f.form.tagName).toBe("FORM"); expect(f.button.type).toBe("submit");
    expect(f.field("login-email")).toMatchObject({ type: "email", required: true, autocomplete: "username" });
    expect(f.field("login-password")).toMatchObject({ type: "password", required: true, autocomplete: "current-password" });
    expect(f.error.attributes.role).toBe("alert");
    expect(f.button.handlers.has("click")).toBe(false);
    expect(f.field("login-password").handlers.has("keydown")).toBe(false);
  });

  it("does not dispatch or save API preferences when validity fails", () => {
    const f = fixture(); f.form.reportValidity.mockReturnValue(false); f.submit();
    expect(f.form.reportValidity).toHaveBeenCalledOnce();
    expect(f.login).not.toHaveBeenCalled(); expect(f.saveApiUrl).not.toHaveBeenCalled();
    expect(f.button.disabled).toBe(false);
  });

  it("serializes submits and preserves the success persistence contract", async () => {
    const f = fixture(); let finish!: (value: unknown) => void;
    f.login.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    f.field("login-email").value = " review@example.invalid ";
    f.field("login-password").value = "secret-for-test";
    f.submit(); f.submit();
    expect(f.login).toHaveBeenCalledTimes(1);
    expect(f.login.mock.calls[0][1]).toEqual({ email: "review@example.invalid", password: "secret-for-test" });
    expect(f.persist).not.toHaveBeenCalled();
    finish({ token: "test-token", refreshToken: "test-refresh" });
    await vi.waitFor(() => expect(f.renderWorkspace).toHaveBeenCalledOnce());
    expect(f.cfg).toMatchObject({ token: "test-token", refreshToken: "test-refresh" });
    expect(f.persist).toHaveBeenCalledExactlyOnceWith(f.cfg);
    expect(f.accountStore).toHaveBeenCalledExactlyOnceWith("bv.account.email", "review@example.invalid");
    expect(f.button.disabled).toBe(false);
  });

  it.each(["en", "tr"] as const)("localizes rejected network errors without raw details in %s", async locale => {
    const f = fixture(locale); f.submit();
    await vi.waitFor(() => expect(f.error.style.display).toBe("block"));
    expect(f.error.textContent).toBe(makeT(locale)("login.errNetwork"));
    expect(f.error.textContent).not.toContain("PRIVATE_RAW");
    expect(f.error.textContent).not.toBe("login.errNetwork");
    expect(f.persist).not.toHaveBeenCalled(); expect(f.button.disabled).toBe(false);
  });

  for (const locale of ["en", "tr"] as const) {
    it.each([
      [0, "network", "errNetwork"], [401, "invalid", "errInvalid"],
      [429, "rate_limited", "errRateLimited"], [500, "unavailable", "errUnavailable"],
      [502, "unavailable", "errUnavailable"], [503, "unavailable", "errUnavailable"],
      [599, "unavailable", "errUnavailable"], [400, "unknown", "errUnknown"],
      [403, "unknown", "errUnknown"], [600, "unknown", "errUnknown"],
    ])(`${locale} maps status %s safely`, (status, kind, key) => {
      const f = fixture(locale); const t = makeT(locale);
      const view = toLoginError({ status: Number(status), body: { error: "PRIVATE_RAW_SERVER_DETAIL" } });
      expect(view?.kind).toBe(kind);
      expect(f.mapLoginErrorText(t, view)).toBe(t(`login.${key}`));
      expect(f.mapLoginErrorText(t, view)).not.toContain("PRIVATE_RAW");
    });
  }
});
