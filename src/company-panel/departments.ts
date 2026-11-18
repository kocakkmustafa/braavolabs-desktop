/**
 * Ajanları departmana göre gruplar (UI-02b). Arka uçta departman alanı yok;
 * grup yalnızca rol kimliğinden türetilen bir GÖRÜNÜM ipucudur, hiçbir yere yazılmaz.
 */
import type { AgentView } from "./map";

export type Department = "management" | "research" | "growth" | "operations" | "engineering" | "other";

export const DEPARTMENT_ORDER: readonly Department[] = ["management", "research", "growth", "operations", "engineering", "other"];

const RULES: ReadonlyArray<readonly [Department, RegExp]> = [
  ["management", /(^|[-_ ])(ceo|gm|manager|management|lead-agent)($|[-_ ])/i],
  ["engineering", /(tech|cto|engineer|dev|release|code|qa)/i],
  ["research", /(analyst|research|market|customer|voice)/i],
  ["growth", /(content|social|marketing|growth|seo)/i],
  ["operations", /(finance|ops|operation|support|legal|hr)/i],
];

export function departmentOf(agent: Pick<AgentView, "role" | "title">): Department {
  for (const [dept, re] of RULES) if (re.test(agent.role)) return dept;
  for (const [dept, re] of RULES) if (agent.title && re.test(agent.title)) return dept;
  return "other";
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
