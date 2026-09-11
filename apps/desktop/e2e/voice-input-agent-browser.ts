import path from "node:path";
import {
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
  waitForEval,
  waitForHttp,
} from "./startup-shared.ts";

const runRoot = path.join(repoRoot, ".tmp", "voice-input-desktop-smoke");
const captureDir = process.env.CLASH_E2E_VOICE_CAPTURE_DIR ?? path.join(runRoot, "screenshots");
const clashHome = process.env.CLASH_E2E_VOICE_CLASH_HOME ?? path.join(runRoot, "clash-home");
const dataDir = path.join(clashHome, "local-api");
const sessionName = `clash-voice-input-${Date.now().toString(36)}`;
const recordingScreenshot = path.join(captureDir, "01-recording.png");
const transcriptScreenshot = path.join(captureDir, "02-transcript.png");
const failureScreenshot = path.join(captureDir, "failure.png");
const transcriptText = "voice e2e transcript";

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

function clickSemanticButton(agentBrowser, accessibleName) {
  agentBrowser([
    "find",
    "role",
    "button",
    "click",
    "--name",
    accessibleName,
    "--exact",
  ]);
}

async function main() {
  await resetDirs(captureDir, clashHome);

  const webPort = await findFreePort(52100);
  const apiPort = await findFreePort(52200);
  const cdpPort = await findFreePort(52300);
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const webLogs = [];
  const electronLogs = [];
  let web;
  let electron;
  let apiServer;
  let statusProbeCount = 0;
  const transcriptionCalls = [];
  const agentBrowser = createAgentBrowser({ sessionName, captureDir });

  try {
    const {
      createConfiguredLocalAcpAdapter,
      startLocalApiServer,
    } = await import("../../local-api/dist/server.js");
    const { createLocalAudioConfigStore } = await import("../../local-api/dist/audio-config.js");

    const ttsRuntime = {
      status: async () => ({ available: false }),
      deploy: async () => undefined,
      remove: async () => undefined,
      synthesize: async () => {
        throw new Error("TTS is outside the voice input smoke");
      },
    };
    const setupAudioConfig = createLocalAudioConfigStore({
      dataDir,
      builtinStatus: async () => ({ available: true }),
      ttsRuntime,
    });
    await setupAudioConfig.updateFromRequest({
      asr_enabled: true,
      asr_provider: "builtin-funasr",
      asr_model: "iic/SenseVoiceSmall",
    });

    // Reopen the store to model a real cold process start rather than reusing
    // the status cache populated while the fixture wrote config.yaml.
    const audioConfig = createLocalAudioConfigStore({
      dataDir,
      builtinStatus: async () => {
        statusProbeCount += 1;
        return { available: true };
      },
      builtinTranscribe: async ({ file, model, language }) => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        transcriptionCalls.push({
          name: file.name,
          type: file.type,
          size: bytes.byteLength,
          model,
          language: language ?? null,
        });
        return { text: transcriptText };
      },
      ttsRuntime,
    });

    apiServer = await startLocalApiServer({
      port: apiPort,
      dataDir,
      audioConfig,
      remotePersistence: null,
      discovery: { enabled: false },
      localAcp: createConfiguredLocalAcpAdapter(
        { CLASH_E2E_STUB_ACP: "1" },
        { apiBaseUrl: apiOrigin, dataDir },
      ),
    });
    await waitForHttp(`${apiOrigin}/api/v1/local/audio/voice-input`, "voice input API");

    web = await startVite({ webPort, logs: webLogs });
    await waitForHttp(webOrigin, "Vite desktop web shell");

    electron = await startElectron({
      cdpPort,
      webOrigin,
      apiPort,
      dataDir,
      captureDir,
      logs: electronLogs,
      electronArgs: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
      env: {
        CLASH_HOME: clashHome,
        CLASH_API_BASE_URL: apiOrigin,
        CLASH_WS_BASE_URL: apiOrigin.replace("http:", "ws:"),
        CLASH_E2E_STUB_ACP: "1",
      },
    });
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, "Electron CDP");

    agentBrowser(["close"], { allowFailure: true });
    agentBrowser(["connect", String(cdpPort)]);
    await waitForEval(
      agentBrowser,
      `document.body.innerText.includes("Home") &&
        !!document.querySelector(".milkdown-chat-input [contenteditable='true']")`,
      "home voice composer",
      30_000,
    );
    await waitForEval(
      agentBrowser,
      `performance.getEntriesByName(${JSON.stringify(`${apiOrigin}/api/v1/local/audio/voice-input`)})
        .some((entry) => entry.responseEnd > 0)`,
      "prefetched voice readiness",
      10_000,
    );

    const clickStartedAt = Date.now();
    clickSemanticButton(agentBrowser, "Voice input");
    await waitForEval(
      agentBrowser,
      `!!document.querySelector("[role='region'][aria-label='Voice input']")`,
      "active voice recording controls",
      5_000,
    );
    const recordingReadyMs = Date.now() - clickStartedAt;
    if (recordingReadyMs > 1_500) {
      throw new Error(`Voice controls took ${recordingReadyMs}ms after a prefetched readiness snapshot`);
    }
    agentBrowser(["screenshot", recordingScreenshot]);

    await sleep(700);
    clickSemanticButton(agentBrowser, "Use voice transcript");
    await waitForEval(
      agentBrowser,
      `(() => {
        const editor = document.querySelector(".milkdown-chat-input [contenteditable='true']");
        return (editor?.innerText || editor?.textContent || "").includes(${JSON.stringify(transcriptText)});
      })()`,
      "transcribed voice text in the composer",
      15_000,
    );
    await waitForEval(
      agentBrowser,
      `!document.querySelector("[role='region'][aria-label='Voice input']")`,
      "recording controls dismissed after transcription",
      5_000,
    );
    agentBrowser(["screenshot", transcriptScreenshot]);

    if (transcriptionCalls.length !== 1) {
      throw new Error(`Expected one transcription request, received ${transcriptionCalls.length}`);
    }
    const [call] = transcriptionCalls;
    if (!call || call.size <= 0) throw new Error("Transcription multipart contained no audio bytes");
    if (!call.type.startsWith("audio/")) {
      throw new Error(`Transcription multipart had unexpected MIME type: ${call.type}`);
    }
    if (statusProbeCount !== 1) {
      throw new Error(`Expected one coalesced startup readiness probe, received ${statusProbeCount}`);
    }

    const evidence = {
      level: "controlled Desktop UI smoke",
      hardware: "Chromium fake microphone",
      asr: "deterministic local API fixture",
      recordingReadyMs,
      statusProbeCount,
      transcription: call,
      composerText: evalJson(
        agentBrowser,
        `document.querySelector(".milkdown-chat-input [contenteditable='true']")?.innerText || ""`,
      ),
      recordingScreenshot,
      transcriptScreenshot,
    };
    console.log("[voice-input-desktop-smoke] ok", JSON.stringify(evidence, null, 2));
  } catch (error) {
    try {
      agentBrowser(["screenshot", failureScreenshot], { allowFailure: true });
      console.error(`[voice-input-desktop-smoke] failure screenshot ${failureScreenshot}`);
    } catch {
      // Ignore screenshot failure while unwinding.
    }
    console.error("[voice-input-desktop-smoke] web logs\n" + tail(webLogs));
    console.error("[voice-input-desktop-smoke] electron logs\n" + tail(electronLogs));
    throw error;
  } finally {
    agentBrowser(["close"], { allowFailure: true });
    await stopProcess(electron);
    await stopProcess(web);
    await closeServer(apiServer);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
