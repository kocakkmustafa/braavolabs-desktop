import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";

// Execute the real focus containment helper; native WebView/screen-reader paint
// remains a human acceptance task, not established by these synthetic nodes.
const source = ts.createSourceFile("ui.ts", readFileSync(new URL("../ui.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "containDialog")!;
const code = ts.transpileModule(fn.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
it("cycles Tab at both modal edges, dismisses on Escape and restores prior focus", () => {
  const document = { activeElement: null as unknown };
  const previous = { isConnected: true, focus: vi.fn() }; document.activeElement = previous;
  const first = { tabIndex: 0, hidden: false, closest: () => null, getClientRects: () => [1], getAttribute: () => null, focus: vi.fn(() => { document.activeElement = first; }) };
  const last = { tabIndex: 0, hidden: false, closest: () => null, getClientRects: () => [1], getAttribute: () => null, focus: vi.fn(() => { document.activeElement = last; }) };
  const hidden = { ...first, closest: () => ({ hidden: true }), focus: vi.fn() };
  const notRendered = { ...first, getClientRects: () => [], focus: vi.fn() };
  const removedFromTabOrder = { ...first, tabIndex: -1, focus: vi.fn() };
  let handler!: (event: any) => void;
  const card = { tabIndex: 0, setAttribute: vi.fn(), querySelectorAll: () => [hidden, first, notRendered, removedFromTabOrder, last],
    addEventListener: (_name: string, callback: typeof handler) => { handler = callback; }, removeEventListener: vi.fn(), focus: vi.fn() };
  const contain = runInNewContext(`${code};containDialog`, { document }) as (card: any, close: () => void) => () => void;
  const close = vi.fn(), release = contain(card, close);
  const event = (key: string, shiftKey = false) => ({ key, shiftKey, preventDefault: vi.fn(), stopPropagation: vi.fn() });
  document.activeElement = last; const tab = event("Tab"); handler(tab); expect(first.focus).toHaveBeenCalledOnce(); expect(tab.preventDefault).toHaveBeenCalledOnce();
  const reverse = event("Tab", true); handler(reverse); expect(last.focus).toHaveBeenCalledOnce();
  document.activeElement = previous; handler(event("Tab", true));
  expect(last.focus).toHaveBeenCalledTimes(2);
  expect(hidden.focus).not.toHaveBeenCalled(); expect(notRendered.focus).not.toHaveBeenCalled(); expect(removedFromTabOrder.focus).not.toHaveBeenCalled();
  handler(event("Escape")); expect(close).toHaveBeenCalledOnce(); release();
  expect(previous.focus).toHaveBeenCalledOnce(); expect(card.removeEventListener).toHaveBeenCalledOnce();
  expect(card.setAttribute).toHaveBeenCalledWith("aria-modal", "true");
});
