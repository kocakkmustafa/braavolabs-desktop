import { describe, it, expect, vi } from "vitest";
import {
  maskKey,
  createMemoryKeyVault,
  createTauriKeyVault,
} from "../keyvault";

describe("maskKey", () => {
  it("shows first4…last4 for a long key and nothing meaningful for short ones", () => {
    expect(maskKey("sk-ant-api03-ABCDEFGH1234")).toBe("sk-a…1234");
    expect(maskKey("shortkey")).toBe("…"); // 8 chars ⇒ fully hidden
    expect(maskKey("")).toBe("…");
    expect(maskKey("  ")).toBe("…");
  });

  it("never leaks the middle of the secret", () => {
    const secret = "sk-proj-SUPERSECRETMIDDLE-tail";
    const masked = maskKey(secret);
    expect(masked).not.toContain("SUPERSECRETMIDDLE");
    expect(masked.length).toBeLessThan(secret.length);
  });
});

describe("createMemoryKeyVault (dev/test fallback — never touches disk)", () => {
  it("round-trips add → list(masked) → get(raw) → remove", async () => {
    const v = createMemoryKeyVault();
    expect(await v.list()).toEqual([]);

    await v.add("openai", "sk-openai-ABCDWXYZ0000");
    await v.add("anthropic", "sk-ant-QRSTuvwx1111");

    const list = await v.list();
    // sorted by provider; masked only
    expect(list).toEqual([
      { provider: "anthropic", masked: "sk-a…1111" },
      { provider: "openai", masked: "sk-o…0000" },
    ]);
    // raw secret retrievable only via get()
    expect(await v.get("openai")).toBe("sk-openai-ABCDWXYZ0000");

    await v.remove("openai");
    expect((await v.list()).map((e) => e.provider)).toEqual(["anthropic"]);
    expect(await v.get("openai")).toBeUndefined();
  });

  it("list() output carries no raw secret anywhere (masked-only render guarantee)", async () => {
    const v = createMemoryKeyVault();
    const raw = "gsk-groqRAWSECRETvalue9999";
    await v.add("groq", raw);
    const serialized = JSON.stringify(await v.list());
    expect(serialized).not.toContain(raw);
    expect(serialized).not.toContain("RAWSECRET");
  });

  it("rejects an empty provider or empty secret", async () => {
    const v = createMemoryKeyVault();
    await expect(v.add("", "x")).rejects.toThrow(/provider/);
    await expect(v.add("openai", "   ")).rejects.toThrow(/secret/);
  });

  it("upserts a provider's key rather than duplicating it", async () => {
    const v = createMemoryKeyVault();
    await v.add("openai", "sk-old-AAAABBBB1111");
    await v.add("openai", "sk-new-CCCCDDDD2222");
    const list = await v.list();
    expect(list).toHaveLength(1);
    expect(await v.get("openai")).toBe("sk-new-CCCCDDDD2222");
  });
});

describe("createTauriKeyVault (delegates to the Rust key commands)", () => {
  it("maps add/list/remove/get onto invoke with the right command names + args", async () => {
    const calls: any[] = [];
    const invoke = vi.fn(async (cmd: string, args?: any) => {
      calls.push({ cmd, args });
      if (cmd === "key_list") return [{ provider: "openai", masked: "sk-o…0000" }];
      if (cmd === "key_get") return "sk-openai-RAWSECRET0000";
      return null;
    });
    const v = createTauriKeyVault(invoke);

    await v.add("openai", "sk-openai-RAWSECRET0000");
    expect(await v.list()).toEqual([{ provider: "openai", masked: "sk-o…0000" }]);
    expect(await v.get("openai")).toBe("sk-openai-RAWSECRET0000");
    await v.remove("openai");

    expect(calls.map((c) => c.cmd)).toEqual(["key_add", "key_list", "key_get", "key_remove"]);
    expect(calls[0].args).toEqual({ provider: "openai", secret: "sk-openai-RAWSECRET0000" });
    expect(calls[3].args).toEqual({ provider: "openai" });
  });

  it("tolerates a null list() result and null get() (nothing stored yet)", async () => {
    const invoke = vi.fn(async () => null);
    const v = createTauriKeyVault(invoke);
    expect(await v.list()).toEqual([]);
    expect(await v.get("anthropic")).toBeUndefined();
  });
});
