import { defineConfig } from "vitest/config";

// Vite config scoped ENTIRELY to packages/desktop — it builds the Tauri
// webview frontend into ./dist (consumed by src-tauri/tauri.conf.json's
// `build.frontendDist = "../dist"`) and hosts the vitest node suite for the
// pure-function API client / render layer. No dev-server assumptions leak to
// the monorepo root: `clearScreen:false` + a fixed port only matter under
// `cargo tauri dev` (a human gate), never in CI.
export default defineConfig({
  root: ".",
  clearScreen: false,
  server: { port: 5183, strictPort: true },
  build: {
    // Tauri v2 targets a modern WebView2 / WKWebView — no legacy transpile.
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  test: {
    // The tested modules (client/render/store) are pure — no DOM needed, so
    // the fast node environment keeps CI light (memory rule: scripted checks,
    // no LLM-in-the-loop).
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
  },
});
