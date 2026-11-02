/**
 * Company panel state (zustand, K9). Framework-free on purpose: the store is a
 * vanilla zustand store driven by an injected PanelApi, so it is unit-tested
 * with a fake transport and React only subscribes to it.
 *
 * Freshness: every mutation is followed by a refresh, and the daemon's
 * `/v1/events` stream (company.changed, agent.status, routine.executed)
 * (plus task.changed) schedules a debounced refresh while the panel is active. A dropped stream
 * reconnects with backoff until the panel is stopped.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { DaemonError, type DaemonErrorCode, type DaemonModels, type StreamEvent } from "../daemon-client";
import type { AgentPatch, EventSubscription, Findings, PanelApi } from "./api";
import {
  buildHireRequest, displayNote, FINDINGS_ROLES, toCompanies, toConversationRefs, toHireResult, toPanel, toPanelEvent, toSkills, toTasks, toApprovals, toTaskEvents,
  type ApprovalView, type TaskEventView, type CompanyRef, type ConversationRef, type HireForm, type HireResultView, type PanelView, type SkillView, type TaskView,
} from "./map";

export interface PanelError { code: DaemonErrorCode; message: string }

export type RoutineResult = { outcome: string; note: string | null } | { error: PanelError };

export interface PanelData {
  phase: "idle" | "loading" | "offline" | "no-company" | "ready" | "error";
  error: PanelError | null;
  companies: CompanyRef[];
  companyId: string | null;
  panel: PanelView | null;
  models: DaemonModels | null;
  modelsError: PanelError | null;
  selectedAgentId: string | null;
  agentBusy: Record<string, boolean>;
  agentError: Record<string, PanelError>;
  routineBusy: Record<string, boolean>;
  routineResult: Record<string, RoutineResult>;
  createBusy: boolean;
  createError: PanelError | null;
  hireBusy: boolean;
  hireError: PanelError | null;
  hireResult: HireResultView | null;
  wizardOpen: boolean;
  findingsRole: string;
  findings: Findings | null;
  findingsError: PanelError | null;
  /** All of the company's tasks, newest first. */
  tasks: TaskView[];
  tasksError: PanelError | null;
  taskBusy: Record<string, boolean>;
  taskError: Record<string, PanelError>;
  createTaskBusy: boolean;
  createTaskError: PanelError | null;
  budgetBusy: boolean;
  budgetError: PanelError | null;
  /** The selected agent's conversations, newest first. */
  agentChats: ConversationRef[];
  chatBusy: boolean;
  chatError: PanelError | null;
  /** Installed SKILL.md skills (plan 5.3); null until loaded. */
  skills: SkillView[] | null;
  skillsError: PanelError | null;
  /** CLI employees' pending approvals (plan 3.1). */
  approvals: ApprovalView[];
  approvalBusy: Record<string, boolean>;
  approvalError: PanelError | null;
  /** Events of tasks the user opened, by task id. */
  taskEvents: Record<string, TaskEventView[]>;
  workerBusy: boolean;
  workerError: PanelError | null;
  /** True while an event subscription is open. */
  live: boolean;
}

export interface NewTask { title: string; body?: string; assignee?: string | null }

export interface PanelActions {
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
  selectCompany(id: string): Promise<void>;
  createAndHire(company: { name: string; mission?: string }, form: HireForm): Promise<boolean>;
  hire(form: HireForm): Promise<boolean>;
  setWizardOpen(open: boolean): void;
  dismissHireResult(): void;
  selectAgent(id: string | null): void;
  updateAgent(id: string, patch: AgentPatch): Promise<boolean>;
  runRoutine(id: string): Promise<void>;
  setFindingsRole(role: string): Promise<void>;
  loadModels(): Promise<void>;
  loadSkills(): Promise<void>;
  decideApproval(id: string, decision: "allow" | "reject"): Promise<void>;
  loadTaskEvents(taskId: string): Promise<void>;
  hireWorker(input: { engine: string; workdir: string; name?: string; approvalPolicy: string }): Promise<boolean>;
  setAgentSkills(agentId: string, skills: string[]): Promise<boolean>;
  setCompanyBudget(usd: number | null): Promise<boolean>;
  createTask(task: NewTask): Promise<boolean>;
  runTask(id: string): Promise<void>;
  setTaskStatus(id: string, status: "OPEN" | "CANCELLED"): Promise<void>;
  /** Open the agent's conversation in the chat surface: the given one, or a new one. */
  chatWithAgent(agentId: string, conversationId?: string): Promise<boolean>;
}

export type PanelState = PanelData & PanelActions;
export type PanelStore = StoreApi<PanelState>;

export interface PanelTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PanelStoreOptions {
  timers?: PanelTimers;
  /** Debounce for event-driven refreshes. */
  refreshDelayMs?: number;
  /** First reconnect delay; doubles up to `reconnectMaxMs`. */
  reconnectMs?: number;
  reconnectMaxMs?: number;
  /** Seed state (tests / server-rendered previews; zustand's server snapshot is the initial state). */
  initial?: Partial<PanelData>;
  /** Show a daemon conversation in the chat surface (the shell owns it). */
  openConversation?: (conversationId: string) => void;
}

export function toPanelError(error: unknown): PanelError {
  if (error instanceof DaemonError) return { code: error.code, message: error.message };
  return { code: "unknown", message: String(error instanceof Error ? error.message : error).slice(0, 300) };
}

const initial = (): PanelData => ({
  phase: "idle", error: null, companies: [], companyId: null, panel: null, models: null, modelsError: null,
  selectedAgentId: null, agentBusy: {}, agentError: {}, routineBusy: {}, routineResult: {},
  createBusy: false, createError: null, hireBusy: false, hireError: null, hireResult: null, wizardOpen: false,
  findingsRole: FINDINGS_ROLES[0], findings: null, findingsError: null,
  tasks: [], tasksError: null, taskBusy: {}, taskError: {}, createTaskBusy: false, createTaskError: null,
  budgetBusy: false, budgetError: null, agentChats: [], chatBusy: false, chatError: null, skills: null, skillsError: null,
  approvals: [], approvalBusy: {}, approvalError: null, taskEvents: {}, workerBusy: false, workerError: null, live: false,
});

const without = <T>(map: Record<string, T>, key: string): Record<string, T> => {
  const next = { ...map };
  delete next[key];
  return next;
};

export function createPanelStore(api: PanelApi, options: PanelStoreOptions = {}): PanelStore {
  const timers: PanelTimers = options.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const refreshDelay = options.refreshDelayMs ?? 300;
  const reconnectBase = options.reconnectMs ?? 2000;
  const reconnectMax = options.reconnectMaxMs ?? 30000;

  let active = false;
  let loadSeq = 0;
  let subscription: EventSubscription | null = null;
  let refreshTimer: unknown = null;
  let reconnectTimer: unknown = null;
  let reconnectDelay = reconnectBase;

  return createStore<PanelState>()((set, get) => {
    const scheduleRefresh = () => {
      if (!active) return;
      if (refreshTimer !== null) timers.clearTimeout(refreshTimer);
      refreshTimer = timers.setTimeout(() => { refreshTimer = null; void get().refresh(); }, refreshDelay);
    };

    const onEvent = ({ event, data }: StreamEvent) => {
      reconnectDelay = reconnectBase;
      const e = toPanelEvent(event, data);
      if (e.kind === "other") return;
      if (e.kind === "agent") {
        // Show the new state at once; the refresh brings the rest (usage, model).
        const panel = get().panel;
        if (panel?.agents.some(a => a.id === e.agentId)) {
          const patch = (a: PanelView["agents"][number]) => a.id !== e.agentId ? a
            : { ...a, status: e.status, setupNeeded: e.status === "error", ...(e.status === "error" ? { provider: null, model: null } : {}) };
          set({ panel: { ...panel, agents: panel.agents.map(patch), rows: panel.rows.map(r => ({ ...r, agent: patch(r.agent) })) } });
        }
      }
      scheduleRefresh();
    };

    const subscribe = () => {
      if (!active || subscription) return;
      const sub = api.events(onEvent);
      subscription = sub;
      set({ live: true });
      void sub.done.then((reply) => {
        if (subscription !== sub) return;
        subscription = null;
        set({ live: false });
        if (!active || reply.status === 499) return;
        // Daemon restarted or went away: try again, and resync once back.
        reconnectTimer = timers.setTimeout(() => {
          reconnectTimer = null;
          if (!active) return;
          subscribe();
          void get().refresh();
        }, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, reconnectMax);
      });
    };

    const loadFindings = async (companyId: string, panel: PanelView | null, seq: number) => {
      const role = get().findingsRole;
      if (!panel?.agents.some(a => a.role === role)) {
        if (seq === loadSeq) set({ findings: null, findingsError: null });
        return;
      }
      try {
        const findings = await api.findings(companyId, role);
        if (seq === loadSeq && get().findingsRole === role) set({ findings, findingsError: null });
      } catch (error) {
        if (seq === loadSeq) set({ findingsError: toPanelError(error) });
      }
    };

    const loadTasks = async (companyId: string, seq: number) => {
      try {
        const tasks = toTasks(await api.tasks(companyId));
        if (seq === loadSeq) set({ tasks, tasksError: null });
      } catch (error) {
        if (seq === loadSeq) set({ tasksError: toPanelError(error) });
      }
    };

    const loadApprovals = async (companyId: string, seq: number) => {
      try {
        const approvals = toApprovals(await api.approvals(companyId));
        if (seq === loadSeq) set({ approvals, approvalError: null });
      } catch (error) {
        // An older daemon has no approval routes: no queue to show.
        if (seq === loadSeq) set({ approvals: [], approvalError: toPanelError(error).code === "not-found" ? null : toPanelError(error) });
      }
    };

    let chatsSeq = 0;
    const loadAgentChats = async (agentId: string | null) => {
      const seq = ++chatsSeq;
      if (!agentId) { set({ agentChats: [], chatError: null }); return; }
      try {
        const chats = toConversationRefs(await api.agentConversations(agentId));
        if (seq === chatsSeq && get().selectedAgentId === agentId) set({ agentChats: chats });
      } catch (error) {
        if (seq === chatsSeq) set({ chatError: toPanelError(error) });
      }
    };

    return {
      ...initial(),
      ...options.initial,

      start() {
        if (active) return;
        active = true;
        reconnectDelay = reconnectBase;
        if (get().phase === "idle") set({ phase: "loading" });
        subscribe();
        void get().refresh();
        // Keys and local models change outside the app (`braavo keys add`, a pull): re-read on entry.
        void get().loadModels();
        // Skills are folders on disk the user edits outside the app: re-read on entry too.
        void get().loadSkills();
      },

      stop() {
        active = false;
        if (refreshTimer !== null) { timers.clearTimeout(refreshTimer); refreshTimer = null; }
        if (reconnectTimer !== null) { timers.clearTimeout(reconnectTimer); reconnectTimer = null; }
        const sub = subscription;
        subscription = null;
        set({ live: false });
        if (sub) void sub.close();
      },

      async refresh() {
        const seq = ++loadSeq;
        try {
          const companies = toCompanies(await api.companies());
          if (seq !== loadSeq) return;
          if (!companies.length) {
            set({ phase: "no-company", error: null, companies, companyId: null, panel: null, selectedAgentId: null });
            return;
          }
          const current = get().companyId;
          const companyId = companies.some(c => c.id === current) ? current! : companies[0].id;
          const panel = toPanel(await api.panel(companyId));
          if (seq !== loadSeq) return;
          if (!panel) throw new DaemonError(0, "unknown", "the daemon sent an unreadable panel");
          const selected = get().selectedAgentId;
          set({
            phase: "ready", error: null, companies, companyId, panel,
            selectedAgentId: selected && panel.agents.some(a => a.id === selected) ? selected : null,
            // A company with nobody hired yet opens on the wizard.
            wizardOpen: get().wizardOpen || panel.agents.length === 0,
          });
          await Promise.all([loadFindings(companyId, panel, seq), loadTasks(companyId, seq), loadAgentChats(get().selectedAgentId), loadApprovals(companyId, seq)]);
          // Keep the opened tasks' event lists current (a CLI employee may still be working).
          await Promise.all(Object.keys(get().taskEvents).map(taskId => get().loadTaskEvents(taskId)));
        } catch (error) {
          if (seq !== loadSeq) return;
          const e = toPanelError(error);
          set({ phase: e.code === "not-running" ? "offline" : "error", error: e });
        }
      },

      async selectCompany(id) {
        if (id === get().companyId) return;
        set({ companyId: id, selectedAgentId: null, findings: null, hireResult: null, wizardOpen: false, tasks: [], agentChats: [] });
        await get().refresh();
      },

      async createAndHire(company, form) {
        const name = company.name.trim();
        if (!name) { set({ createError: { code: "invalid", message: "name is required" } }); return false; }
        set({ createBusy: true, createError: null, hireError: null });
        let companyId: string;
        try {
          const created = (await api.createCompany({ name, ...(company.mission?.trim() ? { mission: company.mission.trim() } : {}) })) as { company?: { id?: unknown } };
          if (typeof created?.company?.id !== "string") throw new DaemonError(0, "unknown", "the daemon did not return a company id");
          companyId = created.company.id;
        } catch (error) {
          set({ createBusy: false, createError: toPanelError(error) });
          return false;
        }
        set({ createBusy: false, companyId, wizardOpen: true });
        const ok = await get().hire(form);
        if (!ok) await get().refresh();
        return ok;
      },

      async hire(form) {
        const companyId = get().companyId;
        if (!companyId) return false;
        set({ hireBusy: true, hireError: null });
        try {
          const result = toHireResult(await api.hire(companyId, buildHireRequest(form)));
          set({ hireBusy: false, hireResult: result, wizardOpen: false });
          await get().refresh();
          return true;
        } catch (error) {
          set({ hireBusy: false, hireError: toPanelError(error) });
          return false;
        }
      },

      setWizardOpen(open) { set({ wizardOpen: open, hireError: null }); },
      dismissHireResult() { set({ hireResult: null }); },
      selectAgent(id) {
        set({ selectedAgentId: id, agentChats: [], chatError: null });
        void loadAgentChats(id);
      },

      async updateAgent(id, patch) {
        set(s => ({ agentBusy: { ...s.agentBusy, [id]: true }, agentError: without(s.agentError, id) }));
        try {
          await api.updateAgent(id, patch);
          set(s => ({ agentBusy: without(s.agentBusy, id) }));
          await get().refresh();
          return true;
        } catch (error) {
          set(s => ({ agentBusy: without(s.agentBusy, id), agentError: { ...s.agentError, [id]: toPanelError(error) } }));
          return false;
        }
      },

      async runRoutine(id) {
        if (get().routineBusy[id]) return;
        set(s => ({ routineBusy: { ...s.routineBusy, [id]: true }, routineResult: without(s.routineResult, id) }));
        let result: RoutineResult;
        try {
          const r = await api.runRoutine(id);
          result = { outcome: typeof r?.outcome === "string" ? r.outcome : "unknown", note: displayNote(r?.note) };
        } catch (error) {
          result = { error: toPanelError(error) };
        }
        set(s => ({ routineBusy: without(s.routineBusy, id), routineResult: { ...s.routineResult, [id]: result } }));
        await get().refresh();
      },

      async setFindingsRole(role) {
        set({ findingsRole: role, findings: null, findingsError: null });
        const { companyId, panel } = get();
        if (companyId) await loadFindings(companyId, panel, loadSeq);
      },

      async setCompanyBudget(usd) {
        const companyId = get().companyId;
        if (!companyId) return false;
        set({ budgetBusy: true, budgetError: null });
        try {
          await api.setCompanyBudget(companyId, usd);
          set({ budgetBusy: false });
          await get().refresh();
          return true;
        } catch (error) {
          set({ budgetBusy: false, budgetError: toPanelError(error) });
          return false;
        }
      },

      async createTask(task) {
        const companyId = get().companyId;
        const title = task.title.trim();
        if (!companyId) return false;
        if (!title) { set({ createTaskError: { code: "invalid", message: "title is required" } }); return false; }
        set({ createTaskBusy: true, createTaskError: null });
        try {
          await api.createTask(companyId, { title, ...(task.body?.trim() ? { body: task.body.trim() } : {}), assignee: task.assignee ?? null });
          set({ createTaskBusy: false });
          await get().refresh();
          return true;
        } catch (error) {
          set({ createTaskBusy: false, createTaskError: toPanelError(error) });
          return false;
        }
      },

      async runTask(id) {
        if (get().taskBusy[id]) return;
        set(s => ({ taskBusy: { ...s.taskBusy, [id]: true }, taskError: without(s.taskError, id) }));
        try { await api.runTask(id); set(s => ({ taskBusy: without(s.taskBusy, id) })); }
        catch (error) { set(s => ({ taskBusy: without(s.taskBusy, id), taskError: { ...s.taskError, [id]: toPanelError(error) } })); }
        await get().refresh();
      },

      async setTaskStatus(id, status) {
        set(s => ({ taskBusy: { ...s.taskBusy, [id]: true }, taskError: without(s.taskError, id) }));
        try { await api.updateTask(id, { status }); set(s => ({ taskBusy: without(s.taskBusy, id) })); }
        catch (error) { set(s => ({ taskBusy: without(s.taskBusy, id), taskError: { ...s.taskError, [id]: toPanelError(error) } })); }
        await get().refresh();
      },

      async chatWithAgent(agentId, conversationId) {
        if (!options.openConversation || get().chatBusy) return false;
        set({ chatBusy: true, chatError: null });
        try {
          let id = conversationId;
          if (!id) {
            const created = (await api.createAgentConversation(agentId)) as { conversation?: { id?: unknown } };
            if (typeof created?.conversation?.id !== "string") throw new DaemonError(0, "unknown", "the daemon did not return a conversation id");
            id = created.conversation.id;
          }
          set({ chatBusy: false });
          options.openConversation(id);
          return true;
        } catch (error) {
          set({ chatBusy: false, chatError: toPanelError(error) });
          return false;
        }
      },

      async decideApproval(id, decision) {
        set(s => ({ approvalBusy: { ...s.approvalBusy, [id]: true }, approvalError: null }));
        try { await api.decideApproval(id, decision); }
        catch (error) { set({ approvalError: toPanelError(error) }); }
        set(s => ({ approvalBusy: without(s.approvalBusy, id) }));
        await get().refresh();
      },

      async loadTaskEvents(taskId) {
        try {
          const events = toTaskEvents(await api.taskEvents(taskId));
          set(s => ({ taskEvents: { ...s.taskEvents, [taskId]: events } }));
        } catch { set(s => ({ taskEvents: { ...s.taskEvents, [taskId]: [] } })); }
      },

      async hireWorker(input) {
        const companyId = get().companyId;
        if (!companyId) return false;
        set({ workerBusy: true, workerError: null });
        try {
          await api.hireWorker(companyId, input);
          set({ workerBusy: false });
          await get().refresh();
          return true;
        } catch (error) {
          set({ workerBusy: false, workerError: toPanelError(error) });
          return false;
        }
      },

      async loadSkills() {
        try { set({ skills: toSkills(await api.skills()), skillsError: null }); }
        catch (error) { set({ skillsError: toPanelError(error) }); }
      },

      async setAgentSkills(agentId, skills) {
        set(s => ({ agentBusy: { ...s.agentBusy, [agentId]: true }, agentError: without(s.agentError, agentId) }));
        try {
          await api.setAgentSkills(agentId, skills);
          set(s => ({ agentBusy: without(s.agentBusy, agentId) }));
          await get().refresh();
          return true;
        } catch (error) {
          set(s => ({ agentBusy: without(s.agentBusy, agentId), agentError: { ...s.agentError, [agentId]: toPanelError(error) } }));
          return false;
        }
      },

      async loadModels() {
        try { set({ models: await api.models(), modelsError: null }); }
        catch (error) { set({ modelsError: toPanelError(error) }); }
      },
    };
  });
}
