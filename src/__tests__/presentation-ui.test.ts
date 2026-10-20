import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { applyLocale, getLocale, LOCALES, LOCALE_NAMES, makeT, formatNumber, formatUsd, saveLocale } from "../i18n";
import { createTheme, THEMES } from "../theme";
import { toCascadeView, toCompareView } from "../render";

class Node {
  value = ""; disabled = false; textContent = ""; innerHTML = "";
  children: Node[] = []; attrs: Record<string, string> = {}; handlers: Record<string, () => unknown> = {};
  constructor(readonly tag: string, readonly cls = "") {}
  append(...nodes: Node[]) { this.children.push(...nodes); }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(key: string, callback: () => unknown) { this.handlers[key] = callback; }
}
const source = ts.createSourceFile("ui.ts", readFileSync(new URL("../ui.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const names = ["themeSelector", "languageSelector", "kv", "renderCascadeInspector", "renderCompareInspector"];
const code = ts.transpileModule(names.map(name => source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!.getText(source)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture(locale: typeof LOCALES[number] = "en", persist = true) {
  applyLocale(locale);
  const nodes: Node[] = [], root = { dataset: {} as DOMStringMap, style: { colorScheme: "" } };
  const storage = { getItem: () => "system", setItem: () => { if (!persist) throw Error("quota"); } };
  const theme = createTheme(root, storage, { matches: false, addEventListener() {}, removeEventListener() {} });
  const el = (tag: string, cls = "", text = "") => { const n = new Node(tag, cls); n.textContent = text; nodes.push(n); return n; };
  const reload = vi.fn(), invalidate = vi.fn().mockResolvedValue(undefined), stop = vi.fn();
  const ui = runInNewContext(`${code};({${names.join(",")}})`, {
    el, resolveTheme: () => theme, THEMES, LOCALES, LOCALE_NAMES, getLocale, saveLocale,
    activeDispatchStopper: stop, location: { reload }, formatNumber, formatUsd,
  }) as Record<string, (...args: any[]) => Node>;
  return { ui, nodes, theme, root, invalidate, reload, stop, deps: { t: makeT(locale), gov: { invalidate } } };
}
afterEach(() => { vi.unstubAllGlobals(); applyLocale("en"); });
it("executes the real theme picker with a labelled choice, immediate appearance and an honest failed-save status", () => {
  const f = fixture("hi", false); f.ui.themeSelector(f.deps);
  const select = f.nodes.find(n => n.tag === "select")!;
  expect(select.attrs["aria-label"]).toBe(makeT("hi")("settings.theme"));
  expect(select.children.map(n => n.value)).toEqual(THEMES);
  select.value = "dark"; select.handlers.change(); expect(f.root.dataset.theme).toBe("dark");
  expect(f.nodes.find(n => n.attrs.role === "status")!.textContent).toBe(makeT("hi")("settings.preferenceUnsaved"));
  select.value = "light"; select.handlers.change(); expect(f.root.dataset.theme).toBe("light");
  expect(f.invalidate).not.toHaveBeenCalled();
});
it("does not reload or claim a language switch when saving fails, and shows retry guidance", async () => {
  vi.stubGlobal("localStorage", { setItem: () => { throw Error("blocked"); } });
  const f = fixture("ar"); f.ui.languageSelector(f.deps);
  const select = f.nodes.find(n => n.tag === "select")!;
  expect(select.children).toHaveLength(14); select.value = "pl";
  await select.handlers.change();
  expect(f.stop).toHaveBeenCalledOnce(); expect(f.invalidate).toHaveBeenCalledOnce();
  expect(f.reload).not.toHaveBeenCalled(); expect(select.value).toBe("ar"); expect(select.disabled).toBe(false);
  expect(f.nodes.find(n => n.attrs.role === "status")!.textContent).toBe(makeT("ar")("settings.languageFailed"));
});
it("waits for approval invalidation before storing/reloading a new language", async () => {
  const setItem = vi.fn(); vi.stubGlobal("localStorage", { setItem });
  const f = fixture("en"); let done!: () => void;
  f.invalidate.mockImplementation(() => new Promise<void>(resolve => { done = resolve; }));
  f.ui.languageSelector(f.deps); const select = f.nodes.find(n => n.tag === "select")!; select.value = "zh-Hans";
  const pending = select.handlers.change(); expect(select.disabled).toBe(true); expect(setItem).not.toHaveBeenCalled(); expect(f.reload).not.toHaveBeenCalled();
  done(); await pending; expect(setItem).toHaveBeenCalledWith("bv.locale", "zh-Hans"); expect(f.reload).toHaveBeenCalledOnce();
});
it("renders missing costs/confidence as localized unknown and preserves explicit zero/false", () => {
  const f = fixture("pl"), body = new Node("div");
  f.ui.renderCascadeInspector(body, toCascadeView({}), f.deps.t);
  const text = () => f.nodes.map(n => n.textContent);
  expect(text().filter(value => value === "Nieznane")).toHaveLength(3);
  expect(text()).not.toContain("0"); expect(text()).not.toContain("no");
  f.nodes.length = 0;
  f.ui.renderCascadeInspector(body, toCascadeView({ confidence: 0, totalCostUsd: 0, escalated: false }), f.deps.t);
  expect(text()).toContain("0"); expect(text()).toContain("Nie"); expect(text()).toContain(formatUsd(0));
  f.nodes.length = 0;
  f.ui.renderCompareInspector(body, toCompareView({ status: "COMPLETED", findings: { multiModel: {} } }), f.deps.t);
  expect(text()).toContain("Nieznane");
});

it("reports the selected model count and does not invent a count for automatic selection", () => {
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "progressLabel") expression = node.initializer;
    ts.forEachChild(node, visit);
  }; visit(source); expect(expression).toBeDefined();
  const compiled = ts.transpileModule(`const progressLabel = ${expression!.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const t = makeT("en");
  for (const count of [undefined, 1, 3]) {
    const runSelections = count === undefined ? undefined : Array.from({ length: count }, () => ({}));
    const progress = runInNewContext(`${compiled};progressLabel`, { runSelections, t }) as (status: string) => string;
    expect(progress("RUNNING")).toBe(count === undefined ? "Models working…" : t("chat.thinking", { n: count }));
    expect(progress("PENDING")).toBe(t("chat.polling", { status: "PENDING" }));
  }
});
