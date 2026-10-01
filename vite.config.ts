import { defineConfig } from "vitest/config";

// Vite config scoped ENTIRELY to packages/desktop — it builds the Tauri
// webview frontend into ./dist (consumed by src-tauri/tauri.conf.json's
// `build.frontendDist = "../dist"`) and hosts the vitest node suite for the
// pure-function API client / render layer. No dev-server assumptions leak to
// the monorepo root: `clearScreen:false` + a fixed port only matter under
// `cargo tauri dev` (a human gate), never in CI.
/**
 * Dev-only CSP genişletmesi.
 *
 * `index.html` içindeki <meta> CSP üretimde ETKİN kalmalı, ama geliştirmede
 * yerel API motoruna (localhost:8080) bağlanmayı engelliyor. Tauri'nin
 * `devCsp` ayarı bu etiketi ETKİSİZ KILMAZ: iki CSP birlikte uygulanır ve
 * tarayıcı KESİŞİMİ zorlar — yani en dar olan kazanır. Bu yüzden gevşetmenin
 * meta etiketinin kendisinde yapılması gerekir.
 *
 * `apply: "serve"` → yalnız `vite`/`tauri dev`; `vite build` çıktısına
 * dokunmaz, dolayısıyla yayınlanan pakette üretim politikası aynen kalır.
 */
const LOCAL_HOSTS =
  "http://localhost:8080 http://localhost:5183 ws://localhost:5183 http://localhost:11434";

/**
 * `BRAAVOLABS_LOCAL_API=1 pnpm tauri build` → yerel motora bağlanabilen bir
 * masaüstü paketi üretir. Bayrak verilmezse `vite build` çıktısı AYNEN üretim
 * politikasını taşır; yani yayınlanan paket bu genişletmeden etkilenmez.
 * Yalnız kurucunun kendi makinesinde holding motorunu uygulama üzerinden
 * kullanabilmesi için vardır (bkz. DEFTER BR-020).
 */
const LOCAL_BUILD = process.env.BRAAVOLABS_LOCAL_API === "1";

const devCspPlugin = {
  name: "dev-csp-relax",
  apply: LOCAL_BUILD ? undefined : ("serve" as const),
  transformIndexHtml(html: string) {
    return html.replace(/(connect-src [^;"]*)/, `$1 ${LOCAL_HOSTS}`);
  },
};

export default defineConfig({
  root: ".",
  clearScreen: false,
  plugins: [devCspPlugin],
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
