import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { createMemoryGovernance } from "../governance";

it("actual prepared UI gate observes the host action without issuing a second request", async () => {
  const source = ts.createSourceFile("ui.ts", readFileSync(new URL("../ui.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "gateForToken")!;
  const code = ts.transpileModule(fn.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const gov = createMemoryGovernance(); const request = vi.spyOn(gov, "request"), observePrepared = vi.fn();
  const deps = { gov: { ...gov, observePrepared }, t: (key: string) => key };
  const modal = vi.fn(async () => ({ approved: false }));
  const gate = runInNewContext(`${code};gateForToken`, { showApprovalModal: modal }) as (...args: any[]) => Promise<unknown>;
  const prepared = { actionId: "host-owned", kind: "mcp.tool", decision: "require-approval", reason: "native" };
  const detail = { server: "fixture", tool: "read", summary: "Read fixture" };
  expect(await gate(deps, "mcp.tool", detail, prepared)).toEqual({ ok: false, reason: "gov.rejectedByUser" });
  expect(observePrepared).toHaveBeenCalledExactlyOnceWith(prepared, detail);
  expect(request).not.toHaveBeenCalled(); expect(modal.mock.calls[0]).toBeDefined();
});
