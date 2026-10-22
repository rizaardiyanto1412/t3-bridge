// Builds T3 Bridge.app and a .dmg for Apple Silicon into release/.
//   node scripts/dist.mjs            # build, then package
//   node scripts/dist.mjs --no-build # package what is already built
import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

import { Arch, Platform, build } from "electron-builder";

const root = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(FS.readFileSync(Path.join(root, "package.json"), "utf8"));
const run = (command, args) =>
  ChildProcess.execFileSync(command, args, { cwd: root, stdio: "inherit" });

if (!process.argv.includes("--no-build")) {
  run("pnpm", ["exec", "tsdown"]);
  run("pnpm", ["exec", "vite", "build", "--config", "vite.renderer.config.ts"]);
}

// Everything the app needs is bundled, so the packaged app gets a dependency-free package.json.
const staging = Path.join(root, "build", "app");
FS.rmSync(staging, { recursive: true, force: true });
FS.mkdirSync(staging, { recursive: true });
for (const dir of ["dist-electron", "dist-renderer"]) {
  FS.cpSync(Path.join(root, dir), Path.join(staging, dir), {
    recursive: true,
    filter: (source) => !source.endsWith(".map"),
  });
}
FS.writeFileSync(
  Path.join(staging, "package.json"),
  JSON.stringify(
    {
      name: "t3-bridge",
      productName: "T3 Bridge",
      version: pkg.version,
      description: pkg.description,
      main: "dist-electron/main.cjs",
      author: "T3 Bridge",
    },
    null,
    2,
  ),
);

const electronVersion = JSON.parse(
  FS.readFileSync(Path.join(root, "node_modules", "electron", "package.json"), "utf8"),
).version;

await build({
  targets: Platform.MAC.createTarget(["dmg", "dir"], Arch.arm64),
  config: {
    appId: "codes.t3.bridge",
    productName: "T3 Bridge",
    electronVersion,
    electronDist: Path.join(root, "node_modules", "electron", "dist"),
    directories: {
      app: staging,
      output: Path.join(root, "release"),
      buildResources: Path.join(root, "resources"),
    },
    // The bundles carry every dependency; keep electron-builder from copying node_modules in too.
    files: ["dist-electron/**", "dist-renderer/**", "package.json", "!**/node_modules/**"],
    asar: true,
    npmRebuild: false,
    mac: {
      icon: Path.join(root, "resources", "icon.png"),
      category: "public.app-category.developer-tools",
      // Ad-hoc signature: Apple Silicon refuses to run unsigned code. Without a Developer ID the
      // first launch on another Mac needs right-click → Open.
      identity: "-",
      hardenedRuntime: false,
      notarize: false,
      extendInfo: {
        NSAppTransportSecurity: { NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true },
      },
    },
    dmg: { title: "T3 Bridge", writeUpdateInfo: false },
    publish: null,
  },
});
console.log(`\nBuilt into ${Path.join(root, "release")}`);
