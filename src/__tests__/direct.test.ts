import { describe, it, expect, vi } from "vitest";
import {
  DIRECT_PROVIDERS,
  DIRECT_DEFAULT_MODEL,
  isDirectProvider,
  resolveDirectModel,
  directChat,
  DirectApiError,
} from "../direct";

function resp(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: `status ${status}`,
    json: async () => body,
  };
}

describe("provider guards + model resolution", () => {
  it("recognises exactly anthropic/openai/groq", () => {
    expect(DIRECT_PROVIDERS).toEqual(["anthropic", "openai", "groq"]);
    expect(isDirectProvider("openai")).toBe(true);
    expect(isDirectProvider("gemini")).toBe(false);
  });

  it("resolves an explicit model override, else the dated default (never 'latest')", () => {
    expect(resolveDirectModel("anthropic")).toBe(DIRECT_DEFAULT_MODEL.anthropic);
    expect(resolveDirectModel("anthropic", "  ")).toBe(DIRECT_DEFAULT_MODEL.anthropic);
    expect(resolveDirectModel("openai", "gpt-4o")).toBe("gpt-4o");
    // defaults are dated identifiers, not moving aliases
    expect(DIRECT_DEFAULT_MODEL.anthropic).toMatch(/\d{8}$/);
  });
});

describe("directChat auth-header shape per provider", () => {
  it("anthropic uses x-api-key (NOT Authorization/Bearer) + anthropic-version", async () => {
    const calls: any[] = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return resp(200, { content: [{ type: "text", text: "claude says hi" }] });
    });
    const out = await directChat("anthropic", "sk-ant-KEY", "claude-3-5-sonnet-20241022", "hello", { fetchImpl });
    expect(out).toEqual({ content: "claude says hi", model: "claude-3-5-sonnet-20241022", provider: "anthropic" });
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].init.headers["x-api-key"]).toBe("sk-ant-KEY");
    expect(calls[0].init.headers.Authorization).toBeUndefined();
    expect(calls[0].init.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(calls[0].init.body);
    expect(body.max_tokens).toBe(1024);
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("openai uses Authorization: Bearer and parses choices[0].message.content", async () => {
    const calls: any[] = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return resp(200, { choices: [{ message: { content: "gpt says hi" } }] });
    });
    const out = await directChat("openai", "sk-oai-KEY", "gpt-4o-mini", "hello", { fetchImpl });
    expect(out.content).toBe("gpt says hi");
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].init.headers.Authorization).toBe("Bearer sk-oai-KEY");
    expect(calls[0].init.headers["x-api-key"]).toBeUndefined();
  });

  it("groq uses the OpenAI-compatible endpoint + Bearer auth", async () => {
    const calls: any[] = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return resp(200, { choices: [{ message: { content: "groq says hi" } }] });
    });
    const out = await directChat("groq", "gsk-KEY", "llama-3.1-8b-instant", "hello", { fetchImpl });
    expect(out.content).toBe("groq says hi");
    expect(calls[0].url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(calls[0].init.headers.Authorization).toBe("Bearer gsk-KEY");
  });

  it("throws DirectApiError (with status + provider) on a non-ok response", async () => {
    const fetchImpl = vi.fn(async () => resp(401, { error: { message: "invalid x-api-key" } }));
    const err = await directChat("anthropic", "bad", "claude-3-5-sonnet-20241022", "x", { fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(DirectApiError);
    expect(err.status).toBe(401);
    expect(err.provider).toBe("anthropic");
    expect(err.message).toMatch(/invalid x-api-key/);
  });

  it("never echoes the raw key in the thrown error", async () => {
    const fetchImpl = vi.fn(async () => resp(403, { error: { message: "forbidden" } }));
    const err = await directChat("openai", "sk-SECRETKEYVALUE", "gpt-4o-mini", "x", { fetchImpl }).catch((e) => e);
    expect(String(err.message)).not.toContain("sk-SECRETKEYVALUE");
  });
});
