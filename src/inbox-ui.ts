/** Minimal jobs inbox panel (BRA-P0-04i). Mounted only when the flag is on. No visual polish. */
import type { Config } from "./config";
import type { Translator } from "./i18n";
import { INBOX_BUCKETS } from "./jobTypes";
import { createDecider, createNotifier, loadBuckets, type PlatformApproval } from "./inbox";
import { listApprovals } from "./client";

const REFRESH_TIMEOUT_MS = 15_000;
const POLL_MS = 30_000;

export interface InboxHandle { open(): void; dispose(): void }

let active: InboxHandle | null = null;
/** Dispose the current mount (workspace teardown / sign-out). Safe to call repeatedly. */
export function disposeActiveInbox(): void {
  const a = active;
  active = null;
  a?.dispose();
}

export function mountInbox(host: HTMLElement, cfg: Config, t: Translator, save?: (c: Config) => void | Promise<void>): InboxHandle {
  disposeActiveInbox(); // single instance: a re-render must not leave the old poller running
  const decider = createDecider({ cfg, save });
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  const panel = document.createElement("div");
  panel.className = "inbox-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", t("inbox.title"));
  panel.style.cssText = "display:none;position:fixed;inset:10% 15%;overflow:auto;background:#111;color:#eee;padding:16px;z-index:50";

  // Persistent nodes: header (with Close) and message line live outside the re-drawn body.
  const head = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = t("inbox.title");
  const closeBtn = document.createElement("button");
  closeBtn.textContent = t("inbox.close");
  closeBtn.addEventListener("click", () => { panel.style.display = "none"; });
  head.append(title, closeBtn);
  const msg = document.createElement("div");
  msg.setAttribute("role", "status");
  const body = document.createElement("div");
  panel.append(head, msg, body);
  host.append(panel);

  const notifier = createNotifier(a => {
    try {
      const N = (globalThis as { Notification?: any }).Notification;
      if (N?.permission === "granted") new N(t("inbox.pending"), { body: a.description ?? a.id });
    } catch { /* notification is best-effort */ }
  });

  async function refresh(): Promise<void> {
    if (disposed) return;
    let pending: PlatformApproval[] = [];
    let buckets;
    try {
      const signal = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
      pending = (await listApprovals(cfg, { limit: 50 }, { save, signal })).items;
      buckets = await loadBuckets(cfg, { save, signal });
    } catch { if (!disposed) msg.textContent = t("inbox.offline"); return; }
    if (disposed) return;
    notifier.feed(pending);
    body.replaceChildren(); // only the body is redrawn; Close + message line survive
    for (const b of INBOX_BUCKETS) {
      const sec = document.createElement("section");
      const h = document.createElement("h3");
      h.textContent = `${t(`inbox.bucket.${b}`)} (${buckets[b].length})`;
      sec.append(h);
      for (const r of buckets[b]) {
        const row = document.createElement("div");
        row.textContent = r.pipeline?.name ?? r.id;
        sec.append(row);
      }
      if (b === "needs_approval") {
        for (const a of pending) {
          const row = document.createElement("div");
          const label = document.createElement("span");
          label.textContent = a.description ?? a.id;
          row.append(label);
          for (const [text, d] of [[t("inbox.approve"), "APPROVED"], [t("inbox.reject"), "REJECTED"]] as const) {
            const btn = document.createElement("button");
            btn.textContent = text;
            btn.addEventListener("click", async () => {
              btn.disabled = true;
              const o = await decider.decide(a, d);
              if (disposed) return;
              if (o.ok) msg.textContent = "";
              else { msg.textContent = t(`inbox.${o.reason}`); if (o.reason === "offline" || o.reason === "error") btn.disabled = false; }
              if (o.ok || (o.reason !== "offline" && o.reason !== "error")) {
                const keep = msg.textContent;
                await refresh();
                if (keep) msg.textContent = keep; // message is set AFTER the redraw
              }
            });
            row.append(btn);
          }
          sec.append(row);
        }
      } else if (!buckets[b].length) {
        const e = document.createElement("div");
        e.textContent = t("inbox.empty");
        sec.append(e);
      }
      body.append(sec);
    }
  }

  const handle: InboxHandle = {
    open() {
      if (disposed) return;
      panel.style.display = "block";
      msg.textContent = "";
      void refresh();
      timer ??= setInterval(() => { if (panel.style.display !== "none") void refresh(); }, POLL_MS);
    },
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      panel.remove();
      if (active === handle) active = null;
    },
  };
  active = handle;
  return handle;
}
