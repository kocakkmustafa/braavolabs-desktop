/**
 * Lane-A direct — single-shot BYOK completions straight to a provider's API,
 * bypassing the Braavolabs Forge server entirely. A VERBATIM port of the CLI's
 * forge/direct.ts: the per-provider request shape (auth header, endpoint,
 * response envelope) is kept explicit rather than papered over, so the
 * differences stay auditable and unit-testable with an injected fetch.
 *
 * The API key is retrieved ONE-TIME from the OS-scoped key store at dispatch
 * (see keyvault.ts) and passed straight into the provider's own auth header; it
 * is never logged, echoed, or rendered to the DOM. The three provider hosts are
 * the only external origins added to the Tauri connect-src CSP.
 *
 * Scope (Lane-A v1): anthropic, openai, groq. Model defaults are deliberately
 * conservative, DATED API identifiers — NOT a claim of "latest". Override with
 * an explicit model; see README for how to pick a current one from each
 * provider's own docs.
 */

type FetchLike = (url: string, init?: any) => Promise<any>;

export const DIRECT_PROVIDERS = ["anthropic", "openai", "groq"] as const;
export type DirectProvider = (typeof DIRECT_PROVIDERS)[number];

export function isDirectProvider(p: string): p is DirectProvider {
  return (DIRECT_PROVIDERS as readonly string[]).includes(p);
}

/**
 * Documented defaults (as of writing) — stable, dated model IDs, not
 * "whatever is newest". Always overridable via an explicit model.
 */
export const DIRECT_DEFAULT_MODEL: Record<DirectProvider, string> = {
  anthropic: "claude-3-5-sonnet-20241022",
  openai: "gpt-4o-mini",
  groq: "llama-3.1-8b-instant",
};

export class DirectApiError extends Error {
  status: number;
  provider: DirectProvider;
  constructor(provider: DirectProvider, status: number, message: string) {
    super(message);
    this.name = "DirectApiError";
    this.status = status;
    this.provider = provider;
  }
}

export interface DirectChatResult {
  content: string;
  model: string;
  provider: DirectProvider;
}

interface ProviderSpec {
  url: string;
  headers: (apiKey: string) => Record<string, string>;
  body: (model: string, question: string) => unknown;
  parse: (json: any) => string;
}

const SPECS: Record<DirectProvider, ProviderSpec> = {
  // Anthropic Messages API: key goes in x-api-key, NOT Authorization/Bearer.
  anthropic: {
    url: "https://api.anthropic.com/v1/messages",
    headers: (apiKey) => ({
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    }),
    body: (model, question) => ({
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: question }],
    }),
    parse: (json) => {
      const block = Array.isArray(json?.content) ? json.content.find((c: any) => c?.type === "text") : undefined;
      return String(block?.text ?? "");
    },
  },
  // OpenAI chat completions: Bearer auth.
  openai: {
    url: "https://api.openai.com/v1/chat/completions",
    headers: (apiKey) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    }),
    body: (model, question) => ({
      model,
      messages: [{ role: "user", content: question }],
    }),
    parse: (json) => String(json?.choices?.[0]?.message?.content ?? ""),
  },
  // Groq: OpenAI-compatible endpoint + auth shape.
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    headers: (apiKey) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    }),
    body: (model, question) => ({
      model,
      messages: [{ role: "user", content: question }],
    }),
    parse: (json) => String(json?.choices?.[0]?.message?.content ?? ""),
  },
};

/** Resolve the model for a provider: explicit override wins, else the dated default. */
export function resolveDirectModel(provider: DirectProvider, explicit?: string): string {
  const m = explicit?.trim();
  return m ? m : DIRECT_DEFAULT_MODEL[provider];
}

/** Single-shot completion straight to `provider` using a locally stored BYOK key. */
export async function directChat(
  provider: DirectProvider,
  apiKey: string,
  model: string,
  question: string,
  o: { fetchImpl?: FetchLike } = {},
): Promise<DirectChatResult> {
  const fetchImpl = o.fetchImpl ?? (globalThis.fetch as FetchLike);
  const spec = SPECS[provider];
  const res = await fetchImpl(spec.url, {
    method: "POST",
    headers: spec.headers(apiKey),
    body: JSON.stringify(spec.body(model, question)),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = json?.error?.message ?? json?.error ?? res.statusText ?? `request failed (${res.status})`;
    throw new DirectApiError(provider, res.status, String(message));
  }
  return { content: spec.parse(json), model, provider };
}
