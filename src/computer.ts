/**
 * Computer control (plan 5.8) — the agent sees the screen and uses the mouse and keyboard,
 * under the same fail-closed gate as every other side effect (governance.ts).
 *
 * - Off by default. A session is started by the user and ends after 15 minutes, 50 actions
 *   or the Stop button, whichever comes first (enforced by the Rust host, computer.rs).
 * - Reading the screen (a screenshot) needs one approval per session.
 * - Every write — click, type, key, scroll — needs its own approval. The token is bound to
 *   the target app, the point and the text, so an approval for one click cannot be spent
 *   on another.
 * - Only apps the user allowed (~/.braavo/computer.json "allowApps", by bundle id) can be
 *   controlled. Some apps can never be: system settings, password and key stores, terminals
 *   and script runners, finance and identity apps, login and authentication prompts,
 *   Braavolabs itself (an agent must not approve its own actions) and web browsers — web
 *   pages go through the Braavo browser, whose URL policy blocks banking, payment and
 *   government sites.
 * - Right before every action the host checks the frontmost app again; when it is not the
 *   approved one, the action is cancelled. Typing into a password field is always refused.
 *
 * The lists here are mirrored in src-tauri/src/computer.rs (a test keeps them equal); the
 * host is the real enforcement point.
 */
import type { ActionDetail, ActionKind } from "./governance";
import type { GateFn } from "./browser";

export const SESSION_MAX_ACTIONS = 50;
export const SESSION_MAX_MINUTES = 15;

/** Apps that can never be controlled, by exact bundle id. */
export const BLOCKED_APPS: readonly string[] = [
  "com.apple.systempreferences", "com.apple.Settings", "com.apple.keychainaccess", "com.apple.Passwords",
  "com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "org.alacritty", "net.kovidgoyal.kitty",
  "com.mitchellh.ghostty", "com.github.wez.wezterm", "co.zeit.hyper", "com.apple.ScriptEditor2", "com.apple.Automator",
  "com.apple.shortcuts", "com.apple.AppStore", "com.apple.ActivityMonitor", "com.apple.DiskUtility", "com.apple.installer",
  "com.apple.MigrateAssistant", "com.apple.SecurityAgent", "com.apple.loginwindow", "com.apple.LocalAuthentication.UIAgent",
  "com.apple.coreautha", "com.apple.UserNotificationCenter", "com.apple.Passbook",
  "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop", "com.lastpass.LastPass",
  "com.dashlane.dashlanephonefinal", "org.keepassxc.keepassxc", "com.yubico.yubioath",
  "com.braavolabs.desktop",
];

/** Bundle-id prefixes of web browsers: web pages go through the Braavo browser instead. */
export const BROWSER_PREFIXES: readonly string[] = [
  "com.apple.Safari", "com.google.Chrome", "org.mozilla.firefox", "com.microsoft.edgemac", "com.brave.Browser",
  "company.thebrowser.", "com.operasoftware.", "com.vivaldi.", "org.chromium.", "app.zen-browser.",
];

/** Finance and identity apps by name or bundle id (English and Turkish words). */
export const FINANCE_IDENTITY = /bank|banka|wallet|cüzdan|cuzdan|crypto|kripto|coin|paypal|revolut|\bwise\b|ledger|trezor|exodus|kraken|robinhood|broker|borsa|trading|e-?devlet|\bgov\b|devlet|identity|kimlik|passport|pasaport|authenticator/i;

/** Key combinations that open launchers or end the session — never sent. */
export const BLOCKED_KEYS: readonly string[] = ["cmd+space", "ctrl+space", "cmd+alt+escape", "cmd+ctrl+q", "cmd+shift+q", "cmd+alt+shift+q", "cmd+ctrl+power", "cmd+alt+power"];

export interface TargetApp { bundleId: string; name?: string }

/** Why an app can never be controlled, or null. */
export function blockedReason(app: TargetApp | undefined): string | null {
  if (!app?.bundleId) return "computer control needs the target app";
  const id = app.bundleId;
  if (BLOCKED_APPS.some(b => b.toLowerCase() === id.toLowerCase())) return `${app.name || id} cannot be controlled (system, security or Braavolabs itself)`;
  if (BROWSER_PREFIXES.some(p => id.startsWith(p))) return "web pages are driven only through the Braavo browser, whose URL policy blocks banking, payment and government sites";
  if (FINANCE_IDENTITY.test(id) || FINANCE_IDENTITY.test(app.name ?? "")) return `${app.name || id} looks like a finance or identity app and cannot be controlled`;
  return null;
}

/** "Cmd+Shift+S" → "cmd+shift+s" with the modifiers in a fixed order. */
export function normalizeKeys(combo: string): string {
  const parts = combo.toLowerCase().split("+").map(p => p.trim()).filter(Boolean)
    .map(p => ({ command: "cmd", "⌘": "cmd", option: "alt", opt: "alt", "⌥": "alt", control: "ctrl", "⌃": "ctrl", "⇧": "shift", esc: "escape", enter: "return" } as Record<string, string>)[p] ?? p);
  const order = ["cmd", "ctrl", "alt", "shift"];
  const mods = order.filter(m => parts.includes(m));
  const rest = parts.filter(p => !order.includes(p));
  return [...mods, ...rest].join("+");
}

// ── action model ────────────────────────────────────────────────────────────

export type ComputerAction =
  | { op: "screenshot" }
  | { op: "click" | "double_click" | "right_click"; x: number; y: number }
  | { op: "type"; text: string }
  | { op: "key"; keys: string }
  | { op: "scroll"; x: number; y: number; dx: number; dy: number };

/**
 * An action → its governance kind and detail. The summary (audit ledger) never carries
 * typed text — only its length; the raw text is bound and shown in the native dialog.
 */
export function computerActionToGate(a: ComputerAction, app: TargetApp, sessionId: string): { kind: ActionKind; detail: ActionDetail } {
  const who = app.name || app.bundleId;
  if (a.op === "screenshot") return { kind: "computer.read", detail: { app: app.bundleId, selector: sessionId, summary: `read the screen (session ${sessionId.slice(0, 8)})` } };
  const base = { app: app.bundleId, interactKind: a.op };
  switch (a.op) {
    case "click": case "double_click": case "right_click":
      return { kind: "computer.interact", detail: { ...base, x: Math.round(a.x), y: Math.round(a.y), summary: `${a.op.replace("_", " ")} at ${Math.round(a.x)},${Math.round(a.y)} in ${who}` } };
    case "type":
      return { kind: "computer.interact", detail: { ...base, value: a.text, summary: `type ${a.text.length} chars in ${who}` } };
    case "key": {
      const keys = normalizeKeys(a.keys);
      return { kind: "computer.interact", detail: { ...base, value: keys, summary: `press ${keys} in ${who}` } };
    }
    case "scroll":
      return { kind: "computer.interact", detail: { ...base, x: Math.round(a.x), y: Math.round(a.y), value: `${Math.round(a.dx)},${Math.round(a.dy)}`, summary: `scroll ${Math.round(a.dx)},${Math.round(a.dy)} in ${who}` } };
  }
}

// ── driver + governed chokepoint ────────────────────────────────────────────

export interface ComputerResult { ok: boolean; png?: string; width?: number; height?: number; scale?: number; error?: string }

export interface ComputerDriver {
  /** Run an already-gated action; the host spends the token (screenshots after the first use the session grant). */
  dispatch(action: ComputerAction, app: TargetApp, sessionId: string, token: string | null): Promise<ComputerResult>;
}

/**
 * Every computer action goes through here. Screenshots ask once per session (the host keeps
 * the grant); every other action asks every time. A deny or a reject never reaches the driver.
 */
export async function governedComputer(
  action: ComputerAction, app: TargetApp, session: { id: string; readGranted: boolean },
  gate: GateFn, driver: ComputerDriver,
): Promise<{ ok: true; result: ComputerResult } | { ok: false; reason: string }> {
  const blocked = blockedReason(app);
  if (blocked) return { ok: false, reason: blocked };
  if (action.op === "key" && BLOCKED_KEYS.includes(normalizeKeys(action.keys))) return { ok: false, reason: `${normalizeKeys(action.keys)} is never sent` };
  if (action.op === "screenshot" && session.readGranted) return { ok: true, result: await driver.dispatch(action, app, session.id, null) };
  const { kind, detail } = computerActionToGate(action, app, session.id);
  const g = await gate(kind, detail);
  if (!g.ok) return { ok: false, reason: g.reason };
  const result = await driver.dispatch(action, app, session.id, g.token);
  if (action.op === "screenshot" && result.ok) session.readGranted = true;
  return { ok: true, result };
}
