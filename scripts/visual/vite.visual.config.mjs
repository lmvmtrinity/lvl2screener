// Vite config for the visual-verification harness.
//
// Root stays at the real web app (read-only); only the dev-server cache is
// written under scripts/visual. /api is proxied to the fixture server on 5198.
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const VISUAL_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(VISUAL_DIR, "..", "..", "apps", "web");
const require = createRequire(join(APP_DIR, "package.json"));
const reactModule = require("@vitejs/plugin-react");
const react = reactModule.default ?? reactModule;
// @tailwindcss/vite is ESM-only; resolve it from the app package and import
// the file directly instead of relying on the CommonJS require() pattern.
const tailwindModule = await import(
  pathToFileURL(require.resolve("@tailwindcss/vite")).href
);
const tailwindcss = tailwindModule.default ?? tailwindModule;

export default {
  root: APP_DIR,
  // Keep the dev-server cache outside the repository so lint/format/verify
  // tooling never scans generated dependencies.
  cacheDir: join(tmpdir(), "tsx-scanner-visual-vite-cache"),
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5199,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:5198",
    },
  },
};
