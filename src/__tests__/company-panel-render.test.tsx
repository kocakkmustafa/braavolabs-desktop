import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { makeT } from "../i18n";
import { createPanelApi, type PanelTransport } from "../company-panel/api";
import { CompanyPanel, errorText } from "../company-panel/CompanyPanel";
import { toPanel } from "../company-panel/map";
import { createPanelStore, type PanelData } from "../company-panel/store";
import { RAW_PANEL } from "./company-panel-fixture";

const idle: PanelTransport = {
  request: async () => ({ status: 200, body: {} }),
  events: () => ({ done: new Promise(() => {}), close: async () => {} }),
  findings: async () => ({ text: "", truncated: false }),
};

function render(locale: "en" | "tr", state: Partial<PanelData>) {
  const store = createPanelStore(createPanelApi(idle), { initial: state });
  return renderToStaticMarkup(<CompanyPanel t={makeT(locale)} locale={locale} store={store} />);
}

describe("company panel screen (server-rendered smoke)", () => {
  it("renders the org chart, routines, findings and activity", () => {
    const panel = toPanel(RAW_PANEL)!;
    const html = render("en", {
      phase: "ready", companies: [{ id: "co_1", name: "Acme" }], companyId: "co_1", panel, live: true,
      findings: { text: "## Prices\n- **X** cut to `$39`\n<script>alert(1)</script>", truncated: true },
    });
    expect(html).toContain("Acme");
    expect(html).toContain("Genel Müdür");
    expect(html).toContain("ANTHROPIC/claude-x");
    // K3: the error agent shows "setup needed", never its placeholder model.
    expect(html).toContain("setup needed");
    expect(html).not.toContain("placeholder-model");
    expect(html).toContain("Rakipleri izle");
    expect(html).toContain("Run now");
    expect(html).toContain("hired-templates");
    expect(html).toContain("Showing the most recent part");
    expect(html).toContain("<strong>X</strong>");
    // Untrusted findings text is escaped, never injected.
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders the agent card with the setup hint and model picker for an agent that needs setup", () => {
    const panel = toPanel(RAW_PANEL)!;
    const html = render("en", {
      phase: "ready", companyId: "co_1", panel, selectedAgentId: "ag_2",
      models: { providers: [], local: { OLLAMA: ["qwen3:8b"] }, suggestions: {} },
      agentError: { ag_2: { code: "invalid", message: "unknown provider" } },
    });
    expect(html).toContain("braavo keys add &lt;provider&gt;");
    expect(html).toContain("braavo models pull qwen3:8b");
    expect(html).toContain("braavo setup");
    expect(html).toContain("OLLAMA/qwen3:8b");
    expect(html).toContain("Change model");
    expect(html).toContain("unknown provider");
    expect(html).toContain("Pause");
  });

  it("renders the create form and hire wizard in Turkish when there is no company", () => {
    const html = render("tr", { phase: "no-company" });
    expect(html).toContain("Şirketinizi kurun");
    expect(html).toContain("Pazar Analisti");
    expect(html).toContain("Sürüm ve Bağımlılık Takipçisi");
    expect(html).toContain("İzlenecek rakip sayfaları");
    expect(html).toContain("Oluştur ve işe al");
  });

  it("renders the hire result with needsSetup hints and needsUrls", () => {
    const html = render("en", {
      phase: "ready", companyId: "co_1", panel: toPanel(RAW_PANEL)!,
      hireResult: {
        hired: [], routineCount: 1, skipped: ["ceo"],
        needsSetup: [{ agentId: "ag_1", agentName: "General Manager", reason: "setup-required", provider: null }, { agentId: "ag_5", agentName: "Content", reason: "model-required", provider: "OPENAI" }],
        needsUrls: ["release-tracker/watch-releases"],
      },
    });
    expect(html).toContain("Waiting for a key or a local model");
    expect(html).toContain("choose a model for OPENAI on its card");
    expect(html).toContain("Already staffed, skipped: General Manager");
    expect(html).toContain("Routines waiting for URLs");
  });

  it("renders the offline state with the start command", () => {
    const html = render("en", { phase: "offline", error: { code: "not-running", message: "daemon-not-running" } });
    expect(html).toContain("Local daemon is not running");
    expect(html).toContain("braavo daemon start");
    expect(errorText(makeT("en"), { code: "not-running", message: "daemon-not-running" })).toBe("The local daemon is not running.");
    expect(errorText(makeT("en"), { code: "invalid", message: "bad" })).toBe("The daemon rejected the input. (bad)");
  });
});
