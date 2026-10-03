#!/usr/bin/env node
/**
 * Capture real Electron tab-state evidence for PR #25.
 * Usage:
 *   CLASH_TAB_EVIDENCE_PHASE=before|after tsx scripts/capture-interactive-tab-evidence.ts
 */
import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  submitNamePromptDialog,
  submitProjectCreateDialog,
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

const repoEvidenceDir = path.join(repoRoot, "docs", "evidence", "interactive-state-styling");
const artifactsDir = "/opt/cursor/artifacts/interactive-state-styling";

function ensurePageTarget(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
) {
  try {
    const href = evalJson(agentBrowser, "location.href");
    if (typeof href === "string" && href.startsWith(recovery.expectedUrlPrefix)) return;
  } catch {
    // Re-attach below.
  }
  recoverAgentBrowserTarget(agentBrowser, recovery);
}

function evalOnPage(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  expression: string,
) {
  ensurePageTarget(agentBrowser, recovery);
  return evalJson(agentBrowser, expression);
}

function outFile(surface: string, theme: string, state: string) {
  return path.join(outDir, `${phase}-${surface}-${theme}-${state}.png`);
}

function clickWorkspaceTab(agentBrowser: ReturnType<typeof createAgentBrowser>, title: string) {
  return evalJson(agentBrowser, `(() => {
    const wanted = ${JSON.stringify(title)};
    const tab = [...document.querySelectorAll('[data-desktop-workspace-tab="true"] [role="tab"]')]
      .find((candidate) => candidate.getAttribute("aria-label") === wanted);
    if (!tab) return false;
    tab.scrollIntoView({ block: "center", inline: "nearest" });
    tab.click();
    return true;
  })()`);
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

async function waitForEvalRecovered(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  expression: string,
  label: string,
  timeoutMs = 20000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastValue: unknown;
  while (Date.now() < deadline) {
    try {
      ensurePageTarget(agentBrowser, recovery);
      lastValue = evalJson(agentBrowser, expression);
      if (lastValue) return lastValue;
    } catch {
      recoverAgentBrowserTarget(agentBrowser, recovery);
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(lastValue)}`);
}

async function screenshot(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  target: string,
) {
  ensurePageTarget(agentBrowser, recovery);
  agentBrowser(["screenshot", target]);
}

async function syncEvidenceCopies() {
  for (const dir of [repoEvidenceDir, artifactsDir]) {
    await mkdir(dir, { recursive: true });
  }
  const names = await readdir(outDir);
  for (const name of names) {
    if (!name.endsWith(".png")) continue;
    const source = path.join(outDir, name);
    await cp(source, path.join(repoEvidenceDir, name));
    await cp(source, path.join(artifactsDir, name));
  }
}

async function captureNavigatorStates(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  theme: "light" | "dark",
  tabA: string,
  tabB: string,
) {
  setTheme(agentBrowser, theme);
  await sleep(400);
  clickNavigatorTab(agentBrowser, tabA);
  await sleep(350);
  await screenshot(agentBrowser, recovery, outFile("navigator", theme, "selected-rest"));
  clickNavigatorTab(agentBrowser, tabB);
  await sleep(350);
  movePointerAway(agentBrowser);
  await sleep(200);
  await screenshot(agentBrowser, recovery, outFile("navigator", theme, "previous-tab-mouse-away"));
  hoverNavigatorTab(agentBrowser, tabA);
  await sleep(250);
  await screenshot(agentBrowser, recovery, outFile("navigator", theme, "hover-inactive"));
  await focusNavigatorTabWithArrows(agentBrowser, tabA);
  await sleep(250);
  await screenshot(agentBrowser, recovery, outFile("navigator", theme, "focus-visible"));
}

async function captureTopNavStates(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  theme: "light" | "dark",
  tabA: string,
  tabB: string,
) {
  setTheme(agentBrowser, theme);
  await sleep(400);
  clickWorkspaceTab(agentBrowser, tabA);
  await sleep(500);
  await screenshot(agentBrowser, recovery, outFile("topnav", theme, "selected-rest"));
  clickWorkspaceTab(agentBrowser, tabB);
  await sleep(500);
  movePointerAway(agentBrowser);
  await sleep(200);
  await screenshot(agentBrowser, recovery, outFile("topnav", theme, "previous-tab-mouse-away"));
  evalOnPage(agentBrowser, recovery, `(() => {
    const tabs = [...document.querySelectorAll('[data-desktop-workspace-tab="true"] [role="tab"]')];
    const inactive = tabs.find((t) => t.getAttribute("aria-selected") !== "true");
    inactive?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    inactive?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    return !!inactive;
  })()`);
  await sleep(250);
  await screenshot(agentBrowser, recovery, outFile("topnav", theme, "hover-inactive"));
  agentBrowser(["click", '[aria-label="Open workspaces"] [role="tab"]']);
  for (let i = 0; i < 8; i += 1) agentBrowser(["press", "ArrowRight"]);
  await sleep(250);
  await screenshot(agentBrowser, recovery, outFile("topnav", theme, "focus-visible"));
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

async function prepareDirectorInspectorTabs(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
) {
  if (
    evalOnPage(
      agentBrowser,
      recovery,
      `!!document.querySelector('[aria-label="Mannequin inspector sections"] [role="tab"]')`,
    )
  ) {
    return;
  }
  ensurePageTarget(agentBrowser, recovery);
  if (!clickButtonByLabel(agentBrowser, "Add scene element")) {
    throw new Error("Director Add scene element control missing");
  }
  await sleep(400);
  await waitForEvalRecovered(
    agentBrowser,
    recovery,
    `[...document.querySelectorAll('[role="menuitem"]')].some((item) => (item.textContent || "").includes("Add editable actor"))`,
    "director add actor menu",
    20000,
  );
  if (
    !evalOnPage(agentBrowser, recovery, `(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')]
        .find((candidate) => (candidate.textContent || "").includes("Add editable actor"));
      item?.click();
      return !!item;
    })()`)
  ) {
    throw new Error("Director Add editable actor menu item missing");
  }
  await waitForEvalRecovered(
    agentBrowser,
    recovery,
    `!!document.querySelector('[aria-label="Mannequin inspector sections"] [role="tab"]')`,
    "mannequin inspector tabs",
    30000,
  );
}

async function openDirectorStageTab(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  stageName: string,
) {
  clickNavigatorTab(agentBrowser, stageName);
  await waitForEvalRecovered(
    agentBrowser,
    recovery,
    `!!document.querySelector('[data-testid="project-director-stage-editor"]')`,
    "director stage editor",
    45000,
  );
  await prepareDirectorInspectorTabs(agentBrowser, recovery);
}

async function captureDirectorInspectorStates(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  theme: "light" | "dark",
) {
  setTheme(agentBrowser, theme);
  await sleep(400);
  clickDirectorInspectorTab(agentBrowser, "Properties");
  await sleep(300);
  await screenshot(agentBrowser, recovery, outFile("director", theme, "selected-rest"));
  clickDirectorInspectorTab(agentBrowser, "Pose");
  await sleep(300);
  movePointerAway(agentBrowser);
  await sleep(200);
  await screenshot(agentBrowser, recovery, outFile("director", theme, "previous-tab-mouse-away"));
  hoverDirectorInspectorTab(agentBrowser, "Properties");
  await sleep(250);
  await screenshot(agentBrowser, recovery, outFile("director", theme, "hover-inactive"));
  agentBrowser(["click", '[aria-label="Mannequin inspector sections"] [role="tab"]']);
  for (let i = 0; i < 6; i += 1) agentBrowser(["press", "ArrowRight"]);
  await sleep(250);
  await screenshot(agentBrowser, recovery, outFile("director", theme, "focus-visible"));
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

async function waitForDesktopShell(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  timeoutMs = 180_000,
) {
  const readyExpression = `(() => {
    const chrome = document.querySelector('[data-desktop-chrome="true"]');
    const runtime = window.__CLASH_RUNTIME_CONFIG__?.apiBaseUrl;
    return !!chrome && !!runtime;
  })()`;
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot: unknown = false;
  while (Date.now() < deadline) {
    try {
      ensurePageTarget(agentBrowser, recovery);
      lastSnapshot = evalJson(agentBrowser, `(() => ({
        href: location.href,
        chrome: !!document.querySelector('[data-desktop-chrome="true"]'),
        runtime: window.__CLASH_RUNTIME_CONFIG__?.apiBaseUrl ?? null,
      }))()`);
      if (evalJson(agentBrowser, readyExpression)) return lastSnapshot;
    } catch {
      recoverAgentBrowserTarget(agentBrowser, recovery);
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for desktop shell; last snapshot: ${JSON.stringify(lastSnapshot)}`);
}

async function submitProjectCreateDialogRecovered(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  projectName: string,
) {
  await waitForEvalRecovered(
    agentBrowser,
    recovery,
    `(() => {
      const input = document.querySelector("input[placeholder='Untitled project']");
      const rect = input?.getBoundingClientRect();
      return !!input && !!rect && rect.width > 0 && rect.height > 0;
    })()`,
    "project name dialog",
    45000,
  );
  ensurePageTarget(agentBrowser, recovery);
  await submitProjectCreateDialog(agentBrowser, projectName);
}

async function submitNamePromptDialogRecovered(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  name: string,
) {
  await waitForEvalRecovered(
    agentBrowser,
    recovery,
    `(() => {
      const input = document.querySelector('[role="dialog"] input');
      const rect = input?.getBoundingClientRect();
      return !!input && !!rect && rect.width > 0 && rect.height > 0;
    })()`,
    "name prompt input",
    45000,
  );
  ensurePageTarget(agentBrowser, recovery);
  await submitNamePromptDialog(agentBrowser, name);
  await waitForEvalRecovered(
    agentBrowser,
    recovery,
    `!document.querySelector('[role="dialog"] button[type="submit"]')`,
    "name prompt closed",
    30000,
  );
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
    agentBrowser(["close"], { allowFailure: true });
    agentBrowser(["connect", String(cdpPort)]);
    await waitForDesktopShell(agentBrowser, recovery);

    if (!clickByText(agentBrowser, "Projects") && !clickButtonByLabel(agentBrowser, "Projects")) {
      throw new Error("Projects link missing");
    }
    await waitForEvalRecovered(agentBrowser, recovery, `location.pathname === "/projects"`, "projects route");
    ensurePageTarget(agentBrowser, recovery);
    if (
      !clickButtonByLabel(agentBrowser, "New Project") &&
      !clickByText(agentBrowser, "New Project")
    ) {
      throw new Error("New Project missing");
    }
    await submitProjectCreateDialogRecovered(agentBrowser, recovery, "Tab Evidence Project");
    await waitForEvalRecovered(
      agentBrowser,
      recovery,
      `location.pathname.startsWith("/projects/") && location.pathname !== "/projects"`,
      "project editor",
      60000,
    );
    await waitForEvalRecovered(
      agentBrowser,
      recovery,
      `document.querySelector('[data-project-loro-connected]')?.getAttribute('data-project-loro-connected') === 'true'`,
      "project Loro room connection",
      120000,
    );
    await waitForEvalRecovered(
      agentBrowser,
      recovery,
      `!!document.querySelector('[aria-label="Project navigator"]')`,
      "project navigator",
      120000,
    );

    ensurePageTarget(agentBrowser, recovery);
    if (!clickButtonByLabel(agentBrowser, "New Timeline")) {
      throw new Error("Could not create timeline for navigator/topnav tabs");
    }
    await sleep(400);
    await submitNamePromptDialogRecovered(agentBrowser, recovery, "Evidence Timeline");
    await waitForEvalRecovered(
      agentBrowser,
      recovery,
      `!!document.querySelector('[data-testid="project-timeline-editor"]')`,
      "timeline editor",
      90000,
    );

    ensurePageTarget(agentBrowser, recovery);
    if (!clickButtonByLabel(agentBrowser, "New Director Stage")) {
      throw new Error("Could not create director stage");
    }
    await sleep(400);
    await submitNamePromptDialogRecovered(agentBrowser, recovery, "Evidence Director");
    await waitForEvalRecovered(
      agentBrowser,
      recovery,
      `!!document.querySelector('[data-testid="project-director-stage-editor"]')`,
      "director stage editor",
      90000,
    );
    await prepareDirectorInspectorTabs(agentBrowser, recovery);

    clickWorkspaceTab(agentBrowser, "Main");
    await sleep(500);

    for (const theme of ["light", "dark"] as const) {
      clickWorkspaceTab(agentBrowser, "Main");
      await sleep(300);
      await captureTopNavStates(agentBrowser, recovery, theme, "Main", "Evidence Timeline");
      await captureNavigatorStates(agentBrowser, recovery, theme, "Main", "Evidence Timeline");
      await openDirectorStageTab(agentBrowser, recovery, "Evidence Director");
      await captureDirectorInspectorStates(agentBrowser, recovery, theme);
    }

    await syncEvidenceCopies();
    const pngCount = (await readdir(outDir)).filter((name) => name.endsWith(".png")).length;
    console.log(`[tab-evidence] phase=${phase} path=${outDir} png=${pngCount} runtime=electron`);
  } finally {
    agentBrowser(["close"], { allowFailure: true });
    await stopProcess(electron);
    await stopProcess(web);
  }
}

await main();
