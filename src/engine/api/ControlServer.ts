import * as Crypto from "node:crypto";
import * as FS from "node:fs/promises";
import * as Http from "node:http";
import * as OS from "node:os";
import * as Path from "node:path";

import { slackManifest } from "../adapters/slack/manifest.ts";
import { testSlackTokens } from "../adapters/slack/SlackAdapter.ts";
import { DEFAULT_INSTRUCTIONS } from "../core/render.ts";
import { NotFoundError, type BotInput, type Engine } from "../Engine.ts";
import type { Updater } from "../updater.ts";
import { BRIDGE_VERSION } from "../version.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Tailscale hands out addresses in 100.64.0.0/10; the control panel listens there and on loopback only. */
export function tailnetAddresses(): string[] {
  return Object.values(OS.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address)
    .filter((address) => {
      const [first, second] = address.split(".").map(Number);
      return first === 100 && second !== undefined && second >= 64 && second <= 127;
    });
}

export interface ControlServerOptions {
  readonly engine: Engine;
  /** The built control panel, served at / so any browser on the tailnet can use it too. */
  readonly staticDir: string | null;
  readonly updater: Updater | null;
}

/**
 * The control panel's API, used by the panel in a browser on this Mac or another device on
 * the tailnet; every /api call needs the bridge's control token.
 */
export class ControlServer {
  private readonly servers: Http.Server[] = [];
  hosts: string[] = [];

  private readonly options: ControlServerOptions;

  constructor(options: ControlServerOptions) {
    this.options = options;
  }

  async start(port: number): Promise<void> {
    const hosts = ["127.0.0.1", ...tailnetAddresses()];
    for (const host of hosts) {
      const server = Http.createServer((request, response) => {
        void this.handle(request, response);
      });
      await new Promise<void>((resolve) => {
        server.once("error", (error) => {
          this.options.engine.log.warn(`Control panel could not listen on ${host}:${port}`, error);
          resolve();
        });
        server.listen(port, host, () => {
          this.servers.push(server);
          this.hosts.push(host);
          resolve();
        });
      });
    }
    this.options.engine.log.info(
      `Control panel on ${this.hosts.map((host) => `http://${host}:${port}`).join(", ")}`,
    );
  }

  async stop() {
    await Promise.all(
      this.servers.map((server) => new Promise((resolve) => server.close(resolve))),
    );
  }

  /** Links that open the panel from another device on the tailnet. */
  connectLinks(): string[] {
    const { controlPort, controlToken } = this.options.engine.config.get();
    return this.hosts
      .filter((host) => host !== "127.0.0.1")
      .map((host) => `http://${host}:${controlPort}/#token=${controlToken}`);
  }

  private async handle(request: Http.IncomingMessage, response: Http.ServerResponse) {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "authorization, content-type");
    response.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
    if (request.method === "OPTIONS") return void response.writeHead(204).end();
    const url = new URL(request.url ?? "/", "http://bridge.local");
    try {
      if (url.pathname.startsWith("/api/")) {
        this.authorize(request);
        const body = request.method === "GET" ? null : await readBody(request);
        const result = await this.route(request.method ?? "GET", url, body);
        sendJson(response, 200, result ?? { ok: true });
        return;
      }
      return await this.serveFile(
        response,
        this.options.staticDir,
        url.pathname === "/" ? "index.html" : url.pathname.slice(1),
      );
    } catch (error) {
      const status =
        error instanceof HttpError ? error.status : error instanceof NotFoundError ? 404 : 500;
      const message = error instanceof Error ? error.message : String(error);
      if (status === 500)
        this.options.engine.log.warn(`Control API ${request.method} ${url.pathname}`, error);
      sendJson(response, status, { error: message });
    }
  }

  private authorize(request: Http.IncomingMessage) {
    const expected = Buffer.from(`Bearer ${this.options.engine.config.get().controlToken}`);
    const provided = Buffer.from(request.headers.authorization ?? "");
    if (provided.length !== expected.length || !Crypto.timingSafeEqual(provided, expected)) {
      throw new HttpError(
        401,
        "This T3 Bridge link is not valid any more. Get the current one with `npx t3-bridge link`.",
      );
    }
  }

  private async route(method: string, url: URL, body: unknown): Promise<unknown> {
    const engine = this.options.engine;
    const path = url.pathname;
    if (method === "GET" && path === "/api/status")
      return { ...engine.status(), connectLinks: this.connectLinks() };
    if (path.startsWith("/api/update")) return this.routeUpdate(method, path);
    if (method === "GET" && path === "/api/logs")
      return { entries: engine.log.entries().slice(-200) };
    if (method === "GET" && path === "/api/defaults") return { instructions: DEFAULT_INSTRUCTIONS };
    if (method === "GET" && path === "/api/t3/threads") return engine.listThreads();
    if (method === "GET" && path === "/api/t3/models")
      return { models: await engine.modelChoices(requireParam(url, "projectId")) };
    if (method === "POST" && path === "/api/t3/threads")
      return engine.createOrchestratorThread(body as never);
    if (method === "GET" && path === "/api/slack/manifest")
      return slackManifest(url.searchParams.get("name") ?? "T3 Bridge");
    if (method === "POST" && path === "/api/slack/test") return testSlackTokens(body as never);
    if (method === "POST" && path === "/api/bots") return engine.addBot(body as BotInput);
    if (method === "POST" && path === "/api/control/rotate") {
      const token = await engine.rotateControlToken();
      return { token, connectLinks: this.connectLinks() };
    }
    const freshMatch = /^\/api\/bots\/([\w-]+)\/new-thread$/.exec(path);
    if (method === "POST" && freshMatch !== null) return engine.startFreshThread(freshMatch[1]!);
    const botMatch = /^\/api\/bots\/([\w-]+)$/.exec(path);
    if (botMatch !== null) {
      if (method === "PATCH") return engine.updateBot(botMatch[1]!, body as Partial<BotInput>);
      if (method === "DELETE") return engine.removeBot(botMatch[1]!);
    }
    throw new HttpError(404, `No route ${method} ${path}`);
  }

  private async routeUpdate(method: string, path: string): Promise<unknown> {
    const updater = this.options.updater;
    if (method === "GET" && path === "/api/update") {
      return { supported: updater !== null, current: BRIDGE_VERSION, status: (await updater?.status()) ?? null };
    }
    if (updater === null) throw new HttpError(400, "This T3 Bridge cannot update itself.");
    if (method === "POST" && path === "/api/update/check") return updater.check();
    if (method === "POST" && path === "/api/update/start") {
      await updater.start();
      this.options.engine.log.info("Update started from the control panel");
      return { started: true };
    }
    throw new HttpError(404, `No route ${method} ${path}`);
  }

  private async serveFile(response: Http.ServerResponse, root: string | null, relative: string) {
    if (root === null) throw new HttpError(404, "Not found");
    const file = Path.resolve(root, decodeURIComponent(relative));
    if (!file.startsWith(Path.resolve(root) + Path.sep)) throw new HttpError(404, "Not found");
    let data: Buffer;
    try {
      data = await FS.readFile(file);
    } catch {
      // Unknown paths fall back to the app shell; real asset misses stay 404.
      if (Path.extname(relative) !== "") throw new HttpError(404, "Not found");
      data = await FS.readFile(Path.join(root, "index.html"));
    }
    response.writeHead(200, {
      "content-type": MIME[Path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    response.end(data);
  }
}

function requireParam(url: URL, name: string) {
  const value = url.searchParams.get(name);
  if (!value) throw new HttpError(400, `Missing ${name}`);
  return value;
}

async function readBody(request: Http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) throw new HttpError(413, "Request too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function sendJson(response: Http.ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}
