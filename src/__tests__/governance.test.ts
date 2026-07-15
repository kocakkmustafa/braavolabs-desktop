import { describe, it, expect, vi } from "vitest";
import {
  ACTION_KINDS,
  classifyAction,
  isTraversal,
  isDestructive,
  redactSummary,
  policyRows,
  createMemoryLedger,
  createMemoryGovernance,
  createTauriGovernance,
} from "../governance";

// A raw-secret canary: if any of these ever appears in an audit entry, the
// no-secret guarantee is broken.
const SECRET = "sk-ant-SUPERSECRET0123456789abcdef0123456789";

describe("classifyAction — the fail-closed policy", () => {
  it("fails CLOSED: an unknown action kind requires approval (never auto-allow)", () => {
    const r = classifyAction("totally.unknown.kind");
    expect(r.decision).toBe("require-approval");
    expect(r.reason).toContain("unknown");
  });

  it("auto-allows ONLY the explicit read-only / local-keyless set", () => {
    expect(classifyAction("probe.detect").decision).toBe("auto-allow");
    expect(classifyAction("local.dispatch").decision).toBe("auto-allow");
  });

  it("requires approval for every external-side-effect kind", () => {
    for (const kind of ["direct.dispatch", "spawn.launch", "mcp.tool", "file.write"]) {
      expect(classifyAction(kind).decision).toBe("require-approval");
    }
    // command.run with a benign argv is approval, not auto-allow.
    expect(classifyAction("command.run", { argv: ["ls", "-la"] }).decision).toBe("require-approval");
  });

  it("hard-DENIES a destructive command (rm -rf) — never even approvable", () => {
    const r = classifyAction("command.run", { argv: ["rm", "-rf", "/"] });
    expect(r.decision).toBe("deny");
    expect(isDestructive("rm -rf /")).toBe(true);
    expect(isDestructive("ls -la")).toBe(false);
  });

  it("hard-DENIES a file.write that escapes via path traversal", () => {
    expect(classifyAction("file.write", { path: "../../etc/passwd" }).decision).toBe("deny");
    expect(isTraversal("a/../b")).toBe(true);
    expect(isTraversal("a/b/c")).toBe(false);
    // A normal write path is approval, not deny.
    expect(classifyAction("file.write", { path: "notes/todo.md" }).decision).toBe("require-approval");
  });
});

describe("policyRows — Settings visibility table", () => {
  it("lists every known kind with a disposition; only the explicit set is auto", () => {
    const rows = policyRows();
    expect(rows.map((r) => r.kind).sort()).toEqual([...ACTION_KINDS].sort());
    const auto = rows.filter((r) => r.decision === "auto-allow").map((r) => r.kind).sort();
    expect(auto).toEqual(["local.dispatch", "probe.detect"]);
  });
});

describe("redactSummary — audit never carries a secret", () => {
  it("scrubs sk- keys, Bearer tokens and long opaque strings", () => {
    expect(redactSummary(`key=${SECRET}`)).not.toContain(SECRET);
    expect(redactSummary("auth Bearer abcdef123456ZZ")).toContain("«redacted»");
    expect(redactSummary("plain human text")).toBe("plain human text");
  });
});

describe("gate lifecycle — auto-allow", () => {
  it("mints a token immediately and audits a 'granted' entry", async () => {
    const ledger = createMemoryLedger();
    const gov = createMemoryGovernance(ledger);
    const res = await gov.request("local.dispatch", { summary: "local chat" });
    expect(res.decision).toBe("auto-allow");
    expect(res.token).toBeTruthy();
    const log = await gov.recent(10);
    expect(log.at(-1)).toMatchObject({ kind: "local.dispatch", outcome: "granted" });
    // A minted auto-allow token is spendable exactly once.
    expect(await gov.consume(res.token!, "local.dispatch", { summary: "local chat" })).toBe(true);
  });
});

describe("gate lifecycle — require-approval", () => {
  it("returns NO token on request and audits 'pending'", async () => {
    const gov = createMemoryGovernance();
    const res = await gov.request("direct.dispatch", { provider: "anthropic", summary: "ask anthropic" });
    expect(res.decision).toBe("require-approval");
    expect(res.token).toBeUndefined();
    expect((await gov.recent(1))[0]).toMatchObject({ outcome: "pending" });
  });

  it("approve() mints a token and consume() succeeds exactly once (replay rejected)", async () => {
    const gov = createMemoryGovernance();
    const detail = { provider: "openai", summary: "ask openai" };
    const req = await gov.request("direct.dispatch", detail);
    const { token } = await gov.approve(req.actionId);
    expect(token).toBeTruthy();
    expect(await gov.consume(token, "direct.dispatch", detail)).toBe(true);
    // Replay: the same token can NOT be spent a second time.
    expect(await gov.consume(token, "direct.dispatch", detail)).toBe(false);
    const outcomes = (await gov.recent(20)).map((e) => e.outcome);
    expect(outcomes).toContain("approved");
    expect(outcomes).toContain("consumed");
    expect(outcomes).toContain("replay-rejected");
  });

  it("reject() removes the pending action so no token can ever be minted", async () => {
    const gov = createMemoryGovernance();
    const req = await gov.request("mcp.tool", { tool: "search", server: "x" });
    await gov.reject(req.actionId);
    expect((await gov.recent(1))[0]).toMatchObject({ outcome: "rejected" });
    await expect(gov.approve(req.actionId)).rejects.toThrow();
  });
});

describe("gate enforcement — nothing runs without passing the gate", () => {
  it("a forged token (never issued) is refused", async () => {
    const gov = createMemoryGovernance();
    expect(await gov.consume("tok_forged_deadbeef", "command.run", { argv: ["ls"] })).toBe(false);
    expect((await gov.recent(1))[0]).toMatchObject({ outcome: "replay-rejected" });
  });

  it("a token bound to action A cannot authorize action B (kind mismatch)", async () => {
    const gov = createMemoryGovernance();
    const a = await gov.request("spawn.launch", { vendor: "claude", summary: "launch claude" });
    const { token } = await gov.approve(a.actionId);
    // Right token, wrong kind → refused.
    expect(await gov.consume(token, "direct.dispatch", { provider: "anthropic" })).toBe(false);
  });

  it("a token bound to detail A cannot authorize the same kind with detail B", async () => {
    const gov = createMemoryGovernance();
    const a = await gov.request("command.run", { argv: ["echo", "a"] });
    const { token } = await gov.approve(a.actionId);
    expect(await gov.consume(token, "command.run", { argv: ["echo", "DIFFERENT"] })).toBe(false);
    // The correctly-bound consume still works.
    const b = await gov.request("command.run", { argv: ["echo", "b"] });
    const t2 = await gov.approve(b.actionId);
    expect(await gov.consume(t2.token, "command.run", { argv: ["echo", "b"] })).toBe(true);
  });
});

describe("audit ledger — append-only, ordered, secret-free", () => {
  it("assigns strictly increasing seq across a transition sequence", async () => {
    const gov = createMemoryGovernance();
    await gov.request("local.dispatch", { summary: "a" });
    const r = await gov.request("direct.dispatch", { provider: "groq", summary: "b" });
    await gov.approve(r.actionId);
    await gov.settle("direct.dispatch", "success", { summary: "b done" });
    const log = await gov.recent(50);
    const seqs = log.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicate seq
  });

  it("NEVER writes a raw secret into any audit entry", async () => {
    const gov = createMemoryGovernance();
    // Even if a secret leaks into a summary, it is scrubbed before storage.
    await gov.request("direct.dispatch", { provider: "anthropic", summary: `dispatch with ${SECRET}` });
    await gov.settle("direct.dispatch", "error", { summary: `failed ${SECRET}` });
    const blob = JSON.stringify(await gov.recent(50));
    expect(blob).not.toContain(SECRET);
    expect(blob).not.toContain("SUPERSECRET");
  });

  it("recent(n) returns the last n entries oldest→newest", async () => {
    const gov = createMemoryGovernance();
    for (let i = 0; i < 5; i++) await gov.request("local.dispatch", { summary: `s${i}` });
    const last2 = await gov.recent(2);
    expect(last2).toHaveLength(2);
    expect(last2[0].seq).toBeLessThan(last2[1].seq);
  });
});

describe("createTauriGovernance — delegates to the host, policy stays local", () => {
  it("request/approve/consume call the Rust commands; policy() makes NO host call", async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "request_action") return { actionId: "act_1", decision: "require-approval", reason: "side-effecting action" };
      if (cmd === "approve_action") return { token: "tok_host_1" };
      if (cmd === "consume_action") return true;
      return null;
    });
    const gov = createTauriGovernance(invoke);

    const req = await gov.request("mcp.tool", { tool: "web", server: "s" });
    expect(req.decision).toBe("require-approval");
    expect(req.token).toBeUndefined();
    const { token } = await gov.approve(req.actionId);
    expect(await gov.consume(token, "mcp.tool", { tool: "web", server: "s" })).toBe(true);

    // policy() is a compile-time constant — a compromised host can't lie about it.
    const policyBefore = calls.length;
    expect(gov.policy().length).toBe(ACTION_KINDS.length);
    expect(calls.length).toBe(policyBefore);

    expect(calls.map((c) => c.cmd)).toEqual(["request_action", "approve_action", "consume_action"]);
    // The token never crosses the boundary as a URL/arg secret — it's an opaque arg only on consume.
    expect(calls[2].args).toMatchObject({ token: "tok_host_1", kind: "mcp.tool" });
  });
});
