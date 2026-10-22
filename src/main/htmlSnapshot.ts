import { BrowserWindow } from "electron";

const RENDER_TIMEOUT_MS = 15_000;

/**
 * Chat apps cannot show HTML, so an agent's html_render becomes a screenshot. The page is
 * drawn in a hidden, sandboxed window and captured at the reply column's width. A page that
 * never finishes loading is abandoned so it cannot hold up the bot's other posts.
 */
export async function renderHtmlToPng(
  html: string,
  width: number,
  height: number,
): Promise<Buffer> {
  const window = new BrowserWindow({
    show: false,
    width,
    height: Math.max(200, Math.min(height, 4000)),
    paintWhenInitiallyHidden: true,
    backgroundColor: "#ffffff",
    webPreferences: { sandbox: true, contextIsolation: true, javascript: true, offscreen: true },
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("HTML render timed out")), RENDER_TIMEOUT_MS);
  });
  try {
    return await Promise.race([capture(window, html, width, height), timeout]);
  } finally {
    clearTimeout(timer);
    if (!window.isDestroyed()) window.destroy();
  }
}

async function capture(window: BrowserWindow, html: string, width: number, height: number) {
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  // Charts and fonts settle shortly after load.
  await new Promise((resolve) => setTimeout(resolve, 800));
  const contentHeight = (await window.webContents.executeJavaScript(
    "Math.ceil(document.documentElement.scrollHeight)",
  )) as number;
  const finalHeight = Math.max(120, Math.min(contentHeight || height, 4000));
  window.setContentSize(width, finalHeight);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const image = await window.webContents.capturePage({ x: 0, y: 0, width, height: finalHeight });
  return image.toPNG();
}
