import type { Config } from "./config";
import type { Translator } from "./i18n";
import { captureSession, isCurrentSession, listCompareSelectionOptions } from "./client";
import type { CompareSelectionOptions, ModelSelection, ReasoningEffort } from "./compare-selection";

/** Only the compare lane exposes server-owned model/effort metadata. */
export function createCompareControls(cfg: Config, t: Translator, company: () => string, mounted: () => boolean) {
  const element = document.createElement("div");
  element.className = "compare-controls";
  const selectionMode = document.createElement("select");
  selectionMode.className = "company-input";
  selectionMode.setAttribute("aria-label", t("chat.modelSelection"));
  for (const value of ["automatic", "selected"]) {
    const option = document.createElement("option");
    option.value = value; option.textContent = t(`chat.${value}Models`);
    selectionMode.append(option);
  }
  const load = document.createElement("button");
  load.textContent = t("chat.loadModels");
  const status = document.createElement("div");
  status.className = "composer-hint";
  status.setAttribute("role", "status");
  const rows = document.createElement("div");
  rows.className = "compare-models";
  element.append(selectionMode, load, status, rows);
  let version = 0;
  let metadata: CompareSelectionOptions | undefined;
  let owner: ReturnType<typeof captureSession> | undefined;
  let loading = false;
  const controls: { checked: HTMLInputElement; effort: HTMLSelectElement }[] = [];
  const clear = () => {
    version++; metadata = undefined; owner = undefined; loading = false;
    controls.length = 0; rows.replaceChildren(); load.disabled = false;
    status.textContent = t("chat.modelsNeeded");
  };
  const syncMode = () => {
    const selected = selectionMode.value === "selected";
    load.style.display = rows.style.display = status.style.display = selected ? "" : "none";
  };
  selectionMode.addEventListener("change", () => { clear(); syncMode(); });
  clear(); syncMode();
  load.addEventListener("click", () => { void refresh(); });
  async function refresh() {
    clear();
    const companyId = company();
    if (!companyId) { status.textContent = t("chat.companyNeeded"); return; }
    const request = version;
    const requestOwner = captureSession(cfg);
    const current = () => mounted() && request === version && company() === companyId && isCurrentSession(cfg, requestOwner);
    loading = true; load.disabled = true; status.textContent = t("chat.modelsLoading");
    try {
      const result = await listCompareSelectionOptions(cfg, companyId);
      if (!current()) return;
      metadata = result; owner = requestOwner;
      for (const model of result.selections) {
        const row = document.createElement("div"); row.className = "compare-model";
        const label = document.createElement("label");
        const checked = document.createElement("input"); checked.type = "checkbox";
        label.append(checked, document.createTextNode(`${model.provider}/${model.model}`));
        const effort = document.createElement("select"); effort.className = "company-input";
        effort.setAttribute("aria-label", t("chat.reasoningEffort", { model: `${model.provider}/${model.model}` }));
        const defaultOption = document.createElement("option");
        defaultOption.value = ""; defaultOption.textContent = t("chat.effortDefault"); effort.append(defaultOption);
        for (const value of model.reasoningEfforts) {
          const option = document.createElement("option");
          option.value = value; option.textContent = t(`chat.effort${value}`); effort.append(option);
        }
        const syncEffort = () => {
          effort.disabled = !checked.checked || !model.reasoningEfforts.length;
          if (!checked.checked) effort.value = "";
          const count = controls.filter(c => c.checked.checked).length;
          for (const control of controls) control.checked.disabled = !control.checked.checked && count >= result.maxCandidates;
        };
        controls.push({ checked, effort });
        effort.disabled = true;
        checked.addEventListener("change", syncEffort);
        row.append(label);
        // No control implies no effort support; model names never imply capability.
        if (model.reasoningEfforts.length) row.append(effort);
        rows.append(row);
      }
      status.textContent = t(result.selections.length ? "chat.chooseModels" : "chat.noModels", { n: result.maxCandidates });
    } catch {
      if (current()) status.textContent = t("chat.modelsUnavailable");
    } finally {
      if (current()) { loading = false; load.disabled = false; }
    }
  }
  function read(companyId: string): ModelSelection[] | undefined {
    if (selectionMode.value === "automatic") return undefined;
    if (loading) throw Error(t("chat.modelsLoading"));
    if (!metadata || metadata.companyId !== companyId || !owner || !isCurrentSession(cfg, owner)) throw Error(t("chat.modelsNeeded"));
    const selections: ModelSelection[] = [];
    controls.forEach((control, index) => {
      if (!control.checked.checked) return;
      const option = metadata!.selections[index];
      const effort = control.effort.value as ReasoningEffort | "";
      if (effort && !option.reasoningEfforts.includes(effort)) throw Error(t("chat.modelsNeeded"));
      selections.push({ provider: option.provider, model: option.model, ...(effort ? { reasoningEffort: effort } : {}) });
    });
    if (!selections.length || selections.length > metadata.maxCandidates) throw Error(t("chat.chooseModels", { n: metadata.maxCandidates }));
    return selections;
  }
  return { element, invalidate: clear, read };
}
