import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = fileURLToPath(new URL(".", import.meta.url));
const publicDirectory = join(rootDirectory, "public");
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4173);
const accessToken = randomBytes(24).toString("hex");
const appServerCommand = process.env.APP_SERVER_COMMAND ?? "codex";
const appServerArguments = process.env.APP_SERVER_ARGS
  ? JSON.parse(process.env.APP_SERVER_ARGS)
  : ["app-server"];
const appServerUrl = process.env.APP_SERVER_URL;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

class AppServerClient {
  constructor(command, args, remoteUrl) {
    this.command = command;
    this.args = args;
    this.remoteUrl = remoteUrl;
    this.process = null;
    this.socket = null;
    this.buffer = "";
    this.nextRequestId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.status = "disconnected";
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  async connect() {
    if (this.process || this.socket) return;

    this.status = "connecting";
    this.emit({ type: "connection", status: this.status });
    if (this.remoteUrl) await this.connectWebSocket();
    else this.connectStdio();

    try {
      await this.request("initialize", {
        clientInfo: { name: "t-vis", version: "0.1.0" },
        capabilities: {}
      });
      this.notify("initialized", {});
      this.status = "connected";
      this.emit({ type: "connection", status: this.status });
    } catch (error) {
      this.disconnect(error.message);
      throw error;
    }
  }

  connectStdio() {
    this.process = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => this.consume(chunk));
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (message) =>
      this.emit({ type: "diagnostic", message: message.trim() })
    );
    this.process.once("error", (error) => this.disconnect(error.message));
    this.process.once("exit", (code) =>
      this.disconnect(`App Server exited with code ${code ?? "unknown"}.`)
    );
  }

  connectWebSocket() {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.remoteUrl);
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error(`Unable to connect to ${this.remoteUrl}.`)), { once: true });
      this.socket.addEventListener("message", (event) => this.consume(`${event.data}\n`));
      this.socket.addEventListener("close", () => this.disconnect("App Server WebSocket closed."));
    });
  }

  disconnect(message = "Disconnected.") {
    if (!this.process && !this.socket && this.status === "disconnected") return;
    this.process?.kill();
    this.socket?.close();
    this.process = null;
    this.socket = null;
    this.status = "disconnected";
    for (const { reject } of this.pending.values()) reject(new Error(message));
    this.pending.clear();
    this.emit({ type: "connection", status: this.status, message });
  }

  consume(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.handleMessage(JSON.parse(line));
      } catch {
        this.emit({ type: "diagnostic", message: `Ignored invalid JSON-RPC line: ${line}` });
      }
    }
  }

  handleMessage(message) {
    if ("id" in message && ("result" in message || "error" in message)) {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message ?? "App Server request failed."));
      else request.resolve(message.result);
      return;
    }
    this.emit({ type: "notification", method: message.method, params: message.params ?? {} });
  }

  request(method, params) {
    if (!this.process && !this.socket) return Promise.reject(new Error("App Server is not connected."));
    const id = this.nextRequestId++;
    this.send({ id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method, params) {
    if (!this.process && !this.socket) return;
    this.send({ method, params });
  }

  send(message) {
    const payload = JSON.stringify(message);
    if (this.process) this.process.stdin.write(`${payload}\n`);
    else if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(payload);
  }
}

const appServer = new AppServerClient(appServerCommand, appServerArguments, appServerUrl);
const events = new Map();

function eventThreadId(event) {
  return event.params?.threadId
    ?? event.params?.thread_id
    ?? event.params?.thread?.id
    ?? event.params?.turn?.threadId
    ?? event.params?.turn?.thread_id;
}

appServer.onEvent((event) => {
  const threadId = eventThreadId(event);
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const [response, subscribedThreadId] of events) {
    if (!threadId || !subscribedThreadId || subscribedThreadId === threadId) response.write(payload);
  }
});

async function connectSharedAppServer(attempt = 0) {
  if (!appServerUrl || appServer.status === "connected") return;
  try {
    await appServer.connect();
  } catch (error) {
    if (attempt >= 19) {
      appServer.emit({ type: "diagnostic", message: error.message });
      return;
    }
    setTimeout(() => connectSharedAppServer(attempt + 1), 300);
  }
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function parseJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function isAuthorized(request, url) {
  return request.headers["x-tvis-token"] === accessToken || url?.searchParams.get("token") === accessToken;
}

async function handleApi(request, response, path) {
  if (!isAuthorized(request)) return sendJson(response, 401, { error: "Unauthorized." });

  try {
    if (request.method === "GET" && path === "/api/status") {
      return sendJson(response, 200, {
        status: appServer.status,
        command: appServerUrl ?? `${appServerCommand} ${appServerArguments.join(" ")}`
      });
    }
    if (request.method === "POST" && path === "/api/connect") {
      await appServer.connect();
      return sendJson(response, 200, { status: appServer.status });
    }
    if (request.method === "POST" && path === "/api/disconnect") {
      appServer.disconnect("Disconnected by user.");
      return sendJson(response, 200, { status: appServer.status });
    }
    if (request.method === "GET" && path === "/api/threads") {
      const [loaded, listed] = await Promise.all([
        appServer.request("thread/loaded/list", { limit: 100 }),
        appServer.request("thread/list", {
          cwd: process.cwd(),
          limit: 100,
          sortKey: "updated_at",
          sortDirection: "desc"
        })
      ]);
      const loadedIds = new Set(loaded.data ?? []);
      const threads = (listed.data ?? []).map((thread) => ({
        ...thread,
        loaded: loadedIds.has(thread.id)
      }));
      const listedIds = new Set(threads.map((thread) => thread.id));
      const loadedOnlyThreads = await Promise.all(
        [...loadedIds]
          .filter((threadId) => !listedIds.has(threadId))
          .map(async (threadId) => {
            try {
              const result = await appServer.request("thread/read", { threadId, includeTurns: false });
              return result.thread ? { ...result.thread, loaded: true } : null;
            } catch {
              return null;
            }
          })
      );
      threads.push(...loadedOnlyThreads.filter(Boolean));
      threads.sort((left, right) =>
        Number(right.loaded) - Number(left.loaded) || (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
      );
      return sendJson(response, 200, { threads });
    }
    if (request.method === "POST" && path === "/api/thread/start") {
      const body = await parseJson(request);
      const result = await appServer.request("thread/start", { cwd: body.cwd || null });
      return sendJson(response, 200, result);
    }
    if (request.method === "POST" && path === "/api/thread/resume") {
      const body = await parseJson(request);
      const result = await appServer.request("thread/resume", { threadId: body.threadId });
      return sendJson(response, 200, result);
    }
    if (request.method === "POST" && path === "/api/thread/read") {
      const body = await parseJson(request);
      const result = await appServer.request("thread/read", {
        threadId: body.threadId,
        includeTurns: true
      });
      return sendJson(response, 200, result);
    }
    if (request.method === "POST" && path === "/api/turn/start") {
      const body = await parseJson(request);
      const result = await appServer.request("turn/start", {
        threadId: body.threadId,
        input: [{ type: "text", text: body.text }]
      });
      return sendJson(response, 200, result);
    }
    return sendJson(response, 404, { error: "Unknown API endpoint." });
  } catch (error) {
    return sendJson(response, 500, { error: error.message });
  }
}

async function serveStatic(request, response, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const absolutePath = normalize(join(publicDirectory, requestedPath));
  if (!absolutePath.startsWith(publicDirectory)) return sendJson(response, 403, { error: "Forbidden." });

  try {
    const file = await stat(absolutePath);
    if (!file.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(absolutePath)] ?? "application/octet-stream",
      "Cache-Control": "no-store"
    });
    createReadStream(absolutePath).pipe(response);
  } catch {
    const fallback = await readFile(join(publicDirectory, "index.html"));
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(fallback);
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/api/events") {
    if (!isAuthorized(request, url)) return sendJson(response, 401, { error: "Unauthorized." });
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    response.write(`data: ${JSON.stringify({ type: "connection", status: appServer.status })}\n\n`);
    events.set(response, url.searchParams.get("threadId"));
    request.on("close", () => events.delete(response));
    return;
  }
  if (url.pathname.startsWith("/api/")) return handleApi(request, response, url.pathname);
  return serveStatic(request, response, url);
});

server.listen(port, host, () => {
  console.log(`T Vis is ready: http://${host}:${port}/?token=${accessToken}`);
  console.log(`App Server: ${appServerUrl ?? `${appServerCommand} ${appServerArguments.join(" ")}`}`);
  connectSharedAppServer();
});
