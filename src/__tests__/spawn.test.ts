import { describe, it, expect, vi } from "vitest";
import {
  SPAWN_VENDORS,
  VENDOR_SPECS,
  isSpawnVendor,
  knownPaths,
  buildLaunchCommand,
  spawnFallbackMessage,
  spawnRiskNote,
  createTauriSpawnProbe,
  createMemorySpawnProbe,
  type SpawnVendor,
} from "../spawn";

/** Filenames/dirs that would be OAuth token/cookie stores — rule (d): never touched. */
const TOKEN_FILE_HINTS = [".credentials", "auth.json", ".claude.json", "cookies", "/.codex/", "/.claude/", ".config/claude", ".config/codex"];
function assertNoTokenAccess(paths: string[]) {
  for (const p of paths) {
    for (const hint of TOKEN_FILE_HINTS) {
      expect(p).not.toContain(hint);
    }
  }
}

describe("isSpawnVendor / VENDOR_SPECS", () => {
  it("recognizes exactly claude and codex", () => {
    expect(SPAWN_VENDORS).toEqual(["claude", "codex"]);
    expect(isSpawnVendor("claude")).toBe(true);
    expect(isSpawnVendor("codex")).toBe(true);
    expect(isSpawnVendor("gemini")).toBe(false);
  });

  it("carries the per-vendor ToS-risk levels the blueprint mandates (rule f)", () => {
    expect(VENDOR_SPECS.claude.risk).toContain("SAFE");
    expect(VENDOR_SPECS.claude.risk.toLowerCase()).toContain("volatile");
    expect(VENDOR_SPECS.codex.risk).toContain("SAFE");
    expect(VENDOR_SPECS.codex.risk.toLowerCase()).toContain("lowest");
    // spawnRiskNote is the single accessor the UI paints steel.
    expect(spawnRiskNote("claude")).toBe(VENDOR_SPECS.claude.risk);
    // Fallback (rule g) points at the API-key path, never a vendor OAuth flow.
    expect(VENDOR_SPECS.claude.fallback).toBe('forge direct anthropic "<question>"');
    expect(VENDOR_SPECS.codex.fallback).toBe('forge direct openai "<question>"');
  });
});

describe("knownPaths — neutral discovery contract (rule d)", () => {
  it("known paths are neutral bin dirs, never a vendor config/token dir", () => {
    assertNoTokenAccess([...knownPaths("claude", "/home/u"), ...knownPaths("codex", "/home/u")]);
  });

  it("every probed path ends in the bare binary name — pure executable lookups", () => {
    for (const p of [...knownPaths("claude", "/home/u"), ...knownPaths("codex", "/home/u")]) {
      expect(p).toMatch(/\/(claude|codex)$/);
    }
  });

  it("codex adds .cargo/bin (rust install prefix); claude does not", () => {
    expect(knownPaths("codex", "/home/u")).toContain("/home/u/.cargo/bin/codex");
    expect(knownPaths("claude", "/home/u").some((p) => p.includes(".cargo"))).toBe(false);
  });
});

describe("buildLaunchCommand — argv array, no shell string (rule b)", () => {
  it("keeps args VERBATIM as an inert array (a malicious token can't break out)", () => {
    const plan = buildLaunchCommand("claude", ["-p", "hi; rm -rf /", "--model", "sonnet"]);
    expect(plan.bin).toBe("claude");
    expect(Array.isArray(plan.argv)).toBe(true);
    expect(plan.argv).toEqual(["claude", "-p", "hi; rm -rf /", "--model", "sonnet"]);
    // The dangerous-looking token stays a single element — never concatenated
    // into one shell string where it could form a command separator.
    expect(plan.argv.filter((a) => a === "hi; rm -rf /")).toHaveLength(1);
    for (const a of plan.argv) expect(typeof a).toBe("string");
  });

  it("delegates the interactive session to the proven `forge spawn` CLI path", () => {
    const plan = buildLaunchCommand("codex", ["--dir", "/work"]);
    expect(plan.cliDelegation).toEqual(["forge", "spawn", "codex", "--dir", "/work"]);
    expect(Array.isArray(plan.cliDelegation)).toBe(true);
  });
});

describe("spawnFallbackMessage — graceful API-key degrade (rule g)", () => {
  it("names the missing CLI and the API-key command that bypasses it", () => {
    const fb = spawnFallbackMessage("codex");
    expect(fb.notFound).toBe("codex CLI not found");
    expect(fb.useApiKey).toBe('forge direct openai "<question>"');
    const fbc = spawnFallbackMessage("claude");
    expect(fbc.notFound).toBe("claude CLI not found");
    expect(fbc.useApiKey).toBe('forge direct anthropic "<question>"');
  });
});

describe("createMemorySpawnProbe — non-Tauri fallback", () => {
  it("reports NOT installed by default (a webview cannot detect binaries)", async () => {
    const probe = createMemorySpawnProbe();
    const s = await probe.probe("claude");
    expect(s).toEqual({ vendor: "claude", installed: false, path: undefined, version: undefined, risk: VENDOR_SPECS.claude.risk });
  });

  it("honours injected fixtures and stamps the local risk note", async () => {
    const probe = createMemorySpawnProbe({ codex: { installed: true, path: "/opt/homebrew/bin/codex", version: "codex 1.0.0" } });
    const all = await probe.probeAll();
    const codex = all.find((s) => s.vendor === "codex")!;
    const claude = all.find((s) => s.vendor === "claude")!;
    expect(codex).toMatchObject({ installed: true, path: "/opt/homebrew/bin/codex", version: "codex 1.0.0", risk: VENDOR_SPECS.codex.risk });
    expect(claude.installed).toBe(false);
    // A fixture path must still be a neutral one (rule d).
    assertNoTokenAccess(all.map((s) => s.path ?? ""));
  });
});

describe("createTauriSpawnProbe — thin host delegation (rules b, d)", () => {
  it("invokes spawn_probe with ONLY the vendor name — never a path or token", async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      return { installed: true, path: "/opt/homebrew/bin/claude", version: "claude 1.2.3" };
    });
    const probe = createTauriSpawnProbe(invoke);
    const s = await probe.probe("claude");
    expect(s).toMatchObject({ vendor: "claude", installed: true, path: "/opt/homebrew/bin/claude", version: "claude 1.2.3", risk: VENDOR_SPECS.claude.risk });
    expect(calls).toEqual([{ cmd: "spawn_probe", args: { vendor: "claude" } }]);
    // The command boundary never carries a token/credential hint in either direction.
    for (const c of calls) {
      assertNoTokenAccess(Object.values(c.args ?? {}).map(String));
    }
    assertNoTokenAccess([s.path ?? ""]);
  });

  it("maps a not-installed host reply to the honest fallback state", async () => {
    const invoke = vi.fn(async () => ({ installed: false }));
    const probe = createTauriSpawnProbe(invoke);
    const s = await probe.probe("codex");
    expect(s.installed).toBe(false);
    expect(s.path).toBeUndefined();
    expect(s.version).toBeUndefined();
    // Risk is stamped locally — a compromised host can't inject a bogus label.
    expect(s.risk).toBe(VENDOR_SPECS.codex.risk);
  });

  it("stays 'installed' with no version when the host reports null version (rule d: never peeks at login state)", async () => {
    const invoke = vi.fn(async () => ({ installed: true, path: "/usr/local/bin/codex", version: null }));
    const probe = createTauriSpawnProbe(invoke);
    const s = await probe.probe("codex");
    expect(s.installed).toBe(true);
    expect(s.version).toBeUndefined();
    expect(s.path).toBe("/usr/local/bin/codex");
  });

  it("probeAll fans out over exactly the known vendors", async () => {
    const seen: string[] = [];
    const invoke = vi.fn(async (_cmd: string, args?: Record<string, unknown>) => {
      seen.push(String((args as { vendor: SpawnVendor }).vendor));
      return { installed: false };
    });
    const statuses = await createTauriSpawnProbe(invoke).probeAll();
    expect(statuses.map((s) => s.vendor).sort()).toEqual(["claude", "codex"]);
    expect(seen.sort()).toEqual(["claude", "codex"]);
  });
});
