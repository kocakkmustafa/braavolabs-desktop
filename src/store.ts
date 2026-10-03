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

/** apiUrl is non-secret → safe to remember in localStorage (when available). */
export function loadApiUrl(fallback: string): string {
  try {
    return globalThis.localStorage?.getItem(API_URL_KEY) || fallback;
  } catch {
    return fallback;
  }
}

export function saveApiUrl(url: string): void {
  try {
    globalThis.localStorage?.setItem(API_URL_KEY, url);
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
