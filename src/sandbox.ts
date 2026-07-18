/**
 * OS-sandbox — the layer governance.ts's own header flags as a roadmap/human-gate:
 * "Full OS-level sandbox isolation … is a documented roadmap/human-gate; this
 * layer is 'governed + choke-point', NOT a claim of OS sandboxing." This module
 * closes that honesty gap for spawned processes (command.run / pty.spawn): the
 * Rust host wraps the child in an OS sandbox built from a least-privilege POLICY,
 * so even a human-APPROVED command can't read outside its declared roots, write
 * outside its cwd, or reach the network unless the policy explicitly grants it.
 * Governance answers "may this run?"; the sandbox bounds "what can it touch if it
 * does" — defense in depth, not a replacement for the approval gate.
 *
 * This module is the PURE, unit-tested core:
 *   1. SandboxPolicy — the capability model (read roots, write roots, network).
 *   2. defaultSandboxPolicy(cwd) — the governed least-privilege default
 *      (system read-only + cwd; write = cwd ONLY; network OFF).
 *   3. validateSandboxPolicy() — write roots must be absolute, non-traversal,
 *      non-sensitive (reuses the governance helpers, so the sandbox can't be
 *      told to grant write to ~/.ssh); read roots absolute + non-traversal.
 *   4. toSeatbeltProfile() (macOS SBPL / sandbox-exec) and toBubblewrapArgs()
 *      (Linux bwrap argv) — what the Rust host applies. SBPL is a STRING, so
 *      every path is escaped: a path containing `"` or `)` must NOT be able to
 *      break out of the profile and neuter it (profile injection). bwrap is
 *      argv (array), injection-free by construction.
 *   5. describeSandbox() — the honest one-line summary shown at approval.
 *
 * The actual wrapping (sandbox-exec on macOS, bwrap on Linux, AppContainer on
 * Windows) is the Rust host's job at spawn time — a HUMAN-GATE runtime, injected
 * and documented, not claimed here. Windows has no generator yet (documented gap
 * below); a policy still validates, so the host can fail-closed there.
 */
import { isAbsolutePath, isTraversal, isSensitiveDir } from "./governance";

export interface SandboxPolicy {
  /** Absolute dirs the child may READ (subpaths included). */
  readRoots: string[];
  /** Absolute dirs the child may WRITE (subpaths). Least privilege = cwd only. */
  writeRoots: string[];
  /** Outbound network. Default DENY — a sandboxed build/agent step shouldn't exfil. */
  allowNetwork: boolean;
}

/**
 * Read-only system roots a typical CLI needs to function (shared libs, certs,
 * interpreters, /dev/null + /dev/urandom, tmp for scratch reads). Deliberately
 * NOT $HOME — a build step reading the whole home dir defeats the point; a
 * policy that needs a specific home subpath adds it explicitly (human-approved).
 */
export const SYSTEM_READ_ROOTS: readonly string[] = [
  "/usr", "/bin", "/sbin", "/lib", "/opt", "/etc", "/dev", "/tmp", "/private", "/var",
  "/System", "/Library", // macOS
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

/**
 * A control char (NUL, newline, U+2028/2029 line separators) in a path is never
 * legitimate and is exactly what a profile-injection attempt smuggles: even with
 * `"` escaped, an embedded newline could let the tail of a path start a new
 * top-level SBPL directive, and a NUL truncates in the C host. Reject at the
 * validation boundary so neither the SBPL nor the bwrap generator ever sees one.
 */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/**
 * A policy the host will ENFORCE must itself be safe: a write root that is
 * relative, escapes via `..`, holds a control char, or lands in a system/secrets
 * dir would let an approved command scribble where it must not. Read roots must
 * be absolute + non-traversal + control-char-free (system reads are fine; `..`,
 * a NUL, or a newline are not).
 */
export function validateSandboxPolicy(p: SandboxPolicy): ValidationResult {
  for (const w of p.writeRoots) {
    if (!isAbsolutePath(w) || isTraversal(w) || hasControlChars(w)) {
      return { ok: false, reason: `write root not absolute/clean: ${w}` };
    }
    if (isSensitiveDir(w)) {
      return { ok: false, reason: `write root in a system/secrets dir: ${w}` };
    }
  }
  for (const r of p.readRoots) {
    if (!isAbsolutePath(r) || isTraversal(r) || hasControlChars(r)) {
      return { ok: false, reason: `read root not absolute/clean: ${r}` };
    }
  }
  return { ok: true };
}

// ── macOS: sandbox-exec SBPL profile ─────────────────────────────────────────

/**
 * Escape a path for an SBPL double-quoted string literal. Backslash first (so we
 * don't double-escape the escapes we add), then the quote. Without this, a path
 * like `/x")(allow default)(deny "` would close the (subpath "…") form and inject
 * profile directives that neuter the sandbox.
 */
export function sbplQuote(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function toSeatbeltProfile(p: SandboxPolicy): string {
  const lines = [
    "(version 1)",
    "(deny default)",
    // A child must be able to fork/exec itself and read basic process info; the
    // file-read allowlist below is what actually bounds which binaries it can run.
    "(allow process-fork)",
    "(allow process-exec)",
    "(allow sysctl-read)",
    "(allow signal (target self))",
  ];
  if (p.readRoots.length > 0) {
    lines.push(`(allow file-read* ${p.readRoots.map((r) => `(subpath ${sbplQuote(r)})`).join(" ")})`);
  }
  if (p.writeRoots.length > 0) {
    lines.push(`(allow file-write* ${p.writeRoots.map((w) => `(subpath ${sbplQuote(w)})`).join(" ")})`);
  }
  // Network is DENY-by-default (deny default covers it); only opened when granted.
  if (p.allowNetwork) {
    lines.push("(allow network*)");
  }
  return lines.join("\n") + "\n";
}

// ── Linux: bubblewrap argv ───────────────────────────────────────────────────

/**
 * bwrap argv (array form → no shell, no injection). `--ro-bind-try` / `--bind-try`
 * tolerate a missing root instead of aborting. `--unshare-net` is the network
 * deny. The host appends `-- <cmd> <args>` after this prefix.
 */
export function toBubblewrapArgs(p: SandboxPolicy): string[] {
  const args: string[] = ["--die-with-parent", "--new-session", "--proc", "/proc", "--dev", "/dev"];
  for (const r of p.readRoots) args.push("--ro-bind-try", r, r);
  for (const w of p.writeRoots) args.push("--bind-try", w, w);
  if (!p.allowNetwork) args.push("--unshare-net");
  return args;
}

// ── honest summary ───────────────────────────────────────────────────────────

/** One-line human summary for the approval modal + (safe to) audit. No secrets. */
export function describeSandbox(p: SandboxPolicy): string {
  const write = p.writeRoots.length ? p.writeRoots.join(", ") : "(nothing)";
  return `sandbox: write→${write}, network ${p.allowNetwork ? "ON" : "OFF"}, read ${p.readRoots.length} roots`;
}

/**
 * Windows has no generator yet — AppContainer / Job Object wrapping is a
 * documented follow-up. Exposed so the host can fail-closed (refuse to spawn
 * unsandboxed) on Windows rather than silently running without isolation.
 */
export const SANDBOX_UNSUPPORTED_WINDOWS =
  "OS sandbox not yet implemented on Windows (AppContainer pending) — host must fail-closed";
