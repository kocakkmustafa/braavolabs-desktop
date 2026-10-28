import { describe, expect, it, vi } from "vitest";
import { withinRequestBudget, boundedJson } from "../request-budget";
import { directChat, DIRECT_PROVIDERS } from "../direct";
import { listOllamaModels } from "../local";

describe("dispatch cancellation and whole-response bounds", () => {
  it("does not dispatch an already cancelled request", async () => {
    const controller = new AbortController(); controller.abort(); const task = vi.fn();
    await expect(withinRequestBudget(task, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(task).not.toHaveBeenCalled();
  });
  it("keeps the deadline active when headers arrived but JSON never finishes", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: () => new Promise(() => {}) }));
    await expect(directChat("openai", "synthetic-key", "test-model", "hello", { fetchImpl, timeoutMs: 10 })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(fetchImpl.mock.calls[0]).toBeDefined();
  });
  it("propagates local body cancellation without calling it unreachable", async () => {
    const controller = new AbortController();
    const request = listOllamaModels("http://localhost:11434", { signal: controller.signal,
      fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }) });
    controller.abort(); await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
  it("bounds streaming bytes before parsing and cancels an oversized body", async () => {
    const cancel = vi.fn(async () => {}), releaseLock = vi.fn();
    const read = vi.fn().mockResolvedValue({ done: false, value: new Uint8Array(11) });
    await expect(boundedJson({ body: { getReader: () => ({ read, cancel, releaseLock }) } }, new AbortController().signal, 10)).rejects.toThrow("output limit");
    expect(cancel).toHaveBeenCalledOnce(); expect(releaseLock).toHaveBeenCalledOnce();
  });
  it("reassembles multibyte JSON across stream chunks", async () => {
    const bytes = new TextEncoder().encode('{"text":"日本語"}');
    let part = 0;
    const reader = { read: async () => part++ === 0 ? { value: bytes.slice(0, 11) } : part === 2 ? { value: bytes.slice(11) } : { done: true }, releaseLock() {}, cancel: async () => {} };
    expect(await boundedJson({ body: { getReader: () => reader } }, new AbortController().signal)).toEqual({ text: "日本語" });
  });
});

describe("existing F09 exact credential echo boundary", () => {
  it.each(DIRECT_PROVIDERS)("refuses redirects for credential-bearing %s fetches", async provider => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) => ({ ok: true, json: async () => ({ content: [{ type: "text", text: "ok" }], choices: [{ message: { content: "ok" } }] }) }));
    await directChat(provider, "synthetic-key", "test-model", "hello", { fetchImpl });
    expect(fetchImpl.mock.calls[0][1].redirect).toBe("error"); expect(fetchImpl).toHaveBeenCalledOnce();
  });

  const key = "fixture:short-日本語";
  it.each(["http", "fetch"])("masks an exact unusual key in %s errors", async mode => {
    const fetchImpl = mode === "http" ? async () => ({ ok: false, status: 403, json: async () => ({ error: { message: `rejected ${key}` } }) })
      : async () => { throw Error(`transport ${key}`); };
    const error = await directChat("openai", key, "test-model", "hello", { fetchImpl }).catch(error => error);
    expect(error.message).not.toContain(key); expect(error.message).toContain("[redacted]");
  });
  it("masks a successful key echo while preserving unrelated long content", async () => {
    const legitimate = "x".repeat(64);
    const result = await directChat("openai", key, "test-model", "hello", { fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: `${legitimate} ${key}` } }] }) }) });
    expect(result.content).toBe(`${legitimate} [redacted]`);
  });
});
