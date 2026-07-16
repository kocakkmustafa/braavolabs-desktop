/**
 * Entry point — hydrate config from the secure store, register the persister,
 * pick a locale, then mount either the login or workspace view. All the heavy
 * lifting is delegated to the tested modules; this file is glue.
 */
import "./styles.css";
import { type Config, DEFAULT_API, setPersist } from "./config";
import { resolveStore, loadApiUrl, hydrateConfig } from "./store";
import { resolveKeyVault } from "./keyvault";
import { resolveSpawnProbe } from "./spawn";
import { resolveGovernance } from "./governance";
import { resolveMcpBridge } from "./mcp";
import { detectLocale, makeT } from "./i18n";
import { renderLogin, renderWorkspace, type UiDeps } from "./ui";

async function boot(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) return;

  const store = resolveStore();
  const cfg: Config = { apiUrl: loadApiUrl(DEFAULT_API) };
  await hydrateConfig(cfg, store);

  // Route the client's post-refresh save through the secure store (never disk
  // in plaintext / never localStorage for the token).
  const persist = async (c: Config) => {
    await store.set({ token: c.token, refreshToken: c.refreshToken });
  };
  setPersist((c) => void persist(c));

  const t = makeT(detectLocale());
  const gov = resolveGovernance();
  const deps: UiDeps = {
    root,
    cfg,
    t,
    vault: resolveKeyVault(),
    spawn: resolveSpawnProbe(),
    gov,
    mcp: resolveMcpBridge(gov),
    persist,
    onSignedOut: () => {
      void store.clear();
      renderLogin(deps);
    },
  };

  if (cfg.token) renderWorkspace(deps);
  else renderLogin(deps);
}

void boot();
