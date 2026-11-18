import { describe, expect, it } from "vitest";
import { departmentOf, groupByDepartment } from "../company-panel/departments";
import type { AgentView } from "../company-panel/map";

const a = (role: string, title: string | null = null) => ({ role, title }) as AgentView;

describe("departman grupları", () => {
  it("rol kimliğinden departman türetir", () => {
    expect(departmentOf(a("ceo"))).toBe("management");
    expect(departmentOf(a("market-analyst"))).toBe("research");
    expect(departmentOf(a("content-social"))).toBe("growth");
    expect(departmentOf(a("finance-tracker"))).toBe("operations");
    expect(departmentOf(a("tech-lead"))).toBe("engineering");
    expect(departmentOf(a("release-tracker"))).toBe("engineering");
    expect(departmentOf(a("mystery"))).toBe("other");
    expect(departmentOf(a("social-media-manager"))).toBe("growth");
    expect(departmentOf(a("marketing-manager"))).toBe("growth");
    expect(departmentOf(a("devops-lead"))).toBe("other"); // alt dizgi değil, kelime eşleşir
    expect(departmentOf(a("x", "management"))).toBe("management");
  });
  it("boş grupları atar, sırayı korur", () => {
    const groups = groupByDepartment([a("tech-lead"), a("ceo"), a("cto")]);
    expect(groups.map(g => g.department)).toEqual(["management", "engineering"]);
    expect(groups[1].agents).toHaveLength(2);
  });
});
