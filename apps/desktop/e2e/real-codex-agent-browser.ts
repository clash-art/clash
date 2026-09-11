import path from "node:path";
import { homedir } from "node:os";
import { lstat, readFile, readlink, stat } from "node:fs/promises";
import {
  assertComposerToolbarLayout,
  clickButtonByLabel,
  clickByText,
  clickComposerSubmitButton,
  createAgentBrowser,
  desktopDir,
  ensureAgentBrowser,
  evalJson,
  findFreePort,
  observeComposerToolbarLayout,
  openSessionHistoryMenu,
  recoverAgentBrowserTarget,
  repoRoot,
  resetDirs,
  sleep,
  startElectron,
  startVite,
  stopProcess,
  submitProjectCreateDialog,
  tail,
  typeComposer,
  waitForEval,
  waitForHttp,
} from "./startup-shared.ts";
import {
  finalAnswerTextFromEvents,
  terminalOutputsFromEvents,
} from "./real-codex-transcript.ts";
import { assertColdStartProductContract } from "./product-cold-start-contract.ts";

if (process.env.CLASH_E2E_REAL_CODEX !== "1") {
  throw new Error("Refusing to run the real Codex E2E without CLASH_E2E_REAL_CODEX=1");
}

const runRoot = path.join(repoRoot, ".tmp", "startup-real-codex");
const captureDir = process.env.CLASH_E2E_REAL_CODEX_CAPTURE_DIR ?? path.join(runRoot, "screenshots");
const dataDir = process.env.CLASH_E2E_REAL_CODEX_DATA_DIR ?? path.join(runRoot, "data");
const sessionName = `clash-real-codex-${Date.now().toString(36)}`;
const failureScreenshot = path.join(captureDir, "failure.png");
const finalScreenshot = path.join(captureDir, "final.png");
const historyScreenshot = path.join(captureDir, "history.png");
const retryStatusScreenshot = path.join(captureDir, "retry-status.png");
const coldStartScreenshot = path.join(captureDir, "cold-start-product-contract.png");
const narrowPlanScreenshot = path.join(captureDir, "narrow-plan-composer.png");
const permissionScreenshot = path.join(captureDir, "permission-composer.png");

function currentClashHome() {
  return process.env.CLASH_HOME || path.join(homedir(), ".clash");
}

async function assertProjectWorkspaceLayout(projectId) {
  const projectWorkspaceRoot = path.join(currentClashHome(), "projects", projectId);
  const required = [
    "drafts",
    "projections/text",
    "projections/timelines",
    "timelines",
    "assets/links",
    "sessions",
    "runtime",
  ];
  const missing = [];
  for (const relativePath of required) {
    const fullPath = path.join(projectWorkspaceRoot, relativePath);
    try {
      const info = await stat(fullPath);
      if (!info.isDirectory()) missing.push(relativePath);
    } catch {
      missing.push(relativePath);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Project workspace layout is missing ${missing.join(", ")} under ${projectWorkspaceRoot}`);
  }
  return { projectWorkspaceRoot, required };
}

async function assertNativeClashSkill(projectWorkspaceRoot) {
  const skillDirectory = path.join(
    projectWorkspaceRoot,
    ".agents",
    "skills",
    "clash",
  );
  const info = await lstat(skillDirectory);
  if (!info.isSymbolicLink()) {
    throw new Error(`Codex project Skill must be a symlink: ${skillDirectory}`);
  }
  const target = await readlink(skillDirectory);
  if (!path.isAbsolute(target)) {
    throw new Error(`Codex project Skill symlink must resolve to the bundled source: ${target}`);
  }
  const skill = await readFile(path.join(skillDirectory, "SKILL.md"), "utf8");
  if (!skill.includes("name: clash") || !skill.includes("bundled `clash_*` tools")) {
    throw new Error(`Codex project Skill did not resolve to the canonical Clash Skill: ${target}`);
  }
  return { skillDirectory, target };
}

async function fetchAndAssertProjectStatus(apiPort, projectId) {
  const url = `http://127.0.0.1:${apiPort}/api/v1/projects/${encodeURIComponent(projectId)}/status`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Project status failed ${res.status}: ${text.slice(0, 1000)}`);
  }
  const status = JSON.parse(text);
  if (!status.runtimeRoot || status.runtimeRoot !== status.roots?.runtime) {
    throw new Error(`Project status must expose runtimeRoot matching roots.runtime: ${text.slice(0, 1000)}`);
  }
  if (!Array.isArray(status.protectedPaths) || !status.protectedPaths.includes(status.runtimeRoot)) {
    throw new Error(`Project status protectedPaths must include runtimeRoot: ${text.slice(0, 1000)}`);
  }
  return {
    projectId: status.projectId,
    projectStore: status.projectStore,
    projectWorkspaceRoot: status.projectWorkspaceRoot,
    roots: status.roots,
    runtimeRoot: status.runtimeRoot,
    protectedPaths: status.protectedPaths,
    editablePaths: status.editablePaths,
    loro: status.loro,
    localSqlitePath: status.localSqlitePath,
  };
}

function hasTransportDiagnostic(lines) {
  return lines.some((line) =>
    /Reconnecting\.\.\.\s*\d+\/\d+|retrying sampling request|falling back to HTTP|Falling back from WebSockets to HTTPS transport/i.test(line),
  );
}

async function captureRetryStatus(agentBrowser, screenshotPath, shouldStop) {
  const deadline = Date.now() + 240000;
  while (!shouldStop() && Date.now() < deadline) {
    let statusText = null;
    try {
      statusText = evalJson(agentBrowser, `(() => {
        const text = document.body.innerText;
        const match = text.match(/(?:Reconnecting\\s+\\d+\\/\\d+|Switching transport|正在重连\\s*\\d+\\/\\d+|正在切换传输)(?:\\s*[·•-]\\s*[^\\n]+)?/i);
        return match ? match[0] : null;
      })()`);
    } catch {
      // The Electron window can be briefly unavailable while the test is
      // submitting or navigating; keep polling until the turn is done.
    }
    if (statusText) {
      agentBrowser(["screenshot", screenshotPath]);
      return { text: statusText, screenshot: screenshotPath };
    }
    await sleep(200);
  }
  return null;
}

async function selectCodexHarness(agentBrowser) {
  const triggerExpression = `document.querySelector("[data-testid='session-harness-config-trigger']")`;
  const selectedHarnessExpression = `(() => {
    const trigger = ${triggerExpression};
    const logo = trigger?.querySelector("[data-acp-agent-logo]");
    return {
      text: trigger?.innerText || "",
      logoLabel: logo?.getAttribute("aria-label") || "",
    };
  })()`;
  const currentSelection = evalJson(agentBrowser, selectedHarnessExpression);
  if (currentSelection.logoLabel.includes("Codex") || currentSelection.text.includes("Codex")) return;

  const opened = evalJson(agentBrowser, `(() => {
    const trigger = ${triggerExpression};
    if (!trigger) return false;
    trigger.scrollIntoView({ block: "center", inline: "center" });
    trigger.click();
    return true;
  })()`);
  if (!opened) throw new Error("Could not open session harness selector");

  await waitForEval(
    agentBrowser,
    `(() => {
      const menuText = [...document.querySelectorAll("[role='menu'], [role='listbox'], [data-radix-popper-content-wrapper]")]
        .map((el) => el.innerText || el.textContent || "")
        .join("\\n");
      return menuText.includes("Codex");
    })()`,
    "Codex harness option",
    10000,
  );
  const picked = evalJson(agentBrowser, `(() => {
    const candidates = [...document.querySelectorAll("[role='option'], [role='menuitemradio'], button, [data-value]")]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 &&
          style.display !== "none" && style.visibility !== "hidden";
      });
    const option = candidates.find((el) => {
      const text = (el.innerText || el.textContent || "").trim();
      const aria = el.getAttribute("aria-label") || "";
      return text === "Codex" || text.startsWith("Codex\\n") || aria === "Codex";
    });
    if (!option) return false;
    option.scrollIntoView({ block: "center", inline: "center" });
    option.click();
    return true;
  })()`);
  if (!picked) throw new Error("Could not select Codex harness");
  await waitForEval(
    agentBrowser,
    `(() => {
      const selection = ${selectedHarnessExpression};
      return selection.logoLabel.includes("Codex") || selection.text.includes("Codex");
    })()`,
    "Codex harness selected",
    10000,
  );
}

async function selectPermissionMode(agentBrowser, label) {
  if (!clickButtonByLabel(agentBrowser, "Harness permission mode")) {
    throw new Error("Could not open the harness permission selector");
  }
  await waitForEval(
    agentBrowser,
    `document.body.innerText.includes(${JSON.stringify(label)})`,
    `${label} permission option`,
    10000,
  );
  const picked = evalJson(agentBrowser, `(() => {
    const label = ${JSON.stringify(label)};
    const candidates = [...document.querySelectorAll('[role="option"], [role="menuitemradio"], [role="menuitem"], button')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 &&
          style.display !== "none" && style.visibility !== "hidden" &&
          !element.disabled;
      });
    const option = candidates.find((element) => {
      const lines = (element.innerText || element.textContent || "")
        .split("\\n")
        .map((line) => line.trim())
        .filter(Boolean);
      return lines[0] === label;
    });
    if (!option) return false;
    option.scrollIntoView({ block: "center", inline: "center" });
    option.click();
    return true;
  })()`);
  if (!picked) {
    throw new Error(`Could not select permission mode ${label}`);
  }
  await waitForEval(
    agentBrowser,
    `(() => {
      const trigger = document.querySelector('[data-testid="session-permission-mode-trigger"]');
      return (trigger?.innerText || trigger?.textContent || "").includes(${JSON.stringify(label)});
    })()`,
    `${label} permission mode selected`,
    10000,
  );
}

function readComposerDesignTokens(agentBrowser, selector) {
  return evalJson(agentBrowser, `(() => {
    const surface = document.querySelector(${JSON.stringify(selector)});
    if (!surface) return null;
    const style = getComputedStyle(surface);
    return {
      borderRadius: style.borderRadius,
      borderColor: style.borderColor,
      borderWidth: style.borderWidth,
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      boxShadow: style.boxShadow,
    };
  })()`);
}

async function verifyPlanCommandResponsiveComposer(agentBrowser) {
  const command = "/plan";
  if (!typeComposer(agentBrowser, command)) {
    throw new Error("Could not type /plan into composer");
  }
  if (!clickComposerSubmitButton(agentBrowser)) {
    throw new Error("Could not submit /plan");
  }
  await waitForEval(
    agentBrowser,
    `(() => {
      const tag = document.querySelector('[data-testid="session-plan-tag"]');
      const close = tag?.querySelector('button[aria-label="Exit Plan mode"]');
      const rect = tag?.getBoundingClientRect();
      return !!tag && !!close && !!rect && rect.width > 0 && rect.height > 0;
    })()`,
    "active Plan tag after /plan",
    10000,
  );

  const initialPanel = evalJson(agentBrowser, `(() => {
    const panel = document.querySelector('#clash-copilot-panel')?.getBoundingClientRect();
    const handle = document.querySelector('[aria-label="Resize panel"]')?.getBoundingClientRect();
    if (!panel || !handle) return null;
    return {
      width: panel.width,
      handleX: handle.left + handle.width / 2,
      handleY: handle.top + handle.height / 2,
      shrinkTargetX: panel.right - 24,
    };
  })()`);
  if (!initialPanel) throw new Error("Could not locate the desktop Copilot resize handle");
  const alreadyAtMinimumWidth = initialPanel.width <= 430;
  if (!alreadyAtMinimumWidth) {
    agentBrowser(["mouse", "move", String(initialPanel.handleX), String(initialPanel.handleY)]);
    agentBrowser(["mouse", "down", "left"]);
    try {
      agentBrowser([
        "mouse",
        "move",
        String((initialPanel.handleX + initialPanel.shrinkTargetX) / 2),
        String(initialPanel.handleY),
      ]);
      agentBrowser(["mouse", "move", String(initialPanel.shrinkTargetX), String(initialPanel.handleY)]);
    } finally {
      agentBrowser(["mouse", "up", "left"], { allowFailure: true });
    }
  }
  await waitForEval(
    agentBrowser,
    `(() => {
      const panel = document.querySelector('#clash-copilot-panel')?.getBoundingClientRect();
      return !!panel && panel.width <= 430 &&
        !!document.querySelector('.clash-chat-input-toolbar-row');
    })()`,
    "minimum-width Plan composer",
    10000,
  );
  assertComposerToolbarLayout(
    observeComposerToolbarLayout(agentBrowser),
    "Narrow Plan composer",
  );
  agentBrowser(["screenshot", narrowPlanScreenshot]);

  if (!alreadyAtMinimumWidth) {
    const narrowedPanel = evalJson(agentBrowser, `(() => {
      const panel = document.querySelector('#clash-copilot-panel')?.getBoundingClientRect();
      const handle = document.querySelector('[aria-label="Resize panel"]')?.getBoundingClientRect();
      if (!panel || !handle) return null;
      return {
        handleX: handle.left + handle.width / 2,
        handleY: handle.top + handle.height / 2,
        restoreTargetX: panel.right - ${JSON.stringify(initialPanel.width)},
      };
    })()`);
    if (!narrowedPanel) throw new Error("Could not locate the narrowed Copilot resize handle");
    agentBrowser(["mouse", "move", String(narrowedPanel.handleX), String(narrowedPanel.handleY)]);
    agentBrowser(["mouse", "down", "left"]);
    try {
      agentBrowser([
        "mouse",
        "move",
        String((narrowedPanel.handleX + narrowedPanel.restoreTargetX) / 2),
        String(narrowedPanel.handleY),
      ]);
      agentBrowser(["mouse", "move", String(narrowedPanel.restoreTargetX), String(narrowedPanel.handleY)]);
    } finally {
      agentBrowser(["mouse", "up", "left"], { allowFailure: true });
    }
    await waitForEval(
      agentBrowser,
      `(() => {
        const width = document.querySelector('#clash-copilot-panel')?.getBoundingClientRect().width;
        return typeof width === "number" && Math.abs(width - ${JSON.stringify(initialPanel.width)}) <= 2;
      })()`,
      "restored Copilot width",
      10000,
    );
  }
  if (!clickButtonByLabel(agentBrowser, "Exit Plan mode")) {
    throw new Error("Could not close the active Plan tag");
  }
  await waitForEval(
    agentBrowser,
    `!document.querySelector('[data-testid="session-plan-tag"]')`,
    "Plan tag closed",
    10000,
  );
}

async function logRuntimeSnapshot(apiPort, label) {
  const url = `http://127.0.0.1:${apiPort}/api/v1/runtimes?probe=config&refresh=1`;
  try {
    const res = await fetch(url);
    const text = await res.text();
    console.log(`[startup-real-codex] ${label} ${res.status} ${text.slice(0, 4000)}`);
    return res.ok ? JSON.parse(text) : null;
  } catch (error) {
    console.error(`[startup-real-codex] ${label} failed`, error instanceof Error ? error.message : error);
    return null;
  }
}

async function waitForPersistedPwdOutput(apiPort, projectId) {
  const expectedPathFragment = `/.clash/projects/${projectId}`;
  const deadline = Date.now() + 60000;
  let lastState = null;
  while (Date.now() < deadline) {
    try {
      const sessionsRes = await fetch(`http://127.0.0.1:${apiPort}/api/v1/sessions?projectId=${encodeURIComponent(projectId)}`);
      const sessionsJson = sessionsRes.ok ? await sessionsRes.json() : { sessions: [] };
      const sessions = Array.isArray(sessionsJson.sessions) ? sessionsJson.sessions : [];
      for (const session of sessions) {
        const sessionId = session?.id ?? session?.threadId;
        if (!sessionId || session?.type !== "runtime") continue;
        const messagesRes = await fetch(`http://127.0.0.1:${apiPort}/api/v1/local-sessions/${encodeURIComponent(sessionId)}/messages`);
        const messagesJson = messagesRes.ok ? await messagesRes.json() : null;
        const messages = Array.isArray(messagesJson?.messages) ? messagesJson.messages : [];
        const matchingOutputs = messages
          .flatMap((message) => terminalOutputsFromEvents(message?.events))
          .filter((output) => output.includes(expectedPathFragment));
        if (matchingOutputs.length > 0) {
          return {
            sessionId,
            expectedPathFragment,
            messages: messages.length,
            toolOutputs: matchingOutputs.length,
          };
        }
        lastState = {
          sessionId,
          messagesStatus: messagesRes.status,
          messages: messages.length,
          terminalOutputs: matchingOutputs.length,
        };
      }
      lastState = { sessionsStatus: sessionsRes.status, sessions: sessions.map((session) => ({
        id: session?.id,
        threadId: session?.threadId,
        type: session?.type,
        title: session?.title,
      })) };
    } catch (error) {
      lastState = { error: error instanceof Error ? error.message : String(error) };
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for persisted pwd output: ${JSON.stringify(lastState)}`);
}

async function waitForPersistedFinalAnswer(apiPort, sessionId, expectedAnswer) {
  const deadline = Date.now() + 60000;
  let lastState = null;
  while (Date.now() < deadline) {
    try {
      const messagesRes = await fetch(
        `http://127.0.0.1:${apiPort}/api/v1/local-sessions/${encodeURIComponent(sessionId)}/messages`,
      );
      const messagesJson = messagesRes.ok ? await messagesRes.json() : null;
      const messages = Array.isArray(messagesJson?.messages) ? messagesJson.messages : [];
      const assistantMessages = messages.filter((message) => message?.sender_kind === "agent");
      const latest = assistantMessages.at(-1);
      const answer = finalAnswerTextFromEvents(latest?.events).trim();
      if (answer === expectedAnswer) {
        return { sessionId, answer, messages: messages.length };
      }
      lastState = {
        messagesStatus: messagesRes.status,
        assistantMessages: assistantMessages.length,
        answer: answer.slice(0, 1000),
      };
    } catch (error) {
      lastState = { error: error instanceof Error ? error.message : String(error) };
    }
    await sleep(500);
  }
  throw new Error(
    `Timed out waiting for exact persisted Codex final answer ${JSON.stringify(expectedAnswer)}: ${JSON.stringify(lastState)}`,
  );
}

function clashMcpToolUpdate(event) {
  if (!event || typeof event !== "object") return null;
  const outer = event;
  const update = outer.update && typeof outer.update === "object"
    ? outer.update
    : outer;
  if (!["tool_call", "tool_call_update"].includes(update.sessionUpdate)) return null;
  const meta = update._meta && typeof update._meta === "object" ? update._meta : {};
  const input = update.rawInput && typeof update.rawInput === "object"
    ? update.rawInput
    : {};
  const toolName = meta.mcp_tool_name ?? meta.mcpToolName ?? input.tool;
  if (toolName !== "clash_canvas_list") return null;
  return { update, meta, input };
}

function structuredNodeCount(rawOutput) {
  const outer = rawOutput && typeof rawOutput === "object" ? rawOutput : {};
  const result = outer.result && typeof outer.result === "object" ? outer.result : outer;
  const structured = result.structuredContent ?? result.structured_content;
  if (!structured || typeof structured !== "object") return null;
  if (Array.isArray(structured.nodes)) return structured.nodes.length;
  if (Array.isArray(structured.items)) return structured.items.length;
  return null;
}

async function waitForPersistedClashMcpOutput(apiPort, sessionId) {
  const deadline = Date.now() + 90000;
  let lastState = null;
  while (Date.now() < deadline) {
    try {
      const messagesRes = await fetch(
        `http://127.0.0.1:${apiPort}/api/v1/local-sessions/${encodeURIComponent(sessionId)}/messages`,
      );
      const messagesJson = messagesRes.ok ? await messagesRes.json() : null;
      const messages = Array.isArray(messagesJson?.messages) ? messagesJson.messages : [];
      const events = messages.flatMap((message) => Array.isArray(message?.events) ? message.events : []);
      const transcript = JSON.stringify(events);
      if (
        /[\\/]\\.codex[\\/]plugins[\\/]cache[\\/]personal[\\/]clash/i.test(transcript)
        || /\bclash\s+canvas\s+list\b/i.test(transcript)
        || /Cannot connect to Clash server/i.test(transcript)
      ) {
        throw new Error(`Clash product work fell back to a global skill or shell CLI: ${transcript.slice(0, 4000)}`);
      }
      const calls = new Map();
      for (const event of events) {
        const mcp = clashMcpToolUpdate(event);
        if (!mcp) continue;
        const toolCallId = mcp.update.toolCallId ?? mcp.update.tool_call_id ?? null;
        const previous = calls.get(toolCallId) ?? {
          sessionId,
          toolCallId,
          trusted: false,
          renderer: null,
          nodeCount: null,
        };
        const nodeCount = structuredNodeCount(mcp.update.rawOutput);
        const current = {
          ...previous,
          trusted: previous.trusted || mcp.meta["clash.host_trusted_mcp"] === true,
          renderer: mcp.meta["clash.renderer"] ?? previous.renderer,
          nodeCount: nodeCount ?? previous.nodeCount,
        };
        calls.set(toolCallId, current);
        if (
          current.trusted
          && current.renderer === "product"
          && current.nodeCount !== null
        ) {
          return current;
        }
        lastState = current;
      }
      if (calls.size === 0) {
        lastState = {
          sessionId,
          messagesStatus: messagesRes.status,
          messages: messages.length,
          clashMcpEvents: 0,
        };
      }
    } catch (error) {
      if (error instanceof Error && /fell back to a global skill or shell CLI/.test(error.message)) {
        throw error;
      }
      lastState = { error: error instanceof Error ? error.message : String(error) };
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for trusted Clash MCP output: ${JSON.stringify(lastState)}`);
}

function clickPwdToolRow(agentBrowser) {
  return evalJson(agentBrowser, `(() => {
    const exactLabels = new Set(["Ran pwd", "Run pwd", "已运行 pwd", "已运行  pwd"]);
    const labelFor = (el) => (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 &&
        style.display !== "none" && style.visibility !== "hidden" &&
        !el.disabled;
    };
    const direct = [...document.querySelectorAll("button, [role='button'], summary")]
      .find((el) => exactLabels.has(labelFor(el)) && isVisible(el));
    if (direct) {
      direct.scrollIntoView({ block: "center", inline: "center" });
      direct.click();
      return true;
    }
    const textOwner = [...document.querySelectorAll("body *")]
      .find((el) => exactLabels.has(labelFor(el)) && isVisible(el));
    const target = textOwner?.closest("button, [role='button'], summary") ?? textOwner;
    if (!target || !isVisible(target)) return false;
    target.scrollIntoView({ block: "center", inline: "center" });
    target.click();
    return true;
  })()`);
}

async function waitAndClickPwdToolRow(agentBrowser) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (clickPwdToolRow(agentBrowser)) return;
    await sleep(300);
  }
  throw new Error("Could not expand the Codex pwd tool output");
}

async function main() {
  ensureAgentBrowser();
  await resetDirs(captureDir, dataDir);

  const webPort = await findFreePort(50100);
  const apiPort = await findFreePort(50200);
  const cdpPort = await findFreePort(50300);
  const webOrigin = `http://127.0.0.1:${webPort}`;

  const webLogs = [];
  const electronLogs = [];
  let web;
  let electron;
  let stopRetryStatusCapture = false;
  let retryStatusCapture = Promise.resolve(null);
  const agentBrowser = createAgentBrowser({ sessionName, captureDir });

  try {
    web = await startVite({ webPort, logs: webLogs });
    await waitForHttp(webOrigin, "Vite desktop web shell");

    electron = await startElectron({
      cdpPort,
      webOrigin,
      apiPort,
      dataDir,
      captureDir,
      logs: electronLogs,
      env: {
        CLASH_ACP_TEST_BIN_DIR: path.join(desktopDir, "build", "acp-bin"),
        CODEX_API_KEY: "",
        OPENAI_API_KEY: "",
      },
    });
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, "Electron CDP");

    agentBrowser(["close"], { allowFailure: true });
    agentBrowser(["connect", String(cdpPort)]);
    await waitForEval(agentBrowser, `document.body.innerText.includes("Home")`, "home page");

    recoverAgentBrowserTarget(agentBrowser, {
      cdpPort,
      expectedUrlPrefix: webOrigin,
    });
    agentBrowser(["click", "a[href='/projects']"]);
    await waitForEval(agentBrowser, `location.pathname === "/projects"`, "projects route");
    if (!clickByText(agentBrowser, "New Project")) throw new Error("Could not create project");
    await submitProjectCreateDialog(agentBrowser, "Real Codex E2E");
    await waitForEval(
      agentBrowser,
      `location.pathname.startsWith("/projects/") && location.pathname !== "/projects"`,
      "project editor route",
      20000,
    );
    const projectId = evalJson(agentBrowser, `location.pathname.split("/").filter(Boolean).pop()`);
    if (!projectId) throw new Error("Could not read project id from editor route");
    await waitForEval(
      agentBrowser,
      `!!document.querySelector(".milkdown-chat-input [contenteditable='true']") &&
        document.body.innerText.includes("AI Copilot")`,
      "copilot composer",
      30000,
    );
    const coldStartProductContract = await assertColdStartProductContract({
      agentBrowser,
      apiOrigin: `http://127.0.0.1:${apiPort}`,
      projectId,
      harnessId: "codex-acp",
    });
    agentBrowser(["screenshot", coldStartScreenshot]);
    const runtimeSnapshot = await logRuntimeSnapshot(apiPort, "runtime snapshot before harness select");
    const codexAuth = runtimeSnapshot?.runtimes
      ?.flatMap((runtime) => runtime?.agents ?? [])
      .find((agent) => agent?.id === "codex-acp")
      ?.auth;
    const configuredAuthMethod = String(codexAuth?.methodId ?? "");
    const supportedAuthMethods = Array.isArray(codexAuth?.methods)
      ? codexAuth.methods.map((method) => String(method?.id ?? ""))
      : [];
    if (
      codexAuth?.status !== "configured" ||
      !configuredAuthMethod ||
      !supportedAuthMethods.includes(configuredAuthMethod)
    ) {
      throw new Error(`Real Codex E2E requires a configured, runtime-declared auth method: ${JSON.stringify(codexAuth)}`);
    }
    await selectCodexHarness(agentBrowser);

    const prompt = "Run pwd with your shell tool. After it finishes, reply exactly DONE.";
    if (!typeComposer(agentBrowser, prompt)) throw new Error("Could not type into composer");
    stopRetryStatusCapture = false;
    retryStatusCapture = captureRetryStatus(
      agentBrowser,
      retryStatusScreenshot,
      () => stopRetryStatusCapture,
    );
    if (!clickComposerSubmitButton(agentBrowser)) throw new Error("Could not click composer submit button");
    await waitForEval(
      agentBrowser,
      `(() => {
        const editor = document.querySelector(".milkdown-chat-input [contenteditable='true']");
        return !!editor && !(editor.innerText || editor.textContent || "").includes(${JSON.stringify(prompt)});
      })()`,
      "composer cleared after submit",
      10000,
    );

    const persistedToolOutput = await waitForPersistedPwdOutput(apiPort, projectId);
    const projectWorkspaceLayout = await assertProjectWorkspaceLayout(projectId);
    const nativeClashSkill = await assertNativeClashSkill(
      projectWorkspaceLayout.projectWorkspaceRoot,
    );
    const projectStatus = await fetchAndAssertProjectStatus(apiPort, projectId);
    await waitAndClickPwdToolRow(agentBrowser);
    await waitForEval(
      agentBrowser,
      `(() => document.body.innerText.includes(${JSON.stringify(`/.clash/projects/${projectId}`)}))()`,
      "Codex tool output project cwd path",
      10000,
    );
    await waitForEval(
      agentBrowser,
      `!document.body.innerText.includes("Falling back from WebSockets to HTTPS transport")`,
      "transport diagnostics hidden from transcript",
      10000,
    );
    await waitForEval(
      agentBrowser,
      `!document.querySelector(".clash-chat-input-stop")`,
      "Codex turn idle after final answer",
      240000,
    );
    const persistedFinalAnswer = await waitForPersistedFinalAnswer(
      apiPort,
      persistedToolOutput.sessionId,
      "DONE",
    );
    stopRetryStatusCapture = true;
    const retryStatus = await retryStatusCapture;
    const transportDiagnosticObserved = hasTransportDiagnostic(electronLogs);
    if (transportDiagnosticObserved && !retryStatus) {
      throw new Error("Codex transport retry/fallback was observed in logs, but no retry status appeared in the UI");
    }

    evalJson(agentBrowser, `(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      return true;
    })()`);
    await sleep(50);
    const composerDesignTokens = readComposerDesignTokens(
      agentBrowser,
      ".clash-chat-input-surface",
    );
    if (!composerDesignTokens) throw new Error("Could not read the composer design tokens");
    await selectPermissionMode(agentBrowser, "Ask for approval");
    const permissionPrompt = [
      "Use the shell to write the word approved to drafts/e2e-permission-check.txt.",
      "After the command finishes, reply exactly APPROVED.",
    ].join(" ");
    if (!typeComposer(agentBrowser, permissionPrompt)) {
      throw new Error("Could not type the permission E2E prompt into composer");
    }
    if (!clickComposerSubmitButton(agentBrowser)) {
      throw new Error("Could not submit the permission E2E prompt");
    }
    await waitForEval(
      agentBrowser,
      `(() => {
        const approval = document.querySelector('[data-testid="acp-permission-card"]');
        const editor = document.querySelector('.milkdown-chat-input');
        const permissionTrigger = document.querySelector('[data-testid="session-permission-mode-trigger"]');
        const runTrigger = document.querySelector('[data-testid="session-harness-config-trigger"]');
        const rect = approval?.getBoundingClientRect();
        return !!approval && !!rect && rect.width > 0 && rect.height > 0 &&
          !editor && !permissionTrigger && !runTrigger;
      })()`,
      "blocking approval replacing the entire composer",
      60000,
    );
    const permissionDesignTokens = readComposerDesignTokens(
      agentBrowser,
      "[data-testid='acp-permission-card']",
    );
    if (JSON.stringify(permissionDesignTokens) !== JSON.stringify(composerDesignTokens)) {
      throw new Error(
        `Approval surface drifted from composer design tokens: ${JSON.stringify({ composerDesignTokens, permissionDesignTokens })}`,
      );
    }
    agentBrowser(["screenshot", permissionScreenshot]);
    const approved = evalJson(agentBrowser, `(() => {
      const approval = document.querySelector('[data-testid="acp-permission-card"]');
      const button = [...(approval?.querySelectorAll('button') ?? [])].find((candidate) => {
        const label = (candidate.innerText || candidate.textContent || "").trim().toLowerCase();
        const rect = candidate.getBoundingClientRect();
        const style = getComputedStyle(candidate);
        return label.startsWith("allow") &&
          rect.width > 0 && rect.height > 0 &&
          style.display !== "none" && style.visibility !== "hidden" &&
          !candidate.disabled;
      });
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!approved) {
      throw new Error("Could not approve the blocking permission request");
    }
    await waitForEval(
      agentBrowser,
      `!document.querySelector('[data-testid="acp-permission-card"]') &&
        !!document.querySelector('.milkdown-chat-input')`,
      "composer restored after approval",
      60000,
    );
    await waitForEval(
      agentBrowser,
      `!document.querySelector(".clash-chat-input-stop") && document.body.innerText.includes("APPROVED")`,
      "permission turn completed",
      240000,
    );

    await verifyPlanCommandResponsiveComposer(agentBrowser);

    const mcpPrompt = [
      "Inspect the current Canvas with the bundled Clash MCP tool clash_canvas_list.",
      "Do not use a shell or the Clash CLI.",
      "Reply with exactly nodes: N using the returned node count.",
    ].join(" ");
    if (!typeComposer(agentBrowser, mcpPrompt)) {
      throw new Error("Could not type the Clash MCP prompt into composer");
    }
    if (!clickComposerSubmitButton(agentBrowser)) {
      throw new Error("Could not submit the Clash MCP prompt");
    }
    await waitForEval(
      agentBrowser,
      `(() => {
        const editor = document.querySelector(".milkdown-chat-input [contenteditable='true']");
        return !!editor && !(editor.innerText || editor.textContent || "").includes(${JSON.stringify(mcpPrompt)});
      })()`,
      "Clash MCP prompt cleared after submit",
      10000,
    );
    const persistedClashMcpOutput = await waitForPersistedClashMcpOutput(
      apiPort,
      persistedToolOutput.sessionId,
    );
    await waitForEval(
      agentBrowser,
      `!document.querySelector(".clash-chat-input-stop")`,
      "Clash MCP turn idle after final answer",
      240000,
    );
    const persistedClashMcpAnswer = await waitForPersistedFinalAnswer(
      apiPort,
      persistedToolOutput.sessionId,
      `nodes: ${persistedClashMcpOutput.nodeCount}`,
    );
    await waitForEval(
      agentBrowser,
      `document.body.innerText.includes("List Canvas") &&
        document.body.innerText.includes(${JSON.stringify(`${persistedClashMcpOutput.nodeCount} nodes`)}) &&
        !document.body.innerText.includes("Cannot connect to Clash server")`,
      "trusted Clash MCP result visible without CLI fallback",
      30000,
    );
    agentBrowser(["screenshot", finalScreenshot]);

    recoverAgentBrowserTarget(agentBrowser, {
      cdpPort,
      expectedUrlPrefix: webOrigin,
    });
    await waitForEval(
      agentBrowser,
      `!!document.querySelector('button[aria-label="New session"], button[aria-label="新建会话"]')`,
      "new session header action after target recovery",
    );
    if (!clickButtonByLabel(agentBrowser, "New session") && !clickButtonByLabel(agentBrowser, "新建会话")) {
      throw new Error("Could not create a fresh session from the header");
    }
    await waitForEval(
      agentBrowser,
      `!document.body.innerText.includes(${JSON.stringify(prompt)})`,
      "fresh session cleared visible transcript",
      30000,
    );
    await openSessionHistoryMenu(agentBrowser);
    await waitForEval(
      agentBrowser,
      `(() => {
        const menu = document.querySelector('[role="menu"][aria-label="Session history"], [role="menu"][aria-label="历史会话"]');
        const rect = menu?.getBoundingClientRect();
        return !!menu && !!rect && rect.width > 0 && rect.height > 0 &&
          !menu.innerText.toLowerCase().includes("no history yet");
      })()`,
      "persisted runtime session history",
      30000,
    );
    await waitForEval(
      agentBrowser,
      `(() => {
        const text = document.body.innerText;
        return text.includes("Run pwd");
      })()`,
      "runtime session history keeps the prompt title",
      30000,
    );
    agentBrowser(["screenshot", historyScreenshot]);

    const state = evalJson(agentBrowser, `(() => ({
      href: location.href,
      text: document.body.innerText.slice(0, 1200),
    }))()`);
    console.log("[startup-real-codex] ok", JSON.stringify({
      finalScreenshot,
      historyScreenshot,
      retryStatusScreenshot: retryStatus?.screenshot ?? null,
      coldStartScreenshot,
      permissionScreenshot,
      coldStartProductContract,
      retryStatusText: retryStatus?.text ?? null,
      transportDiagnosticObserved,
      persistedToolOutput,
      persistedFinalAnswer,
      persistedClashMcpOutput,
      persistedClashMcpAnswer,
      projectWorkspaceLayout,
      nativeClashSkill,
      projectStatus,
      state,
    }));
  } catch (error) {
    stopRetryStatusCapture = true;
    await logRuntimeSnapshot(apiPort, "runtime snapshot after failure");
    try {
      agentBrowser(["screenshot", failureScreenshot], { allowFailure: true });
      console.error(`[startup-real-codex] failure screenshot ${failureScreenshot}`);
    } catch {
      // Ignore screenshot failure while unwinding.
    }
    console.error("[startup-real-codex] web logs\n" + tail(webLogs));
    console.error("[startup-real-codex] electron logs\n" + tail(electronLogs));
    throw error;
  } finally {
    agentBrowser(["close"], { allowFailure: true });
    await stopProcess(electron);
    await stopProcess(web);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
