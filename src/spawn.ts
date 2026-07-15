/**
 * Lane-B SAFE-SPAWN — desktop adapter. A port of the CLI's forge/spawn.ts
 * SAFETY CONTRACT into the Tauri webview context.
 *
 * Lane-B runs the user's OWN, already-authenticated vendor CLI (claude / codex)
 * — it is a thin, opaque passthrough, NOT a re-implementation of the vendor and
 * NOT an OAuth client. The rules (enforced by construction; documented in the
 * README "Lane-B safety contract"):
 *
 *   (a) NO vendor OAuth — the user must have logged in with the official binary
 *       beforehand. Lane-B never initiates or brokers a vendor sign-in.
 *   (b) Only the official binary (found on PATH, or at a NEUTRAL, tool-agnostic
 *       bin prefix) is a spawn target; the launch command is always an argv
 *       ARRAY (see buildLaunchCommand) — never a shell string, so there is no
 *       injection seam.
 *   (c) A vendor session's stdout/stderr is an OPAQUE STREAM: it is never
 *       captured, parsed, teed, or forwarded here — nothing to disk, telemetry,
 *       or any server. Token/identity are never extracted. (The desktop MVP does
 *       not even open the stream in-process — see the delivery note below.)
 *   (d) OAuth token/cookie files (~/.claude*, ~/.codex*, credentials, auth.json)
 *       are NEVER touched — not even read. Binary discovery deliberately looks
 *       ONLY at PATH and neutral bin dirs (knownPaths), never a vendor config dir.
 *   (f) Per-vendor ToS-risk level is surfaced in-product (VENDOR_SPECS.risk).
 *   (g) If the binary is absent, Lane-B degrades gracefully by pointing at the
 *       API-key path (VENDOR_SPECS.fallback → Lane-A Direct) — it never fakes a
 *       result.
 *
 * ── Delivery note (why detection + launch-command, not in-process PTY) ──
 * A webview cannot spawn a child process; only the Rust host can. A FULL
 * interactive PTY bridged into a webview (raw-mode stdio, terminal emulation,
 * resize/signal handling) is a large, security-sensitive surface. For this
 * desktop version Lane-B therefore does the two meaningful, safe things:
 *   1. DETECTS whether the user's official binary is installed (+ its version),
 *      via a thin Rust `spawn_probe` command whose discovery mirrors knownPaths
 *      (neutral paths only; never a token dir).
 *   2. SURFACES the exact launch command (an argv array) and delegates the real
 *      interactive session to the proven CLI (`forge spawn <vendor>`), which
 *      already implements the opaque stdio:"inherit" passthrough.
 * This keeps the Rust host thin (no AI/orchestration, no captured vendor output)
 * and reuses the adversarially-verified CLI spawn path. Discovery + probing +
 * message-building live here in pure, unit-tested TypeScript; the Rust host only
 * answers "installed? which path? what version?" and never streams a session.
 */

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Tauri v2 with `withGlobalTauri:true` exposes window.__TAURI__.core.invoke. */
function tauriInvoke(): Invoke | null {
  const g = globalThis as any;
  const inv = g?.__TAURI__?.core?.invoke;
  return typeof inv === "function" ? (inv as Invoke) : null;
}

export const SPAWN_VENDORS = ["claude", "codex"] as const;
export type SpawnVendor = (typeof SPAWN_VENDORS)[number];

export function isSpawnVendor(v: string): v is SpawnVendor {
  return (SPAWN_VENDORS as readonly string[]).includes(v);
}

export interface VendorSpec {
  /** Executable name as it appears on PATH. */
  bin: string;
  /** One-line ToS-risk note (rule f). Plain text — the UI paints it steel. */
  risk: string;
  /** Graceful API-key fallback suggestion → Lane-A Direct (rule g). */
  fallback: string;
  /** Args used only to read a version string for the probe. */
  versionArgs: string[];
}

export const VENDOR_SPECS: Record<SpawnVendor, VendorSpec> = {
  claude: {
    bin: "claude",
    risk: "ToS risk: SAFE — volatile (policy can shift; runs your own authenticated CLI)",
    fallback: 'forge direct anthropic "<question>"',
    versionArgs: ["--version"],
  },
  codex: {
    bin: "codex",
    risk: "ToS risk: SAFE — lowest risk (runs your own authenticated CLI)",
    fallback: 'forge direct openai "<question>"',
    versionArgs: ["--version"],
  },
};

/**
 * Neutral bin locations to probe when a vendor binary is not on PATH. This is
 * the CONTRACT the Rust `spawn_probe` command mirrors — it is the single,
 * unit-tested source of truth for "what counts as a neutral install prefix".
 *
 * These are deliberately NOT vendor config dirs — we never look inside
 * ~/.claude or ~/.codex (rule d). `.local/bin`, homebrew, `.bun/bin` and
 * `.cargo/bin` are neutral, tool-agnostic install prefixes.
 */
export function knownPaths(vendor: SpawnVendor, home: string): string[] {
  const bin = VENDOR_SPECS[vendor].bin;
  const paths = [
    `/opt/homebrew/bin/${bin}`,
    `/usr/local/bin/${bin}`,
    `${home}/.local/bin/${bin}`,
    `${home}/.bun/bin/${bin}`,
  ];
  if (vendor === "codex") paths.push(`${home}/.cargo/bin/${bin}`);
  return paths;
}

export interface VendorStatus {
  vendor: SpawnVendor;
  installed: boolean;
  /** Resolved neutral path if found — never a token/config path. */
  path?: string;
  /** Version string if the binary volunteered one; absence ≠ "not installed". */
  version?: string;
  risk: string;
}

/**
 * The launch plan for a vendor. Everything is an argv ARRAY — never a shell
 * string — so a malicious-looking argument (e.g. "hi; rm -rf /") stays an inert
 * single array element and can never break out into the shell (rule b).
 */
export interface LaunchPlan {
  /** Bare binary name (the direct target). */
  bin: string;
  /** Direct argv: [bin, ...args]. */
  argv: string[];
  /** The delegated, proven interactive path: `forge spawn <vendor> ...`. */
  cliDelegation: string[];
}

/** Build the launch plan as argv arrays (no shell interpolation anywhere). */
export function buildLaunchCommand(vendor: SpawnVendor, args: string[] = []): LaunchPlan {
  const bin = VENDOR_SPECS[vendor].bin;
  return {
    bin,
    argv: [bin, ...args],
    cliDelegation: ["forge", "spawn", vendor, ...args],
  };
}

/** Graceful-fallback copy (rule g): binary missing → point at Lane-A Direct. */
export interface SpawnFallback {
  /** e.g. "codex CLI not found". */
  notFound: string;
  /** The API-key command that bypasses the missing CLI (VENDOR_SPECS.fallback). */
  useApiKey: string;
}

export function spawnFallbackMessage(vendor: SpawnVendor): SpawnFallback {
  const spec = VENDOR_SPECS[vendor];
  return { notFound: `${spec.bin} CLI not found`, useApiKey: spec.fallback };
}

/** Steel one-liner carrying the per-vendor ToS-risk note (rule f). */
export function spawnRiskNote(vendor: SpawnVendor): string {
  return VENDOR_SPECS[vendor].risk;
}

/** Pure key-vault-style contract — swap the backend, keep the interface. */
export interface SpawnProbe {
  probe(vendor: SpawnVendor): Promise<VendorStatus>;
  probeAll(): Promise<VendorStatus[]>;
}

/** Shape the Rust `spawn_probe` command returns (camelCase, serde). */
interface RawProbe {
  installed?: boolean;
  path?: string | null;
  version?: string | null;
}

/**
 * Tauri-backed probe — delegates detection to the Rust host, which mirrors
 * knownPaths for discovery and reads only the binary's `--version` (never a
 * token/login file, rule d). `risk` is stamped from the local spec so a compromised
 * host can never inject a bogus risk label.
 */
export function createTauriSpawnProbe(invoke: Invoke): SpawnProbe {
  const probe = async (vendor: SpawnVendor): Promise<VendorStatus> => {
    // Only the vendor name crosses the boundary — never a path, never a token.
    const raw = (await invoke("spawn_probe", { vendor })) as RawProbe | null;
    return {
      vendor,
      installed: raw?.installed === true,
      path: raw?.path ?? undefined,
      version: raw?.version ?? undefined,
      risk: VENDOR_SPECS[vendor].risk,
    };
  };
  return {
    probe,
    async probeAll() {
      return Promise.all(SPAWN_VENDORS.map((v) => probe(v)));
    },
  };
}

/**
 * In-memory probe — the dev/test / non-Tauri fallback. A plain webview cannot
 * detect installed binaries, so every vendor reports NOT installed unless a
 * fixture says otherwise (which drives the honest API-key fallback in dev).
 */
export function createMemorySpawnProbe(
  fixtures: Partial<Record<SpawnVendor, { installed: boolean; path?: string; version?: string }>> = {},
): SpawnProbe {
  const probe = async (vendor: SpawnVendor): Promise<VendorStatus> => {
    const f = fixtures[vendor];
    return {
      vendor,
      installed: f?.installed === true,
      path: f?.path,
      version: f?.version,
      risk: VENDOR_SPECS[vendor].risk,
    };
  };
  return {
    probe,
    async probeAll() {
      return Promise.all(SPAWN_VENDORS.map((v) => probe(v)));
    },
  };
}

/** Pick the real backend at runtime: Tauri if present, else memory. */
export function resolveSpawnProbe(): SpawnProbe {
  const inv = tauriInvoke();
  return inv ? createTauriSpawnProbe(inv) : createMemorySpawnProbe();
}
