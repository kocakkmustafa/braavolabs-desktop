import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { makeT } from "../i18n";
import { createPanelApi, type PanelTransport } from "../company-panel/api";
import { CompanyPanel, errorText } from "../company-panel/CompanyPanel";
import { toPanel, toTasks } from "../company-panel/map";
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

  it("renders budgets, tasks and the selected agent's conversations and task history", () => {
    const panel = toPanel({
      ...RAW_PANEL,
      company: { ...RAW_PANEL.company, monthlyBudgetUsd: 20 },
      agents: [RAW_PANEL.agents[0], { ...RAW_PANEL.agents[2], budgetUsdMonthly: 1, budgetRatio: 1.2 }],
      month: { ...RAW_PANEL.month, usd: 17, unpricedCalls: 2, budgetRatio: 0.85 },
      tasks: { open: 1, running: 0, done: 1, failed: 0, recent: [] },
    })!;
    const tasks = toTasks({ tasks: [
      { id: "tk_1", title: "Draft launch post", status: "OPEN", assignee_agent_id: "ag_1" },
      { id: "tk_2", title: "Price check", status: "DONE", assignee_agent_id: "ag_3", result: "All good", conversation_id: "cv_9" },
    ] });
    const html = render("en", {
      phase: "ready", companies: [{ id: "co_1", name: "Acme" }], companyId: "co_1", panel, tasks, selectedAgentId: "ag_3",
      agentChats: [{ id: "cv_9", title: "Weekly check", updatedAt: "2026-11-02T00:00:00Z", messageCount: 3 }],
    });
    expect(html).toContain("80% of the budget is used.");
    expect(html).toContain("2 calls on models with no known price are not counted.");
    expect(html).toContain("Budget used: spending is paused until you raise it.");
    expect(html).toContain("open 1 · running 0 · done 1 · failed 0");
    expect(html).toContain("Draft launch post");
    expect(html).toContain("Reopen");
    expect(html).toContain("Open conversation");
    expect(html).toContain("Weekly check");
    expect(html).toContain("Task history");
    expect(html).toContain("New chat");
    expect(render("tr", { phase: "ready", companies: [], companyId: "co_1", panel, tasks })).toContain("Görev ekle");
    expect(errorText(makeT("en"), { code: "budget", message: "agent budget used" })).toContain("The monthly budget is used.");
  });

  it("lets the selected agent tick skills and shows one whose folder is gone", () => {
    const panel = toPanel({ ...RAW_PANEL, agents: [{ ...RAW_PANEL.agents[0], skills: ["launch-post", "removed-one"] }] })!;
    const html = render("en", {
      phase: "ready", companies: [{ id: "co_1", name: "Acme" }], companyId: "co_1", panel, selectedAgentId: "ag_1",
      skills: [{ name: "launch-post", description: "Write launch posts", source: "user" }, { name: "code-review", description: "", source: "project" }],
    });
    expect(html).toContain("Skills");
    expect(html).toMatch(/<input type="checkbox" checked=""[^>]*\/><span class="mono">launch-post<\/span>/);
    expect(html).toMatch(/<input type="checkbox"(?![^>]*checked)[^>]*\/><span class="mono">code-review<\/span>/);
    expect(html).toContain("removed-one");
    expect(html).toContain("folder not found; untick to remove");
    const empty = render("tr", { phase: "ready", companies: [], companyId: "co_1", panel: toPanel(RAW_PANEL)!, selectedAgentId: "ag_1", skills: [] });
    expect(empty).toContain("Henüz skill yok.");
  });

  it("renders a CLI employee's card and the approval queue", () => {
    const panel = toPanel({ ...RAW_PANEL, agents: [{ ...RAW_PANEL.agents[0], id: "ag_w", name: "Gemini CLI", engine: "gemini", workdir: "/Users/me/app", approvalPolicy: "edits", provider: "ACP", model: "gemini" }] })!;
    const html = render("en", {
      phase: "ready", companies: [{ id: "co_1", name: "Acme" }], companyId: "co_1", panel, selectedAgentId: "ag_w",
      approvals: [{ id: "ap_1", agentId: "ag_w", taskId: null, title: "npm test", tool: "execute", paths: [], createdAt: null }],
    });
    expect(html).toContain("CLI employee");
    expect(html).toContain("/Users/me/app");
    expect(html).toContain("Allow edits in the folder; ask for commands");
    expect(html).not.toContain("Change model");
    expect(html).toContain("Waiting for your approval");
    expect(html).toContain("npm test");
    expect(html).toContain("Hire a CLI employee");
  });
});
