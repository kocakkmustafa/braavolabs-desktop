import { describe, it, expect } from "vitest";
import {
  defaultSandboxPolicy,
  validateSandboxPolicy,
  toSeatbeltProfile,
  toBubblewrapArgs,
  sbplQuote,
  describeSandbox,
  SYSTEM_READ_ROOTS,
  type SandboxPolicy,
} from "../sandbox";

const policy = (over: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
  readRoots: ["/usr", "/w"],
  writeRoots: ["/w"],
  allowNetwork: false,
  ...over,
});

describe("defaultSandboxPolicy — least privilege", () => {
  it("reads system + cwd, writes ONLY cwd, network OFF", () => {
    const p = defaultSandboxPolicy("/Users/me/project");
    expect(p.writeRoots).toEqual(["/Users/me/project"]); // write is cwd only
    expect(p.allowNetwork).toBe(false); // no exfil by default
    expect(p.readRoots).toContain("/Users/me/project");
    expect(p.readRoots).toEqual(expect.arrayContaining([...SYSTEM_READ_ROOTS]));
    expect(p.readRoots).not.toContain("/Users/me"); // NOT the whole home dir
  });
});

describe("validateSandboxPolicy", () => {
  it("accepts an absolute, clean, non-sensitive write root", () => {
    expect(validateSandboxPolicy(policy())).toEqual({ ok: true });
  });

  it("rejects a write root that is relative, traversal, or sensitive", () => {
    expect(validateSandboxPolicy(policy({ writeRoots: ["rel/dir"] }))).toMatchObject({ ok: false });
    expect(validateSandboxPolicy(policy({ writeRoots: ["/a/../b"] }))).toMatchObject({ ok: false });
    // The sandbox must never be told to grant WRITE to a secrets dir.
    expect(validateSandboxPolicy(policy({ writeRoots: ["/Users/me/.ssh"] }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("system/secrets"),
    });
    expect(validateSandboxPolicy(policy({ writeRoots: ["/etc"] }))).toMatchObject({ ok: false });
  });

  it("rejects a non-absolute or traversal read root", () => {
    expect(validateSandboxPolicy(policy({ readRoots: ["usr"] }))).toMatchObject({ ok: false });
    expect(validateSandboxPolicy(policy({ readRoots: ["/a/../etc"] }))).toMatchObject({ ok: false });
  });

  it("the default policy validates for an ordinary project dir", () => {
    expect(validateSandboxPolicy(defaultSandboxPolicy("/Users/me/project"))).toEqual({ ok: true });
  });
});

describe("toSeatbeltProfile (macOS SBPL)", () => {
  it("denies by default, allows read+write subpaths, and OMITS network when off", () => {
    const prof = toSeatbeltProfile(policy());
    expect(prof).toContain("(deny default)");
    expect(prof).toContain('(allow file-read* (subpath "/usr") (subpath "/w"))');
    expect(prof).toContain('(allow file-write* (subpath "/w"))');
    expect(prof).not.toContain("(allow network*)"); // network off → not granted
  });

  it("grants network ONLY when the policy allows it", () => {
    expect(toSeatbeltProfile(policy({ allowNetwork: true }))).toContain("(allow network*)");
  });

  it("ESCAPES a path so it cannot inject SBPL and neuter the sandbox (injection guard)", () => {
    // A crafted write root that, unescaped, would close the (subpath "…") form and
    // append `(allow default)` — defeating the whole profile.
    const evil = '/x")(allow default)(deny "';
    const prof = toSeatbeltProfile(policy({ writeRoots: [evil], readRoots: ["/usr"] }));
    // The dangerous quote is escaped; no BARE `(allow default)` directive appears.
    expect(prof).toContain('\\"'); // the embedded quote was escaped
    expect(prof).not.toMatch(/\n\(allow default\)/); // injection did NOT become a directive
    // sbplQuote is the unit: quotes + backslashes escaped, wrapped in quotes.
    expect(sbplQuote('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});

describe("toBubblewrapArgs (Linux)", () => {
  it("ro-binds read roots, binds write roots, unshares net when network off", () => {
    const args = toBubblewrapArgs(policy());
    expect(args).toEqual(expect.arrayContaining(["--ro-bind-try", "/usr", "/usr"]));
    expect(args).toEqual(expect.arrayContaining(["--bind-try", "/w", "/w"]));
    expect(args).toContain("--unshare-net"); // network denied
  });

  it("does NOT unshare-net when network is allowed", () => {
    expect(toBubblewrapArgs(policy({ allowNetwork: true }))).not.toContain("--unshare-net");
  });

  it("is argv (array) form — each path is a discrete element, so shell injection is impossible", () => {
    const evil = '/x; rm -rf ~';
    const args = toBubblewrapArgs(policy({ writeRoots: [evil], readRoots: [] }));
    // The whole malicious string survives verbatim as discrete argv elements (the
    // src+dest of `--bind-try src dest`), never word-split into `/x;`,`rm`,`-rf`,`~`
    // as a shell would. That it appears EXACTLY as-is (twice, the bind pair) proves
    // no shell interpretation — bwrap is exec'd with this argv, no /bin/sh.
    expect(args.filter((a) => a === evil)).toHaveLength(2);
    expect(args).not.toContain("rm"); // never split into separate tokens
  });
});

describe("describeSandbox", () => {
  it("is an honest one-liner: write scope + network state, no secrets", () => {
    expect(describeSandbox(policy())).toBe("sandbox: write→/w, network OFF, read 2 roots");
    expect(describeSandbox(policy({ allowNetwork: true }))).toContain("network ON");
  });
});
