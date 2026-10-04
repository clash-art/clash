/**
 * PR #24 post-fix verification: no false ACP updates badge after fresh Pi + DeepSeek install.
 *   pnpm --filter @clash/local-api build
 *   CHROME_BIN=/usr/local/bin/google-chrome \
 *   DEEPSEEK_API_KEY=… PI_API_KEY=… \
 *   pnpm exec tsx apps/web/e2e/acp-consolidation-pr24-updates-after-fix.ts
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadHostServer } from "./host-artifacts.ts";
import {
  CdpClient,
  assert,
  capture,
  chromeBinary,
  click,
  evaluate,
  findFreePort,
  startViteDevServer,
  stopProcess,
  tail,
  waitFor,
  waitForHttp,
  waitForTarget,
} from "../../../scripts/e2e/harness.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webDir, "..", "..");

const repoEvidenceDir = path.join(repoRoot, "docs/evidence/acp-consolidation");
const artifactEvidenceDir = "/opt/cursor/artifacts/acp-consolidation";
const captureName = "08-acp-updates-after-fix.png";

const dataDir = path.join(repoRoot, ".tmp", "acp-updates-after-fix-data");
const chromeDataDir = path.join(dataDir, "chrome-profile");

const DSH_LABEL = "DeepSeek Harness";

async function clickAriaButton(cdp: CdpClient, ariaLabel: string) {
  await click(
    cdp,
    `(() => [...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === ${JSON.stringify(ariaLabel)}))()`,
    ariaLabel,
  );
}

async function ensureHarnessEnabled(cdp: CdpClient, label: string) {
  const alreadyEnabled = await evaluate<boolean>(
    cdp,
    `[...document.querySelectorAll("button")].some((button) => button.getAttribute("aria-label") === ${JSON.stringify(`Disable ${label} agent`)})`,
  );
  if (!alreadyEnabled) {
    await clickAriaButton(cdp, `Enable ${label} agent`);
  }
}

async function waitForHarnessInstalled(
  cdp: CdpClient,
  label: string,
  timeoutMs = 360_000,
) {
  await waitFor(
    cdp,
    `(() => {
      const install = [...document.querySelectorAll("button")].find(
        (button) => button.getAttribute("aria-label") === ${JSON.stringify(`Install ${label}`)},
      );
      return !install && (document.body.innerText || "").includes(${JSON.stringify(label)});
    })()`,
    `installed ${label}`,
    timeoutMs,
  );
}

async function waitForHarnessIdle(cdp: CdpClient, timeoutMs = 360_000) {
  await waitFor(
    cdp,
    `!document.body.innerText.includes("Installing...") && !document.body.innerText.includes("Saving enablement...")`,
    "harness UI idle",
    timeoutMs,
  );
}

async function waitForRuntimeAgent(apiOrigin: string, agentId: string) {
  const deadline = Date.now() + 360_000;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${apiOrigin}/api/v1/runtimes?refresh=1&probe=config`,
    );
    if (res.ok) {
      const json = (await res.json()) as {
        runtimes?: { agents?: { id: string }[] }[];
      };
      const ids =
        json.runtimes?.[0]?.agents?.map((agent) => agent.id) ?? [];
      if (ids.includes(agentId)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for runtime agent ${agentId}`);
}

async function freshAgentsSetup(
  cdp: CdpClient,
  webOrigin: string,
  apiOrigin: string,
) {
  await cdp.send("Page.navigate", {
    url: `${webOrigin}/settings?section=agents`,
  });
  await waitFor(
    cdp,
    `location.pathname === "/settings" && document.body.innerText.includes("Agents")`,
    "agents settings",
    60_000,
  );

  await waitFor(
    cdp,
    `[...document.querySelectorAll("button")].some((button) => button.getAttribute("aria-label") === ${JSON.stringify(`Install Pi`)})`,
    "Pi installable",
    120_000,
  );
  await clickAriaButton(cdp, "Install Pi");
  await waitForHarnessInstalled(cdp, "Pi");

  await evaluate(
    cdp,
    `(() => {
      const button = [...document.querySelectorAll("button")].find(
        (candidate) => candidate.getAttribute("aria-label") === ${JSON.stringify(`Install ${DSH_LABEL}`)},
      );
      button?.scrollIntoView({ block: "center", inline: "nearest" });
      return !!button;
    })()`,
  );
  await clickAriaButton(cdp, `Install ${DSH_LABEL}`);
  await waitForHarnessInstalled(cdp, DSH_LABEL);
  await waitForHarnessIdle(cdp);

  for (const _ of [0, 1]) {
    await click(
      cdp,
      `(() => [...document.querySelectorAll("button")].find((b) => {
        const text = (b.innerText || b.textContent || "").trim();
        return text === "Check again" && !b.disabled;
      }))()`,
      "agents Check again",
    );
    await waitFor(
      cdp,
      `!document.body.innerText.includes("Checking...")`,
      "agents recheck finished",
      360_000,
    );
    await waitForHarnessIdle(cdp);
  }

  await ensureHarnessEnabled(cdp, "Pi");
  await ensureHarnessEnabled(cdp, DSH_LABEL);
  await waitForHarnessIdle(cdp);
  await waitForRuntimeAgent(apiOrigin, "dsh-acp");
}

async function assertNoFalseUpdates(apiOrigin: string) {
  const deadline = Date.now() + 120_000;
  let lastFlagged: string[] = [];
  while (Date.now() < deadline) {
    const res = await fetch(`${apiOrigin}/api/v1/local/harnesses?updates=1`);
    assert(res.ok, "harnesses updates API", res.status);
    const json = (await res.json()) as {
      harnesses?: { id: string; updateAvailable?: boolean }[];
    };
    lastFlagged =
      json.harnesses
        ?.filter((h) => h.updateAvailable === true)
        .map((h) => h.id) ?? [];
    if (lastFlagged.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert(
    false,
    "no harnesses with updateAvailable after fresh install",
    lastFlagged,
  );
}

async function waitForNoUpdatesBadge(cdp: CdpClient) {
  await waitFor(
    cdp,
    `(() => {
      const control = document.querySelector('[data-harness-update-control="true"]');
      if (!control) return true;
      const aria = control.getAttribute("aria-label") || "";
      const text = (control.innerText || control.textContent || "").trim();
      if (/1 ACP update available|2 ACP updates available/i.test(aria)) return false;
      if (/ACP updates\\s*\\n\\s*[1-9]/i.test(text)) return false;
      return true;
    })()`,
    "ACP updates badge absent or zero",
    120_000,
  );
}

async function main() {
  process.env.DEEPSEEK_API_KEY =
    process.env.DEEPSEEK_API_KEY ?? "sk-fake-deepseek-test";
  process.env.PI_API_KEY = process.env.PI_API_KEY ?? "sk-fake-pi-test";

  await rm(dataDir, { recursive: true, force: true });
  await mkdir(repoEvidenceDir, { recursive: true });
  await mkdir(artifactEvidenceDir, { recursive: true });

  const apiPort = await findFreePort(49920);
  const webPort = await findFreePort(49940);
  const cdpPort = await findFreePort(49960);
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const webOrigin = `http://127.0.0.1:${webPort}`;

  const { startLocalApiServer } = await loadHostServer();
  const apiServer = await startLocalApiServer({ port: apiPort, dataDir });
  const { child: web, logs: webLogs } = await startViteDevServer({
    webDir,
    repoRoot,
    port: webPort,
    env: {
      VITE_CLASH_API_BASE_URL: apiOrigin,
      VITE_CLASH_WS_BASE_URL: apiOrigin.replace("http:", "ws:"),
    },
  });

  let chrome: ReturnType<typeof spawn> | undefined;
  let cdp: CdpClient | undefined;
  const chromeLogs: string[] = [];

  try {
    await waitForHttp(`${apiOrigin}/health`, "local-api health");
    await waitForHttp(webOrigin, "vite web");

    chrome = spawn(
      chromeBinary(),
      [
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${chromeDataDir}`,
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1440,1200",
        webOrigin,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    chrome.stdout?.on("data", (b) => chromeLogs.push(String(b)));
    chrome.stderr?.on("data", (b) => chromeLogs.push(String(b)));

    cdp = new CdpClient(await waitForTarget(cdpPort));
    await cdp.ready();
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    await freshAgentsSetup(cdp, webOrigin, apiOrigin);

    await cdp.send("Page.navigate", { url: `${webOrigin}/` });
    await waitFor(
      cdp,
      `document.body.innerText.includes("Home")`,
      "home after install",
      120_000,
    );
    await waitForNoUpdatesBadge(cdp);
    await assertNoFalseUpdates(apiOrigin);

    const outRepo = path.join(repoEvidenceDir, captureName);
    const outArtifact = path.join(artifactEvidenceDir, captureName);
    await capture(cdp, outRepo);
    await copyFile(outRepo, outArtifact);

    console.log("[acp-updates-after-fix] ok", { outRepo, outArtifact });
  } catch (error) {
    process.exitCode = 1;
    if (cdp) {
      try {
        await capture(
          cdp,
          path.join(repoEvidenceDir, "08-acp-updates-after-fix-failure.png"),
        );
      } catch {
        // ignore
      }
    }
    console.error("[acp-updates-after-fix]", error);
    console.error("[acp-updates-after-fix] web\n", tail(webLogs));
    console.error("[acp-updates-after-fix] chrome\n", tail(chromeLogs));
    throw error;
  } finally {
    cdp?.close();
    await stopProcess(chrome);
    await stopProcess(web);
    await new Promise<void>((resolve, reject) => {
      apiServer.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

void main();
