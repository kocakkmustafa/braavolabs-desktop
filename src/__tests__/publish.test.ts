import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMemoryGovernance, classifyAction, ACTION_KINDS, type Governance } from "../governance";
import { LOCALES, MESSAGES, makeT } from "../i18n";
import { toChangeViews } from "../changes";
import {
  PUBLISH_FLAG_KEY, byteSort, draftProblems, errorCode, isPublishEnabled, isSecretPath, isValidBranch, publishSummary, runPublish, suggestBranch,
  type PublishDraft, type PublishInfo,
} from "../publish";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const info: PublishInfo = { branch: "main", repo: "aisirketim/satis-paneli", base: "main" };
const draft: PublishDraft = { branch: "braavo/x", title: "Fix totals", body: "d", draft: false };
const PAT = "github_pat_11ABCDEFG0123456789_abcdefghijklmnop";

describe("flag (criterion 1)", () => {
  it("is off unless the local flag is exactly 1, and never switched on in code", () => {
    expect(isPublishEnabled({ getItem: () => null })).toBe(false);
    expect(isPublishEnabled({ getItem: () => "true" })).toBe(false);
    expect(isPublishEnabled({ getItem: () => { throw new Error("blocked"); } })).toBe(false);
    expect(isPublishEnabled({ getItem: (k) => (k === PUBLISH_FLAG_KEY ? "1" : null) })).toBe(true);
    for (const f of readdirSync(new URL("..", import.meta.url)).filter(n => n.endsWith(".ts"))) {
      expect(read(`../${f}`), f).not.toMatch(/setItem\(\s*(PUBLISH_FLAG_KEY|["']bv\.flags\.publish)/);
    }
  });
  it("creates the publish UI only inside the flag check, so off means no button and no behaviour change", () => {
    const ui = read("../ui.ts");
    expect(ui.match(/isPublishEnabled\(\)/g)).toHaveLength(1);
    expect(ui.match(/createPublishUi\(/g)).toHaveLength(1);
    const block = ui.slice(ui.indexOf("if (isPublishEnabled())"), ui.indexOf("const renderChanges"));
    expect(block).toContain("createPublishUi(");
    expect(ui.slice(0, ui.indexOf("if (isPublishEnabled())"))).not.toContain("createPublishUi(");
  });
  it("shows the disabled/none state when nothing changed and counts honestly otherwise", () => {
    const view = read("../publish-view.ts");
    expect(view).toMatch(/button\.disabled = n === 0 \|\| running/);
    expect(view).toContain('"publish.none"');
    const sum = publishSummary(toChangeViews([{ path: "a.ts", added: 3, removed: 1, status: "M" }, { path: "b.ts", status: "??" }]));
    expect(sum).toMatchObject({ files: 2, added: 3, removed: 1, tests: "unknown" });
  });
});

describe("UI-10b merge edildi; açma kurucu kararı (bayrak varsayılan KAPALI)", () => {
  it("default is OFF and no code path, build file or config switches the flag on or makes it default-on", () => {
    expect(isPublishEnabled({ getItem: () => null })).toBe(false);
    expect(read("../publish.ts")).toContain("UI-10b merge edildi; açma kurucu kararı");
    expect(read("../publish.ts")).toMatch(/\.getItem\(PUBLISH_FLAG_KEY\) === "1"/);
    const files = [...readdirSync(new URL("..", import.meta.url)).filter(n => /\.(ts|tsx|css)$/.test(n)).map(n => `../${n}`),
      "../../index.html", "../../vite.config.ts", "../../package.json", "../../src-tauri/tauri.conf.json"];
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(/(setItem|localStorage\[)[^;\n]*(PUBLISH_FLAG_KEY|bv\.flags\.publish)/);
      expect(src, f).not.toMatch(/bv\.flags\.publish["']?\s*[:=]\s*["']?1/);
      if (!f.endsWith("publish.ts")) expect(src, f).not.toContain("bv.flags.publish");
    }
    expect(read("../publish.ts")).not.toMatch(/PUBLISH_FLAG_KEY[^;\n]*(\?\?|\|\|)\s*["']1["']/);
  });
});

describe("draft validation (criterion 2)", () => {
  it("accepts good branch names and rejects ref-injection shapes", () => {
    for (const ok of ["braavo/satis-ozeti", "feat/a_b.c", "a/b/c"]) expect(isValidBranch(ok), ok).toBe(true);
    for (const bad of ["", "-x", "--force", "+a:b", "a:b", "a..b", "a//b", "/a", "a/", "a.", ".a", "x.lock", "HEAD", "a b", "a;b", "a$(x)", "a@{1}", "a~1", "ş", "a".repeat(101)])
      expect(isValidBranch(bad), JSON.stringify(bad)).toBe(false);
  });
  it("suggests a valid branch from any title, Turkish letters included", () => {
    for (const t of ["Satış özetinde bölge toplamlarını düzelt", "", "!!!", "a".repeat(300), "İğdır ÇŞ"]) expect(isValidBranch(suggestBranch(t)), t).toBe(true);
    expect(suggestBranch("Satış özetinde bölge")).toBe("braavo/satis-ozetinde-bolge");
  });
  it("bounds title and description and refuses newlines in the title", () => {
    expect(draftProblems({ ...draft })).toEqual([]);
    expect(draftProblems({ ...draft, branch: "-x" })).toEqual(["branch"]);
    expect(draftProblems({ ...draft, title: "  " })).toEqual(["title"]);
    expect(draftProblems({ ...draft, title: "a\nb" })).toEqual(["title"]);
    expect(draftProblems({ ...draft, title: "a".repeat(201) })).toEqual(["title"]);
    expect(draftProblems({ ...draft, body: "a".repeat(4001) })).toEqual(["body"]);
  });
  it("says nothing was sent and shows the test status as unknown, never invented", () => {
    expect(makeT("tr")("publish.notSent")).toBe("Henüz hiçbir şey gönderilmedi.");
    expect(makeT("tr")("publish.testsUnknown")).toBe("Testler: bilinmiyor");
    expect(read("../publish-view.ts")).toContain('"publish.notSent"');
  });
  it("flags secret-looking changed files so they are never committed", () => {
    for (const p of [".env", "a/.env.local", "k/server.pem", "id_rsa", ".ssh/config", "credentials.json", "x/.aws/credentials"]) expect(isSecretPath(p), p).toBe(true);
    for (const p of ["src/a.ts", "README.md", "keyboard.ts"]) expect(isSecretPath(p), p).toBe(false);
    expect(publishSummary(toChangeViews([{ path: "a.ts" }, { path: ".env" }])).secrets).toEqual([".env"]);
  });
});

/** An invoke mock that records every host call. */
function host(fail?: { cmd: string; msg: string }, listing: unknown = [{ path: "a.ts", status: "M", added: 1, removed: 0 }]) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "git_changed_files") return listing; // read-only; not a write, so not recorded in `calls`
    calls.push({ cmd, args });
    if (fail && fail.cmd === cmd) throw new Error(fail.msg);
    if (cmd === "git_publish_commit") return "abc1234";
    if (cmd === "github_open_pr") return { number: 42, url: "https://github.com/aisirketim/satis-paneli/pull/42" };
    return undefined;
  };
  return { calls, invoke };
}
const run = (gov: Governance, invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>, extra: Partial<Parameters<typeof runPublish>[1]> = {}) =>
  runPublish({ invoke, gov }, { cwd: "/w", info, draft, files: ["a.ts"], ...extra });

describe("approval gate (criterion 3)", () => {
  it("makes no host call at all when the approval is declined", async () => {
    const gov = { ...createMemoryGovernance(), approve: async () => { throw new Error("rejected"); } } as Governance;
    const h = host();
    expect(await run(gov, h.invoke)).toEqual({ ok: false, step: "commit", code: "cancelled" });
    expect(h.calls).toEqual([]);
  });
  it("makes no host call when the policy denies the branch", async () => {
    const h = host();
    const r = await run(createMemoryGovernance(), h.invoke, { draft: { ...draft, branch: "--force" } });
    expect(r).toMatchObject({ ok: false, step: "commit", code: "invalidBranch" });
    expect(h.calls).toEqual([]);
  });
  it("runs commit, push, PR in order, each with its own one-time token, and returns the PR link", async () => {
    const h = host();
    const r = await run(createMemoryGovernance(), h.invoke);
    expect(r).toEqual({ ok: true, number: 42, url: "https://github.com/aisirketim/satis-paneli/pull/42", sha: "abc1234" });
    expect(h.calls.map(c => c.cmd)).toEqual(["git_publish_commit", "git_publish_push", "github_open_pr"]);
    const tokens = h.calls.map(c => c.args.token);
    expect(new Set(tokens).size).toBe(3);
    expect(tokens.every(t => typeof t === "string" && t.length > 0)).toBe(true);
  });
  it("stops at the failing step, says which, and a retry resumes from there only", async () => {
    const h = host({ cmd: "git_publish_push", msg: "publish:pushRejected" });
    const gov = createMemoryGovernance();
    const r = await run(gov, h.invoke);
    expect(r).toEqual({ ok: false, step: "push", code: "pushRejected" });
    expect(h.calls.map(c => c.cmd)).toEqual(["git_publish_commit", "git_publish_push"]);
    const h2 = host();
    const r2 = await run(gov, h2.invoke, { from: "push" });
    expect(r2.ok).toBe(true);
    expect(h2.calls.map(c => c.cmd)).toEqual(["git_publish_push", "github_open_pr"]);
  });
  it("refuses a PR link that is not a github.com page", async () => {
    const invoke = async (cmd: string): Promise<unknown> => (cmd === "git_changed_files" ? [{ path: "a.ts", status: "M" }] : cmd === "github_open_pr" ? { number: 1, url: "https://evil.example/x" } : "sha");
    expect(await run(createMemoryGovernance(), invoke)).toMatchObject({ ok: false, step: "pr", code: "unknown" });
  });
  it("registers the three kinds as approval-required, denies a bad branch, and offers no merge action", () => {
    for (const k of ["git.commit", "git.push", "github.pr"] as const) {
      expect(ACTION_KINDS).toContain(k);
      expect(classifyAction(k, { branch: "braavo/ok" }).decision).toBe("require-approval");
      expect(classifyAction(k, { branch: "+a:b" }).decision).toBe("deny");
      expect(classifyAction(k, {}).decision).toBe("deny");
    }
    expect(ACTION_KINDS.filter(k => /merge/.test(k))).toEqual([]);
    expect(classifyAction("git.merge", { branch: "x" }).reason).toContain("fail-closed");
  });
  it("binds each token to the exact branch, repo, files and title", async () => {
    const gov = createMemoryGovernance();
    const d = { cwd: "/w", branch: "braavo/x", title: "t", files: ["a.ts"] };
    const r = await gov.request("git.commit", d);
    const { token } = await gov.approve(r.actionId);
    expect(await gov.consume(token, "git.commit", { ...d, files: ["a.ts", "b.ts"] })).toBe(false);
    expect(await gov.consume(token, "git.commit", { ...d, title: "other" })).toBe(false);
    expect(await gov.consume(token, "git.commit", d)).toBe(true);
    expect(await gov.consume(token, "git.commit", d)).toBe(false);
  });
});

describe("file list order and freshness (reviewer HIGH/MEDIUM)", () => {
  // The host's own order for a real mixed working tree: tracked edits and untracked (??) files.
  const hostRaw = [
    { path: "src/zeta.ts", status: "M", added: 2, removed: 1 },
    { path: "README.md", status: "M", added: 40, removed: 3 },
    { path: "new/b.ts", status: "??" },
    { path: "src/alpha.ts", status: "M", added: 9, removed: 0 },
    { path: "new/a.ts", status: "??" },
  ];
  it("UI order (by edit size, changes.ts) and host order bind the same token", async () => {
    const ui = toChangeViews(hostRaw).map(v => v.path);
    expect(ui).not.toEqual(hostRaw.map(r => r.path)); // the orders really differ
    expect(byteSort(ui)).toEqual(byteSort(hostRaw.map(r => r.path)));
    expect(byteSort(ui)).toEqual(["README.md", "new/a.ts", "new/b.ts", "src/alpha.ts", "src/zeta.ts"]);
    const gov = createMemoryGovernance();
    const d = { cwd: "/w", branch: "braavo/x", title: "t", body: "" };
    const r = await gov.request("git.commit", { ...d, files: byteSort(ui) });
    const { token } = await gov.approve(r.actionId);
    expect(await gov.consume(token, "git.commit", { ...d, files: byteSort([...hostRaw.map(x => x.path)].reverse()) })).toBe(true);
  });
  it("sorts by UTF-8 bytes, not UTF-16 units", () => {
    // U+FF5E (BMP, UTF-8 EF BD 9E) vs U+1F600 (astral, UTF-8 F0 9F 98 80): bytes put the astral one last; UTF-16 units would not
    expect(byteSort(["\u{1F600}.ts", "\uFF5E.ts", "a.ts", "a.ts"])).toEqual(["a.ts", "\uFF5E.ts", "\u{1F600}.ts"]);
    expect(["\u{1F600}.ts", "\uFF5E.ts"].sort()[0]).toBe("\u{1F600}.ts");
  });
  it("runs a real multi-file commit end to end with the host's list in a different order", async () => {
    const h = host(undefined, hostRaw);
    const r = await run(createMemoryGovernance(), h.invoke, { files: toChangeViews(hostRaw).map(v => v.path) });
    expect(r.ok).toBe(true);
    expect(h.calls.map(c => c.cmd)).toEqual(["git_publish_commit", "git_publish_push", "github_open_pr"]);
  });
  it("stops with an explicit changesChanged (not unknown) when the list changed after confirmation, before any approval", async () => {
    const h = host(undefined, [...hostRaw, { path: "extra.ts", status: "??" }]);
    const r = await run(createMemoryGovernance(), h.invoke, { files: hostRaw.map(x => x.path) });
    expect(r).toEqual({ ok: false, step: "commit", code: "changesChanged" });
    expect(h.calls).toEqual([]);
    expect(errorCode(new Error("publish:changesChanged"))).toBe("changesChanged");
  });
});

describe("secrets and errors (criteria 4, 5, 6)", () => {
  it("maps only publish:<code> to a code and drops any other text, so no token can appear in an error", () => {
    expect(errorCode(new Error("publish:network"))).toBe("network");
    for (const hostile of [`fatal: could not read from ${PAT}`, `Authorization: Bearer ghp_${"a".repeat(36)}`, "publish:../../x", "publish:network extra", undefined, 5]) {
      const c = errorCode(hostile);
      expect(c).toBe("unknown");
      expect(c).not.toMatch(/ghp_|github_pat_|Authorization/);
    }
  });
  it("renders a message for every code with no token wording, in all fourteen languages", () => {
    const codes = ["pushRejected", "network", "noWriteAccess", "unauthorized", "notFound", "rateLimit", "conflict", "branchExists", "identity", "commitFailed", "wrongBranch", "nothingToPublish", "tooMany", "cancelled", "keychain", "invalid", "unknown", "unsafeConfig", "changesChanged", "gitAuth", "noPat"];
    for (const l of LOCALES) for (const c of codes) {
      const m = MESSAGES[l][`publish.err.${c}`];
      expect(m, `${l}:${c}`).toBeTruthy();
      expect(m).not.toMatch(/ghp_|github_pat_|Authorization|Bearer/);
    }
  });
  it("push sign-in failures say the Git identity is the fix and that the PR key does not solve it; the key prompt is for the PR step only", () => {
    expect(errorCode(new Error("publish:gitAuth"))).toBe("gitAuth");
    const view = read("../publish-view.ts");
    expect(view).toContain('"publish.err.gitAuth"');
    expect(view).toContain('"publish.err.noPat"');
    expect(view).toMatch(/KEY_CODES\.has\(code\) && \(fail\?\.step \?\? step\) === "pr"/);
    expect(view).not.toContain("github_pat_status"); // no key is asked for before the push
    for (const l of LOCALES) expect(MESSAGES[l]["publish.err.gitAuth"].length, l).toBeGreaterThan(40);
  });
  it("never logs, stores or fetches: no console, storage, fetch, XHR or WebSocket in the publish modules", () => {
    for (const f of ["../publish.ts", "../publish-view.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/console\.|setItem|sessionStorage|\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/);
      if (f.endsWith("view.ts")) expect(src).not.toMatch(/localStorage/);
    }
  });
  it("sends the key to the host once, clears the field, and never reads it back", () => {
    const view = read("../publish-view.ts");
    expect(view).toContain('"github_pat_set", { pat: value }');
    expect(view).toContain('input.value = ""');
    expect(view).not.toMatch(/github_pat_get|key_get|pat_read/);
    expect(view).toContain('input.type = "password"');
  });
  it("renders every name, title, path and message through textContent, never as markup", () => {
    for (const f of ["../publish-view.ts", "../publish.ts"]) expect(read(f), f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
  it("adds no network origin: the only external host named in the publish code is github", () => {
    const hosts = new Set<string>();
    for (const f of ["../publish.ts", "../publish-view.ts"]) for (const m of read(f).matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1]);
    expect([...hosts].filter(h => !/^github\.com$/.test(h))).toEqual([]);
    const csp = JSON.parse(read("../../src-tauri/tauri.conf.json")).app.security.csp as string;
    expect(csp).toContain("connect-src 'self' https:");
  });
});

describe("i18n (criterion 7)", () => {
  const keys = Object.keys(MESSAGES.en).filter(k => k.startsWith("publish."));
  const src = ["../publish-view.ts", "../publish.ts", "../ui.ts"].map(read).join("\n");
  it("has every publish.* key in all fourteen languages with the same placeholders", () => {
    expect(keys.length).toBeGreaterThanOrEqual(60);
    for (const l of LOCALES) for (const k of keys) {
      expect(MESSAGES[l][k]?.trim(), `${l}:${k}`).toBeTruthy();
      expect([...MESSAGES[l][k].matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort(), `${l}:${k}`).toEqual([...MESSAGES.en[k].matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort());
    }
  });
  it("has no unused key and no used key that is missing", () => {
    const used = new Set([...src.matchAll(/["'`](publish\.[\w.]+)["'`]/g)].map(m => m[1]));
    expect(keys.filter(k => !used.has(k))).toEqual([]);
    expect([...used].filter(k => !keys.includes(k))).toEqual([]);
  });
  it("the other languages are real translations, not the English text", () => {
    const short = new Set(["publish.repo", "publish.branchRow", "publish.filesRow", "publish.branch", "publish.errLabel"]);
    for (const l of LOCALES.filter(x => x !== "en")) {
      const same = keys.filter(k => MESSAGES[l][k] === MESSAGES.en[k] && !short.has(k));
      expect(same, l).toEqual([]);
    }
  });
  it("never uses the old 'commit and open PR' wording on any surface or in any language", () => {
    const old = /Commit ve PR aç|Commit and open (a )?PR|Commit & open PR|Confirmar y abrir PR/i;
    for (const l of LOCALES) for (const [k, v] of Object.entries(MESSAGES[l])) expect(v, `${l}:${k}`).not.toMatch(old);
    for (const f of ["../publish-view.ts", "../publish.ts", "../ui.ts"]) expect(read(f), f).not.toMatch(old);
  });
  it("keeps the chat free of diffs, file lists and step dumps: the publish UI lives in the changes panel only", () => {
    const view = read("../publish-view.ts");
    expect(view).not.toMatch(/chat|transcript|appendMessage/i);
    expect(read("../ui.ts").slice(read("../ui.ts").indexOf("if (isPublishEnabled())"), read("../ui.ts").indexOf("const renderChanges"))).toContain("changesSec.append");
  });
});
