/** Minimal jobs inbox panel (BRA-P0-04i). Mounted only when the flag is on. No visual polish. */
import type { Config } from "./config";
import { INBOX_BUCKETS } from "./jobTypes";
import { createDecider, createNotifier, loadBuckets, type PlatformApproval } from "./inbox";
import { listApprovals } from "./client";

const TXT = {
  title: "Gelen kutusu",
  close: "Kapat",
  approve: "Onayla",
  reject: "Reddet",
  offline: "Çevrimdışısın: çevrimiçi olunca karar ver.",
  changed: "İçerik değişti; onaylanmadı. Yenile ve tekrar bak.",
  gone: "Bu onay artık bekleyen değil.",
  already: "Bu onaya zaten karar verilmiş.",
  error: "Karar gönderilemedi.",
  empty: "Boş",
  pending: "Bekleyen onay",
} as const;
const BUCKET_LABEL: Record<string, string> = { working: "Çalışıyor", needs_approval: "Onay bekliyor", done: "Bitti", stuck: "Takıldı" };

export function mountInbox(host: HTMLElement, cfg: Config, save?: (c: Config) => void | Promise<void>): { open(): void; dispose(): void } {
  const decider = createDecider({ cfg, save });
  let timer: ReturnType<typeof setInterval> | undefined;
  const panel = document.createElement("div");
  panel.className = "inbox-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", TXT.title);
  panel.style.cssText = "display:none;position:fixed;inset:10% 15%;overflow:auto;background:#111;color:#eee;padding:16px;z-index:50";
  host.append(panel);

  const notifier = createNotifier(a => {
    try {
      const N = (globalThis as { Notification?: any }).Notification;
      if (N?.permission === "granted") new N(TXT.pending, { body: a.description ?? a.id });
    } catch { /* notification is best-effort */ }
  });

  async function refresh(): Promise<void> {
    let pending: PlatformApproval[] = [];
    let buckets;
    try {
      pending = (await listApprovals(cfg, { limit: 50 }, { save })).items;
      buckets = await loadBuckets(cfg, { save });
    } catch { panel.textContent = TXT.offline; return; }
    notifier.feed(pending);
    panel.replaceChildren();
    const head = document.createElement("div");
    const close = document.createElement("button");
    close.textContent = TXT.close;
    close.addEventListener("click", () => { panel.style.display = "none"; });
    head.append(Object.assign(document.createElement("h2"), { textContent: TXT.title }), close);
    panel.append(head);
    const msg = document.createElement("div");
    msg.setAttribute("role", "status");
    for (const b of INBOX_BUCKETS) {
      const sec = document.createElement("section");
      sec.append(Object.assign(document.createElement("h3"), { textContent: `${BUCKET_LABEL[b]} (${buckets[b].length})` }));
      for (const r of buckets[b]) sec.append(Object.assign(document.createElement("div"), { textContent: r.pipeline?.name ?? r.id }));
      if (b === "needs_approval") {
        for (const a of pending) {
          const row = document.createElement("div");
          row.append(Object.assign(document.createElement("span"), { textContent: a.description ?? a.id }));
          for (const [label, d] of [[TXT.approve, "APPROVED"], [TXT.reject, "REJECTED"]] as const) {
            const btn = document.createElement("button");
            btn.textContent = label;
            btn.addEventListener("click", async () => {
              btn.disabled = true;
              const o = await decider.decide(a, d);
              msg.textContent = o.ok ? "" : TXT[o.reason];
              if (o.ok || o.reason !== "offline") void refresh();
              else btn.disabled = false;
            });
            row.append(btn);
          }
          sec.append(row);
        }
      }
      if (!buckets[b].length && b !== "needs_approval") sec.append(Object.assign(document.createElement("div"), { textContent: TXT.empty }));
      panel.append(sec);
    }
    panel.append(msg);
  }

  return {
    open() { panel.style.display = "block"; void refresh(); timer ??= setInterval(() => { if (panel.style.display !== "none") void refresh(); }, 30_000); },
    dispose() { if (timer) clearInterval(timer); panel.remove(); },
  };
}
