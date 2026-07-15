import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_OLLAMA_HOST,
  resolveOllamaHost,
  listOllamaModels,
  ollamaChat,
  resolveOllamaModel,
  OllamaUnreachableError,
} from "../local";

function resp(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: `status ${status}`,
    json: async () => body,
  };
}

describe("resolveOllamaHost", () => {
  it("defaults to localhost:11434 and strips trailing slashes", () => {
    expect(resolveOllamaHost()).toBe(DEFAULT_OLLAMA_HOST);
    expect(resolveOllamaHost("http://box:11434/")).toBe("http://box:11434");
    expect(resolveOllamaHost("http://box:11434///")).toBe("http://box:11434");
  });
});

describe("listOllamaModels (GET /api/tags)", () => {
  it("returns installed model names and drops empties", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://localhost:11434/api/tags");
      return resp(200, { models: [{ name: "llama3.1:8b" }, { name: "" }, { name: "qwen2.5:7b" }] });
    });
    expect(await listOllamaModels(DEFAULT_OLLAMA_HOST, { fetchImpl })).toEqual(["llama3.1:8b", "qwen2.5:7b"]);
  });

  it("throws OllamaUnreachableError on a non-ok response", async () => {
    const fetchImpl = vi.fn(async () => resp(500, {}));
    await expect(listOllamaModels(DEFAULT_OLLAMA_HOST, { fetchImpl })).rejects.toBeInstanceOf(OllamaUnreachableError);
  });

  it("throws OllamaUnreachableError when the socket is refused (fetch rejects)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(listOllamaModels(DEFAULT_OLLAMA_HOST, { fetchImpl })).rejects.toBeInstanceOf(OllamaUnreachableError);
  });
});

describe("ollamaChat (POST /api/chat, stream:false)", () => {
  it("sends the one-shot non-streamed shape and parses message.content", async () => {
    const calls: any[] = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return resp(200, { model: "llama3.1:8b", message: { content: "hi there" } });
    });
    const out = await ollamaChat(DEFAULT_OLLAMA_HOST, "llama3.1:8b", "hello", { fetchImpl });
    expect(out).toEqual({ content: "hi there", model: "llama3.1:8b" });
    expect(calls[0].url).toBe("http://localhost:11434/api/chat");
    expect(calls[0].init.method).toBe("POST");
    const body = JSON.parse(calls[0].init.body);
    expect(body.stream).toBe(false);
    expect(body.model).toBe("llama3.1:8b");
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("surfaces the server error string on a non-ok response", async () => {
    const fetchImpl = vi.fn(async () => resp(400, { error: "model 'ghost' not found" }));
    await expect(ollamaChat(DEFAULT_OLLAMA_HOST, "ghost", "x", { fetchImpl })).rejects.toThrow(/not found/);
  });
});

describe("resolveOllamaModel", () => {
  it("honours an explicit choice without hitting the network", async () => {
    const fetchImpl = vi.fn(async () => resp(200, { models: [] }));
    expect(await resolveOllamaModel(DEFAULT_OLLAMA_HOST, "mistral:7b", { fetchImpl })).toBe("mistral:7b");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back to the first installed model", async () => {
    const fetchImpl = vi.fn(async () => resp(200, { models: [{ name: "phi3:mini" }, { name: "llama3.1:8b" }] }));
    expect(await resolveOllamaModel(DEFAULT_OLLAMA_HOST, undefined, { fetchImpl })).toBe("phi3:mini");
  });

  it("throws (never guesses a name) when nothing is installed", async () => {
    const fetchImpl = vi.fn(async () => resp(200, { models: [] }));
    await expect(resolveOllamaModel(DEFAULT_OLLAMA_HOST, undefined, { fetchImpl })).rejects.toThrow(/No local Ollama models/);
  });
});
