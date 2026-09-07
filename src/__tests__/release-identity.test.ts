import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("desktop release identity", () => {
  it("keeps the UI, native bundle, and local Cargo package on one version", () => {
    const version = JSON.parse(read("package.json")).version;
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(JSON.parse(read("src-tauri/tauri.conf.json")).version).toBe(version);
    for (const path of ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]) {
      const localPackage = read(path).match(/name = "braavolabs-desktop"\r?\nversion = "([^"]+)"/);
      expect(localPackage?.[1], path).toBe(version);
    }
  });
});
