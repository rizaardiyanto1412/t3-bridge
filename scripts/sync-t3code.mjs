// Refreshes vendor/t3code from a T3 Code checkout: the protocol contracts the bridge speaks,
// plus the few shared helpers it uses for HTML renders. Run it when T3 Code changes its
// protocol, then rebuild:
//   node scripts/sync-t3code.mjs ~/Code/t3code
import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

const root = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), "..");
const source = Path.resolve(process.argv[2] ?? Path.join(root, "..", "t3code"));
const vendor = Path.join(root, "vendor", "t3code");
const SHARED_ENTRIES = ["htmlRender.ts", "toolOutput.ts"];

if (!FS.existsSync(Path.join(source, "packages", "contracts", "src", "index.ts"))) {
  throw new Error(`${source} is not a T3 Code checkout`);
}

// Contracts: everything except tests.
const contractsSrc = Path.join(source, "packages", "contracts", "src");
const contractsOut = Path.join(vendor, "contracts", "src");
FS.rmSync(contractsOut, { recursive: true, force: true });
FS.cpSync(contractsSrc, contractsOut, {
  recursive: true,
  filter: (file) => !file.endsWith(".test.ts"),
});

// Shared: only the entry files and what they import, which must stay inside shared/src.
const sharedSrc = Path.join(source, "packages", "shared", "src");
const sharedOut = Path.join(vendor, "shared", "src");
FS.rmSync(sharedOut, { recursive: true, force: true });
const queue = [...SHARED_ENTRIES];
const copied = new Set();
while (queue.length > 0) {
  const file = queue.pop();
  if (copied.has(file)) continue;
  copied.add(file);
  const text = FS.readFileSync(Path.join(sharedSrc, file), "utf8");
  for (const match of text.matchAll(/from "([^"]+)"/g)) {
    const spec = match[1];
    if (spec.startsWith(".")) {
      queue.push(Path.normalize(Path.join(Path.dirname(file), spec)).replace(/(\.ts)?$/, ".ts"));
    } else if (spec !== "@t3tools/contracts" && !spec.startsWith("effect")) {
      throw new Error(`${file} now imports ${spec}; add it to vendor/t3code/shared/package.json`);
    }
  }
  FS.mkdirSync(Path.dirname(Path.join(sharedOut, file)), { recursive: true });
  FS.copyFileSync(Path.join(sharedSrc, file), Path.join(sharedOut, file));
}

FS.copyFileSync(Path.join(source, "LICENSE"), Path.join(vendor, "LICENSE"));
// The last commit that changed the vendored packages, which also exists upstream.
const commit = ChildProcess.execFileSync(
  "git",
  ["log", "-1", "--format=%H", "--", "packages/contracts", "packages/shared"],
  { cwd: source, encoding: "utf8" },
).trim();
FS.writeFileSync(
  Path.join(vendor, "SOURCE.md"),
  `# Vendored from T3 Code\n\nCopied from https://github.com/pingdotgg/t3code at \`${commit}\` by\n\`scripts/sync-t3code.mjs\`. Do not edit these files by hand; re-run the script instead.\nT3 Code is MIT licensed; see LICENSE in this folder.\n\n- \`contracts/src\`: packages/contracts/src, without tests\n- \`shared/src\`: ${[...copied].sort().map((file) => `\`${file}\``).join(", ")} from packages/shared/src\n`,
);
console.log(`Vendored T3 Code ${commit.slice(0, 9)}: contracts + ${copied.size} shared files`);
