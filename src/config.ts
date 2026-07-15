/**
 * Forge Desktop config — the SAME shape the CLI persists ({apiUrl, token,
 * refreshToken}) so the two clients share one mental model. Unlike the CLI
 * (which writes ~/.forge/config.json on disk), the desktop must NOT drop a
 * bearer token into a plaintext file or localStorage: the token is held in
 * memory and persisted through an injectable secure backend (see store.ts,
 * wired in main.ts to the Tauri OS-scoped secret command). `apiUrl` is the
 * only non-secret field and is the one thing safe to remember in localStorage.
 *
 * `save`/`persist` are pluggable so the API client (client.ts) stays a pure,
 * disk-free, network-injectable module that unit tests can drive with fakes.
 */

export interface Config {
  apiUrl: string;
  token?: string;
  refreshToken?: string;
}

/** Compile-time default; overridable at runtime via VITE_FORGE_API_URL. */
export const DEFAULT_API =
  (typeof import.meta !== "undefined" &&
    (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_FORGE_API_URL) ||
  "https://braavolabs.com/api/v1";

/**
 * Secret persister hook. Defaults to a no-op (memory-only) so `apiFetch` never
 * touches disk in tests. main.ts registers the real Tauri-backed persister at
 * startup via `setPersist(...)`. Field names mirror the CLI's config.ts.
 */
export type Persist = (c: Config) => void | Promise<void>;

let persister: Persist = () => {};

export function setPersist(fn: Persist): void {
  persister = fn;
}

/** Called by the client after a token refresh. Delegates to the registered backend. */
export function saveConfig(c: Config): void {
  void persister(c);
}
