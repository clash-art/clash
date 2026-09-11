import path from "node:path";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import {
  clickButtonByLabel,
  clickByText,
  clickComposerSubmitButton,
  createAgentBrowser,
  desktopDir,
  ensureAgentBrowser,
  evalJson,
  findFreePort,
  openSessionHistoryMenu,
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
import { terminalOutputsFromEvents } from "./real-codex-transcript.ts";

if (process.env.CLASH_E2E_REAL_CODEX !== "1") {
  throw new Error("Refusing to run the real Codex resume E2E without CLASH_E2E_REAL_CODEX=1");
}

const runRoot = path.join(repoRoot, ".tmp", "startup-real-codex-resume");
const captureDir = process.env.CLASH_E2E_REAL_CODEX_RESUME_CAPTURE_DIR ?? path.join(runRoot, "screenshots");
const dataDir = process.env.CLASH_E2E_REAL_CODEX_RESUME_DATA_DIR ?? path.join(runRoot, "data");
const sessionName = `clash-real-codex-resume-${Date.now().toString(36)}`;
const failureScreenshot = path.join(captureDir, "failure.png");
const firstFinalScreenshot = path.join(captureDir, "01-first-turn-final.png");
const historyScreenshot = path.join(captureDir, "02-reopened-history.png");
const resumedScreenshot = path.join(captureDir, "03-resumed-session.png");
const secondFinalScreenshot = path.join(captureDir, "04-second-turn-final.png");

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

function visibleMenuItemSelector() {
  return `[role="menu"] [role="menuitem"]`;
}

function clickFirstHistoryItem(agentBrowser) {
  return evalJson(agentBrowser, `(() => {
    const items = [...document.querySelectorAll(${JSON.stringify(visibleMenuItemSelector())})]
      .filter((item) => {
        const rect = item.getBoundingClientRect();
        const style = getComputedStyle(item);
        return rect.width > 0 && rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          !item.disabled;
      });
    const item = items[0];
    if (!item) return false;
    item.scrollIntoView({ block: "center", inline: "center" });
    item.click();
    return true;
  })()`);
}

async function waitForPersistedPwdOutput(apiPort, projectId, minimumOutputs) {
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
        const outputCount = messages
          .flatMap((message) => terminalOutputsFromEvents(message?.events))
          .filter((output) => output.includes(expectedPathFragment))
          .length;
        if (outputCount >= minimumOutputs) {
          return { sessionId, expectedPathFragment, outputCount };
        }
        lastState = { sessionId, messagesStatus: messagesRes.status, outputCount };
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
  throw new Error(`Timed out waiting for persisted pwd output count ${minimumOutputs}: ${JSON.stringify(lastState)}`);
}

function visibleProjectPathCount(agentBrowser, projectId) {
  return evalJson(agentBrowser, `(() => {
    const expected = ${JSON.stringify(`/.clash/projects/${projectId}`)};
    return (document.body.innerText.split(expected).length - 1);
  })()`);
}

function clickCollapsedPwdToolRow(agentBrowser) {
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
    const row = [...document.querySelectorAll("button, [role='button'], summary")]
      .find((el) => exactLabels.has(labelFor(el)) && el.getAttribute("aria-expanded") !== "true" && isVisible(el));
    if (!row) return false;
    row.scrollIntoView({ block: "center", inline: "center" });
    row.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    }));
    row.click();
    return true;
  })()`);
}

async function ensurePwdToolOutputVisible(agentBrowser, projectId, minimumPathRows) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (visibleProjectPathCount(agentBrowser, projectId) >= minimumPathRows) return;
    clickCollapsedPwdToolRow(agentBrowser);
    await sleep(300);
  }
  throw new Error(`Timed out waiting for visible expanded pwd output count ${minimumPathRows}`);
}

async function launchElectron({ cdpPort, webOrigin, apiPort, dataDir, captureDir, electronLogs }) {
  const electron = await startElectron({
    cdpPort,
    webOrigin,
    apiPort,
    dataDir,
    captureDir,
    logs: electronLogs,
    env: {
      CLASH_ACP_TEST_BIN_DIR: path.join(desktopDir, "build", "acp-bin"),
    },
  });
  await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, "Electron CDP");
  return electron;
}

async function waitForProjectComposer(agentBrowser) {
  await waitForEval(
    agentBrowser,
    `!!document.querySelector(".milkdown-chat-input [contenteditable='true']") &&
      document.body.innerText.includes("AI Copilot")`,
    "copilot composer",
    30000,
  );
}

async function submitAndWaitForPwd(agentBrowser, prompt, apiPort, projectId, minimumOutputs) {
  if (!typeComposer(agentBrowser, prompt)) throw new Error(`Could not type prompt: ${prompt}`);
  if (!clickComposerSubmitButton(agentBrowser)) throw new Error("Could not click composer submit button");
  await waitForEval(
    agentBrowser,
    `(() => {
      const editor = document.querySelector(".milkdown-chat-input [contenteditable='true']");
      return !!editor && !(editor.innerText || editor.textContent || "").includes(${JSON.stringify(prompt.replaceAll("`", ""))});
    })()`,
    "composer cleared after submit",
    10000,
  );
  await waitForPersistedPwdOutput(apiPort, projectId, minimumOutputs);
  await ensurePwdToolOutputVisible(agentBrowser, projectId, minimumOutputs);
  await waitForEval(
    agentBrowser,
    `!document.querySelector(".clash-chat-input-stop")`,
    "Codex turn idle after final answer",
    240000,
  );
}

async function main() {
  ensureAgentBrowser();
  await resetDirs(captureDir, dataDir);

  const webPort = await findFreePort(50100);
  const apiPort = await findFreePort(50200);
  const firstCdpPort = await findFreePort(50300);
  const secondCdpPort = await findFreePort(50400);
  const webOrigin = `http://127.0.0.1:${webPort}`;

  const webLogs = [];
  const electronLogs = [];
  let web;
  let electron;
  const agentBrowser = createAgentBrowser({ sessionName, captureDir });

  try {
    web = await startVite({ webPort, logs: webLogs });
    await waitForHttp(webOrigin, "Vite desktop web shell");

    electron = await launchElectron({
      cdpPort: firstCdpPort,
      webOrigin,
      apiPort,
      dataDir,
      captureDir,
      electronLogs,
    });

    agentBrowser(["close"], { allowFailure: true });
    agentBrowser(["connect", String(firstCdpPort)]);
    await waitForEval(agentBrowser, `document.body.innerText.includes("Home")`, "home page");

    if (!clickByText(agentBrowser, "Projects")) throw new Error("Could not open Projects");
    await waitForEval(agentBrowser, `location.pathname === "/projects"`, "projects route");
    if (!clickByText(agentBrowser, "New Project")) throw new Error("Could not create project");
    await submitProjectCreateDialog(agentBrowser, "Real Codex Resume E2E");
    await waitForEval(
      agentBrowser,
      `location.pathname.startsWith("/projects/") && location.pathname !== "/projects"`,
      "project editor route",
      20000,
    );
    const projectUrl = evalJson(agentBrowser, `location.href`);
    const projectId = new URL(projectUrl).pathname.split("/").filter(Boolean).pop();
    if (!projectId) throw new Error(`Could not determine project id from ${projectUrl}`);
    await waitForProjectComposer(agentBrowser);

    const firstPrompt = "Run pwd with your shell tool. After it finishes, reply exactly DONE.";
    await submitAndWaitForPwd(agentBrowser, firstPrompt, apiPort, projectId, 1);
    const firstProjectWorkspaceLayout = await assertProjectWorkspaceLayout(projectId);
    const firstProjectStatus = await fetchAndAssertProjectStatus(apiPort, projectId);
    agentBrowser(["screenshot", firstFinalScreenshot]);

    agentBrowser(["close"], { allowFailure: true });
    await stopProcess(electron);
    electron = null;
    await sleep(1200);

    electron = await launchElectron({
      cdpPort: secondCdpPort,
      webOrigin,
      apiPort,
      dataDir,
      captureDir,
      electronLogs,
    });
    agentBrowser(["connect", String(secondCdpPort)]);
    await waitForEval(agentBrowser, `document.body.innerText.includes("Home")`, "reopened home page");
    agentBrowser(["open", projectUrl]);
    await waitForEval(
      agentBrowser,
      `location.href === ${JSON.stringify(projectUrl)} || location.pathname.startsWith("/projects/")`,
      "reopened project route",
      30000,
    );
    await waitForProjectComposer(agentBrowser);

    await openSessionHistoryMenu(agentBrowser);
    await waitForEval(
      agentBrowser,
      `(() => {
        const menu = document.querySelector('[role="menu"][aria-label="Session history"], [role="menu"][aria-label="历史会话"]');
        const rect = menu?.getBoundingClientRect();
        return !!menu && !!rect && rect.width > 0 && rect.height > 0 &&
          !menu.innerText.toLowerCase().includes("no history yet") &&
          menu.innerText.includes("Run pwd");
      })()`,
      "reopened persisted session history",
      30000,
    );
    agentBrowser(["screenshot", historyScreenshot]);

    if (!clickFirstHistoryItem(agentBrowser)) throw new Error("Could not select the persisted runtime session");
    await waitForEval(
      agentBrowser,
      `(() => {
        const text = document.body.innerText;
        return text.includes("Run pwd") &&
          (text.match(/Ran pwd|Run pwd|已运行\\s+pwd|已运行 pwd/g) || []).length >= 1;
      })()`,
      "resumed transcript loaded",
      30000,
    );
    await ensurePwdToolOutputVisible(agentBrowser, projectId, 1);
    agentBrowser(["screenshot", resumedScreenshot]);

    const secondPrompt = "Run pwd again with your shell tool. After it finishes, reply exactly DONE.";
    await submitAndWaitForPwd(agentBrowser, secondPrompt, apiPort, projectId, 2);
    const resumedProjectWorkspaceLayout = await assertProjectWorkspaceLayout(projectId);
    const resumedProjectStatus = await fetchAndAssertProjectStatus(apiPort, projectId);
    agentBrowser(["screenshot", secondFinalScreenshot]);

    const state = evalJson(agentBrowser, `(() => ({
      href: location.href,
      text: document.body.innerText.slice(0, 1600),
    }))()`);
    console.log("[startup-real-codex-resume] ok", JSON.stringify({
      firstFinalScreenshot,
      historyScreenshot,
      resumedScreenshot,
      secondFinalScreenshot,
      firstProjectWorkspaceLayout,
      firstProjectStatus,
      resumedProjectWorkspaceLayout,
      resumedProjectStatus,
      state,
    }));
  } catch (error) {
    try {
      agentBrowser(["screenshot", failureScreenshot], { allowFailure: true });
      console.error(`[startup-real-codex-resume] failure screenshot ${failureScreenshot}`);
    } catch {
      // Ignore screenshot failure while unwinding.
    }
    console.error("[startup-real-codex-resume] web logs\n" + tail(webLogs));
    console.error("[startup-real-codex-resume] electron logs\n" + tail(electronLogs));
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
