/**
 * Workspace changes — the Code surface's "changed files" list (design v3).
 *
 * HONESTY BOUNDARY: this data comes from `git`, never from the vendor CLI's
 * output. The Lane-B contract keeps that stream OPAQUE (parsing it is
 * forbidden), but the session edits the user's real working tree — so git is
 * the legitimate source for what changed. The host command runs two fixed
 * read-only `git` invocations; this module only shapes and sorts the result.
 */

export interface RawChange {
  path?: unknown;
  added?: unknown;
  removed?: unknown;
  status?: unknown;
}

export interface ChangeView {
  path: string;
  /** Last path segment — what the list shows; the full path is the tooltip. */
  file: string;
  added: number;
  removed: number;
  /** Porcelain code, e.g. "M", "A", "??", "D". */
  status: string;
  /** True for an untracked file: git has no diff for it, so counts stay 0. */
  untracked: boolean;
  /** True when git reported the change as binary (or gave no counts). */
  countless: boolean;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;

/**
 * Shape the host payload. Rows without a path are dropped (a blank row tells
 * the user nothing). Deleted files keep their status so "D" is visible rather
 * than looking like an unchanged file with 0/0.
 */
export function toChangeViews(raw: unknown): ChangeView[] {
  if (!Array.isArray(raw)) return [];
  const out: ChangeView[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const c = r as RawChange;
    const path = str(c.path).trim();
    if (!path) continue;
    const status = str(c.status) || "?";
    const added = num(c.added);
    const removed = num(c.removed);
    const untracked = status.includes("?");
    out.push({
      path,
      file: path.split("/").filter(Boolean).pop() ?? path,
      added,
      removed,
      status,
      untracked,
      // Untracked files legitimately have no counts; a TRACKED file with 0/0 is
      // git reporting a binary diff. Both render "—" rather than a fake "+0".
      countless: added === 0 && removed === 0,
    });
  }
  // Biggest edits first — that is what a reviewer looks at — then alphabetical
  // so the order is stable between polls instead of jittering.
  return out.sort((a, b) => b.added + b.removed - (a.added + a.removed) || a.path.localeCompare(b.path));
}

/** "3 files · +64 −18" for the section header. Counts only what git counted. */
export function changeSummary(views: ChangeView[]): { files: number; added: number; removed: number } {
  return {
    files: views.length,
    added: views.reduce((n, v) => n + v.added, 0),
    removed: views.reduce((n, v) => n + v.removed, 0),
  };
}

/** Per-row right-hand label: "+21 −6", or "—" when git gave no counts. */
export function changeCounts(v: ChangeView): string {
  if (v.countless) return "—";
  return `+${v.added} −${v.removed}`;
}
