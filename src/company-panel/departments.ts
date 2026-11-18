/**
 * Ajanları departmana göre gruplar (UI-02b). Arka uçta departman alanı yok;
 * grup yalnızca rol kimliğinden türetilen bir GÖRÜNÜM ipucudur, hiçbir yere yazılmaz.
 */
import type { AgentView } from "./map";

export type Department = "management" | "research" | "growth" | "operations" | "engineering" | "other";

export const DEPARTMENT_ORDER: readonly Department[] = ["management", "research", "growth", "operations", "engineering", "other"];

/** Kelime (tire/boşluk/altçizgi) sınırında tam eşleşme: "marketing-manager" ya da "social-media-manager" yanlış gruba düşmez. */
const RULES: ReadonlyArray<readonly [Department, ReadonlySet<string>]> = [
  ["management", new Set(["ceo", "gm", "management"])],
  ["engineering", new Set(["tech", "cto", "engineer", "engineering", "dev", "developer", "release", "code", "qa"])],
  ["research", new Set(["analyst", "research", "researcher", "market", "customer", "voice"])],
  ["growth", new Set(["content", "social", "marketing", "growth", "seo"])],
  ["operations", new Set(["finance", "ops", "operations", "support", "legal", "hr"])],
];

const tokens = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function match(text: string): Department | null {
  const words = tokens(text);
  for (const [dept, set] of RULES) if (words.some(w => set.has(w))) return dept;
  return null;
}

export function departmentOf(agent: Pick<AgentView, "role" | "title">): Department {
  return match(agent.role) ?? (agent.title ? match(agent.title) : null) ?? "other";
}

export interface DepartmentGroup { department: Department; agents: AgentView[] }

/** Boş gruplar atılır; sıra sabit, grup içi sıra korunur. */
export function groupByDepartment(agents: readonly AgentView[]): DepartmentGroup[] {
  const buckets = new Map<Department, AgentView[]>();
  for (const a of agents) {
    const d = departmentOf(a);
    const list = buckets.get(d);
    if (list) list.push(a); else buckets.set(d, [a]);
  }
  return DEPARTMENT_ORDER.filter(d => buckets.has(d)).map(d => ({ department: d, agents: buckets.get(d)! }));
}
