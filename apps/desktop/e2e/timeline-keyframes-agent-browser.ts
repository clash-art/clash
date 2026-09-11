import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
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
  tail,
  waitForEval,
  waitForHttp,
} from "./startup-shared.ts";

const execFileAsync = promisify(execFile);
const captureDir = path.join(repoRoot, ".tmp", "timeline-keyframes-e2e-captures");
const dataDir = path.join(repoRoot, ".tmp", "timeline-keyframes-e2e-data");
const artifactDir = path.join(repoRoot, ".tmp", "timeline-keyframes-e2e-artifacts");
const inspectorScreenshot = path.join(captureDir, "keyframes-inspector.png");
const reloadScreenshot = path.join(captureDir, "keyframes-reloaded.png");
const exportPath = path.join(artifactDir, "keyframes-export.mp4");
const evidencePath = path.join(artifactDir, "evidence.json");
const sessionName = `clash-timeline-keyframes-${Date.now().toString(36)}`;
const cliEntry = path.join(repoRoot, "packages", "cli", "dist", "index.js");
const sharedTypesEntry = path.join(repoRoot, "packages", "shared-types", "dist", "index.js");

function assert(condition, message, detail) {
  if (!condition) {
    throw new Error(`${message}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  }
}

async function fetchJson(url, init) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function runCli(args, { cwd, apiOrigin }) {
  const result = await execFileAsync(process.execPath, [cliEntry, ...args], {
    cwd,
    env: {
      ...process.env,
      CLASH_API_URL: apiOrigin,
    },
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

async function pullTimelineWhenPersisted(args, context, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await runCli(args, context);
    } catch (error) {
      lastError = error;
      if (!String(error?.stderr ?? error).includes("not found")) throw error;
      await sleep(250);
    }
  }
  throw lastError;
}

async function listFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

async function waitForRenderedMp4(timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = await listFiles(path.join(dataDir, "assets"));
    const mp4 = files.find((file) => file.toLowerCase().endsWith(".mp4"));
    if (mp4) return mp4;
    await sleep(500);
  }
  throw new Error("Timed out waiting for the Timeline render MP4");
}

async function clickAt(agentBrowser, x, y) {
  agentBrowser(["mouse", "move", String(Math.round(x)), String(Math.round(y))]);
  agentBrowser(["mouse", "down", "left"]);
  agentBrowser(["mouse", "up", "left"]);
}

function clickVisible(agentBrowser, selector) {
  agentBrowser(["scrollintoview", selector]);
  agentBrowser(["click", selector]);
}

function fillVisible(agentBrowser, selector, value) {
  agentBrowser(["scrollintoview", selector]);
  agentBrowser(["fill", selector, value]);
}

async function main() {
  ensureAgentBrowser();
  await resetDirs(dataDir, captureDir, artifactDir);

  const webPort = await findFreePort(50700);
  const apiPort = await findFreePort(50800);
  const cdpPort = await findFreePort(50900);
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
      env: { CLASH_E2E_STUB_ACP: "1" },
    });
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, "Electron CDP");
    agentBrowser(["connect", String(cdpPort)]);
    recoverAgentBrowserTarget(agentBrowser, {
      cdpPort,
      expectedUrlPrefix: `${webOrigin}/`,
    });
    agentBrowser(["set", "viewport", "1440", "900"]);
    await waitForEval(agentBrowser, `document.body.innerText.includes("Home")`, "desktop home");
    const runtime = await waitForEval(
      agentBrowser,
      `window.__CLASH_RUNTIME_CONFIG__?.apiBaseUrl ? window.__CLASH_RUNTIME_CONFIG__ : false`,
      "desktop runtime config",
    );
    const apiOrigin = runtime.apiBaseUrl;

    agentBrowser(["click", 'a[href="/projects"]']);
    await waitForEval(agentBrowser, `location.pathname === "/projects"`, "Projects route");
    agentBrowser(["find", "text", "New Project", "click"]);
    await waitForEval(
      agentBrowser,
      `!!document.querySelector("input[placeholder='Untitled project']")`,
      "project create dialog",
    );
    agentBrowser(["fill", "input[placeholder='Untitled project']", "Keyframe E2E"]);
    await waitForEval(
      agentBrowser,
      `document.querySelector("input[placeholder='Untitled project']")?.value === "Keyframe E2E" &&
       document.querySelector("button[type='submit']")?.disabled === false`,
      "enabled project create submit",
    );
    agentBrowser(["click", "button[type='submit']"]);
    const projectId = await waitForEval(
      agentBrowser,
      `location.pathname.startsWith("/projects/") &&
        location.pathname !== "/projects" &&
        location.pathname.split("/").pop()`,
      "project editor route",
      20_000,
    );
    await waitForEval(
      agentBrowser,
      `!!document.querySelector('button[aria-label="New Timeline"]')`,
      "project navigator actions",
      20_000,
    );

    evalJson(agentBrowser, `(() => {
      window.prompt = () => "Keyframe Motion";
      return true;
    })()`);
    agentBrowser(["click", 'button[aria-label="New Timeline"]']);
    await waitForEval(
      agentBrowser,
      `!!document.querySelector('[data-testid="project-timeline-editor"]')`,
      "embedded Timeline editor",
      20_000,
    );
    const timelineTabId = await waitForEval(
      agentBrowser,
      `document.querySelector('[id^="project-timeline-"][aria-selected="true"]')?.id || false`,
      "selected Timeline tab",
    );
    const timelineId = timelineTabId.replace(/^project-timeline-/, "");
    const copilotGeometry = await waitForEval(
      agentBrowser,
      `(() => {
        const workspace = document.querySelector('#project-workspace-shell');
        const panel = document.querySelector('#clash-copilot-panel');
        if (!workspace || !panel) return false;
        const workspaceRect = workspace.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const geometry = {
          layout: workspace.getAttribute('data-copilot-layout'),
          rounded: panel.classList.contains('rounded-matrix'),
          workspaceGap: Math.round((panelRect.left - workspaceRect.right) * 10) / 10,
          rightInset: Math.round((window.innerWidth - panelRect.right) * 10) / 10,
          bottomInset: Math.round((window.innerHeight - panelRect.bottom) * 10) / 10,
        };
        return geometry.layout === 'reserved-floating' &&
          geometry.rounded &&
          Math.abs(geometry.workspaceGap - 8) <= 1 &&
          Math.abs(geometry.rightInset - 8) <= 1 &&
          Math.abs(geometry.bottomInset - 8) <= 1
          ? geometry
          : false;
      })()`,
      "rounded floating Copilot with an aligned workspace gutter",
    );

    agentBrowser(["click", 'button[role="tab"][aria-label="Graphics"]']);
    await waitForEval(
      agentBrowser,
      `!!document.querySelector('button[aria-label="Apply Spark"]')`,
      "Graphics library",
      15_000,
    );
    agentBrowser(["click", 'button[aria-label="Apply Spark"]']);
    await waitForEval(
      agentBrowser,
      `document.querySelectorAll('[aria-label^="sticker:"]').length === 1 &&
       !!document.querySelector('button[aria-label="Add Position keyframe at current frame"]')`,
      "selected sticker Transform Inspector",
      15_000,
    );

    for (const channel of ["Position", "Scale", "Rotation", "Opacity"]) {
      clickVisible(agentBrowser, `button[aria-label="Add ${channel} keyframe at current frame"]`);
    }
    fillVisible(agentBrowser, 'input[aria-label="X position in pixels"]', "-220");
    fillVisible(agentBrowser, 'input[aria-label="Y position in pixels"]', "-120");
    fillVisible(agentBrowser, 'input[aria-label="X animated scale"]', "0.7");
    fillVisible(agentBrowser, 'input[aria-label="Y animated scale"]', "0.7");
    fillVisible(agentBrowser, 'input[aria-label="Rotation in degrees"]', "-20");
    fillVisible(agentBrowser, 'input[aria-label="Opacity"]', "0.2");

    const rulerPoint = evalJson(agentBrowser, `(() => {
      const rect = document.querySelector('[data-timeline-ruler]')?.getBoundingClientRect();
      return rect ? {
        x: rect.left + rect.width * 0.42,
        startX: rect.left + 5,
        y: rect.top + rect.height / 2,
      } : null;
    })()`);
    assert(rulerPoint, "Timeline ruler was not available");
    await clickAt(agentBrowser, rulerPoint.x, rulerPoint.y);
    await waitForEval(
      agentBrowser,
      `document.querySelector('output[aria-label="Current timecode"]')?.textContent !== "00:00:00:00"`,
      "non-zero playhead",
    );

    for (const channel of ["Position", "Scale", "Rotation", "Opacity"]) {
      clickVisible(agentBrowser, `button[aria-label="Add ${channel} keyframe at current frame"]`);
    }
    fillVisible(agentBrowser, 'input[aria-label="X position in pixels"]', "220");
    fillVisible(agentBrowser, 'input[aria-label="Y position in pixels"]', "120");
    fillVisible(agentBrowser, 'input[aria-label="X animated scale"]', "1.5");
    fillVisible(agentBrowser, 'input[aria-label="Y animated scale"]', "1.5");
    fillVisible(agentBrowser, 'input[aria-label="Rotation in degrees"]', "25");
    fillVisible(agentBrowser, 'input[aria-label="Opacity"]', "1");

    const authored = await waitForEval(
      agentBrowser,
      `(() => {
        const markers = [...document.querySelectorAll('[data-timeline-keyframe-marker]')].map((marker) => ({
          channels: (marker.getAttribute('data-keyframe-channels') || '').split(',').filter(Boolean),
          frame: Number(marker.getAttribute('data-keyframe-frame')),
        }));
        const channels = ["position", "scale", "rotation", "opacity"];
        return markers.length === 2 && channels.every((channel) =>
          markers.filter((marker) => marker.channels.includes(channel)).length === 2
        ) ? { markers } : false;
      })()`,
      "two GUI-authored keys on every transform channel",
    );
    agentBrowser(["screenshot", inspectorScreenshot]);

    agentBrowser(["click", 'button[aria-label="Undo"]']);
    await waitForEval(
      agentBrowser,
      `Number(document.querySelector('input[aria-label="Opacity"]')?.value) < 1`,
      "Undo of last keyframe value",
    );
    agentBrowser(["click", 'button[aria-label="Redo"]']);
    await waitForEval(
      agentBrowser,
      `Number(document.querySelector('input[aria-label="Opacity"]')?.value) === 1`,
      "Redo of last keyframe value",
    );

    await clickAt(agentBrowser, rulerPoint.startX, rulerPoint.y);
    agentBrowser(["click", 'button[aria-label="Play"]']);
    await waitForEval(
      agentBrowser,
      `!!document.querySelector('button[aria-label="Pause"]')`,
      "Timeline playback running",
    );
    await waitForEval(
      agentBrowser,
      `!!document.querySelector('button[aria-label="Play"]')`,
      "Timeline playback completed",
      15_000,
    );

    agentBrowser(["click", "#project-canvas-main"]);
    await waitForEval(
      agentBrowser,
      `!document.querySelector('[data-testid="project-timeline-editor"]')`,
      "Timeline closed for persistence flush",
    );
    agentBrowser(["click", `#${timelineTabId}`]);
    await waitForEval(
      agentBrowser,
      `!!document.querySelector('[data-testid="project-timeline-editor"]') &&
       document.querySelectorAll('[aria-label^="sticker:"]').length === 1`,
      "reopened persisted Timeline",
      20_000,
    );
    agentBrowser(["click", '[aria-label^="sticker:"]']);
    await waitForEval(
      agentBrowser,
      `document.querySelectorAll('[data-timeline-keyframe-marker]').length === 2`,
      "persisted keyframe markers after reopen",
    );
    agentBrowser(["screenshot", reloadScreenshot]);

    const status = await fetchJson(`${apiOrigin}/api/v1/projects/${encodeURIComponent(projectId)}/status`);
    const workspaceRoot = status.projectWorkspaceRoot;
    assert(typeof workspaceRoot === "string" && workspaceRoot.length > 0, "Project workspace root missing", status);
    await mkdir(path.join(workspaceRoot, "timelines"), { recursive: true });
    const projectionPath = path.join(workspaceRoot, "timelines", "keyframe-motion.timeline.yaml");
    const pulled = await pullTimelineWhenPersisted(
      ["timeline", "pull", "--project", projectId, "--timeline", timelineId, "--file", projectionPath, "--json"],
      { cwd: workspaceRoot, apiOrigin },
    );
    const { timelineDslFromYaml, timelineDslToYaml } = await import(sharedTypesEntry);
    const parsed = timelineDslFromYaml(await readFile(projectionPath, "utf8"));
    assert(parsed.ok, "Pulled Timeline keyframe YAML was invalid", parsed);
    const visualItem = parsed.dsl.tracks.flatMap((track) => track.items).find((item) => item.type === "sticker");
    assert(visualItem, "Pulled Timeline did not contain the GUI sticker item");
    for (const channel of ["position", "scale", "rotation", "opacity"]) {
      assert(visualItem.keyframes?.[channel]?.length >= 2, `Pulled YAML lost ${channel} keys`, visualItem.keyframes);
    }
    const secondPosition = visualItem.keyframes.position.at(-1);
    secondPosition.value = [240, 130];
    parsed.dsl.durationInFrames = visualItem.from + visualItem.durationInFrames;
    await writeFile(projectionPath, timelineDslToYaml(parsed.dsl), "utf8");
    const applied = await runCli(
      ["timeline", "apply", "--project", projectId, "--timeline", timelineId, "--file", projectionPath, "--json"],
      { cwd: workspaceRoot, apiOrigin },
    );
    assert(applied.applied === true, "Agent-edited keyframe YAML did not apply", applied);

    agentBrowser(["reload"]);
    recoverAgentBrowserTarget(agentBrowser, {
      cdpPort,
      expectedUrlPrefix: `${webOrigin}/`,
    });
    await waitForEval(
      agentBrowser,
      `!!document.getElementById(${JSON.stringify(timelineTabId)})`,
      "Timeline navigator tab after Agent YAML apply",
      20_000,
    );
    agentBrowser(["click", `#${timelineTabId}`]);
    await waitForEval(
      agentBrowser,
      `!!document.querySelector('[data-testid="project-timeline-editor"]')`,
      "Timeline after Agent YAML apply",
      20_000,
    );
    agentBrowser(["click", '[aria-label^="sticker:"]']);
    agentBrowser(["click", `[data-timeline-keyframe-marker][data-keyframe-frame="${secondPosition.frame}"]`]);
    await waitForEval(
      agentBrowser,
      `Number(document.querySelector('input[aria-label="X position in pixels"]')?.value) === 240`,
      "Agent YAML keyframe visible in Inspector",
    );

    agentBrowser(["find", "text", "Export", "click"]);
    await waitForEval(
      agentBrowser,
      `!!document.querySelector('[aria-label="Export video"]')`,
      "Export menu",
    );
    agentBrowser(["click", '[aria-label="Export video"]']);
    const renderedPath = await waitForRenderedMp4();
    await execFileAsync("/bin/cp", [renderedPath, exportPath]);

    const probe = JSON.parse((await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-show_entries", "stream=width,height,nb_frames,avg_frame_rate",
      "-of", "json",
      exportPath,
    ])).stdout);
    const durationSeconds = Number(probe.format?.duration ?? 0);
    assert(durationSeconds > 0, "Exported MP4 duration is invalid", probe);
    const videoStream = probe.streams?.find((stream) => Number(stream.width) > 0);
    const videoFrameCount = Number(videoStream?.nb_frames ?? 0);
    const videoFrameRate = Number(videoStream?.avg_frame_rate?.split("/")[0] ?? 0)
      / Number(videoStream?.avg_frame_rate?.split("/")[1] ?? 1);
    assert(videoFrameCount > 0 && videoFrameRate > 0, "Exported MP4 video frame metadata is invalid", probe);
    const lastVideoFrameTime = (videoFrameCount - 1) / videoFrameRate;
    const frameTimes = [0, lastVideoFrameTime / 2, lastVideoFrameTime];
    const framePaths = [];
    for (const [index, time] of frameTimes.entries()) {
      const framePath = path.join(artifactDir, ["start.png", "middle.png", "end.png"][index]);
      await execFileAsync("ffmpeg", [
        "-y", "-ss", String(time), "-i", exportPath, "-frames:v", "1", framePath,
      ]);
      framePaths.push(framePath);
    }
    const hashes = [];
    for (const framePath of framePaths) {
      hashes.push((await execFileAsync("shasum", ["-a", "256", framePath])).stdout.split(/\s+/)[0]);
    }
    assert(new Set(hashes).size === hashes.length, "Exported start/middle/end frames are not visually distinct", hashes);

    const evidence = {
      level: "real development Electron UI E2E (stub ACP present but unused)",
      projectId,
      timelineId,
      copilotGeometry,
      authored,
      pulled,
      applied,
      inspectorScreenshot,
      reloadScreenshot,
      exportPath,
      framePaths,
      hashes,
      probe,
    };
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log("[timeline-keyframes-e2e]", JSON.stringify(evidence));
  } catch (error) {
    console.error("[timeline-keyframes-e2e] web logs\n" + tail(webLogs));
    console.error("[timeline-keyframes-e2e] electron logs\n" + tail(electronLogs));
    throw error;
  } finally {
    agentBrowser(["close"], { allowFailure: true });
    await stopProcess(electron);
    await stopProcess(web);
  }
}

await main();
