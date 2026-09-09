import { readFileSync } from "node:fs";
import { afterEach, describe, it, expect, vi } from "vitest";
import { detectLocale, makeT } from "../i18n";

describe("desktop bundle locale declaration", () => {
  it("declares only English development language and EN/TR support", () => {
    const plist = readFileSync(
      new URL("../../src-tauri/Info.plist", import.meta.url),
      "utf8",
    ).trim();

    // This deliberately narrow contract is not a general-purpose XML parser.
    // Native artifact verification separately parses the generated plist.
    const expectedElements = [
      '<\\?xml version="1\\.0" encoding="UTF-8"\\?>',
      '<plist version="1\\.0">',
      "<dict>",
      "<key>CFBundleDevelopmentRegion</key>",
      "<string>en</string>",
      "<key>CFBundleLocalizations</key>",
      "<array>",
      "<string>en</string>",
      "<string>tr</string>",
      "</array>",
      "</dict>",
      "</plist>",
    ];
    expect(plist).toMatch(new RegExp(`^${expectedElements.join("\\s*")}$`));
  });
});

describe("desktop locale detection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["tr", "tr"],
    ["tr-TR", "tr"],
    ["TR-tr", "tr"],
    ["en", "en"],
    ["en-US", "en"],
    ["de-DE", "en"],
    ["", "en"],
    [undefined, "en"],
  ])("maps navigator.language %s to %s", (language, expected) => {
    vi.stubGlobal("navigator", { language });
    expect(detectLocale()).toBe(expected);
  });

  it("falls back to English when navigator is absent", () => {
    vi.stubGlobal("navigator", undefined);
    expect(detectLocale()).toBe("en");
  });
});

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
    expect(t("app.name")).toBe("Braavolabs");
    // wholly unknown key → returns the key (visible-but-safe, never throws)
    expect(t("nope.missing")).toBe("nope.missing");
  });
});
