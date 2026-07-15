/**
 * BYOK key vault — LOCAL provider-key storage for Lane-A direct dispatch. The
 * desktop analogue of the CLI's forge/keys.ts, adapted to Tauri: keys live in
 * an OS-scoped `keys.json` (0600 on unix) written by the Rust host, NEVER in
 * localStorage or a plaintext file the webview touches.
 *
 * Enumeration (`list`) returns MASKED fingerprints only (first4…last4). The raw
 * secret leaves the store solely via `get`, called one-time at direct-dispatch
 * (client-side, direct.ts) and passed straight into the provider's auth header
 * — never rendered to the DOM. Outside Tauri (vitest, a plain `vite dev`
 * browser preview) this falls back to an in-memory Map so a key never lands on
 * disk in dev/test.
 *
 * Backends are injectable (invoke for Tauri, a Map for tests) so the whole
 * vault is unit-testable without a real keychain or disk.
 */

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Tauri v2 with `withGlobalTauri:true` exposes window.__TAURI__.core.invoke. */
function tauriInvoke(): Invoke | null {
  const g = globalThis as any;
  const inv = g?.__TAURI__?.core?.invoke;
  return typeof inv === "function" ? (inv as Invoke) : null;
}

/** Reveal nothing meaningful: first4…last4 for long keys, just "…" for short. */
export function maskKey(secret: string): string {
  const s = (secret ?? "").trim();
  if (s.length <= 8) return "…";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export interface KeyEntry {
  provider: string;
  /** Masked fingerprint — NEVER the raw secret. */
  masked: string;
}

/** Pure key-vault contract — swap the backend, keep the interface. */
export interface KeyVault {
  add(provider: string, secret: string): Promise<void>;
  /** Masked list only — safe to render. */
  list(): Promise<KeyEntry[]>;
  remove(provider: string): Promise<void>;
  /** Raw secret for one provider — call ONLY at direct-dispatch; never render. */
  get(provider: string): Promise<string | undefined>;
}

/** In-memory backend — the dev/test fallback. Masks locally on `list`. */
export function createMemoryKeyVault(): KeyVault {
  const map = new Map<string, string>();
  return {
    async add(provider, secret) {
      const p = provider.trim();
      if (!p) throw new Error("provider is required");
      if (!secret.trim()) throw new Error("secret is required");
      map.set(p, secret);
    },
    async list() {
      return [...map.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([provider, secret]) => ({ provider, masked: maskKey(secret) }));
    },
    async remove(provider) {
      map.delete(provider.trim());
    },
    async get(provider) {
      return map.get(provider.trim());
    },
  };
}

/** Tauri-backed backend — delegates to the Rust OS-scoped key commands. */
export function createTauriKeyVault(invoke: Invoke): KeyVault {
  return {
    async add(provider, secret) {
      await invoke("key_add", { provider, secret });
    },
    async list() {
      const raw = (await invoke("key_list")) as KeyEntry[] | null;
      return Array.isArray(raw)
        ? raw.map((e) => ({ provider: String(e?.provider ?? ""), masked: String(e?.masked ?? "…") }))
        : [];
    },
    async remove(provider) {
      await invoke("key_remove", { provider });
    },
    async get(provider) {
      const raw = (await invoke("key_get", { provider })) as string | null;
      return raw ?? undefined;
    },
  };
}

/** Pick the real backend at runtime: Tauri if present, else memory. */
export function resolveKeyVault(): KeyVault {
  const inv = tauriInvoke();
  return inv ? createTauriKeyVault(inv) : createMemoryKeyVault();
}
