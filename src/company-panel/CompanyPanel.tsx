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
  EFFORT_CHOICES, FINDINGS_ROLES, keysAddCommand, parseUrls, PULL_MODEL_COMMAND, SETUP_COMMAND, TEMPLATE_IDS, URL_KEYS, urlKeyTemplate,
  type AgentView, type HireForm, type RoutineView,
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

const ERROR_KEYS = new Set(["not-running", "timeout", "unauthorized", "not-found", "invalid", "busy", "missing-key", "model-required", "provider"]);
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
