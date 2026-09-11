import path from "node:path";
import {
  clickButtonByLabel,
  clickByText,
  clickComposerSubmitButton,
  createAgentBrowser,
  evalJson,
  findFreePort,
  repoRoot,
  resetDirs,
  sleep,
  startElectron,
  startVite,
  stopProcess,
  tail,
  typeComposer,
  waitForEval,
  waitForHttp,
} from "./startup-shared.ts";

const runRoot = path.join(repoRoot, ".tmp", "startup-queue-smoke");
const captureDir = process.env.CLASH_E2E_QUEUE_CAPTURE_DIR ?? path.join(runRoot, "screenshots");
const dataDir = process.env.CLASH_E2E_QUEUE_DATA_DIR ?? path.join(runRoot, "data");
const sessionName = `clash-queue-smoke-${Date.now().toString(36)}`;
const failureScreenshot = path.join(captureDir, "failure.png");
const queuedScreenshot = path.join(captureDir, "01-queued.png");
const drainScreenshot = path.join(captureDir, "02-after-first-drain.png");
const clearedScreenshot = path.join(captureDir, "03-removed.png");
const steeredScreenshot = path.join(captureDir, "04-steered.png");

async function waitForProjectComposer(agentBrowser) {
  await waitForEval(
    agentBrowser,
    `!!document.querySelector(".milkdown-chat-input [contenteditable='true']") &&
      document.body.innerText.includes("AI Copilot")`,
    "copilot composer",
    30000,
  );
}

function bodyText(agentBrowser) {
  return evalJson(agentBrowser, `document.body.innerText`);
}

async function submitPrompt(agentBrowser, prompt) {
  if (!typeComposer(agentBrowser, prompt)) throw new Error(`Could not type prompt: ${prompt}`);
  if (!clickComposerSubmitButton(agentBrowser)) throw new Error(`Could not submit prompt: ${prompt}`);
}

async function main() {
  await resetDirs(captureDir, dataDir);

  const webPort = await findFreePort(51100);
  const apiPort = await findFreePort(51200);
  const cdpPort = await findFreePort(51300);
  const webOrigin = `http://127.0.0.1:${webPort}`;

  const webLogs = [];
  const electronLogs = [];
  let web;
  let electron;
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
        CLASH_E2E_STUB_ACP: "1",
        CLASH_E2E_STUB_ACP_DELAY_MS: "20000",
      },
    });
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, "Electron CDP");

    agentBrowser(["close"], { allowFailure: true });
    agentBrowser(["connect", String(cdpPort)]);
    await waitForEval(agentBrowser, `document.body.innerText.includes("Home")`, "home page");

    if (!clickByText(agentBrowser, "Projects")) throw new Error("Could not open Projects");
    await waitForEval(agentBrowser, `location.pathname === "/projects"`, "projects route");
    if (!clickByText(agentBrowser, "New Project")) throw new Error("Could not create project");
    await waitForEval(
      agentBrowser,
      `location.pathname.startsWith("/projects/") && location.pathname !== "/projects"`,
      "project editor route",
      20000,
    );
    await waitForProjectComposer(agentBrowser);
    await waitForEval(
      agentBrowser,
      `(() => localStorage.getItem("clash.runtimePromptQueue.enabled") !== "false")()`,
      "prompt queue enabled by default",
    );

    await submitPrompt(agentBrowser, "queue smoke first slow turn");
    await sleep(350);
    await submitPrompt(agentBrowser, "queue smoke queued second");
    await sleep(350);
    await submitPrompt(agentBrowser, "queue smoke queued third");

    await waitForEval(
      agentBrowser,
      `(() => {
        const text = document.body.innerText;
        return text.includes("queue smoke queued second") &&
          text.includes("queue smoke queued third") &&
          !text.includes("2 queued") &&
          !text.includes("Mock ACP reply: queue smoke queued second") &&
          !text.includes("Mock ACP reply: queue smoke queued third");
      })()`,
      "two queued prompts before they are sent to the agent",
      15000,
    );
    agentBrowser(["screenshot", queuedScreenshot]);

    await waitForEval(
      agentBrowser,
      `(() => {
        const text = document.body.innerText;
        return text.includes("queue smoke queued third") &&
          text.includes("Mock ACP reply: queue smoke first slow turn");
      })()`,
      "default single queue drain after the first turn",
      20000,
    );
    agentBrowser(["screenshot", drainScreenshot]);

    await submitPrompt(agentBrowser, "queue smoke queued fourth");
    await waitForEval(
      agentBrowser,
      `(() => {
        const text = document.body.innerText;
        return text.includes("queue smoke queued third") &&
          text.includes("queue smoke queued fourth") &&
          !text.includes("Mock ACP reply: queue smoke queued third") &&
          !text.includes("Mock ACP reply: queue smoke queued fourth") &&
          !!Array.from(document.querySelectorAll("button"))
            .find((el) => el.getAttribute("aria-label") === "Remove queued message 2");
      })()`,
      "second queued prompt added while second turn is running",
      10000,
    );
    if (!clickButtonByLabel(agentBrowser, "Remove queued message 2")) {
      throw new Error("Could not remove the extra queued prompt");
    }
    await waitForEval(
      agentBrowser,
      `(() => {
        const text = document.body.innerText;
        return text.includes("queue smoke queued third") &&
          !text.includes("queue smoke queued fourth") &&
          !!Array.from(document.querySelectorAll("button"))
            .find((el) => el.getAttribute("aria-label") === "Steer queued message 1");
      })()`,
      "extra queued prompt removed",
      10000,
    );
    agentBrowser(["screenshot", clearedScreenshot]);

    if (!clickButtonByLabel(agentBrowser, "Steer queued message 1")) {
      throw new Error("Could not steer the remaining queued prompt");
    }
    await waitForEval(
      agentBrowser,
      `(() => {
        const text = document.body.innerText;
        const button = Array.from(document.querySelectorAll("button"))
          .find((el) => el.getAttribute("aria-label") === "Steer queued message 1");
        return !button &&
          text.includes("queue smoke queued third") &&
          !text.includes("queue smoke queued fourth");
      })()`,
      "queued prompt converted to an in-flight steer",
      10000,
    );
    agentBrowser(["screenshot", steeredScreenshot]);

    await waitForEval(
      agentBrowser,
      `(() => {
        const text = document.body.innerText;
        return text.includes("Mock ACP reply: queue smoke queued second") &&
          text.includes("Mock ACP reply: queue smoke queued third") &&
          !text.includes("queue smoke queued fourth");
      })()`,
      "steered prompt completes while removed prompt stays absent",
      25000,
    );

    const state = {
      text: bodyText(agentBrowser).slice(0, 1800),
      queuedScreenshot,
      drainScreenshot,
      steeredScreenshot,
      clearedScreenshot,
    };
    console.log("[startup-queue-smoke] ok", JSON.stringify(state, null, 2));
  } catch (error) {
    try {
      agentBrowser(["screenshot", failureScreenshot], { allowFailure: true });
      console.error(`[startup-queue-smoke] failure screenshot ${failureScreenshot}`);
    } catch {
      // Ignore screenshot failure while unwinding.
    }
    console.error("[startup-queue-smoke] web logs\n" + tail(webLogs));
    console.error("[startup-queue-smoke] electron logs\n" + tail(electronLogs));
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
