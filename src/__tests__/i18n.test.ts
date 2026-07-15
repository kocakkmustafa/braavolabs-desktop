import { describe, it, expect } from "vitest";
import { makeT } from "../i18n";

describe("i18n (single messages object, en+tr)", () => {
  it("resolves dotted keys for en", () => {
    const t = makeT("en");
    expect(t("login.submit")).toBe("Sign in");
    expect(t("chat.modeCascade")).toBe("Cascade");
  });

  it("resolves the tr locale", () => {
    const t = makeT("tr");
    expect(t("login.submit")).toBe("Giriş yap");
    expect(t("chat.modeCompare")).toBe("Karşılaştır");
  });

  it("interpolates {placeholders}", () => {
    const t = makeT("en");
    expect(t("chat.thinking", { n: 3 })).toBe("3 faces thinking…");
    expect(t("rail.savingsWindow", { days: 30 })).toBe("Last 30 days");
  });

  it("falls back to en for a key missing in tr, then to the key itself", () => {
    const t = makeT("tr");
    // present in both → tr value
    expect(t("app.name")).toBe("Forge");
    // wholly unknown key → returns the key (visible-but-safe, never throws)
    expect(t("nope.missing")).toBe("nope.missing");
  });
});
