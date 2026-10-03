/**
 * PR #24 VM evidence: Chrome + Vite pointed at real local-api (no Worker 401).
 * Installs public-registry Pi + dsh-acp through Settings → Agents UI.
 */
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startLocalApiServer } from "../../local-api/src/server.ts";
import {
  CdpClient,
  assert,
  capture,
  chromeBinary,
  click,
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

const REGISTRY_LABEL = "Pi";
const DSH_LABEL = "DeepSeek Harness";

function agentRowExpression(label: string) {
  return `(() => {
    const label = ${JSON.stringify(label)};
    const rows = [...document.querySelectorAll("div.grid")].filter((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width < 400 || rect.height < 40 || style.display === "none" || style.visibility === "hidden") return false;
      const text = el.innerText || el.textContent || "";
      if (!text.includes(label)) return false;
      return [...el.querySelectorAll("span")].some((span) => (span.innerText || span.textContent || "").trim() === label);
    });
    return rows[0] ?? null;
  })()`;
}

function agentRowActionExpression(label: string, action: string) {
  return `(() => {
    const row = (${agentRowExpression(label)});
    if (!row) return null;
    const action = ${JSON.stringify(action)};
    return [...row.querySelectorAll("button")].find((button) => {
      const text = (button.innerText || button.textContent || "").trim();
      const aria = button.getAttribute("aria-label") || "";
      return text === action || aria.includes(action);
    }) ?? null;
  })()`;
}

async function clickAgentAction(cdp: CdpClient, label: string, action: string) {
  await click(cdp, agentRowActionExpression(label, action), `${action} ${label}`);
}

async function waitForAgentRowIncludes(
  cdp: CdpClient,
  label: string,
  includes: string,
  description: string,
  timeoutMs = 360_000,
) {
  await waitFor(
    cdp,
    `(() => {
      const row = (${agentRowExpression(label)});
      return !!row && (row.innerText || row.textContent || "").includes(${JSON.stringify(includes)});
    })()`,
    description,
    timeoutMs,
  );
}

async function main() {
  await rm(dataDir, { recursive: true, force: true });
  await mkdir(captureDir, { recursive: true });

  const apiPort = await findFreePort(49920);
  const webPort = await findFreePort(49940);
  const cdpPort = await findFreePort(49960);
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const webOrigin = `http://127.0.0.1:${webPort}`;

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
        "about:blank",
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

    await waitForAgentRowIncludes(cdp, REGISTRY_LABEL, "Install", "Pi installable", 120_000);
    await clickAgentAction(cdp, REGISTRY_LABEL, "Install");
    await waitForAgentRowIncludes(cdp, REGISTRY_LABEL, "Uninstall", "Pi installed", 360_000);
    await capture(cdp, path.join(captureDir, "02-registry-harness-pi-installed.png"));

    await waitForAgentRowIncludes(cdp, DSH_LABEL, "Install", "dsh installable", 120_000);
    await clickAgentAction(cdp, DSH_LABEL, "Install");
    await waitForAgentRowIncludes(cdp, DSH_LABEL, "Uninstall", "dsh installed", 360_000);
    await capture(cdp, path.join(captureDir, "03-dsh-acp-installed.png"));

    await click(
      cdp,
      `(() => {
        const row = (${agentRowExpression(REGISTRY_LABEL)});
        return row?.querySelector('[role="switch"], button[role="switch"]');
      })()`,
      "enable Pi",
    );
    await click(
      cdp,
      `(() => {
        const row = (${agentRowExpression(DSH_LABEL)});
        return row?.querySelector('[role="switch"], button[role="switch"]');
      })()`,
      "enable dsh",
    );
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
      `(() => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
          (b.innerText || b.textContent || "").trim() === "Check again"
        );
        return !!btn && (btn.innerText || "").trim() === "Check again";
      })() && !document.body.innerText.includes("Checking...")`,
      "agents recheck finished",
      360_000,
    );

    await cdp.send("Page.navigate", { url: `${webOrigin}/` });
    await waitFor(cdp, `document.body.innerText.includes("Home")`, "home", 120_000);

    const runtimeRes = await fetch(
      `${apiOrigin}/api/v1/runtimes?refresh=1&probe=config`,
    );
    if (!runtimeRes.ok) {
      throw new Error(`Runtime refresh failed: HTTP ${runtimeRes.status}`);
    }
    const runtimeCheck = (await runtimeRes.json()) as {
      runtimes?: { agents?: { id: string }[] }[];
    };
    const runtimeAgentIds =
      runtimeCheck.runtimes?.[0]?.agents?.map((agent) => agent.id) ?? [];
    console.log("[acp-consolidation-pr24-smoke] runtime agents", runtimeAgentIds);
    if (!runtimeAgentIds.includes("dsh-acp")) {
      throw new Error(
        `Expected dsh-acp in runtime agents; got ${JSON.stringify(runtimeAgentIds)}`,
      );
    }

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

    for (const [idx, label] of [REGISTRY_LABEL, DSH_LABEL].entries()) {
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
        await capture(
          cdp,
          path.join(captureDir, "05b-harness-menu-dsh-selected.png"),
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
