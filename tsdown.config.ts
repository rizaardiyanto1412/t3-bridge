import { defineConfig } from "tsdown";

// One file with every dependency inlined, the vendored T3 Code sources included (they ship as
// TypeScript), so `npx t3-bridge` installs nothing but this package.
export default defineConfig({
  entry: ["src/cli.ts"],
  format: "cjs",
  outDir: "dist",
  dts: false,
  sourcemap: true,
  clean: true,
  outExtensions: () => ({ js: ".cjs" }),
  outputOptions: { banner: "#!/usr/bin/env node" },
  platform: "node",
  deps: {
    alwaysBundle: (id: string) => !id.startsWith("node:"),
    onlyBundle: false,
  },
});
