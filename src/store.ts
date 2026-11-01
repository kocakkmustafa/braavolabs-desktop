/**
 * Platform-aware token storage for the desktop app.
 *
 * SECURITY NOTE: the bearer + refresh tokens are NEVER written to localStorage
 * or a plaintext file by this module. Under Tauri they are handed to a Rust
 * command (`secure_store_set`, src-tauri/src/lib.rs). On macOS/Windows the
 * Rust backend uses the OS Keychain/Credential Manager and fails closed on
 * backend errors. Linux/other platforms use the explicitly insecure 0600-file
 * fallback; `secret_backend_secure` reports this distinction. Outside Tauri
 * (vitest or a plain browser preview) tokens remain only in memory.
 *
 * Only `apiUrl` (non-secret) is allowed in localStorage — see loadApiUrl.
 */
import type { Config } from "./config";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Tauri v2 with `withGlobalTauri:true` exposes window.__TAURI__.core.invoke. */
function tauriInvoke(): Invoke | null {
  const g = globalThis as any;
  const inv = g?.__TAURI__?.core?.invoke;
  return typeof inv === "function" ? (inv as Invoke) : null;
}

/** Pure secret store contract — swap the backend, keep the interface. */
export interface SecretStore {
  get(): Promise<{ token?: string; refreshToken?: string }>;
  set(v: { token?: string; refreshToken?: string }): Promise<void>;
  clear(): Promise<void>;
}

/** Serialize snapshots so an earlier async token write cannot outlive logout. */
export function createConfigPersister(store: SecretStore): (cfg: Config) => Promise<void> {
  let pending = Promise.resolve();
  return (cfg) => {
    const snapshot = { token: cfg.token, refreshToken: cfg.refreshToken };
    const operation = pending.catch(() => {}).then(() =>
      snapshot.token || snapshot.refreshToken ? store.set(snapshot) : store.clear());
    pending = operation;
    return operation;
  };
}

/** In-memory backend — the dev/test fallback. Exported for unit tests. */
export function createMemoryStore(): SecretStore {
  let state: { token?: string; refreshToken?: string } = {};
  return {
    async get() {
      return { ...state };
    },
    async set(v) {
      state = { token: v.token, refreshToken: v.refreshToken };
    },
    async clear() {
      state = {};
    },
  };
}

/** Tauri-backed backend — delegates to the Rust OS-scoped secret command. */
export function createTauriStore(invoke: Invoke): SecretStore {
  return {
    async get() {
      const raw = (await invoke("secure_store_get")) as
        | { token?: string; refreshToken?: string }
        | null;
      return raw ?? {};
    },
    async set(v) {
      await invoke("secure_store_set", { token: v.token ?? null, refreshToken: v.refreshToken ?? null });
    },
    async clear() {
      await invoke("secure_store_clear");
    },
  };
}

/** Pick the real backend at runtime: Tauri if present, else memory. */
export function resolveStore(): SecretStore {
  const inv = tauriInvoke();
  return inv ? createTauriStore(inv) : createMemoryStore();
}

const API_URL_KEY = "braavolabs.apiUrl";
/** Set when the user saves an API URL from the sign-in form (1.1.0+). */
const API_URL_EXPLICIT_KEY = "braavolabs.apiUrl.explicit";

/** A packaged Tauri app is served from tauri://localhost (macOS/Linux) or tauri.localhost (Windows); dev uses the Vite server. */
export function isReleaseBuild(): boolean {
  const l = (globalThis as { location?: { protocol?: string; hostname?: string } }).location;
  return Boolean(l && (l.protocol === "tauri:" || l.hostname === "tauri.localhost"));
}

/** Loopback, .local or private-LAN hosts: a development or self-host address. */
export function isLocalApiUrl(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return false; }
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1" ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

/**
 * apiUrl is non-secret → safe to remember in localStorage (when available).
 * In a release build, a local address left behind by an old development setup
 * (saved before the explicit marker existed) falls back to the default; one the
 * user chose in the sign-in form is kept, so self-hosting still works.
 */
export function loadApiUrl(fallback: string, opts: { production?: boolean } = {}): string {
  try {
    const stored = globalThis.localStorage?.getItem(API_URL_KEY);
    if (!stored) return fallback;
    if (opts.production && isLocalApiUrl(stored) && globalThis.localStorage?.getItem(API_URL_EXPLICIT_KEY) !== "1") return fallback;
    return stored;
  } catch {
    return fallback;
  }
}

export function saveApiUrl(url: string): void {
  try {
    globalThis.localStorage?.setItem(API_URL_KEY, url);
    globalThis.localStorage?.setItem(API_URL_EXPLICIT_KEY, "1");
  } catch {
    /* localStorage unavailable (SSR/test) — non-fatal */
  }
}

/** Hydrate a Config's secret fields from the store (call once at startup). */
export async function hydrateConfig(cfg: Config, store: SecretStore): Promise<Config> {
  const secrets = await store.get();
  cfg.token = secrets.token;
  cfg.refreshToken = secrets.refreshToken;
  return cfg;
}
