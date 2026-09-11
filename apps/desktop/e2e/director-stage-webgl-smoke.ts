import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
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
  tail,
  waitForEval,
  waitForHttp,
} from "./startup-shared.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runRoot = process.env.CLASH_DIRECTOR_E2E_ROOT
  ?? path.join(repoRoot, ".tmp", "director-stage-webgl-e2e");
const dataDir = path.join(runRoot, "data");
const captureDir = path.join(runRoot, "captures");
const inspectorScreenshot = path.join(captureDir, "director-stage-character-inspector.png");
const annyBodiesScreenshot = path.join(captureDir, "director-stage-anny-bodies.png");
const poseScreenshot = path.join(captureDir, "director-stage-pose-skeleton.png");
const autoWalkScreenshot = path.join(captureDir, "director-stage-auto-walk.png");
const trackingWalkStartScreenshot = path.join(captureDir, "director-stage-walk-tracking-start.png");
const trackingWalkEndScreenshot = path.join(captureDir, "director-stage-walk-tracking-end.png");
const exportedWalkStartFrame = path.join(captureDir, "director-stage-exported-walk-start.png");
const exportedWalkEndFrame = path.join(captureDir, "director-stage-exported-walk-end.png");
const layeredWaveScreenshot = path.join(captureDir, "director-stage-layered-wave.png");
const cliScaleScreenshot = path.join(captureDir, "director-stage-cli-scaled-character.png");
const stageScreenshot = path.join(captureDir, "director-stage-electron-webgl.png");
const motionPathScreenshot = path.join(captureDir, "director-stage-motion-paths.png");
const cameraLensScreenshot = path.join(captureDir, "director-stage-camera-lens-focus.png");
const horseRiderScreenshot = path.join(captureDir, "director-stage-horse-rider.png");
const uploadedModelScreenshot = path.join(captureDir, "director-stage-uploaded-model.png");
const objectCatalogScreenshot = path.join(captureDir, "director-stage-object-catalog.png");
const panoramaScreenshot = path.join(captureDir, "director-stage-panorama.png");
const canvasScreenshot = path.join(captureDir, "director-stage-shot-on-canvas.png");
const cameraVideoPath = path.join(captureDir, "director-stage-camera.webm");
const panoramaFixturePath = process.env.CLASH_DIRECTOR_E2E_PANORAMA_PATH;
const modelFixturePath = process.env.CLASH_DIRECTOR_E2E_MODEL_PATH;
const verifyCalibrationPanorama = process.env.CLASH_DIRECTOR_E2E_CALIBRATION_PANORAMA === "1";
const panoramaOnly = process.env.CLASH_DIRECTOR_E2E_PANORAMA_ONLY === "1";
const motionOnly = process.env.CLASH_DIRECTOR_E2E_MOTION_ONLY === "1";
const sessionName = `clash-director-webgl-${Date.now().toString(36)}`;

function clickByAriaLabel(agentBrowser, label) {
  return evalJson(agentBrowser, `(() => {
    const label = ${JSON.stringify(label)};
    const element = [...document.querySelectorAll("button, [role='button']")].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const style = getComputedStyle(candidate);
      return candidate.getAttribute("aria-label") === label &&
        rect.width > 0 && rect.height > 0 &&
        style.display !== "none" && style.visibility !== "hidden" &&
        !candidate.disabled;
    });
    if (!element) return false;
    const pointer = { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const mouse = { bubbles: true, cancelable: true, button: 0 };
    element.dispatchEvent(new PointerEvent('pointerdown', pointer));
    element.dispatchEvent(new MouseEvent('mousedown', mouse));
    element.dispatchEvent(new PointerEvent('pointerup', pointer));
    element.dispatchEvent(new MouseEvent('mouseup', mouse));
    element.click();
    return true;
  })()`);
}

async function warmProjectRouteInRenderer(agentBrowser, { cdpPort, webOrigin }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    evalJson(agentBrowser, `(() => {
      window.__directorProjectRouteWarmup = 'loading';
      import('/app/routes/project.$id.tsx')
        .then(() => { window.__directorProjectRouteWarmup = 'ready'; })
        .catch((error) => {
          window.__directorProjectRouteWarmup = 'error:' + (error?.message || String(error));
        });
      return true;
    })()`);
    const status = await waitForEval(
      agentBrowser,
      `window.__directorProjectRouteWarmup !== 'loading' && window.__directorProjectRouteWarmup`,
      "Director Stage project route renderer warmup",
      120000,
    );
    if (status === "ready") return;
    if (attempt === 2) throw new Error(`Could not warm the project route: ${status}`);
    evalJson(agentBrowser, "location.reload(); true");
    await sleep(750);
    recoverAgentBrowserTarget(agentBrowser, {
      cdpPort,
      expectedUrlPrefix: `${webOrigin}/`,
    });
    await waitForEval(agentBrowser, `document.body.innerText.includes("Home")`, "desktop home after route warmup retry");
  }
}

function clickMenuItem(agentBrowser, text) {
  return evalJson(agentBrowser, `(() => {
    const text = ${JSON.stringify(text)};
    const element = [...document.querySelectorAll('[role="menuitem"]')].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const style = getComputedStyle(candidate);
      return (candidate.innerText || candidate.textContent || '').trim() === text &&
        rect.width > 0 && rect.height > 0 &&
        style.display !== 'none' && style.visibility !== 'hidden' &&
        candidate.getAttribute('aria-disabled') !== 'true';
    });
    if (!element) return false;
    const pointer = { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const mouse = { bubbles: true, cancelable: true, button: 0 };
    element.dispatchEvent(new PointerEvent('pointerdown', pointer));
    element.dispatchEvent(new MouseEvent('mousedown', mouse));
    element.dispatchEvent(new PointerEvent('pointerup', pointer));
    element.dispatchEvent(new MouseEvent('mouseup', mouse));
    element.click();
    return true;
  })()`);
}

function clickDirectorAssetCard(agentBrowser, name) {
  return evalJson(agentBrowser, `(() => {
    const name = ${JSON.stringify(name)};
    const element = [...document.querySelectorAll('button')].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const title = candidate.querySelector('strong')?.textContent?.trim();
      return title === name && rect.width > 0 && rect.height > 0 && !candidate.disabled;
    });
    if (!element) return false;
    element.scrollIntoView({ block: 'center' });
    element.click();
    return true;
  })()`);
}

function clickSelectOption(agentBrowser, text) {
  const marked = evalJson(agentBrowser, `(() => {
    const text = ${JSON.stringify(text)};
    document.querySelectorAll('[data-director-e2e-option]').forEach((candidate) => {
      candidate.removeAttribute('data-director-e2e-option');
    });
    const element = [...document.querySelectorAll('[role="option"]')].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return (candidate.innerText || candidate.textContent || '').trim() === text &&
        rect.width > 0 && rect.height > 0 && candidate.getAttribute('aria-disabled') !== 'true';
    });
    if (!element) return false;
    element.setAttribute('data-director-e2e-option', 'true');
    return true;
  })()`);
  if (!marked) return false;
  agentBrowser(["click", '[data-director-e2e-option="true"]']);
  return true;
}

function setInputByAriaLabel(agentBrowser, label, value) {
  return evalJson(agentBrowser, `(() => {
    const input = document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)});
    if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) return false;
    input.scrollIntoView({ block: 'center' });
    const prototype = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    setter?.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value;
  })()`);
}

function setInputByPlaceholder(agentBrowser, placeholder, value) {
  return evalJson(agentBrowser, `(() => {
    const input = document.querySelector(${JSON.stringify(`[placeholder="${placeholder}"]`)});
    if (!(input instanceof HTMLInputElement)) return false;
    input.scrollIntoView({ block: 'center' });
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value;
  })()`);
}

function setSliderByAriaLabel(agentBrowser, label, value) {
  const selector = `[role="slider"][aria-label="${label}"]`;
  const current = evalJson(agentBrowser, `Number(document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-valuenow'))`);
  if (!Number.isFinite(current) || !Number.isFinite(value)) return false;
  agentBrowser(["click", selector]);
  const key = value >= current ? "ArrowRight" : "ArrowLeft";
  for (let step = 0; step < Math.abs(value - current); step += 1) {
    agentBrowser(["press", key]);
  }
  return evalJson(agentBrowser, `Number(document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-valuenow'))`);
}

function seekDirectorTimeline(agentBrowser, seconds) {
  return evalJson(agentBrowser, `(() => {
    const ruler = document.querySelector('[data-director-keyframe-timeline] [data-timeline-ruler]');
    if (!(ruler instanceof HTMLElement)) return false;
    const rect = ruler.getBoundingClientRect();
    const pixelsPerSecond = 30 * 2;
    const x = Math.min(rect.width - 2, Math.max(2, ${JSON.stringify(seconds)} * pixelsPerSecond));
    ruler.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + x,
      clientY: rect.top + rect.height / 2,
    }));
    return true;
  })()`);
}

function readDirectorCanvasStats(agentBrowser) {
  return evalJson(agentBrowser, `(() => {
    const canvas = document.querySelector('[data-testid="project-director-stage-editor"] canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl || gl.isContextLost()) return false;
    gl.finish();
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let cyanPixels = 0;
    let neutralPixels = 0;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      const pixelIndex = index / 4;
      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);
      if (red < 150 && green > 165 && blue > 185 && blue > red + 55) cyanPixels += 1;
      const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
      // Actor 1 is the neutral white mannequin positioned on the left. Crop
      // the sample so the other three profile colors cannot merge into its
      // silhouette bounds.
      if (x < width * 0.34 && Math.min(red, green, blue) > 105 && spread < 38) {
        neutralPixels += 1;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    return {
      width,
      height,
      cyanPixels,
      neutralPixels,
      neutralBounds: maxX >= minX && maxY >= minY
        ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
        : null,
    };
  })()`);
}

function readDirectorFrameSignature(agentBrowser) {
  return evalJson(agentBrowser, `(() => {
    const canvas = document.querySelector('[data-testid="project-director-stage-editor"] canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl || gl.isContextLost()) return false;
    gl.finish();
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const columns = 16;
    const rows = 9;
    const signature = [];
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const x = Math.min(width - 1, Math.floor((column + 0.5) * width / columns));
        const y = Math.min(height - 1, Math.floor((row + 0.5) * height / rows));
        const index = (y * width + x) * 4;
        signature.push(pixels[index], pixels[index + 1], pixels[index + 2]);
      }
    }
    return signature;
  })()`);
}

function signatureDifference(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return 0;
  return left.reduce((sum, value, index) => sum + Math.abs(value - right[index]), 0) / left.length;
}

function readDirectorNeutralSilhouette(agentBrowser) {
  return evalJson(agentBrowser, `(() => {
    const canvas = document.querySelector('[data-testid="project-director-stage-editor"] canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl || gl.isContextLost()) return false;
    gl.finish();
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let count = 0;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
      if (Math.min(red, green, blue) <= 105 || spread >= 38) continue;
      const pixelIndex = index / 4;
      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);
      count += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    return maxX >= minX && maxY >= minY
      ? { count, x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
      : false;
  })()`);
}

function runClashCliJson(cliPath, args) {
  const result = spawnSync(cliPath, [...args, "--json"], {
    cwd: runRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CLASH_API_URL: process.env.CLASH_API_URL,
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `Clash CLI failed (${args.join(" ")}): ${result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`}`,
    );
  }
  const output = result.stdout.trim();
  if (!output) throw new Error(`Clash CLI returned no JSON for ${args.join(" ")}`);
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`Could not parse Clash CLI JSON for ${args.join(" ")}: ${output}\n${error}`);
  }
}

async function waitForFile(filePath, label, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const info = await stat(filePath);
      if (info.isFile()) return filePath;
    } catch {
      // The Desktop host publishes its agent-owned CLI after Local API starts.
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}: ${filePath}`);
}

async function pullDirectorStageWithCli({ cliPath, projectId, stageId, projectionPath }) {
  const startedAt = Date.now();
  let listed = [];
  let lastError;
  while (Date.now() - startedAt < 30000) {
    listed = runClashCliJson(cliPath, ["director", "list", "--project", projectId]);
    if (listed.some((stage) => stage.id === stageId)) {
      try {
        const pulled = runClashCliJson(cliPath, [
          "director",
          "pull",
          "--project",
          projectId,
          "--stage",
          stageId,
          "--file",
          projectionPath,
        ]);
        const state = JSON.parse(await readFile(projectionPath, "utf8"));
        return { listed, pulled, state };
      } catch (error) {
        lastError = error;
      }
    }
    await sleep(300);
  }
  throw new Error(
    `Clash CLI could not read Director Stage ${stageId}; listed=${JSON.stringify(listed)}; ${lastError ?? "not listed"}`,
  );
}

function assertNoDirectorRendererErrors(logs) {
  const output = logs.join("");
  const forbidden = [
    /Error creating WebGL context/i,
    /WebGL context (?:is )?lost/i,
    /THREE\.WebGLRenderer: Error/i,
    /\[Director Stage\] capture failed/i,
    /Could not load .*\.gl(?:b|tf)/i,
    /Director mannequin is missing bound bone/i,
  ];
  const matched = forbidden.find((pattern) => pattern.test(output));
  if (matched) throw new Error(`Director renderer log matched ${matched}`);
}

async function main() {
  ensureAgentBrowser();
  await resetDirs(dataDir, captureDir);

  const webPort = await findFreePort(50710);
  const apiPort = await findFreePort(50810);
  const cdpPort = await findFreePort(50910);
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const webLogs = [];
  const electronLogs = [];
  const agentBrowser = createAgentBrowser({ sessionName, captureDir });
  let web;
  let electron;
  let directorDaemon;
  let directorCliPath;
  let verified = false;

  try {
    web = await startVite({ webPort, logs: webLogs });
    await waitForHttp(webOrigin, "Director Stage Vite shell");
    await waitForHttp(
      `${webOrigin}/app/routes/project.$id.tsx`,
      "Director Stage project route module",
    );
    electron = await startElectron({
      cdpPort,
      webOrigin,
      apiPort,
      dataDir,
      captureDir,
      logs: electronLogs,
      env: {
        CLASH_E2E_STUB_ACP: "1",
        CLASH_DIRECTOR_E2E_VIDEO_EXPORT_PATH: cameraVideoPath,
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
    await warmProjectRouteInRenderer(agentBrowser, { cdpPort, webOrigin });

    if (!clickByText(agentBrowser, "Projects")) throw new Error("Could not open Projects");
    await waitForEval(agentBrowser, `location.pathname === "/projects"`, "Projects route");
    if (!clickByText(agentBrowser, "New Project")) throw new Error("Could not create Project");
    await waitForEval(
      agentBrowser,
      `Boolean(document.querySelector('input[placeholder="Untitled project"]')) || location.pathname.startsWith('/projects/')`,
      "Project creation dialog or editor route",
    );
    if (evalJson(agentBrowser, `Boolean(document.querySelector('input[placeholder="Untitled project"]'))`)) {
      if (setInputByPlaceholder(agentBrowser, "Untitled project", "Director Action E2E") !== "Director Action E2E") {
        throw new Error("Could not name the Director Stage E2E project");
      }
      if (!clickByText(agentBrowser, "Create")) throw new Error("Could not submit the Director Stage E2E project");
    }
    const projectId = await waitForEval(
      agentBrowser,
      `location.pathname.startsWith("/projects/") && location.pathname.split("/").pop()`,
      "Project editor route",
    );
    const projectSurfaceState = await waitForEval(
      agentBrowser,
      `document.querySelector('[aria-label="Canvas tools"] [aria-label="Director Stage"]')
        ? 'ready'
        : document.body.innerText.includes('Clash could not finish this view')
          ? 'paused'
          : false`,
      "Project editor surface or recoverable route pause",
      30000,
    );
    if (projectSurfaceState === "paused") {
      if (!clickByText(agentBrowser, "Reload")) throw new Error("Could not recover the cold project route");
      await waitForEval(
        agentBrowser,
        `!!document.querySelector('[aria-label="Canvas tools"] [aria-label="Director Stage"]')`,
        "Director Stage Canvas tool after route recovery",
        120000,
      );
    }
    // Generation is server-processed, so the Stage graph must exist in the
    // synced room rather than only in the client's local document.
    await waitForEval(
      agentBrowser,
      `document.querySelector('[data-project-loro-connected]')?.getAttribute('data-project-loro-connected') === 'true'`,
      "project Loro room connection",
    );
    directorCliPath = await waitForFile(
      path.join(dataDir, "agent-bin", "clash"),
      "host-owned Clash CLI",
    );
    directorDaemon = spawn(
      directorCliPath,
      ["canvas", "connect", "--project", projectId],
      {
        cwd: runRoot,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    directorDaemon.stdout.on("data", (buffer) => electronLogs.push(String(buffer)));
    directorDaemon.stderr.on("data", (buffer) => electronLogs.push(String(buffer)));
    await sleep(800);

    if (!clickByAriaLabel(agentBrowser, "Director Stage")) {
      throw new Error("Could not add Director Stage Action");
    }
    const actionId = await waitForEval(
      agentBrowser,
      `document.querySelector('[data-director-stage-action]')?.closest('[data-id]')?.getAttribute('data-id')`,
      "Director Stage Action",
    );
    const stageId = await waitForEval(
      agentBrowser,
      `document.querySelector('[data-director-stage-action]')?.getAttribute('data-director-stage-action')`,
      "Director Stage ID",
    );
    if (!clickByText(agentBrowser, "Open Director Stage")) {
      throw new Error("Could not open Director Stage");
    }
    await waitForEval(
      agentBrowser,
      `!!document.querySelector('[data-testid="project-director-stage-editor"] canvas')`,
      "Director Stage WebGL canvas",
    );
    if (!clickByAriaLabel(agentBrowser, "Collapse AI Copilot") &&
        !clickByAriaLabel(agentBrowser, "Collapse chat panel")) {
      throw new Error("Could not give the Director Stage the full desktop viewport");
    }
    await waitForEval(
      agentBrowser,
      `!!document.querySelector('[aria-label="Expand AI Copilot"], [aria-label="Expand chat panel"]')`,
      "collapsed chat panel",
    );

    const initialWebgl = await waitForEval(
      agentBrowser,
      `(() => {
        const root = document.querySelector('[data-testid="project-director-stage-editor"]');
        const canvas = root?.querySelector('canvas');
        if (!root || !(canvas instanceof HTMLCanvasElement) || canvas.width < 2 || canvas.height < 2) return false;
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
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        const styles = getComputedStyle(document.documentElement);
        const frame = root.getBoundingClientRect();
        const tokenValues = {
          panel: styles.getPropertyValue('--clash-director-panel').trim(),
          viewport: styles.getPropertyValue('--clash-director-viewport').trim(),
          selection: styles.getPropertyValue('--clash-director-selection').trim(),
          timeline: styles.getPropertyValue('--clash-director-timeline-surface').trim(),
        };
        if (Object.values(tokenValues).some((value) => !value)) return false;
        if (pixel[0] + pixel[1] + pixel[2] === 0) return false;
        return {
          width: canvas.width,
          height: canvas.height,
          frame: { width: Math.round(frame.width), height: Math.round(frame.height) },
          context: gl instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl',
          version: gl.getParameter(gl.VERSION),
          vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
          renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          centerPixel: [...pixel],
          preservedFrameBytes: canvas.toDataURL('image/png').length,
          tokens: tokenValues,
        };
      })()`,
      "live tokenized WebGL framebuffer",
      30000,
    );
    const initialFrameSignature = readDirectorFrameSignature(agentBrowser);

    if (modelFixturePath && process.env.CLASH_DIRECTOR_E2E_MODEL_ONLY === "1") {
      const modelStat = await stat(modelFixturePath);
      if (modelStat.size < 1024) throw new Error(`Director model fixture is too small: ${modelStat.size}`);
      agentBrowser(["upload", 'input[accept*=".glb"]', modelFixturePath]);
      const expectedModelName = path.basename(modelFixturePath);
      await waitForEval(
        agentBrowser,
        `document.body.textContent.includes(${JSON.stringify(expectedModelName)})`,
        "uploaded Director model scene object",
        30000,
      );
      await sleep(1200);
      const uploadedModelFrameSignature = readDirectorFrameSignature(agentBrowser);
      const uploadedModelFrameDifference = signatureDifference(
        initialFrameSignature,
        uploadedModelFrameSignature,
      );
      if (uploadedModelFrameDifference < 1) {
        throw new Error(`Uploaded model did not alter the WebGL frame: ${uploadedModelFrameDifference}`);
      }
      agentBrowser(["screenshot", uploadedModelScreenshot]);
      assertNoDirectorRendererErrors([...webLogs, ...electronLogs]);
      console.log("[director-stage-webgl] verified", JSON.stringify({
        projectId,
        actionId,
        stageId,
        webgl: initialWebgl,
        uploadedModelProof: {
          fileName: expectedModelName,
          bytes: modelStat.size,
          uploadedModelFrameDifference,
        },
        screenshots: { uploadedModel: uploadedModelScreenshot },
      }));
      verified = true;
      return;
    }

    if (process.env.CLASH_DIRECTOR_E2E_OBJECT_CATALOG_ONLY === "1") {
      const catalog = [
        { name: "Victorian armchair", position: [-2.8, 0, -0.5], scale: 1 },
        { name: "Vintage sofa", position: [-0.8, 0, -2.2], scale: 1 },
        { name: "Covered car", position: [2.4, 0, -1.2], scale: 0.75 },
        { name: "Casual character", position: [-1.4, 0, 2.2], scale: 1 },
        { name: "Animated horse", position: [0.7, 0, 2.2], scale: 0.5 },
        { name: "Anthurium plant", position: [2.8, 0, 1.9], scale: 0.85 },
      ];
      for (const entry of catalog) {
        if (!clickByAriaLabel(agentBrowser, "Add scene element")) {
          throw new Error(`Could not open scene element menu for ${entry.name}`);
        }
        if (!clickMenuItem(agentBrowser, "Browse real 3D assets")) {
          throw new Error(`Could not open production asset library for ${entry.name}`);
        }
        await waitForEval(
          agentBrowser,
          `document.querySelector('[role="dialog"]')?.textContent?.includes('Production assets')`,
          "production asset library",
        );
        if (!clickDirectorAssetCard(agentBrowser, entry.name)) {
          throw new Error(`Could not add production asset ${entry.name}`);
        }
        await waitForEval(
          agentBrowser,
          `document.body.textContent.includes(${JSON.stringify(entry.name)})`,
          `${entry.name} scene object`,
        );
        for (const [index, axis] of ["X", "Y", "Z"].entries()) {
          const value = String(entry.position[index]);
          if (setInputByAriaLabel(agentBrowser, `Position ${axis}`, value) !== value) {
            throw new Error(`Could not position ${entry.name} on ${axis}`);
          }
        }
        for (const axis of ["X", "Y", "Z"]) {
          const value = String(entry.scale);
          if (setInputByAriaLabel(agentBrowser, `Scale ${axis}`, value) !== value) {
            throw new Error(`Could not scale ${entry.name} on ${axis}`);
          }
        }
      }
      if (!clickByText(agentBrowser, "Casual character")) {
        throw new Error("Could not select the rigged production character");
      }
      if (!clickByText(agentBrowser, "Motion")) {
        throw new Error("Could not open the rigged model Motion inspector");
      }
      if (!clickByAriaLabel(agentBrowser, "Action") || !clickSelectOption(agentBrowser, "Wave")) {
        throw new Error("Could not choose the character's embedded Wave clip");
      }
      const idleCharacterFrameSignature = readDirectorFrameSignature(agentBrowser);
      if (!clickByText(agentBrowser, "Add action at 0.00s")) {
        throw new Error("Could not add the embedded Wave clip to the model action track");
      }
      await waitForEval(
        agentBrowser,
        `document.querySelectorAll('[data-director-action-clip]').length >= 1`,
        "rigged model action clip",
      );
      if (!seekDirectorTimeline(agentBrowser, 1)) {
        throw new Error("Could not seek inside the embedded Wave clip");
      }
      await sleep(500);
      const animatedCharacterFrameSignature = readDirectorFrameSignature(agentBrowser);
      const riggedActionFrameDifference = signatureDifference(
        idleCharacterFrameSignature,
        animatedCharacterFrameSignature,
      );
      if (riggedActionFrameDifference < 0.05) {
        throw new Error(`Embedded model action did not alter the WebGL frame: ${riggedActionFrameDifference}`);
      }
      await sleep(4000);
      const objectCatalogFrameSignature = readDirectorFrameSignature(agentBrowser);
      const objectCatalogFrameDifference = signatureDifference(
        initialFrameSignature,
        objectCatalogFrameSignature,
      );
      agentBrowser(["screenshot", objectCatalogScreenshot]);
      if (objectCatalogFrameDifference < 1) {
        throw new Error(`Object catalog did not materially alter the WebGL frame: ${objectCatalogFrameDifference}`);
      }
      assertNoDirectorRendererErrors([...webLogs, ...electronLogs]);
      console.log("[director-stage-webgl] verified", JSON.stringify({
        projectId,
        actionId,
        stageId,
        webgl: initialWebgl,
        objectCatalogProof: {
          objects: catalog.map((entry) => entry.name),
          source: "bundled CC0 GLB/glTF production assets",
          objectCatalogFrameDifference,
          riggedAction: {
            character: "Casual character",
            clip: "Wave",
            riggedActionFrameDifference,
          },
        },
        screenshots: { objectCatalog: objectCatalogScreenshot },
      }));
      verified = true;
      return;
    }

    const skipPanorama = process.env.CLASH_DIRECTOR_E2E_SKIP_PANORAMA === "1";
    let aiPanorama = null;
    let cameraProof = null;
    let horseRiderProof = null;
    let uploadedModelProof = null;
    if (panoramaFixturePath) {
      const fixtureStat = await stat(panoramaFixturePath);
      if (fixtureStat.size < 1024) throw new Error(`Panorama fixture is too small: ${fixtureStat.size}`);
      agentBrowser(["upload", '[aria-label="Panorama file"]', panoramaFixturePath]);
      const selection = await waitForEval(
        agentBrowser,
        `(() => {
          const value = document.querySelector('[aria-label="Scene panorama"]')?.textContent?.trim() || '';
          return value && value !== 'None' ? value : false;
        })()`,
        "uploaded panorama bound to the Stage",
        30000,
      );
      const previewedPanorama = evalJson(agentBrowser, `(() => {
        const button = [...document.querySelectorAll('button')].find((candidate) =>
          candidate.textContent?.includes('Preview panorama in viewport') && !candidate.disabled);
        if (!button) return false;
        button.click();
        return true;
      })()`);
      if (!previewedPanorama) {
        throw new Error("Could not preview the uploaded panorama");
      }
      await waitForEval(
        agentBrowser,
        `[...document.querySelectorAll('button[aria-pressed="true"]')].some((button) => button.textContent?.includes('Preview panorama in viewport'))`,
        "visible panorama background",
      );
      await sleep(800);
      const panoramaFrameSignature = readDirectorFrameSignature(agentBrowser);
      const frameDifference = signatureDifference(initialFrameSignature, panoramaFrameSignature);
      if (frameDifference < 7) {
        throw new Error(`Panorama did not materially change the WebGL background: ${frameDifference}`);
      }
      let alignment = null;
      if (verifyCalibrationPanorama) {
        if (setInputByAriaLabel(agentBrowser, "Panorama horizon", "8") !== "8") {
          throw new Error("Could not offset the calibration panorama horizon");
        }
        if (setInputByAriaLabel(agentBrowser, "Panorama yaw", "20") !== "20") {
          throw new Error("Could not offset the calibration panorama yaw");
        }
        await sleep(500);
        const offsetFrameSignature = readDirectorFrameSignature(agentBrowser);
        const offsetFrameDifference = signatureDifference(
          panoramaFrameSignature,
          offsetFrameSignature,
        );
        if (offsetFrameDifference < 3) {
          throw new Error(
            `Panorama horizon/yaw controls did not materially rotate the WebGL background: ${offsetFrameDifference}`,
          );
        }
        if (setInputByAriaLabel(agentBrowser, "Panorama horizon", "0") !== "0") {
          throw new Error("Could not restore the calibration panorama horizon");
        }
        if (setInputByAriaLabel(agentBrowser, "Panorama yaw", "0") !== "0") {
          throw new Error("Could not restore the calibration panorama yaw");
        }
        await sleep(500);
        const restoredFrameSignature = readDirectorFrameSignature(agentBrowser);
        const restoredFrameDifference = signatureDifference(
          panoramaFrameSignature,
          restoredFrameSignature,
        );
        if (restoredFrameDifference > 1) {
          throw new Error(
            `Calibration panorama did not return to its aligned frame: ${restoredFrameDifference}`,
          );
        }
        alignment = {
          offset: { horizon: 8, yaw: 20 },
          aligned: { horizon: 0, yaw: 0 },
          offsetFrameDifference,
          restoredFrameDifference,
        };
      }
      agentBrowser(["screenshot", panoramaScreenshot]);
      aiPanorama = {
        selection,
        sourcePath: panoramaFixturePath,
        sourceBytes: fixtureStat.size,
        projection: "equirectangular",
        aspectRatio: "2:1",
        format: path.extname(panoramaFixturePath).toLowerCase() === ".png"
          ? "image/png"
          : "image/webp",
        frameDifference,
        alignment,
      };
      if (panoramaOnly) {
        assertNoDirectorRendererErrors([...webLogs, ...electronLogs]);
        console.log("[director-stage-webgl] verified", JSON.stringify({
          projectId,
          actionId,
          stageId,
          webgl: initialWebgl,
          aiPanorama,
          screenshots: {
            panorama: panoramaScreenshot,
          },
        }));
        verified = true;
        return;
      }
    } else if (!skipPanorama) {
      const panoramaBrief = "Rainy Shanghai street corner, neon reflections, cinematic practical lighting";
      if (setInputByAriaLabel(agentBrowser, "AI panorama prompt", panoramaBrief) !== panoramaBrief) {
        throw new Error("Could not enter the AI panorama brief");
      }
      if (!clickByText(agentBrowser, "Generate AI panorama")) {
        throw new Error("Could not start AI panorama generation");
      }
      aiPanorama = await waitForEval(
        agentBrowser,
        `(() => {
          const root = document.querySelector('[data-testid="project-director-stage-editor"]');
          const error = root?.querySelector('[data-director-panorama-error]')?.textContent?.trim();
          if (error) throw new Error('AI panorama generation failed: ' + error);
          const selection = root?.querySelector('[aria-label="Scene panorama"]')?.textContent?.trim() || '';
          const generating = [...(root?.querySelectorAll('button') || [])].some((button) =>
            button.textContent?.includes('Generating panorama'));
          if (generating || !selection || selection === 'None') return false;
          return {
            selection,
            projection: 'equirectangular',
            aspectRatio: '2:1',
            format: 'image/webp',
          };
        })()`,
        "generated 2:1 AI panorama bound to the Stage",
        60000,
      );
    }
    if (panoramaFixturePath) {
      if (!clickByAriaLabel(agentBrowser, "Scene panorama")) {
        throw new Error("Could not open the panorama selector before durable reload");
      }
      await waitForEval(
        agentBrowser,
        `[...document.querySelectorAll('[role="option"]')].some((option) => option.textContent?.trim() === 'None')`,
        "panorama None option",
      );
      if (!clickSelectOption(agentBrowser, "None")) {
        throw new Error("Could not unbind the panorama after its WebGL proof");
      }
      await waitForEval(
        agentBrowser,
        `document.querySelector('[aria-label="Scene panorama"]')?.textContent?.trim() === 'None'`,
        "panorama unbound while retaining the uploaded asset",
      );
    }

    if (!clickByAriaLabel(agentBrowser, "Add scene element")) {
      throw new Error("Could not open scene element menu");
    }
    await waitForEval(
      agentBrowser,
      `(() => {
        const labels = [...document.querySelectorAll('[role="menuitem"]')]
          .map((item) => item.textContent?.trim());
        const required = ${motionOnly
          ? JSON.stringify(["Add editable actor"])
          : JSON.stringify([
              "Add editable actor",
              "Masculine actor",
              "Feminine actor",
              "Broad actor",
              "Athletic actor",
              "Slender actor",
              "Youth actor",
              "Child actor",
              "Chibi actor",
            ])};
        return required.every((label) => labels.includes(label));
      })()`,
      motionOnly ? "default mannequin in scene element menu" : "all mannequin body types in scene element menu",
    );
    if (!clickMenuItem(agentBrowser, "Add editable actor")) throw new Error("Could not add editable actor");
    await waitForEval(agentBrowser, `document.body.innerText.includes("Actor 1")`, "mannequin scene row");
    await waitForEval(
      agentBrowser,
      `(() => {
        const bodyType = document.querySelector('[aria-label="Character profile"]')?.textContent?.trim();
        const color = document.querySelector('[aria-label="Object color"]');
        const bodyShape = document.querySelector('[role="slider"][aria-label="Body shape"]');
        return bodyType?.includes('Neutral') && color instanceof HTMLInputElement &&
          color.value === '#e8ebef' && bodyShape?.getAttribute('aria-valuenow') === '0';
      })()`,
      "neutral mannequin defaults",
    );
    if (motionOnly) {
      if (!clickByText(agentBrowser, "Motion")) throw new Error("Could not open mannequin Motion inspector");
      if (!clickByText(agentBrowser, "Add position keyframe · 0.00s")) {
        throw new Error("Could not add the motion-only initial position keyframe");
      }
      if (!seekDirectorTimeline(agentBrowser, 9)) throw new Error("Could not seek motion-only timeline");
      if (!clickByText(agentBrowser, "Properties")) throw new Error("Could not open motion-only Properties inspector");
      if (setInputByAriaLabel(agentBrowser, "Position X", "10.8") !== "10.8") {
        throw new Error("Could not move the motion-only mannequin");
      }
      if (!clickByText(agentBrowser, "Motion")) throw new Error("Could not reopen motion-only Motion inspector");
      if (!clickByText(agentBrowser, "Add position keyframe · 9.00s")) {
        throw new Error("Could not add the motion-only endpoint keyframe");
      }
      if (!seekDirectorTimeline(agentBrowser, 2.5)) throw new Error("Could not seek the real Walk clip");
      await sleep(700);
      agentBrowser(["screenshot", autoWalkScreenshot]);

      if (!seekDirectorTimeline(agentBrowser, 0)) {
        throw new Error("Could not seek to the tracking-shot reference frame");
      }
      if (!clickByAriaLabel(agentBrowser, "Add scene element")) {
        throw new Error("Could not open the scene menu for tracking camera");
      }
      await waitForEval(
        agentBrowser,
        `[...document.querySelectorAll('[role="menuitem"]')]
          .some((item) => item.textContent?.trim() === 'Add camera')`,
        "tracking camera menu item",
      );
      if (!clickMenuItem(agentBrowser, "Add camera")) {
        throw new Error("Could not add the tracking camera");
      }
      await waitForEval(agentBrowser, `document.body.innerText.includes("Camera 1")`, "tracking camera row");
      for (const [label, value] of [
        ["Position X", "0"],
        ["Position Y", "1.35"],
        ["Position Z", "6"],
        ["Camera focal length", "50"],
      ]) {
        if (setInputByAriaLabel(agentBrowser, label, value) !== value) {
          throw new Error(`Could not set ${label} for tracking camera`);
        }
      }
      if (!clickByAriaLabel(agentBrowser, "Camera focus target")) {
        throw new Error("Could not open the tracking camera target selector");
      }
      if (!clickSelectOption(agentBrowser, "Actor 1")) {
        throw new Error("Could not target Actor 1 with the tracking camera");
      }
      if (setInputByAriaLabel(agentBrowser, "Focus offset Y", "1.2") !== "1.2") {
        throw new Error("Could not raise the tracking camera target");
      }
      await waitForEval(
        agentBrowser,
        `(() => {
          const button = [...document.querySelectorAll('button')].find(
            (candidate) => candidate.textContent?.includes('Apply camera move'),
          );
          const preset = document.querySelector('[aria-label="Camera move preset"]');
          return button instanceof HTMLButtonElement && !button.disabled
            && preset?.textContent?.includes('Lead');
        })()`,
        "enabled lead-camera preset",
      );
      if (!clickByText(agentBrowser, "Apply camera move")) {
        throw new Error("Could not apply the lead-camera move");
      }
      const trackingTimeline = await waitForEval(
        agentBrowser,
        `(() => {
          const keys = [...document.querySelectorAll('[data-director-keyframe]')];
          const tracks = [...document.querySelectorAll('[data-director-track-label]')]
            .map((element) => element.textContent?.trim());
          return keys.length === 5 && tracks.some((label) => label?.includes('Camera 1position'))
            ? { keyframes: keys.length, tracks }
            : false;
        })()`,
        "actor and lead-camera position keys",
      );
      if (!clickByText(agentBrowser, "Camera view")) {
        throw new Error("Could not enter the tracking camera view");
      }
      if (!seekDirectorTimeline(agentBrowser, 1)) {
        throw new Error("Could not seek to the tracking-shot opening");
      }
      await sleep(500);
      const trackingStartFrame = readDirectorFrameSignature(agentBrowser);
      const trackingStartSilhouette = readDirectorNeutralSilhouette(agentBrowser);
      agentBrowser(["screenshot", trackingWalkStartScreenshot]);
      if (!seekDirectorTimeline(agentBrowser, 8)) {
        throw new Error("Could not seek to the tracking-shot closing");
      }
      await sleep(500);
      const trackingEndFrame = readDirectorFrameSignature(agentBrowser);
      const trackingEndSilhouette = readDirectorNeutralSilhouette(agentBrowser);
      agentBrowser(["screenshot", trackingWalkEndScreenshot]);
      if (!trackingStartSilhouette || !trackingEndSilhouette) {
        throw new Error(`Tracking shot lost the actor: ${JSON.stringify({
          trackingStartSilhouette,
          trackingEndSilhouette,
        })}`);
      }
      const trackingCenterDriftPixels = Math.hypot(
        trackingStartSilhouette.x + trackingStartSilhouette.width / 2
          - trackingEndSilhouette.x - trackingEndSilhouette.width / 2,
        trackingStartSilhouette.y + trackingStartSilhouette.height / 2
          - trackingEndSilhouette.y - trackingEndSilhouette.height / 2,
      );
      if (trackingCenterDriftPixels > 100) {
        throw new Error(`Camera preset lost the actor composition: ${trackingCenterDriftPixels}px`);
      }
      const trackingScaleChange = Math.max(
        trackingEndSilhouette.height / trackingStartSilhouette.height,
        trackingStartSilhouette.height / trackingEndSilhouette.height,
      );
      if (trackingScaleChange < 1.2) {
        throw new Error(`Lead-camera preset did not visibly change shot size: ${trackingScaleChange}`);
      }
      const trackingMotionDifference = signatureDifference(trackingStartFrame, trackingEndFrame);
      if (!clickByAriaLabel(agentBrowser, "Export camera video")) {
        throw new Error("Could not start the motion-only camera video export");
      }
      await waitForEval(
        agentBrowser,
        `document.querySelector('[data-director-video-export-status="exporting"]') !== null`,
        "motion-only camera video recording",
      );
      await waitForEval(
        agentBrowser,
        `(() => {
          const error = document.querySelector('[data-director-video-export-status="error"]');
          if (error) throw new Error('Motion-only camera video export entered error state');
          return document.querySelector('[data-director-video-export-status="idle"]') !== null;
        })()`,
        "completed motion-only camera video export",
        90000,
      );
      const cameraVideoStat = await stat(cameraVideoPath);
      const cameraVideoHeader = (await readFile(cameraVideoPath)).subarray(0, 4).toString("hex");
      if (cameraVideoStat.size < 1024 || cameraVideoHeader !== "1a45dfa3") {
        throw new Error(`Invalid motion-only camera WebM: ${cameraVideoStat.size} bytes, header ${cameraVideoHeader}`);
      }
      const probeResult = spawnSync("ffprobe", [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=codec_name,width,height:packet=pts_time,duration_time",
        "-of", "json",
        cameraVideoPath,
      ], { encoding: "utf8" });
      if (probeResult.status !== 0) {
        throw new Error(`Could not probe motion-only camera WebM: ${probeResult.stderr}`);
      }
      const probe = JSON.parse(probeResult.stdout);
      const stream = probe.streams?.[0];
      const packetEndTimes = (probe.packets ?? [])
        .map((packet) => Number(packet.pts_time) + Number(packet.duration_time ?? 0))
        .filter(Number.isFinite);
      const decodedFrameCount = packetEndTimes.length;
      const durationSeconds = Math.max(0, ...packetEndTimes);
      const averageFrameRate = decodedFrameCount / Math.max(durationSeconds, 0.001);
      if (
        !["vp8", "vp9"].includes(stream?.codec_name)
        || stream?.width !== 1920
        || stream?.height !== 1080
        || durationSeconds < 9.5
        || durationSeconds > 11
        || decodedFrameCount < 180
        || averageFrameRate < 18
      ) {
        throw new Error(`Unexpected motion-only camera WebM decode result: ${JSON.stringify({
          stream,
          durationSeconds,
          decodedFrameCount,
          averageFrameRate,
        })}`);
      }
      for (const [timeSeconds, outputPath] of [
        [1, exportedWalkStartFrame],
        [8, exportedWalkEndFrame],
      ]) {
        const frameResult = spawnSync("ffmpeg", [
          "-loglevel", "error",
          "-y",
          "-ss", String(timeSeconds),
          "-i", cameraVideoPath,
          "-frames:v", "1",
          "-vf", "scale=960:-2",
          outputPath,
        ], { encoding: "utf8" });
        if (frameResult.status !== 0) {
          throw new Error(`Could not extract exported frame at ${timeSeconds}s: ${frameResult.stderr}`);
        }
      }
      const exportedStartBytes = await readFile(exportedWalkStartFrame);
      const exportedEndBytes = await readFile(exportedWalkEndFrame);
      if (exportedStartBytes.equals(exportedEndBytes)) {
        throw new Error("Exported tracking-shot frames are identical");
      }
      const cameraVideo = {
        path: cameraVideoPath,
        bytes: cameraVideoStat.size,
        header: cameraVideoHeader,
        codec: stream.codec_name,
        width: stream.width,
        height: stream.height,
        durationSeconds,
        decodedFrameCount,
        averageFrameRate,
        extractedFrames: [exportedWalkStartFrame, exportedWalkEndFrame],
      };
      assertNoDirectorRendererErrors([...webLogs, ...electronLogs]);
      console.log("[director-stage-webgl] verified", JSON.stringify({
        projectId,
        actionId,
        stageId,
        webgl: initialWebgl,
        motion: {
          path: "X 0→10.8 over 9 seconds",
          averageSpeedMetersPerSecond: 1.2,
          pathFacing: true,
          baseClip: "Walk",
          camera: {
            move: "lead · front three-quarter",
            focalLengthMm: 50,
            focusTarget: "Actor 1",
            focusOffsetY: 1.2,
            trackingTimeline,
            trackingCenterDriftPixels,
            trackingScaleChange,
            trackingMotionDifference,
          },
        },
        cameraVideo,
        screenshots: {
          autoWalk: autoWalkScreenshot,
          trackingStart: trackingWalkStartScreenshot,
          trackingEnd: trackingWalkEndScreenshot,
        },
      }));
      verified = true;
      return;
    }
    if (setSliderByAriaLabel(agentBrowser, "Body shape", 45) !== 45) {
      throw new Error("Could not adjust the Anny body shape to a natural full intermediate");
    }
    await waitForEval(
      agentBrowser,
      `document.body.textContent.includes('Body shape · Full')`,
      "continuous Anny body-shape intermediate",
    );
    if (setInputByAriaLabel(agentBrowser, "Position X", "-3") !== "-3") {
      throw new Error("Could not position the neutral Anny body");
    }
    for (const body of [
      { menu: "Broad actor", actor: "Actor 2", label: "Broad", x: "-1" },
      { menu: "Slender actor", actor: "Actor 3", label: "Slender", x: "1" },
      { menu: "Child actor", actor: "Actor 4", label: "Child", x: "3" },
    ]) {
      if (!clickByAriaLabel(agentBrowser, "Add scene element")) {
        throw new Error(`Could not open scene menu for ${body.label}`);
      }
      if (!clickMenuItem(agentBrowser, body.menu)) throw new Error(`Could not add ${body.label} Anny body`);
      await waitForEval(agentBrowser, `document.body.innerText.includes(${JSON.stringify(body.actor)})`, body.actor);
      await waitForEval(
        agentBrowser,
        `document.querySelector('[aria-label="Character profile"]')?.textContent?.includes(${JSON.stringify(body.label)})`,
        `${body.label} Anny body type`,
      );
      if (setInputByAriaLabel(agentBrowser, "Position X", body.x) !== body.x) {
        throw new Error(`Could not position ${body.label} Anny body`);
      }
    }
    // Reconnect once after the browser's debounced local snapshot is durable.
    // This publishes a full Stage snapshot to the host and proves the CLI is
    // reading recoverable shared state, not renderer-only React state.
    await sleep(1600);
    evalJson(agentBrowser, "location.reload(); true");
    await sleep(750);
    recoverAgentBrowserTarget(agentBrowser, {
      cdpPort,
      expectedUrlPrefix: `${webOrigin}/projects/${projectId}`,
    });
    await waitForEval(
      agentBrowser,
      `document.querySelector('[data-project-loro-connected]')?.getAttribute('data-project-loro-connected') === 'true'`,
      "reconnected project Loro room with durable Director Stage",
      30000,
    );
    if (!evalJson(agentBrowser, `!!document.querySelector('[data-testid="project-director-stage-editor"] canvas')`)) {
      await waitForEval(
        agentBrowser,
        `!!document.querySelector('[data-director-stage-action]')`,
        "reloaded Director Stage Action",
      );
      if (!clickByText(agentBrowser, "Open Director Stage")) {
        throw new Error("Could not reopen Director Stage after durable snapshot sync");
      }
    }
    await waitForEval(
      agentBrowser,
      `!!document.querySelector('[data-testid="project-director-stage-editor"] canvas')`,
      "reopened durable Director Stage WebGL canvas",
    );
    if (clickByAriaLabel(agentBrowser, "Collapse AI Copilot") ||
        clickByAriaLabel(agentBrowser, "Collapse chat panel")) {
      await waitForEval(
        agentBrowser,
        `!!document.querySelector('[aria-label="Expand AI Copilot"], [aria-label="Expand chat panel"]')`,
        "collapsed chat panel after durable sync",
      );
    }
    if (!clickByText(agentBrowser, "Actor 1")) throw new Error("Could not reselect the neutral Anny body");
    if (!clickByAriaLabel(agentBrowser, "Front view")) throw new Error("Could not frame the Anny body lineup");
    await sleep(600);
    const characterScaleBefore = readDirectorCanvasStats(agentBrowser);
    const projectionPath = path.join(runRoot, "director-stage-cli-projection.json");
    const beforeCli = await pullDirectorStageWithCli({
      cliPath: directorCliPath,
      projectId,
      stageId,
      projectionPath,
    });
    const actor = beforeCli.state.objects.find((object) => object.name === "Actor 1");
    if (!actor) throw new Error(`Clash CLI projection did not include Actor 1: ${JSON.stringify(beforeCli.state.objects)}`);
    if (JSON.stringify(actor.transform?.scale) !== JSON.stringify([1, 1, 1])) {
      throw new Error(`Actor 1 did not start at uniform scale 1: ${JSON.stringify(actor.transform?.scale)}`);
    }
    runClashCliJson(directorCliPath, [
      "director",
      "object",
      "update",
      "--project",
      projectId,
      "--stage",
      stageId,
      "--id",
      actor.id,
      "--sx",
      "1.25",
      "--sy",
      "1.25",
      "--sz",
      "1.25",
    ]);
    const afterCli = await pullDirectorStageWithCli({
      cliPath: directorCliPath,
      projectId,
      stageId,
      projectionPath,
    });
    const scaledActor = afterCli.state.objects.find((object) => object.id === actor.id);
    if (JSON.stringify(scaledActor?.transform?.scale) !== JSON.stringify([1.25, 1.25, 1.25])) {
      throw new Error(`Clash CLI scale readback failed: ${JSON.stringify(scaledActor?.transform?.scale)}`);
    }
    await waitForEval(
      agentBrowser,
      `document.querySelector('[role="slider"][aria-label="Character scale"]')?.getAttribute('aria-valuenow') === '125'`,
      "CLI scale synchronized into the Character inspector",
    );
    await sleep(600);
    const characterScaleAfter = readDirectorCanvasStats(agentBrowser);
    if (!characterScaleBefore?.neutralBounds || !characterScaleAfter?.neutralBounds ||
        characterScaleAfter.neutralPixels < characterScaleBefore.neutralPixels * 1.5 ||
        characterScaleAfter.neutralBounds.width < characterScaleBefore.neutralBounds.width * 1.04) {
      throw new Error(`CLI scale did not enlarge the real Anny silhouette: ${JSON.stringify({
        characterScaleBefore,
        characterScaleAfter,
      })}`);
    }
    const cliScaleProof = {
      command: `clash director object update --project ${projectId} --stage ${stageId} --id ${actor.id} --sx 1.25 --sy 1.25 --sz 1.25`,
      objectId: actor.id,
      before: actor.transform.scale,
      after: scaledActor.transform.scale,
      beforeBounds: characterScaleBefore.neutralBounds,
      afterBounds: characterScaleAfter.neutralBounds,
      neutralPixelArea: {
        before: characterScaleBefore.neutralPixels,
        after: characterScaleAfter.neutralPixels,
      },
    };
    agentBrowser(["screenshot", cliScaleScreenshot]);
    agentBrowser(["screenshot", annyBodiesScreenshot]);
    agentBrowser(["screenshot", inspectorScreenshot]);
    if (!clickByText(agentBrowser, "Pose")) throw new Error("Could not open mannequin Pose inspector");
    await waitForEval(
      agentBrowser,
      `document.querySelector('[role="switch"][aria-label="Show skeleton"]')?.getAttribute('data-state') === 'checked'`,
      "selected mannequin skeleton overlay control",
    );
    if (!clickByText(agentBrowser, "Standing")) throw new Error("Could not apply Standing preset");
    await sleep(500);
    const standingFrame = readDirectorCanvasStats(agentBrowser);
    if (!clickByText(agentBrowser, "T-pose")) throw new Error("Could not apply T-pose preset");
    await waitForEval(
      agentBrowser,
      `[...document.querySelectorAll('button[aria-pressed="true"]')].some((button) => button.textContent?.trim() === 'T-pose')`,
      "applied T-pose preset",
    );
    await sleep(500);
    const tPoseFrame = readDirectorCanvasStats(agentBrowser);
    agentBrowser(["screenshot", poseScreenshot]);
    if (!standingFrame?.neutralBounds || !tPoseFrame?.neutralBounds ||
        tPoseFrame.neutralBounds.width < standingFrame.neutralBounds.width * 1.35) {
      throw new Error(`T-pose did not widen the real Anny silhouette: ${JSON.stringify({ standingFrame, tPoseFrame })}`);
    }
    if (!clickByAriaLabel(agentBrowser, "Show skeleton")) {
      throw new Error("Could not hide the bound skeleton overlay");
    }
    await waitForEval(
      agentBrowser,
      `document.querySelector('[role="switch"][aria-label="Show skeleton"]')?.getAttribute('data-state') === 'unchecked'`,
      "hidden skeleton overlay",
    );
    await sleep(400);
    const skeletonOffFrame = readDirectorCanvasStats(agentBrowser);
    if (!clickByAriaLabel(agentBrowser, "Show skeleton")) {
      throw new Error("Could not restore the bound skeleton overlay");
    }
    await waitForEval(
      agentBrowser,
      `document.querySelector('[role="switch"][aria-label="Show skeleton"]')?.getAttribute('data-state') === 'checked'`,
      "visible skeleton overlay",
    );
    await sleep(400);
    const skeletonOnFrame = readDirectorCanvasStats(agentBrowser);
    if (!skeletonOffFrame || !skeletonOnFrame ||
        skeletonOnFrame.cyanPixels < skeletonOffFrame.cyanPixels + 30) {
      throw new Error(`Skeleton overlay did not add visible cyan rig pixels: ${JSON.stringify({ skeletonOffFrame, skeletonOnFrame })}`);
    }
    const poseProof = {
      standingBounds: standingFrame.neutralBounds,
      tPoseBounds: tPoseFrame.neutralBounds,
      skeletonCyanPixels: {
        off: skeletonOffFrame.cyanPixels,
        on: skeletonOnFrame.cyanPixels,
      },
    };
    agentBrowser(["screenshot", poseScreenshot]);
    if (setInputByAriaLabel(agentBrowser, "Joint pitch", "12") !== "12") {
      throw new Error("Could not adjust the selected rig joint");
    }
    if (!clickByText(agentBrowser, "Standing")) {
      throw new Error("Could not restore Standing before automatic locomotion");
    }
    if (!clickByText(agentBrowser, "Motion")) throw new Error("Could not open mannequin Motion inspector");
    if (!clickByText(agentBrowser, "Add position keyframe · 0.00s")) {
      throw new Error("Could not add initial mannequin position keyframe");
    }
    await waitForEval(
      agentBrowser,
      `document.querySelectorAll('[data-director-keyframe]').length === 1`,
      "initial mannequin keyframe",
    );
    if (!seekDirectorTimeline(agentBrowser, 5)) throw new Error("Could not seek Director timeline");
    await waitForEval(
      agentBrowser,
      `document.body.innerText.includes('Add position keyframe · 5.00s')`,
      "five second Director playhead",
    );
    if (!clickByText(agentBrowser, "Properties")) throw new Error("Could not open mannequin Properties inspector");
    if (setInputByAriaLabel(agentBrowser, "Position X", "2") !== "2") {
      throw new Error("Could not move mannequin for its motion path");
    }
    if (!clickByText(agentBrowser, "Motion")) throw new Error("Could not reopen mannequin Motion inspector");
    if (!clickByText(agentBrowser, "Add position keyframe · 5.00s")) {
      throw new Error("Could not add second mannequin position keyframe");
    }
    await waitForEval(
      agentBrowser,
      `document.querySelectorAll('[data-director-keyframe]').length === 2`,
      "mannequin motion path keyframes",
    );
    if (!seekDirectorTimeline(agentBrowser, 2.5)) throw new Error("Could not seek automatic walk cycle");
    await waitForEval(
      agentBrowser,
      `document.body.innerText.includes('Add position keyframe · 2.50s')`,
      "automatic walk cycle playhead",
    );
    await sleep(400);
    agentBrowser(["screenshot", autoWalkScreenshot]);
    if (!clickByAriaLabel(agentBrowser, "Action")) {
      throw new Error("Could not open the mannequin Action selector");
    }
    await waitForEval(
      agentBrowser,
      `[...document.querySelectorAll('[role="option"]')].some((option) => option.textContent?.trim() === 'Wave')`,
      "Wave action option",
    );
    if (!clickSelectOption(agentBrowser, "Wave")) throw new Error("Could not select Wave action");
    if (setInputByAriaLabel(agentBrowser, "Action duration", "2") !== "2") {
      throw new Error("Could not set the Wave action duration");
    }
    if (!clickByText(agentBrowser, "Add action at 2.50s")) {
      throw new Error("Could not add the user-authored Wave action clip");
    }
    await waitForEval(
      agentBrowser,
      `(() => {
        const clip = document.querySelector('[data-director-action-clip]');
        return clip?.textContent?.includes('Wave') && clip.textContent.includes('Upper body');
      })()`,
      "Wave upper-body action track clip",
    );
    if (!seekDirectorTimeline(agentBrowser, 3)) throw new Error("Could not seek inside the Wave action clip");
    await sleep(400);
    agentBrowser(["screenshot", layeredWaveScreenshot]);
    if (!evalJson(agentBrowser, `Boolean(document.querySelector('[data-director-action-inspector]'))`)) {
      throw new Error("Wave action clip did not remain selected in the Motion inspector");
    }
    if (!seekDirectorTimeline(agentBrowser, 5)) throw new Error("Could not restore mannequin path endpoint");
    await waitForEval(
      agentBrowser,
      `document.body.innerText.includes('Add position keyframe · 5.00s')`,
      "restored mannequin path endpoint",
    );

    if (!clickByAriaLabel(agentBrowser, "Add scene element")) {
      throw new Error("Could not reopen scene element menu");
    }
    await waitForEval(agentBrowser, `document.body.innerText.includes("Add camera")`, "camera menu item");
    if (!clickMenuItem(agentBrowser, "Add camera")) throw new Error("Could not add camera");
    await waitForEval(agentBrowser, `document.body.innerText.includes("Camera 1")`, "camera scene row");
    if (setInputByAriaLabel(agentBrowser, "Camera focal length", "24") !== "24") {
      throw new Error("Could not set the camera to a 24mm wide lens");
    }
    await waitForEval(
      agentBrowser,
      `Math.abs(Number(document.querySelector('[role="slider"][aria-label="Vertical FOV"]')?.getAttribute('aria-valuenow')) - 53.13) < 0.75`,
      "24mm lens and FOV linkage",
    );
    for (const angle of [
      { label: "Camera pitch", value: "-8" },
      { label: "Camera yaw", value: "35" },
      { label: "Camera roll", value: "3" },
    ]) {
      if (setInputByAriaLabel(agentBrowser, angle.label, angle.value) !== angle.value) {
        throw new Error(`Could not set ${angle.label}`);
      }
    }
    if (setInputByAriaLabel(agentBrowser, "Position X", "4") !== "4") {
      throw new Error("Could not stage initial camera X position");
    }
    if (setInputByAriaLabel(agentBrowser, "Position Z", "4") !== "4") {
      throw new Error("Could not stage initial camera Z position");
    }
    if (!clickByText(agentBrowser, "Add position keyframe · 5.00s")) {
      throw new Error("Could not add initial camera position keyframe");
    }
    if (!clickByText(agentBrowser, "Add angle keyframe · 5.00s")) {
      throw new Error("Could not add initial camera angle keyframe");
    }
    await waitForEval(
      agentBrowser,
      `document.querySelectorAll('[data-director-keyframe]').length === 4`,
      "initial camera position and angle keyframes",
    );
    if (!seekDirectorTimeline(agentBrowser, 8)) throw new Error("Could not seek camera motion path time");
    await waitForEval(
      agentBrowser,
      `document.body.innerText.includes('Add position keyframe · 8.00s')`,
      "eight second Director playhead",
    );
    if (setInputByAriaLabel(agentBrowser, "Position X", "-4") !== "-4") {
      throw new Error("Could not move camera for its motion path");
    }
    if (setInputByAriaLabel(agentBrowser, "Camera yaw", "-20") !== "-20") {
      throw new Error("Could not rotate camera for its angle track");
    }
    if (!clickByText(agentBrowser, "Add position keyframe · 8.00s")) {
      throw new Error("Could not add second camera position keyframe");
    }
    if (!clickByText(agentBrowser, "Add angle keyframe · 8.00s")) {
      throw new Error("Could not add second camera angle keyframe");
    }
    const motionPaths = await waitForEval(
      agentBrowser,
      `(() => {
        const keys = document.querySelectorAll('[data-director-keyframe]');
        const tracks = [...document.querySelectorAll('[data-director-track-label]')]
          .map((element) => element.getAttribute('data-director-track-label'));
        return keys.length === 6 && tracks.length === 3 ? { keyframes: keys.length, tracks } : false;
      })()`,
      "mannequin position plus camera position and angle tracks",
    );
    if (!clickByAriaLabel(agentBrowser, "Camera focus target")) {
      throw new Error("Could not open camera focus target selector");
    }
    await waitForEval(
      agentBrowser,
      `[...document.querySelectorAll('[role="option"]')].some((option) => option.textContent?.trim() === 'Actor 1')`,
      "camera target option",
    );
    if (!clickSelectOption(agentBrowser, "Actor 1")) throw new Error("Could not target Actor 1");
    await waitForEval(
      agentBrowser,
      `document.querySelector('[aria-label="Camera focus target"]')?.textContent?.includes('Actor 1')`,
      "camera focus target",
    );
    if (setInputByAriaLabel(agentBrowser, "Focus offset Y", "1.65") !== "1.65") {
      throw new Error("Could not raise the camera focus point");
    }
    await waitForEval(
      agentBrowser,
      `['Camera pitch', 'Camera yaw', 'Camera roll'].every((label) => document.querySelector('[aria-label="' + label + '"]')?.disabled)`,
      "focus-driven camera angle controls",
    );
    if (!clickByText(agentBrowser, "Camera view")) throw new Error("Could not inspect the camera lens");
    await sleep(500);
    if (setInputByAriaLabel(agentBrowser, "Camera focal length", "85") !== "85") {
      throw new Error("Could not set the portrait lens");
    }
    await waitForEval(
      agentBrowser,
      `Math.abs(Number(document.querySelector('[role="slider"][aria-label="Vertical FOV"]')?.getAttribute('aria-valuenow')) - 16.07) < 0.75`,
      "85mm portrait lens FOV",
    );
    await sleep(400);
    const portraitLensSignature = readDirectorFrameSignature(agentBrowser);
    if (setInputByAriaLabel(agentBrowser, "Camera focal length", "14") !== "14") {
      throw new Error("Could not set the ultra-wide lens");
    }
    await waitForEval(
      agentBrowser,
      `Math.abs(Number(document.querySelector('[role="slider"][aria-label="Vertical FOV"]')?.getAttribute('aria-valuenow')) - 81.2) < 0.75`,
      "14mm ultra-wide lens FOV",
    );
    await sleep(400);
    const ultraWideLensSignature = readDirectorFrameSignature(agentBrowser);
    const lensFrameDifference = signatureDifference(portraitLensSignature, ultraWideLensSignature);
    if (lensFrameDifference < 4) {
      throw new Error(`Lens changes did not alter the camera framebuffer: ${lensFrameDifference}`);
    }
    if (setInputByAriaLabel(agentBrowser, "Camera focal length", "24") !== "24") {
      throw new Error("Could not restore the final wide lens");
    }
    await sleep(400);
    agentBrowser(["screenshot", cameraLensScreenshot]);
    cameraProof = {
      focalLengthRoundTripMm: 24,
      portraitFov: 16.07,
      ultraWideFov: 81.2,
      lensFrameDifference,
      focusTarget: "Actor 1",
      focusOffset: [0, 1.65, 0],
      angleTrackKeyframes: 2,
    };
    if (!clickByText(agentBrowser, "Director view")) throw new Error("Could not return to Director view after lens proof");
    if (!clickByAriaLabel(agentBrowser, "Top view")) throw new Error("Could not select top view");
    await sleep(400);
    agentBrowser(["screenshot", motionPathScreenshot]);
    if (!clickByText(agentBrowser, "Director view")) throw new Error("Could not return to Director view");
    if (!clickByAriaLabel(agentBrowser, "Reset view")) throw new Error("Could not reset Director view");
    const beforeHorseRiderSignature = readDirectorFrameSignature(agentBrowser);
    if (!clickByAriaLabel(agentBrowser, "Add scene element")) {
      throw new Error("Could not open the Director element menu for horse and rider");
    }
    if (!clickMenuItem(agentBrowser, "Add rider + horse")) {
      throw new Error("Could not add the Director horse and rider composition");
    }
    await waitForEval(
      agentBrowser,
      `document.body.textContent.includes('Horse 1') && document.body.textContent.includes('Rider 1')`,
      "horse and rider scene objects",
    );
    await sleep(400);
    const afterHorseRiderSignature = readDirectorFrameSignature(agentBrowser);
    const horseRiderFrameDifference = signatureDifference(
      beforeHorseRiderSignature,
      afterHorseRiderSignature,
    );
    if (horseRiderFrameDifference < 1) {
      throw new Error(`Horse and rider did not alter the WebGL frame: ${horseRiderFrameDifference}`);
    }
    if (!clickByText(agentBrowser, "Horse 1")) throw new Error("Could not select the generated horse");
    await waitForEval(
      agentBrowser,
      `document.body.textContent.includes('Horse build') && document.body.textContent.includes('Gait')`,
      "horse build and gait inspector",
    );
    if (!clickByText(agentBrowser, "Rider 1")) throw new Error("Could not select the mounted rider");
    if (!clickByText(agentBrowser, "Properties")) throw new Error("Could not open mounted rider properties");
    await waitForEval(
      agentBrowser,
      `document.body.textContent.includes('Attached to Horse 1') && document.body.textContent.includes('Detach from parent')`,
      "rider saddle attachment inspector",
    );
    agentBrowser(["screenshot", horseRiderScreenshot]);
    horseRiderProof = {
      horse: "Horse 1",
      rider: "Rider 1",
      socket: "saddle",
      horseRiderFrameDifference,
    };
    if (modelFixturePath) {
      const beforeUploadedModelSignature = readDirectorFrameSignature(agentBrowser);
      agentBrowser(["upload", 'input[accept*=".glb"]', modelFixturePath]);
      const expectedModelName = path.basename(modelFixturePath);
      await waitForEval(
        agentBrowser,
        `document.body.textContent.includes(${JSON.stringify(expectedModelName)})`,
        "uploaded Director model scene object",
        30000,
      );
      await sleep(800);
      const afterUploadedModelSignature = readDirectorFrameSignature(agentBrowser);
      const uploadedModelFrameDifference = signatureDifference(
        beforeUploadedModelSignature,
        afterUploadedModelSignature,
      );
      if (uploadedModelFrameDifference < 1) {
        throw new Error(`Uploaded model did not alter the WebGL frame: ${uploadedModelFrameDifference}`);
      }
      agentBrowser(["screenshot", uploadedModelScreenshot]);
      uploadedModelProof = {
        fileName: expectedModelName,
        uploadedModelFrameDifference,
      };
    }
    if (!clickByText(agentBrowser, "Actor 1")) throw new Error("Could not reselect Actor 1 for rig verification");
    await waitForEval(
      agentBrowser,
      `document.querySelector('[aria-label="Mannequin inspector sections"]') !== null`,
      "mannequin inspector tabs",
    );
    if (!clickByText(agentBrowser, "Pose")) throw new Error("Could not reopen mannequin Pose inspector");
    await waitForEval(agentBrowser, `document.body.textContent.includes('Pose preset')`, "mannequin rig inspector");
    await sleep(400);
    agentBrowser(["screenshot", stageScreenshot]);
    if (process.env.CLASH_DIRECTOR_E2E_KEEP_OPEN === "1") {
      console.log("[director-stage-webgl] keeping the verified Director Stage open");
      await Promise.race([
        new Promise((resolve) => process.once("SIGINT", resolve)),
        new Promise((resolve) => process.once("SIGTERM", resolve)),
        new Promise((resolve) => electron.once("exit", resolve)),
      ]);
      return;
    }
    if (!clickByText(agentBrowser, "Camera view")) throw new Error("Could not select Camera view");
    await sleep(400);

    if (!clickByText(agentBrowser, "Capture shot")) throw new Error("Could not capture shot");
    await sleep(500);
    const captureSettled = await waitForEval(
      agentBrowser,
      `(() => {
        const root = document.querySelector('[data-testid="project-director-stage-editor"]');
        if (!root) return false;
        const retry = [...root.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Retry capture');
        if (retry) throw new Error('Director Stage capture entered error state');
        const button = [...root.querySelectorAll('button')].find((candidate) =>
          candidate.textContent?.trim() === 'Capture shot');
        return Boolean(button && !button.disabled);
      })()`,
      "completed Director shot capture",
      30000,
    );
    if (!captureSettled) throw new Error("Director shot capture did not settle");

    if (!clickByAriaLabel(agentBrowser, "Preview sequence")) {
      throw new Error("Could not start Director sequence preview");
    }
    await waitForEval(
      agentBrowser,
      `document.querySelector('[data-director-video-export-status="exporting"]') !== null`,
      "Director camera video recording",
    );
    await waitForEval(
      agentBrowser,
      `document.querySelector('[data-director-video-export-status="idle"]') !== null`,
      "completed Director camera video export",
      60000,
    );
    const cameraVideoStat = await stat(cameraVideoPath);
    const cameraVideoHeader = (await readFile(cameraVideoPath)).subarray(0, 4).toString("hex");
    if (cameraVideoStat.size < 1024 || cameraVideoHeader !== "1a45dfa3") {
      throw new Error(`Invalid Director camera WebM: ${cameraVideoStat.size} bytes, header ${cameraVideoHeader}`);
    }
    const cameraVideo = {
      path: cameraVideoPath,
      bytes: cameraVideoStat.size,
      header: cameraVideoHeader,
    };

    const openedCanvas = evalJson(agentBrowser, `(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) =>
        candidate.getAttribute('aria-label')?.startsWith('Open parent Canvas '));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!openedCanvas) throw new Error("Could not return to parent Canvas");
    const canvasLineage = await waitForEval(
      agentBrowser,
      `(() => {
        if (document.querySelector('[data-testid="project-director-stage-editor"]')) return false;
        const shotNode = document.querySelector('[data-id^="director-shot-image-"]');
        const panoramaNode = document.querySelector('[data-id^="director-panorama-"]');
        const actionNode = document.querySelector(${JSON.stringify(`[data-id="${actionId}"]`)});
        if (!shotNode || !actionNode || (${JSON.stringify(!skipPanorama && !panoramaFixturePath)} && !panoramaNode)) return false;
        const shotFrame = shotNode.getBoundingClientRect();
        const shotImage = shotNode.querySelector('img');
        const imageFrame = shotImage?.getBoundingClientRect();
        const shotRatio = shotFrame.width / shotFrame.height;
        const mediaFill = imageFrame ? imageFrame.height / shotFrame.height : 0;
        if (Math.abs(shotRatio - 16 / 9) > 0.08 || mediaFill < 0.9) return false;
        return {
          shotNodeId: shotNode.getAttribute('data-id'),
          panoramaNodeId: panoramaNode?.getAttribute('data-id') ?? null,
          actionNodeId: actionNode.getAttribute('data-id'),
          lineageEdges: document.querySelectorAll('.react-flow__edge').length,
          shotFrame: { width: Math.round(shotFrame.width), height: Math.round(shotFrame.height) },
          shotRatio,
          mediaFill,
        };
      })()`,
      "Director shot image and lineage on Canvas",
      30000,
    );
    agentBrowser(["screenshot", canvasScreenshot]);

    assertNoDirectorRendererErrors([...webLogs, ...electronLogs]);
    console.log("[director-stage-webgl] verified", JSON.stringify({
      projectId,
      actionId,
      stageId,
      webgl: initialWebgl,
      aiPanorama,
      cameraProof,
      horseRiderProof,
      uploadedModelProof,
      cliScaleProof,
      motionPaths,
      poseProof,
      capture: canvasLineage,
      cameraVideo,
      screenshots: {
        annyBodies: annyBodiesScreenshot,
        pose: poseScreenshot,
        autoWalk: autoWalkScreenshot,
        layeredWave: layeredWaveScreenshot,
        cliScale: cliScaleScreenshot,
        stage: stageScreenshot,
        motionPaths: motionPathScreenshot,
        cameraLens: cameraLensScreenshot,
        horseRider: horseRiderScreenshot,
        uploadedModel: modelFixturePath ? uploadedModelScreenshot : null,
        panorama: panoramaFixturePath ? panoramaScreenshot : null,
        canvas: canvasScreenshot,
      },
    }));
    verified = true;
  } catch (error) {
    agentBrowser(["screenshot", path.join(captureDir, "director-stage-failure.png")], { allowFailure: true });
    console.error("[director-stage-webgl] web logs\n" + tail(webLogs));
    console.error("[director-stage-webgl] electron logs\n" + tail(electronLogs));
    throw error;
  } finally {
    if (verified && process.env.CLASH_DIRECTOR_E2E_KEEP_OPEN === "1") {
      console.log("[director-stage-webgl] keeping the verified Director Stage open");
      await new Promise((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
    }
    agentBrowser(["close"], { allowFailure: true });
    await stopProcess(directorDaemon);
    await stopProcess(electron);
    await stopProcess(web);
  }
}

await main();
