#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const target = process.argv[2];
const validTargets = new Map([
  ["trae", "traecli"],
  ["codex", "codex"]
]);

if (!validTargets.has(target)) {
  console.error("Usage: tvis <trae|codex> [TUI arguments...]");
  process.exit(1);
}

const executable = validTargets.get(target);
const extraArguments = process.argv.slice(3);
const appServerPort = Number(process.env.TVIS_APP_SERVER_PORT ?? 4699);
const webPort = Number(process.env.TVIS_PORT ?? 4173);
const endpoint = `ws://127.0.0.1:${appServerPort}`;
const rootDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const serverPath = join(rootDirectory, "server.mjs");
const children = [];
let tui = null;

function executableAvailable(command) {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function launch(command, args, environment = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...environment }
  });
  children.push(child);
  child.once("exit", (code) => {
    if (child === tui && code !== 0 && code !== null) shutdown(code);
  });
  return child;
}

function shutdown(exitCode = 0) {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exit(exitCode);
}

if (!executableAvailable(executable)) {
  console.error(`Cannot find a working ${executable} executable on PATH.`);
  process.exit(1);
}

const appServer = launch(executable, ["app-server", "--listen", endpoint]);
setTimeout(() => {
  launch("node", [serverPath], {
    APP_SERVER_URL: endpoint,
    PORT: String(webPort)
  });
  tui = launch(executable, ["--remote", endpoint, ...extraArguments]);
}, 350);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => shutdown());
}

appServer.once("exit", (code) => {
  if (code !== 0 && code !== null) shutdown(code);
});
