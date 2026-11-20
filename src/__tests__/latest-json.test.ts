import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOWNLOAD_PREFIX, UPDATER_PLATFORMS, validateLatestJson } from "../latest-json";

const SIG = btoa("untrusted comment: signature from tauri secret key\nRUQ-test-signature-body-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
const good = () => ({
  version: "1.2.0",
  notes: "x",
  pub_date: "2026-11-20T10:00:00Z",
  platforms: Object.fromEntries(UPDATER_PLATFORMS.map((k) => [k, { url: `${DOWNLOAD_PREFIX}v1.2.0/Braavolabs-${k}.bin`, signature: SIG }])),
});

describe("latest.json check", () => {
  it("accepts a complete file", () => expect(validateLatestJson(good())).toEqual({ ok: true, errors: [] }));
  it("rejects a missing platform entry", () => {
    const j = good(); delete (j.platforms as Record<string, unknown>)["windows-x86_64"];
    const r = validateLatestJson(j);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("windows-x86_64: entry missing");
  });
  it("rejects missing or placeholder signatures", () => {
    const j = good(); (j.platforms["linux-x86_64"] as { signature?: string }).signature = "";
    expect(validateLatestJson(j).errors.join()).toContain("linux-x86_64: signature missing");
    (j.platforms["linux-x86_64"] as { signature?: string }).signature = "PASTE_SIGNATURE_HERE";
    expect(validateLatestJson(j).ok).toBe(false);
  });
  it("rejects a link outside the project's downloads, or under another version", () => {
    const a = good(); (a.platforms["darwin-aarch64"] as { url: string }).url = "https://evil.example/x.tar.gz";
    expect(validateLatestJson(a).ok).toBe(false);
    const b = good(); (b.platforms["darwin-aarch64"] as { url: string }).url = `${DOWNLOAD_PREFIX}v1.1.0/x.tar.gz`;
    expect(validateLatestJson(b).errors.join()).toContain("not under v1.2.0");
    const c = good(); (c.platforms["darwin-aarch64"] as { url: string }).url = "http://github.com/kocakkmustafa/braavolabs-desktop/releases/download/v1.2.0/x";
    expect(validateLatestJson(c).ok).toBe(false);
  });
  it("rejects bad version, bad shape and unknown platform keys", () => {
    expect(validateLatestJson({ ...good(), version: "latest" }).ok).toBe(false);
    expect(validateLatestJson(null).ok).toBe(false);
    expect(validateLatestJson({ version: "1.2.0" }).ok).toBe(false);
    const j = good(); (j.platforms as Record<string, unknown>)["darwin-universal"] = { url: "x", signature: SIG };
    expect(validateLatestJson(j).errors.join()).toContain("unexpected platform key");
  });
  it("CLI exits 0 for a good file and 1 for a bad one", () => {
    const dir = mkdtempSync(join(tmpdir(), "latest-"));
    const ok = join(dir, "ok.json"), bad = join(dir, "bad.json");
    writeFileSync(ok, JSON.stringify(good()));
    const j = good(); delete (j.platforms as Record<string, unknown>)["darwin-x86_64"];
    writeFileSync(bad, JSON.stringify(j));
    const run = (f: string) => { try { execFileSync(process.execPath, ["scripts/verify-latest-json.mjs", f], { stdio: "pipe" }); return 0; } catch (e) { return (e as { status: number }).status; } };
    expect(run(ok)).toBe(0);
    expect(run(bad)).toBe(1);
  });
});
