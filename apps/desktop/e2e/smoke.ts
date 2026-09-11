import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const desktopDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");

const appBinary = process.env.CLASH_DESKTOP_APP_BINARY;
const usePackagedApp = Boolean(appBinary);
const realAcpSmoke = process.env.CLASH_DESKTOP_REAL_ACP_SMOKE === "1";
let webUrl = process.env.CLASH_WEB_URL;
const webPortStart = Number(process.env.CLASH_DESKTOP_WEB_PORT_START ?? "3001");
const captureDir =
  process.env.CLASH_DESKTOP_CAPTURE_DIR ??
  path.join(repoRoot, ".tmp", "electron-smoke-captures");
const dataDir =
  process.env.CLASH_DESKTOP_SMOKE_DATA_DIR ??
  path.join(repoRoot, ".tmp", "electron-smoke-data");
const realAcpBinDir = path.join(repoRoot, ".tmp", "electron-real-acp-bin");
const realAcpHome = path.join(repoRoot, ".tmp", "electron-real-acp-home");
const latestScreenshot = path.join(captureDir, "latest-cdp-smoke.png");
const runtimeCopilotScreenshot = path.join(captureDir, "runtime-copilot-ui.png");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertWebServer() {
  const deadline = Date.now() + 25000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(webUrl, { signal: AbortSignal.timeout(2500) });
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(
    `Web app is not reachable at ${webUrl}. Start it first: pnpm --filter @clash/web dev\n` +
      `Reason: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function assertViteRouteModulesReady() {
  const deadline = Date.now() + 25000;
  let lastError;
  const paths = ["/app/main.tsx", "/app/routes/home.tsx"];
  while (Date.now() < deadline) {
    try {
      const responses = await Promise.all(
        paths.map((pathname) => fetch(new URL(pathname, webUrl), { signal: AbortSignal.timeout(2500) })),
      );
      if (responses.every((res) => res.ok && (res.headers.get("content-type") ?? "").includes("javascript"))) {
        return;
      }
      lastError = new Error(responses.map((res) => `${res.url} -> HTTP ${res.status}`).join(", "));
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(
    `Vite route modules are not reachable at ${webUrl}. ` +
      `Reason: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function findFreePort(start) {
  const failures = [];
  for (let port = start; port < start + 100; port += 1) {
    const ok = await new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", (error) => {
        failures.push(`${port}:${error.code ?? error.message}`);
        resolve(false);
      });
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(true));
      });
    });
    if (ok) return port;
  }
  throw new Error(`No free port found from ${start}. Last bind errors: ${failures.slice(-5).join(", ")}`);
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function startMockCloudRoomServer() {
  const port = await findFreePort(49450);
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const roomMatch = /^\/api\/v1\/projects\/([^/]+)\/room\/messages$/.exec(url.pathname);
    if (roomMatch) {
      const projectId = decodeURIComponent(roomMatch[1]);
      if (req.method === "GET") {
        requests.push({
          kind: "room",
          method: "GET",
          projectId,
          authorization: req.headers.authorization ?? "",
        });
        return writeJson(res, 200, { messages: [] });
      }
      if (req.method === "POST") {
        const raw = await readRequestBody(req);
        const body = raw.byteLength ? JSON.parse(raw.toString("utf8")) : {};
        requests.push({
          kind: "room",
          method: "POST",
          projectId,
          authorization: req.headers.authorization ?? "",
          body,
        });
        return writeJson(res, 201, {
          id: body.id ?? "mock-cloud-room-message",
          project_id: projectId,
          sender_kind: body.sender_kind ?? "user",
          sender_id: body.sender_id ?? "local-user",
          sender_user_id: "local-user",
          mentions: body.mentions ?? [],
          text: body.text ?? "",
          at: Math.floor(Date.now() / 1000),
        });
      }
    }

    if (/^\/loro\/.+\/snapshot$/.test(url.pathname) && req.method === "GET") {
      requests.push({ kind: "loro", method: "GET", path: url.pathname });
      res.writeHead(404);
      res.end();
      return;
    }
    if (/^\/loro\/.+\/updates$/.test(url.pathname) && req.method === "POST") {
      const raw = await readRequestBody(req);
      requests.push({
        kind: "loro",
        method: "POST",
        path: url.pathname,
        bytes: raw.byteLength,
        authorization: req.headers.authorization ?? "",
      });
      res.writeHead(204);
      res.end();
      return;
    }

    writeJson(res, 404, { error: "not found" });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${result.status}`);
  }
}

async function runClashCli(args, env) {
  const child = spawn("clash", args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
      CLASH_NODE_EXEC_PATH: process.execPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`clash ${args.join(" ")} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 15000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (exitCode, signal) => {
      clearTimeout(timer);
      if (signal) reject(new Error(`clash ${args.join(" ")} terminated by ${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      else resolve(exitCode ?? 1);
    });
  });
  if (code !== 0) {
    throw new Error(`clash ${args.join(" ")} exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return stdout.trim();
}

function tail(lines, max = 80) {
  return lines.slice(Math.max(0, lines.length - max)).join("");
}

async function writeFakeCodexAcp(binDir) {
  await mkdir(binDir, { recursive: true });
  const wrapper = path.join(binDir, "codex-acp");
  const agent = path.join(binDir, "fake-codex-acp.mjs");
  const sdkUrl = pathToFileURL(require.resolve("@agentclientprotocol/sdk", {
    paths: [path.join(repoRoot, "packages", "cli")],
  })).href;
  await writeFile(
    wrapper,
    [
      "#!/bin/sh",
      "DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
      "if [ -n \"$CLASH_NODE_EXEC_PATH\" ]; then",
      "  exec \"$CLASH_NODE_EXEC_PATH\" \"$DIR/fake-codex-acp.mjs\" \"$@\"",
      "fi",
      "exec node \"$DIR/fake-codex-acp.mjs\" \"$@\"",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await writeFile(
    agent,
    [
      "#!/usr/bin/env node",
      "import { spawn } from 'node:child_process';",
      "import { randomUUID } from 'node:crypto';",
      "import { Readable, Writable } from 'node:stream';",
      `import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from ${JSON.stringify(sdkUrl)};`,
      "",
      "const argv = process.argv.slice(2);",
      "if (argv.includes('--help')) {",
      "  console.log('Usage: codex-acp [OPTIONS]');",
      "  process.exit(0);",
      "}",
      "",
      "function runClash(args) {",
      "  return new Promise((resolve, reject) => {",
      "    const child = spawn('clash', args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });",
      "    let stdout = '';",
      "    let stderr = '';",
      "    child.stdout.setEncoding('utf8');",
      "    child.stderr.setEncoding('utf8');",
      "    child.stdout.on('data', (chunk) => { stdout += chunk; });",
      "    child.stderr.on('data', (chunk) => { stderr += chunk; });",
      "    child.once('error', reject);",
      "    child.once('exit', (code, signal) => {",
      "      if (code === 0) resolve(stdout.trim());",
      "      else reject(new Error('clash ' + args.join(' ') + ' exited ' + (signal || code) + '\\nstdout:\\n' + stdout + '\\nstderr:\\n' + stderr));",
      "    });",
      "  });",
      "}",
      "",
      "function configOptions(state = {}) {",
      "  return [",
      "    {",
      "      id: 'mode',",
      "      name: 'Mode',",
      "      type: 'select',",
      "      category: 'mode',",
      "      currentValue: state.mode || 'full-access',",
      "      options: [",
      "        { value: 'read-only', name: 'Read only' },",
      "        { value: 'auto', name: 'Auto' },",
      "        { value: 'full-access', name: 'Full access' },",
      "      ],",
      "    },",
      "    {",
      "      id: 'model',",
      "      name: 'Model',",
      "      type: 'select',",
      "      category: 'model',",
      "      currentValue: state.model || 'gpt-5.5',",
      "      options: [",
      "        { value: 'gpt-5.5', name: 'GPT-5.5', description: 'Codex conversational model' },",
      "        { value: 'gpt-5.4', name: 'GPT-5.4', description: 'Codex compatibility profile' },",
      "      ],",
      "    },",
      "    {",
      "      id: 'reasoning_effort',",
      "      name: 'Reasoning',",
      "      type: 'select',",
      "      category: 'thought_level',",
      "      currentValue: state.reasoning_effort || 'low',",
      "      options: [",
      "        { value: 'low', name: 'Low' },",
      "        { value: 'medium', name: 'Medium' },",
      "        { value: 'high', name: 'High' },",
      "        { value: 'xhigh', name: 'Extra High' },",
      "      ],",
      "    },",
      "  ];",
      "}",
      "",
      "class FakeCodexAcpAgent {",
      "  constructor(connection) {",
      "    this.connection = connection;",
      "    this.sessions = new Map();",
      "  }",
      "  async initialize() {",
      "    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: false, promptCapabilities: {} } };",
      "  }",
      "  async newSession(params) {",
      "    const sessionId = randomUUID();",
      "    const state = { cwd: params.cwd || process.cwd(), mode: 'full-access', model: 'gpt-5.5', reasoning_effort: 'low' };",
      "    this.sessions.set(sessionId, state);",
      "    return { sessionId, configOptions: configOptions(state) };",
      "  }",
      "  async authenticate() { return {}; }",
      "  async setSessionConfigOption(params) {",
      "    const state = this.sessions.get(params.sessionId);",
      "    if (!state) throw new Error('unknown session ' + params.sessionId);",
      "    state[params.configId] = params.value;",
      "    return { configOptions: configOptions(state) };",
      "  }",
      "  async prompt(params) {",
      "    if (!this.sessions.has(params.sessionId)) throw new Error('unknown session ' + params.sessionId);",
      "    await this.connection.sessionUpdate({",
      "      sessionId: params.sessionId,",
      "      update: {",
      "        sessionUpdate: 'agent_thought_chunk',",
      "        content: { type: 'text', text: 'Checking the canvas before editing.' },",
      "        messageId: 'desktop-fake-thought',",
      "      },",
      "    });",
      "    await this.connection.sessionUpdate({",
      "      sessionId: params.sessionId,",
      "      update: {",
      "        sessionUpdate: 'tool_call',",
      "        toolCallId: 'desktop-fake-clash-cli',",
      "        title: 'Run clash canvas add',",
      "        kind: 'execute',",
      "        status: 'in_progress',",
      "        rawInput: { command: 'clash canvas add' },",
      "      },",
      "    });",
      "    const projectId = process.env.CLASH_PROJECT_ID;",
      "    if (!projectId) throw new Error('CLASH_PROJECT_ID missing');",
      "    const created = JSON.parse(await runClash([",
      "      'canvas', 'add',",
      "      '--project', projectId,",
      "      '--type', 'text',",
      "      '--label', 'Desktop Real ACP CLI Note',",
      "      '--content', 'created by desktop fake ACP child through clash CLI',",
      "      '--json',",
      "    ]));",
      "    await this.connection.sessionUpdate({",
      "      sessionId: params.sessionId,",
      "      update: {",
      "        sessionUpdate: 'agent_message_chunk',",
      "        content: { type: 'text', text: 'Desktop fake ACP wrote node ' + created.node_id },",
      "      },",
      "    });",
      "    await this.connection.sessionUpdate({",
      "      sessionId: params.sessionId,",
      "      update: {",
      "        sessionUpdate: 'tool_call_update',",
      "        toolCallId: 'desktop-fake-clash-cli',",
      "        status: 'completed',",
      "        rawOutput: created,",
      "      },",
      "    });",
      "    return { stopReason: 'end_turn' };",
      "  }",
      "  async cancel() {}",
      "}",
      "",
      "const input = Writable.toWeb(process.stdout);",
      "const output = Readable.toWeb(process.stdin);",
      "new AgentSideConnection((connection) => new FakeCodexAcpAgent(connection), ndJsonStream(input, output));",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

async function waitForTarget(cdpPort) {
  const url = `http://127.0.0.1:${cdpPort}/json/list`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const targets = await res.json();
        const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch {
      // Electron may not have opened the DevTools endpoint yet.
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for Electron CDP page target");
}

async function startWebServerIfNeeded() {
  if (usePackagedApp) return null;
  if (webUrl) {
    await assertWebServer();
    return null;
  }

  const port = await findFreePort(webPortStart);
  webUrl = `http://127.0.0.1:${port}`;
  const webDir = path.join(repoRoot, "apps", "web");
  const logs = [];
  const child = spawn("pnpm", ["--dir", webDir, "exec", "vite", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: webDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (buf) => {
    const text = String(buf);
    logs.push(text);
    process.stdout.write(text);
  });
  child.stderr.on("data", (buf) => {
    const text = String(buf);
    logs.push(text);
    process.stderr.write(text);
  });
  try {
    await assertWebServer();
    await assertViteRouteModulesReady();
  } catch (error) {
    console.error("[desktop-smoke] web server logs\n" + tail(logs));
    await stopProcess(child);
    throw error;
  }
  return child;
}

class CdpClient {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (!msg.id || !this.pending.has(msg.id)) return;
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
    });
  }

  async ready() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.ws.close();
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "Runtime evaluation failed");
  }
  return result.result.value;
}

async function waitFor(cdp, expression, label, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(cdp, expression);
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForValue(fn, label, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function click(cdp, selectorExpression, label) {
  return waitFor(
    cdp,
    `(() => {
      const el = (${selectorExpression});
      if (!el) return false;
      el.scrollIntoView({ block: "center", inline: "center" });
      el.click();
      return {
        label: ${JSON.stringify(label)},
        text: (el.innerText || el.textContent || "").trim(),
        href: location.href
      };
    })()`,
    `click ${label}`,
  );
}

function clickableByText(label) {
  return `([...document.querySelectorAll("a, button, [role='button'], [role='tab']")].find((el) => {
    const text = (el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim();
    if (text !== ${JSON.stringify(label)}) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }))`;
}

function assertReadableTheme(state) {
  if (state.bodyColor === "rgb(255, 255, 255)" && state.bodyBg !== "rgb(0, 0, 0)") {
    throw new Error(`Body text is white on a non-black background: ${JSON.stringify(state)}`);
  }
}

async function capture(cdp, targetPath = latestScreenshot) {
  await mkdir(captureDir, { recursive: true });
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await writeFile(targetPath, Buffer.from(shot.data, "base64"));
}

async function typeRoomMessage(cdp, text) {
  const inserted = await evaluate(cdp, `(() => {
    const editor = document.querySelector(".milkdown-chat-input [contenteditable='true']");
    if (!editor) return false;
    editor.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, ${JSON.stringify(text)});
    editor.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: ${JSON.stringify(text)}
    }));
    return (editor.innerText || editor.textContent || "").includes(${JSON.stringify(text)});
  })()`);
  if (!inserted) throw new Error("Could not type into room chat editor");
}

async function sendSyntheticLoroUpdate(apiPort, projectId) {
  const { LoroDoc } = await import("loro-crdt");
  const ws = new WebSocket(`ws://127.0.0.1:${apiPort}/sync/${encodeURIComponent(projectId)}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const doc = new LoroDoc();
  doc.getMap("nodes").set("desktop-e2e-node", {
    type: "text",
    position: { x: 120, y: 120 },
    data: { label: "Desktop E2E Loro" },
  });
  ws.send(doc.export({ mode: "snapshot" }));
  await sleep(250);
  ws.close();
}

async function exerciseLocalAcpSessionHistory(cdp) {
  const state = await evaluate(cdp, `(async () => {
    const runtime = window.__CLASH_RUNTIME_CONFIG__;
    const runtimes = await (await fetch(runtime.apiBaseUrl + "/api/v1/runtimes")).json();
    const createdRes = await fetch(runtime.apiBaseUrl + "/api/v1/runtimes/desktop-local/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent_template_id: "clash",
        project_id: "desktop-smoke-agent"
      })
    });
    const created = await createdRes.json();
    if (!createdRes.ok) {
      return { ok: false, stage: "create", status: createdRes.status, runtimes, created };
    }

    async function promptSession(turnId, promptText) {
      const events = [];
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(runtime.wsBaseUrl + "/api/v1/local-sessions/" + encodeURIComponent(created.session_id) + "/_stream");
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error("Timed out waiting for mock ACP completion"));
        }, 10000);
        ws.addEventListener("open", () => {
          ws.send(JSON.stringify({ type: "prompt", turn_id: turnId, text: promptText }));
        });
        ws.addEventListener("message", (event) => {
          const msg = JSON.parse(String(event.data));
          events.push(msg);
          if (msg.type === "session.complete" && msg.turn_id === turnId) {
            clearTimeout(timeout);
            ws.close();
            resolve(true);
          }
        });
        ws.addEventListener("error", () => {
          clearTimeout(timeout);
          reject(new Error("Mock ACP websocket failed"));
        });
      });
      return events;
    }

    const firstEvents = await promptSession("desktop-smoke-turn-1", "hello desktop local agent");
    const secondEvents = await promptSession("desktop-smoke-turn-2", "hello again after detach");

    async function readPersistedSessionState() {
      const historyRes = await fetch(runtime.apiBaseUrl + "/api/v1/local-sessions/" + encodeURIComponent(created.session_id) + "/messages");
      const history = await historyRes.json();
      const sessionsRes = await fetch(runtime.apiBaseUrl + "/api/v1/sessions?projectId=desktop-smoke-agent");
      const sessions = await sessionsRes.json();
      return {
        ok: historyRes.ok && sessionsRes.ok,
        status: { history: historyRes.status, sessions: sessionsRes.status },
        history,
        sessions
      };
    }

    let persisted = await readPersistedSessionState();
    const deadline = Date.now() + 5000;
    while (
      Date.now() < deadline &&
      !persisted.history?.messages?.some((message) =>
        message.sender_kind === "agent" &&
        message.turn_id === "desktop-smoke-turn-2" &&
        message.events?.some((event) => event.type === "text" && event.text === "Mock ACP reply: hello again after detach")
      )
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      persisted = await readPersistedSessionState();
    }
    return {
      ok: persisted.ok,
      stage: "history",
      status: persisted.status,
      runtimes,
      created,
      events: [...firstEvents, ...secondEvents],
      history: persisted.history,
      sessions: persisted.sessions
    };
  })()`);

  const agents = state.runtimes?.runtimes?.flatMap((runtime) => runtime.agents ?? []) ?? [];
  const userMessage = state.history?.messages?.find((message) =>
    message.sender_kind === "user" &&
    message.events?.some((event) => event.type === "text" && event.text === "hello desktop local agent")
  );
  const agentMessage = state.history?.messages?.find((message) =>
    message.sender_kind === "agent" &&
    message.events?.some((event) => event.type === "text" && event.text === "Mock ACP reply: hello desktop local agent")
  );
  const reopenedUserMessage = state.history?.messages?.find((message) =>
    message.sender_kind === "user" &&
    message.turn_id === "desktop-smoke-turn-2" &&
    message.events?.some((event) => event.type === "text" && event.text === "hello again after detach")
  );
  const reopenedAgentMessage = state.history?.messages?.find((message) =>
    message.sender_kind === "agent" &&
    message.turn_id === "desktop-smoke-turn-2" &&
    message.events?.some((event) => event.type === "text" && event.text === "Mock ACP reply: hello again after detach")
  );
  const persistedSession = state.sessions?.sessions?.find((session) =>
    session.threadId === state.created?.session_id &&
    session.type === "runtime" &&
    session.projectId === "desktop-smoke-agent"
  );
  if (
    !state.ok ||
    !agents.some((agent) => agent.id === "mock-acp") ||
    !userMessage ||
    !agentMessage ||
    !reopenedUserMessage ||
    !reopenedAgentMessage ||
    !persistedSession
  ) {
    throw new Error(`Local ACP session history smoke failed: ${JSON.stringify(state)}`);
  }
  console.log("[desktop-smoke] local acp history", JSON.stringify({
    session_id: state.created.session_id,
    persisted: { threadId: persistedSession.threadId, type: persistedSession.type },
    events: state.events.map((event) => event.type),
    messages: state.history.messages.map((message) => ({
      sender_kind: message.sender_kind,
      sender_id: message.sender_id,
      turn_id: message.turn_id,
    })),
  }));
}

async function exerciseRealAcpSessionThroughDesktopRuntime(cdp, apiPort) {
  const state = await evaluate(cdp, `(async () => {
    const runtime = window.__CLASH_RUNTIME_CONFIG__;
    const projectRes = await fetch(runtime.apiBaseUrl + "/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "desktop real acp project" })
    });
    const project = await projectRes.json();
    if (!projectRes.ok) {
      return { ok: false, stage: "project", status: projectRes.status, project };
    }

    const runtimes = await (await fetch(runtime.apiBaseUrl + "/api/v1/runtimes")).json();
    if (!runtimes.runtimes?.[0]?.agents?.some((agent) => agent.id === "codex-acp")) {
      return { ok: false, stage: "runtimes", runtimes };
    }

    const createdRes = await fetch(runtime.apiBaseUrl + "/api/v1/runtimes/desktop-local/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent_member_id: "local-clash",
        project_id: project.id,
        agent_id: "codex-acp"
      })
    });
    const created = await createdRes.json();
    if (!createdRes.ok) {
      return { ok: false, stage: "create", status: createdRes.status, runtimes, created, project };
    }

    const turnId = "desktop-real-acp-turn";
    const events = [];
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(runtime.wsBaseUrl + "/api/v1/local-sessions/" + encodeURIComponent(created.session_id) + "/_stream");
      let promptSent = false;
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Timed out waiting for desktop real ACP disposal"));
      }, 20000);
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(String(event.data));
        events.push(msg);
        if (msg.type === "session.ready") {
          const options = msg.config_options || [];
          if (!options.some((option) => option.category === "model")) {
            clearTimeout(timeout);
            ws.close();
            reject(new Error("session.ready did not include ACP model config_options"));
            return;
          }
          if (!options.some((option) => option.category === "thought_level")) {
            clearTimeout(timeout);
            ws.close();
            reject(new Error("session.ready did not include ACP thought_level config_options"));
            return;
          }
          ws.send(JSON.stringify({ type: "set_config_option", config_id: "model", value: "gpt-5.4" }));
          return;
        }
        if (
          msg.type === "session.config_options" &&
          msg.config_options?.some((option) => option.id === "model" && option.currentValue === "gpt-5.4") &&
          !promptSent
        ) {
          promptSent = true;
          ws.send(JSON.stringify({ type: "prompt", turn_id: turnId, text: "use clash cli on the desktop canvas" }));
          return;
        }
        if (msg.type === "session.complete" && msg.turn_id === turnId) {
          ws.send(JSON.stringify({ type: "dispose" }));
          return;
        }
        if (msg.type === "session.disposed" && msg.session_id === created.session_id) {
          clearTimeout(timeout);
          ws.close();
          resolve(true);
        }
      });
      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Desktop real ACP websocket failed"));
      });
    });

    const textEvent = events.find((event) =>
      event.type === "session.event" &&
      event.event?.content?.text?.startsWith("Desktop fake ACP wrote node ")
    );
    const toolCallEvent = events.find((event) =>
      event.type === "session.event" &&
      event.event?.sessionUpdate === "tool_call" &&
      event.event?.toolCallId === "desktop-fake-clash-cli"
    );
    return {
      ok: !!textEvent && !!toolCallEvent,
      stage: "events",
      runtimes,
      project,
      created,
      events,
      text: textEvent?.event?.content?.text ?? null
    };
  })()`);

  if (!state.ok) {
    throw new Error(`Desktop real ACP smoke failed: ${JSON.stringify(state)}`);
  }

  const { createLocalAgentToolEnv } = await import("../../local-api/dist/server.js");
  const env = createLocalAgentToolEnv({
    dataDir,
    apiBaseUrl: `http://127.0.0.1:${apiPort}`,
    env: { ...process.env, CLASH_NODE_EXEC_PATH: process.execPath },
  });
  const nodes = JSON.parse(await runClashCli([
    "canvas",
    "list",
    "--project",
    state.project.id,
    "--json",
  ], env));
  const node = nodes.find((candidate) => candidate.data?.label === "Desktop Real ACP CLI Note");
  if (!node) {
    throw new Error(`Desktop real ACP CLI node missing: ${JSON.stringify({ state, nodes })}`);
  }
  if (
    node.data?.actorType !== "agent" ||
    node.data?.actorUserId !== "local-user" ||
    node.data?.actorAgentId !== "local-clash"
  ) {
    throw new Error(`Desktop real ACP CLI node attribution mismatch: ${JSON.stringify(node)}`);
  }

  console.log("[desktop-smoke] real acp cli", JSON.stringify({
    session_id: state.created.session_id,
    project_id: state.project.id,
    node_id: node.id,
    actorType: node.data.actorType,
    actorUserId: node.data.actorUserId,
    actorAgentId: node.data.actorAgentId,
    events: state.events.map((event) => event.type),
  }));
}

async function exerciseRuntimeCopilotUi(cdp) {
  await waitFor(
    cdp,
    `!!document.querySelector('[aria-label="AI Copilot"], [aria-label="AI 副驾驶"]')`,
    "AI Copilot panel",
  );
  await waitFor(
    cdp,
    `!!document.querySelector(".milkdown-chat-input [contenteditable='true']")`,
    "desktop runtime composer ready",
    15000,
  );
  const emptyState = await evaluate(cdp, `(() => ({
    bodyText: document.body.innerText.slice(0, 500),
    hasRunPicker: !!(
      document.querySelector("button[aria-label='Run on (Cloud / local runtime)']") ||
      document.querySelector("button[aria-label='运行环境（云端 / 本地）']")
    ),
    statusLabels: [...document.querySelectorAll('[role="status"]')]
      .map((el) => el.getAttribute("aria-label") || (el.innerText || el.textContent || "").trim())
      .filter(Boolean),
  }))()`);
  if (
    emptyState.bodyText.includes("Local agent connected") ||
    emptyState.bodyText.includes("本地 Agent 已连接") ||
    emptyState.bodyText.includes("No local agent is available") ||
    emptyState.bodyText.includes("Start the local agent")
  ) {
    throw new Error(`Desktop local empty state is too noisy: ${JSON.stringify(emptyState)}`);
  }
  console.log("[desktop-smoke] runtime copilot empty state", JSON.stringify(emptyState));

  const prompt = "hello desktop runtime helper";
  await typeRoomMessage(cdp, prompt);
  await click(
    cdp,
    `([...document.querySelectorAll("button")].find((button) => {
      const label = (button.getAttribute("aria-label") || "").toLowerCase();
      const rect = button.getBoundingClientRect();
      return label.includes("send") && !button.disabled && rect.width > 0 && rect.height > 0;
      }))`,
    "Send runtime prompt",
  );

  try {
    await waitFor(
      cdp,
      `document.body.innerText.includes(${JSON.stringify(prompt)}) &&
        document.body.innerText.includes(${JSON.stringify(`Mock ACP reply: ${prompt}`)})`,
      "runtime mock ACP reply",
      15000,
    );
    await waitFor(
      cdp,
      `(() => {
        const nodes = [...document.querySelectorAll(".react-flow__node")].map((node) => ({
          id: node.getAttribute("data-id") || "",
          text: (node.querySelector("input")?.value || "") + " " + (node.innerText || node.textContent || ""),
        }));
        return nodes.some((node) => node.id.includes("mock-agent-stage-")) &&
          nodes.some((node) => node.text.includes("Agent Brief")) &&
          nodes.some((node) => node.text.includes("Agent Image Pass"));
      })()`,
      "runtime-created canvas nodes",
      15000,
    );
  } catch (error) {
    const diagnostics = await evaluate(cdp, `(() => ({
      bodyText: document.body.innerText.slice(0, 2000),
      runtimeMenuButtons: [...document.querySelectorAll("button, [role='menuitem']")].map((button) => ({
        text: (button.innerText || button.textContent || "").trim(),
        ariaLabel: button.getAttribute("aria-label"),
        disabled: button.disabled || button.getAttribute("aria-disabled"),
      })),
    }))()`);
    console.error("[desktop-smoke] runtime copilot diagnostics", JSON.stringify(diagnostics, null, 2));
    throw error;
  }

  const state = await evaluate(cdp, `(() => {
    const nodes = [...document.querySelectorAll(".react-flow__node")].map((node) => ({
      id: node.getAttribute("data-id"),
      text: ((node.querySelector("input")?.value || "") + " " + (node.innerText || node.textContent || "")).trim().slice(0, 180),
      rect: (() => {
        const r = node.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      })()
    }));
    return {
      text: document.body.innerText.slice(0, 800),
      url: location.href,
      nodes: nodes.filter((node) =>
        (node.id || "").includes("mock-agent-stage-") ||
        node.text.includes("Agent Brief") ||
        node.text.includes("Agent Image Pass")
      ),
    };
  })()`);
  await capture(cdp, runtimeCopilotScreenshot);
  console.log("[desktop-smoke] runtime copilot ui", JSON.stringify(state));
  console.log(`[desktop-smoke] runtime copilot screenshot ${runtimeCopilotScreenshot}`);
}

async function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    sleep(timeoutMs).then(() => false),
  ]);
}

async function stopProcess(child) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForProcessExit(child, 3000)) return;
  child.kill("SIGKILL");
  await waitForProcessExit(child, 3000);
}

async function main() {
  let webChild = null;
  if (!usePackagedApp) {
    webChild = await startWebServerIfNeeded();
  }

  const cdpPort = await findFreePort(49355);
  const apiPort = await findFreePort(49356);
  await rm(dataDir, { recursive: true, force: true });
  if (realAcpSmoke) {
    await rm(realAcpBinDir, { recursive: true, force: true });
    await rm(realAcpHome, { recursive: true, force: true });
    await mkdir(realAcpHome, { recursive: true });
    await writeFakeCodexAcp(realAcpBinDir);
  }
  const mockCloud = await startMockCloudRoomServer();
  const electronBin = require("electron");
  const launchCommand = appBinary ?? electronBin;
  const launchArgs = usePackagedApp
    ? []
    : [`--remote-debugging-port=${cdpPort}`, desktopDir];
  const logs = [];
  const child = spawn(launchCommand, launchArgs, {
    cwd: usePackagedApp ? path.dirname(launchCommand) : repoRoot,
    env: {
      ...process.env,
      ...(usePackagedApp ? {} : { CLASH_WEB_URL: webUrl }),
      ...(usePackagedApp ? { CLASH_DESKTOP_REMOTE_DEBUGGING_PORT: String(cdpPort) } : {}),
      CLASH_LOCAL_DATA_DIR: dataDir,
      CLASH_LOCAL_API_PORT: String(apiPort),
      CLASH_DESKTOP_CAPTURE_DIR: captureDir,
      ...(realAcpSmoke
        ? {
            CLASH_ACP_TEST_BIN_DIR: realAcpBinDir,
            CLASH_NODE_EXEC_PATH: process.execPath,
            HOME: realAcpHome,
          }
        : { CLASH_E2E_STUB_ACP: "1" }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (buf) => {
    const text = String(buf);
    logs.push(text);
    process.stdout.write(text);
  });
  child.stderr.on("data", (buf) => {
    const text = String(buf);
    logs.push(text);
    process.stderr.write(text);
  });

  let cdp;
  try {
    cdp = new CdpClient(await waitForTarget(cdpPort));
    await cdp.ready();
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Page.bringToFront");

    await waitFor(cdp, `document.body.innerText.includes("Home")`, "home");
    const homeState = await evaluate(cdp, `({
      href: location.href,
      text: document.body.innerText.slice(0, 240),
      bodyColor: getComputedStyle(document.body).color,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      runtime: window.__CLASH_RUNTIME_CONFIG__ ?? null
    })`);
    assertReadableTheme(homeState);
    console.log("[desktop-smoke] home", JSON.stringify(homeState));

    const syncState = await evaluate(cdp, `(async () => {
      const runtime = window.__CLASH_RUNTIME_CONFIG__;
      const res = await fetch(runtime.apiBaseUrl + "/api/v1/local/sync", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "cloud-sync",
          remote_loro_url: ${JSON.stringify(mockCloud.url)},
          remote_loro_token: "clsh_smoke_token"
        })
      });
      return await res.json();
    })()`);
    if (syncState.mode !== "cloud-sync") {
      throw new Error(`Failed to enable cloud sync: ${JSON.stringify(syncState)}`);
    }
    console.log("[desktop-smoke] sync", JSON.stringify(syncState));
    if (realAcpSmoke) {
      await exerciseRealAcpSessionThroughDesktopRuntime(cdp, apiPort);
    } else {
      await exerciseLocalAcpSessionHistory(cdp);
    }

    await click(cdp, clickableByText("Projects"), "Projects");
    await waitFor(cdp, `location.pathname === "/projects"`, "projects page");

    await click(cdp, clickableByText("New Project"), "New Project");
    await waitFor(
      cdp,
      `location.pathname.startsWith("/projects/") && location.pathname !== "/projects" && !!document.querySelector("#editor-header")`,
      "project editor",
      15000,
    );
    const projectState = await evaluate(cdp, `({
      href: location.href,
      text: document.body.innerText.slice(0, 240),
      hasEditorHeader: !!document.querySelector("#editor-header")
    })`);
    console.log("[desktop-smoke] project", JSON.stringify(projectState));

    const projectId = await evaluate(cdp, `location.pathname.split("/").filter(Boolean).at(-1)`);
    const loroSnapshot = await waitForValue(
      () => mockCloud.requests.find((req) =>
        req.kind === "loro" &&
        req.method === "GET" &&
        req.path.includes(encodeURIComponent(projectId))
      ),
      "mock cloud Loro snapshot fetch",
      15000,
    );
    console.log("[desktop-smoke] loro cloud snapshot", JSON.stringify(loroSnapshot));
    if (!realAcpSmoke) {
      await exerciseRuntimeCopilotUi(cdp);
    }
    await sendSyntheticLoroUpdate(apiPort, projectId);
    const loroUpdate = await waitForValue(
      () => mockCloud.requests.find((req) =>
        req.kind === "loro" &&
        req.method === "POST" &&
        req.path.includes(encodeURIComponent(projectId)) &&
        req.bytes > 0
      ),
      "mock cloud Loro update append",
      15000,
    );
    console.log("[desktop-smoke] loro cloud update", JSON.stringify(loroUpdate));

    await click(
      cdp,
      `document.querySelector("button[aria-label='Return to projects']")`,
      "Return to projects",
    );
    await waitFor(cdp, `location.pathname === "/projects"`, "projects page again");

    await click(cdp, clickableByText("Store"), "Store");
    await waitFor(
      cdp,
      `location.pathname === "/marketplace/manage" && document.body.innerText.includes("Marketplace")`,
      "store page",
    );

    const finalState = await evaluate(cdp, `({
      href: location.href,
      title: document.title,
      text: document.body.innerText.slice(0, 500),
      bodyColor: getComputedStyle(document.body).color,
      bodyBg: getComputedStyle(document.body).backgroundColor
    })`);
    assertReadableTheme(finalState);
    await capture(cdp);
    console.log("[desktop-smoke] final", JSON.stringify(finalState));
    console.log(`[desktop-smoke] screenshot ${latestScreenshot}`);
  } catch (error) {
    if (cdp) {
      try {
        await capture(cdp);
        console.error(`[desktop-smoke] failure screenshot ${latestScreenshot}`);
      } catch {
        // Ignore screenshot failures during cleanup.
      }
    }
    console.error(tail(logs));
    throw error;
  } finally {
    if (cdp) cdp.close();
    await stopProcess(child);
    await stopProcess(webChild);
    await mockCloud.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
