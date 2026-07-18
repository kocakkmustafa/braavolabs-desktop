import { describe, it, expect } from "vitest";
import {
  defaultSandboxPolicy,
  validateSandboxPolicy,
  isSafeWriteRoot,
  toSeatbeltProfile,
  toBubblewrapArgs,
  sbplQuote,
  describeSandbox,
  SYSTEM_READ_ROOTS,
  type SandboxPolicy,
} from "../sandbox";

const CWD = "/Users/me/project";
const policy = (over: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
  readRoots: ["/usr", CWD],
  writeRoots: [CWD],
  allowNetwork: false,
  ...over,
});

describe("defaultSandboxPolicy — least privilege", () => {
  it("reads TRIMMED system + cwd, writes ONLY cwd, network OFF", () => {
    const p = defaultSandboxPolicy(CWD);
    expect(p.writeRoots).toEqual([CWD]);
    expect(p.allowNetwork).toBe(false);
    expect(p.readRoots).toContain(CWD);
    expect(p.readRoots).toEqual(expect.arrayContaining([...SYSTEM_READ_ROOTS]));
    // Trimmed: NOT the token-bearing / scratch dirs, NOT the whole home.
    for (const leaky of ["/private", "/var", "/tmp", "/Users/me", "/Users"]) {
      expect(p.readRoots).not.toContain(leaky);
    }
    expect(validateSandboxPolicy(p)).toEqual({ ok: true });
  });
});

describe("isSafeWriteRoot — allowlist-shaped (adversarial B)", () => {
  it("accepts a real project / scratch subtree", () => {
    for (const ok of ["/Users/me/project", "/home/x/proj", "/tmp/scratch/build", "/Users/me/a/b"]) {
      expect(isSafeWriteRoot(ok), ok).toBe(true);
    }
  });

  it("REJECTS a home root, all-homes root, or whole home dir (secret dirs live inside)", () => {
    for (const bad of ["/Users", "/home", "/Users/me", "/home/x"]) {
      expect(isSafeWriteRoot(bad), bad).toBe(false);
    }
  });

  it("REJECTS system trees at any depth (PATH shadowing / LaunchAgents persistence)", () => {
    for (const bad of ["/usr/local/bin", "/Library/LaunchAgents", "/etc/cron.d", "/opt", "/var/root"]) {
      expect(isSafeWriteRoot(bad), bad).toBe(false);
    }
  });

  it("REJECTS the macOS /private alias of /etc and a // normalization bypass", () => {
    expect(isSafeWriteRoot("/private/etc"), "/private/etc == /etc").toBe(false);
    expect(isSafeWriteRoot("//etc"), "//etc").toBe(false);
    expect(isSafeWriteRoot("/private/var"), "/private/var").toBe(false);
  });

  it("REJECTS shallow / relative / traversal / control-char roots", () => {
    for (const bad of ["/", "/opt", "rel/dir", "/a/../b"]) {
      expect(isSafeWriteRoot(bad), bad).toBe(false);
    }
    expect(isSafeWriteRoot("/Users/me/pr\x00oj")).toBe(false);
  });
});

describe("validateSandboxPolicy", () => {
  it("accepts a clean project policy", () => {
    expect(validateSandboxPolicy(policy())).toEqual({ ok: true });
  });

  it("rejects an unsafe write root with an honest reason", () => {
    expect(validateSandboxPolicy(policy({ writeRoots: ["/Users/me"] }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("unsafe write root"),
    });
  });

  it("rejects a read root that names a secrets dir (adversarial C — read is the exfil source)", () => {
    expect(validateSandboxPolicy(policy({ readRoots: ["/Users/me/.ssh"] }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("secrets dir"),
    });
    expect(validateSandboxPolicy(policy({ readRoots: ["/home/x/.aws"] }))).toMatchObject({ ok: false });
  });

  it("rejects a non-absolute / traversal / control-char read root", () => {
    expect(validateSandboxPolicy(policy({ readRoots: ["usr"] }))).toMatchObject({ ok: false });
    expect(validateSandboxPolicy(policy({ readRoots: ["/a/../etc"] }))).toMatchObject({ ok: false });
    expect(validateSandboxPolicy(policy({ readRoots: ["/u\n(x)"] }))).toMatchObject({ ok: false });
  });

  it("rejects a write root that is a strict ANCESTOR of a read root (rw would shadow ro)", () => {
    expect(
      validateSandboxPolicy({ writeRoots: ["/Users/me/proj"], readRoots: ["/Users/me/proj/vendor"], allowNetwork: false }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("ancestor") });
    // Equal write+read root (the default cwd case) is fine — not a STRICT ancestor.
    expect(validateSandboxPolicy(policy())).toEqual({ ok: true });
  });
});

describe("toSeatbeltProfile (macOS SBPL)", () => {
  it("validates first, denies by default, allows read+write subpaths, OMITS network when off", () => {
    const prof = toSeatbeltProfile(policy());
    expect(prof).toContain("(deny default)");
    expect(prof).toContain(`(allow file-read* (subpath "/usr") (subpath "${CWD}"))`);
    expect(prof).toContain(`(allow file-write* (subpath "${CWD}"))`);
    expect(prof).not.toContain("(allow network*)");
    expect(prof).not.toContain("(allow system-socket)");
  });

  it("grants network + socket ONLY when allowed", () => {
    const prof = toSeatbeltProfile(policy({ allowNetwork: true }));
    expect(prof).toContain("(allow network*)");
    expect(prof).toContain("(allow system-socket)");
  });

  it("THROWS rather than emit a profile for an unsafe policy (adversarial G)", () => {
    expect(() => toSeatbeltProfile(policy({ writeRoots: ["/etc"] }))).toThrow(/refusing to build/);
    expect(() => toSeatbeltProfile(policy({ writeRoots: ["/Users/me"] }))).toThrow();
  });

  it("ESCAPES a path so it cannot inject SBPL and neuter the sandbox (injection guard)", () => {
    // A validly-shaped project dir whose NAME contains quotes/parens.
    const evil = '/Users/me/pr")(allow default)("';
    const prof = toSeatbeltProfile(policy({ writeRoots: [evil], readRoots: ["/usr"] }));
    expect(prof).toContain('\\"'); // embedded quote escaped
    expect(prof).not.toMatch(/\n\(allow default\)/); // did NOT become a top-level directive
    expect(sbplQuote('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});

describe("toBubblewrapArgs (Linux)", () => {
  it("unshares pid+ipc+net, clears env, ro-binds reads + binds writes", () => {
    const args = toBubblewrapArgs(policy());
    expect(args).toContain("--unshare-pid"); // no sibling /proc/<pid>/environ snoop (adversarial D)
    expect(args).toContain("--unshare-ipc");
    expect(args).toContain("--unshare-net"); // network denied
    expect(args).toContain("--clearenv"); // host secret env does NOT leak in (adversarial D3)
    expect(args).toEqual(expect.arrayContaining(["--setenv", "HOME", CWD])); // HOME=project, not real $HOME
    expect(args).toEqual(expect.arrayContaining(["--ro-bind-try", "/usr", "/usr"]));
    expect(args).toEqual(expect.arrayContaining(["--bind-try", CWD, CWD]));
  });

  it("does NOT unshare-net when network is allowed", () => {
    expect(toBubblewrapArgs(policy({ allowNetwork: true }))).not.toContain("--unshare-net");
  });

  it("THROWS on an unsafe policy (adversarial G)", () => {
    expect(() => toBubblewrapArgs(policy({ writeRoots: ["/usr/local/bin"] }))).toThrow(/refusing to build/);
  });

  it("is argv (array) form — a malicious path stays ONE element, never shell-split", () => {
    const evil = "/Users/me/x; rm -rf ~";
    const args = toBubblewrapArgs(policy({ writeRoots: [evil], readRoots: [] }));
    // Appears verbatim as discrete argv elements (setenv HOME + the bind pair),
    // never word-split into `rm`,`-rf`,`~` as a shell would.
    expect(args.filter((a) => a === evil)).toHaveLength(3);
    expect(args).not.toContain("rm"); // never tokenized
  });
});

describe("describeSandbox — honest (adversarial F)", () => {
  it("spells out write roots + any NON-system read root + network state", () => {
    expect(describeSandbox(policy())).toBe(`sandbox: write→${CWD}, read system + ${CWD}, network OFF`);
    expect(describeSandbox({ readRoots: [...SYSTEM_READ_ROOTS], writeRoots: [CWD], allowNetwork: true }))
      .toBe(`sandbox: write→${CWD}, read system only, network ON`);
  });

  it("does NOT hide a non-system read root behind a count", () => {
    const d = describeSandbox({ readRoots: ["/usr", "/Users/me/secrets-cache"], writeRoots: [CWD], allowNetwork: false });
    expect(d).toContain("/Users/me/secrets-cache"); // the exfil source is visible to the approver
  });
});
