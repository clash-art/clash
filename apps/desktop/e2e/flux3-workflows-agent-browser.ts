import { execFile } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  createAgentBrowser,
  ensureAgentBrowser,
  findFreePort,
  recoverAgentBrowserTarget,
  repoRoot,
  resetDirs,
  startElectron,
  startVite,
  stopProcess,
  tail,
  waitForEval,
  waitForHttp,
} from "./startup-shared.ts";

const execFileAsync = promisify(execFile);
const captureDir = path.join(repoRoot, ".tmp", "flux3-workflows-e2e-captures");
const clashHome = path.join(repoRoot, ".tmp", "flux3-workflows-e2e-home");
const dataDir = path.join(clashHome, "local-api");
const artifactDir = path.join(repoRoot, ".tmp", "flux3-workflows-e2e-artifacts");
const stableArtifactDir = path.join(repoRoot, ".codex", "artifacts");
const keyframeStripScreenshot = path.join(captureDir, "flux3-keyframe-strip-10.png");
const keyframeTimelineScreenshot = path.join(captureDir, "flux3-keyframe-timeline.png");
const stableKeyframeStripScreenshot = path.join(stableArtifactDir, "flux3-keyframe-strip-10.png");
const stableKeyframeTimelineScreenshot = path.join(stableArtifactDir, "flux3-keyframe-timeline.png");
const evidencePath = path.join(artifactDir, "evidence.json");
const keyframeFixturePath = path.join(repoRoot, "apps", "web", "public", "og-image.png");
const sessionName = `clash-flux3-workflows-${Date.now().toString(36)}`;
const cliEntry = path.join(repoRoot, "packages", "cli", "dist", "index.js");

function assert(condition, message, detail) {
  if (!condition) {
    throw new Error(`${message}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  }
}

async function runCli(args, apiOrigin) {
  const result = await execFileAsync(process.execPath, [cliEntry, ...args], {
    cwd: repoRoot,
    env: { ...process.env, CLASH_API_URL: apiOrigin, CLASH_HOME: clashHome },
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

async function main() {
  ensureAgentBrowser();
  await resetDirs(clashHome, captureDir, artifactDir);
  await mkdir(artifactDir, { recursive: true });
  await mkdir(stableArtifactDir, { recursive: true });

  const webPort = await findFreePort(51000);
  const apiPort = await findFreePort(51100);
  const cdpPort = await findFreePort(51200);
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const agentBrowser = createAgentBrowser({ sessionName, captureDir });
  const webLogs = [];
  const electronLogs = [];
  let web;
  let electron;

  try {
    web = await startVite({ webPort, logs: webLogs });
    await waitForHttp(webOrigin, "Vite desktop runtime");
    electron = await startElectron({
      cdpPort,
      webOrigin,
      apiPort,
      dataDir,
      captureDir,
      logs: electronLogs,
      env: { CLASH_E2E_STUB_ACP: "1", CLASH_HOME: clashHome },
    });
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, "Electron CDP");
    agentBrowser(["connect", String(cdpPort)]);
    recoverAgentBrowserTarget(agentBrowser, { cdpPort, expectedUrlPrefix: `${webOrigin}/` });
    agentBrowser(["set", "viewport", "1440", "900"]);
    await waitForEval(agentBrowser, `document.body.innerText.includes("Home")`, "desktop home");
    const runtime = await waitForEval(
      agentBrowser,
      `window.__CLASH_RUNTIME_CONFIG__?.apiBaseUrl ? window.__CLASH_RUNTIME_CONFIG__ : false`,
      "desktop runtime config",
    );
    const apiOrigin = runtime.apiBaseUrl;

    const providerResponse = await fetch(`${apiOrigin}/api/v1/model-providers`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providers: [{
          id: "flux3-e2e-bfl",
          providerId: "official",
          upstreamId: "bfl",
          region: "global",
          enabled: true,
          weight: 10,
          credentials: { apiKey: "e2e-bfl-key" },
        }],
      }),
    });
    assert(providerResponse.ok, "Could not configure isolated BFL provider", await providerResponse.text());

    agentBrowser(["click", 'a[href="/projects"]']);
    await waitForEval(agentBrowser, `location.pathname === "/projects"`, "Projects route");
    agentBrowser(["find", "text", "New Project", "click"]);
    await waitForEval(
      agentBrowser,
      `!!document.querySelector("input[placeholder='Untitled project']")`,
      "project create dialog",
    );
    agentBrowser(["fill", "input[placeholder='Untitled project']", "FLUX 3 Workflow E2E"]);
    agentBrowser(["click", "button[type='submit']"]);
    const projectId = await waitForEval(
      agentBrowser,
      `location.pathname.startsWith("/projects/") && location.pathname.split("/").pop()`,
      "project editor route",
      20_000,
    );

    const importedFixture = await runCli([
      "assets", "import",
      "--project", projectId,
      "--file", keyframeFixturePath,
      "--kind", "image",
      "--no-link",
      "--json",
    ], apiOrigin);
    assert(importedFixture.assetId, "CLI did not import the local keyframe fixture", importedFixture);

    const keyframeRefIds = [];
    for (let index = 0; index < 10; index += 1) {
      const image = await runCli([
        "canvas", "add",
        "--project", projectId,
        "--type", "image",
        "--label", `Keyframe ${index + 1}`,
        "--json",
      ], apiOrigin);
      assert(image.node_id, "CLI did not return a keyframe image node id", image);
      await runCli([
        "canvas", "get",
        "--project", projectId,
        "--node", image.node_id,
        "--json",
      ], apiOrigin);
      await runCli([
        "canvas", "update",
        "--project", projectId,
        "--node", image.node_id,
        "--asset-id", importedFixture.assetId,
        "--json",
      ], apiOrigin);
      await runCli([
        "canvas", "move",
        "--project", projectId,
        "--node", image.node_id,
        "--x", String((index % 5) * 260),
        "--y", String(Math.floor(index / 5) * 220),
        "--json",
      ], apiOrigin);
      keyframeRefIds.push(image.node_id);
    }

    const created = await runCli([
      "canvas", "add",
      "--project", projectId,
      "--type", "video_gen",
      "--label", "FLUX 3 keyframes",
      "--prompt", "Connect these cinematic moments",
      "--model", "flux-3-video-keyframes",
      "--param", "duration=5",
      "--ref", ...keyframeRefIds,
      "--json",
    ], apiOrigin);
    const actionId = created.node_id;
    assert(actionId, "CLI did not return the FLUX 3 action id", created);
    await runCli([
      "canvas", "move",
      "--project", projectId,
      "--node", actionId,
      "--x", "520",
      "--y", "520",
      "--json",
    ], apiOrigin);

    // The nodes were added after React Flow's initial fit. Reloading the real
    // project route remounts the Canvas and fits all eleven nodes into view.
    // Give the first mount time to hydrate the Loro snapshot, then remount once
    // more so React Flow's initial fit cannot race ahead of the node payload.
    agentBrowser(["open", `${webOrigin}/projects/${projectId}`]);
    agentBrowser(["wait", "1500"]);
    agentBrowser(["open", `${webOrigin}/projects/${projectId}`]);
    await waitForEval(
      agentBrowser,
      `!!document.querySelector(${JSON.stringify(`[data-id="${actionId}"] button[aria-label="Configure action"]`)})`,
      "FLUX 3 action node",
      20_000,
    );
    agentBrowser(["click", `[data-id="${actionId}"] button[aria-label="Configure action"]`]);
    const compactStripExpression = `(() => {
        const panel = document.querySelector(${JSON.stringify(`[data-action-config-panel="${actionId}"]`)});
        const strip = panel?.querySelector('[data-testid="frame-reference-strip"]');
        const scroll = strip?.querySelector('[data-testid="frame-reference-scroll"]');
        const list = strip?.querySelector('[aria-label="FLUX 3 keyframes"]');
        const timing = strip?.querySelector('button[aria-label="Edit keyframe timing"]');
        const listItems = list?.querySelectorAll('[role="listitem"]') ?? [];
        const images = [...(list?.querySelectorAll('img') ?? [])];
        const imagesLoaded = images.length === 10
          && images.every((image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
        if (!panel || !strip || !scroll || !list || !timing || listItems.length !== 10 || !imagesLoaded) return false;
        const rect = strip.getBoundingClientRect();
        return {
          references: 10,
          visibleWidth: Math.round(rect.width),
          scrollWidth: scroll.scrollWidth,
          scrollViewportWidth: scroll.clientWidth,
          bounded: rect.width <= 289,
          internalScroll: scroll.scrollWidth > scroll.clientWidth,
          timingButton: true,
          imagesLoaded,
          firstImageSrc: images[0]?.currentSrc || images[0]?.src,
        };
      })()`;
    let compactStrip;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        compactStrip = await waitForEval(
          agentBrowser,
          compactStripExpression,
          "bounded ten-frame FLUX 3 strip",
          attempt === 0 ? 20_000 : 40_000,
        );
        break;
      } catch (error) {
        if (attempt === 1) throw error;
        // Local Loro hydration can remount the editor after the first panel
        // click. Re-enter the project once and open the panel after the action
        // is present again so the visual assertions run against settled UI.
        agentBrowser(["open", `${webOrigin}/projects/${projectId}`]);
        await waitForEval(
          agentBrowser,
          `!!document.querySelector(${JSON.stringify(`[data-id="${actionId}"] button[aria-label="Configure action"]`)})`,
          "FLUX 3 action node after hydration recovery",
          20_000,
        );
        agentBrowser(["wait", "1000"]);
        agentBrowser(["click", `[data-id="${actionId}"] button[aria-label="Configure action"]`]);
      }
    }
    assert(compactStrip, "Ten-frame FLUX 3 strip never settled after hydration recovery");
    assert(compactStrip.bounded, "Ten-frame strip exceeded its 18rem layout bound", compactStrip);
    assert(compactStrip.internalScroll, "Ten-frame strip did not scroll inside its compact viewport", compactStrip);
    agentBrowser(["screenshot", `[data-action-config-panel="${actionId}"]`, keyframeStripScreenshot]);

    agentBrowser(["click", 'button[aria-label="Edit keyframe timing"]']);
    const timelineDialog = await waitForEval(
      agentBrowser,
      `(() => {
        const dialog = [...document.querySelectorAll('[role="dialog"]')]
          .find((candidate) => candidate.textContent?.includes("Keyframe timing"));
        const inputs = [...(dialog?.querySelectorAll('input[type="number"]') ?? [])];
        const timeSlots = [...(dialog?.querySelectorAll('[data-testid="keyframe-time-slot"]') ?? [])];
        const start = dialog?.querySelector('[aria-label^="Start at "]');
        const end = dialog?.querySelector('[aria-label^="End at "]');
        if (!dialog || inputs.length !== 8 || timeSlots.length !== 10 || !start || !end || !dialog.innerText.includes("Evenly distributed · 24 fps · 5s")) return false;
        const timeSlotTops = timeSlots.map((slot) => slot.getBoundingClientRect().top);
        return {
          exactTimeInputs: inputs.length,
          fixedEndpoints: !start.querySelector('input') && !end.querySelector('input'),
          movableMiddleFrames: inputs.every((input) => !input.disabled),
          distributeEvenly: !!dialog.querySelector('button[aria-label="Distribute keyframes evenly"]'),
          alignedTimeLabels: Math.max(...timeSlotTops) - Math.min(...timeSlotTops) <= 1,
          trackWidth: Math.round(dialog.querySelector('[data-testid="keyframe-timeline-track"]')?.getBoundingClientRect().width ?? 0),
        };
      })()`,
      "FLUX 3 keyframe timing dialog",
    );
    assert(timelineDialog.fixedEndpoints, "Timeline endpoints were not fixed", timelineDialog);
    assert(timelineDialog.movableMiddleFrames, "Timeline middle frames were not editable", timelineDialog);
    assert(timelineDialog.distributeEvenly, "Timeline is missing the even-distribution reset", timelineDialog);
    assert(timelineDialog.alignedTimeLabels, "Timeline time labels do not share one horizontal baseline", timelineDialog);
    agentBrowser(["fill", 'input[aria-label="Frame 2 time in seconds"]', "0.75"]);
    agentBrowser(["press", "Enter"]);
    const customTiming = await waitForEval(
      agentBrowser,
      `(() => {
        const dialog = [...document.querySelectorAll('[role="dialog"]')]
          .find((candidate) => candidate.textContent?.includes("Keyframe timing"));
        return dialog?.innerText.includes("Custom timing · 24 fps · 5s")
          ? { mode: "custom", frame2Seconds: dialog.querySelector('input[aria-label="Frame 2 time in seconds"]')?.value }
          : false;
      })()`,
      "persisted custom FLUX 3 timing",
    );
    agentBrowser(["screenshot", '[role="dialog"]', keyframeTimelineScreenshot]);
    await copyFile(keyframeStripScreenshot, stableKeyframeStripScreenshot);
    await copyFile(keyframeTimelineScreenshot, stableKeyframeTimelineScreenshot);

    const persisted = await runCli(["canvas", "get", "--project", projectId, "--node", actionId, "--json"], apiOrigin);
    const persistedFrameIndices = JSON.parse(persisted.data?.modelParams?.keyframe_frame_indices ?? "null");
    assert(
      Array.isArray(persistedFrameIndices)
        && persistedFrameIndices.length === 10
        && persistedFrameIndices[0] === 0
        && persistedFrameIndices[1] === 18
        && persistedFrameIndices[9] === 120,
      "Custom 24 fps frame indices were not persisted",
      persisted,
    );

    const evidence = {
      level: "real isolated development Electron UI E2E",
      projectId,
      actionId,
      compactStrip,
      timelineDialog,
      customTiming,
      persistedModelId: persisted.data.modelId,
      persistedFrameIndices,
      screenshots: {
        keyframeStripScreenshot: stableKeyframeStripScreenshot,
        keyframeTimelineScreenshot: stableKeyframeTimelineScreenshot,
      },
    };
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log("[flux3-workflows-e2e]", JSON.stringify(evidence));
  } catch (error) {
    console.error("[flux3-workflows-e2e] web logs\n" + tail(webLogs));
    console.error("[flux3-workflows-e2e] electron logs\n" + tail(electronLogs));
    throw error;
  } finally {
    agentBrowser(["close"], { allowFailure: true });
    await stopProcess(electron);
    await stopProcess(web);
  }
}

await main();
