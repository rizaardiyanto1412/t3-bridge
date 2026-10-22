import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Relative asset paths let the same build load from file:// in Electron and from the worker's HTTP server.
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  build: { outDir: "../../dist-renderer", emptyOutDir: true, target: "es2022" },
});
