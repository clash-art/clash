#!/usr/bin/env node
/**
 * Capture real Electron tab-state evidence for PR #25.
 * Usage:
 *   CLASH_TAB_EVIDENCE_PHASE=before|after tsx scripts/capture-interactive-tab-evidence.ts
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clickButtonByLabel,
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
  waitForEval,
  waitForHttp,
} from "../apps/desktop/e2e/startup-shared.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const phase = process.env.CLASH_TAB_EVIDENCE_PHASE ?? "after";
const outDir =
  process.env.CLASH_TAB_EVIDENCE_DIR ??
  "/cursor/stores/bc-8af30c89-1c8d-5944-9e50-08179bf783ab/media/interactive-state-styling";

const runRoot = path.join(repoRoot, ".tmp", "interactive-tab-evidence");
const dataDir = path.join(runRoot, "data");
const captureDir = path.join(runRoot, "captures");
const sessionName = `tab-evidence-${phase}-${Date.now().toString(36)}`;

function outFile(surface: string, theme: string, state: string) {
  return path.join(outDir, `${phase}-${surface}-${theme}-${state}.png`);
}

function clickVisibleText(agentBrowser: ReturnType<typeof createAgentBrowser>, text: string) {
  return evalJson(agentBrowser, `(() => {
    const wanted = ${JSON.stringify(text)};
    const el = [...document.querySelectorAll("a, button, [role='button'], [role='tab']")].find((candidate) => {
      const value = (candidate.innerText || candidate.textContent || "").trim();
      const rect = candidate.getBoundingClientRect();
      const style = getComputedStyle(candidate);
      return value === wanted &&
        rect.width > 0 && rect.height > 0 &&
        style.display !== "none" && style.visibility !== "hidden" &&
        !candidate.disabled;
    });
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    el.click();
    return true;
  })()`);
}

function clickNavigatorTab(agentBrowser: ReturnType<typeof createAgentBrowser>, label: string) {
  return evalJson(agentBrowser, `(() => {
    const wanted = ${JSON.stringify(label)};
    const root = document.querySelector('[aria-label="Project navigator"]');
    if (!root) return false;
    const tab = [...root.querySelectorAll('[role="tab"]')].find((candidate) => {
      const value = (candidate.innerText || candidate.textContent || "").trim();
      return value === wanted || value.includes(wanted);
    });
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
}

function hoverNavigatorTab(agentBrowser: ReturnType<typeof createAgentBrowser>, label: string) {
  return evalJson(agentBrowser, `(() => {
    const wanted = ${JSON.stringify(label)};
    const root = document.querySelector('[aria-label="Project navigator"]');
    const tab = [...(root?.querySelectorAll('[role="tab"]') ?? [])].find((candidate) => {
      const value = (candidate.innerText || candidate.textContent || "").trim();
      return value === wanted || value.includes(wanted);
    });
    if (!tab) return false;
    tab.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    tab.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    return true;
  })()`);
}

async function focusNavigatorTabWithArrows(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  label: string,
) {
  agentBrowser(["click", '[aria-label="Project navigator"] [role="tab"]']);
  for (let i = 0; i < 12; i += 1) {
    const focused = evalJson(agentBrowser, `(() => {
      const active = document.activeElement;
      const text = (active?.innerText || active?.textContent || "").trim();
      return text.includes(${JSON.stringify(label)});
    })()`);
    if (focused) return true;
    agentBrowser(["press", "ArrowDown"]);
    await sleep(80);
  }
  return false;
}

function setTheme(agentBrowser: ReturnType<typeof createAgentBrowser>, theme: "light" | "dark") {
  evalJson(agentBrowser, `(() => {
    const dark = ${theme === "dark"};
    document.documentElement.classList.toggle("dark", dark);
    try { localStorage.setItem("clash.appearance", ${JSON.stringify(theme)}); } catch {}
    return document.documentElement.classList.contains("dark") === dark;
  })()`);
}

function movePointerAway(agentBrowser: ReturnType<typeof createAgentBrowser>) {
  evalJson(agentBrowser, `(() => {
    document.body.dispatchEvent(new MouseEvent("mousemove", { clientX: 8, clientY: 8, bubbles: true }));
    return true;
  })()`);
}

async function screenshot(agentBrowser: ReturnType<typeof createAgentBrowser>, target: string) {
  agentBrowser(["screenshot", target]);
}

async function captureNavigatorStates(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  theme: "light" | "dark",
  tabA: string,
  tabB: string,
) {
  setTheme(agentBrowser, theme);
  await sleep(400);
  clickNavigatorTab(agentBrowser, tabA);
  await sleep(350);
  await screenshot(agentBrowser, outFile("navigator", theme, "selected-rest"));
  clickNavigatorTab(agentBrowser, tabB);
  await sleep(350);
  movePointerAway(agentBrowser);
  await sleep(200);
  await screenshot(agentBrowser, outFile("navigator", theme, "previous-tab-mouse-away"));
  hoverNavigatorTab(agentBrowser, tabA);
  await sleep(250);
  await screenshot(agentBrowser, outFile("navigator", theme, "hover-inactive"));
  await focusNavigatorTabWithArrows(agentBrowser, tabA);
  await sleep(250);
  await screenshot(agentBrowser, outFile("navigator", theme, "focus-visible"));
}

async function captureTopNavStates(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  theme: "light" | "dark",
  tabA: string,
  tabB: string,
) {
  setTheme(agentBrowser, theme);
  await sleep(400);
  clickVisibleText(agentBrowser, tabA);
  await sleep(500);
  await screenshot(agentBrowser, outFile("topnav", theme, "selected-rest"));
  clickVisibleText(agentBrowser, tabB);
  await sleep(500);
  movePointerAway(agentBrowser);
  await sleep(200);
  await screenshot(agentBrowser, outFile("topnav", theme, "previous-tab-mouse-away"));
  evalJson(agentBrowser, `(() => {
    const tabs = [...document.querySelectorAll('[data-desktop-workspace-tab="true"] [role="tab"]')];
    const inactive = tabs.find((t) => t.getAttribute('aria-selected') !== 'true');
    inactive?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    return !!inactive;
  })()`);
  await sleep(250);
  await screenshot(agentBrowser, outFile("topnav", theme, "hover-inactive"));
  agentBrowser(["click", '[aria-label="Open workspaces"] [role="tab"]']);
  for (let i = 0; i < 8; i += 1) agentBrowser(["press", "ArrowRight"]);
  await sleep(250);
  await screenshot(agentBrowser, outFile("topnav", theme, "focus-visible"));
}

function clickDirectorInspectorTab(agentBrowser: ReturnType<typeof createAgentBrowser>, label: string) {
  return evalJson(agentBrowser, `(() => {
    const wanted = ${JSON.stringify(label)};
    const root = document.querySelector('[aria-label="Mannequin inspector sections"]');
    const tab = [...(root?.querySelectorAll('[role="tab"]') ?? [])].find((candidate) => {
      const value = (candidate.innerText || candidate.textContent || "").trim();
      return value === wanted;
    });
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
}

function hoverDirectorInspectorTab(agentBrowser: ReturnType<typeof createAgentBrowser>, label: string) {
  return evalJson(agentBrowser, `(() => {
    const wanted = ${JSON.stringify(label)};
    const root = document.querySelector('[aria-label="Mannequin inspector sections"]');
    const tab = [...(root?.querySelectorAll('[role="tab"]') ?? [])].find((candidate) => {
      const value = (candidate.innerText || candidate.textContent || "").trim();
      return value === wanted;
    });
    if (!tab) return false;
    tab.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    tab.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    return true;
  })()`);
}

async function prepareDirectorInspectorTabs(agentBrowser: ReturnType<typeof createAgentBrowser>) {
  if (!clickButtonByLabel(agentBrowser, "Add scene element")) {
    throw new Error("Director Add scene element control missing");
  }
  await sleep(350);
  if (!clickVisibleText(agentBrowser, "Add editable actor")) {
    throw new Error("Director Add editable actor menu item missing");
  }
  await waitForEval(
    agentBrowser,
    `!!document.querySelector('[aria-label="Mannequin inspector sections"] [role="tab"]')`,
    "mannequin inspector tabs",
    20000,
  );
}

async function captureDirectorInspectorStates(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  theme: "light" | "dark",
) {
  setTheme(agentBrowser, theme);
  await sleep(400);
  clickDirectorInspectorTab(agentBrowser, "Properties");
  await sleep(300);
  await screenshot(agentBrowser, outFile("director", theme, "selected-rest"));
  clickDirectorInspectorTab(agentBrowser, "Pose");
  await sleep(300);
  movePointerAway(agentBrowser);
  await sleep(200);
  await screenshot(agentBrowser, outFile("director", theme, "previous-tab-mouse-away"));
  hoverDirectorInspectorTab(agentBrowser, "Properties");
  await sleep(250);
  await screenshot(agentBrowser, outFile("director", theme, "hover-inactive"));
  agentBrowser(["click", '[aria-label="Mannequin inspector sections"] [role="tab"]']);
  for (let i = 0; i < 6; i += 1) agentBrowser(["press", "ArrowRight"]);
  await sleep(250);
  await screenshot(agentBrowser, outFile("director", theme, "focus-visible"));
}

async function waitForCdpPageTarget(
  cdpPort: number,
  expectedUrlPrefix: string,
  timeoutMs = 65_000,
) {
  const url = `http://127.0.0.1:${cdpPort}/json/list`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        const targets = (await res.json()) as Array<{
          type?: string;
          url?: string;
          webSocketDebuggerUrl?: string;
        }>;
        const page = targets.find(
          (target) =>
            target.type === "page" &&
            typeof target.url === "string" &&
            target.url.startsWith(expectedUrlPrefix),
        );
        if (page) return;
      }
    } catch {
      // Electron may expose CDP before the window navigates.
    }
    await sleep(250);
  }
  throw new Error(`Electron page target did not navigate to ${expectedUrlPrefix}`);
}

async function main() {
  ensureAgentBrowser();
  process.env.CLASH_E2E_STUB_ACP = "1";
  await resetDirs(dataDir, captureDir);
  await mkdir(outDir, { recursive: true });

  const webPort = await findFreePort(50100);
  const apiPort = await findFreePort(50150);
  const cdpPort = await findFreePort(50200);
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const webLogs: string[] = [];
  const electronLogs: string[] = [];
  const agentBrowser = createAgentBrowser({ sessionName, captureDir });
  let web: Awaited<ReturnType<typeof startVite>> | undefined;
  let electron: Awaited<ReturnType<typeof startElectron>> | undefined;

  try {
    web = await startVite({ webPort, logs: webLogs });
    await waitForHttp(webOrigin, "desktop web shell");
    electron = await startElectron({
      cdpPort,
      webOrigin,
      apiPort,
      dataDir,
      captureDir,
      logs: electronLogs,
      env: {
        CLASH_E2E_STUB_ACP: "1",
        CLASH_DESKTOP_HOST_STARTUP_TIMEOUT_MS: "120000",
        CLASH_DESKTOP_SOURCE_HOST_WATCH: "0",
      },
    });
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, "Electron CDP");
    await waitForCdpPageTarget(cdpPort, `${webOrigin}/`);
    const recovery = { cdpPort, expectedUrlPrefix: `${webOrigin}/` };
    recoverAgentBrowserTarget(agentBrowser, recovery);
    await waitForEval(agentBrowser, `document.body.innerText.includes("Home")`, "home page", 90000);
    await waitForEval(
      agentBrowser,
      `(() => window.__CLASH_RUNTIME_CONFIG__?.apiBaseUrl ? window.__CLASH_RUNTIME_CONFIG__ : false)()`,
      "Electron desktop runtime config",
      60000,
    );

    if (!clickVisibleText(agentBrowser, "Projects")) throw new Error("Projects link missing");
    await waitForEval(agentBrowser, `location.pathname === "/projects"`, "projects route");
    if (!clickVisibleText(agentBrowser, "New Project")) throw new Error("New Project missing");
    await submitProjectCreateDialog(agentBrowser, "Tab Evidence Project");
    await waitForEval(
      agentBrowser,
      `location.pathname.startsWith("/projects/") && location.pathname !== "/projects"`,
      "project editor",
      60000,
    );
    await waitForEval(
      agentBrowser,
      `document.querySelector('[data-project-loro-connected]')?.getAttribute('data-project-loro-connected') === 'true'`,
      "project Loro room connection",
      60000,
    );

    if (!clickButtonByLabel(agentBrowser, "New Timeline")) {
      throw new Error("Could not create timeline for navigator/topnav tabs");
    }
    agentBrowser(["fill", '[role="dialog"] input', "Evidence Timeline"]);
    agentBrowser(["click", '[role="dialog"] button[type="submit"]']);
    await waitForEval(
      agentBrowser,
      `document.body.innerText.includes("Evidence Timeline")`,
      "timeline created",
      20000,
    );

    if (!clickButtonByLabel(agentBrowser, "New Director Stage")) {
      throw new Error("Could not create director stage");
    }
    agentBrowser(["fill", '[role="dialog"] input', "Evidence Director"]);
    agentBrowser(["click", '[role="dialog"] button[type="submit"]']);
    await waitForEval(
      agentBrowser,
      `!!document.querySelector('[data-testid="project-director-stage-editor"]')`,
      "director stage editor",
      60000,
    );
    await prepareDirectorInspectorTabs(agentBrowser);

    clickVisibleText(agentBrowser, "Main");
    await sleep(500);

    for (const theme of ["light", "dark"] as const) {
      await captureTopNavStates(agentBrowser, theme, "Main", "Evidence Timeline");
      await captureNavigatorStates(agentBrowser, theme, "Main", "Evidence Timeline");
      clickVisibleText(agentBrowser, "Evidence Timeline");
      await waitForEval(
        agentBrowser,
        `!!document.querySelector('[data-testid="project-director-stage-editor"]') || document.body.innerText.includes("Director")`,
        "director reachable",
        15000,
      );
      if (!evalJson(agentBrowser, `!!document.querySelector('[data-testid="project-director-stage-editor"]')`)) {
        const stageTab = evalJson(agentBrowser, `(() => {
          const tab = [...document.querySelectorAll('[aria-label="Project navigator"] [role="tab"]')]
            .find((t) => (t.textContent || '').includes('Director') || (t.textContent || '').includes('Stage'));
          tab?.click();
          return !!tab;
        })()`);
        if (!stageTab) throw new Error("Could not open director stage tab");
        await waitForEval(
          agentBrowser,
          `!!document.querySelector('[data-testid="project-director-stage-editor"]')`,
          "director editor",
          30000,
        );
        await prepareDirectorInspectorTabs(agentBrowser);
      }
      await captureDirectorInspectorStates(agentBrowser, theme);
    }

    console.log(`[tab-evidence] phase=${phase} path=${outDir} runtime=electron`);
  } finally {
    agentBrowser(["close"], { allowFailure: true });
    await stopProcess(electron);
    await stopProcess(web);
  }
}

await main();
