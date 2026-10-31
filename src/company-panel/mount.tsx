/**
 * Mount the company panel as a React root inside the framework-less shell
 * (K9: new complex screens are React islands; ui.ts stays the entry point).
 */
import { createRoot } from "react-dom/client";
import type { Translator } from "../i18n";
import { createPanelApi, type PanelTransport } from "./api";
import { CompanyPanel } from "./CompanyPanel";
import { createPanelStore } from "./store";

export interface CompanyPanelHandle {
  /** Start (load + live events) or stop (close the event stream) with the surface. */
  setActive(active: boolean): void;
  unmount(): void;
}

export function mountCompanyPanel(container: HTMLElement, deps: { t: Translator; locale: string; transport: PanelTransport }): CompanyPanelHandle {
  const store = createPanelStore(createPanelApi(deps.transport));
  const root = createRoot(container);
  root.render(<CompanyPanel t={deps.t} locale={deps.locale} store={store} />);
  return {
    setActive(active) { if (active) store.getState().start(); else store.getState().stop(); },
    unmount() { store.getState().stop(); root.unmount(); },
  };
}
