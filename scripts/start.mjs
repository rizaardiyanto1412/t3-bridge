// Runs the app from source; run `pnpm build` first.
import * as ChildProcess from "node:child_process";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

const root = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = ChildProcess.spawn(
  Path.join(root, "node_modules", ".bin", "electron"),
  [root, ...process.argv.slice(2)],
  {
    cwd: root,
    env,
    stdio: "inherit",
  },
);
child.on("exit", (code) => process.exit(code ?? 0));
