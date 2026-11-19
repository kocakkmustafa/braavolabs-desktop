/**
 * "Yayına hazırla" (BRA-UI-10): the pure half. Flag, validation, summary, error mapping and the governed
 * three-step run (commit, push, PR). Default OFF behind a local flag; see `isPublishEnabled`.
 *
 * Nothing here writes or reaches the network by itself: every effect is a host command that needs a one-time
 * approval token for its exact fields (native dialog). The GitHub token never passes through this module: it
 * is stored and used by the host only. Errors arrive as `publish:<code>` and map to words, never raw output.
 */
import type { ActionDetail, Governance } from "./governance";
import { changeSummary, type ChangeView } from "./changes";

// UI-10b'ye kadar kapalı: bu bayrak BRA-UI-10b (PAT yalnız PR REST'te, push kullanıcının git kimliğiyle) merge edilene dek
// hiçbir yapıda açılmaz ve varsayılanı açılmaz. Kodda bu anahtara "1" yazan bir yol yoktur (publish.test.ts kilitler).
export const PUBLISH_FLAG_KEY = "bv.flags.publish";
export const MAX_BRANCH = 100;
export const MAX_TITLE = 200;
export const MAX_BODY = 4000;

interface FlagStorage { getItem(key: string): string | null }
export function isPublishEnabled(storage?: FlagStorage): boolean {
  try { return (storage ?? (globalThis as { localStorage?: FlagStorage }).localStorage)?.getItem(PUBLISH_FLAG_KEY) === "1"; } catch { return false; }
}

/** Letters, digits and `._/-` only; mirrors `publish::is_valid_branch` in the host. */
export function isValidBranch(b: string): boolean {
  if (!b || b.length > MAX_BRANCH || b === "HEAD" || b === "@") return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(b)) return false;
  if (/^[-/.]/.test(b) || b.endsWith("/") || b.endsWith(".") || b.endsWith(".lock")) return false;
  if (b.includes("..") || b.includes("//")) return false;
  return b.split("/").every(s => s.length > 0 && !s.startsWith(".") && !s.endsWith(".lock"));
}

const FOLD: Record<string, string> = { ı: "i", İ: "i", ş: "s", Ş: "s", ğ: "g", Ğ: "g", ü: "u", Ü: "u", ö: "o", Ö: "o", ç: "c", Ç: "c" };
/** A suggested branch from the title: `braavo/<slug>`; always valid or the fixed fallback. */
export function suggestBranch(title: string): string {
  const slug = title.replace(/[ıİşŞğĞüÜöÖçÇ]/g, c => FOLD[c] ?? c).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  const b = slug ? `braavo/${slug}` : "braavo/degisiklik";
  return isValidBranch(b) ? b : "braavo/degisiklik";
}

/** Secret-looking paths; mirrors the host's list so the warning appears before anything is asked. */
export function isSecretPath(path: string): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  if (p.split("/").some(s => [".ssh", ".aws", ".gnupg", ".kube", ".docker"].includes(s))) return true;
  const b = p.split("/").pop() ?? p;
  if (b === ".env" || b.startsWith(".env.") || b.endsWith(".env") || b === ".envrc" || b.startsWith("config.env")) return true;
  if ([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"].some(e => b.endsWith(e)) || b.includes(".key.")) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/.test(b) || /^(credentials?|secrets?)(\..*)?$/.test(b)) return true;
  return [".npmrc", ".netrc", ".pypirc"].includes(b);
}

export interface PublishDraft { branch: string; title: string; body: string; draft: boolean }
export type DraftProblem = "branch" | "title" | "body";
export function draftProblems(d: PublishDraft): DraftProblem[] {
  const out: DraftProblem[] = [];
  if (!isValidBranch(d.branch.trim())) out.push("branch");
  const t = d.title.trim();
  if (!t || [...t].length > MAX_TITLE || /[\r\n\0]/.test(d.title)) out.push("title");
  if ([...d.body].length > MAX_BODY || d.body.includes("\0")) out.push("body");
  return out;
}

export interface PublishSummary { files: number; added: number; removed: number; secrets: string[]; tests: "unknown" }
/** Test status is never inferred: the app does not run or parse the project's tests, so it is always "unknown". */
export function publishSummary(views: ChangeView[]): PublishSummary {
  const s = changeSummary(views);
  return { ...s, secrets: views.map(v => v.path).filter(isSecretPath), tests: "unknown" };
}

export type PublishErrorCode =
  | "invalidBranch" | "invalidText" | "nothingToPublish" | "tooMany" | "secretFile" | "notGithub" | "noPat" | "keychainUnavailable"
  | "branchExists" | "identity" | "commitFailed" | "wrongBranch" | "pushRejected" | "noWriteAccess" | "unauthorized" | "notFound"
  | "rateLimit" | "network" | "conflict" | "unsafeConfig" | "cancelled" | "unknown";
const CODES: readonly string[] = ["invalidBranch", "invalidText", "nothingToPublish", "tooMany", "secretFile", "notGithub", "noPat", "keychainUnavailable", "branchExists", "identity", "commitFailed", "wrongBranch", "pushRejected", "noWriteAccess", "unauthorized", "notFound", "rateLimit", "network", "conflict", "unsafeConfig", "cancelled", "unknown"];

/** `publish:<code>` from the host becomes a known code; anything else (including free text) becomes "unknown". The text itself is dropped. */
export function errorCode(e: unknown): PublishErrorCode {
  const m = /^publish:(\w+)$/.exec(String(e instanceof Error ? e.message : e).trim());
  return m && CODES.includes(m[1]) ? (m[1] as PublishErrorCode) : "unknown";
}

export type PublishStep = "commit" | "push" | "pr";
export interface PublishInfo { branch: string | null; repo: string | null; base: string }
export interface PublishOutcome { ok: true; number: number; url: string; sha: string }
export interface PublishFailure { ok: false; step: PublishStep; code: PublishErrorCode }
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface RunDeps { invoke: Invoke; gov: Governance; onStep?: (step: PublishStep, state: "run" | "done") => void }
export interface RunInput { cwd: string; info: PublishInfo; draft: PublishDraft; files: string[]; from?: PublishStep }

/** One governed step: request -> native approval -> one-time token -> host command. Refusal or denial is "cancelled"/the deny code; nothing ran. */
async function gated<T>(deps: RunDeps, kind: string, detail: ActionDetail, run: (token: string) => Promise<T>): Promise<T> {
  const r = await deps.gov.request(kind, detail);
  if (r.decision === "deny") throw new Error("publish:invalidBranch");
  let token = r.token;
  if (r.decision !== "auto-allow") {
    try { token = (await deps.gov.approve(r.actionId)).token; } catch { throw new Error("publish:cancelled"); }
  }
  if (!token) throw new Error("publish:cancelled");
  try {
    const out = await run(token);
    await deps.gov.settle(kind, "success", detail).catch(() => undefined);
    return out;
  } catch (e) {
    await deps.gov.settle(kind, "error", detail).catch(() => undefined);
    throw e;
  }
}

const ORDER: PublishStep[] = ["commit", "push", "pr"];
/** Runs commit, push, PR in order (from `from` on a retry). Stops at the first failure and says which step. */
export async function runPublish(deps: RunDeps, input: RunInput): Promise<PublishOutcome | PublishFailure> {
  const { cwd, info, draft, files } = input;
  const branch = draft.branch.trim(), title = draft.title.trim(), body = draft.body.trim();
  const repo = info.repo ?? "";
  let sha = "";
  let step: PublishStep = input.from ?? "commit";
  try {
    for (const s of ORDER.slice(ORDER.indexOf(step))) {
      step = s;
      deps.onStep?.(s, "run");
      if (s === "commit") {
        sha = String(await gated(deps, "git.commit", { summary: "git commit", cwd, branch, title, body, files }, token =>
          deps.invoke("git_publish_commit", { token, cwd, branch, title, body, ts: Date.now() })));
      } else if (s === "push") {
        await gated(deps, "git.push", { summary: "git push", cwd, branch, repo }, token => deps.invoke("git_publish_push", { token, cwd, branch, ts: Date.now() }));
      } else {
        const pr = (await gated(deps, "github.pr", { summary: "open pull request", cwd, branch, base: info.base, repo, title, body, draft: draft.draft }, token =>
          deps.invoke("github_open_pr", { token, cwd, branch, base: info.base, title, body, draft: draft.draft, ts: Date.now() }))) as { number?: unknown; url?: unknown };
        deps.onStep?.(s, "done");
        const url = typeof pr?.url === "string" && pr.url.startsWith("https://github.com/") ? pr.url : "";
        if (!url || typeof pr.number !== "number") return { ok: false, step: s, code: "unknown" };
        return { ok: true, number: pr.number, url, sha };
      }
      deps.onStep?.(s, "done");
    }
  } catch (e) {
    return { ok: false, step, code: errorCode(e) };
  }
  return { ok: false, step, code: "unknown" };
}
