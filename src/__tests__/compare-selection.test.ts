import { afterEach, describe, expect, it, vi } from "vitest";
import { invalidateSession, listCompareSelectionOptions, startCompare } from "../client";
import { parseCompareSelectionOptions } from "../compare-selection";
import { createCompareControls } from "../compare-controls";
import { makeT } from "../i18n";
import type { Config } from "../config";

const cfg = (): Config => ({ apiUrl: "https://host/api/v1", token: "synthetic-token" });
const options = (companyId = "company") => ({ companyId, maxCandidates: 3, selections: [
  { provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEfforts: ["low", "medium", "high"] },
  { provider: "OPENAI", model: "gpt-4o", reasoningEfforts: [] },
  { provider: "CUSTOM", model: "opaque-model", reasoningEfforts: [] },
  { provider: "OLLAMA", model: "local-exact", reasoningEfforts: [] },
] });
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "synthetic", json: async () => body });

describe("compare selection wire contract", () => {
  it("discovers company-scoped options with auth and encoded company", async () => {
    const fetchImpl = vi.fn(async () => response(options("company /?#")));
    expect(await listCompareSelectionOptions(cfg(), "company /?#", { fetchImpl })).toEqual(options("company /?#"));
    expect(fetchImpl.mock.calls[0]).toEqual(expect.arrayContaining([
      "https://host/api/v1/research/compare/options?companyId=company%20%2F%3F%23",
      expect.objectContaining({ method: "GET", headers: expect.objectContaining({ Authorization: "Bearer synthetic-token" }) }),
    ]));
  });
  it.each(["low", "medium", "high"] as const)("preserves exact %s effort at the selected endpoint", async reasoningEffort => {
    const fetchImpl = vi.fn(async () => response({ id: "research", status: "PENDING" }, 201));
    const selections = [{ provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEffort }, { provider: "OPENAI", model: "gpt-4o" }];
    await startCompare(cfg(), { companyId: "company", query: "question", selections, maxCandidates: 2, maxTokensPerCandidate: 512, maxCostUsd: 1 }, { fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://host/api/v1/research/compare/selected");
    expect(JSON.parse(init.body as string)).toEqual({ companyId: "company", query: "question", selections, maxCandidates: 2, maxTokensPerCandidate: 512, maxCostUsd: 1 });
  });
  it("keeps provider effort omitted and rejects an older selected endpoint without retry/fallback", async () => {
    const fetchImpl = vi.fn(async () => response({ error: "unsupported" }, 404));
    await expect(startCompare(cfg(), { companyId: "company", query: "question", selections: [{ provider: "CEREBRAS", model: "gpt-oss-120b" }] }, { fetchImpl })).rejects.toMatchObject({ status: 404 });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).selections[0]).not.toHaveProperty("reasoningEffort");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it.each([
    { ...options(), companyId: "other" }, { ...options(), maxCandidates: 4 },
    { ...options(), selections: [{ provider: "P", model: "M" }] },
    { ...options(), selections: [{ provider: "P", model: "M", reasoningEfforts: ["none"] }] },
    { ...options(), selections: [options().selections[0], options().selections[0]] },
  ])("rejects unusable discovery metadata before enabling selection", raw => {
    expect(() => parseCompareSelectionOptions(raw, "company")).toThrow();
  });
});

class Element {
  value = ""; textContent = ""; className = ""; type = ""; checked = false; disabled = false;
  style: Record<string, string> = {}; children: Element[] = []; attributes: Record<string, string> = {};
  handlers = new Map<string, () => void>();
  constructor(readonly tag: string) {}
  append(...nodes: Element[]) {
    if (this.tag === "select" && !this.children.length && nodes[0]) this.value = nodes[0].value;
    this.children.push(...nodes);
  }
  replaceChildren() { this.children = []; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener(key: string, handler: () => void) { this.handlers.set(key, handler); }
  fire(key: string) { this.handlers.get(key)!(); }
}
function fixture(locale: "en" | "tr" = "en") {
  vi.stubGlobal("document", { createElement: (tag: string) => new Element(tag), createTextNode: (text: string) => Object.assign(new Element("text"), { textContent: text }) });
  const fetchImpl = vi.fn(async () => response(options())); vi.stubGlobal("fetch", fetchImpl);
  const c = cfg(); let company = "company", mounted = true;
  const controls = createCompareControls(c, makeT(locale), () => company, () => mounted);
  const [mode, load, status, rows] = (controls.element as unknown as Element).children;
  const selected = () => { mode.value = "selected"; mode.fire("change"); };
  const discover = async () => { load.fire("click"); await vi.waitFor(() => expect(load.disabled).toBe(false)); };
  const row = (index: number) => {
    const children = rows.children[index].children;
    return { check: children[0].children[0], effort: children[1] };
  };
  return { ...controls, c, mode, load, status, rows, selected, discover, row, fetchImpl,
    company: (value: string) => { company = value; controls.invalidate(); }, dispose: () => { mounted = false; } };
}
afterEach(() => vi.unstubAllGlobals());

describe("actual compare DOM controls", () => {
  it.each(["en", "tr"] as const)("uses server-advertised efforts and keeps defaults omitted in %s", async locale => {
    const f = fixture(locale);
    expect(f.read("company")).toBeUndefined(); expect(f.fetchImpl).not.toHaveBeenCalled();
    f.selected(); expect(() => f.read("company")).toThrow(); await f.discover();
    expect(f.rows.children).toHaveLength(4);
    expect(f.row(1).effort).toBeUndefined(); expect(f.row(2).effort).toBeUndefined();
    const { check, effort } = f.row(0);
    expect(effort.children.map(c => c.value)).toEqual(["", "low", "medium", "high"]);
    expect(effort.attributes["aria-label"]).not.toContain("chat.");
    expect(effort.disabled).toBe(true); check.checked = true; check.fire("change");
    expect(effort.disabled).toBe(false);
    expect(f.read("company")).toEqual([{ provider: "CEREBRAS", model: "gpt-oss-120b" }]);
    effort.value = "high";
    expect(f.read("company")).toEqual([{ provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEffort: "high" }]);
    check.checked = false; check.fire("change"); expect(effort.value).toBe(""); expect(effort.disabled).toBe(true);
    check.checked = true; check.fire("change"); expect(f.read("company")![0]).not.toHaveProperty("reasoningEffort");
  });
  it("caps at three, requires one, and does not persist manual choice on lane invalidation", async () => {
    const f = fixture(); f.selected(); await f.discover(); expect(() => f.read("company")).toThrow();
    for (const i of [0, 1, 2]) { const { check } = f.row(i); check.checked = true; check.fire("change"); }
    expect(f.row(3).check.disabled).toBe(true); expect(f.read("company")).toHaveLength(3);
    f.row(0).check.checked = false; f.row(0).check.fire("change"); expect(f.row(3).check.disabled).toBe(false);
    f.invalidate(); expect(() => f.read("company")).toThrow(); expect(f.rows.children).toHaveLength(0);
  });
  it.each(["company", "account", "base", "dispose", "mode"])("discards delayed metadata after %s changes", async boundary => {
    const f = fixture(); let finish!: (value: ReturnType<typeof response>) => void;
    f.fetchImpl.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    f.selected(); f.load.fire("click"); expect(() => f.read("company")).toThrow();
    if (boundary === "company") f.company("other");
    if (boundary === "account") { invalidateSession(f.c); f.c.token = "other"; }
    if (boundary === "base") f.c.apiUrl = "https://other/api/v1";
    if (boundary === "dispose") f.dispose();
    if (boundary === "mode") { f.mode.value = "automatic"; f.mode.fire("change"); }
    finish(response(options())); await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.rows.children).toHaveLength(0);
    if (boundary !== "mode") expect(() => f.read("company")).toThrow();
  });
  it("requires fresh discovery for a different company or account even without an input event", async () => {
    const f = fixture(); f.selected(); await f.discover(); f.row(0).check.checked = true;
    expect(() => f.read("other")).toThrow(); invalidateSession(f.c); expect(() => f.read("company")).toThrow();
  });
  it.each([404, 503])("keeps explicit mode blocked on discovery %s without automatic inference", async status => {
    const f = fixture(); f.fetchImpl.mockImplementation(async () => response({ error: "RAW_PRIVATE_DETAIL" }, status));
    f.selected(); await f.discover(); expect(() => f.read("company")).toThrow();
    expect(f.status.textContent).toBe(makeT("en")("chat.modelsUnavailable"));
    expect(f.rows.children).toHaveLength(0); expect(f.fetchImpl).toHaveBeenCalledOnce();
  });
  it("does not infer a model or effort when discovery returns no models", async () => {
    const f = fixture(); f.fetchImpl.mockImplementation(async () => response({ ...options(), selections: [] }));
    f.selected(); await f.discover(); expect(() => f.read("company")).toThrow();
    expect(f.status.textContent).toBe(makeT("en")("chat.noModels"));
  });
});
