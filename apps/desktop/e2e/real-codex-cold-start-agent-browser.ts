import { access, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertColdStartProductContract,
  assertRecentRunPreferencesProductContract,
  chooseAlternateRunPreferences,
} from "./product-cold-start-contract.ts";
import {
  clickByText,
  createAgentBrowser,
  desktopDir,
  ensureAgentBrowser,
  evalJson,
  findFreePort,
  recoverAgentBrowserTarget,
  repoRoot,
  resetDirs,
  sleep,
  startElectron,
  startVite,
  stopProcess,
  submitProjectCreateDialog,
  tail,
  waitForEval,
  waitForHttp,
} from "./startup-shared.ts";

if (process.env.CLASH_E2E_REAL_CODEX !== "1") {
  throw new Error(
    "Refusing to run the product cold-start E2E without CLASH_E2E_REAL_CODEX=1",
  );
}

const runRoot = path.join(repoRoot, ".tmp", "real-codex-cold-start");
const clashHome = path.join(runRoot, ".clash");
const dataDir = path.join(clashHome, "local-api");
const electronUserDataDir = path.join(clashHome, "desktop", "user-data");
const captureDir = path.join(runRoot, "screenshots");
const screenshotPath = path.join(captureDir, "cold-start-product.png");
const recentScreenshotPath = path.join(
  captureDir,
  "cold-restart-recent-preferences.png",
);
const failureScreenshotPath = path.join(captureDir, "failure.png");
const configPath = path.join(clashHome, "config.yaml");
const sessionName = `clash-product-cold-${Date.now().toString(36)}`;

const configSource = [
  "version: 1",
  "harnesses:",
  "  enabled:",
  "    - codex-acp",
  "",
].join("\n");

async function runtimeSessionCount(apiOrigin, projectId) {
  const response = await fetch(
    `${apiOrigin}/api/v1/sessions?projectId=${encodeURIComponent(projectId)}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) {
    throw new Error(`Could not list product runtime sessions: HTTP ${response.status}`);
  }
  const body = await response.json();
  const sessions = Array.isArray(body?.sessions) ? body.sessions : [];
  return sessions.filter((session) => session?.type === "runtime").length;
}

async function main() {
  ensureAgentBrowser();
  await resetDirs(runRoot, clashHome, captureDir);
  await writeFile(configPath, configSource, { encoding: "utf8", mode: 0o600 });

  const webPort = await findFreePort(50700);
  const apiPort = await findFreePort(50800);
  const cdpPort = await findFreePort(50900);
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const agentBrowser = createAgentBrowser({ sessionName, captureDir });

  const webLogs = [];
  const electronLogs = [];
  let web;
  let electron;

  try {
    web = await startVite({ webPort, logs: webLogs });
    await waitForHttp(webOrigin, "Vite desktop web shell");

    electron = await startElectron({
      cdpPort,
      webOrigin,
      apiPort,
      dataDir,
      electronUserDataDir,
      captureDir,
      logs: electronLogs,
      env: {
        CLASH_HOME: clashHome,
        CLASH_ACP_TEST_BIN_DIR: path.join(desktopDir, "build", "acp-bin"),
        CODEX_API_KEY: "",
        OPENAI_API_KEY: "",
      },
    });
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, "Electron CDP");

    agentBrowser(["close"], { allowFailure: true });
    agentBrowser(["connect", String(cdpPort)]);
    await waitForEval(agentBrowser, `document.body.innerText.includes("Home")`, "home page");

    if (!clickByText(agentBrowser, "Projects")) throw new Error("Could not open Projects");
    await waitForEval(agentBrowser, `location.pathname === "/projects"`, "projects route");
    if (!clickByText(agentBrowser, "New Project")) throw new Error("Could not create project");
    await submitProjectCreateDialog(agentBrowser, "Cold Start Product E2E");
    const projectId = await waitForEval(
      agentBrowser,
      `location.pathname.startsWith("/projects/") &&
        location.pathname !== "/projects" &&
        location.pathname.split("/").filter(Boolean).pop()`,
      "project editor route",
      20_000,
    );
    await waitForEval(
      agentBrowser,
      `!!document.querySelector(".milkdown-chat-input [contenteditable='true']") &&
        document.body.innerText.includes("AI Copilot")`,
      "copilot composer",
      30_000,
    );

    const observation = await assertColdStartProductContract({
      agentBrowser,
      apiOrigin,
      projectId,
      clashHome,
      harnessId: "codex-acp",
    });
    if (observation.profile.auth?.status !== "configured") {
      throw new Error(
        `Product cold-start E2E requires configured Codex auth: ${
          JSON.stringify(observation.profile.auth)
        }`,
      );
    }

    agentBrowser(["screenshot", screenshotPath]);
    await access(path.join(dataDir, "local.sqlite"));
    const sqlite = await stat(path.join(dataDir, "local.sqlite"));
    if (!sqlite.isFile()) throw new Error("Product local SQLite is not a file");
    const persistedConfig = await readFile(configPath, "utf8");
    if (persistedConfig !== configSource) {
      throw new Error(
        `Cold-start probing rewrote declarative config.yaml:\n${persistedConfig}`,
      );
    }

    const alternatePreferences = chooseAlternateRunPreferences(
      observation.profile,
    );
    const recentSessionResponse = await fetch(
      `${apiOrigin}/api/v1/runtimes/desktop-local/sessions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent_id: alternatePreferences.harnessId,
          project_id: projectId,
          ...(alternatePreferences.permissionMode !== undefined
            ? { permission_mode: alternatePreferences.permissionMode }
            : {}),
          config_values: alternatePreferences.configValues,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const recentSessionText = await recentSessionResponse.text();
    if (!recentSessionResponse.ok) {
      throw new Error(
        `Could not record recent run choices: HTTP ${
          recentSessionResponse.status
        }: ${recentSessionText.slice(0, 1000)}`,
      );
    }
    const recentSession = JSON.parse(recentSessionText);
    const sessionsBeforeRestart = await runtimeSessionCount(apiOrigin, projectId);
    if (sessionsBeforeRestart !== 1) {
      throw new Error(
        `Expected one recorded runtime session before restart; received ${sessionsBeforeRestart}`,
      );
    }

    agentBrowser(["close"], { allowFailure: true });
    await stopProcess(electron);
    electron = undefined;

    electron = await startElectron({
      cdpPort,
      webOrigin,
      apiPort,
      dataDir,
      electronUserDataDir,
      captureDir,
      logs: electronLogs,
      env: {
        CLASH_HOME: clashHome,
        CLASH_ACP_TEST_BIN_DIR: path.join(desktopDir, "build", "acp-bin"),
        CODEX_API_KEY: "",
        OPENAI_API_KEY: "",
      },
    });
    await waitForHttp(
      `http://127.0.0.1:${cdpPort}/json/version`,
      "cold-restarted Electron CDP",
    );
    agentBrowser(["connect", String(cdpPort)]);
    await waitForEval(agentBrowser, `document.body.innerText.includes("Home")`, "restarted home page");
    if (!clickByText(agentBrowser, "Projects")) {
      throw new Error("Could not open Projects after cold restart");
    }
    await waitForEval(agentBrowser, `location.pathname === "/projects"`, "restarted projects route");
    const openedExistingProject = evalJson(agentBrowser, `(() => {
      const wanted = "Cold Start Product E2E";
      const candidate = [...document.querySelectorAll("a, button, [role='button']")]
        .find((element) => (element.innerText || element.textContent || "").includes(wanted));
      if (!candidate) return false;
      candidate.click();
      return true;
    })()`);
    if (!openedExistingProject) {
      evalJson(
        agentBrowser,
        `(() => { location.href = ${
          JSON.stringify(`${webOrigin}/projects/${projectId}`)
        }; return true; })()`,
      );
      await sleep(750);
      recoverAgentBrowserTarget(agentBrowser, {
        cdpPort,
        expectedUrlPrefix: webOrigin,
      });
    }
    await waitForEval(
      agentBrowser,
      `location.pathname === ${JSON.stringify(`/projects/${projectId}`)} &&
        !!document.querySelector(".milkdown-chat-input [contenteditable='true']")`,
      "project composer after cold restart",
      30_000,
    );

    const recentPreferences = await assertRecentRunPreferencesProductContract({
      agentBrowser,
      apiOrigin,
      projectId,
      harnessId: "codex-acp",
      expectedPreferences: alternatePreferences,
      sessionsBeforeRestart,
    });
    agentBrowser(["click", '[data-testid="session-harness-config-trigger"]']);
    await waitForEval(
      agentBrowser,
      `!!document.querySelector('[role="menu"][data-state="open"]')`,
      "recent run menu for evidence screenshot",
      10_000,
    );
    agentBrowser(["screenshot", recentScreenshotPath]);
    agentBrowser(["press", "Escape"]);

    console.log("[product-cold-start] ok", JSON.stringify({
      clashHome,
      configPath,
      sqlitePath: path.join(dataDir, "local.sqlite"),
      electronUserDataDir,
      screenshotPath,
      recentScreenshotPath,
      projectId,
      recentSessionId: recentSession.session_id,
      observation,
      recentPreferences,
    }));
  } catch (error) {
    try {
      agentBrowser(["screenshot", failureScreenshotPath], { allowFailure: true });
      console.error(`[product-cold-start] failure screenshot ${failureScreenshotPath}`);
    } catch {
      // Preserve the original product-contract failure.
    }
    console.error("[product-cold-start] web logs\n" + tail(webLogs));
    console.error("[product-cold-start] electron logs\n" + tail(electronLogs));
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
