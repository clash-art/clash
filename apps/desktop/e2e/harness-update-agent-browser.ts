import path from "node:path";
import { writeFile } from "node:fs/promises";

import {
  clickByText,
  clickButtonByLabel,
  clickComposerSubmitButton,
  createAgentBrowser,
  ensureAgentBrowser,
  evalJson,
  findFreePort,
  resetDirs,
  startElectron,
  startVite,
  stopProcess,
  submitProjectCreateDialog,
  tail,
  typeComposer,
  waitForEval,
  waitForHttp,
} from "./startup-shared.ts";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const runRoot = path.join(repoRoot, ".tmp", "harness-update-gui-e2e");
const captureDir = path.join(runRoot, "screenshots");
const dataDir = path.join(runRoot, "data");
const controlScreenshot = path.join(captureDir, "01-active-turn-update-control.png");
const expandedScreenshot = path.join(captureDir, "02-expanded-updates.png");
const restartScreenshot = path.join(
  captureDir,
  "03-restart-after-turn.png",
);
const queuedScreenshot = path.join(captureDir, "04-restart-queued.png");
const completeScreenshot = path.join(captureDir, "05-session-restarted-fading.png");
const selfDestructedScreenshot = path.join(captureDir, "06-update-notice-self-destructed.png");
const failureScreenshot = path.join(captureDir, "failure.png");
const sessionName = `clash-harness-update-${Date.now().toString(36)}`;

async function main() {
  ensureAgentBrowser();
  await resetDirs(captureDir, dataDir);

  const webPort = await findFreePort(50400);
  const apiPort = await findFreePort(50500);
  const cdpPort = await findFreePort(50600);
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const webLogs = [];
  const electronLogs = [];
  const agentBrowser = createAgentBrowser({ sessionName, captureDir });
  let web;
  let electron;

  try {
    web = await startVite({ webPort, logs: webLogs });
    await waitForHttp(webOrigin, "static desktop web snapshot");
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
        CLASH_E2E_STUB_HARNESS_UPDATE: "1",
      },
    });
    await waitForHttp(
      `http://127.0.0.1:${cdpPort}/json/version`,
      "Electron CDP",
    );

    agentBrowser(["close"], { allowFailure: true });
    agentBrowser(["connect", String(cdpPort)]);
    await waitForEval(
      agentBrowser,
      'document.body.innerText.includes("Home")',
      "home page",
    );
    if (!clickByText(agentBrowser, "Projects"))
      throw new Error("Could not open Projects");
    await waitForEval(
      agentBrowser,
      'location.pathname === "/projects"',
      "projects route",
    );
    if (!clickByText(agentBrowser, "New Project"))
      throw new Error("Could not create project");
    await submitProjectCreateDialog(agentBrowser, "Harness Update E2E");
    await waitForEval(
      agentBrowser,
      'location.pathname.startsWith("/projects/") && document.body.innerText.includes("Mock ACP")',
      "project with mock ACP",
      20_000,
    );

    const prompt = "Keep this session alive for the update test.";
    if (!typeComposer(agentBrowser, prompt))
      throw new Error("Could not type update-test prompt");
    if (!clickComposerSubmitButton(agentBrowser))
      throw new Error("Could not submit update-test prompt");
    await waitForEval(
      agentBrowser,
      '!!document.querySelector("button.clash-chat-input-stop")',
      "active mock ACP turn",
      20_000,
    );
    const queuedPrompt = "Use this queued follow-up after the update.";
    if (!typeComposer(agentBrowser, queuedPrompt))
      throw new Error("Could not type queued update-test prompt");
    if (!clickComposerSubmitButton(agentBrowser))
      throw new Error("Could not queue update-test prompt");
    await waitForEval(
      agentBrowser,
      `!!document.querySelector('.clash-runtime-prompt-queue') && document.body.innerText.includes(${JSON.stringify(queuedPrompt)})`,
      "active prompt queue alongside the ACP turn",
      20_000,
    );
    await writeFile(path.join(dataDir, ".e2e-harness-update-ready"), "ready\n");
    agentBrowser(["eval", "window.dispatchEvent(new Event('focus')); true"]);
    await waitForEval(
      agentBrowser,
      '!!document.querySelector(\'button[data-harness-update-control="true"][aria-label="1 ACP update available"]\')',
      "persistent managed harness update control",
    );
    agentBrowser(["screenshot", controlScreenshot]);

    if (!clickButtonByLabel(agentBrowser, "1 ACP update available")) {
      throw new Error("Could not expand the managed harness updates");
    }
    await waitForEval(
      agentBrowser,
      '(() => { const panel = document.querySelector(\'[role="dialog"][aria-label="ACP updates"]\'); return !!panel && panel.innerText.includes("Mock ACP") && panel.innerText.includes("1.0.0 → 2.0.0"); })()',
      "expanded managed harness update list",
    );
    agentBrowser(["screenshot", expandedScreenshot]);
    if (!clickButtonByLabel(agentBrowser, "Update Mock ACP")) {
      throw new Error("Could not start the in-place harness update");
    }
    await waitForEval(
      agentBrowser,
      "!!document.querySelector('button[aria-label=\"Updating Mock ACP\"][disabled]')",
      "in-place harness update progress",
    );

    await waitForEval(
      agentBrowser,
      'document.body.innerText.includes("Mock ACP 2.0.0 installed") && !!document.querySelector(\'button[aria-label="Restart after this turn"]\')',
      "busy session restart banner",
      20_000,
    );
    if (!clickButtonByLabel(agentBrowser, "ACP updated")) {
      throw new Error("Could not collapse the completed update list");
    }
    await waitForEval(
      agentBrowser,
      '!document.querySelector(\'[role="dialog"][aria-label="ACP updates"]\')',
      "collapsed managed harness update list",
    );
    const sessionNoticeOpen = evalJson(
      agentBrowser,
      '!!document.querySelector(\'button[aria-label="Restart after this turn"]\')',
    );
    if (!sessionNoticeOpen) {
      if (!clickButtonByLabel(agentBrowser, "ACP update requires session restart")) {
        throw new Error("Could not reopen the current-session ACP update notice");
      }
      await waitForEval(
        agentBrowser,
        '!!document.querySelector(\'button[aria-label="Restart after this turn"]\')',
        "reopened current-session ACP update notice",
      );
    }
    agentBrowser(["screenshot", restartScreenshot]);
    if (!clickButtonByLabel(agentBrowser, "Restart after this turn")) {
      throw new Error("Could not queue the busy ACP session restart");
    }
    await waitForEval(
      agentBrowser,
      'document.body.innerText.includes("This session will restart when the current turn finishes.") && document.body.innerText.includes("Restart queued")',
      "queued busy-session restart",
    );
    agentBrowser(["screenshot", queuedScreenshot]);
    await waitForEval(
      agentBrowser,
      `document.body.innerText.includes(${JSON.stringify(`Mock ACP reply: ${prompt}`)})`,
      "completed mock ACP turn",
      30_000,
    );
    await waitForEval(
      agentBrowser,
      'document.body.innerText.includes("Mock ACP 2.0.0 is now in use")',
      "automatic restarted-session confirmation",
      20_000,
    );
    agentBrowser(["screenshot", completeScreenshot]);
    await waitForEval(
      agentBrowser,
      '!document.body.innerText.includes("Mock ACP 2.0.0 is now in use") && !document.querySelector(\'button[aria-label="ACP session updated"]\')',
      "self-destructed session update notice",
      5_000,
    );
    agentBrowser(["screenshot", selfDestructedScreenshot]);

    console.log(
      "[harness-update-gui-e2e] ok",
      JSON.stringify({
        controlScreenshot,
        expandedScreenshot,
        restartScreenshot,
        queuedScreenshot,
        completeScreenshot,
        selfDestructedScreenshot,
      }),
    );
  } catch (error) {
    agentBrowser(["screenshot", failureScreenshot], { allowFailure: true });
    console.error(
      `[harness-update-gui-e2e] failure screenshot ${failureScreenshot}`,
    );
    console.error("[harness-update-gui-e2e] web logs\n" + tail(webLogs));
    console.error(
      "[harness-update-gui-e2e] electron logs\n" + tail(electronLogs),
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
