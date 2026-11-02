/**
 * Company panel transport + typed calls (daemon contract: CLI src/daemon/server.ts,
 * src/daemon/company.ts). Like daemon-client.ts, the webview never talks to the
 * daemon: the Rust host forwards the allow-listed panel routes, owns the event
 * stream and reads the findings file from a path it builds itself.
 */
import {
  DaemonError, errorFromHost, errorFromReply,
  type DaemonModels, type DaemonReply, type DaemonTransport, type StreamEvent,
} from "../daemon-client";
import type { HireRequest } from "./map";

export interface EventSubscription {
  /** Resolves when the stream ends: `status 499` = closed by us; anything else = reconnect. */
  done: Promise<DaemonReply>;
  close(): Promise<void>;
}

export interface Findings { text: string; truncated: boolean }

export interface PanelTransport {
  request: DaemonTransport["request"];
  events(onEvent: (event: StreamEvent) => void): EventSubscription;
  findings(companyId: string, role: string): Promise<Findings>;
}

export interface AgentPatch {
  approvalPolicy?: "ask" | "edits" | "readonly";
  provider?: string;
  model?: string;
  effort?: string | null;
  status?: "paused" | "idle";
  budgetUsdMonthly?: number | null;
}

export function createPanelApi(transport: PanelTransport) {
  const call = async <T>(method: "GET" | "POST" | "PUT" | "PATCH", path: string, body?: unknown): Promise<T> => {
    let reply: DaemonReply;
    try { reply = await transport.request(method, path, body); }
    catch (error) { throw errorFromHost(error); }
    if (reply.status < 200 || reply.status >= 300) throw errorFromReply(reply);
    return reply.body as T;
  };
  const id = (value: string) => encodeURIComponent(value);
  return {
    companies: () => call<unknown>("GET", "/v1/companies"),
    createCompany: (input: { name: string; mission?: string }) => call<unknown>("POST", "/v1/companies", input),
    panel: (companyId: string) => call<unknown>("GET", `/v1/companies/${id(companyId)}/panel`),
    hire: (companyId: string, request: HireRequest) => call<unknown>("POST", `/v1/companies/${id(companyId)}/hire`, request),
    updateAgent: (agentId: string, patch: AgentPatch) => call<unknown>("PATCH", `/v1/agents/${id(agentId)}`, patch),
    runRoutine: (routineId: string) => call<{ outcome: string; note?: string }>("POST", `/v1/routines/${id(routineId)}/run`),
    setCompanyBudget: (companyId: string, monthlyBudgetUsd: number | null) => call<unknown>("PATCH", `/v1/companies/${id(companyId)}`, { monthlyBudgetUsd }),
    tasks: (companyId: string) => call<unknown>("GET", `/v1/companies/${id(companyId)}/tasks`),
    createTask: (companyId: string, input: { title: string; body?: string; assignee?: string | null }) => call<unknown>("POST", `/v1/companies/${id(companyId)}/tasks`, input),
    updateTask: (taskId: string, patch: { status?: "OPEN" | "CANCELLED"; assignee?: string | null }) => call<unknown>("PATCH", `/v1/tasks/${id(taskId)}`, patch),
    runTask: (taskId: string) => call<unknown>("POST", `/v1/tasks/${id(taskId)}/run`),
    agentConversations: (agentId: string) => call<unknown>("GET", `/v1/conversations?${new URLSearchParams({ agentId, limit: "20" })}`),
    createAgentConversation: (agentId: string) => call<unknown>("POST", "/v1/conversations", { agentId }),
    skills: () => call<unknown>("GET", "/v1/skills"),
    hireWorker: (companyId: string, input: { engine: string; workdir: string; name?: string; approvalPolicy: string }) => call<unknown>("POST", `/v1/companies/${id(companyId)}/workers`, input),
    approvals: (companyId: string) => call<unknown>("GET", `/v1/companies/${id(companyId)}/approvals?status=pending`),
    decideApproval: (approvalId: string, decision: "allow" | "reject") => call<unknown>("POST", `/v1/approvals/${id(approvalId)}`, { decision }),
    taskEvents: (taskId: string) => call<unknown>("GET", `/v1/tasks/${id(taskId)}/events`),
    setAgentSkills: (agentId: string, skills: string[]) => call<unknown>("PUT", `/v1/agents/${id(agentId)}/skills`, { skills }),
    models: () => call<DaemonModels>("GET", "/v1/models"),
    async findings(companyId: string, role: string): Promise<Findings> {
      try { return await transport.findings(companyId, role); }
      catch (error) { throw errorFromHost(error); }
    },
    events: (onEvent: (event: StreamEvent) => void) => transport.events(onEvent),
  };
}

export type PanelApi = ReturnType<typeof createPanelApi>;
export { DaemonError };

// ── Tauri transport ───────────────────────────────────────────────────────────

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type ChannelCtor = new () => { onmessage: ((message: unknown) => void) | null };

let subscriptionSeq = 0;

export function createTauriPanelTransport(invoke: Invoke, Channel: ChannelCtor): PanelTransport {
  return {
    async request(method, path, body) {
      return (await invoke("daemon_request", { method, path, body: body ?? null })) as DaemonReply;
    },
    events(onEvent) {
      // Ids match the host's `[A-Za-z0-9_-]{1,128}` check.
      const subscriptionId = `ev_${Date.now().toString(36)}_${(subscriptionSeq += 1)}`;
      const channel = new Channel();
      channel.onmessage = (message) => {
        const m = message as StreamEvent;
        if (m && typeof m.event === "string") onEvent(m);
      };
      const done = (invoke("daemon_events_subscribe", { subscriptionId, onEvent: channel }) as Promise<DaemonReply>)
        .catch((error): DaemonReply => ({ status: 0, body: String(error instanceof Error ? error.message : error).slice(0, 200) }));
      return {
        done,
        async close() { await invoke("daemon_events_unsubscribe", { subscriptionId }).catch(() => false); },
      };
    },
    async findings(companyId, role) {
      return (await invoke("daemon_findings", { companyId, role })) as Findings;
    },
  };
}

/** Tauri at runtime; null in a plain browser preview / tests. */
export function resolvePanelTransport(): PanelTransport | null {
  const core = (globalThis as any)?.__TAURI__?.core;
  if (typeof core?.invoke !== "function" || typeof core?.Channel !== "function") return null;
  return createTauriPanelTransport(core.invoke as Invoke, core.Channel as ChannelCtor);
}
