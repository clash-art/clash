/**
 * PR #24 evidence captures (DeepSeek harness session + ACP updates popover).
 * Run after `pnpm --filter @clash/local-api build`:
 *   CHROME_BIN=/usr/local/bin/google-chrome \
 *   DEEPSEEK_API_KEY=… PI_API_KEY=… \
 *   pnpm exec tsx apps/web/e2e/acp-consolidation-pr24-evidence.ts
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
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

const repoEvidenceDir = path.join(repoRoot, "docs/evidence/acp-consolidation");
const artifactEvidenceDir = "/opt/cursor/artifacts/acp-consolidation";

const captureDir =
  process.env.CLASH_ACP_CONSOLIDATION_CAPTURE_DIR ?? repoEvidenceDir;
const dataDir =
  process.env.CLASH_ACP_CONSOLIDATION_DATA_DIR ??
  path.join(repoRoot, ".tmp", "acp-consolidation-pr24-data");
const chromeDataDir = path.join(dataDir, "chrome-profile");

const DSH_LABEL = "DeepSeek Harness";
const DSH_PROMPT = "Reply with exactly: DeepSeek harness OK.";

const HARNESS_PICKER_ARIA = "Session runtime, harness, and model";

function harnessPickerExpression() {
  return `(() => [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === ${JSON.stringify(HARNESS_PICKER_ARIA)}))()`;
}

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

async function agentsSetup(
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

  const installPiIfNeeded = async () => {
    const canInstall = await evaluate<boolean>(
      cdp,
      `[...document.querySelectorAll("button")].some((button) => button.getAttribute("aria-label") === ${JSON.stringify(`Install Pi`)})`,
    );
    if (!canInstall) return;
    await clickAriaButton(cdp, "Install Pi");
    await waitForHarnessInstalled(cdp, "Pi");
  };

  await waitFor(
    cdp,
    `[...document.querySelectorAll("button")].some((button) => {
      const aria = button.getAttribute("aria-label") || "";
      return aria === ${JSON.stringify(`Install Pi`)} ||
        aria === ${JSON.stringify(`Upgrade Pi`)} ||
        aria === ${JSON.stringify(`Disable Pi agent`)};
    })`,
    "Pi row visible",
    120_000,
  );
  await installPiIfNeeded();

  const installDshIfNeeded = async () => {
    const canInstall = await evaluate<boolean>(
      cdp,
      `[...document.querySelectorAll("button")].some((button) => button.getAttribute("aria-label") === ${JSON.stringify(`Install ${DSH_LABEL}`)})`,
    );
    if (!canInstall) return;
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
  };

  await waitFor(
    cdp,
    `[...document.querySelectorAll("button")].some((button) => {
      const aria = button.getAttribute("aria-label") || "";
      return aria === ${JSON.stringify(`Install ${DSH_LABEL}`)} ||
        aria === ${JSON.stringify(`Upgrade ${DSH_LABEL}`)} ||
        aria === ${JSON.stringify(`Disable ${DSH_LABEL} agent`)};
    })`,
    "DeepSeek harness row visible",
    120_000,
  );
  await installDshIfNeeded();
  await waitForHarnessIdle(cdp);

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

  await ensureHarnessEnabled(cdp, "Pi");
  await ensureHarnessEnabled(cdp, DSH_LABEL);
  await waitForHarnessIdle(cdp);

  await click(
    cdp,
    `(() => [...document.querySelectorAll("button")].find((b) => {
      const text = (b.innerText || b.textContent || "").trim();
      return text === "Check again" && !b.disabled;
    }))()`,
    "agents Check again final",
  );
  await waitFor(
    cdp,
    `!document.body.innerText.includes("Checking...")`,
    "agents recheck finished",
    360_000,
  );

  await waitForRuntimeAgent(apiOrigin, "dsh-acp");
}

async function selectDeepSeekHarness(cdp: CdpClient) {
  await click(cdp, harnessPickerExpression(), "harness picker");
  await waitFor(
    cdp,
    `document.body.innerText.includes("DeepSeek") || document.body.innerText.includes("dsh-acp")`,
    "harness menu open",
    30_000,
  );
  await capture(
    cdp,
    path.join(captureDir, "06a-harness-menu-deepseek-visible.png"),
  );
  await click(
    cdp,
    `(() => [...document.querySelectorAll("button, [role='menuitem'], [role='option'], [role='menuitemradio'], [data-value]")].find((el) => {
      const text = (el.innerText || el.textContent || "").trim();
      const value = el.getAttribute("data-value") || "";
      return text.includes("DeepSeek") || value.includes("dsh-acp");
    }))()`,
    "select DeepSeek harness",
  );
  await waitFor(
    cdp,
    `(() => {
      const btn = (${harnessPickerExpression()});
      const text = btn ? (btn.innerText || btn.textContent || "") : "";
      return text.includes("DeepSeek") || text.includes("dsh");
    })()`,
    "harness trigger shows DeepSeek",
    30_000,
  );
  await capture(
    cdp,
    path.join(captureDir, "06b-harness-picker-deepseek-selected.png"),
  );
}

const MILKDOWN_EDITOR_EXPR = `document.querySelector(".milkdown-chat-input .ProseMirror[contenteditable='true']") ?? document.querySelector(".ProseMirror[contenteditable='true']")`;

async function typeHeroPrompt(cdp: CdpClient, text: string) {
  await click(cdp, `(() => ${MILKDOWN_EDITOR_EXPR})()`, "milkdown editor");
  await cdp.send("Input.insertText", { text });
  const sendEnabledExpr = `(() => {
      const send = document
        .querySelector(".clash-home-hero .clash-chat-input-surface, .clash-chat-input-surface")
        ?.querySelector("button[aria-label='Send message']");
      return !!send && !send.disabled;
    })()`;
  try {
    await waitFor(cdp, sendEnabledExpr, "send message enabled", 8_000);
    return;
  } catch {
    // Milkdown sometimes ignores insertText; fall back to per-character key events.
    await click(cdp, `(() => ${MILKDOWN_EDITOR_EXPR})()`, "milkdown editor refocus");
    for (const char of text) {
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        text: char,
        key: char,
        unmodifiedText: char,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "char",
        text: char,
        unmodifiedText: char,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        text: char,
        key: char,
        unmodifiedText: char,
      });
    }
    await waitFor(cdp, sendEnabledExpr, "send message enabled", 45_000);
  }
}

async function clickSend(cdp: CdpClient) {
  await click(
    cdp,
    `(() => [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Send message" && !b.disabled))()`,
    "Send message",
  );
}

async function openProjectSessionFromHome(cdp: CdpClient, webOrigin: string) {
  try {
    await waitFor(
      cdp,
      `location.pathname.startsWith("/projects/")`,
      "project session route",
      60_000,
    );
    return;
  } catch {
    const projectPath = await evaluate<string | null>(
      cdp,
      `(() => {
        const link = [...document.querySelectorAll("a")].find((anchor) => {
          if (!anchor.pathname.startsWith("/projects/")) return false;
          const text = (anchor.innerText || anchor.textContent || "").trim();
          return text.includes(${JSON.stringify(DSH_PROMPT.slice(0, 20))});
        });
        return link ? link.pathname : null;
      })()`,
    );
    if (!projectPath) {
      throw new Error("Home composer created no navigable project link");
    }
    const prompt = encodeURIComponent(DSH_PROMPT);
    await cdp.send("Page.navigate", {
      url: `${webOrigin}${projectPath}?prompt=${prompt}`,
    });
    await waitFor(
      cdp,
      `location.pathname.startsWith("/projects/")`,
      "project session route (fallback navigate)",
      120_000,
    );
  }
}

async function waitForDeepSeekSessionReply(cdp: CdpClient) {
  await waitFor(
    cdp,
    `(() => {
      const bodies = [...document.querySelectorAll('[data-testid="acp-assistant-body"]')];
      const assistantText = bodies.map((el) => (el.textContent || "").trim()).join(" ");
      const hasAssistant = assistantText.length >= 3;
      const hasHarness =
        (document.body.innerText || "").includes("DeepSeek") ||
        (document.body.innerText || "").includes("dsh-acp");
      const picker = (${harnessPickerExpression()});
      const pickerText = picker ? (picker.innerText || picker.textContent || "") : "";
      const pickerShowsDsh =
        pickerText.includes("DeepSeek") || pickerText.includes("dsh");
      return hasAssistant && hasHarness && pickerShowsDsh;
    })()`,
    "DeepSeek assistant reply visible",
    300_000,
  );
}

async function captureAcpUpdatesExpanded(cdp: CdpClient) {
  const panelOpen = await evaluate<boolean>(
    cdp,
    `(() => [...document.querySelectorAll("[role='dialog']")].some((el) =>
      (el.innerText || "").includes("A newer local runtime is ready"),
    ))()`,
  );
  if (!panelOpen) {
    await click(
      cdp,
      `(() => document.querySelector('[data-harness-update-control="true"]'))()`,
      "ACP updates control",
    );
  }
  await waitFor(
    cdp,
    `(() => {
      const dialog = [...document.querySelectorAll("[role='dialog']")].find((el) =>
        (el.innerText || "").includes("A newer local runtime is ready"),
      );
      return !!dialog;
    })()`,
    "ACP updates panel",
    30_000,
  );
  await capture(
    cdp,
    path.join(captureDir, "07-acp-updates-expanded.png"),
  );
}

async function publishEvidence(filename: string) {
  await mkdir(repoEvidenceDir, { recursive: true });
  await mkdir(artifactEvidenceDir, { recursive: true });
  const source = path.join(captureDir, filename);
  await copyFile(source, path.join(repoEvidenceDir, filename));
  await copyFile(source, path.join(artifactEvidenceDir, filename));
}

async function main() {
  process.env.DEEPSEEK_API_KEY =
    process.env.DEEPSEEK_API_KEY ?? "sk-fake-deepseek-test";
  process.env.PI_API_KEY = process.env.PI_API_KEY ?? "sk-fake-pi-test";
  process.env.CLASH_E2E_DSH_ECHO = "1";

  if (process.env.CLASH_ACP_REUSE_DATA !== "1") {
    await rm(dataDir, { recursive: true, force: true });
  }
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

  const published: string[] = [];

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
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });

    await agentsSetup(cdp, webOrigin, apiOrigin);

    await cdp.send("Page.navigate", { url: `${webOrigin}/` });
    await waitFor(cdp, `document.body.innerText.includes("Home")`, "home", 120_000);
    await waitFor(
      cdp,
      `!!(${harnessPickerExpression()})`,
      "harness picker on home",
      120_000,
    );

    await selectDeepSeekHarness(cdp);
    await typeHeroPrompt(cdp, DSH_PROMPT);
    await clickSend(cdp);
    await openProjectSessionFromHome(cdp, webOrigin);
    await waitForDeepSeekSessionReply(cdp);

    await capture(
      cdp,
      path.join(captureDir, "06-session-start-deepseek-harness.png"),
    );

    await captureAcpUpdatesExpanded(cdp);

    for (const name of [
      "06a-harness-menu-deepseek-visible.png",
      "06b-harness-picker-deepseek-selected.png",
      "06-session-start-deepseek-harness.png",
      "07-acp-updates-expanded.png",
    ]) {
      await publishEvidence(name);
      published.push(path.join(repoEvidenceDir, name));
      published.push(path.join(artifactEvidenceDir, name));
    }

    console.log("[acp-consolidation-pr24-evidence] ok", { published });
  } catch (error) {
    process.exitCode = 1;
    if (cdp) {
      try {
        await capture(cdp, path.join(captureDir, "failure.png"));
        await publishEvidence("failure.png").catch(() => undefined);
      } catch {
        // ignore
      }
    }
    console.error("[acp-consolidation-pr24-evidence]", error);
    console.error("[acp-consolidation-pr24-evidence] web\n", tail(webLogs));
    console.error("[acp-consolidation-pr24-evidence] chrome\n", tail(chromeLogs));
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
