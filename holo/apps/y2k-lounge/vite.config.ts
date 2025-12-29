import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const packageEntry = (pkg: string, entry = "src/index.ts") =>
  fileURLToPath(new URL(`../../packages/${pkg}/${entry}`, import.meta.url));
const packageAsset = (pkg: string, asset: string) =>
  fileURLToPath(new URL(`../../packages/${pkg}/${asset}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@holo/ui-kit/styles.css", replacement: packageAsset("ui-kit", "styles.css") },
      { find: "@holo/ui-kit", replacement: packageEntry("ui-kit", "src/index.tsx") },
      { find: "@holo/sdk", replacement: packageEntry("sdk-js") },
      { find: "@holo/shared-spec", replacement: packageEntry("shared-spec") },
      { find: "@holo/viewer-three", replacement: packageEntry("viewer-three") },
      { find: "@holo/visualizer-three", replacement: packageEntry("visualizer-three") },
    ],
  },
  server: {
    port: 5174,
    fs: {
      allow: [repoRoot],
    },
  },
});
