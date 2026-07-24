/**
 * Real relay transport — the runtime implementation of RelayBridge's
 * injected `RelayTransport` (relay-bridge.ts). Two request shapes:
 *   - register/postEvent: plain JSON request/response, so these reuse
 *     client.ts's `apiFetch` VERBATIM — same Bearer-token contract, same
 *     transparent single-refresh-on-401, same Config shape as every other
 *     authenticated desktop→API call.
 *   - subscribeCommands: a long-lived Server-Sent-Events stream
 *     (`GET /relay/sessions/:id/commands`, packages/api/.../relay/router.ts)
 *     that needs a custom `Authorization: Bearer` header — the webview's
 *     native `EventSource` cannot set headers, so this reads the response
 *     body as a stream and parses SSE frames by hand (fetch + ReadableStream,
 *     not EventSource).
 *
 * Deliberately THIN (per the module's scope): no reconnect-on-drop, no
 * token-refresh-on-401 for the long-lived stream. Both are real gaps for a
 * production-grade relay connection, called out here rather than silently
 * left implicit — closing them is headed-runtime follow-up work (a dropped
 * SSE connection needs a live server + a live client to verify against, not
 * something the headless test suite can exercise meaningfully). The pure
 * SSE-frame parsing below (`splitSseEvents` / `parseSseEvent`) IS unit
 * tested — that's the part that can go wrong independent of the network.
 */
import { apiFetch } from "./client";
import type { Config } from "./config";
import type { RelayTransport } from "./relay-bridge";
import type { SessionEventInput, SessionRegistration } from "./relay-protocol";

type FetchLike = (url: string, init?: any) => Promise<any>;

export interface RelayTransportOptions {
  cfg: Config;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Persist cfg after a refresh; defaults to apiFetch's own default (see client.ts). */
  save?: (c: Config) => void;
}

// ── pure SSE framing (unit-tested independent of any real network) ──────

/**
 * Split accumulated stream text into complete `"\n\n"`-terminated SSE event
 * blocks plus the leftover partial tail (kept for the next chunk). Pure —
 * no I/O — so it is exercised directly in tests without a real stream.
 */
export function splitSseEvents(buffer: string): { events: string[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  return { events: parts, rest };
}

/**
 * Parse one SSE event block into its JSON-decoded `data:` payload. Returns
 * null for a keepalive/comment-only block (`: keepalive …`), a `event: done`
 * marker with no data line, or malformed JSON — all of which the caller
 * ignores rather than treating as a command.
 */
export function parseSseEvent(block: string): unknown | null {
  let data: string | null = null;
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) data = line.slice("data:".length).trim();
    // "id:"/"event:" lines and ": comment" keepalives are not needed by the
    // command-dispatch path in this slice — ignored on purpose.
  }
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// ── the real transport ────────────────────────────────────────────────

export function createRelayTransport(opts: RelayTransportOptions): RelayTransport {
  const { cfg } = opts;
  const streamFetch: FetchLike = opts.fetchImpl ?? (globalThis.fetch as FetchLike);

  return {
    async register(reg: SessionRegistration) {
      const res = await apiFetch("/relay/sessions", {
        method: "POST",
        body: reg,
        cfg,
        fetchImpl: opts.fetchImpl,
        save: opts.save,
      });
      return { sessionId: String(res?.sessionId ?? "") };
    },

    async postEvent(sessionId: string, ev: SessionEventInput) {
      await apiFetch(`/relay/sessions/${encodeURIComponent(sessionId)}/events`, {
        method: "POST",
        body: ev,
        cfg,
        fetchImpl: opts.fetchImpl,
        save: opts.save,
      });
    },

    subscribeCommands(sessionId: string, onCmd: (raw: unknown) => void) {
      const controller = new AbortController();
      let stopped = false;

      void (async () => {
        try {
          const res = await streamFetch(
            `${cfg.apiUrl}/relay/sessions/${encodeURIComponent(sessionId)}/commands`,
            {
              method: "GET",
              headers: {
                Accept: "text/event-stream",
                ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
              },
              signal: controller.signal,
            },
          );
          const body = res?.body;
          if (!body || typeof body.getReader !== "function") return;
          const reader = body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (!stopped) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const { events, rest } = splitSseEvents(buffer);
            buffer = rest;
            for (const block of events) {
              const payload = parseSseEvent(block);
              if (payload !== null) onCmd(payload);
            }
          }
        } catch {
          // Aborted via unsubscribe(), or a network failure — either way the
          // stream is over. Reconnect-on-drop is a headed follow-up (see
          // module header), not this slice's scope.
        }
      })();

      return () => {
        stopped = true;
        controller.abort();
      };
    },
  };
}
