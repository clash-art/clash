/**
 * PR #24 evidence: Electron Settings → Agents installs (registry + dsh-acp).
 * Uses the same Electron bootstrap as agent-browser-smoke (embedded local-api).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  clickButtonByLabel,
  createAgentBrowser,
  evalJson,
  findFreePort,
  repoRoot,
  startVite,
  stopProcess,
  tail,
  waitForEval,
  waitForHttp,
} from "./startup-shared.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const desktopDir = path.resolve(__dirname, "..");

const captureDir =
  process.env.CLASH_ACP_CONSOLIDATION_CAPTURE_DIR ??
  path.join(repoRoot, ".tmp", "acp-consolidation-captures");
const dataDir =
  process.env.CLASH_ACP_CONSOLIDATION_DATA_DIR ??
  path.join(repoRoot, ".tmp", "acp-consolidation-data");
const sessionName = `acp-consolidation-${Date.now().toString(36)}`;

const REGISTRY_LABEL = process.env.CLASH_ACP_VERIFY_REGISTRY_LABEL ?? "Pi";
const DSH_LABEL = "DeepSeek Harness";

function shot(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  name: string,
) {
  const file = path.join(captureDir, `${name}.png`);
  agentBrowser(["screenshot", file]);
  console.log(`[acp-consolidation-verify] screenshot ${file}`);
  return file;
}

async function waitForHarnessInstalled(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  label: string,
  timeoutMs = 360_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await evalJson(
      agentBrowser,
      `(() => {
        const install = [...document.querySelectorAll("button")].find((b) =>
          b.getAttribute("aria-label") === ${JSON.stringify(`Install ${label}`)}
        );
        const row = (document.body.innerText || "");
        return !install && row.includes(${JSON.stringify(label)});
      })()`,
    );
    if (ok) return;
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error(`Install did not finish for ${label}`);
}

async function main() {
  if (
    !spawnSync("agent-browser", ["--help"], { encoding: "utf8" }).stdout.includes(
      "agent-browser",
    )
  ) {
    throw new Error("agent-browser CLI is not available");
  }

  await rm(dataDir, { recursive: true, force: true });
  await rm(captureDir, { recursive: true, force: true });
  await mkdir(captureDir, { recursive: true });

  const webPort = await findFreePort(49870);
  const apiPort = await findFreePort(49920);
  const cdpPort = await findFreePort(49970);
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const webLogs: string[] = [];
  const electronLogs: string[] = [];
  const agentBrowser = createAgentBrowser({ sessionName, captureDir });
  const screenshots: string[] = [];
  let web: Awaited<ReturnType<typeof startVite>> | undefined;
  let electron: ReturnType<typeof spawn> | undefined;

  try {
    web = await startVite({ webPort, logs: webLogs });
    await waitForHttp(webOrigin, "Vite desktop web shell", 120_000);

    const electronBin = require("electron") as string;
    electron = spawn(
      electronBin,
      [`--remote-debugging-port=${cdpPort}`, desktopDir],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CLASH_WEB_URL: webOrigin,
          CLASH_LOCAL_DATA_DIR: dataDir,
          CLASH_LOCAL_API_PORT: String(apiPort),
          CLASH_DESKTOP_CAPTURE_DIR: captureDir,
          CLASH_DESKTOP_HOST_STARTUP_TIMEOUT_MS: "120000",
          CLASH_DESKTOP_SOURCE_HOST_WATCH: "0",
          CLASH_NODE_EXEC_PATH: process.execPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    electron.stdout?.on("data", (buf) => {
      const text = String(buf);
      electronLogs.push(text);
      process.stdout.write(text);
    });
    electron.stderr?.on("data", (buf) => {
      const text = String(buf);
      electronLogs.push(text);
      process.stderr.write(text);
    });

    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, "Electron CDP", 120_000);
    agentBrowser(["close"], { allowFailure: true });
    agentBrowser(["connect", String(cdpPort)]);
    await waitForEval(
      agentBrowser,
      'document.body.innerText.includes("Home")',
      "home",
      180_000,
    );
    screenshots.push(shot(agentBrowser, "01-home"));

    await evalJson(
      agentBrowser,
      `(() => {
        document.querySelector('.clash-project-sidebar-footer [aria-label="Settings"]')?.click();
        return location.pathname === "/settings" || true;
      })()`,
    );
    await waitForEval(
      agentBrowser,
      'location.pathname === "/settings"',
      "settings",
      60_000,
    );
    await evalJson(
      agentBrowser,
      `(() => {
        const tab = [...document.querySelectorAll('[role="tab"]')].find((t) => (t.textContent||"").trim()==="Agents");
        tab?.click();
        return !!tab;
      })()`,
    );
    await waitForEval(
      agentBrowser,
      `document.body.innerText.includes(${JSON.stringify(REGISTRY_LABEL)})`,
      "agents tab",
      60_000,
    );
    screenshots.push(shot(agentBrowser, "02-agents-before-install"));

    clickButtonByLabel(agentBrowser, `Install ${REGISTRY_LABEL}`);
    await waitForHarnessInstalled(agentBrowser, REGISTRY_LABEL);
    screenshots.push(shot(agentBrowser, "03-registry-harness-installed"));

    clickButtonByLabel(agentBrowser, `Install ${DSH_LABEL}`);
    await waitForHarnessInstalled(agentBrowser, DSH_LABEL);
    screenshots.push(shot(agentBrowser, "04-dsh-acp-installed"));

    for (const label of [REGISTRY_LABEL, DSH_LABEL]) {
      clickButtonByLabel(agentBrowser, `Enable ${label} agent`);
      await new Promise((r) => setTimeout(r, 1500));
    }
    screenshots.push(shot(agentBrowser, "05-harnesses-enabled"));

    await evalJson(agentBrowser, `(() => { location.assign("/"); return true; })()`);
    await waitForEval(agentBrowser, 'document.body.innerText.includes("Home")', "home-2", 120_000);

    for (const [i, label] of [REGISTRY_LABEL, DSH_LABEL].entries()) {
      await evalJson(
        agentBrowser,
        `(() => {
          const ta = document.querySelector('textarea[aria-label="Message"], textarea');
          if (!ta) return false;
          ta.focus();
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
          setter?.call(ta, ${JSON.stringify(`Smoke ${label}`)});
          ta.dispatchEvent(new InputEvent("input", { bubbles: true }));
          return true;
        })()`,
      );
      clickButtonByLabel(agentBrowser, "Send");
      await waitForEval(
        agentBrowser,
        `document.body.innerText.includes("Session") || document.body.innerText.includes("Turn") || document.body.innerText.includes(${JSON.stringify(label)})`,
        `session ${label}`,
        180_000,
      );
      screenshots.push(shot(agentBrowser, `0${6 + i}-session-start-${label.replace(/\s+/g, "-").toLowerCase()}`));
    }

    console.log("[acp-consolidation-verify] ok", JSON.stringify({ screenshots }));
  } catch (error) {
    try {
      screenshots.push(shot(agentBrowser, "failure"));
    } catch {
      // ignore
    }
    console.error("[acp-consolidation-verify]", error);
    console.error("[acp-consolidation-verify] web", tail(webLogs));
    console.error("[acp-consolidation-verify] electron", tail(electronLogs));
    process.exitCode = 1;
  } finally {
    agentBrowser(["close"], { allowFailure: true });
    await stopProcess(electron);
    await stopProcess(web);
  }
}

await main();
