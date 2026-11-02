/**
 * Company panel screen (plan 2.5, D1/D2) — the first React island (K9). All
 * state and daemon calls live in the zustand store; these components only read
 * it and forward intent. Daemon/web-derived text is always rendered as text.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useStore } from "zustand";
import type { Translator } from "../i18n";
import { modelOptions, parseModelRef, providersNeedingModel } from "../daemon-client";
import {
  budgetLevel, EFFORT_CHOICES, FINDINGS_ROLES, keysAddCommand, parseBudget, parseUrls, PULL_MODEL_COMMAND, SETUP_COMMAND, TEMPLATE_IDS, URL_KEYS, urlKeyTemplate,
  type AgentView, type HireForm, type RoutineView, type TaskView,
} from "./map";
import { parseMarkdown, type Inline } from "./markdown";
import type { PanelError, PanelState, PanelStore } from "./store";

interface Env { t: Translator; locale: string; store: PanelStore }
/** Stable fallbacks: a selector must not return a fresh array per call (zustand v5). */
const NONE: never[] = [];
const EnvContext = createContext<Env | null>(null);
const useEnv = (): Env => {
  const env = useContext(EnvContext);
  if (!env) throw new Error("CompanyPanel env missing");
  return env;
};
function usePanel<T>(selector: (s: PanelState) => T): T {
  return useStore(useEnv().store, selector);
}

const ERROR_KEYS = new Set(["not-running", "timeout", "unauthorized", "not-found", "invalid", "busy", "missing-key", "model-required", "provider", "budget"]);
export function errorText(t: Translator, e: PanelError): string {
  const label = t(ERROR_KEYS.has(e.code) ? `panel.err.${e.code}` : "panel.err.unknown");
  return e.message && e.code !== "not-running" ? t("panel.errDetail", { label, detail: e.message.slice(0, 300) }) : label;
}

function formatWhen(locale: string, iso: string | null, fallback: string): string {
  if (!iso) return fallback;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return fallback;
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(ms);
}
const formatInt = (locale: string, n: number) => new Intl.NumberFormat(locale).format(n);
const formatUsd = (locale: string, n: number) =>
  new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(n);

function ErrorLine({ error }: { error: PanelError | null | undefined }) {
  const { t } = useEnv();
  if (!error) return null;
  return <div className="cp-error" role="alert">{errorText(t, error)}</div>;
}

function Cmd({ children }: { children: ReactNode }) {
  return <code className="cp-cmd mono">{children}</code>;
}

/** "Add a key … or pull a local model …" with the commands as code. */
function SetupHint({ provider }: { provider: string | null }) {
  const { t } = useEnv();
  return (
    <div className="cp-hint">
      {t("panel.setupHintKey")} <Cmd>{keysAddCommand(provider)}</Cmd> · {t("panel.setupHintLocal")} <Cmd>{PULL_MODEL_COMMAND}</Cmd> · {t("panel.setupHintMore")} <Cmd>{SETUP_COMMAND}</Cmd>
    </div>
  );
}

function StatusBadge({ agent }: { agent: AgentView }) {
  const { t } = useEnv();
  return <span className={`cp-badge cp-badge-${agent.status} mono`}>{t(`panel.status.${agent.status}`)}</span>;
}

// ── hire wizard ──────────────────────────────────────────────────────────────

function defaultTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

function HireFields({ form, setForm }: { form: HireForm; setForm: (f: HireForm) => void }) {
  const { t } = useEnv();
  const toggle = (id: string) =>
    setForm({ ...form, templates: form.templates.includes(id) ? form.templates.filter(x => x !== id) : [...form.templates, id] });
  const competitors = parseUrls(form.competitorUrls);
  const releases = parseUrls(form.releaseUrls);
  return (
    <>
      <fieldset className="cp-fieldset">
        <legend className="rail-section-label">{t("panel.templates")}</legend>
        {TEMPLATE_IDS.map(id => (
          <label key={id} className="cp-check">
            <input type="checkbox" checked={form.templates.includes(id)} onChange={() => toggle(id)} />
            <span>{t(`panel.tpl.${id}`)}</span>
          </label>
        ))}
      </fieldset>
      {form.templates.includes("market-analyst") && (
        <label className="cp-field">
          <span className="rail-section-label">{t("panel.competitorUrls")}</span>
          <textarea className="cp-textarea mono" dir="ltr" rows={3} value={form.competitorUrls}
            placeholder="https://example.com/pricing" onChange={e => setForm({ ...form, competitorUrls: e.target.value })} />
          {competitors.invalid.length > 0 && <span className="cp-error">{t("panel.invalidUrls", { urls: competitors.invalid.join(", ") })}</span>}
        </label>
      )}
      {form.templates.includes("release-tracker") && (
        <label className="cp-field">
          <span className="rail-section-label">{t("panel.releaseUrls")}</span>
          <textarea className="cp-textarea mono" dir="ltr" rows={3} value={form.releaseUrls}
            placeholder="https://example.com/changelog" onChange={e => setForm({ ...form, releaseUrls: e.target.value })} />
          {releases.invalid.length > 0 && <span className="cp-error">{t("panel.invalidUrls", { urls: releases.invalid.join(", ") })}</span>}
        </label>
      )}
      <label className="cp-field">
        <span className="rail-section-label">{t("panel.timezone")}</span>
        <input className="company-input cp-input" dir="ltr" value={form.timezone} onChange={e => setForm({ ...form, timezone: e.target.value })} />
      </label>
    </>
  );
}

function useHireForm(): [HireForm, (f: HireForm) => void] {
  const { locale } = useEnv();
  const [form, setForm] = useState<HireForm>(() => ({
    templates: [...TEMPLATE_IDS], competitorUrls: "", releaseUrls: "", timezone: defaultTimezone(), appLocale: locale,
  }));
  return [form, setForm];
}

function CreateCompany() {
  const { t, store } = useEnv();
  const createBusy = usePanel(s => s.createBusy);
  const hireBusy = usePanel(s => s.hireBusy);
  const createError = usePanel(s => s.createError);
  const hireError = usePanel(s => s.hireError);
  const [name, setName] = useState("");
  const [mission, setMission] = useState("");
  const [form, setForm] = useHireForm();
  const busy = createBusy || hireBusy;
  return (
    <form className="cp-card cp-create" onSubmit={e => { e.preventDefault(); void store.getState().createAndHire({ name, mission }, form); }}>
      <h2 className="cp-h">{t("panel.createTitle")}</h2>
      <p className="cp-sub">{t("panel.createIntro")}</p>
      <label className="cp-field">
        <span className="rail-section-label">{t("panel.companyName")}</span>
        <input className="company-input cp-input" required maxLength={120} value={name} onChange={e => setName(e.target.value)} />
      </label>
      <label className="cp-field">
        <span className="rail-section-label">{t("panel.mission")}</span>
        <textarea className="cp-textarea" rows={2} maxLength={4000} value={mission} onChange={e => setMission(e.target.value)} />
      </label>
      <HireFields form={form} setForm={setForm} />
      <ErrorLine error={createError ?? hireError} />
      <div className="cp-actions">
        <button className="set-btn cp-primary" type="submit" disabled={busy || !name.trim() || form.templates.length === 0}>
          {busy ? t("panel.working") : t("panel.createAndHire")}
        </button>
      </div>
    </form>
  );
}

function HireWizard() {
  const { t, store } = useEnv();
  const hireBusy = usePanel(s => s.hireBusy);
  const hireError = usePanel(s => s.hireError);
  const hasAgents = usePanel(s => (s.panel?.agents.length ?? 0) > 0);
  const [form, setForm] = useHireForm();
  return (
    <form className="cp-card" onSubmit={e => { e.preventDefault(); void store.getState().hire(form); }}>
      <h2 className="cp-h">{t("panel.hireTitle")}</h2>
      <p className="cp-sub">{t("panel.hireIntro")}</p>
      <HireFields form={form} setForm={setForm} />
      <ErrorLine error={hireError} />
      <div className="cp-actions">
        <button className="set-btn cp-primary" type="submit" disabled={hireBusy || form.templates.length === 0}>
          {hireBusy ? t("panel.working") : t("panel.hire")}
        </button>
        {hasAgents && <button className="set-btn" type="button" onClick={() => store.getState().setWizardOpen(false)}>{t("panel.cancel")}</button>}
      </div>
    </form>
  );
}

function HireResult() {
  const { t, store } = useEnv();
  const result = usePanel(s => s.hireResult);
  if (!result) return null;
  return (
    <section className="cp-card cp-result" aria-live="polite">
      <div className="cp-row-between">
        <h2 className="cp-h">{t("panel.hiredSummary", { agents: result.hired.length, routines: result.routineCount })}</h2>
        <button className="set-btn" onClick={() => store.getState().dismissHireResult()}>{t("panel.dismiss")}</button>
      </div>
      {result.skipped.length > 0 && <p className="cp-sub">{t("panel.skipped", { roles: result.skipped.map(id => t(`panel.tpl.${id}`)).join(", ") })}</p>}
      {result.needsSetup.length > 0 && (
        <div className="cp-block">
          <div className="rail-section-label">{t("panel.needsSetup")}</div>
          <ul className="cp-list">
            {result.needsSetup.map(n => (
              <li key={n.agentId}>
                <strong>{n.agentName}</strong> — {n.reason === "model-required" ? t("panel.modelRequired", { provider: n.provider ?? "" }) : t("panel.status.error")}
                {n.reason === "model-required" ? null : <SetupHint provider={n.provider} />}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.needsUrls.length > 0 && (
        <div className="cp-block">
          <div className="rail-section-label">{t("panel.needsUrls")}</div>
          <ul className="cp-list">
            {result.needsUrls.map(key => {
              const tpl = urlKeyTemplate(key);
              const which = key === URL_KEYS.releases ? t("panel.releaseUrls") : t("panel.competitorUrls");
              return <li key={key}>{tpl ? t(`panel.tpl.${tpl}`) : key} — {t("panel.needsUrlsHint", { field: which })}</li>;
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

// ── org chart + agent card ───────────────────────────────────────────────────

function OrgChart() {
  const { t, locale, store } = useEnv();
  const rows = usePanel(s => s.panel?.rows ?? NONE);
  const selected = usePanel(s => s.selectedAgentId);
  if (!rows.length) return <div className="company-empty">{t("panel.noAgents")}</div>;
  return (
    <ul className="cp-tree" role="tree" aria-label={t("panel.org")}>
      {rows.map(({ agent, depth }) => (
        <li key={agent.id} role="treeitem" aria-level={depth + 1} aria-selected={selected === agent.id} style={{ paddingInlineStart: `${depth * 18}px` }}>
          <button className={`cp-node${selected === agent.id ? " active" : ""}`} onClick={() => store.getState().selectAgent(selected === agent.id ? null : agent.id)}>
            <span className="cp-node-main">
              <span className="cp-node-name">{agent.name}</span>
              <span className="cp-node-sub mono">
                {agent.role}
                {" · "}
                {agent.setupNeeded ? t("panel.setupNeeded") : `${agent.provider ?? "?"}/${agent.model ?? "?"}`}
                {" · "}
                {agent.effort ?? t("panel.effortDefault")}
              </span>
              <span className="cp-node-sub mono">
                {t("panel.monthUsage", { runs: formatInt(locale, agent.month.runs), tokens: formatInt(locale, agent.month.inputTokens + agent.month.outputTokens) })}
              </span>
            </span>
            <StatusBadge agent={agent} />
          </button>
        </li>
      ))}
    </ul>
  );
}

// ── budgets ──────────────────────────────────────────────────────────────────

const AGENT_BUDGET_MAX = 100_000;
const COMPANY_BUDGET_MAX = 1_000_000;

/** "$3.20 of $25.00 this month (13%)" with a meter; the daemon warns at 80% and pauses at 100%. */
function BudgetMeter({ spent, budget, ratio }: { spent: number; budget: number | null; ratio: number | null }) {
  const { t, locale } = useEnv();
  if (budget === null) return <span className="cp-sub">{t("panel.budgetNone")}</span>;
  const level = budgetLevel(ratio);
  const pct = Math.round(Math.min(ratio ?? 0, 9.99) * 100);
  return (
    <span className="cp-budget">
      <span className="mono">{t("panel.budgetOf", { spent: formatUsd(locale, spent), budget: formatUsd(locale, budget), pct: formatInt(locale, pct) })}</span>
      <span className={`cp-meter cp-meter-${level}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(pct, 100)} aria-label={t("panel.budget")}>
        <span style={{ width: `${Math.min(pct, 100)}%` }} />
      </span>
      {level === "warn" && <span className="cp-hint">{t("panel.budgetWarn")}</span>}
      {level === "over" && <span className="cp-error">{t("panel.budgetOver")}</span>}
    </span>
  );
}

/** An amount field + Save; empty saves "no budget". */
function BudgetEditor({ current, max, busy, onSave, label }: { current: number | null; max: number; busy: boolean; onSave: (usd: number | null) => void; label: string }) {
  const { t } = useEnv();
  const [text, setText] = useState(current === null ? "" : String(current));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setText(current === null ? "" : String(current)); setInvalid(false); }, [current]);
  const save = () => {
    const v = parseBudget(text, max);
    if (v === "invalid") { setInvalid(true); return; }
    setInvalid(false);
    if (v !== current) onSave(v);
  };
  return (
    <div className="cp-field">
      <div className="cp-inline">
        <input className="company-input cp-input cp-budget-input" dir="ltr" inputMode="decimal" aria-label={label} placeholder={t("panel.budgetPlaceholder")}
          value={text} disabled={busy} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter") save(); }} />
        <button className="set-btn" disabled={busy} onClick={save}>{t("panel.budgetSave")}</button>
      </div>
      {invalid && <div className="cp-error" role="alert">{t("panel.budgetInvalid")}</div>}
    </div>
  );
}

const CUSTOM = "__custom__";

function AgentCard({ agent }: { agent: AgentView }) {
  const { t, locale, store } = useEnv();
  const busy = usePanel(s => Boolean(s.agentBusy[agent.id]));
  const error = usePanel(s => s.agentError[agent.id]);
  const models = usePanel(s => s.models);
  const modelsError = usePanel(s => s.modelsError);
  const options = useMemo(() => (models ? modelOptions(models) : []), [models]);
  const needModel = useMemo(() => (models ? providersNeedingModel(models) : []), [models]);
  const [choice, setChoice] = useState("");
  const [custom, setCustom] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  useEffect(() => { setChoice(""); setCustom(""); setLocalError(null); }, [agent.id]);

  const applyModel = () => {
    setLocalError(null);
    const ref = choice === CUSTOM ? parseModelRef(custom) : options.find(o => `${o.provider}/${o.model}` === choice) ?? null;
    if (!ref) { setLocalError(t("panel.modelInvalid")); return; }
    void store.getState().updateAgent(agent.id, { provider: ref.provider, model: ref.model });
  };
  const efforts: (string | null)[] = [...EFFORT_CHOICES];
  if (agent.effort && !efforts.includes(agent.effort)) efforts.push(agent.effort);

  return (
    <section className="cp-card cp-agent" aria-label={agent.name}>
      <div className="cp-row-between">
        <div>
          <h2 className="cp-h">{agent.name}</h2>
          <div className="cp-sub">{[agent.title, agent.role].filter(Boolean).join(" · ")}</div>
        </div>
        <StatusBadge agent={agent} />
      </div>

      {agent.setupNeeded ? (
        <div className="cp-block cp-setup">
          <strong>{t("panel.setupNeeded")}</strong>
          <SetupHint provider={null} />
        </div>
      ) : (
        <div className="cp-kv"><span>{t("panel.model")}</span><span className="mono">{agent.provider}/{agent.model}</span></div>
      )}
      <div className="cp-kv">
        <span>{t("panel.thisMonth")}</span>
        <span className="mono">
          {t("panel.monthUsage", { runs: formatInt(locale, agent.month.runs), tokens: formatInt(locale, agent.month.inputTokens + agent.month.outputTokens) })}
          {" · "}{formatUsd(locale, agent.month.usd)}
        </span>
      </div>

      <div className="cp-field">
        <span className="rail-section-label">{t("panel.agentBudget")}</span>
        <BudgetMeter spent={agent.month.usd} budget={agent.budgetUsdMonthly} ratio={agent.budgetRatio} />
        <BudgetEditor current={agent.budgetUsdMonthly} max={AGENT_BUDGET_MAX} busy={busy} label={t("panel.agentBudget")}
          onSave={usd => void store.getState().updateAgent(agent.id, { budgetUsdMonthly: usd })} />
      </div>

      <div className="cp-field">
        <span className="rail-section-label">{t("panel.changeModel")}</span>
        <div className="cp-inline">
          <select className="company-input cp-input" value={choice} disabled={busy} aria-label={t("panel.changeModel")} onChange={e => setChoice(e.target.value)}>
            <option value="">{options.length ? t("panel.pickModel") : t("panel.noModels")}</option>
            {options.map(o => <option key={`${o.provider}/${o.model}`} value={`${o.provider}/${o.model}`}>{o.label}</option>)}
            <option value={CUSTOM}>{t("panel.customModel")}</option>
          </select>
          {choice === CUSTOM && (
            <input className="company-input cp-input" dir="ltr" placeholder="PROVIDER/model" value={custom} onChange={e => setCustom(e.target.value)} />
          )}
          <button className="set-btn" disabled={busy || !choice} onClick={applyModel}>{t("panel.apply")}</button>
        </div>
        {needModel.length > 0 && <span className="cp-hint">{t("panel.providersNeedModel", { providers: needModel.join(", ") })}</span>}
        {!options.length && models && <SetupHint provider={null} />}
        <ErrorLine error={modelsError} />
      </div>

      <div className="cp-inline">
        <label className="cp-field">
          <span className="rail-section-label">{t("panel.effort")}</span>
          <select className="company-input cp-input" value={agent.effort ?? ""} disabled={busy}
            onChange={e => void store.getState().updateAgent(agent.id, { effort: e.target.value || null })}>
            {efforts.map(e => <option key={e ?? "default"} value={e ?? ""}>{e ? t(`panel.effort.${e}`) : t("panel.effortDefault")}</option>)}
          </select>
        </label>
        <button className="set-btn" disabled={busy || agent.status === "running"}
          onClick={() => void store.getState().updateAgent(agent.id, { status: agent.status === "paused" ? "idle" : "paused" })}>
          {agent.status === "paused" ? t("panel.resume") : t("panel.pause")}
        </button>
      </div>
      {busy && <div className="cp-sub" role="status">{t("panel.saving")}</div>}
      {localError && <div className="cp-error" role="alert">{localError}</div>}
      <ErrorLine error={error} />

      <AgentSkills agent={agent} busy={busy} />
      <AgentChats agent={agent} />
      <AgentTasks agent={agent} />
    </section>
  );
}

/** Plan 5.3: tick the SKILL.md skills this agent follows; order = the order they were ticked. */
function AgentSkills({ agent, busy }: { agent: AgentView; busy: boolean }) {
  const { t, store } = useEnv();
  const skills = usePanel(s => s.skills);
  const error = usePanel(s => s.skillsError);
  const toggle = (name: string, on: boolean) => {
    const next = on ? [...agent.skills.filter(s => s !== name), name] : agent.skills.filter(s => s !== name);
    void store.getState().setAgentSkills(agent.id, next);
  };
  // A skill folder that was removed stays assigned until changed; show it so it can be unticked.
  const missing = agent.skills.filter(n => skills && !skills.some(s => s.name === n));
  return (
    <div className="cp-field">
      <span className="rail-section-label">{t("panel.skills")}</span>
      {skills && !skills.length && !missing.length && <span className="cp-hint">{t("panel.noSkills")} <Cmd>~/.braavo/skills/&lt;name&gt;/SKILL.md</Cmd> · <Cmd>braavo skills</Cmd></span>}
      {skills && (skills.length > 0 || missing.length > 0) && (
        <ul className="cp-plain cp-skills">
          {skills.map(s => (
            <li key={s.name}>
              <label className="cp-check" title={s.description}>
                <input type="checkbox" checked={agent.skills.includes(s.name)} disabled={busy} onChange={e => toggle(s.name, e.target.checked)} />
                <span className="mono">{s.name}</span>
                <span className="cp-dim"> · {s.source === "project" ? t("panel.skillProject") : t("panel.skillUser")}{s.description ? ` · ${s.description}` : ""}</span>
              </label>
            </li>
          ))}
          {missing.map(n => (
            <li key={n}>
              <label className="cp-check">
                <input type="checkbox" checked disabled={busy} onChange={() => toggle(n, false)} />
                <span className="mono">{n}</span> <span className="cp-error">{t("panel.skillMissing")}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

function AgentChats({ agent }: { agent: AgentView }) {
  const { t, locale, store } = useEnv();
  const chats = usePanel(s => s.agentChats);
  const busy = usePanel(s => s.chatBusy);
  const error = usePanel(s => s.chatError);
  return (
    <div className="cp-field">
      <div className="cp-row-between">
        <span className="rail-section-label">{t("panel.chats")}</span>
        <button className="set-btn" disabled={busy || agent.setupNeeded} onClick={() => void store.getState().chatWithAgent(agent.id)}>{t("panel.newChat")}</button>
      </div>
      {chats.length ? (
        <ul className="cp-plain">
          {chats.slice(0, 5).map(c => (
            <li key={c.id}>
              <button className="cp-link" disabled={busy} onClick={() => void store.getState().chatWithAgent(agent.id, c.id)}>
                {c.title || t("panel.untitledChat")}
              </button>
              <span className="mono cp-dim"> · {formatWhen(locale, c.updatedAt, "")} · {t("panel.messages", { count: formatInt(locale, c.messageCount) })}</span>
            </li>
          ))}
        </ul>
      ) : <div className="cp-sub">{t("panel.noChats")}</div>}
      <ErrorLine error={error} />
    </div>
  );
}

function AgentTasks({ agent }: { agent: AgentView }) {
  const { t } = useEnv();
  const all = usePanel(s => s.tasks);
  const tasks = useMemo(() => all.filter(task => task.assigneeAgentId === agent.id), [all, agent.id]);
  return (
    <div className="cp-field">
      <span className="rail-section-label">{t("panel.agentTasks")}</span>
      {tasks.length ? <ul className="cp-plain">{tasks.slice(0, 8).map(task => <TaskRow key={task.id} task={task} compact />)}</ul>
        : <div className="cp-sub">{t("panel.noTasks")}</div>}
    </div>
  );
}

// ── tasks ────────────────────────────────────────────────────────────────────

function TaskRow({ task, compact = false }: { task: TaskView; compact?: boolean }) {
  const { t, locale, store } = useEnv();
  const busy = usePanel(s => Boolean(s.taskBusy[task.id]));
  const error = usePanel(s => s.taskError[task.id]);
  const assignee = usePanel(s => s.panel?.agents.find(a => a.id === task.assigneeAgentId) ?? null);
  const [open, setOpen] = useState(false);
  const detail = task.result ?? task.body;
  return (
    <li className="company-row cp-task">
      <div className="company-meta">
        <div className="company-name">
          <span className={`cp-badge cp-task-${task.status.toLowerCase()} mono`}>{t(`panel.taskStatus.${task.status}`)}</span> {task.title}
        </div>
        <div className="company-sub mono">
          {!compact && <>{assignee?.name ?? t("panel.anyAgent")} · </>}
          {formatWhen(locale, task.updatedAt, "")}
          {task.note ? ` · ${task.note}` : ""}
        </div>
        {detail && (
          <button className="cp-link" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t("panel.taskHide") : t("panel.taskShow")}</button>
        )}
        {open && detail && <div className="cp-task-detail"><Markdown source={detail} /></div>}
        <ErrorLine error={error} />
      </div>
      <div className="cp-inline">
        {task.status === "OPEN" && (
          <>
            <button className="set-btn" disabled={busy || !task.assigneeAgentId} title={task.assigneeAgentId ? undefined : t("panel.taskNeedsAssignee")}
              onClick={() => void store.getState().runTask(task.id)}>{busy ? t("panel.running") : t("panel.taskRun")}</button>
            <button className="set-btn" disabled={busy} onClick={() => void store.getState().setTaskStatus(task.id, "CANCELLED")}>{t("panel.taskCancel")}</button>
          </>
        )}
        {(task.status === "DONE" || task.status === "FAILED" || task.status === "CANCELLED") && (
          <button className="set-btn" disabled={busy} onClick={() => void store.getState().setTaskStatus(task.id, "OPEN")}>{t("panel.taskReopen")}</button>
        )}
        {task.conversationId && task.assigneeAgentId && (
          <button className="set-btn" onClick={() => void store.getState().chatWithAgent(task.assigneeAgentId!, task.conversationId!)}>{t("panel.taskOpenChat")}</button>
        )}
      </div>
    </li>
  );
}

function NewTaskForm() {
  const { t, store } = useEnv();
  const agents = usePanel(s => s.panel?.agents ?? NONE);
  const busy = usePanel(s => s.createTaskBusy);
  const error = usePanel(s => s.createTaskError);
  const selected = usePanel(s => s.selectedAgentId);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [assignee, setAssignee] = useState<string>("");
  useEffect(() => { if (selected) setAssignee(selected); }, [selected]);
  const add = async () => {
    if (await store.getState().createTask({ title, body, assignee: assignee || null })) { setTitle(""); setBody(""); }
  };
  return (
    <div className="cp-field cp-new-task">
      <div className="cp-inline">
        <input className="company-input cp-input" aria-label={t("panel.taskTitle")} placeholder={t("panel.taskTitle")} maxLength={300}
          value={title} disabled={busy} onChange={e => setTitle(e.target.value)} />
        <select className="company-input cp-input" aria-label={t("panel.assignee")} value={assignee} disabled={busy} onChange={e => setAssignee(e.target.value)}>
          <option value="">{t("panel.anyAgent")}</option>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <button className="set-btn" disabled={busy || !title.trim()} onClick={() => void add()}>{t("panel.addTask")}</button>
      </div>
      <textarea className="company-input cp-input" rows={2} aria-label={t("panel.taskBody")} placeholder={t("panel.taskBody")} maxLength={20000}
        value={body} disabled={busy} onChange={e => setBody(e.target.value)} />
      <ErrorLine error={error} />
    </div>
  );
}

function Tasks() {
  const { t, locale } = useEnv();
  const tasks = usePanel(s => s.tasks);
  const counts = usePanel(s => s.panel?.tasks ?? null);
  const error = usePanel(s => s.tasksError);
  return (
    <section className="cp-section">
      <div className="cp-row-between">
        <div className="rail-section-label">{t("panel.tasks")}</div>
        {counts && <span className="mono cp-dim">{t("panel.taskCounts", {
          open: formatInt(locale, counts.open), running: formatInt(locale, counts.running), done: formatInt(locale, counts.done), failed: formatInt(locale, counts.failed),
        })}</span>}
      </div>
      <NewTaskForm />
      <ErrorLine error={error} />
      {tasks.length ? <ul className="cp-plain">{tasks.slice(0, 30).map(task => <TaskRow key={task.id} task={task} />)}</ul>
        : <div className="company-empty">{t("panel.noTasks")}</div>}
    </section>
  );
}

// ── routines, activity, findings ─────────────────────────────────────────────

function RoutineRow({ routine }: { routine: RoutineView }) {
  const { t, locale, store } = useEnv();
  const busy = usePanel(s => Boolean(s.routineBusy[routine.id]));
  const result = usePanel(s => s.routineResult[routine.id]);
  return (
    <li className="company-row cp-routine">
      <div className="company-meta">
        <div className="company-name">{routine.name}</div>
        <div className="company-sub mono">
          {routine.agentName ?? routine.agentId}
          {" · "}
          {routine.enabled ? t("panel.nextRun", { when: formatWhen(locale, routine.nextFireAt, t("panel.never")) }) : t("panel.disabled")}
        </div>
        <div className="company-sub mono">
          {routine.last
            ? t("panel.lastRun", { when: formatWhen(locale, routine.last.at, t("panel.never")), outcome: routine.last.outcome })
            : t("panel.notRunYet")}
          {routine.last?.note ? ` · ${routine.last.note}` : ""}
        </div>
        {result && ("error" in result
          ? <div className="cp-error" role="alert">{errorText(t, result.error)}</div>
          : <div className="cp-sub" role="status">{t("panel.runResult", { outcome: result.outcome })}{result.note ? ` · ${result.note}` : ""}</div>)}
      </div>
      <button className="set-btn" disabled={busy} onClick={() => void store.getState().runRoutine(routine.id)}>
        {busy ? t("panel.running") : t("panel.runNow")}
      </button>
    </li>
  );
}

function Routines() {
  const { t } = useEnv();
  const routines = usePanel(s => s.panel?.routines ?? NONE);
  return (
    <section className="cp-section">
      <div className="rail-section-label">{t("panel.routines")}</div>
      {routines.length ? <ul className="cp-plain">{routines.map(r => <RoutineRow key={r.id} routine={r} />)}</ul>
        : <div className="company-empty">{t("panel.noRoutines")}</div>}
    </section>
  );
}

function Activity() {
  const { t, locale } = useEnv();
  const activity = usePanel(s => s.panel?.activity ?? NONE);
  return (
    <section className="cp-section">
      <div className="rail-section-label">{t("panel.activity")}</div>
      {activity.length ? (
        <ul className="cp-plain cp-activity">
          {activity.map((a, i) => (
            <li key={`${a.at}-${i}`}>
              <span className="mono cp-dim">{formatWhen(locale, a.at, "")}</span> {a.actor} · {a.verb}{a.summary ? ` · ${a.summary}` : ""}
            </li>
          ))}
        </ul>
      ) : <div className="company-empty">{t("panel.noActivity")}</div>}
    </section>
  );
}

function InlineText({ parts }: { parts: Inline[] }) {
  return <>{parts.map((p, i) => p.kind === "code" ? <code key={i} className="mono">{p.text}</code> : p.kind === "strong" ? <strong key={i}>{p.text}</strong> : <span key={i}>{p.text}</span>)}</>;
}

export function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "heading": return <div key={i} className={`cp-md-h cp-md-h${b.level}`}><InlineText parts={b.inline} /></div>;
          case "item": return <div key={i} className="cp-md-li" style={{ paddingInlineStart: `${12 + b.depth * 14}px`, "--li-indent": `${b.depth * 14}px` } as CSSProperties}><InlineText parts={b.inline} /></div>;
          case "code": return <pre key={i} className="cp-md-pre mono">{b.text}</pre>;
          default: return <p key={i} className="cp-md-p"><InlineText parts={b.inline} /></p>;
        }
      })}
    </>
  );
}

function FindingsView() {
  const { t, store } = useEnv();
  const role = usePanel(s => s.findingsRole);
  const findings = usePanel(s => s.findings);
  const error = usePanel(s => s.findingsError);
  const agents = usePanel(s => s.panel?.agents ?? NONE);
  const roles = useMemo(() => FINDINGS_ROLES.filter(r => agents.some(a => a.role === r)), [agents]);
  const box = useRef<HTMLDivElement>(null);
  // Findings are an append-only log: the newest entry is at the bottom.
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [findings?.text]);
  if (!roles.length) return null;
  const tplFor = (r: string) => (r === "release-tracker" ? "release-tracker" : "market-analyst");
  return (
    <section className="cp-section">
      <div className="cp-row-between">
        <div className="rail-section-label">{t("panel.findings")}</div>
        {roles.length > 1 && (
          <select className="company-input cp-input" value={role} aria-label={t("panel.findings")} onChange={e => void store.getState().setFindingsRole(e.target.value)}>
            {roles.map(r => <option key={r} value={r}>{t(`panel.tpl.${tplFor(r)}`)}</option>)}
          </select>
        )}
      </div>
      <ErrorLine error={error} />
      {findings?.truncated && <div className="cp-sub">{t("panel.findingsTruncated")}</div>}
      <div className="cp-findings" ref={box} tabIndex={0}>
        {findings?.text.trim() ? <Markdown source={findings.text} /> : <div className="company-empty">{t("panel.noFindings")}</div>}
      </div>
    </section>
  );
}

// ── screen ───────────────────────────────────────────────────────────────────

function Header() {
  const { t, locale, store } = useEnv();
  const panel = usePanel(s => s.panel);
  const companies = usePanel(s => s.companies);
  const companyId = usePanel(s => s.companyId);
  const live = usePanel(s => s.live);
  const wizardOpen = usePanel(s => s.wizardOpen);
  const budgetBusy = usePanel(s => s.budgetBusy);
  const budgetError = usePanel(s => s.budgetError);
  if (!panel) return null;
  return (
    <header className="cp-header">
      <div className="cp-row-between">
        <div className="cp-title">
          {companies.length > 1 ? (
            <select className="company-input cp-input" value={companyId ?? ""} aria-label={t("panel.company")} onChange={e => void store.getState().selectCompany(e.target.value)}>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          ) : <h1 className="cp-h1">{panel.company.name}</h1>}
          <span className={`cp-live mono${live ? " on" : ""}`}>{live ? t("panel.live") : t("panel.notLive")}</span>
        </div>
        <div className="cp-inline">
          {!wizardOpen && <button className="set-btn" onClick={() => store.getState().setWizardOpen(true)}>{t("panel.hireMore")}</button>}
          <button className="set-btn" onClick={() => void store.getState().refresh()}>{t("panel.refresh")}</button>
        </div>
      </div>
      {panel.company.mission && <p className="cp-sub">{panel.company.mission}</p>}
      <div className="company-summary mono">
        {t("panel.summary", {
          agents: formatInt(locale, panel.agents.length),
          tokens: formatInt(locale, panel.month.inputTokens + panel.month.outputTokens),
          usd: formatUsd(locale, panel.month.usd),
        })}
      </div>
      <div className="cp-field">
        <span className="rail-section-label">{t("panel.budget")}</span>
        <BudgetMeter spent={panel.month.usd} budget={panel.company.monthlyBudgetUsd} ratio={panel.month.budgetRatio} />
        {panel.month.unpricedCalls > 0 && <span className="cp-hint">{t("panel.unpriced", { count: formatInt(locale, panel.month.unpricedCalls) })}</span>}
        <BudgetEditor current={panel.company.monthlyBudgetUsd} max={COMPANY_BUDGET_MAX} busy={budgetBusy} label={t("panel.budget")}
          onSave={usd => void store.getState().setCompanyBudget(usd)} />
        <ErrorLine error={budgetError} />
      </div>
    </header>
  );
}

function Ready() {
  const wizardOpen = usePanel(s => s.wizardOpen);
  const selected = usePanel(s => s.panel?.agents.find(a => a.id === s.selectedAgentId) ?? null);
  const { t } = useEnv();
  return (
    <>
      <Header />
      <HireResult />
      {wizardOpen && <HireWizard />}
      <div className="cp-grid">
        <section className="cp-section">
          <div className="rail-section-label">{t("panel.org")}</div>
          <OrgChart />
        </section>
        {selected ? <AgentCard agent={selected} /> : <div className="cp-card cp-sub cp-placeholder">{t("panel.selectAgent")}</div>}
      </div>
      <Tasks />
      <Routines />
      <FindingsView />
      <Activity />
    </>
  );
}

function Body() {
  const { t, store } = useEnv();
  const phase = usePanel(s => s.phase);
  const error = usePanel(s => s.error);
  switch (phase) {
    case "idle":
    case "loading":
      return <div className="company-empty" role="status">{t("panel.loading")}</div>;
    case "offline":
      return (
        <div className="cp-card">
          <h2 className="cp-h">{t("panel.offlineTitle")}</h2>
          <p className="cp-sub">{t("panel.offline")} <Cmd>braavo daemon start</Cmd></p>
          <button className="set-btn" onClick={() => void store.getState().refresh()}>{t("panel.retry")}</button>
        </div>
      );
    case "error":
      return (
        <div className="cp-card">
          <ErrorLine error={error} />
          <button className="set-btn" onClick={() => void store.getState().refresh()}>{t("panel.retry")}</button>
        </div>
      );
    case "no-company":
      return <CreateCompany />;
    case "ready":
      return <Ready />;
  }
}

export function CompanyPanel(props: { t: Translator; locale: string; store: PanelStore }) {
  const env = useMemo<Env>(() => ({ t: props.t, locale: props.locale, store: props.store }), [props.t, props.locale, props.store]);
  return (
    <EnvContext.Provider value={env}>
      <div className="cp-root">
        <Body />
      </div>
    </EnvContext.Provider>
  );
}
