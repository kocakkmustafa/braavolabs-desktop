/**
 * `latest.json` check for the Tauri updater (BRA-UI-11c). Pure; used by scripts/verify-latest-json.mjs (release step)
 * and by the tests. The updater itself rejects a file with any incomplete platform entry, so this refuses the same
 * things BEFORE the file is uploaded: a missing platform, a missing/empty signature, a link outside the project's own
 * release downloads, a version that does not match the link, or a leftover template placeholder.
 */

export const UPDATER_PLATFORMS = ["darwin-aarch64", "darwin-x86_64", "windows-x86_64", "linux-x86_64"] as const;
export const DOWNLOAD_PREFIX = "https://github.com/kocakkmustafa/braavolabs-desktop/releases/download/";

const SEMVER = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,30})?$/;

export interface LatestJsonCheck { ok: boolean; errors: string[] }

/** A minisign signature file's content is base64 of text that starts with "untrusted comment:". */
function looksLikeSignature(sig: string): boolean {
  if (sig.length < 40 || sig.length > 4096 || !/^[A-Za-z0-9+/=]+$/.test(sig)) return false;
  try { return atob(sig).startsWith("untrusted comment:"); } catch { return false; }
}

export function validateLatestJson(input: unknown): LatestJsonCheck {
  const errors: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: ["not an object"] };
  const j = input as Record<string, unknown>;
  const version = typeof j.version === "string" ? j.version : "";
  if (!SEMVER.test(version)) errors.push("version: missing or not x.y.z");
  if (j.notes !== undefined && typeof j.notes !== "string") errors.push("notes: must be text");
  if (j.pub_date !== undefined && (typeof j.pub_date !== "string" || Number.isNaN(Date.parse(j.pub_date)))) errors.push("pub_date: not an RFC 3339 date");
  const platforms = j.platforms;
  if (!platforms || typeof platforms !== "object" || Array.isArray(platforms)) {
    errors.push("platforms: missing");
    return { ok: false, errors };
  }
  const p = platforms as Record<string, unknown>;
  for (const key of UPDATER_PLATFORMS) {
    const e = p[key];
    if (!e || typeof e !== "object" || Array.isArray(e)) { errors.push(`${key}: entry missing`); continue; }
    const { url, signature } = e as Record<string, unknown>;
    if (typeof url !== "string" || !url.startsWith(DOWNLOAD_PREFIX) || !/^[\x21-\x7e]+$/.test(url) || url.includes("..") || url.includes("@") || /["\\<>`^{}|]/.test(url)) {
      errors.push(`${key}: url missing or outside ${DOWNLOAD_PREFIX}`);
    } else if (SEMVER.test(version) && !url.startsWith(`${DOWNLOAD_PREFIX}v${version}/`)) {
      errors.push(`${key}: url is not under v${version}`);
    }
    if (typeof signature !== "string" || !signature) errors.push(`${key}: signature missing`);
    else if (!looksLikeSignature(signature)) errors.push(`${key}: signature is not a minisign signature (placeholder or a path?)`);
  }
  for (const key of Object.keys(p)) if (!(UPDATER_PLATFORMS as readonly string[]).includes(key)) errors.push(`${key}: unexpected platform key`);
  return { ok: errors.length === 0, errors };
}
