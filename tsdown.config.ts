import { defineConfig } from "tsdown";

// The main process bundles every dependency, the vendored T3 Code sources included (they ship
// as TypeScript), and keeps only Electron external, so the packaged app needs no node_modules.
const external = (id: string) => id === "electron" || id.startsWith("electron/");

const bundle = (entry: string, clean: boolean) => ({
  format: "cjs" as const,
  outDir: "dist-electron",
  dts: false,
  sourcemap: true,
  outExtensions: () => ({ js: ".cjs" }),
  outputOptions: { codeSplitting: false },
  entry: [entry],
  clean,
  platform: "node" as const,
  deps: {
    alwaysBundle: (id: string) => !id.startsWith("node:") && !external(id),
    neverBundle: external,
    onlyBundle: false as const,
  },
});

export default defineConfig([
  bundle("src/main/main.ts", true),
  bundle("src/main/preload.ts", false),
  bundle("src/engine/cli.ts", false),
]);
