import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ltr } from "../bidi";
import { renderSentChips } from "../attachments-view";
import { buildAbout } from "../update-view";
import { makeT } from "../i18n";

// jsdom is not a dependency; a tiny stand-in is enough to read the `dir` attribute the views set.
class FakeNode {
  className = ""; dir = ""; hidden = false; title = ""; type = ""; disabled = false; textContent = "";
  children: FakeNode[] = []; attrs: Record<string, string> = {};
  constructor(public tag: string) {}
  append(...n: unknown[]) { for (const x of n) this.children.push(typeof x === "string" ? Object.assign(new FakeNode("#text"), { textContent: x }) : (x as FakeNode)); }
  replaceChildren(...n: unknown[]) { this.children = []; this.append(...n); }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener() {}
  find(pred: (n: FakeNode) => boolean): FakeNode[] { return [...(pred(this) ? [this] : []), ...this.children.flatMap(c => c.find(pred))]; }
}
const saved = (globalThis as { document?: unknown }).document;
beforeAll(() => {
  (globalThis as { document?: unknown }).document = {
    createElement: (t: string) => new FakeNode(t),
    createElementNS: (_n: string, t: string) => new FakeNode(t),
    createTextNode: (s: string) => Object.assign(new FakeNode("#text"), { textContent: s }),
  };
});
afterEach(() => { /* nothing global to reset */ });
const restore = () => { (globalThis as { document?: unknown }).document = saved; };
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const t = makeT("ar");

describe("RTL lock: paths, targets and identifiers keep dir=ltr (BRA-ADAY-8)", () => {
  it("ltr() sets dir=ltr and returns the same node", () => {
    const n = new FakeNode("span") as unknown as HTMLElement;
    expect(ltr(n)).toBe(n);
    expect(n.dir).toBe("ltr");
  });
  it("attachment chip file names are dir=ltr (UI-09)", () => {
    const row = renderSentChips([{ name: "تقرير/report.pdf", size: 10 }], t, "ar") as unknown as FakeNode;
    const nm = row.find(n => n.className === "att-nm");
    expect(nm).toHaveLength(1);
    expect(nm[0].dir).toBe("ltr");
    expect(nm[0].textContent).toBe("تقرير/report.pdf");
  });
  it("About version value is dir=ltr (UI-11)", () => {
    const about = buildAbout({ t, version: "1.2.3", invoke: async () => undefined }, null, () => "") as unknown as FakeNode;
    const v = about.find(n => n.className === "mono");
    expect(v[0].dir).toBe("ltr");
    expect(v[0].textContent).toBe("1.2.3");
    restore();
  });
  it("publish flow (UI-10): branch input, repo/branch rows, done card branch and URL are dir=ltr", () => {
    const src = read("publish-view.ts");
    expect(src).toContain("ltr(branchIn)");
    expect(src).toContain('mono ? ltr(make("span", "approve-v mono", v))');
    expect(src).toMatch(/const br = ltr\(make\("div", "pb-line mono"/);
    expect(src).toMatch(/const link = ltr\(make\("div", "pb-line mono pb-url"/);
  });
  it("changes list, MCP and launch-command surfaces are dir=ltr; computer-pane bundle ids too", () => {
    const ui = read("ui.ts");
    for (const needle of [
      'ltr(el("input", "changes-path"))', 'ltr(el("span", "changes-file mono"', "dir ? ltr(dirLabel) : dirLabel",
      'ltr(el("div", "laneb-cmd mono"))', 'ltr(el("span", "mcp-name mono"', 'ltr(el("span", "mcp-cmd mono"', 'ltr(el("span", "mcp-tool-name mono"',
    ]) expect(ui, needle).toContain(needle);
    expect(read("computer-pane.ts")).toContain('ltr(el("span", "cp-sub mono", a.bundleId))');
  });
});
