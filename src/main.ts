/**
 * Entry point — hydrate config from the secure store, register the persister,
 * pick a locale, then mount either the login or workspace view. All the heavy
 * lifting is delegated to the tested modules; this file is glue.
 */
import "./styles.css";
import { type Config, DEFAULT_API, setPersist } from "./config";
import { resolveStore, loadApiUrl, hydrateConfig, createConfigPersister } from "./store";
import { resolveKeyVault } from "./keyvault";
import { resolveSpawnProbe } from "./spawn";
import { resolveGovernance } from "./governance";
import { resolveMcpBridge } from "./mcp";
import { detectLocale, makeT, applyLocale } from "./i18n";
import { renderLogin, renderWorkspace, type UiDeps } from "./ui";
import { verifyHistoryIdentity } from "./client";
import { clearAllSessions } from "./sessions";

async function boot(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) return;

  const store = resolveStore();
  const cfg: Config = { apiUrl: loadApiUrl(DEFAULT_API) };
  await hydrateConfig(cfg, store);

  // Route the client's post-refresh save through the secure store (never disk
  // in plaintext / never localStorage for the token).
  const persist = createConfigPersister(store);
  setPersist(persist);

  const locale = detectLocale();
  applyLocale(locale);
  const t = makeT(locale);
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
    onSignOutError: (message) => {
      const warning = document.createElement("p");
      warning.setAttribute("role", "alert");
      warning.textContent = t("common.signOutWarning");
      void message;
      const retry = document.createElement("button");
      retry.textContent = t("common.retryClear");
      retry.addEventListener("click", async () => {
        if (cfg.token || cfg.refreshToken) return;
        retry.disabled = true;
        try {
          await persist(cfg);
          if (!cfg.token && !cfg.refreshToken) { warning.remove(); retry.remove(); }
        } catch {
          // Keep the sanitized warning and retry action; never display backend details.
        } finally { retry.disabled = false; }
      });
      root.prepend(warning, retry);
    },
    onSignedOut: () => {
      // Transcripts + the cached account email are plain user content, but they
      // are THIS user's content — the next account on this machine must not
      // find them in the sidebar. renderLogin() also tears the workspace down
      // (companion bridge + governance decorator), see runWorkspaceTeardown.
      const historyCleared = clearAllSessions();
      renderLogin(deps);
      if (!historyCleared) {
        const warning = document.createElement("p"); warning.setAttribute("role", "alert");
        warning.textContent = t("sessions.clearFailed"); root.prepend(warning);
      }
    },
  };

  const invoke = (globalThis as any).__TAURI__?.core?.invoke;
  let nativeLocaleFailed = false;
  if (typeof invoke === "function") {
    try { await invoke("set_ui_locale", { locale }); } catch { nativeLocaleFailed = true; }
  }
  if (cfg.token) {
    root.textContent = t("sessions.verifying");
    await verifyHistoryIdentity(cfg, { save: persist });
    if (cfg.token) renderWorkspace(deps); else renderLogin(deps);
  } else renderLogin(deps);
  if (nativeLocaleFailed) {
    const warning = document.createElement("p"); warning.setAttribute("role", "status");
    warning.textContent = t("native.syncFailed"); root.prepend(warning);
  }
}

void boot();
