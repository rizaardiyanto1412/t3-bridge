import * as FS from "node:fs";
import * as Path from "node:path";

import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, shell, Tray } from "electron";

import { ControlServer } from "../engine/api/ControlServer.ts";
import { Engine } from "../engine/Engine.ts";
import { FileSecretStore } from "../engine/store.ts";
import { renderHtmlToPng } from "./htmlSnapshot.ts";
import { trayIcon } from "./trayIcon.ts";

// Started by launchd on a headless Mac, the bridge runs with no window until someone opens one.
const hidden = process.argv.includes("--hidden");

app.setName("T3 Bridge");
if (!app.requestSingleInstanceLock()) app.quit();

let engine: Engine | null = null;
let server: ControlServer | null = null;
let tray: Tray | null = null;
let window: BrowserWindow | null = null;

const dataDir = app.getPath("userData");
const rendererDir = Path.join(__dirname, "..", "dist-renderer");
const downloadsDir = Path.join(dataDir, "downloads");

function logSink() {
  const file = Path.join(dataDir, "bridge.log");
  return (line: string) => {
    console.log(line);
    try {
      FS.appendFileSync(file, `${line}\n`);
      if (FS.statSync(file).size > 5 * 1024 * 1024) FS.renameSync(file, `${file}.1`);
    } catch {
      // Logging must never take the bridge down.
    }
  };
}

async function startEngine() {
  FS.mkdirSync(downloadsDir, { recursive: true });
  // Tokens are kept in a file only this user can read, like T3's own secrets. The macOS
  // keychain would be stronger, but it can raise permission prompts that nobody sees on a
  // headless Mac and would stall the bridge.
  engine = new Engine({
    dataDir,
    secrets: new FileSecretStore(Path.join(dataDir, "secrets.json"), null),
    renderHtmlToPng,
    logSink: logSink(),
    ...(process.env.T3_BRIDGE_T3_URL
      ? { t3Defaults: { httpBaseUrl: process.env.T3_BRIDGE_T3_URL } }
      : {}),
  });
  const config = await engine.start();
  server = new ControlServer({ engine, staticDir: rendererDir, downloadsDir });
  await server.start(config.controlPort);
}

interface RemoteWorker {
  readonly baseUrl: string;
  readonly token: string;
  /** Whether the window shows the worker rather than this Mac. */
  readonly selected: boolean;
}

const remoteFile = Path.join(dataDir, "remote-worker.json");

function readRemote(): RemoteWorker | null {
  try {
    return JSON.parse(FS.readFileSync(remoteFile, "utf8")) as RemoteWorker;
  } catch {
    return null;
  }
}

function writeRemote(remote: RemoteWorker) {
  FS.writeFileSync(remoteFile, JSON.stringify(remote), { mode: 0o600 });
}

/**
 * Shows this Mac's panel, or the worker's own panel loaded from the worker. Loading it from
 * the worker means a worker update reaches this Mac without reinstalling the app here. If
 * the worker cannot be reached, the local panel shows instead and says so.
 */
function showPanel(target: BrowserWindow) {
  const remote = readRemote();
  if (remote?.selected) {
    target.webContents.once("did-fail-load", (_event, _code, description, url) => {
      if (!url.startsWith(remote.baseUrl)) return;
      void target.loadFile(Path.join(rendererDir, "index.html"), {
        query: { workerError: `${new URL(remote.baseUrl).hostname}: ${description}` },
      });
    });
    void target.loadURL(`${remote.baseUrl}/#token=${encodeURIComponent(remote.token)}`);
    return;
  }
  void target.loadFile(Path.join(rendererDir, "index.html"));
}

function openWindow() {
  if (window !== null && !window.isDestroyed()) {
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    title: "T3 Bridge",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#16161a",
    webPreferences: {
      preload: Path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  showPanel(window);
  if (process.platform === "darwin") void app.dock?.show();
  window.on("closed", () => {
    window = null;
    if (process.platform === "darwin") app.dock?.hide();
  });
}

function refreshTray() {
  if (tray === null || engine === null) return;
  const status = engine.status();
  const links = server?.connectLinks() ?? [];
  const loginItem = app.getLoginItemSettings().openAtLogin;
  const t3Line =
    status.t3.state === "connected"
      ? `T3: ${status.t3.label}`
      : `T3: ${status.t3.state === "connecting" ? "connecting…" : "not connected"}`;
  tray.setToolTip(`T3 Bridge · ${t3Line}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open T3 Bridge", click: openWindow },
      { type: "separator" },
      { label: t3Line, enabled: false },
      ...status.bots.map((bot) => ({
        label: `${bot.connection.state === "connected" ? "●" : "○"} ${bot.name}`,
        enabled: false,
      })),
      { type: "separator" },
      {
        label: "Copy link for another Mac",
        enabled: links.length > 0,
        click: () => clipboard.writeText(links[0] ?? ""),
      },
      {
        label: "Open at login",
        type: "checkbox",
        checked: loginItem,
        click: () => app.setLoginItemSettings({ openAtLogin: !loginItem, args: ["--hidden"] }),
      },
      { type: "separator" },
      { label: "Quit T3 Bridge", role: "quit" },
    ]),
  );
}

// The local panel may read this Mac's engine token; a page loaded from a worker may not.
ipcMain.handle("bridge:local", (event) => {
  if (!event.senderFrame?.url.startsWith("file:")) return null;
  const config = engine?.config.get();
  return config
    ? { baseUrl: `http://127.0.0.1:${config.controlPort}`, token: config.controlToken }
    : null;
});
ipcMain.handle("bridge:remote:get", () => {
  const remote = readRemote();
  return remote === null
    ? null
    : { baseUrl: remote.baseUrl, label: new URL(remote.baseUrl).hostname };
});
ipcMain.handle("bridge:remote:connect", (_event, target: { baseUrl: string; token: string }) => {
  writeRemote({ baseUrl: target.baseUrl, token: target.token, selected: true });
  if (window !== null) showPanel(window);
});
ipcMain.handle("bridge:remote:select", (_event, selected: boolean) => {
  const remote = readRemote();
  if (remote !== null) writeRemote({ ...remote, selected });
  if (window !== null) showPanel(window);
});
ipcMain.handle("bridge:remote:forget", () => {
  FS.rmSync(remoteFile, { force: true });
  if (window !== null) showPanel(window);
});
ipcMain.handle("bridge:remote:token", (event, token: string) => {
  const remote = readRemote();
  if (remote !== null && event.senderFrame?.url.startsWith(remote.baseUrl))
    writeRemote({ ...remote, token });
});

// launchd stops the worker with SIGTERM; quit normally so bot state is saved first.
process.on("SIGTERM", () => app.quit());

app.on("second-instance", openWindow);
app.on("activate", openWindow);
// Closing the window keeps the bridge running in the menu bar.
app.on("window-all-closed", () => {});
let quitting = false;
// Saving bot state is async; hold the quit until it is on disk so nothing is posted twice.
app.on("before-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  void Promise.allSettled([server?.stop(), engine?.stop()]).then(() => app.exit(0));
});

void app.whenReady().then(async () => {
  if (process.platform === "darwin" && hidden) app.dock?.hide();
  const icon = nativeImage.createFromBitmap(trayIcon.bitmap, {
    width: trayIcon.size,
    height: trayIcon.size,
    scaleFactor: 2,
  });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  try {
    await startEngine();
  } catch (error) {
    console.error("T3 Bridge failed to start", error);
  }
  refreshTray();
  setInterval(refreshTray, 5000);
  if (!hidden) openWindow();
});
