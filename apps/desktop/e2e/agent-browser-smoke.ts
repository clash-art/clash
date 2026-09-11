import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertComposerToolbarLayout,
  clickButtonByLabel,
  clickComposerSubmitButton,
  observeComposerToolbarLayout,
  openSessionHistoryMenu,
  recoverAgentBrowserTarget,
  runtimeSessionPathObservation,
  startVite,
  submitProjectCreateDialog,
  typeComposer,
} from "./startup-shared.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const desktopDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");

const captureDir =
  process.env.CLASH_DESKTOP_AGENT_BROWSER_CAPTURE_DIR ??
  path.join(repoRoot, ".tmp", "agent-browser-desktop-captures");
const dataDir =
  process.env.CLASH_DESKTOP_AGENT_BROWSER_DATA_DIR ??
  path.join(repoRoot, ".tmp", "agent-browser-desktop-data");
const sessionName = `clash-desktop-agent-browser-${Date.now().toString(36)}`;
const latestScreenshot = path.join(
  captureDir,
  "latest-agent-browser-desktop.png",
);
const historyScreenshot = path.join(
  captureDir,
  "history-agent-browser-desktop.png",
);
const narrowLayoutScreenshot = path.join(
  captureDir,
  "narrow-layout-agent-browser-desktop.png",
);
const narrowComposerScreenshot = path.join(
  captureDir,
  "narrow-composer-agent-browser-desktop.png",
);
const collapsedNavigatorScreenshot = path.join(
  captureDir,
  "collapsed-navigator-agent-browser-desktop.png",
);
const populatedChromeScreenshot = path.join(
  captureDir,
  "populated-chrome-agent-browser-desktop.png",
);
const timelineDockScreenshot = path.join(
  captureDir,
  "timeline-dock-agent-browser-desktop.png",
);
const assetPreviewScreenshot = path.join(
  captureDir,
  "asset-preview-agent-browser-desktop.png",
);
const assetDragScreenshot = path.join(
  captureDir,
  "asset-drag-agent-browser-desktop.png",
);
const localSettingsScreenshot = path.join(
  captureDir,
  "local-settings-agent-browser-desktop.png",
);
const agentFollowScreenshot = path.join(
  captureDir,
  "agent-follow-agent-browser-desktop.png",
);
const transientUiScreenshot = path.join(
  captureDir,
  "canvas-transient-ui-agent-browser-desktop.png",
);
const toolbarTooltipScreenshot = path.join(
  captureDir,
  "canvas-toolbar-tooltip-agent-browser-desktop.png",
);
const popupInteractionsScreenshot = path.join(
  captureDir,
  "popup-interactions-agent-browser-desktop.png",
);
const scopedAssetPickerScreenshot = path.join(
  captureDir,
  "scoped-asset-picker-agent-browser-desktop.png",
);
let electronTargetRecovery = null;
let electronCdpPort: number | null = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  throw new Error(
    `No free port found from ${start}. Last bind errors: ${failures.slice(-5).join(", ")}`,
  );
}

async function waitForHttp(url, label) {
  const deadline = Date.now() + 30000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(
    `${label} did not become reachable at ${url}: ${lastError?.message ?? lastError}`,
  );
}

async function waitForCdpPageTarget(
  cdpPort,
  expectedUrlPrefix,
  timeoutMs = 65_000,
) {
  const url = `http://127.0.0.1:${cdpPort}/json/list`;
  const deadline = Date.now() + timeoutMs;
  let lastTargets = [];
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        const targets = await res.json();
        lastTargets = Array.isArray(targets) ? targets : [];
        const page = lastTargets.find(
          (target) =>
            target?.type === "page" &&
            typeof target.url === "string" &&
            target.url.startsWith(expectedUrlPrefix) &&
            typeof target.webSocketDebuggerUrl === "string",
        );
        if (page) return page;
      }
    } catch {
      // Electron may expose the browser endpoint before creating its window.
    }
    await sleep(250);
  }
  throw new Error(
    `Electron page target did not become available at ${expectedUrlPrefix}: ${JSON.stringify(lastTargets)}`,
  );
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    sleep(3000).then(() => false),
  ]);
  if (!exited) child.kill("SIGKILL");
}

function tail(lines, max = 100) {
  return lines.slice(Math.max(0, lines.length - max)).join("");
}

const forbiddenRendererPatterns = [
  /Cannot update a component .* while rendering a different component/,
  /Maximum update depth exceeded/,
  /Rendered (?:fewer|more) hooks than expected/,
  /Invalid hook call/,
  /Minified React error #/,
];

function assertNoForbiddenRendererIssues(logs) {
  const text = logs.join("");
  const matched = forbiddenRendererPatterns.find((pattern) =>
    pattern.test(text),
  );
  if (!matched) return;
  const lines = text
    .split(/\r?\n/)
    .filter((line) =>
      forbiddenRendererPatterns.some((pattern) => pattern.test(line)),
    );
  throw new Error(
    `Forbidden renderer issue matched ${matched}: ${lines.slice(-5).join("\n")}`,
  );
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function agentBrowser(args, opts = {}) {
  let result;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const directCdpArgs =
      electronCdpPort !== null && args[0] !== "connect" && args[0] !== "close"
        ? ["--cdp", String(electronCdpPort)]
        : [];
    result = spawnSync(
      "agent-browser",
      ["--session", sessionName, ...directCdpArgs, ...args],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          AGENT_BROWSER_SCREENSHOT_DIR: captureDir,
        },
      },
    );
    if (result.status === 0) break;
    if (!String(result.stderr).includes("Resource temporarily unavailable"))
      break;
    sleepSync(250);
  }
  if (!opts.allowFailure && result.status !== 0) {
    throw new Error(
      `agent-browser ${args.join(" ")} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function parseEvalOutput(stdout) {
  const trimmed = stdout.trim();
  if (trimmed) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall back to the final non-empty line for primitive outputs that
      // include command status chatter.
    }
  }
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  try {
    return JSON.parse(last);
  } catch (error) {
    throw new Error(
      `Could not parse agent-browser eval output as JSON:\n${stdout}\n${error.message}`,
    );
  }
}

function evalJson(expression) {
  return parseEvalOutput(agentBrowser(["eval", expression]));
}

async function waitForEval(expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    try {
      lastValue = evalJson(expression);
      if (lastValue) return lastValue;
      if (
        electronTargetRecovery &&
        evalJson("location.href") === "about:blank"
      ) {
        recoverAgentBrowserTarget(agentBrowser, electronTargetRecovery);
      }
    } catch (error) {
      if (!electronTargetRecovery) throw error;
      lastValue = `eval failed: ${error instanceof Error ? error.message : String(error)}`;
      recoverAgentBrowserTarget(agentBrowser, electronTargetRecovery);
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for ${label}; last value: ${JSON.stringify(lastValue)}`,
  );
}

function clickVisibleLinkOrButtonByText(text) {
  return evalJson(`(() => {
    const el = [...document.querySelectorAll("a, button, [role='button'], [role='tab']")].find((candidate) => {
      const value = (candidate.innerText || candidate.textContent || "").trim();
      const rect = candidate.getBoundingClientRect();
      const style = getComputedStyle(candidate);
      return value === ${JSON.stringify(text)} &&
        rect.width > 0 && rect.height > 0 &&
        style.display !== "none" && style.visibility !== "hidden" &&
        !candidate.disabled;
    });
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "center" });
    el.click();
    return true;
  })()`);
}

function clickHistoryMenuItemByText(text) {
  return evalJson(`(() => {
    const wanted = ${JSON.stringify(text)};
    const menu = document.querySelector('[role="menu"][aria-label="Session history"], [role="menu"][aria-label="历史会话"]');
    const root = menu || document;
    const item = [...root.querySelectorAll("[role='menuitem']")].find((candidate) => {
      const value = (candidate.innerText || candidate.textContent || "").trim();
      const rect = candidate.getBoundingClientRect();
      const style = getComputedStyle(candidate);
      return value.includes(wanted) &&
        rect.width > 0 && rect.height > 0 &&
        style.display !== "none" && style.visibility !== "hidden" &&
        candidate.getAttribute("aria-disabled") !== "true";
    });
    if (!item) return false;
    item.scrollIntoView({ block: "center", inline: "center" });
    const pointerInit = { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true };
    const mouseInit = { bubbles: true, cancelable: true, button: 0 };
    item.dispatchEvent(new PointerEvent("pointerdown", pointerInit));
    item.dispatchEvent(new MouseEvent("mousedown", mouseInit));
    item.dispatchEvent(new PointerEvent("pointerup", pointerInit));
    item.dispatchEvent(new MouseEvent("mouseup", mouseInit));
    item.click();
    return true;
  })()`);
}

async function sendPrompt(text) {
  if (!typeComposer(agentBrowser, text))
    throw new Error("Could not type into composer");
  const clickedSend = clickComposerSubmitButton(agentBrowser);
  if (!clickedSend) {
    throw new Error("Could not click send button");
  }
  if (!electronTargetRecovery) {
    throw new Error("Electron target recovery is not configured");
  }
  recoverAgentBrowserTarget(agentBrowser, electronTargetRecovery);
  await waitForEval(
    `document.body.innerText.includes(${JSON.stringify(text)}) &&
       document.body.innerText.includes(${JSON.stringify(`Mock ACP reply: ${text}`)})`,
    `mock ACP reply for ${text}`,
    45000,
  );
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function assertRuntimeHistory(projectId, apiOrigin, expectedCount) {
  const deadline = Date.now() + 20000;
  let lastState = null;
  while (Date.now() < deadline) {
    const sessions = await fetchJson(
      `${apiOrigin}/api/v1/sessions?projectId=${encodeURIComponent(projectId)}`,
    );
    const runtimeSessions = (sessions.sessions || sessions || []).filter(
      (session) => session.type === "runtime",
    );
    const sessionsWithPaths = [];
    for (const session of runtimeSessions) {
      const eventPath = `${apiOrigin}/api/v1/local-sessions/${encodeURIComponent(session.threadId || session.id)}/events`;
      const history = await fetchJson(eventPath);
      sessionsWithPaths.push(
        {
          ...runtimeSessionPathObservation({
            session,
            projectId,
            apiOrigin,
            dataDir,
            messageCount: (history.events || []).length,
          }),
          apiPath: eventPath,
        },
      );
    }
    lastState = {
      count: runtimeSessions.length,
      sessions: sessionsWithPaths,
    };
    if (
      runtimeSessions.length >= expectedCount &&
      sessionsWithPaths.every((session) => session.messageCount >= 2)
    ) {
      return lastState;
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for runtime history ${expectedCount}: ${JSON.stringify(lastState)}`,
  );
}

async function main() {
  if (
    !spawnSync("agent-browser", ["--help"], {
      encoding: "utf8",
    }).stdout.includes("agent-browser")
  ) {
    throw new Error("agent-browser CLI is not available");
  }

  process.env.CLASH_E2E_STUB_ACP = "1";
  await rm(dataDir, { recursive: true, force: true });
  await rm(captureDir, { recursive: true, force: true });
  await mkdir(captureDir, { recursive: true });

  const webPort = await findFreePort(49870);
  const apiPort = await findFreePort(49920);
  const cdpPort = await findFreePort(49970);
  electronCdpPort = cdpPort;
  const webOrigin = `http://127.0.0.1:${webPort}`;

  const webLogs = [];
  const electronLogs = [];
  let web;
  let electron;

  try {
    web = await startVite({ webPort, logs: webLogs });

    await waitForHttp(webOrigin, "Vite desktop-runtime web shell");

    const electronBin = require("electron");
    electron = spawn(
      electronBin,
      [`--remote-debugging-port=${cdpPort}`, desktopDir],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CLASH_WEB_URL: webOrigin,
          CLASH_E2E_STUB_ACP: "1",
          CLASH_LOCAL_DATA_DIR: dataDir,
          CLASH_LOCAL_API_PORT: String(apiPort),
          CLASH_DESKTOP_CAPTURE_DIR: captureDir,
          CLASH_DESKTOP_HOST_STARTUP_TIMEOUT_MS: "60000",
          CLASH_DESKTOP_SOURCE_HOST_WATCH: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    electron.stdout.on("data", (buf) => {
      const text = String(buf);
      electronLogs.push(text);
      process.stdout.write(text);
    });
    electron.stderr.on("data", (buf) => {
      const text = String(buf);
      electronLogs.push(text);
      process.stderr.write(text);
    });
    await waitForHttp(
      `http://127.0.0.1:${cdpPort}/json/version`,
      "Electron CDP",
    );

    electronTargetRecovery = {
      cdpPort,
      expectedUrlPrefix: `http://127.0.0.1:${webPort}/`,
    };
    await waitForCdpPageTarget(
      cdpPort,
      electronTargetRecovery.expectedUrlPrefix,
    );
    recoverAgentBrowserTarget(agentBrowser, electronTargetRecovery);
    await waitForEval(`document.body.innerText.includes("Home")`, "home page");
    const runtime = await waitForEval(
      `(() => window.__CLASH_RUNTIME_CONFIG__?.apiBaseUrl ? window.__CLASH_RUNTIME_CONFIG__ : false)()`,
      "Electron desktop runtime config",
    );
    const apiOrigin = runtime.apiBaseUrl;

    if (!clickVisibleLinkOrButtonByText("Projects"))
      throw new Error("Could not open Projects");
    await waitForEval(`location.pathname === "/projects"`, "projects route");
    if (!clickVisibleLinkOrButtonByText("New Project"))
      throw new Error("Could not create project");
    await submitProjectCreateDialog(agentBrowser, "Stub Desktop E2E");
    const projectId = await waitForEval(
      `location.pathname.startsWith("/projects/") &&
        location.pathname !== "/projects" &&
        location.pathname.split("/").pop()`,
      "project editor route",
      20000,
    );
    const seededAssetForm = new FormData();
    seededAssetForm.set(
      "file",
      new File(
        [
          Uint8Array.from(
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
              "base64",
            ),
          ).buffer,
        ],
        "explicit-target.png",
        { type: "image/png" },
      ),
    );
    seededAssetForm.set("kind", "image");
    seededAssetForm.set(
      "projectAssetId",
      "asset:desktop-smoke:explicit-target",
    );
    const seededAssetResponse = await fetch(
      `${apiOrigin}/api/v1/projects/${encodeURIComponent(projectId)}/assets/import-file`,
      {
        method: "POST",
        body: seededAssetForm,
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!seededAssetResponse.ok) {
      throw new Error(
        `Could not seed project asset: HTTP ${seededAssetResponse.status}`,
      );
    }
    const seededAsset = await seededAssetResponse.json();
    const seededAssetElementId = `project-asset-${seededAsset.id}`;
    const seededAssetSelector = `[id=${JSON.stringify(seededAssetElementId)}]`;
    agentBrowser(["eval", "location.reload()"], { allowFailure: true });
    await sleep(750);
    recoverAgentBrowserTarget(agentBrowser, electronTargetRecovery);
    await waitForEval(
      `document.querySelector('[aria-controls="project-assets-list"]')?.getAttribute('aria-expanded') === 'true' &&
       !!document.querySelector(${JSON.stringify(seededAssetSelector)})`,
      "project detail with complete asset list",
      20000,
    );
    await waitForEval(
      `document.body.innerText.includes("Mock ACP")`,
      "mock ACP runtime ready",
      20000,
    );
    await waitForEval(
      `!!document.querySelector('[aria-label="Canvas tools"] [aria-label="Assets"]')`,
      "Canvas asset tool ready",
      20000,
    );

    if (
      !evalJson(`(() => {
      const button = document.querySelector('[aria-label="Canvas tools"] button[aria-label="Assets"]');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`)
    ) {
      throw new Error("Could not open the Canvas asset picker");
    }
    await waitForEval(
      `(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const tabs = [...(dialog?.querySelectorAll('[role="tab"]') ?? [])].map((node) => node.textContent?.trim());
        return !!dialog?.querySelector('[data-layout="command-grid"]') &&
          !!dialog.querySelector('input[type="search"][aria-label="Search media"]') &&
          tabs.includes('Project') && tabs.includes('More sources') &&
          !tabs.includes('Current Canvas');
      })()`,
      "large Canvas command-grid asset picker",
      10000,
    );
    agentBrowser(["screenshot", scopedAssetPickerScreenshot]);
    agentBrowser(["press", "Escape"]);

    const sessionConfigSelector =
      '[data-testid="session-harness-config-trigger"]';
    const sessionHistorySelector = '[aria-label="Session history"]';
    agentBrowser(["click", sessionConfigSelector]);
    await waitForEval(
      `document.querySelector(${JSON.stringify(sessionConfigSelector)})?.getAttribute('data-state') === 'open'`,
      "session config menu open",
    );
    agentBrowser(["click", sessionConfigSelector]);
    await waitForEval(
      `document.querySelector(${JSON.stringify(sessionConfigSelector)})?.getAttribute('data-state') === 'closed' &&
       !document.querySelector('[role="menu"][data-state="open"]')`,
      "session config menu closed by its trigger",
    );

    let popupInteractions;

    const firstPrompt = "agent-browser desktop first turn";
    const secondPrompt = "agent-browser desktop fresh turn";
    if (
      !clickButtonByLabel(agentBrowser, "Follow agent actions") &&
      !clickButtonByLabel(agentBrowser, "跟随 Agent 操作")
    ) {
      throw new Error("Could not enable agent follow mode");
    }
    await waitForEval(
      `document.querySelector('#project-workspace-shell')?.getAttribute('data-following-agent') === 'true' &&
       document.querySelector('[aria-label="Stop following agent"], [aria-label="停止跟随 Agent"]')?.getAttribute('aria-pressed') === 'true'`,
      "active agent follow mode",
      10000,
    );
    await sendPrompt(firstPrompt);
    agentBrowser(["click", sessionConfigSelector]);
    await waitForEval(
      `document.querySelector(${JSON.stringify(sessionConfigSelector)})?.getAttribute('data-state') === 'open'`,
      "session config menu reopened",
    );
    agentBrowser(["click", sessionHistorySelector]);
    popupInteractions = await waitForEval(
      `(() => {
        const sessionConfig = document.querySelector(${JSON.stringify(sessionConfigSelector)});
        const sessionHistory = document.querySelector(${JSON.stringify(sessionHistorySelector)});
        const openMenus = [...document.querySelectorAll('[role="menu"][data-state="open"]')];
        if (sessionConfig?.getAttribute('data-state') !== 'closed') return false;
        if (sessionHistory?.getAttribute('data-state') !== 'open') return false;
        if (openMenus.length !== 1) return false;
        return {
          sameTriggerToggle: true,
          crossTriggerSwitch: true,
          openMenuCount: openMenus.length,
          activeTrigger: sessionHistory.getAttribute('aria-label'),
        };
      })()`,
      "single-action popup trigger switch",
    );
    agentBrowser(["screenshot", popupInteractionsScreenshot]);
    agentBrowser(["press", "Escape"]);
    await waitForEval(
      `document.querySelector(${JSON.stringify(sessionHistorySelector)})?.getAttribute('data-state') === 'closed' &&
       !document.querySelector('[role="menu"][data-state="open"]')`,
      "popup dismissed with Escape",
    );
    const agentFollow = await waitForEval(
      `(() => {
        const shell = document.querySelector('#project-workspace-shell');
        const flow = document.querySelector('#project-workspace-inset .react-flow')?.getBoundingClientRect();
        const target = [...document.querySelectorAll('[data-id^="mock-agent-action-"]')].at(-1)?.getBoundingClientRect();
        const toggle = document.querySelector('[aria-label="Stop following agent"], [aria-label="停止跟随 Agent"]');
        const panelElement = document.querySelector('#clash-copilot-panel');
        const panel = panelElement?.getBoundingClientRect();
        if (!shell || !flow || !target || !toggle) return false;
        if (shell.getAttribute('data-following-agent') !== 'true' || toggle.getAttribute('aria-pressed') !== 'true') return false;
        const panelCoversCanvas = panelElement?.getAttribute('aria-hidden') !== 'true' && panel &&
          panel.left > flow.left && panel.left < flow.right && panel.bottom > flow.top && panel.top < flow.bottom;
        const visibleRight = panelCoversCanvas ? panel.left - 12 : flow.right;
        const deltaX = Math.abs((target.left + target.width / 2) - (flow.left + (visibleRight - flow.left) / 2));
        const deltaY = Math.abs((target.top + target.height / 2) - (flow.top + flow.height / 2));
        if (deltaX > 80 || deltaY > 80) return false;
        return {
          targetId: [...document.querySelectorAll('[data-id^="mock-agent-action-"]')].at(-1)?.getAttribute('data-id'),
          deltaX: Math.round(deltaX),
          deltaY: Math.round(deltaY),
          active: true,
        };
      })()`,
      "agent-created node centered by follow mode",
      20000,
    );
    agentBrowser(["screenshot", agentFollowScreenshot]);

    const transientTargets = evalJson(`(() => {
      const lower = [...document.querySelectorAll('[data-id^="mock-agent-action-"]')].at(-1);
      const upper = [...document.querySelectorAll('[data-id^="mock-agent-brief-"]')].at(-1);
      return {
        lowerId: lower?.getAttribute('data-id') ?? null,
        upperId: upper?.getAttribute('data-id') ?? null,
      };
    })()`);
    if (!transientTargets.lowerId || !transientTargets.upperId) {
      throw new Error(
        `Could not identify action nodes for transient UI checks: ${JSON.stringify(transientTargets)}`,
      );
    }
    const configureSelector = (nodeId) =>
      `[data-id="${nodeId}"] button[aria-label="Configure action"]`;

    agentBrowser(["click", configureSelector(transientTargets.lowerId)]);
    await waitForEval(
      `document.querySelectorAll('[data-action-config-panel]').length === 1 &&
       !!document.querySelector(${JSON.stringify(`[data-action-config-panel="${transientTargets.lowerId}"]`)})`,
      "lower action config panel",
    );
    agentBrowser(["click", configureSelector(transientTargets.upperId)]);
    await waitForEval(
      `document.querySelectorAll('[data-action-config-panel]').length === 1 &&
       !!document.querySelector(${JSON.stringify(`[data-action-config-panel="${transientTargets.upperId}"]`)})`,
      "single action config owner after switching nodes",
    );
    const selectedCapsuleFill = await waitForEval(
      `(() => {
        const configure = document.querySelector(${JSON.stringify(configureSelector(transientTargets.upperId))});
        const capsule = configure?.parentElement?.parentElement;
        const runRegion = configure?.nextElementSibling;
        if (!configure || !capsule || !runRegion) return false;
        const configureBackground = getComputedStyle(configure).backgroundColor;
        const runRegionBackground = getComputedStyle(runRegion).backgroundColor;
        const capsuleBackground = getComputedStyle(capsule).backgroundColor;
        if (configureBackground !== runRegionBackground || capsuleBackground === 'rgba(0, 0, 0, 0)') return false;
        return {
          capsuleBackground,
          configureBackground,
          runRegionBackground,
          uniform: true,
        };
      })()`,
      "uniform selected action capsule fill",
    );

    const tooltipPoints = evalJson(`(() => {
      const flow = document.querySelector('#project-workspace-inset .react-flow')?.getBoundingClientRect();
      const actions = document.querySelector('[aria-label="Canvas tools"] [aria-label="Actions"]')?.getBoundingClientRect();
      if (!flow || !actions) return null;
      return {
        actions: {
          x: Math.round(actions.left + actions.width / 2),
          y: Math.round(actions.top + actions.height / 2),
        },
        exit: {
          x: Math.round(flow.right - 24),
          y: Math.round(flow.top + 24),
        },
      };
    })()`);
    if (!tooltipPoints)
      throw new Error("Could not calculate canvas toolbar tooltip points");
    agentBrowser([
      "mouse",
      "move",
      String(tooltipPoints.exit.x),
      String(tooltipPoints.exit.y),
    ]);
    agentBrowser([
      "mouse",
      "move",
      String(tooltipPoints.actions.x),
      String(tooltipPoints.actions.y),
    ]);
    const toolbarTooltip = await waitForEval(
      `(() => {
        const button = document.querySelector('[aria-label="Canvas tools"] [aria-label="Actions"]')?.getBoundingClientRect();
        const tooltipElement = [...document.querySelectorAll('[role="tooltip"]')].find((tooltip) => tooltip.textContent?.trim() === 'Actions');
        const tooltip = tooltipElement?.getBoundingClientRect();
        if (!button || !tooltip || tooltip.left < button.right + 6) return false;
        return {
          placement: tooltipElement.getAttribute('data-placement'),
          sideGap: Math.round((tooltip.left - button.right) * 10) / 10,
          verticallyAligned: tooltip.top < button.bottom && tooltip.bottom > button.top,
        };
      })()`,
      "right-side canvas toolbar tooltip",
    );
    agentBrowser(["screenshot", toolbarTooltipScreenshot]);
    agentBrowser([
      "mouse",
      "move",
      String(tooltipPoints.exit.x),
      String(tooltipPoints.exit.y),
    ]);
    await waitForEval(
      `![...document.querySelectorAll('[role="tooltip"]')].some((tooltip) => tooltip.textContent?.trim() === "Actions")`,
      "canvas toolbar tooltip dismissal",
    );

    agentBrowser([
      "click",
      '[aria-label="Canvas tools"] [aria-label="Actions"]',
    ]);
    await waitForEval(
      `!!document.querySelector('[role="menu"][aria-label="Actions tools"]') &&
       document.querySelectorAll('[data-action-config-panel]').length === 0`,
      "toolbar menu replacing node-owned overlay",
    );
    agentBrowser(["press", "Escape"]);

    agentBrowser(["click", configureSelector(transientTargets.upperId)]);
    await waitForEval(
      `!!document.querySelector(${JSON.stringify(`[data-action-config-panel="${transientTargets.upperId}"]`)})`,
      "action panel before live drag",
    );
    const dragPoints = evalJson(`(() => {
      const flow = document.querySelector('#project-workspace-inset .react-flow')?.getBoundingClientRect();
      const node = document.querySelector(${JSON.stringify(`[data-id="${transientTargets.upperId}"]`)})?.getBoundingClientRect();
      if (!flow || !node) return null;
      const start = { x: Math.round(node.left + 18), y: Math.round(node.top + node.height / 2) };
      const direction = start.x < flow.left + flow.width / 2 ? 140 : -140;
      return {
        start,
        target: {
          x: Math.round(Math.max(flow.left + 80, Math.min(flow.right - 80, start.x + direction))),
          y: Math.round(Math.max(flow.top + 80, Math.min(flow.bottom - 180, start.y - 70))),
        },
        initialNodeLeft: Math.round(node.left),
        initialNodeTop: Math.round(node.top),
      };
    })()`);
    if (!dragPoints) throw new Error("Could not calculate action drag points");

    let transientUi;
    agentBrowser([
      "mouse",
      "move",
      String(dragPoints.start.x),
      String(dragPoints.start.y),
    ]);
    agentBrowser(["mouse", "down", "left"]);
    try {
      agentBrowser([
        "mouse",
        "move",
        String(Math.round((dragPoints.start.x + dragPoints.target.x) / 2)),
        String(Math.round((dragPoints.start.y + dragPoints.target.y) / 2)),
      ]);
      agentBrowser([
        "mouse",
        "move",
        String(dragPoints.target.x),
        String(dragPoints.target.y),
      ]);
      transientUi = await waitForEval(
        `(() => {
          const node = document.querySelector(${JSON.stringify(`[data-id="${transientTargets.upperId}"]`)})?.getBoundingClientRect();
          const panel = document.querySelector(${JSON.stringify(`[data-action-config-panel="${transientTargets.upperId}"]`)})?.getBoundingClientRect();
          if (!node || !panel) return false;
          const moved = Math.hypot(node.left - ${Number(dragPoints.initialNodeLeft)}, node.top - ${Number(dragPoints.initialNodeTop)});
          const centerDelta = Math.abs((node.left + node.width / 2) - (panel.left + panel.width / 2));
          const verticalGap = panel.top - node.bottom;
          if (moved < 40 || centerDelta > 2 || Math.abs(verticalGap - 12) > 2) return false;
          return {
            ownerId: ${JSON.stringify(transientTargets.upperId)},
            panelCount: document.querySelectorAll('[data-action-config-panel]').length,
            moved: Math.round(moved),
            centerDelta: Math.round(centerDelta * 10) / 10,
            verticalGap: Math.round(verticalGap * 10) / 10,
            tooltipVisible: [...document.querySelectorAll('[role="tooltip"]')].some((tooltip) => tooltip.textContent?.trim() === "Actions"),
          };
        })()`,
        "action panel tracking a live node drag",
      );
      agentBrowser(["screenshot", transientUiScreenshot]);
    } finally {
      agentBrowser(["mouse", "up", "left"], { allowFailure: true });
    }

    agentBrowser(["click", seededAssetSelector]);
    await waitForEval(
      `document.querySelector('#project-workspace-shell')?.getAttribute('data-following-agent') === 'false' &&
       !!document.querySelector('[aria-label="Follow agent actions"], [aria-label="跟随 Agent 操作"]') &&
       !!document.querySelector(${JSON.stringify(`[aria-label="explicit-target.png preview"]`)})`,
      "manual project navigation stops agent follow mode",
      10000,
    );
    agentBrowser(["click", "#project-canvas-main"]);
    await waitForEval(
      `document.querySelector('#project-workspace-shell')?.getAttribute('data-copilot-layout') === 'overlay'`,
      "Main Canvas after manual follow takeover",
      10000,
    );
    const firstHistory = await assertRuntimeHistory(projectId, apiOrigin, 1);

    if (
      !clickButtonByLabel(agentBrowser, "New session") &&
      !clickButtonByLabel(agentBrowser, "新建会话")
    ) {
      throw new Error("Could not click New session");
    }
    await waitForEval(
      `!document.body.innerText.includes(${JSON.stringify(`Mock ACP reply: ${firstPrompt}`)})`,
      "fresh session cleared visible transcript",
      20000,
    );
    await sendPrompt(secondPrompt);
    const secondHistory = await assertRuntimeHistory(projectId, apiOrigin, 2);

    await openSessionHistoryMenu(agentBrowser);
    await waitForEval(
      `(() => {
        const menu = document.querySelector('[role="menu"][aria-label="Session history"], [role="menu"][aria-label="历史会话"]');
        const rect = menu?.getBoundingClientRect();
        return !!menu && !!rect && rect.width > 0 && rect.height > 0 &&
          !menu.innerText.toLowerCase().includes("no history yet");
      })()`,
      "session history panel",
      10000,
    );
    agentBrowser(["screenshot", historyScreenshot]);
    if (!clickHistoryMenuItemByText(firstPrompt)) {
      throw new Error("Could not restore the first session from history");
    }
    await waitForEval(
      `document.body.innerText.includes(${JSON.stringify(firstPrompt)}) &&
        document.body.innerText.includes(${JSON.stringify(`Mock ACP reply: ${firstPrompt}`)})`,
      "restored first session transcript",
      20000,
    );
    const restoredSession = firstHistory.sessions[0];
    if (!restoredSession?.id)
      throw new Error("Could not identify the restored first session");

    const projectStatusApiPath = `${apiOrigin}/api/v1/projects/${encodeURIComponent(projectId)}/status`;
    const projectStatus = await fetchJson(projectStatusApiPath);
    if (
      projectStatus.projectId !== projectId ||
      !projectStatus.runtimeRoot ||
      !Array.isArray(projectStatus.protectedPaths) ||
      !projectStatus.protectedPaths.includes(projectStatus.runtimeRoot)
    ) {
      throw new Error(
        `Project status path contract failed: ${JSON.stringify(projectStatus)}`,
      );
    }
    const projectStatusEvidence = {
      projectId: projectStatus.projectId,
      projectStore: projectStatus.projectStore,
      projectWorkspaceRoot: projectStatus.projectWorkspaceRoot,
      roots: projectStatus.roots,
      runtimeRoot: projectStatus.runtimeRoot,
      protectedPaths: projectStatus.protectedPaths,
      editablePaths: projectStatus.editablePaths,
      loro: projectStatus.loro,
      localSqlitePath: projectStatus.localSqlitePath,
    };

    const state = evalJson(`(() => ({
      href: location.href,
      projectId: ${JSON.stringify(projectId)},
      bodyText: document.body.innerText.slice(0, 1200),
      runtime: window.__CLASH_RUNTIME_CONFIG__ ?? null,
    }))()`);
    agentBrowser(["screenshot", latestScreenshot]);

    if (
      !evalJson(`(() => {
      const button = document.querySelector('[aria-label="Canvas tools"] button[aria-label="Assets"]');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`)
    ) {
      throw new Error("Could not reopen the Canvas asset picker");
    }
    await waitForEval(
      `(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const tabs = [...(dialog?.querySelectorAll('[role="tab"]') ?? [])].map((node) => node.textContent?.trim());
        const rect = dialog?.getBoundingClientRect();
        return !!dialog?.querySelector('[data-layout="command-grid"]') &&
          !!dialog.querySelector('[role="searchbox"][aria-label="Search media"]') &&
          !!rect && rect.width >= window.innerWidth * 0.68 &&
          tabs.includes('Project') && tabs.includes('More sources') &&
          !tabs.includes('Current Canvas') &&
          !['projects/', 'generated/', 'uploads/'].some((fragment) => (dialog?.textContent ?? '').includes(fragment));
      })()`,
      "Canvas scope-aware asset picker without storage addresses",
      10000,
    );
    agentBrowser(["press", "Escape"]);

    if (
      !clickButtonByLabel(agentBrowser, "Collapse AI Copilot") &&
      !clickButtonByLabel(agentBrowser, "Collapse chat panel")
    ) {
      throw new Error(
        "Could not collapse project chat before narrow layout checks",
      );
    }
    await waitForEval(
      `!!document.querySelector('[aria-label="Expand AI Copilot"], [aria-label="Expand chat panel"]')`,
      "collapsed project chat",
      10000,
    );
    agentBrowser(["set", "viewport", "720", "900"]);
    await waitForEval(
      `window.innerWidth === 720 && window.innerHeight === 900`,
      "720x900 project viewport",
      10000,
    );
    const narrowLayout = evalJson(`(() => {
      const workspace = document.querySelector('#project-workspace-shell')?.getBoundingClientRect();
      const sidebarElement = document.querySelector('[aria-label="Project navigator"]');
      const sidebar = sidebarElement?.getBoundingClientRect();
      const sidebarHeader = sidebarElement?.querySelector('.clash-project-sidebar-header')?.getBoundingClientRect();
      const sidebarSearchRow = sidebarElement?.querySelector('.clash-project-sidebar-search')?.getBoundingClientRect();
      const projectReturn = sidebarElement?.querySelector('[aria-label="Return to projects"]')?.getBoundingClientRect();
      const searchControl = sidebarElement?.querySelector('[aria-label="Search project"]')?.getBoundingClientRect();
      const selectedTab = sidebarElement?.querySelector('[role="tab"][aria-selected="true"]')?.getBoundingClientRect();
      const toolbarElement = document.querySelector('[aria-label="Canvas tools"]');
      const toolbarRail = toolbarElement?.getBoundingClientRect();
      const projectToggle = document.querySelector('[data-desktop-chrome="true"] [data-project-navigator-toggle]')?.getBoundingClientRect();
      const backControl = document.querySelector('[data-desktop-chrome="true"] [aria-label="Back"]')?.getBoundingClientRect();
      const canvasSectionHeader = sidebarElement?.querySelector('[data-project-folder="canvases"] [data-project-folder-header]')?.getBoundingClientRect();
      const timelineSectionHeader = sidebarElement?.querySelector('[data-project-folder="timelines"] [data-project-folder-header]')?.getBoundingClientRect();
      const assetsFolderElement = sidebarElement?.querySelector('[aria-controls="project-assets-list"]');
      const assetsTab = assetsFolderElement?.closest('[data-project-folder-header]')?.getBoundingClientRect();
      const firstAssetTab = sidebarElement?.querySelector('[id^="project-asset-"]')?.getBoundingClientRect();
      const timelineTabs = [...(sidebarElement?.querySelectorAll('[id^="project-timeline-"]') ?? [])]
        .map((element) => element.getBoundingClientRect());
      const selectMode = document.querySelector('[aria-label="Select mode"]')?.getBoundingClientRect();
      const handMode = document.querySelector('[aria-label="Hand mode"]')?.getBoundingClientRect();
      const assetsTool = toolbarElement?.querySelector('[aria-label="Assets"]')?.getBoundingClientRect();
      const actionsTool = toolbarElement?.querySelector('[aria-label="Actions"]')?.getBoundingClientRect();
      const editorTool = toolbarElement?.querySelector('[aria-label="Editor"]')?.getBoundingClientRect();
      const projectTitle = document.querySelector('.clash-project-name-input');
      const centerX = (element) => {
        const rect = element?.getBoundingClientRect();
        return rect ? rect.left + rect.width / 2 : null;
      };
      const left = (element) => element?.getBoundingClientRect().left ?? null;
      const spread = (values) => values.every((value) => value !== null)
        ? Math.round((Math.max(...values) - Math.min(...values)) * 10) / 10
        : null;
      const sidebarActionCenters = [
        centerX(sidebarElement?.querySelector('[aria-label="New Canvas"]')),
        centerX(sidebarElement?.querySelector('[aria-label="New Timeline"]')),
        centerX(sidebarElement?.querySelector('[aria-label="Add Asset"]')),
      ];
      const sidebarSectionHeadingLefts = [
        left(sidebarElement?.querySelector('#project-canvases-heading')),
        left(sidebarElement?.querySelector('#project-timelines-heading')),
        left(sidebarElement?.querySelector('#project-assets-heading')),
      ];
      const sidebarRowIconLefts = [
        left(sidebarElement?.querySelector('[role="tab"][aria-selected="true"] svg')),
        left(sidebarElement?.querySelector('[id^="project-timeline-"] svg')),
      ];
      const sidebarNavigationIconCenters = [
        centerX(sidebarElement?.querySelector('[aria-label="Return to projects"] svg')),
        centerX(sidebarElement?.querySelector('[role="tab"][aria-selected="true"] svg')),
        centerX(sidebarElement?.querySelector('[id^="project-timeline-"] svg')),
      ];
      const sectionHeaderRects = [canvasSectionHeader, timelineSectionHeader, assetsTab];
      const atomicControlHeights = [
        projectReturn?.height ?? null,
        projectTitle?.getBoundingClientRect().height ?? null,
        searchControl?.height ?? null,
        canvasSectionHeader?.height ?? null,
        selectedTab?.height ?? null,
        timelineSectionHeader?.height ?? null,
        assetsTab?.height ?? null,
        firstAssetTab?.height ?? null,
        projectToggle?.height ?? null,
        selectMode?.height ?? null,
        handMode?.height ?? null,
        assetsTool?.height ?? null,
        actionsTool?.height ?? null,
        editorTool?.height ?? null,
      ];
      const sidebarActionHeights = [
        sidebarElement?.querySelector('[aria-label="New Canvas"]')?.getBoundingClientRect().height ?? null,
        sidebarElement?.querySelector('[aria-label="New Timeline"]')?.getBoundingClientRect().height ?? null,
        sidebarElement?.querySelector('[aria-label="Add Asset"]')?.getBoundingClientRect().height ?? null,
      ];
      const chromeEdgeGutters = sidebar && selectedTab && toolbarRail
        ? [sidebar.right - selectedTab.right, toolbarRail.left - sidebar.right]
        : [null, null];
      const toolbarButtonInsets = toolbarRail && selectMode
        ? [selectMode.left - toolbarRail.left, toolbarRail.right - selectMode.right]
        : [null, null];
      const searchEdgeGutters = sidebar && searchControl
        ? [searchControl.left - sidebar.left, sidebar.right - searchControl.right]
        : [null, null];
      const topUtilityRowHeights = [
        sidebarHeader?.height ?? null,
        sidebarSearchRow?.height ?? null,
      ];
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        sidebarWidth: sidebar ? Math.round(sidebar.width) : null,
        selectedTabWidth: selectedTab ? Math.round(selectedTab.width) : null,
        toolbarRailWidth: toolbarRail ? Math.round(toolbarRail.width) : null,
        toolbarHorizontalGutter: sidebar && toolbarRail
          ? Math.round(toolbarRail.left - sidebar.right)
          : null,
        toolbarVerticalOffset: sidebarHeader && toolbarRail
          ? Math.round(toolbarRail.top - sidebarHeader.bottom)
          : null,
        toolbarTopInset: workspace && toolbarRail
          ? Math.round(toolbarRail.top - workspace.top)
          : null,
        primaryChromeDimensions: sidebarHeader && toolbarRail
          ? { sidebarHeaderHeight: Math.round(sidebarHeader.height), toolbarRailWidth: Math.round(toolbarRail.width) }
          : null,
        topUtilityRowHeights: topUtilityRowHeights.map((value) => value === null ? null : Math.round(value)),
        topUtilityRowHeightSpread: spread(topUtilityRowHeights),
        atomicControlHeights: atomicControlHeights.map((value) => value === null ? null : Math.round(value)),
        atomicControlHeightSpread: spread(atomicControlHeights),
        actionSlotHeights: sidebarActionHeights.map((value) => value === null ? null : Math.round(value)),
        actionSlotHeightSpread: spread(sidebarActionHeights),
        searchToolbarBoundarySpread: spread([searchControl?.bottom ?? null, toolbarRail?.top ?? null]),
        desktopControlTopSpread: spread([projectToggle?.top ?? null, backControl?.top ?? null]),
        firstRowTopBoundarySpread: spread([canvasSectionHeader?.top ?? null, selectMode?.top ?? null]),
        secondRowTopBoundarySpread: spread([selectedTab?.top ?? null, handMode?.top ?? null]),
        thirdRowTopBoundarySpread: spread([timelineSectionHeader?.top ?? null, assetsTool?.top ?? null]),
        timelineAssetsGap: assetsTab
          ? Math.round(assetsTab.top - (timelineTabs.at(-1)?.bottom ?? timelineSectionHeader?.bottom ?? assetsTab.top))
          : null,
        chromeEdgeGutters: chromeEdgeGutters.map((value) => value === null ? null : Math.round(value)),
        chromeEdgeGutterSpread: spread(chromeEdgeGutters),
        searchEdgeGutters: searchEdgeGutters.map((value) => value === null ? null : Math.round(value)),
        searchEdgeGutterSpread: spread(searchEdgeGutters),
        toolbarButtonInsets: toolbarButtonInsets.map((value) => value === null ? null : Math.round(value)),
        toolbarButtonInsetSpread: spread(toolbarButtonInsets),
        sidebarActionCenters: sidebarActionCenters.map((value) => value === null ? null : Math.round(value)),
        sidebarActionColumnSpread: spread(sidebarActionCenters),
        sidebarSectionHeadingLeftSpread: spread(sidebarSectionHeadingLefts),
        sidebarSectionLeftEdgeSpread: spread(sectionHeaderRects.map((rect) => rect?.left ?? null)),
        sidebarSectionRightEdgeSpread: spread(sectionHeaderRects.map((rect) => rect?.right ?? null)),
        sidebarRowIconLeftSpread: spread(sidebarRowIconLefts),
        sidebarNavigationIconCenters: sidebarNavigationIconCenters.map((value) => value === null ? null : Math.round(value * 10) / 10),
        sidebarNavigationIconCenterSpread: spread(sidebarNavigationIconCenters),
        horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
        projectTitleOverflow: projectTitle ? projectTitle.scrollWidth - projectTitle.clientWidth : null,
      };
    })()`);
    if (
      narrowLayout.sidebarWidth < 190 ||
      narrowLayout.sidebarWidth > 194 ||
      narrowLayout.selectedTabWidth < 174 ||
      narrowLayout.toolbarRailWidth < 46 ||
      narrowLayout.toolbarRailWidth > 50 ||
      narrowLayout.toolbarHorizontalGutter < 7 ||
      narrowLayout.toolbarHorizontalGutter > 9 ||
      narrowLayout.toolbarVerticalOffset < 39 ||
      narrowLayout.toolbarVerticalOffset > 41 ||
      narrowLayout.toolbarTopInset < 79 ||
      narrowLayout.toolbarTopInset > 81 ||
      narrowLayout.primaryChromeDimensions?.sidebarHeaderHeight !== 40 ||
      narrowLayout.primaryChromeDimensions?.toolbarRailWidth !== 48 ||
      narrowLayout.topUtilityRowHeights?.some((height) => height !== 40) ||
      narrowLayout.topUtilityRowHeightSpread === null ||
      narrowLayout.topUtilityRowHeightSpread > 1 ||
      narrowLayout.atomicControlHeights?.some(
        (height) => height < 31 || height > 33,
      ) ||
      narrowLayout.atomicControlHeightSpread === null ||
      narrowLayout.atomicControlHeightSpread > 1 ||
      narrowLayout.actionSlotHeights?.some(
        (height) => height < 23 || height > 25,
      ) ||
      narrowLayout.actionSlotHeightSpread === null ||
      narrowLayout.actionSlotHeightSpread > 1 ||
      narrowLayout.searchToolbarBoundarySpread === null ||
      narrowLayout.searchToolbarBoundarySpread > 1 ||
      narrowLayout.desktopControlTopSpread === null ||
      narrowLayout.desktopControlTopSpread > 1 ||
      narrowLayout.firstRowTopBoundarySpread === null ||
      narrowLayout.firstRowTopBoundarySpread > 1 ||
      narrowLayout.secondRowTopBoundarySpread === null ||
      narrowLayout.secondRowTopBoundarySpread > 1 ||
      narrowLayout.thirdRowTopBoundarySpread === null ||
      narrowLayout.thirdRowTopBoundarySpread > 1 ||
      narrowLayout.timelineAssetsGap < 7 ||
      narrowLayout.timelineAssetsGap > 9 ||
      narrowLayout.chromeEdgeGutterSpread === null ||
      narrowLayout.chromeEdgeGutterSpread > 1 ||
      narrowLayout.searchEdgeGutterSpread === null ||
      narrowLayout.searchEdgeGutterSpread > 1 ||
      narrowLayout.toolbarButtonInsetSpread === null ||
      narrowLayout.toolbarButtonInsetSpread > 1 ||
      narrowLayout.sidebarActionColumnSpread === null ||
      narrowLayout.sidebarActionColumnSpread > 1 ||
      narrowLayout.sidebarSectionHeadingLeftSpread === null ||
      narrowLayout.sidebarSectionHeadingLeftSpread > 1 ||
      narrowLayout.sidebarSectionLeftEdgeSpread === null ||
      narrowLayout.sidebarSectionLeftEdgeSpread > 1 ||
      narrowLayout.sidebarSectionRightEdgeSpread === null ||
      narrowLayout.sidebarSectionRightEdgeSpread > 1 ||
      narrowLayout.sidebarRowIconLeftSpread === null ||
      narrowLayout.sidebarRowIconLeftSpread > 1 ||
      narrowLayout.sidebarNavigationIconCenterSpread === null ||
      narrowLayout.sidebarNavigationIconCenterSpread > 1 ||
      narrowLayout.horizontalOverflow > 1 ||
      narrowLayout.projectTitleOverflow > 1
    ) {
      throw new Error(
        `Narrow project chrome layout failed: ${JSON.stringify(narrowLayout)}`,
      );
    }
    agentBrowser(["screenshot", narrowLayoutScreenshot]);

    if (
      !clickButtonByLabel(agentBrowser, "Expand AI Copilot") &&
      !clickButtonByLabel(agentBrowser, "Expand chat panel")
    ) {
      throw new Error("Could not expand narrow project chat");
    }
    await waitForEval(
      `(() => {
        const panel = document.querySelector('#clash-copilot-panel');
        const toolbar = document.querySelector('.clash-chat-input-toolbar-row');
        const surface = document.querySelector('.clash-chat-input-surface');
        return panel?.getAttribute('aria-hidden') === 'false' && !!toolbar && !!surface;
      })()`,
      "narrow project chat composer",
      10000,
    );
    assertComposerToolbarLayout(
      observeComposerToolbarLayout(agentBrowser),
      "Narrow composer",
    );
    agentBrowser(["screenshot", narrowComposerScreenshot]);
    if (
      !clickButtonByLabel(agentBrowser, "Collapse AI Copilot") &&
      !clickButtonByLabel(agentBrowser, "Collapse chat panel")
    ) {
      throw new Error("Could not collapse narrow project chat");
    }
    await waitForEval(
      `document.querySelector('#clash-copilot-panel')?.getAttribute('aria-hidden') === 'true'`,
      "collapsed narrow project chat",
      10000,
    );

    agentBrowser(["press", "Meta+k"]);
    const commandPalette = await waitForEval(
      `(() => {
        const dialog = document.querySelector('[role="dialog"][aria-label="Search project"], [role="dialog"] [aria-label="Search project"]')?.closest('[role="dialog"]');
        const input = document.querySelector('[role="combobox"][aria-label="Search project"]');
        if (!dialog || !input) return false;
        return { dialogVisible: true, inputRole: input.getAttribute('role') };
      })()`,
      "Cmd-K project command palette",
      10000,
    );
    agentBrowser(["keyboard", "type", "Main"]);
    await waitForEval(
      `!!document.querySelector('[role="option"][aria-label="Main Canvas"]')`,
      "project command palette result",
      10000,
    );
    agentBrowser(["press", "Escape"]);
    await waitForEval(
      `!document.querySelector('[role="dialog"] [aria-label="Search project"]')`,
      "closed project command palette",
      10000,
    );

    if (!clickButtonByLabel(agentBrowser, "Collapse project sidebar")) {
      throw new Error("Could not collapse project sidebar");
    }
    await waitForEval(
      `document.querySelector('#project-workspace-shell')?.getAttribute('data-project-navigator-collapsed') === 'true' &&
       Math.round(document.querySelector('[aria-label="Project navigator"]')?.getBoundingClientRect().width ?? -1) === 0 &&
       !!document.querySelector('[data-desktop-chrome="true"] [aria-label="Expand project sidebar"]')`,
      "fully collapsed project navigator",
      10000,
    );
    const collapsedNavigator = evalJson(`(() => {
      const workspace = document.querySelector('#project-workspace-shell')?.getBoundingClientRect();
      const sidebar = document.querySelector('[aria-label="Project navigator"]');
      const sidebarRect = sidebar?.getBoundingClientRect();
      const toolbarElement = document.querySelector('[aria-label="Canvas tools"]');
      const toolbar = toolbarElement?.getBoundingClientRect();
      const desktopChromeElement = document.querySelector('[data-desktop-chrome="true"]');
      const desktopChrome = desktopChromeElement?.getBoundingClientRect();
      const toggleElement = desktopChromeElement?.querySelector('[aria-label="Expand project sidebar"]');
      const toggle = toggleElement?.getBoundingClientRect();
      const backElement = desktopChromeElement?.querySelector('[aria-label="Back"]');
      const back = backElement?.getBoundingClientRect();
      const selectMode = toolbarElement?.querySelector('[aria-label="Select mode"]')?.getBoundingClientRect();
      return {
        sidebarWidth: sidebarRect ? Math.round(sidebarRect.width) : null,
        sidebarVisibility: sidebar ? getComputedStyle(sidebar).visibility : null,
        sidebarAriaHidden: sidebar?.getAttribute('aria-hidden') ?? null,
        toggleWidth: toggle ? Math.round(toggle.width) : null,
        toggleHeight: toggle ? Math.round(toggle.height) : null,
        toggleLeftInset: toggle && desktopChrome ? Math.round(toggle.left - desktopChrome.left) : null,
        toggleTopInset: toggle && desktopChrome ? Math.round(toggle.top - desktopChrome.top) : null,
        desktopControlTopSpread: toggle && back ? Math.round(Math.abs(toggle.top - back.top)) : null,
        toolbarLeftInset: workspace && toolbar ? Math.round(toolbar.left - workspace.left) : null,
        toolbarTopInset: workspace && toolbar ? Math.round(toolbar.top - workspace.top) : null,
        selectTopInset: selectMode && toolbar ? Math.round(selectMode.top - toolbar.top) : null,
        toggleInsideDesktopChrome: !!toggleElement && !!desktopChromeElement?.contains(toggleElement),
        toggleBeforeBack: !!toggleElement && !!backElement && !!(toggleElement.compareDocumentPosition(backElement) & Node.DOCUMENT_POSITION_FOLLOWING),
        toggleOutsideToolbar: !!toggleElement && !toolbarElement?.contains(toggleElement),
        toggleOutsideSidebar: !!toggleElement && !sidebar?.contains(toggleElement),
        projectTitleVisible: !!sidebar?.querySelector('.clash-project-name-input'),
        searchVisible: !!sidebar?.querySelector('[aria-label="Search project"]'),
        settingsVisible: !!sidebar?.querySelector('[aria-label="Settings"]'),
        horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
      };
    })()`);
    if (
      collapsedNavigator.sidebarWidth !== 0 ||
      collapsedNavigator.sidebarVisibility !== "hidden" ||
      collapsedNavigator.sidebarAriaHidden !== "true" ||
      collapsedNavigator.toggleWidth !== 32 ||
      collapsedNavigator.toggleHeight !== 32 ||
      collapsedNavigator.toggleLeftInset < 91 ||
      collapsedNavigator.toggleLeftInset > 93 ||
      collapsedNavigator.toggleTopInset < 3 ||
      collapsedNavigator.toggleTopInset > 5 ||
      collapsedNavigator.desktopControlTopSpread > 1 ||
      collapsedNavigator.toolbarLeftInset < 7 ||
      collapsedNavigator.toolbarLeftInset > 9 ||
      collapsedNavigator.toolbarTopInset < 79 ||
      collapsedNavigator.toolbarTopInset > 81 ||
      collapsedNavigator.selectTopInset < 7 ||
      collapsedNavigator.selectTopInset > 9 ||
      !collapsedNavigator.toggleInsideDesktopChrome ||
      !collapsedNavigator.toggleBeforeBack ||
      !collapsedNavigator.toggleOutsideToolbar ||
      !collapsedNavigator.toggleOutsideSidebar ||
      collapsedNavigator.projectTitleVisible ||
      collapsedNavigator.searchVisible ||
      collapsedNavigator.settingsVisible ||
      collapsedNavigator.horizontalOverflow > 1
    ) {
      throw new Error(
        `Collapsed project navigator layout failed: ${JSON.stringify(collapsedNavigator)}`,
      );
    }
    agentBrowser(["screenshot", collapsedNavigatorScreenshot]);

    if (!clickButtonByLabel(agentBrowser, "Expand project sidebar")) {
      throw new Error("Could not expand project sidebar");
    }
    await waitForEval(
      `document.querySelector('#project-workspace-shell')?.getAttribute('data-project-navigator-collapsed') === 'false' &&
       Math.round(document.querySelector('[aria-label="Project navigator"]')?.getBoundingClientRect().width ?? 0) === 192`,
      "expanded 192px project navigator",
      10000,
    );

    agentBrowser(["set", "viewport", "1440", "900"]);
    await waitForEval(
      `window.innerWidth === 1440 && window.innerHeight === 900`,
      "1440x900 timeline viewport",
      10000,
    );
    if (
      !clickButtonByLabel(agentBrowser, "Expand AI Copilot") &&
      !clickButtonByLabel(agentBrowser, "Expand chat panel")
    ) {
      throw new Error("Could not expand persistent project chat");
    }
    await waitForEval(
      `(() => {
        const panel = document.querySelector('#clash-copilot-panel');
        const composer = document.querySelector(".milkdown-chat-input [contenteditable='true']");
        const rect = composer?.getBoundingClientRect();
        const style = composer ? getComputedStyle(composer) : null;
        return panel?.getAttribute('aria-hidden') === 'false' && !!rect &&
          rect.width > 0 && rect.height > 0 &&
          style?.display !== 'none' && style?.visibility !== 'hidden';
      })()`,
      "expanded persistent project chat composer",
      10000,
    );
    const draftMarker = "draft survives project surface switch";
    if (!typeComposer(agentBrowser, draftMarker)) {
      throw new Error("Could not type persistent chat draft");
    }
    evalJson(`(() => {
      window.prompt = () => "E2E Rough Cut";
      return true;
    })()`);
    if (!clickButtonByLabel(agentBrowser, "New Timeline")) {
      throw new Error("Could not create Timeline from the project navigator");
    }
    await waitForEval(
      `document.querySelector('[data-testid="project-timeline-editor"]') &&
       document.querySelector('[data-layout="embedded"]') &&
       !document.querySelector('[role="dialog"][aria-label="Video editor"]') &&
       !document.querySelector('[aria-label^="Open parent Canvas"]') &&
       !!document.querySelector('[data-desktop-chrome="true"] [aria-label="Collapse project sidebar"]') &&
       document.querySelector('#project-workspace-shell')?.getAttribute('data-copilot-layout') === 'overlay' &&
       document.body.innerText.includes(${JSON.stringify(draftMarker)})`,
      "embedded Timeline editor with floating persistent chat",
      20000,
    );
    if (!clickButtonByLabel(agentBrowser, "Add media")) {
      throw new Error("Could not open the standalone Timeline asset picker");
    }
    await waitForEval(
      `(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const tabs = [...(dialog?.querySelectorAll('[role="tab"]') ?? [])].map((node) => node.textContent?.trim());
        return !!dialog?.querySelector('[data-layout="command-grid"]') &&
          !!dialog.querySelector('[role="searchbox"][aria-label="Search media"]') &&
          tabs.includes('Project') && tabs.includes('More sources') &&
          !tabs.includes('Current Canvas') &&
          !![...(dialog?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.includes('Upload from Mac'));
      })()`,
      "standalone Timeline scope-aware asset picker",
      10000,
    );
    agentBrowser(["press", "Escape"]);
    if (!clickVisibleLinkOrButtonByText("+ Text")) {
      throw new Error("Could not add text in Timeline editor");
    }
    await waitForEval(
      `document.querySelectorAll('[aria-label^="text:"]').length === 1`,
      "Timeline text item",
      10000,
    );
    if (!clickVisibleLinkOrButtonByText("Main")) {
      throw new Error("Could not switch from Timeline to Main Canvas");
    }
    await waitForEval(
      `(() => {
        const workspace = document.querySelector('#project-workspace-shell')?.getBoundingClientRect();
        const copilot = document.querySelector('#clash-copilot-panel')?.getBoundingClientRect();
        return document.querySelector('#project-workspace-shell')?.getAttribute('data-copilot-layout') === 'overlay' &&
          document.body.innerText.includes(${JSON.stringify(draftMarker)}) &&
          !!workspace && !!copilot &&
          Math.abs(window.innerWidth - workspace.right) <= 1 &&
          copilot.left < workspace.right;
      })()`,
      "full-width Canvas under the persistent chat overlay",
      10000,
    );
    if (!clickVisibleLinkOrButtonByText("E2E Rough Cut")) {
      throw new Error("Could not reopen Timeline from the project navigator");
    }
    const timelineDock = await waitForEval(
      `(() => {
        const navigatorCount = document.querySelectorAll('[aria-label="Project navigator"]').length;
        const footerCount = document.querySelectorAll('.clash-project-sidebar-footer').length;
        const launcherCount = document.querySelectorAll('.clash-copilot-launcher').length;
        const workspace = document.querySelector('#project-workspace-shell')?.getBoundingClientRect();
        const copilot = document.querySelector('#clash-copilot-panel')?.getBoundingClientRect();
        const editor = document.querySelector('[data-testid="project-timeline-editor"]')?.getBoundingClientRect();
        const media = document.querySelector('[data-editor-region="media"]')?.getBoundingClientRect();
        const preview = document.querySelector('[data-editor-region="preview"]')?.getBoundingClientRect();
        const timelineSurface = document.querySelector('[data-editor-region="timeline"]')?.getBoundingClientRect();
        const navigator = document.querySelector('[aria-label="Project navigator"]')?.getBoundingClientRect();
        const footer = document.querySelector('.clash-project-sidebar-footer')?.getBoundingClientRect();
        const settings = document.querySelector('.clash-project-sidebar-footer [aria-label="Settings"]')?.getBoundingClientRect();
        const itemCount = document.querySelectorAll('[aria-label^="text:"]').length;
        if (navigatorCount !== 1 || footerCount !== 1 || launcherCount > 1) return false;
        if (!workspace || !copilot || !editor || !media || !preview || !timelineSurface || !navigator || !footer || !settings || itemCount !== 1) return false;
        const workspaceOverlap = workspace.right - copilot.left;
        const surfaceGap = copilot.left - preview.right;
        const topBaselineDelta = Math.abs(media.top - copilot.top);
        const bottomBaselineDelta = Math.abs(timelineSurface.bottom - copilot.bottom);
        if (Math.abs(window.innerWidth - workspace.right) > 1 || workspaceOverlap <= 0) return false;
        if (surfaceGap < 7 || surfaceGap > 9) return false;
        if (topBaselineDelta > 1 || bottomBaselineDelta > 1) return false;
        if (Math.abs((window.innerWidth - copilot.right) - 8) > 1) return false;
        if (Math.abs(navigator.bottom - footer.bottom) > 1) return false;
        if (settings.top < footer.top || settings.bottom > footer.bottom) return false;
        if (document.querySelector('#project-top-actions')) return false;
        if (!document.body.innerText.includes(${JSON.stringify(draftMarker)})) return false;
        return {
          workspace: { left: workspace.left, right: workspace.right, width: workspace.width },
          copilot: { left: copilot.left, right: copilot.right, width: copilot.width },
          editor: { left: editor.left, right: editor.right, width: editor.width },
          surfaces: { mediaTop: media.top, timelineBottom: timelineSurface.bottom },
          sidebarFooter: { top: footer.top, bottom: footer.bottom, settingsLeft: settings.left },
          singletonChrome: { navigatorCount, footerCount, launcherCount },
          workspaceOverlap,
          surfaceGap,
          topBaselineDelta,
          bottomBaselineDelta,
          itemCount,
        };
      })()`,
      "persisted Timeline item and floating geometry",
      15000,
    );
    agentBrowser(["screenshot", timelineDockScreenshot]);

    evalJson(`(() => {
      window.prompt = () => "Review Canvas";
      return true;
    })()`);
    if (!clickButtonByLabel(agentBrowser, "New Canvas")) {
      throw new Error(
        "Could not create a second Canvas for explicit asset placement",
      );
    }
    await waitForEval(
      `document.querySelector('[aria-label="Project navigator"] [role="tab"][aria-selected="true"]')?.textContent?.includes("Review Canvas") === true &&
       document.querySelector('#project-workspace-shell')?.getAttribute('data-copilot-layout') === 'overlay' &&
       document.body.innerText.includes(${JSON.stringify(draftMarker)})`,
      "second Canvas with persistent chat draft",
      10000,
    );
    if (
      !evalJson(`(() => {
      const button = document.querySelector('[aria-label="Canvas tools"] button[aria-label="Assets"]');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`)
    ) {
      throw new Error("Could not open the second Canvas asset picker");
    }
    await waitForEval(
      `(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const tabs = [...(dialog?.querySelectorAll('[role="tab"]') ?? [])].map((node) => node.textContent?.trim());
        const rect = dialog?.getBoundingClientRect();
        return !!dialog?.querySelector('[data-layout="command-grid"]') &&
          !!dialog.querySelector('[role="searchbox"][aria-label="Search media"]') &&
          !!rect && rect.width >= window.innerWidth * 0.68 &&
          tabs.includes('Project') && tabs.includes('More sources') &&
          !tabs.includes('Current Canvas') &&
          !['projects/', 'generated/', 'uploads/'].some((fragment) => (dialog?.textContent ?? '').includes(fragment));
      })()`,
      "Canvas scope-aware asset picker without storage addresses",
      10000,
    );
    agentBrowser(["press", "Escape"]);
    const populatedChrome = evalJson(`(() => {
      const sidebar = document.querySelector('[aria-label="Project navigator"]');
      const toolbar = document.querySelector('[aria-label="Canvas tools"]');
      const canvasTabs = [...(sidebar?.querySelectorAll('[id^="project-canvas-"]') ?? [])];
      const timelineTabs = [...(sidebar?.querySelectorAll('[id^="project-timeline-"]') ?? [])];
      const rect = (selector, root = document) => root.querySelector(selector)?.getBoundingClientRect() ?? null;
      const spread = (values) => values.every((value) => value !== null)
        ? Math.round((Math.max(...values) - Math.min(...values)) * 10) / 10
        : null;
      const canvasHeader = sidebar?.querySelector('[data-project-folder="canvases"] [data-project-folder-header]')?.getBoundingClientRect() ?? null;
      const timelineHeader = sidebar?.querySelector('[data-project-folder="timelines"] [data-project-folder-header]')?.getBoundingClientRect() ?? null;
      const firstCanvas = canvasTabs[0]?.getBoundingClientRect() ?? null;
      const assetsTab = sidebar?.querySelector('[data-project-folder="assets"] [data-project-folder-header]')?.getBoundingClientRect() ?? null;
      const selectMode = rect('[aria-label="Select mode"]');
      const handMode = rect('[aria-label="Hand mode"]');
      const sidebarRows = [canvasHeader, ...canvasTabs.map((tab) => tab.getBoundingClientRect()), timelineHeader,
        ...timelineTabs.map((tab) => tab.getBoundingClientRect()), assetsTab].filter(Boolean);
      const toolbarControls = [...(toolbar?.querySelectorAll('button[aria-label]') ?? [])]
        .map((control) => control.getBoundingClientRect())
        .sort((a, b) => a.top - b.top);
      const uniqueBoundaries = (rects) => [...new Set(rects.flatMap((item) => [item.top, item.bottom])
        .map((value) => Math.round(value * 10) / 10))];
      const sidebarBoundaries = uniqueBoundaries(sidebarRows);
      const toolbarBoundaries = uniqueBoundaries(toolbarControls);
      const sharedBoundaries = sidebarBoundaries.filter((sidebarBoundary) =>
        toolbarBoundaries.some((toolbarBoundary) => Math.abs(toolbarBoundary - sidebarBoundary) <= 1));
      const controlGaps = toolbarControls.slice(1).map((control, index) =>
        Math.round((control.top - toolbarControls[index].bottom) * 10) / 10);
      const sectionGaps = controlGaps.filter((gap) => gap > 1);
      return {
        canvasCount: canvasTabs.length,
        timelineCount: timelineTabs.length,
        stableTopAnchorSpreads: {
          canvasHeaderToSelect: spread([canvasHeader?.top ?? null, selectMode?.top ?? null]),
          firstCanvasToHand: spread([firstCanvas?.top ?? null, handMode?.top ?? null]),
        },
        sharedBoundaryCount: sharedBoundaries.length,
        sharedBoundaries,
        maxControlGap: controlGaps.length ? Math.max(...controlGaps) : null,
        sectionGaps,
        sectionGapSpread: sectionGaps.length ? spread(sectionGaps) : null,
        toolbarHeight: toolbar ? Math.round(toolbar.getBoundingClientRect().height) : null,
      };
    })()`);
    if (
      populatedChrome.canvasCount < 2 ||
      populatedChrome.timelineCount < 1 ||
      Object.values(populatedChrome.stableTopAnchorSpreads).some(
        (value) => value === null || value > 1,
      ) ||
      populatedChrome.sharedBoundaryCount < 5 ||
      populatedChrome.maxControlGap === null ||
      populatedChrome.maxControlGap > 9 ||
      populatedChrome.sectionGaps.length !== 3 ||
      populatedChrome.sectionGaps.some((gap) => gap < 7 || gap > 9) ||
      populatedChrome.sectionGapSpread === null ||
      populatedChrome.sectionGapSpread > 1 ||
      populatedChrome.toolbarHeight === null ||
      populatedChrome.toolbarHeight > 365
    ) {
      throw new Error(
        `Populated project chrome anchors failed: ${JSON.stringify(populatedChrome)}`,
      );
    }
    agentBrowser(["screenshot", populatedChromeScreenshot]);

    for (const folder of [
      {
        label: "Canvases",
        controls: "project-canvases-list",
        childSelector: '[id^="project-canvas-"]',
        unaffectedSelector: '[id^="project-timeline-"]',
      },
      {
        label: "Timelines",
        controls: "project-timelines-list",
        childSelector: '[id^="project-timeline-"]',
        unaffectedSelector: '[id^="project-canvas-"]',
      },
    ]) {
      const disclosureSelector = `[aria-controls="${folder.controls}"]`;
      agentBrowser(["click", disclosureSelector]);
      await waitForEval(
        `document.querySelector(${JSON.stringify(disclosureSelector)})?.getAttribute('aria-expanded') === 'false' &&
         !document.querySelector(${JSON.stringify(folder.childSelector)}) &&
         !!document.querySelector(${JSON.stringify(folder.unaffectedSelector)}) &&
         !!document.querySelector(${JSON.stringify(seededAssetSelector)})`,
        `collapsed ${folder.label} folder without affecting siblings`,
        10000,
      );
      agentBrowser(["click", disclosureSelector]);
      await waitForEval(
        `document.querySelector(${JSON.stringify(disclosureSelector)})?.getAttribute('aria-expanded') === 'true' &&
         !!document.querySelector(${JSON.stringify(folder.childSelector)})`,
        `expanded ${folder.label} folder`,
        10000,
      );
    }

    const assetSelector = seededAssetSelector;
    if (
      !evalJson(`(() => {
      const asset = document.querySelector(${JSON.stringify(assetSelector)});
      if (!asset) return false;
      asset.scrollIntoView({ block: 'center', inline: 'center' });
      asset.click();
      return true;
    })()`)
    ) {
      throw new Error("Could not open the project asset directly");
    }
    await waitForEval(
      `document.querySelector('[aria-label="Project navigator"] [role="tab"][aria-selected="true"]')?.id === ${JSON.stringify(seededAssetElementId)} &&
       !!document.querySelector('[aria-label="explicit-target.png preview"]') &&
       ![...document.querySelectorAll('#project-workspace-inset h1, #project-workspace-inset h2')].some((heading) => (heading.textContent || '').trim() === 'Assets') &&
       !!document.querySelector('[data-desktop-chrome="true"] [aria-label="Collapse project sidebar"]') &&
       document.querySelector('#project-workspace-shell')?.getAttribute('data-copilot-layout') === 'overlay' &&
       document.body.innerText.includes(${JSON.stringify(draftMarker)})`,
      "direct asset preview with floating persistent chat",
      10000,
    );
    const assetPreview = evalJson(`(() => ({
      selectedAssetId: document.querySelector('[aria-label="Project navigator"] [role="tab"][aria-selected="true"]')?.id ?? null,
      disclosureExpanded: document.querySelector('[aria-controls="project-assets-list"]')?.getAttribute('aria-expanded') ?? null,
      previewVisible: !!document.querySelector('[aria-label="explicit-target.png preview"]'),
      aggregatePageVisible: [...document.querySelectorAll('#project-workspace-inset h1, #project-workspace-inset h2')].some((heading) => (heading.textContent || '').trim() === 'Assets'),
    }))()`);
    agentBrowser(["screenshot", assetPreviewScreenshot]);

    agentBrowser(["click", '[aria-controls="project-assets-list"]']);
    await waitForEval(
      `document.querySelector('[aria-controls="project-assets-list"]')?.getAttribute('aria-expanded') === 'false' &&
       !document.querySelector(${JSON.stringify(assetSelector)})`,
      "collapsed Assets folder",
      10000,
    );
    agentBrowser(["click", '[aria-controls="project-assets-list"]']);
    await waitForEval(
      `document.querySelector('[aria-controls="project-assets-list"]')?.getAttribute('aria-expanded') === 'true' &&
       !!document.querySelector(${JSON.stringify(assetSelector)})`,
      "expanded Assets folder",
      10000,
    );

    agentBrowser(["click", "#project-canvas-main"]);
    await waitForEval(
      `document.querySelector('#project-workspace-shell')?.getAttribute('data-copilot-layout') === 'overlay' &&
       !!document.querySelector('.react-flow__pane')`,
      "Main Canvas before asset drag",
      10000,
    );
    const imageNodeCountBeforeDrop = evalJson(
      `document.querySelectorAll('.react-flow__node-image').length`,
    );
    agentBrowser(["drag", assetSelector, ".react-flow__pane"]);
    await waitForEval(
      `document.querySelectorAll('.react-flow__node-image').length > ${Number(imageNodeCountBeforeDrop)}`,
      "sidebar asset dropped onto Canvas",
      15000,
    );
    const assetPlacement = evalJson(`(() => ({
      selectedCanvas: document.querySelector('[aria-label="Project navigator"] [role="tab"][aria-selected="true"]')?.textContent?.trim() ?? null,
      copilotLayout: document.querySelector('#project-workspace-shell')?.getAttribute('data-copilot-layout') ?? null,
      draftPreserved: document.body.innerText.includes(${JSON.stringify(draftMarker)}),
      projectImageVisible: document.querySelectorAll('.react-flow__node-image').length > ${Number(imageNodeCountBeforeDrop)},
    }))()`);
    if (
      !assetPlacement.selectedCanvas?.includes("Main") ||
      assetPlacement.copilotLayout !== "overlay" ||
      !assetPlacement.draftPreserved ||
      !assetPlacement.projectImageVisible
    ) {
      throw new Error(
        `Canvas asset drag state failed: ${JSON.stringify(assetPlacement)}`,
      );
    }

    evalJson(`(() => {
      window.prompt = () => "Asset Drop Timeline";
      return true;
    })()`);
    if (!clickButtonByLabel(agentBrowser, "New Timeline")) {
      throw new Error("Could not create an empty Timeline for asset drag");
    }
    await waitForEval(
      `!!document.querySelector('[data-testid="project-timeline-editor"] .tracks-viewport') &&
       document.querySelectorAll('[aria-label^="image:"]').length === 0`,
      "empty Timeline asset drop target",
      15000,
    );
    agentBrowser(["drag", assetSelector, ".tracks-viewport"]);
    await waitForEval(
      `document.querySelectorAll('[aria-label^="image:"]').length === 1`,
      "sidebar asset dropped onto Timeline",
      15000,
    );
    agentBrowser(["click", "#project-canvas-main"]);
    await waitForEval(
      `document.querySelector('#project-workspace-shell')?.getAttribute('data-copilot-layout') === 'overlay'`,
      "Canvas after persisting Timeline asset drop",
      10000,
    );
    if (!clickVisibleLinkOrButtonByText("Asset Drop Timeline")) {
      throw new Error("Could not reopen the asset drop Timeline");
    }
    const timelineAssetPlacement = await waitForEval(
      `(() => {
        const imageItems = document.querySelectorAll('[aria-label^="image:"]').length;
        if (imageItems !== 1) return false;
        return {
          imageItems,
          copilotLayout: document.querySelector('#project-workspace-shell')?.getAttribute('data-copilot-layout') ?? null,
          draftPreserved: document.body.innerText.includes(${JSON.stringify(draftMarker)}),
        };
      })()`,
      "persisted Timeline asset drop",
      15000,
    );
    agentBrowser(["screenshot", assetDragScreenshot]);

    if (
      !evalJson(`(() => {
      const link = document.querySelector('a[aria-label="Settings"]');
      if (!link) return false;
      const rect = link.getBoundingClientRect();
      const style = getComputedStyle(link);
      if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') return false;
      link.scrollIntoView({ block: 'center', inline: 'center' });
      link.click();
      return true;
    })()`)
    ) {
      throw new Error(
        "Could not open local desktop Settings from the project sidebar",
      );
    }
    const localSettings = await waitForEval(
      `(() => {
        if (location.pathname !== '/settings') return false;
        const signOut = [...document.querySelectorAll('button')].find((button) =>
          (button.innerText || button.textContent || '').trim() === 'Sign out'
        );
        if (signOut) return false;
        if (document.body.innerText.includes('Workspace controls')) return false;
        if (document.querySelector('[data-project-navigator-toggle]')) return false;
        const sidebar = document.querySelector('.clash-settings-page-sidebar');
        const sidebarHeader = sidebar?.querySelector('.clash-settings-sidebar-header')?.getBoundingClientRect();
        const firstNavigationRow = sidebar?.querySelector('[aria-label="Settings sections"] [role="tab"]')?.getBoundingClientRect();
        if (!sidebarHeader || Math.round(sidebarHeader.height) !== 40) return false;
        if (!firstNavigationRow || Math.round(firstNavigationRow.height) !== 32) return false;
        return {
          path: location.pathname,
          signOutVisible: false,
          projectNavigatorToggleVisible: false,
          sidebarHeaderHeight: Math.round(sidebarHeader.height),
          navigationRowHeight: Math.round(firstNavigationRow.height),
        };
      })()`,
      "local Settings without cloud sign out",
      10000,
    );
    agentBrowser(["screenshot", localSettingsScreenshot]);

    console.log("[desktop-agent-browser] state", JSON.stringify(state));
    console.log(
      "[desktop-agent-browser] history",
      JSON.stringify({
        firstHistory,
        secondHistory,
        restoredSession,
      }),
    );
    console.log(
      "[desktop-agent-browser] project status",
      JSON.stringify({
        apiPath: projectStatusApiPath,
        status: projectStatusEvidence,
      }),
    );
    console.log(
      "[desktop-agent-browser] narrow layout",
      JSON.stringify(narrowLayout),
    );
    console.log(
      "[desktop-agent-browser] command palette",
      JSON.stringify(commandPalette),
    );
    console.log(
      "[desktop-agent-browser] collapsed navigator",
      JSON.stringify(collapsedNavigator),
    );
    console.log(
      "[desktop-agent-browser] populated chrome",
      JSON.stringify(populatedChrome),
    );
    console.log(
      "[desktop-agent-browser] timeline dock",
      JSON.stringify(timelineDock),
    );
    console.log(
      "[desktop-agent-browser] asset preview",
      JSON.stringify(assetPreview),
    );
    console.log(
      "[desktop-agent-browser] asset placement",
      JSON.stringify(assetPlacement),
    );
    console.log(
      "[desktop-agent-browser] timeline asset placement",
      JSON.stringify(timelineAssetPlacement),
    );
    console.log(
      "[desktop-agent-browser] local settings",
      JSON.stringify(localSettings),
    );
    console.log(
      "[desktop-agent-browser] agent follow",
      JSON.stringify(agentFollow),
    );
    console.log(
      "[desktop-agent-browser] canvas transient UI",
      JSON.stringify(transientUi),
    );
    console.log(
      "[desktop-agent-browser] selected capsule fill",
      JSON.stringify(selectedCapsuleFill),
    );
    console.log(
      "[desktop-agent-browser] canvas toolbar tooltip",
      JSON.stringify(toolbarTooltip),
    );
    console.log(
      "[desktop-agent-browser] popup interactions",
      JSON.stringify(popupInteractions),
    );
    console.log(`[desktop-agent-browser] screenshot ${latestScreenshot}`);
    console.log(
      `[desktop-agent-browser] history screenshot ${historyScreenshot}`,
    );
    console.log(
      `[desktop-agent-browser] narrow screenshot ${narrowLayoutScreenshot}`,
    );
    console.log(
      `[desktop-agent-browser] narrow composer screenshot ${narrowComposerScreenshot}`,
    );
    console.log(
      `[desktop-agent-browser] collapsed navigator screenshot ${collapsedNavigatorScreenshot}`,
    );
    console.log(
      `[desktop-agent-browser] populated chrome screenshot ${populatedChromeScreenshot}`,
    );
    console.log(
      `[desktop-agent-browser] timeline dock screenshot ${timelineDockScreenshot}`,
    );
    console.log(
      `[desktop-agent-browser] asset preview screenshot ${assetPreviewScreenshot}`,
    );
    console.log(
      `[desktop-agent-browser] asset drag screenshot ${assetDragScreenshot}`,
    );
    console.log(
      `[desktop-agent-browser] local settings screenshot ${localSettingsScreenshot}`,
    );
    console.log(
      `[desktop-agent-browser] agent follow screenshot ${agentFollowScreenshot}`,
    );
    console.log(
      `[desktop-agent-browser] canvas transient UI screenshot ${transientUiScreenshot}`,
    );
    console.log(
      `[desktop-agent-browser] canvas toolbar tooltip screenshot ${toolbarTooltipScreenshot}`,
    );
    console.log(
      `[desktop-agent-browser] popup interactions screenshot ${popupInteractionsScreenshot}`,
    );
    assertNoForbiddenRendererIssues(electronLogs);
  } catch (error) {
    try {
      agentBrowser(["screenshot", latestScreenshot], { allowFailure: true });
      console.error(
        `[desktop-agent-browser] failure screenshot ${latestScreenshot}`,
      );
    } catch {
      // Ignore screenshot failure while unwinding.
    }
    console.error("[desktop-agent-browser] web logs\n" + tail(webLogs));
    console.error(
      "[desktop-agent-browser] electron logs\n" + tail(electronLogs),
    );
    throw error;
  } finally {
    agentBrowser(["close"], { allowFailure: true });
    await stopProcess(electron);
    await stopProcess(web);
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});
