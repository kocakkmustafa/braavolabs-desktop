import { describe, it, expect } from "vitest";
import { changeCounts, changeSummary, toChangeViews } from "../changes";

describe("toChangeViews", () => {
  it("maps the host payload and derives the display file name", () => {
    const views = toChangeViews([
      { path: "apps/api/auth/session.ts", added: 21, removed: 6, status: "M" },
    ]);
    expect(views[0]).toMatchObject({
      path: "apps/api/auth/session.ts",
      file: "session.ts",
      added: 21,
      removed: 6,
      status: "M",
      untracked: false,
      countless: false,
    });
  });

  it("sorts by edit size, then alphabetically so polls don't jitter", () => {
    const views = toChangeViews([
      { path: "b.ts", added: 1, removed: 1, status: "M" },
      { path: "big.ts", added: 40, removed: 4, status: "M" },
      { path: "a.ts", added: 1, removed: 1, status: "M" },
    ]);
    expect(views.map((v) => v.path)).toEqual(["big.ts", "a.ts", "b.ts"]);
  });

  it("marks untracked files — git has no diff for them, so counts stay 0", () => {
    const [v] = toChangeViews([{ path: "notes/new.md", added: 0, removed: 0, status: "??" }]);
    expect(v.untracked).toBe(true);
    expect(v.countless).toBe(true);
  });

  it("keeps a deletion visible instead of looking unchanged", () => {
    const [v] = toChangeViews([{ path: "old.ts", added: 0, removed: 0, status: "D" }]);
    expect(v.status).toBe("D");
    expect(v.untracked).toBe(false);
  });

  it("drops pathless / malformed rows and non-array payloads", () => {
    expect(toChangeViews([{ added: 3 }, "junk", null, { path: "  " }])).toEqual([]);
    expect(toChangeViews({ error: "not a repo" })).toEqual([]);
  });

  it("ignores negative or non-numeric counts rather than rendering them", () => {
    const [v] = toChangeViews([{ path: "x.ts", added: -5, removed: "12", status: "M" }]);
    expect(v.added).toBe(0);
    expect(v.removed).toBe(0);
  });
});

describe("changeCounts", () => {
  it("formats real counts and falls back to a dash when git gave none", () => {
    const [tracked] = toChangeViews([{ path: "a.ts", added: 21, removed: 6, status: "M" }]);
    const [binary] = toChangeViews([{ path: "logo.png", added: 0, removed: 0, status: "M" }]);
    expect(changeCounts(tracked)).toBe("+21 −6");
    // A tracked file with no counts is a binary diff — never a fake "+0 −0".
    expect(changeCounts(binary)).toBe("—");
  });
});

describe("changeSummary", () => {
  it("totals only what git actually counted", () => {
    const views = toChangeViews([
      { path: "a.ts", added: 21, removed: 6, status: "M" },
      { path: "b.ts", added: 43, removed: 12, status: "M" },
      { path: "new.md", added: 0, removed: 0, status: "??" },
    ]);
    expect(changeSummary(views)).toEqual({ files: 3, added: 64, removed: 18 });
  });

  it("is zero-safe on an empty list", () => {
    expect(changeSummary([])).toEqual({ files: 0, added: 0, removed: 0 });
  });
});
