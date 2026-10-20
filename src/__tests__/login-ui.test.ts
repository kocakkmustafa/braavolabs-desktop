import { rememberHistoryIdentity } from "../sessions";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../client";
import * as clientModule from "../client";
import type { Config } from "../config";
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
  // The browser owns these flags; tests supply states, not a second email policy.
  validity = { valueMissing: false, typeMismatch: false, customError: false };
  validationMessage = "";
  setCustomValidity = vi.fn((message: string) => {
    this.validationMessage = message;
    this.validity.customError = message !== "";
  });
  constructor(readonly tagName: string, readonly className = "") {}
  append(...children: Element[]) { this.children.push(...children); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(name: string, handler: (event: { preventDefault(): void }) => void) { this.handlers.set(name, handler); }
  fire(name: string) {
    const event = { preventDefault: vi.fn() };
    const handler = this.handlers.get(name);
    expect(handler, `actual input owns the ${name} handler`).toBeDefined();
    handler!(event);
    return event;
  }
}

function fixture(locale: "en" | "tr" = "en") {
  const nodes: Element[] = [];
  const el = (tag: string, cls = "", text = "") => {
    const node = new Element(tag.toUpperCase(), cls); node.textContent = text; nodes.push(node); return node;
  };
  const login = vi.fn().mockRejectedValue(new TypeError("PRIVATE_RAW_NETWORK_DETAIL"));
  const saveApiUrl = vi.fn(); const persist = vi.fn(); const renderWorkspace = vi.fn();
  const accountStore = vi.fn(); const cfg: Config = { apiUrl: "https://api.braavolabs.com/api/v1" };
  const ui = runInNewContext(`${compiled}\n({renderLogin,mapLoginErrorText});`, {
    ...clientModule, el, document: { createTextNode: (text: string) => el("text", "", text) },
    rememberHistoryIdentity, runWorkspaceTeardown() {}, initReducedMotion() {}, languageSelector: () => el("select"), login, saveApiUrl,
    ApiError, toLoginError, renderWorkspace, localStorage: { setItem: accountStore },
  }) as { renderLogin(deps: unknown): void; mapLoginErrorText: (t: ReturnType<typeof makeT>, view: ReturnType<typeof toLoginError>) => string };
  const deps = { root: el("div"), cfg, t: makeT(locale), persist };
  ui.renderLogin(deps);
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
  return { ...ui, deps, nodes, form, button, error, field, submit, login, saveApiUrl, persist, renderWorkspace, cfg, accountStore };
}

function delayed<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("actual login UI session owner", () => {
  it("discards an old login result after another account signs in", async () => {
    const f = fixture(); const response = delayed<{ token: string; refreshToken: string }>();
    f.login.mockImplementation(async () => response.promise);
    f.submit(); f.cfg.token = "B-token"; f.cfg.refreshToken = "B-refresh";
    response.resolve({ token: "A-token", refreshToken: "A-refresh" });
    await vi.waitFor(() => expect(f.button.disabled).toBe(false));
    expect(f.cfg.token).toBe("B-token"); expect(f.cfg.refreshToken).toBe("B-refresh");
    expect(f.persist).not.toHaveBeenCalled(); expect(f.renderWorkspace).not.toHaveBeenCalled();
    expect(f.accountStore).not.toHaveBeenCalled();
  });

  it("does not enter the workspace or store old identity after session changes during persistence", async () => {
    const f = fixture(); const persistence = delayed<void>();
    f.login.mockResolvedValue({ token: "A-token", refreshToken: "A-refresh" });
    f.persist.mockImplementation(async () => persistence.promise);
    f.submit(); await vi.waitFor(() => expect(f.persist).toHaveBeenCalledOnce());
    f.cfg.token = "B-token"; f.cfg.refreshToken = "B-refresh"; persistence.resolve();
    await vi.waitFor(() => expect(f.button.disabled).toBe(false));
    expect(f.cfg.token).toBe("B-token"); expect(f.renderWorkspace).not.toHaveBeenCalled();
    expect(f.accountStore).not.toHaveBeenCalled();
  });

  it("cancels the pending login when its view is mounted again", async () => {
    const f = fixture(); const response = delayed<{ token: string; refreshToken: string }>();
    f.login.mockImplementation(async () => response.promise); f.submit();
    f.renderLogin(f.deps);
    response.resolve({ token: "A-token", refreshToken: "A-refresh" });
    await vi.waitFor(() => expect(f.button.disabled).toBe(false));
    expect(f.cfg.token).toBeUndefined(); expect(f.persist).not.toHaveBeenCalled();
    expect(f.renderWorkspace).not.toHaveBeenCalled();
  });
});

describe("actual desktop login UI source functions", () => {
  it("uses native form validation, a submit button and an accessible error region", () => {
    const f = fixture();
    expect(f.form.tagName).toBe("FORM"); expect(f.button.type).toBe("submit");
    expect(f.field("login-email")).toMatchObject({ type: "email", required: true, autocomplete: "username" });
    expect(f.field("login-password")).toMatchObject({ type: "password", required: true, autocomplete: "current-password" });
    expect(f.error.attributes.role).toBe("alert");
    expect(f.button.handlers.has("click")).toBe(false);
    expect(f.field("login-password").handlers.has("keydown")).toBe(false);
    expect(f.form.attributes).not.toHaveProperty("novalidate");
    expect(f.form).not.toHaveProperty("noValidate", true);
    expect(f.button).not.toHaveProperty("formNoValidate", true);
  });

  it("does not create a custom error before native validation", () => {
    const f = fixture();
    expect(f.field("login-email").setCustomValidity).not.toHaveBeenCalled();
    expect(f.field("login-password").setCustomValidity).not.toHaveBeenCalled();
  });

  for (const [locale, requiredEmail, requiredPassword, invalidEmail] of [
    ["en", "Enter your email address.", "Enter your password.", "Enter a valid email address."],
    ["tr", "E-posta adresinizi girin.", "Parolanızı girin.", "Geçerli bir e-posta adresi girin."],
  ] as const) {
    it(`${locale} provides all three localized native validation messages`, () => {
      const t = makeT(locale);
      expect(t("login.requiredEmail")).toBe(requiredEmail);
      expect(t("login.requiredPassword")).toBe(requiredPassword);
      expect(t("login.invalidEmail")).toBe(invalidEmail);
    });

    it.each([
      ["login-email", "valueMissing", "requiredEmail", requiredEmail],
      ["login-password", "valueMissing", "requiredPassword", requiredPassword],
      ["login-email", "typeMismatch", "invalidEmail", invalidEmail],
    ] as const)(`${locale} localizes native %s %s before a submit event`, (id, flag, key, message) => {
      const f = fixture(locale); const input = f.field(id);
      input.validity[flag] = true;
      const event = input.fire("invalid");
      expect(input.validationMessage).toBe(message);
      expect(makeT(locale)(`login.${key}`)).toBe(message);
      expect(input.validity.customError).toBe(true);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(f.form.reportValidity).not.toHaveBeenCalled();
      expect(f.login).not.toHaveBeenCalled(); expect(f.saveApiUrl).not.toHaveBeenCalled();
    });

    for (const id of ["login-email", "login-password"]) {
      it.each(["input", "change"])(`${locale} clears stale ${id} custom error on %s without revalidating`, eventName => {
        const f = fixture(locale); const input = f.field(id);
        input.validity.valueMissing = true;
        input.fire("invalid");
        expect(input.validity.customError).toBe(true);
        // Even while the native missing-value flag remains true, typing/change
        // only clears the old message. A later invalid event chooses a new one.
        input.fire(eventName);
        expect(input.validationMessage).toBe("");
        expect(input.validity.customError).toBe(false);
        expect(f.form.reportValidity).not.toHaveBeenCalled();
        expect(f.login).not.toHaveBeenCalled(); expect(f.saveApiUrl).not.toHaveBeenCalled();
        input.fire("invalid");
        expect(input.validationMessage).toBe(id === "login-email" ? requiredEmail : requiredPassword);
        input.validity.valueMissing = false;
        input.fire(eventName);
        expect(input.validity.customError).toBe(false);
        expect(input.validationMessage).toBe("");
      });
    }

    it(`${locale} derives each email message from current native flags and clears a corrected value`, () => {
      const f = fixture(locale); const input = f.field("login-email");
      input.validity.valueMissing = true; input.fire("invalid");
      expect(input.validationMessage).toBe(requiredEmail);
      input.validity.valueMissing = false; input.validity.typeMismatch = true;
      input.fire("input"); input.fire("invalid");
      expect(input.validationMessage).toBe(invalidEmail);
      input.validity.typeMismatch = false; input.fire("change");
      expect(input.validationMessage).toBe("");
      expect(input.validity.customError).toBe(false);
      f.submit();
      expect(f.form.reportValidity).toHaveBeenCalledOnce();
      expect(f.login).toHaveBeenCalledOnce();
    });

    it(`${locale} does not invent constraints or retain an obsolete custom error`, () => {
      const f = fixture(locale); const email = f.field("login-email");
      email.setCustomValidity("STALE_MESSAGE");
      email.fire("invalid");
      expect(email.validationMessage).toBe("");
      const password = f.field("login-password");
      password.validity.typeMismatch = true;
      password.fire("invalid");
      expect(password.validationMessage).toBe("");
      expect(f.login).not.toHaveBeenCalled(); expect(f.saveApiUrl).not.toHaveBeenCalled();
    });
  }

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
