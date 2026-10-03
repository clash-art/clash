/**
 * PR #24 VM evidence: Chrome + Vite pointed at real local-api (no Worker 401).
 * Run: CHROME_BIN=/usr/local/bin/google-chrome pnpm exec tsx apps/web/e2e/acp-consolidation-pr24-smoke.ts
 */
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadHostServer } from "./host-artifacts.ts";
import {
  CdpClient,
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

const captureDir =
  process.env.CLASH_ACP_CONSOLIDATION_CAPTURE_DIR ??
  path.join(repoRoot, ".tmp", "acp-consolidation-pr24-captures");
const dataDir =
  process.env.CLASH_ACP_CONSOLIDATION_DATA_DIR ??
  path.join(repoRoot, ".tmp", "acp-consolidation-pr24-data");
const chromeDataDir = path.join(dataDir, "chrome-profile");

const DSH_LABEL = "DeepSeek Harness";

function buttonByAriaLabelExpression(ariaLabel: string) {
  return `(() => [...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === ${JSON.stringify(ariaLabel)}))()`;
}

async function clickAriaButton(cdp: CdpClient, ariaLabel: string) {
  await click(cdp, buttonByAriaLabelExpression(ariaLabel), ariaLabel);
}

async function ensureHarnessEnabled(cdp: CdpClient, label: string) {
  const enableLabel = `Enable ${label} agent`;
  const alreadyEnabled = await evaluate<boolean>(
    cdp,
    `[...document.querySelectorAll("button")].some((button) => button.getAttribute("aria-label") === ${JSON.stringify(`Disable ${label} agent`)})`,
  );
  if (alreadyEnabled) return;
  await clickAriaButton(cdp, enableLabel);
}

async function scrollInstallButtonIntoView(cdp: CdpClient, label: string) {
  await evaluate(
    cdp,
    `(() => {
      const button = [...document.querySelectorAll("button")].find(
        (candidate) => candidate.getAttribute("aria-label") === ${JSON.stringify(`Install ${label}`)},
      );
      button?.scrollIntoView({ block: "center", inline: "nearest" });
      return !!button;
    })()`,
  );
}

async function resolveRegistryHarnessLabel(cdp: CdpClient): Promise<string> {
  await waitFor(
    cdp,
    `[...document.querySelectorAll("button")].some((button) => (button.getAttribute("aria-label") || "").startsWith("Install "))`,
    "harness install actions",
    120_000,
  );
  const preferred = process.env.CLASH_ACP_VERIFY_REGISTRY_LABEL ?? "Pi";
  for (const label of [preferred, "Pi", "Agoragentic"]) {
    const found = await evaluate<boolean>(
      cdp,
      `[...document.querySelectorAll("button")].some((button) => button.getAttribute("aria-label") === ${JSON.stringify(`Install ${label}`)})`,
    );
    if (found) return label;
  }
  const fallback = await evaluate<string | null>(
    cdp,
    `(() => {
      const skip = new Set([${JSON.stringify(DSH_LABEL)}]);
      const button = [...document.querySelectorAll("button")].find((candidate) => {
        const aria = candidate.getAttribute("aria-label") || "";
        if (!aria.startsWith("Install ")) return false;
        const name = aria.slice("Install ".length);
        return !skip.has(name);
      });
      return button ? (button.getAttribute("aria-label") || "").slice("Install ".length) : null;
    })()`,
  );
  if (fallback) return fallback;
  throw new Error(
    "No public registry harness install button found (tried Pi and Agoragentic)",
  );
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
      const text = document.body.innerText || "";
      return !install && text.includes(${JSON.stringify(label)});
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

async function waitForRuntimeAgent(
  apiOrigin: string,
  agentId: string,
  timeoutMs = 360_000,
) {
  const deadline = Date.now() + timeoutMs;
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
      if (ids.includes(agentId)) return ids;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for runtime agent ${agentId}`);
}

async function main() {
  process.env.DEEPSEEK_API_KEY =
    process.env.DEEPSEEK_API_KEY ?? "sk-fake-deepseek-test";
  process.env.PI_API_KEY = process.env.PI_API_KEY ?? "sk-fake-pi-test";

  await rm(dataDir, { recursive: true, force: true });
  await mkdir(captureDir, { recursive: true });

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
        "--window-size=1440,1000",
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

    await cdp.send("Page.navigate", {
      url: `${webOrigin}/settings?section=agents`,
    });
    await waitFor(
      cdp,
      `location.pathname === "/settings" && document.body.innerText.includes("Agents")`,
      "agents settings",
      60_000,
    );
    await capture(cdp, path.join(captureDir, "01-agents-settings-initial.png"));

    const registryLabel = await resolveRegistryHarnessLabel(cdp);
    console.log("[acp-consolidation-pr24-smoke] registry harness", registryLabel);

    await clickAriaButton(cdp, `Install ${registryLabel}`);
    await waitForHarnessInstalled(cdp, registryLabel);
    await capture(cdp, path.join(captureDir, "02-registry-harness-pi-installed.png"));

    await scrollInstallButtonIntoView(cdp, DSH_LABEL);
    await clickAriaButton(cdp, `Install ${DSH_LABEL}`);
    await waitForHarnessInstalled(cdp, DSH_LABEL);
    await waitForHarnessIdle(cdp);
    await capture(cdp, path.join(captureDir, "03-dsh-acp-installed.png"));

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
      "agents auth recheck",
      360_000,
    );
    await waitForHarnessIdle(cdp);

    for (const label of [registryLabel, DSH_LABEL]) {
      await ensureHarnessEnabled(cdp, label);
    }
    await waitForHarnessIdle(cdp);
    await capture(cdp, path.join(captureDir, "04-harnesses-enabled.png"));

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

    const runtimeAgentIds = await waitForRuntimeAgent(apiOrigin, "dsh-acp");
    console.log("[acp-consolidation-pr24-smoke] runtime agents", runtimeAgentIds);

    await cdp.send("Page.navigate", { url: `${webOrigin}/` });
    await waitFor(cdp, `document.body.innerText.includes("Home")`, "home", 120_000);
    await waitFor(
      cdp,
      `(() => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
          b.getAttribute("aria-label") === "Session runtime, harness, and model"
        );
        return !!btn && (btn.innerText || "").length > 0;
      })()`,
      "harness trigger ready",
      120_000,
    );

    for (const [idx, label] of [registryLabel, DSH_LABEL].entries()) {
      if (idx > 0) {
        await click(
          cdp,
          `(() => [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Session runtime, harness, and model"))()`,
          "harness picker",
        );
        await waitFor(
          cdp,
          `document.body.innerText.includes("DeepSeek") || document.body.innerText.includes("HARNESS")`,
          "harness menu",
          30_000,
        );
        await click(
          cdp,
          `(() => [...document.querySelectorAll("button, [role='menuitem'], [role='option'], [role='menuitemradio'], [data-value]")].find((el) => {
            const text = (el.innerText || el.textContent || "").trim();
            const value = el.getAttribute("data-value") || "";
            return text.includes("DeepSeek") || value.includes("dsh-acp");
          }))()`,
          `select ${label}`,
        );
      }
      await click(
        cdp,
        `(() => [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Start a new project" || (b.innerText||"").trim() === "Create project"))()`,
        "create project",
      );
      await waitFor(
        cdp,
        `document.querySelector('textarea, [contenteditable="true"]') !== null`,
        "composer visible",
        60_000,
      );
      await click(
        cdp,
        `(() => {
          const el = document.querySelector('textarea') ?? document.querySelector('[contenteditable="true"]');
          if (!el) return null;
          el.focus();
          if (el instanceof HTMLTextAreaElement) {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
            setter?.call(el, ${JSON.stringify(`PR24 smoke ${label}`)});
            el.dispatchEvent(new InputEvent("input", { bubbles: true }));
          } else {
            el.textContent = ${JSON.stringify(`PR24 smoke ${label}`)};
            el.dispatchEvent(new InputEvent("input", { bubbles: true }));
          }
          return el;
        })()`,
        "composer input",
      );
      await click(
        cdp,
        `(() => [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Send message" && !b.disabled))()`,
        "send message",
      );
      await waitFor(
        cdp,
        `document.body.innerText.includes("Session") || document.body.innerText.includes("Turn") || document.body.innerText.includes("Thinking") || document.body.innerText.includes(${JSON.stringify(label)})`,
        `session ${label}`,
        180_000,
      );
      await capture(
        cdp,
        path.join(
          captureDir,
          idx === 1
            ? "06-session-start-deepseek-harness.png"
            : `0${5 + idx}-session-start-${label.replace(/\s+/g, "-").toLowerCase()}.png`,
        ),
      );
      await cdp.send("Page.navigate", { url: `${webOrigin}/` });
      await waitFor(cdp, `document.body.innerText.includes("Home")`, "home reset", 120_000);
    }

    console.log("[acp-consolidation-pr24-smoke] ok", captureDir);
  } catch (error) {
    process.exitCode = 1;
    if (cdp) {
      try {
        await capture(cdp, path.join(captureDir, "failure.png"));
      } catch {
        // ignore
      }
    }
    console.error("[acp-consolidation-pr24-smoke]", error);
    console.error("[acp-consolidation-pr24-smoke] web\n", tail(webLogs));
    console.error("[acp-consolidation-pr24-smoke] chrome\n", tail(chromeLogs));
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

await main();
