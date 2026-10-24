// Screenshots the real control panel (../dist/panel, from `pnpm build`) with
// mocked API data, so the video shows the SandyWP and Repile bots.
//
//   node panel-shot.mjs   -> panel.png
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "panel");
const { chromium } = createRequire(import.meta.url)("playwright");

const day = "2026-10-24";
const at = (hh, mm) => `${day}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
const entry = (id, hh, mm, text, status = "completed", subagents = 1) => ({
  id, at: at(hh, mm), user: "Riza", text, files: 0, status,
  subagents: Array.from({ length: subagents }, (_, i) => ({ id: `${id}-${i}`, title: text, status: "completed" })),
  waiting: null,
  reply: null, error: null, updatedAt: at(hh, mm),
});
const activities = {
  sandywp: [
    entry("a1", 9, 12, "Bump the plugin version"),
    entry("a2", 10, 5, "Fix the settings page layout"),
    entry("a3", 10, 41, "Review the open PRs", "completed", 3),
    entry("a4", 11, 20, "Add a changelog entry"),
    entry("a5", 13, 2, "Check the failing E2E test"),
    entry("a6", 15, 48, "Translate the onboarding strings"),
    entry("a7", 17, 30, "Signup redirects to a 404 after login", "running", 2),
  ],
  repile: [
    entry("b1", 10, 30, "Summarize yesterday's issues"),
    entry("b2", 11, 45, "Speed up the import job"),
    entry("b3", 14, 15, "Write tests for the parser"),
  ],
};
const bot = (id, name, platform, username, threadId, working) => ({
  id, name, platform, account: { username }, enabled: true, threadId, allowedUserIds: ["U1"],
  instructions: "", reminder: true, manifestVersion: 1,
  connection: { state: "connected", identity: "acme" }, lastError: null, manifestOutdated: false,
  chatLink: null,
  activity: {
    working: working ? activities[id].at(-1) : null,
    today: activities[id].length, problemsToday: 0, lastAt: activities[id].at(-1).at,
  },
});
const api = {
  "/api/status": {
    version: "0.4.1", manifestVersion: 1,
    t3: { state: "connected", label: "T3 Code" },
    bots: [
      bot("sandywp", "SandyWP", "slack", "sandywp", "t1", true),
      bot("repile", "Repile", "discord", "repile", "t2", false),
    ],
    connectLinks: ["http://100.64.0.7:47821/#token=demo"],
  },
  "/api/t3/threads": {
    projects: [{ id: "p1", title: "sandywp" }, { id: "p2", title: "repile" }],
    threads: [
      { id: "t1", title: "SandyWP", projectId: "p1", projectTitle: "sandywp", pinned: true, status: "running", model: "claude-opus-5-5", updatedAt: at(17, 30) },
      { id: "t2", title: "Repile", projectId: "p2", projectTitle: "repile", pinned: true, status: "idle", model: "claude-opus-5-5", updatedAt: at(14, 15) },
    ],
  },
  "/api/update": { supported: true, current: "0.4.1", status: null },
  "/api/logs": { entries: [] },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
await page.clock.setFixedTime(new Date(at(17, 34)));
await page.route("http://panel.local/**", (route) => {
  const url = new URL(route.request().url());
  const activity = url.pathname.match(/^\/api\/bots\/(\w+)\/activity$/);
  if (activity) return route.fulfill({ json: { entries: activities[activity[1]] ?? [] } });
  if (url.pathname.startsWith("/api/")) return route.fulfill({ json: api[url.pathname] ?? {} });
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
  return route.fulfill({ body: readFileSync(join(dist, file)), contentType: types[extname(file)] ?? "application/octet-stream" });
});
await page.goto("http://panel.local/#token=demo");
await page.waitForSelector(".bot-card");
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(500);
await page.screenshot({ path: join(here, "panel.png") });
await browser.close();
