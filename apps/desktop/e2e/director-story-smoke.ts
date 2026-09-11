import path from "node:path";
import { spawnSync, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import {
  clickButtonByLabel,
  clickByText,
  createAgentBrowser,
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

type AgentBrowser = (
  args: string[],
  options?: { allowFailure?: boolean },
) => string;

type CanvasCliNode = {
  id: string;
  type?: string;
  parent_id?: string | null;
  data?: Record<string, unknown>;
};

const runRoot = process.env.CLASH_DIRECTOR_STORY_E2E_ROOT
  ?? path.join(repoRoot, ".tmp", "director-story-e2e");
const dataDir = path.join(runRoot, "data");
const captureDir = path.join(runRoot, "captures");
const timelineScreenshot = path.join(captureDir, "director-story-timeline.png");
const shotGroupScreenshot = path.join(captureDir, "director-story-shot-group.png");
const videoPath = path.join(captureDir, "director-story.webm");
const contactSheetPath = path.join(captureDir, "director-story-contact-sheet.png");
const sessionName = `clash-director-story-${Date.now().toString(36)}`;

const cues = [
  ["story-shot-establish", "story-camera-establish", 1],
  ["story-shot-lead", "story-camera-lead", 5],
  ["story-shot-ots", "story-camera-ots", 10],
  ["story-shot-reverse", "story-camera-reverse", 14],
  ["story-shot-intervention", "story-camera-intervention", 18],
  ["story-shot-arc", "story-camera-arc", 23],
  ["story-shot-closing", "story-camera-closing", 28],
] as const;

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

async function waitForFile(
  filePath: string,
  label: string,
  timeoutMs = 30_000,
): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await stat(filePath);
      return filePath;
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`Timed out waiting for ${label}: ${filePath}`);
}

async function waitForCanvasNodes(
  clashCliPath: string,
  projectId: string,
  predicate: (nodes: CanvasCliNode[]) => boolean,
  label: string,
  timeoutMs = 60_000,
): Promise<CanvasCliNode[]> {
  const startedAt = Date.now();
  let lastNodes: CanvasCliNode[] = [];
  while (Date.now() - startedAt < timeoutMs) {
    lastNodes = JSON.parse(run(clashCliPath, [
      "canvas",
      "list",
      "--project",
      projectId,
      "--json",
    ])) as CanvasCliNode[];
    if (predicate(lastNodes)) return lastNodes;
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for ${label}; last nodes: ${JSON.stringify(lastNodes)}`,
  );
}

async function warmProjectRoute(
  agentBrowser: AgentBrowser,
  cdpPort: number,
  webOrigin: string,
): Promise<void> {
  evalJson(agentBrowser, `(() => {
    window.__directorStoryRouteWarmup = "loading";
    import("/app/routes/project.$id.tsx")
      .then(() => { window.__directorStoryRouteWarmup = "ready"; })
      .catch((error) => {
        window.__directorStoryRouteWarmup = "error:" + (error?.message || String(error));
      });
    return true;
  })()`);
  const status = await waitForEval(
    agentBrowser,
    `window.__directorStoryRouteWarmup !== "loading" && window.__directorStoryRouteWarmup`,
    "Director project route warmup",
    120_000,
  );
  if (status === "ready") return;
  evalJson(agentBrowser, "location.reload(); true");
  await sleep(750);
  recoverAgentBrowserTarget(agentBrowser, {
    cdpPort,
    expectedUrlPrefix: `${webOrigin}/`,
  });
  await waitForEval(agentBrowser, `document.body.innerText.includes("Home")`, "desktop home");
}

function clickCue(
  agentBrowser: AgentBrowser,
  cueId: string,
  modifiers: { metaKey?: boolean; shiftKey?: boolean } = {},
): void {
  const selector = `[data-director-sequence-shot="${cueId}"]`;
  const clicked = evalJson(agentBrowser, `(() => {
    const cue = document.querySelector(${JSON.stringify(selector)});
    if (!(cue instanceof HTMLButtonElement)) return false;
    cue.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      metaKey: ${Boolean(modifiers.metaKey)},
      shiftKey: ${Boolean(modifiers.shiftKey)},
    }));
    cue.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Could not click Director sequence shot ${cueId}`);
}

function rendererObservation(agentBrowser: AgentBrowser) {
  return evalJson(agentBrowser, `(() => {
    const root = document.querySelector('[data-testid="project-director-stage-editor"]');
    const canvas = root?.querySelector('canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl || gl.isContextLost()) return false;
    const pixel = new Uint8Array(4);
    gl.readPixels(
      Math.floor(gl.drawingBufferWidth / 2),
      Math.floor(gl.drawingBufferHeight / 2),
      1,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixel,
    );
    return {
      activeCameraId: root?.getAttribute('data-director-active-camera'),
      width: gl.drawingBufferWidth,
      height: gl.drawingBufferHeight,
      centerPixel: [...pixel],
      preservedFrameBytes: canvas.toDataURL('image/png').length,
    };
  })()`);
}

function probeVideo(outputPath: string) {
  const output = run("ffprobe", [
    "-v",
    "error",
    "-count_frames",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,width,height,avg_frame_rate,nb_read_frames:format=duration",
    "-of",
    "json",
    outputPath,
  ]);
  return JSON.parse(output) as {
    streams: Array<{
      codec_name: string;
      width: number;
      height: number;
      avg_frame_rate: string;
      nb_read_frames: string;
    }>;
    format: { duration?: string };
  };
}

function lastVideoFrameTimestamp(outputPath: string): number {
  const output = run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "frame=best_effort_timestamp_time",
    "-of",
    "csv=p=0",
    outputPath,
  ]);
  const timestamps = output
    .split(/\r?\n/)
    .map(Number)
    .filter(Number.isFinite);
  const timestamp = timestamps.at(-1);
  if (timestamp === undefined) {
    throw new Error("Exported Director story video has no readable frame timestamps");
  }
  return timestamp;
}

function extractContactSheet(outputPath: string): {
  framePaths: string[];
  uniqueFrameHashes: number;
} {
  const framePaths = cues.map(([, , seconds], index) => {
    const framePath = path.join(captureDir, `director-story-cue-${index + 1}.png`);
    run("ffmpeg", [
      "-y",
      "-ss",
      String(seconds),
      "-i",
      outputPath,
      "-frames:v",
      "1",
      framePath,
    ]);
    return framePath;
  });
  const hashes = framePaths.map((framePath) => (
    run("shasum", ["-a", "256", framePath]).split(/\s+/)[0]
  ));
  const scaleFilters = framePaths.map((_, index) => (
    `[${index}:v]scale=480:270:force_original_aspect_ratio=decrease,`
    + `pad=480:270:(ow-iw)/2:(oh-ih)/2:black[v${index}]`
  ));
  run("ffmpeg", [
    "-y",
    ...framePaths.flatMap((framePath) => ["-i", framePath]),
    "-filter_complex",
    [
      ...scaleFilters,
      "[v0][v1][v2][v3][v4][v5][v6]"
        + "xstack=inputs=7:"
        + "layout=0_0|480_0|960_0|1440_0|0_270|480_270|960_270:"
        + "fill=black[out]",
    ].join(";"),
    "-map",
    "[out]",
    "-frames:v",
    "1",
    contactSheetPath,
  ]);
  return {
    framePaths,
    uniqueFrameHashes: new Set(hashes).size,
  };
}

async function main(): Promise<void> {
  ensureAgentBrowser();
  await resetDirs(dataDir, captureDir);

  const webPort = await findFreePort(50740);
  const apiPort = await findFreePort(50840);
  const cdpPort = await findFreePort(50940);
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const webLogs: string[] = [];
  const electronLogs: string[] = [];
  const agentBrowser = createAgentBrowser({ sessionName, captureDir }) as AgentBrowser;
  let web: ChildProcess | undefined;
  let electron: ChildProcess | undefined;

  try {
    web = await startVite({ webPort, logs: webLogs });
    await waitForHttp(webOrigin, "Director Story Vite shell");
    electron = await startElectron({
      cdpPort,
      webOrigin,
      apiPort,
      dataDir,
      captureDir,
      logs: electronLogs,
      env: {
        CLASH_E2E_STUB_ACP: "1",
        CLASH_DIRECTOR_E2E_VIDEO_EXPORT_PATH: videoPath,
      },
    });
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, "Electron CDP");

    agentBrowser(["close"], { allowFailure: true });
    agentBrowser(["connect", String(cdpPort)]);
    recoverAgentBrowserTarget(agentBrowser, {
      cdpPort,
      expectedUrlPrefix: `${webOrigin}/`,
    });
    await waitForEval(agentBrowser, `document.body.innerText.includes("Home")`, "desktop home");
    await warmProjectRoute(agentBrowser, cdpPort, webOrigin);

    if (!clickByText(agentBrowser, "Projects")) throw new Error("Could not open Projects");
    await waitForEval(agentBrowser, `location.pathname === "/projects"`, "Projects route");
    if (!clickByText(agentBrowser, "New Project")) throw new Error("Could not create Project");
    await submitProjectCreateDialog(agentBrowser, "Director Multi-Actor Story E2E");
    await waitForEval(
      agentBrowser,
      `location.pathname.startsWith("/projects/")`,
      "Project editor route",
      120_000,
    );
    const projectId = evalJson(
      agentBrowser,
      `location.pathname.split("/").filter(Boolean).at(-1)`,
    ) as string;
    await waitForEval(
      agentBrowser,
      `document.querySelector('[data-project-loro-connected]')?.getAttribute('data-project-loro-connected') === 'true'`,
      "project Loro room connection",
      60_000,
    );
    const directorCliPath = await waitForFile(
      path.join(dataDir, "agent-bin", "clash"),
      "host-owned Clash CLI",
    );
    await waitForEval(
      agentBrowser,
      `!!document.querySelector('[aria-label="Canvas tools"] [aria-label="Director Stage"]')`,
      "Director Stage Canvas tool",
      120_000,
    );
    if (!clickButtonByLabel(agentBrowser, "Director Stage")) {
      throw new Error("Could not add Director Stage action");
    }
    const stageActionNodeId = await waitForEval(
      agentBrowser,
      `document.querySelector('[data-director-stage-action]')?.closest('[data-id]')?.getAttribute('data-id')`,
      "Director Stage Canvas node",
    );
    const generatorResult = JSON.parse(run(directorCliPath, [
      "canvas",
      "add",
      "--project",
      projectId,
      "--type",
      "video_gen",
      "--label",
      "Generate Director shots",
      "--prompt",
      "Preserve the blocking, performance, lens, and camera movement from each Director reference shot.",
      "--model",
      "seedance-2-ref",
      "--ref",
      stageActionNodeId,
      "--json",
    ])) as { node_id?: string; nodeId?: string };
    const videoGeneratorNodeId = generatorResult.node_id ?? generatorResult.nodeId;
    if (!videoGeneratorNodeId) {
      throw new Error(`CLI did not return the Video Gen node id: ${JSON.stringify(generatorResult)}`);
    }
    await waitForEval(
      agentBrowser,
      `!!document.querySelector('[data-director-stage-action]')`,
      "Director Stage action",
    );
    if (!clickByText(agentBrowser, "Open Director Stage")) {
      throw new Error("Could not open Director Stage");
    }
    await waitForEval(
      agentBrowser,
      `!!document.querySelector('[data-testid="project-director-stage-editor"] canvas')`,
      "Director Stage WebGL canvas",
      60_000,
    );
    if (!clickButtonByLabel(agentBrowser, "Collapse AI Copilot")) {
      clickButtonByLabel(agentBrowser, "Collapse chat panel");
    }

    await waitForEval(
      agentBrowser,
      `!!document.querySelector('[data-director-story-template] button:not(:disabled)')`,
      "empty-stage story template",
    );
    if (!clickByText(agentBrowser, "Stage three-actor story")) {
      throw new Error("Could not stage the three-actor story");
    }
    const timelineContract = await waitForEval(
      agentBrowser,
      `(() => {
        const storyBeats = document.querySelectorAll('[data-director-story-beat]').length;
        const sequenceShots = document.querySelectorAll('[data-director-sequence-shot]').length;
        const actionClips = document.querySelectorAll('[data-director-action-clip]').length;
        const body = document.body.innerText;
        if (storyBeats !== 7 || sequenceShots !== 7 || actionClips < 2) return false;
        if (!body.includes('他不会来了。') || !body.includes('现在已经太晚了。')) return false;
        if (!body.includes('Add shot') || !body.includes('Shots')) return false;
        return { storyBeats, sequenceShots, actionClips };
      })()`,
      "three-actor story timeline",
      60_000,
    );
    agentBrowser(["screenshot", timelineScreenshot]);

    const liveCuts = [];
    for (const [cueId, expectedCameraId] of cues) {
      clickCue(agentBrowser, cueId);
      await waitForEval(
        agentBrowser,
        `document.querySelector('[data-testid="project-director-stage-editor"]')`
          + `?.getAttribute('data-director-active-camera') === ${JSON.stringify(expectedCameraId)}`,
        `${cueId} active camera`,
      );
      await sleep(350);
      liveCuts.push(rendererObservation(agentBrowser));
    }

    clickCue(agentBrowser, "story-shot-lead");
    clickCue(agentBrowser, "story-shot-reverse", { metaKey: true });
    const multiSelection = await waitForEval(
      agentBrowser,
      `(() => {
        const selected = [...document.querySelectorAll('[data-director-sequence-shot][aria-pressed="true"]')]
          .map((node) => node.getAttribute('data-director-sequence-shot'));
        const primary = document.querySelector('[data-director-primary-shot="true"]')
          ?.getAttribute('data-director-sequence-shot');
        return selected.length === 2 ? { selected, primary } : false;
      })()`,
      "Director multi-Shot selection",
    );

    if (!clickByText(agentBrowser, "Generate 2 selected shots")) {
      throw new Error("Could not generate the two selected Director shots");
    }
    await waitForEval(
      agentBrowser,
      `document.querySelector('[data-director-video-export-status]')`
        + `?.getAttribute('data-director-video-export-status') === 'exporting'`,
      "selected Director Shot export start",
    );
    await waitForEval(
      agentBrowser,
      `document.querySelector('[data-director-video-export-status]')`
        + `?.getAttribute('data-director-video-export-status') === 'idle'`,
      "selected Director Shot export completion",
      120_000,
    );

    const openedCanvas = evalJson(agentBrowser, `(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) =>
        candidate.getAttribute('aria-label')?.startsWith('Open parent Canvas '));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!openedCanvas) throw new Error("Could not return to the Director parent Canvas");
    const canvasNodes = await waitForCanvasNodes(
      directorCliPath,
      projectId,
      (nodes) => nodes.some((node) => (
        node.type === "group"
        && node.data?.label === "Director shots · 2"
      )),
      "persisted Director Shot Group",
    );
    const shotGroup = canvasNodes.find((node) => (
      node.type === "group"
      && node.data?.label === "Director shots · 2"
    ));
    if (!shotGroup) {
      throw new Error("Persisted Director Shot Group disappeared after polling");
    }
    const shotGroupId = shotGroup.id;
    await waitForEval(
      agentBrowser,
      `!!document.querySelector(${JSON.stringify(`[data-id="${shotGroupId}"]`)})`,
      "visible Director Shot Group",
    );
    const groupedShotOutputs = canvasNodes.filter(
      (node) => (
        node.data?.directorShotGroupId === shotGroupId
        && typeof node.data?.sourceDirectorStageShotId === "string"
      ),
    );
    const groupedShotIds = groupedShotOutputs
      .map((node) => node.data?.sourceDirectorStageShotId)
      .filter((value): value is string => typeof value === "string")
      .sort();
    if (
      groupedShotOutputs.length !== 2
      || groupedShotOutputs.some((node) => node.parent_id !== shotGroupId)
      || JSON.stringify(groupedShotIds) !== JSON.stringify([
        "story-shot-lead",
        "story-shot-reverse",
      ])
    ) {
      throw new Error(
        `Invalid Director Shot Group lineage: ${JSON.stringify({ shotGroupId, groupedShotOutputs })}`,
      );
    }
    agentBrowser(["screenshot", shotGroupScreenshot]);

    const reopenedStage = evalJson(agentBrowser, `(() => {
      const node = document.querySelector(${JSON.stringify(`[data-id="${stageActionNodeId}"]`)});
      const button = [...(node?.querySelectorAll('button') ?? [])].find((candidate) =>
        candidate.textContent?.includes('Open Director Stage'));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!reopenedStage) throw new Error("Could not reopen Director Stage");
    await waitForEval(
      agentBrowser,
      `document.querySelector('[data-testid="project-director-stage-editor"]')`
        + `?.getAttribute('data-director-viewport-ready') === 'true'`,
      "reopened Director Stage renderer",
      60_000,
    );

    if (!clickButtonByLabel(agentBrowser, "Preview sequence")) {
      throw new Error("Could not start Director sequence preview");
    }
    await waitForEval(
      agentBrowser,
      `document.querySelector('[data-director-video-export-status]')`
        + `?.getAttribute('data-director-video-export-status') === 'exporting'`,
      "Director camera video export start",
    );
    await waitForEval(
      agentBrowser,
      `document.querySelector('[data-director-video-export-status]')`
        + `?.getAttribute('data-director-video-export-status') === 'idle'`,
      "Director camera video export completion",
      120_000,
    );

    const videoStat = await stat(videoPath);
    if (videoStat.size < 250_000) {
      throw new Error(`Exported Director story video is too small: ${videoStat.size}`);
    }
    const probe = probeVideo(videoPath);
    const video = probe.streams[0];
    if (!video || !["vp8", "vp9"].includes(video.codec_name)) {
      throw new Error(`Unexpected Director story video codec: ${video?.codec_name}`);
    }
    if (video.width !== 1920 || video.height !== 1080) {
      throw new Error(`Unexpected Director story dimensions: ${video.width}x${video.height}`);
    }
    const containerDuration = Number(probe.format.duration);
    const durationSeconds = Number.isFinite(containerDuration)
      ? containerDuration
      : lastVideoFrameTimestamp(videoPath);
    const decodedFrames = Number(video.nb_read_frames);
    if (durationSeconds < 31.5 || durationSeconds > 34) {
      throw new Error(`Unexpected Director story duration: ${durationSeconds}`);
    }
    const effectiveFrameRate = decodedFrames / durationSeconds;
    if (effectiveFrameRate < 12) {
      throw new Error(
        `Director story export fell below the 12 fps headless floor: ${effectiveFrameRate}`,
      );
    }
    const contactSheet = extractContactSheet(videoPath);
    if (contactSheet.uniqueFrameHashes < 6) {
      throw new Error(
        `Director camera cut export produced only ${contactSheet.uniqueFrameHashes} distinct cue frames`,
      );
    }

    console.log(JSON.stringify({
      verified: true,
      timeline: timelineContract,
      multiSelection,
      shotGroup: {
        id: shotGroupId,
        generatorNodeId: videoGeneratorNodeId,
        outputNodeIds: groupedShotOutputs.map((node) => node.id),
        shotIds: groupedShotIds,
        screenshot: shotGroupScreenshot,
      },
      liveCuts,
      video: {
        path: videoPath,
        bytes: videoStat.size,
        codec: video.codec_name,
        width: video.width,
        height: video.height,
        durationSeconds,
        decodedFrames,
        avgFrameRate: video.avg_frame_rate,
        effectiveFrameRate,
      },
      contactSheet: {
        path: contactSheetPath,
        uniqueFrameHashes: contactSheet.uniqueFrameHashes,
      },
      screenshots: { timeline: timelineScreenshot },
    }, null, 2));
  } catch (error) {
    agentBrowser(
      ["screenshot", path.join(captureDir, "director-story-failure.png")],
      { allowFailure: true },
    );
    console.error(error);
    console.error("Web tail:\n", tail(webLogs));
    console.error("Electron tail:\n", tail(electronLogs));
    process.exitCode = 1;
  } finally {
    agentBrowser(["close"], { allowFailure: true });
    await stopProcess(electron);
    await stopProcess(web);
  }
}

await main();
