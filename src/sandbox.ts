/**
 * OS-sandbox — the layer governance.ts's own header flags as a roadmap/human-gate:
 * "Full OS-level sandbox isolation … is a documented roadmap/human-gate; this
 * layer is 'governed + choke-point', NOT a claim of OS sandboxing." This module
 * closes that gap for spawned processes (command.run / pty.spawn): the Rust host
 * wraps the child in an OS sandbox built from a least-privilege POLICY, so even a
 * human-APPROVED command can't write outside its declared project roots, read the
 * user's secrets, or reach the network unless the policy explicitly grants it.
 * Governance answers "may this run?"; the sandbox bounds "what can it touch if it
 * does" — defense in depth, not a replacement for the approval gate.
 *
 * PURE, unit-tested core (the Rust host MIRRORS this policy — governance.ts:13 —
 * so a hole here would be replicated in Rust; the source of truth must be safe):
 *   1. SandboxPolicy — the capability model (read roots, write roots, network).
 *   2. defaultSandboxPolicy(cwd) — least privilege: a TRIMMED system read set +
 *      cwd; write = cwd ONLY; network OFF. NOT /private, /var, /tmp (per-user
 *      caches hold tokens), NOT $HOME.
 *   3. validateSandboxPolicy() — a WRITE grant is a whole subtree, so an
 *      exact-match denylist is the wrong model (grant the parent, the secret
 *      comes along). Write roots must pass isSafeWriteRoot (no system tree, no
 *      home/all-homes root, canonicalized so /private/etc and //etc are caught,
 *      deep enough to be a real project dir); read roots must not name a secrets
 *      dir; no write root may be an ancestor of a read root.
 *   4. toSeatbeltProfile() / toBubblewrapArgs() — VALIDATE first (throw on an
 *      unsafe policy — a generator must never emit an unsafe profile), then emit.
 *      SBPL paths are escaped (a `"`/`)` can't break out); bwrap is argv (no
 *      shell) and adds --unshare-pid/--unshare-ipc (no sibling proc-environ
 *      snoop) + --clearenv (the child does NOT inherit the host's secret env).
 *   5. describeSandbox() — honest summary: write scope + network + any NON-system
 *      read root spelled out (hiding reads behind a count conceals the exfil
 *      source a reviewer must see).
 *
 * Delegated to the Rust host (documented, LOAD-BEARING): the host MUST realpath-
 * resolve every root — symlinks AND mount aliases (/Volumes/*, firmlinks) — BEFORE
 * it validates/generates, since these string checks cannot see through a symlinked
 * write root to its target (on Linux bwrap binds the resolved target rw). Plus
 * final NUL rejection. Windows: no generator yet — host fails closed.
 */
import {
  isAbsolutePath,
  isTraversal,
  isSensitiveDir,
  canonicalizePath,
} from "./governance";

export interface SandboxPolicy {
  /** Absolute dirs the child may READ (subpaths included). */
  readRoots: string[];
  /** Absolute dirs the child may WRITE (subpaths). Least privilege = cwd only. */
  writeRoots: string[];
  /** Outbound network. Default DENY — a sandboxed build/agent step shouldn't exfil. */
  allowNetwork: boolean;
}

/**
 * Read-only system roots a typical CLI needs (shared libs, interpreters, TLS
 * roots, /dev/null+urandom). Trimmed vs the naive set: NO /private, /var, /tmp
 * (macOS /private/var/folders/<user> holds session tokens/cookies; /tmp is other
 * processes' scratch), NO $HOME. A policy needing a specific extra read adds it
 * explicitly — and validateSandboxPolicy still forbids naming a secrets dir.
 */
export const SYSTEM_READ_ROOTS: readonly string[] = [
  "/usr", "/bin", "/sbin", "/lib", "/opt", "/etc", "/dev",
  "/System", "/Library", // macOS frameworks / dyld
];

/** The governed least-privilege default for a process spawned in `cwd`. */
export function defaultSandboxPolicy(cwd: string): SandboxPolicy {
  return {
    readRoots: [...SYSTEM_READ_ROOTS, cwd],
    writeRoots: [cwd],
    allowNetwork: false,
  };
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/** Control char (NUL, newline, U+2028/2029) — never a real path, exactly what a
 * profile-injection attempt smuggles. Rejected at the validation boundary. */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

// Top path segments that are NEVER a legitimate WRITE target at any depth
// (writing anywhere under them = system tamper: PATH shadowing, LaunchAgents
// persistence, etc.). Compared against the canonical, lowercased first segment.
const SYSTEM_WRITE_TREES: ReadonlySet<string> = new Set([
  "usr", "bin", "sbin", "lib", "opt", "etc", "dev", "proc", "sys",
  "system", "library", "boot", "root", "var", "windows",
]);
// Home CONTAINERS: "/Users", "/home" (all users) and a bare "/Users/<name>"
// (a whole home dir) are too broad to grant write to — the secret dirs live
// directly inside. A real project is a subdir BELOW the home.
const HOME_CONTAINERS: ReadonlySet<string> = new Set(["users", "home"]);

/** A WRITE grant is safe only if it's a real project/scratch subtree, not a
 * system tree, a home root, or a bare top-level dir. Canonicalizes first so
 * /private/etc, //etc, and trailing-slash spellings can't slip past. */
export function isSafeWriteRoot(root: string): boolean {
  if (!isAbsolutePath(root) || isTraversal(root) || hasControlChars(root)) return false;
  const canon = canonicalizePath(root);
  const lc = canon.toLowerCase();
  if (isSensitiveDir(canon)) return false; // /, /etc (+ /private/etc via canon), secrets
  const segs = lc.split("/").filter(Boolean);
  // Drop a leading Windows drive letter ("c:") so the depth/home/system-tree
  // heuristics see the REAL segments — else "C:\Users\me" reads as depth-3 and
  // the whole-home guard below misses it (the same bug-class as the POSIX P1).
  if (segs.length > 0 && /^[a-z]:$/.test(segs[0])) segs.shift();
  if (segs.length <= 1) return false; // "/", "/Users", "/opt", "C:\", "C:\Users" — too broad
  if (SYSTEM_WRITE_TREES.has(segs[0])) return false; // /usr/local/bin, /Library/LaunchAgents…
  if (segs.length === 2 && HOME_CONTAINERS.has(segs[0])) return false; // whole home "/Users/me"
  return true;
}

/** A read root that is a whole home or all-homes container ("/Users", "/home",
 * "/Users/<name>") exposes every dotfile-secret (.netrc, .git-credentials, browser
 * profiles) — too broad to grant read to. System roots (/usr…) are depth-1 but
 * legitimate, so this is home-specific, not a general depth rule. */
function isBroadHomeReadRoot(root: string): boolean {
  const segs = canonicalizePath(root).toLowerCase().split("/").filter(Boolean);
  if (segs.length > 0 && /^[a-z]:$/.test(segs[0])) segs.shift();
  return segs.length > 0 && segs.length <= 2 && HOME_CONTAINERS.has(segs[0]);
}

/** True when `anc` is a STRICT ancestor of `desc` (canonical, case-folded — a
 * case-insensitive FS treats /Users/me/Proj and /users/me/proj as one tree). */
function isStrictAncestor(anc: string, desc: string): boolean {
  const a = canonicalizePath(anc).toLowerCase();
  const d = canonicalizePath(desc).toLowerCase();
  return a !== d && (d + "/").startsWith(a + "/");
}

/** Secret stores a READ root must not name — a SUPERSET of governance's write/pty
 * secret set (a read grant + the always-writable cwd is an exfil path even with
 * network off). Covers key stores, cloud/CI creds, browser profiles, keychains. */
const SECRET_READ_SEGMENT =
  /\/(\.(ssh|aws|gnupg|gpg|kube|docker|config|netrc|git-credentials|npmrc|password-store)|library\/keychains|library\/application support\/[^/]*\/(cookies|login data))(\/|$)/i;

/**
 * A policy the host will ENFORCE must itself be safe. Write roots go through the
 * allowlist-shaped isSafeWriteRoot (a denylist is bypassable by granting a
 * parent). Read roots must be absolute, clean, and not name a secrets dir. No
 * write root may be a strict ancestor of a read root (else the rw bind silently
 * upgrades the ro child).
 */
export function validateSandboxPolicy(p: SandboxPolicy): ValidationResult {
  for (const w of p.writeRoots) {
    if (!isSafeWriteRoot(w)) {
      return { ok: false, reason: `unsafe write root (system/home/too-broad/dirty): ${w}` };
    }
  }
  for (const r of p.readRoots) {
    if (!isAbsolutePath(r) || isTraversal(r) || hasControlChars(r)) {
      return { ok: false, reason: `read root not absolute/clean: ${r}` };
    }
    if (SECRET_READ_SEGMENT.test(canonicalizePath(r))) {
      return { ok: false, reason: `read root names a secrets dir: ${r}` };
    }
    if (isBroadHomeReadRoot(r)) {
      return { ok: false, reason: `read root is a whole home / all-homes dir: ${r}` };
    }
  }
  for (const w of p.writeRoots) {
    for (const r of p.readRoots) {
      if (isStrictAncestor(w, r)) {
        return { ok: false, reason: `write root ${w} is an ancestor of read root ${r}` };
      }
    }
  }
  return { ok: true };
}

function assertValid(p: SandboxPolicy): void {
  const v = validateSandboxPolicy(p);
  if (!v.ok) throw new Error(`refusing to build sandbox profile: ${v.reason}`);
}

// ── macOS: sandbox-exec SBPL profile ─────────────────────────────────────────

/**
 * Escape a path for an SBPL double-quoted string literal. Backslash first (so we
 * don't double-escape), then the quote. In SBPL/TinyScheme a string literal is
 * terminated ONLY by an unescaped `"`, so `{\, "}` is the complete set; a `)`,
 * `;`, or newline inside stays inert. (Control chars are already rejected in
 * validation before generation.)
 */
export function sbplQuote(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function toSeatbeltProfile(p: SandboxPolicy): string {
  assertValid(p);
  const read = p.readRoots.map(canonicalizePath);
  const write = p.writeRoots.map(canonicalizePath);
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow process-exec)",
    "(allow sysctl-read)",
    "(allow signal (target self))",
  ];
  if (read.length > 0) {
    lines.push(`(allow file-read* ${read.map((r) => `(subpath ${sbplQuote(r)})`).join(" ")})`);
  }
  if (write.length > 0) {
    lines.push(`(allow file-write* ${write.map((w) => `(subpath ${sbplQuote(w)})`).join(" ")})`);
  }
  // Network + socket creation are covered by (deny default); only opened on grant.
  if (p.allowNetwork) {
    lines.push("(allow network*)");
    lines.push("(allow system-socket)");
  }
  return lines.join("\n") + "\n";
}

// ── Linux: bubblewrap argv ───────────────────────────────────────────────────

/** A minimal, secret-free env the child gets after --clearenv (the host scrubs
 * its own secret-bearing env). HOME points at the first write root (the project
 * dir), never the real $HOME. */
function sandboxEnvArgs(p: SandboxPolicy): string[] {
  const home = p.writeRoots.length > 0 ? canonicalizePath(p.writeRoots[0]) : "/tmp";
  return [
    "--clearenv",
    "--setenv", "PATH", "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin",
    "--setenv", "HOME", home,
    "--setenv", "TERM", "xterm-256color",
  ];
}

/**
 * bwrap argv (array form → no shell, no injection). Isolation: --unshare-pid
 * (no host PID visibility → can't read a sibling's /proc/<pid>/environ or
 * /proc/<pid>/mem, same-UID), --unshare-ipc (no shm snoop), --unshare-net when
 * network is denied, --new-session (anti-TIOCSTI), --die-with-parent, minimal
 * --dev/--proc, and --clearenv so host secret env doesn't leak in. Read roots
 * are ro-bound FIRST, then write roots, so a rw project subdir correctly
 * overrides its ro parent (and validation already forbids a write root that is
 * an ancestor of a read root). Host appends `-- <cmd> <args>`.
 */
export function toBubblewrapArgs(p: SandboxPolicy): string[] {
  assertValid(p);
  const args: string[] = [
    "--die-with-parent", "--new-session",
    "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--cap-drop", "ALL", // child keeps no capabilities even if braavo runs elevated
    "--proc", "/proc", "--dev", "/dev",
    ...sandboxEnvArgs(p),
  ];
  for (const r of p.readRoots) {
    const c = canonicalizePath(r);
    args.push("--ro-bind-try", c, c);
  }
  for (const w of p.writeRoots) {
    const c = canonicalizePath(w);
    args.push("--bind-try", c, c);
  }
  if (!p.allowNetwork) args.push("--unshare-net");
  return args;
}

// ── honest summary ───────────────────────────────────────────────────────────

/** One-line human summary for the approval modal. Spells out write roots + any
 * read root OUTSIDE the standard system set (the exfil source a reviewer needs
 * to see), + network state. No secrets. */
export function describeSandbox(p: SandboxPolicy): string {
  const write = p.writeRoots.length ? p.writeRoots.join(", ") : "(nothing)";
  const sys = new Set<string>(SYSTEM_READ_ROOTS.map((r) => canonicalizePath(r).toLowerCase()));
  const extraReads = p.readRoots.filter((r) => !sys.has(canonicalizePath(r).toLowerCase()));
  const reads = extraReads.length ? `system + ${extraReads.join(", ")}` : "system only";
  return `sandbox: write→${write}, read ${reads}, network ${p.allowNetwork ? "ON" : "OFF"}`;
}

/**
 * Windows has no generator yet — AppContainer / Job Object wrapping is a
 * documented follow-up. Exposed so the host can fail-closed (refuse to spawn
 * unsandboxed) on Windows rather than silently running without isolation.
 */
export const SANDBOX_UNSUPPORTED_WINDOWS =
  "OS sandbox not yet implemented on Windows (AppContainer pending) — host must fail-closed";
