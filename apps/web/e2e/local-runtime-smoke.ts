import { loadHostServer, type ClosableServer } from "./host-artifacts.ts";
import { CdpClient } from "../../../scripts/e2e/harness.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webDir, "..", "..");
const dataDir = process.env.CLASH_WEB_E2E_DATA_DIR ?? path.join(repoRoot, ".tmp", "web-e2e-local-api-data");
const chromeDataDir = process.env.CLASH_WEB_E2E_CHROME_DATA_DIR ?? path.join(repoRoot, ".tmp", "web-e2e-chrome");
const captureDir = process.env.CLASH_WEB_E2E_CAPTURE_DIR ?? path.join(repoRoot, ".tmp", "web-e2e-captures");
const latestScreenshot = path.join(captureDir, "latest-web-local-runtime.png");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition: unknown, message: string, details?: unknown): asserts condition {
  if (!condition) {
    throw new Error(`${message}${details === undefined ? "" : `: ${JSON.stringify(details)}`}`);
  }
}

async function findFreePort(start: number) {
  const failures: string[] = [];
  for (let port = start; port < start + 100; port += 1) {
    const ok = await new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", (error) => {
        failures.push(`${port}:${("code" in error ? error.code : undefined) ?? error.message}`);
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

async function waitForHttp(url: string, label: string, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Server is still booting.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}: ${url}`);
}

function tail(lines: string[], max = 80) {
  return lines.slice(Math.max(0, lines.length - max)).join("");
}

function chromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter((candidate): candidate is string => typeof candidate === "string");
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error("No Chrome-compatible browser found. Set CHROME_BIN to run web E2E.");
  }
  return found;
}

function viteCli() {
  const localVite = path.join(webDir, "node_modules", "vite", "bin", "vite.js");
  if (existsSync(localVite)) return localVite;
  const rootVite = path.join(repoRoot, "node_modules", "vite", "bin", "vite.js");
  if (existsSync(rootVite)) return rootVite;
  throw new Error("Vite CLI not found. Run dependency install before web E2E.");
}

async function waitForTarget(cdpPort: number) {
  const url = `http://127.0.0.1:${cdpPort}/json/list`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const targets = await res.json() as Array<{ type: string; webSocketDebuggerUrl?: string }>;
        const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch {
      // CDP is still booting.
    }
    await sleep(200);
  }
  throw new Error("Timed out waiting for Chrome CDP target");
}

async function evaluate<T = unknown>(cdp: CdpClient, expression: string): Promise<T> {
  const result = await cdp.send<{ result: { value: T }; exceptionDetails?: { text?: string } }>("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "Runtime evaluation failed");
  }
  return result.result.value;
}

async function waitFor<T = unknown>(cdp: CdpClient, expression: string, label: string, timeoutMs = 12000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate<T>(cdp, expression);
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function click(cdp: CdpClient, selectorExpression: string, label: string) {
  return waitFor(
    cdp,
    `(() => {
      const el = (${selectorExpression});
      if (!el) return false;
      el.scrollIntoView({ block: "center", inline: "center" });
      el.click();
      return true;
    })()`,
    `click ${label}`,
  );
}

function clickableByText(label: string) {
  return `([...document.querySelectorAll("a, button, [role='button'], [role='tab']")].find((el) => {
    const text = (el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim();
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return text === ${JSON.stringify(label)} &&
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden";
  }))`;
}

async function typeChatMessage(cdp: CdpClient, text: string) {
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
  if (!inserted) throw new Error("Could not type into chat editor");
}

async function installHostMutationObserver(cdp: CdpClient) {
  await evaluate(cdp, `(() => {
    window.__CLASH_HOST_MUTATION_EVENTS__ = [];
    window.addEventListener("clash:host-mutation", (event) => {
      window.__CLASH_HOST_MUTATION_EVENTS__.push({
        projectId: event.detail?.projectId ?? null,
        mutation: event.detail?.mutation ?? null,
      });
    });
    return true;
  })()`);
}

async function readHostMutationEvents(cdp: CdpClient) {
  return evaluate<Array<{ mutation?: { accepted?: boolean; operation?: string; entity?: { kind?: string }; beforeReadToken?: string; error?: string } }>>(cdp, `(() => window.__CLASH_HOST_MUTATION_EVENTS__ ?? [])()`);
}

async function capture(cdp: CdpClient, targetPath = latestScreenshot) {
  await mkdir(captureDir, { recursive: true });
  const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await writeFile(targetPath, Buffer.from(shot.data, "base64"));
}

async function exerciseLocalRuntimeUi(cdp: CdpClient) {
  await waitFor(cdp, `document.body.innerText.includes("Home")`, "home");
  const runtime = await evaluate<{ apiBaseUrl?: string } | null>(cdp, `window.__CLASH_RUNTIME_CONFIG__ ?? null`);
  assert(runtime?.apiBaseUrl, "web runtime config was injected", runtime);

  await click(cdp, clickableByText("Projects"), "Projects");
  await waitFor(cdp, `location.pathname === "/projects"`, "projects page");
  await click(cdp, clickableByText("New Project"), "New Project");
  await waitFor(
    cdp,
    `location.pathname.startsWith("/projects/") && location.pathname !== "/projects" && !!document.querySelector("#editor-header")`,
    "project editor",
    15000,
  );
  await installHostMutationObserver(cdp);

  const hasRuntimePickerButton = await evaluate(cdp, `(() => {
    const button = document.querySelector("button[aria-label='Run on (Cloud / local runtime)']") ||
      document.querySelector("button[aria-label='运行环境（云端 / 本地）']");
    if (!button) return false;
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden";
  })()`);

  if (hasRuntimePickerButton) {
    await click(
      cdp,
      `document.querySelector("button[aria-label='Run on (Cloud / local runtime)']") ||
        document.querySelector("button[aria-label='运行环境（云端 / 本地）']")`,
      "Run on runtime picker",
    );
    await click(
      cdp,
      `([...document.querySelectorAll("[role='menuitem'], button")].find((el) => {
        const text = (el.innerText || el.textContent || "").trim();
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return text.includes("Mock Desktop") &&
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden";
      }))`,
      "Mock Desktop runtime",
    );
    await waitFor(cdp, `document.body.innerText.includes("Start local helper on Mock Desktop")`, "runtime picker dialog");
    await click(cdp, clickableByText("Start helper"), "Start helper");
    await waitFor(
      cdp,
      `document.body.innerText.includes("Local agent connected") ||
        document.body.innerText.includes("本地 Agent 已连接") ||
        document.body.innerText.includes("Mock ACP")`,
      "local runtime connected",
      15000,
    );
  } else {
    await waitFor(
      cdp,
      `document.body.innerText.includes("Mock ACP")`,
      "default mock ACP runtime selected",
      15000,
    );
  }

  const prompt = "hello web runtime helper";
  await typeChatMessage(cdp, prompt);
  await click(
    cdp,
    `([...document.querySelectorAll("button")].find((button) => {
      const label = (button.getAttribute("aria-label") || "").toLowerCase();
      const rect = button.getBoundingClientRect();
      return (label.includes("send") || label.includes("发送")) &&
        !button.disabled &&
        rect.width > 0 &&
        rect.height > 0;
    }))`,
    "Send runtime prompt",
  );
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
  await waitFor(
    cdp,
    `(() => {
      const projectId = location.pathname.split("/").filter(Boolean).at(-1);
      const events = window.__CLASH_HOST_MUTATION_EVENTS__ ?? [];
      return events.some((event) =>
        event?.projectId === projectId &&
        event?.mutation?.accepted === true &&
        event?.mutation?.operation === "canvas_add_node" &&
        event?.mutation?.entity?.kind === "canvas-node" &&
        typeof event?.mutation?.resultEntityId === "string" &&
        typeof event?.mutation?.afterReadToken === "string"
      );
    })()`,
    "browser-visible host mutation event",
    15000,
  );
  await waitFor(
    cdp,
    `(() => {
      const projectId = location.pathname.split("/").filter(Boolean).at(-1);
      const events = window.__CLASH_HOST_MUTATION_EVENTS__ ?? [];
      return events.some((event) =>
        event?.projectId === projectId &&
        event?.mutation?.accepted === true &&
        event?.mutation?.operation === "canvas_delete" &&
        event?.mutation?.entity?.kind === "canvas-node" &&
        typeof event?.mutation?.resultEntityId === "string"
      );
    })()`,
    "browser-visible host node delete mutation event",
    15000,
  );
  await waitFor(
    cdp,
    `(() => {
      const projectId = location.pathname.split("/").filter(Boolean).at(-1);
      const events = window.__CLASH_HOST_MUTATION_EVENTS__ ?? [];
      return events.some((event) =>
        event?.projectId === projectId &&
        event?.mutation?.accepted === false &&
        event?.mutation?.operation === "canvas_delete" &&
        event?.mutation?.entity?.kind === "canvas-node" &&
        typeof event?.mutation?.beforeReadToken === "string" &&
        typeof event?.mutation?.error === "string" &&
        event.mutation.error.includes("Missing canvas delete read proof")
      );
    })()`,
    "browser-visible rejected agent node delete without read proof",
    15000,
  );
  await waitFor(
    cdp,
    `(() => {
      const projectId = location.pathname.split("/").filter(Boolean).at(-1);
      const events = window.__CLASH_HOST_MUTATION_EVENTS__ ?? [];
      return events.some((event) =>
        event?.projectId === projectId &&
        event?.mutation?.accepted === true &&
        event?.mutation?.operation === "canvas_add_edge" &&
        event?.mutation?.entity?.kind === "canvas-edge" &&
        typeof event?.mutation?.resultEntityId === "string"
      );
    })()`,
    "browser-visible host edge mutation event",
    15000,
  );
  await waitFor(
    cdp,
    `(() => {
      const projectId = location.pathname.split("/").filter(Boolean).at(-1);
      const events = window.__CLASH_HOST_MUTATION_EVENTS__ ?? [];
      return events.some((event) =>
        event?.projectId === projectId &&
        event?.mutation?.accepted === true &&
        event?.mutation?.operation === "canvas_update_edge" &&
        event?.mutation?.entity?.kind === "canvas-edge" &&
        typeof event?.mutation?.resultEntityId === "string"
      );
    })()`,
    "browser-visible host edge update mutation event",
    15000,
  );
  await waitFor(
    cdp,
    `(() => {
      const projectId = location.pathname.split("/").filter(Boolean).at(-1);
      const events = window.__CLASH_HOST_MUTATION_EVENTS__ ?? [];
      return events.some((event) =>
        event?.projectId === projectId &&
        event?.mutation?.accepted === true &&
        event?.mutation?.operation === "canvas_delete_edge" &&
        event?.mutation?.entity?.kind === "canvas-edge" &&
        typeof event?.mutation?.resultEntityId === "string"
      );
    })()`,
    "browser-visible host edge delete mutation event",
    15000,
  );
  await waitFor(
    cdp,
    `(() => {
      const projectId = location.pathname.split("/").filter(Boolean).at(-1);
      const events = window.__CLASH_HOST_MUTATION_EVENTS__ ?? [];
      return events.some((event) =>
        event?.projectId === projectId &&
        event?.mutation?.accepted === true &&
        event?.mutation?.operation === "timeline_apply" &&
        event?.mutation?.entity?.kind === "timeline" &&
        typeof event?.mutation?.resultEntityId === "string" &&
        typeof event?.mutation?.afterReadToken === "string"
      );
    })()`,
    "browser-visible host timeline apply mutation event",
    15000,
  );

  const hostMutationEvents = await readHostMutationEvents(cdp);
  const acceptedNodeMutations = hostMutationEvents.filter((event) =>
    event?.mutation?.accepted === true &&
    event?.mutation?.operation === "canvas_add_node" &&
    event?.mutation?.entity?.kind === "canvas-node"
  );
  assert(
    acceptedNodeMutations.length > 0,
    "ProjectEditor emitted browser-visible host mutation events",
    hostMutationEvents,
  );
  const acceptedNodeDeleteMutations = hostMutationEvents.filter((event) =>
    event?.mutation?.accepted === true &&
    event?.mutation?.operation === "canvas_delete" &&
    event?.mutation?.entity?.kind === "canvas-node"
  );
  assert(
    acceptedNodeDeleteMutations.length > 0,
    "ProjectEditor emitted browser-visible host node delete mutation events",
    hostMutationEvents,
  );
  const rejectedNodeDeleteReadProofMutations = hostMutationEvents.filter((event) =>
    event?.mutation?.accepted === false &&
    event?.mutation?.operation === "canvas_delete" &&
    event?.mutation?.entity?.kind === "canvas-node" &&
    typeof event?.mutation?.beforeReadToken === "string" &&
    typeof event?.mutation?.error === "string" &&
    event.mutation.error.includes("Missing canvas delete read proof")
  );
  assert(
    rejectedNodeDeleteReadProofMutations.length > 0,
    "ProjectEditor rejected browser-visible agent node delete without read proof",
    hostMutationEvents,
  );
  const acceptedEdgeMutations = hostMutationEvents.filter((event) =>
    event?.mutation?.accepted === true &&
    event?.mutation?.operation === "canvas_add_edge" &&
    event?.mutation?.entity?.kind === "canvas-edge"
  );
  assert(
    acceptedEdgeMutations.length > 0,
    "ProjectEditor emitted browser-visible host edge mutation events",
    hostMutationEvents,
  );
  const acceptedEdgeUpdateMutations = hostMutationEvents.filter((event) =>
    event?.mutation?.accepted === true &&
    event?.mutation?.operation === "canvas_update_edge" &&
    event?.mutation?.entity?.kind === "canvas-edge"
  );
  assert(
    acceptedEdgeUpdateMutations.length > 0,
    "ProjectEditor emitted browser-visible host edge update mutation events",
    hostMutationEvents,
  );
  const acceptedEdgeDeleteMutations = hostMutationEvents.filter((event) =>
    event?.mutation?.accepted === true &&
    event?.mutation?.operation === "canvas_delete_edge" &&
    event?.mutation?.entity?.kind === "canvas-edge"
  );
  assert(
    acceptedEdgeDeleteMutations.length > 0,
    "ProjectEditor emitted browser-visible host edge delete mutation events",
    hostMutationEvents,
  );
  const acceptedTimelineMutations = hostMutationEvents.filter((event) =>
    event?.mutation?.accepted === true &&
    event?.mutation?.operation === "timeline_apply" &&
    event?.mutation?.entity?.kind === "timeline"
  );
  assert(
    acceptedTimelineMutations.length > 0,
    "ProjectEditor emitted browser-visible host timeline apply mutation events",
    hostMutationEvents,
  );

  return evaluate(cdp, `({
    href: location.href,
    text: document.body.innerText.slice(0, 800),
    runtime: window.__CLASH_RUNTIME_CONFIG__ ?? null,
    nodes: [...document.querySelectorAll(".react-flow__node")].map((node) => ({
      id: node.getAttribute("data-id"),
      text: ((node.querySelector("input")?.value || "") + " " + (node.innerText || node.textContent || "")).trim().slice(0, 180),
    })).filter((node) =>
      (node.id || "").includes("mock-agent-stage-") ||
      node.text.includes("Agent Brief") ||
      node.text.includes("Agent Image Pass")
    ),
    hostMutationEvents: (window.__CLASH_HOST_MUTATION_EVENTS__ ?? []).map((event) => ({
      projectId: event.projectId,
      operation: event.mutation?.operation,
      accepted: event.mutation?.accepted,
      entity: event.mutation?.entity,
      resultEntityId: event.mutation?.resultEntityId,
      hasAfterReadToken: typeof event.mutation?.afterReadToken === "string",
      hasBeforeReadToken: typeof event.mutation?.beforeReadToken === "string",
      error: event.mutation?.error,
    })),
  })`);
}

async function stopProcess(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    sleep(3000).then(() => false),
  ]);
  if (!exited) child.kill("SIGKILL");
}

async function closeServer(server: ClosableServer) {
  await new Promise((resolve) => server.close(resolve));
}

async function main() {
  process.env.CLASH_E2E_STUB_ACP = "1";
  await rm(dataDir, { recursive: true, force: true });
  await rm(chromeDataDir, { recursive: true, force: true });

  const apiPort = await findFreePort(49600);
  const webPort = await findFreePort(49650);
  const cdpPort = await findFreePort(49700);
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const webOrigin = `http://127.0.0.1:${webPort}`;

  const { startLocalApiServer } = await loadHostServer();
  const apiServer = await startLocalApiServer({ port: apiPort, dataDir });
  const webLogs: string[] = [];
  const chromeLogs: string[] = [];
  let web;
  let chrome;
  let cdp;

  try {
    web = spawn(process.execPath, [viteCli(), "--host", "127.0.0.1", "--port", String(webPort)], {
      cwd: webDir,
      env: {
        ...process.env,
        VITE_CLASH_API_BASE_URL: apiOrigin,
        VITE_CLASH_WS_BASE_URL: apiOrigin.replace("http:", "ws:"),
        CLASH_WEB_E2E_NO_CLOUDFLARE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    web.stdout.on("data", (buf) => {
      const text = String(buf);
      webLogs.push(text);
      process.stdout.write(text);
    });
    web.stderr.on("data", (buf) => {
      const text = String(buf);
      webLogs.push(text);
      process.stderr.write(text);
    });
    await waitForHttp(webOrigin, "Vite web server");

    chrome = spawn(chromeBinary(), [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${chromeDataDir}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-renderer-backgrounding",
      "--window-size=1440,1000",
      "about:blank",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    chrome.stdout.on("data", (buf) => chromeLogs.push(String(buf)));
    chrome.stderr.on("data", (buf) => chromeLogs.push(String(buf)));

    cdp = new CdpClient(await waitForTarget(cdpPort));
    await cdp.ready();
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url: webOrigin });
    const state = await exerciseLocalRuntimeUi(cdp);
    await capture(cdp);
    console.log("[web-smoke] local runtime", JSON.stringify(state));
    console.log(`[web-smoke] screenshot ${latestScreenshot}`);
  } catch (error) {
    if (cdp) {
      try {
        await capture(cdp);
        console.error(`[web-smoke] failure screenshot ${latestScreenshot}`);
      } catch {
        // Ignore capture failure while unwinding.
      }
    }
    console.error("[web-smoke] web logs\n" + tail(webLogs));
    console.error("[web-smoke] chrome logs\n" + tail(chromeLogs));
    throw error;
  } finally {
    if (cdp) cdp.close();
    await stopProcess(chrome);
    await stopProcess(web);
    await closeServer(apiServer);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
