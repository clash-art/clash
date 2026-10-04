#!/usr/bin/env node
/**
 * Capture real Electron tab-state evidence for PR #25.
 * Usage:
 *   CLASH_TAB_EVIDENCE_PHASE=before|after tsx scripts/capture-interactive-tab-evidence.ts
 */
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CdpClient } from "./e2e/harness.ts";
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

const PRIMARY_PROJECT = "Tab Evidence Project";
const NAV_CANVAS = "Main";
const NAV_TIMELINE = "Evidence Timeline";
const NAV_DIRECTOR = "Evidence Director";

type TabStyleSample = {
  phase: string;
  surface: string;
  theme: string;
  state: string;
  ariaSelected: string | null;
  background: string;
  color: string;
  outline: string;
  boxShadow: string;
};

const styleAudit: TabStyleSample[] = [];

const FOCUS_CAPTURE_MARGIN_PX = 8;
const FOCUS_CAPTURE_SCALE = 4;

function outFileFocusFull(surface: string, theme: string) {
  return path.join(outDir, `${phase}-${surface}-${theme}-focus-visible-full.png`);
}

function outFileZoom(surface: string, theme: string, state: string) {
  return path.join(outDir, `${phase}-${surface}-${theme}-${state}-zoom.png`);
}

function tabStyleExpression(selector: string) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const style = getComputedStyle(el);
    return {
      ariaSelected: el.getAttribute("aria-selected"),
      background: style.backgroundColor,
      color: style.color,
      outline: style.outlineStyle !== "none" ? style.outlineColor + " " + style.outlineWidth : "none",
      boxShadow: style.boxShadow,
    };
  })()`;
}

async function recordTabStyle(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  surface: string,
  theme: string,
  state: string,
  selector: string,
) {
  const sample = evalOnPage(agentBrowser, recovery, tabStyleExpression(selector)) as Omit<
    TabStyleSample,
    "phase" | "surface" | "theme" | "state"
  > | null;
  if (sample) styleAudit.push({ phase, surface, theme, state, ...sample });
}

async function writeStyleAudit() {
  const target = path.join(repoEvidenceDir, "computed-styles.json");
  await mkdir(repoEvidenceDir, { recursive: true });
  let existing: TabStyleSample[] = [];
  try {
    existing = JSON.parse(await readFile(target, "utf8")) as TabStyleSample[];
  } catch {
    existing = [];
  }
  const merged = [...existing.filter((row) => row.phase !== phase), ...styleAudit];
  await writeFile(target, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  await mkdir(artifactsDir, { recursive: true });
  await cp(target, path.join(artifactsDir, "computed-styles.json"));
}

function topNavTabSelector(title: string) {
  return `[data-desktop-workspace-tab="true"] [role="tab"][aria-label=${JSON.stringify(title)}]`;
}

function navigatorTabSelector(label: string) {
  return `[aria-label="Project navigator"] [role="tab"][aria-label=${JSON.stringify(label)}]`;
}

const evidenceFocusedTabSelector = '[data-tab-evidence-focus="true"]';

function markActiveTabForEvidence(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
) {
  const ok = evalOnPage(
    agentBrowser,
    recovery,
    `(() => {
      document.querySelectorAll('[data-tab-evidence-focus="true"]').forEach((el) => {
        el.removeAttribute("data-tab-evidence-focus");
      });
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return false;
      let target = active;
      if (active.getAttribute("role") === "tab") {
        const workspace = active.closest('[data-desktop-workspace-tab="true"]');
        if (workspace instanceof HTMLElement) target = workspace;
      }
      target.setAttribute("data-tab-evidence-focus", "true");
      target.scrollIntoView({ block: "center", inline: "nearest" });
      return true;
    })()`,
  );
  if (!ok) {
    throw new Error("Focused tab missing for evidence capture");
  }
}

async function connectPageCdp(
  cdpPort: number,
  expectedUrlPrefix: string,
): Promise<CdpClient> {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  if (!res.ok) throw new Error(`CDP list failed: HTTP ${res.status}`);
  const targets = (await res.json()) as Array<{
    type?: string;
    url?: string;
    webSocketDebuggerUrl?: string;
  }>;
  const page = targets.find(
    (target) =>
      target.type === "page" &&
      typeof target.url === "string" &&
      target.url.startsWith(expectedUrlPrefix) &&
      target.webSocketDebuggerUrl,
  );
  if (!page?.webSocketDebuggerUrl) {
    throw new Error(`CDP page target missing for ${expectedUrlPrefix}`);
  }
  const cdp = new CdpClient(page.webSocketDebuggerUrl);
  await cdp.ready();
  return cdp;
}

async function captureFocusClipScreenshot(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  selector: string,
  targetPath: string,
) {
  await captureElementClipScreenshot(
    agentBrowser,
    recovery,
    selector,
    targetPath,
    FOCUS_CAPTURE_MARGIN_PX,
    FOCUS_CAPTURE_SCALE,
  );
}

async function screenshotTabFocusEvidence(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  selector: string,
  surface: string,
  theme: "light" | "dark",
) {
  await screenshot(agentBrowser, recovery, outFileFocusFull(surface, theme));
  await captureFocusClipScreenshot(
    agentBrowser,
    recovery,
    selector,
    outFile(surface, theme, "focus-visible"),
  );
}

async function selectWorkspaceTab(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  title: string,
) {
  await waitForEvalRecovered(
    agentBrowser,
    recovery,
    `[...document.querySelectorAll('[data-desktop-workspace-tab="true"] [role="tab"]')].some((tab) => tab.getAttribute("aria-label") === ${JSON.stringify(title)})`,
    `workspace tab present: ${title}`,
    30000,
  );
  if (!clickWorkspaceTab(agentBrowser, title)) {
    throw new Error(`Workspace tab not found: ${title}`);
  }
  await waitForEvalRecovered(
    agentBrowser,
    recovery,
    `document.querySelector(${JSON.stringify(topNavTabSelector(title))})?.getAttribute("aria-selected") === "true"`,
    `workspace tab selected: ${title}`,
    15000,
  );
}

async function openSettingsWorkspaceTab(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
) {
  evalOnPage(agentBrowser, recovery, `(() => {
    window.history.pushState({}, "", "/settings");
    window.dispatchEvent(new PopStateEvent("popstate"));
    return location.pathname;
  })()`);
  await waitForEvalRecovered(agentBrowser, recovery, `location.pathname === "/settings"`, "settings route", 20000);
  await waitForEvalRecovered(
    agentBrowser,
    recovery,
    `[...document.querySelectorAll('[data-desktop-workspace-tab="true"] [role="tab"]')].some((tab) => tab.getAttribute("aria-label") === "Settings")`,
    "settings workspace tab",
    20000,
  );
}

async function returnToPrimaryProject(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  primaryProjectPath: string,
  primaryTabTitle: string,
): Promise<string> {
  await waitForEvalRecovered(
    agentBrowser,
    recovery,
    `document.querySelectorAll('[data-desktop-workspace-tab="true"] [role="tab"]').length >= 1 || location.pathname.startsWith("/projects/")`,
    "workspace tabs or project route",
    30000,
  );
  const labels = evalOnPage(
    agentBrowser,
    recovery,
    `[...document.querySelectorAll('[data-desktop-workspace-tab="true"] [role="tab"]')].map((tab) => tab.getAttribute("aria-label") || "")`,
  ) as string[];
  for (const label of labels) {
    if (!label || label === "Settings") continue;
    clickWorkspaceTab(agentBrowser, label);
    await sleep(500);
    const path = evalOnPage(agentBrowser, recovery, "location.pathname") as string;
    if (path === primaryProjectPath) return label;
  }
  if (labels.includes(primaryTabTitle)) {
    await selectWorkspaceTab(agentBrowser, recovery, primaryTabTitle);
    return primaryTabTitle;
  }
  evalOnPage(agentBrowser, recovery, `(() => {
    window.history.pushState({}, "", ${JSON.stringify(primaryProjectPath)});
    window.dispatchEvent(new PopStateEvent("popstate"));
    return location.pathname;
  })()`);
  await waitForEvalRecovered(
    agentBrowser,
    recovery,
    `location.pathname === ${JSON.stringify(primaryProjectPath)}`,
    `project route ${primaryProjectPath}`,
    30000,
  );
  return primaryTabTitle;
}

async function waitForTabTransitionSettle(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  selector: string,
  label: string,
) {
  await sleep(120);
  await waitForEvalRecovered(
    agentBrowser,
    recovery,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const animations = el.getAnimations();
      return !animations.some((animation) => animation.playState === "running" || animation.pending);
    })()`,
    `transition settle on ${label}`,
    12000,
  );
  await sleep(280);
}

async function hoverAndSettle(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  selector: string,
  label: string,
) {
  ensurePageTarget(agentBrowser, recovery);
  const hovered = evalOnPage(
    agentBrowser,
    recovery,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!(el instanceof HTMLElement)) return false;
      el.scrollIntoView({ block: "center", inline: "nearest" });
      for (const type of ["mouseover", "mouseenter", "mousemove"]) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
      }
      return true;
    })()`,
  );
  if (!hovered) {
    throw new Error(`Hover target missing for ${label}: ${selector}`);
  }
  await waitForTabTransitionSettle(agentBrowser, recovery, selector, label);
  await waitForEvalRecovered(
    agentBrowser,
    recovery,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const bg = getComputedStyle(el).backgroundColor;
      if (bg === "transparent" || bg === "rgba(0, 0, 0, 0)") return false;
      const oklab = bg.match(/\\/\\s*([0-9.]+)\\s*\\)$/);
      if (oklab) return Number(oklab[1]) >= 0.04;
      const parts = bg.match(/[\\d.]+/g);
      if (parts && parts.length >= 4) return Number(parts[3]) >= 0.04;
      return true;
    })()`,
    `hover background settled on ${label}`,
    8000,
  ).catch((error) => {
    console.warn(`[tab-evidence-warn] hover background check skipped for ${label}: ${String(error)}`);
  });
}

async function movePointerOffTabs(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
) {
  ensurePageTarget(agentBrowser, recovery);
  agentBrowser(["hover", '[data-desktop-dashboard="true"]']);
  await sleep(150);
}

async function captureElementClipScreenshot(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  selector: string,
  targetPath: string,
  marginPx: number,
  scale: number,
) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const clip = evalOnPage(
    agentBrowser,
    recovery,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const rect = el.getBoundingClientRect();
      const margin = ${marginPx};
      const x = Math.max(0, rect.x - margin);
      const y = Math.max(0, rect.y - margin);
      const right = rect.right + margin;
      const bottom = rect.bottom + margin;
      return {
        x,
        y,
        width: Math.max(1, right - x),
        height: Math.max(1, bottom - y),
        scale: ${scale},
      };
    })()`,
  ) as { x: number; y: number; width: number; height: number; scale: number } | null;
  if (!clip) throw new Error(`Element clip target missing: ${selector}`);
  const cdp = await connectPageCdp(recovery.cdpPort, recovery.expectedUrlPrefix);
  try {
    const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      clip,
      captureBeyondViewport: false,
    });
    await writeFile(targetPath, Buffer.from(shot.data, "base64"));
  } finally {
    cdp.close();
  }
}

async function screenshotElement(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  selector: string,
  target: string,
) {
  await waitForEvalRecovered(
    agentBrowser,
    recovery,
    `!!document.querySelector(${JSON.stringify(selector)})`,
    `screenshot element ${selector}`,
    45000,
  );
  await captureElementClipScreenshot(agentBrowser, recovery, selector, target, 0, 1);
}

async function focusWorkspaceTabKeyboard(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  title: string,
  selectedTitle: string,
) {
  ensurePageTarget(agentBrowser, recovery);
  agentBrowser(["click", topNavTabSelector(selectedTitle)]);
  await sleep(150);
  for (let i = 0; i < 14; i += 1) {
    const match = evalOnPage(
      agentBrowser,
      recovery,
      `document.activeElement?.getAttribute("aria-label") === ${JSON.stringify(title)}`,
    );
    if (match) break;
    agentBrowser(["press", "ArrowLeft"]);
    await sleep(80);
  }
}

async function focusDirectorInspectorTabKeyboard(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  label: string,
  selectedLabel: string,
) {
  clickDirectorInspectorTab(agentBrowser, selectedLabel);
  await sleep(200);
  markDirectorInspectorTab(agentBrowser, label);
  ensurePageTarget(agentBrowser, recovery);
  agentBrowser(["click", `${directorInspectorRoot} [role="tab"][aria-selected="true"]`]);
  await sleep(120);
  for (let i = 0; i < 10; i += 1) {
    const match = evalOnPage(
      agentBrowser,
      recovery,
      `(() => {
        const active = document.querySelector(${JSON.stringify(directorEvidenceTab)});
        if (!active || document.activeElement !== active) return false;
        const text = (active.innerText || active.textContent || "").trim();
        return text === ${JSON.stringify(label)};
      })()`,
    );
    if (match) break;
    agentBrowser(["press", "ArrowLeft"]);
    await sleep(100);
  }
  await waitForEvalRecovered(
    agentBrowser,
    recovery,
    `(() => {
      const el = document.querySelector(${JSON.stringify(directorEvidenceTab)});
      if (!el || document.activeElement !== el) return false;
      const style = getComputedStyle(el);
      return style.outlineStyle !== "none" || style.boxShadow !== "none";
    })()`,
    `director focus ring on ${label}`,
    12000,
  );
}

async function focusNavigatorTabKeyboard(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  label: string,
  selectedLabel: string,
) {
  ensurePageTarget(agentBrowser, recovery);
  agentBrowser(["click", navigatorTabSelector(selectedLabel)]);
  await sleep(150);
  for (let i = 0; i < 14; i += 1) {
    const match = evalOnPage(
      agentBrowser,
      recovery,
      `(() => {
        const active = document.activeElement;
        const text = (active?.innerText || active?.textContent || active?.getAttribute("aria-label") || "").trim();
        return text.includes(${JSON.stringify(label)});
      })()`,
    );
    if (match) break;
    agentBrowser(["press", "ArrowUp"]);
    await sleep(80);
  }
}

function findDirectorInspectorRootExpression() {
  return `document.querySelector('[aria-label="Mannequin inspector sections"]')
    ?? document.querySelector('[aria-label="Rigged model inspector sections"]')`;
}

function stampDirectorInspectorRoot(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
) {
  return evalOnPage(
    agentBrowser,
    recovery,
    `(() => {
      document.querySelectorAll('[data-director-inspector-evidence-root="true"]').forEach((el) => {
        el.removeAttribute("data-director-inspector-evidence-root");
      });
      const root = ${findDirectorInspectorRootExpression()};
      if (!(root instanceof HTMLElement)) return false;
      root.setAttribute("data-director-inspector-evidence-root", "true");
      return true;
    })()`,
  );
}

function markDirectorInspectorTab(agentBrowser: ReturnType<typeof createAgentBrowser>, label: string) {
  const tabId = directorInspectorTabIdForLabel(label);
  return evalJson(agentBrowser, `(() => {
    const wanted = ${JSON.stringify(label)};
    const tabId = ${JSON.stringify(tabId)};
    document.querySelectorAll("[data-tab-evidence-target]").forEach((el) => el.removeAttribute("data-tab-evidence-target"));
    document.querySelectorAll('[data-director-inspector-evidence-root="true"]').forEach((el) => {
      el.removeAttribute("data-director-inspector-evidence-root");
    });
    const root = ${findDirectorInspectorRootExpression()};
    if (!(root instanceof HTMLElement)) return false;
    root.setAttribute("data-director-inspector-evidence-root", "true");
    let tab = tabId ? root.querySelector("#" + tabId) : null;
    if (!(tab instanceof HTMLElement)) {
      tab = [...root.querySelectorAll('[role="tab"]')].find((candidate) => {
        const value = (candidate.innerText || candidate.textContent || "").trim();
        return value === wanted;
      }) ?? null;
    }
    if (!(tab instanceof HTMLElement)) return false;
    tab.setAttribute("data-tab-evidence-target", "true");
    return true;
  })()`);
}

const directorEvidenceTab =
  '[data-director-inspector-evidence-root="true"] [role="tab"][data-tab-evidence-target="true"]';
const directorInspectorRoot = '[data-director-inspector-evidence-root="true"]';

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
      const aria = candidate.getAttribute("aria-label") || "";
      return value === wanted || value.includes(wanted) || aria === wanted;
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
  const styles = path.join(repoEvidenceDir, "computed-styles.json");
  try {
    await cp(styles, path.join(artifactsDir, "computed-styles.json"));
    await cp(styles, path.join(outDir, "computed-styles.json"));
  } catch {
    // written by writeStyleAudit
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
  await recordTabStyle(agentBrowser, recovery, "navigator", theme, "selected-rest", navigatorTabSelector(tabA));
  await screenshot(agentBrowser, recovery, outFile("navigator", theme, "selected-rest"));
  clickNavigatorTab(agentBrowser, tabB);
  await sleep(350);
  await movePointerOffTabs(agentBrowser, recovery);
  await recordTabStyle(
    agentBrowser,
    recovery,
    "navigator",
    theme,
    "previous-tab-mouse-away",
    navigatorTabSelector(tabA),
  );
  await screenshot(agentBrowser, recovery, outFile("navigator", theme, "previous-tab-mouse-away"));
  await hoverAndSettle(agentBrowser, recovery, navigatorTabSelector(tabA), tabA);
  await recordTabStyle(agentBrowser, recovery, "navigator", theme, "hover-inactive", navigatorTabSelector(tabA));
  await screenshot(agentBrowser, recovery, outFile("navigator", theme, "hover-inactive"));
  await focusNavigatorTabKeyboard(agentBrowser, recovery, tabA, tabB);
  await sleep(200);
  markActiveTabForEvidence(agentBrowser, recovery);
  await recordTabStyle(
    agentBrowser,
    recovery,
    "navigator",
    theme,
    "focus-visible",
    evidenceFocusedTabSelector,
  );
  await screenshotTabFocusEvidence(agentBrowser, recovery, evidenceFocusedTabSelector, "navigator", theme);
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
  await selectWorkspaceTab(agentBrowser, recovery, tabA);
  await sleep(350);
  await recordTabStyle(agentBrowser, recovery, "topnav", theme, "selected-rest", topNavTabSelector(tabA));
  await screenshot(agentBrowser, recovery, outFile("topnav", theme, "selected-rest"));
  await selectWorkspaceTab(agentBrowser, recovery, tabB);
  await sleep(350);
  await movePointerOffTabs(agentBrowser, recovery);
  await recordTabStyle(
    agentBrowser,
    recovery,
    "topnav",
    theme,
    "previous-tab-mouse-away",
    topNavTabSelector(tabA),
  );
  await screenshot(agentBrowser, recovery, outFile("topnav", theme, "previous-tab-mouse-away"));
  await hoverAndSettle(agentBrowser, recovery, topNavTabSelector(tabA), tabA);
  await recordTabStyle(agentBrowser, recovery, "topnav", theme, "hover-inactive", topNavTabSelector(tabA));
  await screenshot(agentBrowser, recovery, outFile("topnav", theme, "hover-inactive"));
  await focusWorkspaceTabKeyboard(agentBrowser, recovery, tabA, tabB);
  await sleep(200);
  markActiveTabForEvidence(agentBrowser, recovery);
  await recordTabStyle(
    agentBrowser,
    recovery,
    "topnav",
    theme,
    "focus-visible",
    evidenceFocusedTabSelector,
  );
  await screenshotTabFocusEvidence(agentBrowser, recovery, evidenceFocusedTabSelector, "topnav", theme);
}

function directorInspectorTabIdForLabel(label: string) {
  if (label === "Properties") return "properties";
  if (label === "Pose") return "pose";
  if (label === "Motion") return "motion";
  return null;
}

function clickDirectorInspectorTab(agentBrowser: ReturnType<typeof createAgentBrowser>, label: string) {
  const tabId = directorInspectorTabIdForLabel(label);
  return evalJson(agentBrowser, `(() => {
    const wanted = ${JSON.stringify(label)};
    const tabId = ${JSON.stringify(tabId)};
    const root = ${findDirectorInspectorRootExpression()};
    if (!root) return false;
    let tab = tabId ? root.querySelector("#" + tabId) : null;
    if (!(tab instanceof HTMLElement)) {
      tab = [...root.querySelectorAll('[role="tab"]')].find((candidate) => {
        const value = (candidate.innerText || candidate.textContent || "").trim();
        return value === wanted;
      }) ?? null;
    }
    if (!(tab instanceof HTMLElement)) return false;
    tab.click();
    return true;
  })()`);
}

function hoverDirectorInspectorTab(agentBrowser: ReturnType<typeof createAgentBrowser>, label: string) {
  return evalJson(agentBrowser, `(() => {
    const wanted = ${JSON.stringify(label)};
    const root = ${findDirectorInspectorRootExpression()};
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

const directorInspectorTabsPresentExpression = `!!(${findDirectorInspectorRootExpression()}?.querySelector('[role="tab"]'))`;

async function prepareDirectorInspectorTabs(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
) {
  if (evalOnPage(agentBrowser, recovery, directorInspectorTabsPresentExpression)) {
    return;
  }
  ensurePageTarget(agentBrowser, recovery);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (evalOnPage(agentBrowser, recovery, directorInspectorTabsPresentExpression)) {
      return;
    }
    if (!clickButtonByLabel(agentBrowser, "Add scene element")) {
      throw new Error("Director Add scene element control missing");
    }
    await sleep(500);
    await waitForEvalRecovered(
      agentBrowser,
      recovery,
      `[...document.querySelectorAll('[role="menuitem"]')].some((item) => (item.textContent || "").includes("Add editable actor"))`,
      "director add actor menu",
      20000,
    );
    const clicked = evalOnPage(agentBrowser, recovery, `(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        const style = getComputedStyle(candidate);
        return (candidate.textContent || "").includes("Add editable actor") &&
          rect.width > 0 && rect.height > 0 &&
          style.display !== "none" && style.visibility !== "hidden" &&
          candidate.getAttribute("aria-disabled") !== "true";
      });
      if (!item) return false;
      item.scrollIntoView({ block: "center", inline: "nearest" });
      item.click();
      return true;
    })()`);
    if (clicked) {
      await waitForEvalRecovered(
        agentBrowser,
        recovery,
        `document.body.innerText.includes("Actor 1")`,
        "mannequin scene row",
        45000,
      );
      await waitForEvalRecovered(
        agentBrowser,
        recovery,
        directorInspectorTabsPresentExpression,
        "director inspector tabs",
        45000,
      );
      return;
    }
    agentBrowser(["press", "Escape"], { allowFailure: true });
    await sleep(400);
  }
  throw new Error("Director Add editable actor menu item missing");
}

async function ensureDirectorInspectorEvidenceReady(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
) {
  await prepareDirectorInspectorTabs(agentBrowser, recovery);
  if (!evalOnPage(agentBrowser, recovery, directorInspectorTabsPresentExpression)) {
    clickByText(agentBrowser, "Actor 1");
    await waitForEvalRecovered(
      agentBrowser,
      recovery,
      directorInspectorTabsPresentExpression,
      "director inspector after selecting Actor 1",
      30000,
    );
  }
  if (!stampDirectorInspectorRoot(agentBrowser, recovery)) {
    throw new Error("Director inspector root missing for evidence capture");
  }
}

async function openDirectorStageTab(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  stageName: string,
) {
  await ensureProjectNavigatorExpanded(agentBrowser, recovery);
  evalOnPage(
    agentBrowser,
    recovery,
    `(() => {
      const section = document.querySelector('[data-project-folder="director-stages"]');
      const trigger = section?.querySelector('[aria-expanded]');
      if (trigger?.getAttribute("aria-expanded") !== "true") trigger?.click();
      return true;
    })()`,
  );
  await sleep(250);
  const directorTabSelector = `[data-project-folder="director-stages"] [role="tab"][aria-label=${JSON.stringify(stageName)}]`;
  await waitForEvalRecovered(
    agentBrowser,
    recovery,
    `!!document.querySelector(${JSON.stringify(directorTabSelector)})`,
    `director stage tab visible: ${stageName}`,
    30000,
  );
  ensurePageTarget(agentBrowser, recovery);
  agentBrowser(["click", directorTabSelector]);
  await sleep(600);
  await waitForEvalRecovered(
    agentBrowser,
    recovery,
    `!!document.querySelector('[data-testid="project-director-stage-editor"]') || (${directorInspectorTabsPresentExpression})`,
    "director stage editor",
    120000,
  );
  await ensureDirectorInspectorEvidenceReady(agentBrowser, recovery);
}

function resolveDirectorInactiveTabLabel(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
) {
  const label = evalOnPage(
    agentBrowser,
    recovery,
    `(() => {
      const root = ${findDirectorInspectorRootExpression()};
      if (!root) return "";
      const labels = [...root.querySelectorAll('[role="tab"]')].map((tab) =>
        (tab.innerText || tab.textContent || "").trim(),
      );
      if (labels.includes("Pose")) return "Pose";
      return labels.find((value) => value && value !== "Properties") || "";
    })()`,
  );
  if (typeof label !== "string" || !label) {
    throw new Error("Director inactive inspector tab missing");
  }
  return label;
}

async function captureDirectorInspectorStates(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  theme: "light" | "dark",
) {
  setTheme(agentBrowser, theme);
  await sleep(400);
  await ensureDirectorInspectorEvidenceReady(agentBrowser, recovery);
  const inactiveTab = resolveDirectorInactiveTabLabel(agentBrowser, recovery);
  if (!clickDirectorInspectorTab(agentBrowser, "Properties")) {
    throw new Error("Director Properties tab missing");
  }
  await sleep(300);
  markDirectorInspectorTab(agentBrowser, "Properties");
  stampDirectorInspectorRoot(agentBrowser, recovery);
  await recordTabStyle(agentBrowser, recovery, "director", theme, "selected-rest", directorEvidenceTab);
  await screenshot(agentBrowser, recovery, outFile("director", theme, "selected-rest"));
  await screenshotElement(agentBrowser, recovery, directorInspectorRoot, outFileZoom("director", theme, "selected-rest"));
  await ensureDirectorInspectorEvidenceReady(agentBrowser, recovery);
  const inactiveAfterRest = resolveDirectorInactiveTabLabel(agentBrowser, recovery);
  if (!clickDirectorInspectorTab(agentBrowser, inactiveAfterRest)) {
    throw new Error(`Director inactive tab missing: ${inactiveAfterRest}`);
  }
  await sleep(300);
  await movePointerOffTabs(agentBrowser, recovery);
  if (!markDirectorInspectorTab(agentBrowser, "Properties")) {
    await ensureDirectorInspectorEvidenceReady(agentBrowser, recovery);
    if (!markDirectorInspectorTab(agentBrowser, "Properties")) {
      throw new Error("Director Properties tab marker missing (mouse-away)");
    }
  }
  await recordTabStyle(
    agentBrowser,
    recovery,
    "director",
    theme,
    "previous-tab-mouse-away",
    directorEvidenceTab,
  );
  await screenshot(agentBrowser, recovery, outFile("director", theme, "previous-tab-mouse-away"));
  await screenshotElement(
    agentBrowser,
    recovery,
    directorInspectorRoot,
    outFileZoom("director", theme, "previous-tab-mouse-away"),
  );
  await ensureDirectorInspectorEvidenceReady(agentBrowser, recovery);
  if (!clickDirectorInspectorTab(agentBrowser, inactiveTab)) {
    throw new Error(`Director inactive tab missing before hover capture: ${inactiveTab}`);
  }
  await sleep(200);
  if (!markDirectorInspectorTab(agentBrowser, "Properties")) {
    await ensureDirectorInspectorEvidenceReady(agentBrowser, recovery);
    if (!markDirectorInspectorTab(agentBrowser, "Properties")) {
      throw new Error("Director Properties tab marker missing (hover)");
    }
  }
  await hoverAndSettle(agentBrowser, recovery, directorEvidenceTab, "Properties");
  await recordTabStyle(agentBrowser, recovery, "director", theme, "hover-inactive", directorEvidenceTab);
  await screenshot(agentBrowser, recovery, outFile("director", theme, "hover-inactive"));
  await screenshotElement(agentBrowser, recovery, directorInspectorRoot, outFileZoom("director", theme, "hover-inactive"));
  if (!markDirectorInspectorTab(agentBrowser, "Properties")) {
    await ensureDirectorInspectorEvidenceReady(agentBrowser, recovery);
    if (!markDirectorInspectorTab(agentBrowser, "Properties")) {
      throw new Error("Director Properties tab marker missing (focus)");
    }
  }
  await focusDirectorInspectorTabKeyboard(agentBrowser, recovery, "Properties", inactiveTab);
  await waitForTabTransitionSettle(agentBrowser, recovery, directorEvidenceTab, "Properties focus");
  markActiveTabForEvidence(agentBrowser, recovery);
  await recordTabStyle(agentBrowser, recovery, "director", theme, "focus-visible", evidenceFocusedTabSelector);
  await screenshotTabFocusEvidence(agentBrowser, recovery, evidenceFocusedTabSelector, "director", theme);
}

function clickSettingsSectionTab(agentBrowser: ReturnType<typeof createAgentBrowser>, label: string) {
  return evalJson(agentBrowser, `(() => {
    const wanted = ${JSON.stringify(label)};
    const tab = [...document.querySelectorAll('[aria-label="Settings sections"] [role="tab"]')].find((candidate) => {
      const value = (candidate.innerText || candidate.textContent || "").trim();
      return value === wanted;
    });
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
}

async function focusSettingsSectionKeyboard(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  label: string,
  selectedLabel: string,
) {
  if (!clickSettingsSectionTab(agentBrowser, selectedLabel)) {
    throw new Error(`Settings section tab not found: ${selectedLabel}`);
  }
  await sleep(150);
  for (let i = 0; i < 16; i += 1) {
    const match = evalOnPage(
      agentBrowser,
      recovery,
      `(() => {
        const active = document.activeElement;
        const text = (active?.innerText || active?.textContent || "").trim();
        return text === ${JSON.stringify(label)};
      })()`,
    );
    if (match) break;
    agentBrowser(["press", "ArrowDown"]);
    await sleep(80);
  }
}

function markSettingsSectionTabForEvidence(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  label: string,
) {
  const ok = evalOnPage(
    agentBrowser,
    recovery,
    `(() => {
      document.querySelectorAll('[data-tab-evidence-focus="true"]').forEach((el) => {
        el.removeAttribute("data-tab-evidence-focus");
      });
      const wanted = ${JSON.stringify(label)};
      const tab = [...document.querySelectorAll('[aria-label="Settings sections"] [role="tab"]')].find((candidate) => {
        const value = (candidate.innerText || candidate.textContent || "").trim();
        return value.includes(wanted);
      });
      if (!(tab instanceof HTMLElement)) return false;
      tab.setAttribute("data-tab-evidence-focus", "true");
      tab.scrollIntoView({ block: "center", inline: "nearest" });
      return true;
    })()`,
  );
  if (!ok) {
    throw new Error(`Settings section tab missing for evidence: ${label}`);
  }
}

const settingsAppearanceTabSelector = '[aria-label="Settings sections"] #appearance';

async function captureSettingsFocusStates(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  theme: "light" | "dark",
) {
  setTheme(agentBrowser, theme);
  await sleep(400);
  await openSettingsWorkspaceTab(agentBrowser, recovery);
  await waitForEvalRecovered(
    agentBrowser,
    recovery,
    `!!document.querySelector('[aria-label="Settings sections"] [role="tab"]')`,
    "settings section tabs",
    30000,
  );
  await focusSettingsSectionKeyboard(agentBrowser, recovery, "Appearance", "Plugins");
  await sleep(200);
  const focusedAppearance = evalOnPage(
    agentBrowser,
    recovery,
    `(() => {
      const tab = document.querySelector(${JSON.stringify(settingsAppearanceTabSelector)});
      if (!(tab instanceof HTMLElement)) return false;
      tab.focus();
      return document.activeElement === tab || document.activeElement?.closest('[role="tab"]') === tab;
    })()`,
  );
  if (!focusedAppearance) {
    throw new Error("Settings Appearance tab focus failed");
  }
  await sleep(120);
  await recordTabStyle(
    agentBrowser,
    recovery,
    "settings",
    theme,
    "focus-visible",
    settingsAppearanceTabSelector,
  );
  markSettingsSectionTabForEvidence(agentBrowser, recovery, "Appearance");
  await screenshotTabFocusEvidence(agentBrowser, recovery, evidenceFocusedTabSelector, "settings", theme);
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

async function ensureProjectNavigatorExpanded(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
) {
  const collapsed = evalOnPage(
    agentBrowser,
    recovery,
    `document.querySelector('#project-workspace-shell')?.getAttribute('data-project-navigator-collapsed') === 'true'`,
  );
  if (!collapsed) return;
  clickButtonByLabel(agentBrowser, "Expand project sidebar");
  await waitForEvalRecovered(
    agentBrowser,
    recovery,
    `document.querySelector('#project-workspace-shell')?.getAttribute('data-project-navigator-collapsed') === 'false'`,
    "expanded project navigator",
    15000,
  );
}

async function clickNavigatorAddLabel(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  folderId: string,
  addLabel: string,
) {
  await ensureProjectNavigatorExpanded(agentBrowser, recovery);
  await waitForEvalRecovered(
    agentBrowser,
    recovery,
    `!!document.querySelector('[data-project-folder="${folderId}"]')`,
    `${folderId} navigator folder`,
    30000,
  );
  evalOnPage(
    agentBrowser,
    recovery,
    `(() => {
      const section = document.querySelector('[data-project-folder="${folderId}"]');
      section?.scrollIntoView({ block: "center", inline: "nearest" });
      const trigger = section?.querySelector('[aria-expanded]');
      if (trigger?.getAttribute("aria-expanded") !== "true") trigger?.click();
      return true;
    })()`,
  );
  await waitForEvalRecovered(
    agentBrowser,
    recovery,
    `(() => {
      const section = document.querySelector('[data-project-folder="${folderId}"]');
      const button = [...(section?.querySelectorAll("button") ?? [])].find(
        (candidate) => candidate.getAttribute("aria-label") === ${JSON.stringify(addLabel)},
      );
      const rect = button?.getBoundingClientRect();
      return !!button && !!rect && rect.width > 0 && rect.height > 0;
    })()`,
    `${addLabel} control`,
    30000,
  );
  ensurePageTarget(agentBrowser, recovery);
  const clicked = evalOnPage(
    agentBrowser,
    recovery,
    `(() => {
      const section = document.querySelector('[data-project-folder=${JSON.stringify(folderId)}]');
      const button = [...(section?.querySelectorAll("button") ?? [])].find(
        (candidate) => candidate.getAttribute("aria-label") === ${JSON.stringify(addLabel)},
      );
      if (!button) return false;
      button.scrollIntoView({ block: "center", inline: "nearest" });
      button.click();
      return true;
    })()`,
  );
  if (!clicked) {
    agentBrowser(
      [
        "click",
        `[data-project-folder=${JSON.stringify(folderId)}] [aria-label=${JSON.stringify(addLabel)}]`,
      ],
      { allowFailure: true },
    );
    const confirmed = evalOnPage(
      agentBrowser,
      recovery,
      `(() => {
        const section = document.querySelector('[data-project-folder=${JSON.stringify(folderId)}]');
        const button = [...(section?.querySelectorAll("button") ?? [])].find(
          (candidate) => candidate.getAttribute("aria-label") === ${JSON.stringify(addLabel)},
        );
        return !!button;
      })()`,
    );
    if (!confirmed) {
      throw new Error(`${addLabel} control click did not register`);
    }
  }
}

async function waitForNamePrompt(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  titleFragment: string,
) {
  await waitForEvalRecovered(
    agentBrowser,
    recovery,
    `(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const input = dialog?.querySelector("input");
      const rect = input?.getBoundingClientRect();
      const text = dialog?.textContent || "";
      return !!input && !!rect && rect.width > 0 && rect.height > 0 &&
        text.includes(${JSON.stringify(titleFragment)});
    })()`,
    `name prompt (${titleFragment})`,
    45000,
  );
}

async function submitProjectCreateDialogRecovered(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  projectName: string,
) {
  const selector = "input[placeholder='Untitled project']";
  await waitForEvalRecovered(
    agentBrowser,
    recovery,
    `(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      const rect = input?.getBoundingClientRect();
      return !!input && !!rect && rect.width > 0 && rect.height > 0;
    })()`,
    "project name dialog",
    45000,
  );
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      ensurePageTarget(agentBrowser, recovery);
      agentBrowser(["fill", selector, projectName]);
      await waitForEvalRecovered(
        agentBrowser,
        recovery,
        `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(projectName)} &&
         document.querySelector('[role="dialog"] button[type="submit"]')?.disabled === false`,
        "enabled project create submit",
        20000,
      );
      agentBrowser(["click", '[role="dialog"] button[type="submit"]']);
      await waitForEvalRecovered(
        agentBrowser,
        recovery,
        `location.pathname.startsWith("/projects/") && location.pathname !== "/projects"`,
        "project editor route",
        60000,
      );
      return;
    } catch (error) {
      recoverAgentBrowserTarget(agentBrowser, recovery);
      if (attempt === 4) throw error;
      await sleep(700);
    }
  }
}

async function submitNamePromptDialogRecovered(
  agentBrowser: ReturnType<typeof createAgentBrowser>,
  recovery: { cdpPort: number; expectedUrlPrefix: string },
  name: string,
  titleFragment: string,
) {
  await waitForNamePrompt(agentBrowser, recovery, titleFragment);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      ensurePageTarget(agentBrowser, recovery);
      const inputSelector = '[role="dialog"] input';
      const focused = evalOnPage(
        agentBrowser,
        recovery,
        `(() => {
          const dialog = document.querySelector('[role="dialog"]');
          const input = dialog?.querySelector("input");
          if (!input) return false;
          dialog?.scrollIntoView({ block: "center", inline: "nearest" });
          input.focus({ preventScroll: true });
          const wanted = ${JSON.stringify(name)};
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (setter) setter.call(input, wanted);
          else input.value = wanted;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return input.value === wanted;
        })()`,
      );
      if (!focused) {
        agentBrowser(["click", inputSelector]);
        agentBrowser(["press", "Meta+A"], { allowFailure: true });
        agentBrowser(["press", "Control+A"], { allowFailure: true });
        agentBrowser(["press", "Backspace"], { allowFailure: true });
        agentBrowser(["keyboard", "type", name]);
      }
      await waitForEvalRecovered(
        agentBrowser,
        recovery,
        `(() => {
          const input = document.querySelector(${JSON.stringify(inputSelector)});
          const submit = document.querySelector('[role="dialog"] button[type="submit"]');
          return input?.value?.trim() === ${JSON.stringify(name)} && !!submit && !submit.disabled;
        })()`,
        "enabled name prompt continue",
        25000,
      );
      agentBrowser(["click", '[role="dialog"] button[type="submit"]'], { allowFailure: true });
      evalOnPage(
        agentBrowser,
        recovery,
        `(() => {
          const submit = document.querySelector('[role="dialog"] button[type="submit"]');
          submit?.click();
          return true;
        })()`,
      );
      await waitForEvalRecovered(
        agentBrowser,
        recovery,
        `!document.querySelector('[role="dialog"] button[type="submit"]')`,
        "name prompt closed",
        30000,
      );
      return;
    } catch (error) {
      recoverAgentBrowserTarget(agentBrowser, recovery);
      if (attempt === 4) throw error;
      await sleep(700);
    }
  }
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
      electronArgs: [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--disable-gpu-sandbox",
      ],
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
    await waitForEvalRecovered(
      agentBrowser,
      recovery,
      `(() => {
        const links = [...document.querySelectorAll("a, button")];
        return links.some((el) => (el.textContent || "").trim() === "Projects" || el.getAttribute("aria-label") === "Projects");
      })()`,
      "Projects navigation control",
      60000,
    );

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
    await sleep(500);
    await submitProjectCreateDialogRecovered(agentBrowser, recovery, PRIMARY_PROJECT);
    const primaryProjectPath = (await waitForEvalRecovered(
      agentBrowser,
      recovery,
      `location.pathname.startsWith("/projects/") && location.pathname !== "/projects" && location.pathname`,
      "project editor",
      60000,
    )) as string;
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

    clickNavigatorTab(agentBrowser, NAV_CANVAS);
    await sleep(800);

    await waitForEvalRecovered(
      agentBrowser,
      recovery,
      `!!document.querySelector('[data-project-folder="director-stages"] [aria-label="New Director Stage"]')`,
      "director stage create control",
      120000,
    );

    ensurePageTarget(agentBrowser, recovery);
    await clickNavigatorAddLabel(agentBrowser, recovery, "director-stages", "New Director Stage");
    await sleep(400);
    await submitNamePromptDialogRecovered(
      agentBrowser,
      recovery,
      NAV_DIRECTOR,
      "Director Stage name",
    );
    await waitForEvalRecovered(
      agentBrowser,
      recovery,
      `!!document.querySelector('[data-project-folder="director-stages"] [role="tab"][aria-label=${JSON.stringify(NAV_DIRECTOR)}]')`,
      `director stage tab ${NAV_DIRECTOR}`,
      120000,
    );
    clickNavigatorTab(agentBrowser, NAV_CANVAS);
    await sleep(800);

    ensurePageTarget(agentBrowser, recovery);
    await clickNavigatorAddLabel(agentBrowser, recovery, "timelines", "New Timeline");
    await sleep(400);
    await submitNamePromptDialogRecovered(
      agentBrowser,
      recovery,
      NAV_TIMELINE,
      "Timeline name",
    );
    await waitForEvalRecovered(
      agentBrowser,
      recovery,
      `!!document.querySelector('[data-testid="project-timeline-editor"]')`,
      "timeline editor",
      90000,
    );

    const primaryTabTitle = (await waitForEvalRecovered(
      agentBrowser,
      recovery,
      `[...document.querySelectorAll('[data-desktop-workspace-tab="true"] [role="tab"]')].find((tab) => tab.getAttribute("aria-label") !== "Settings")?.getAttribute("aria-label") || ""`,
      "primary workspace tab title",
      30000,
    )) as string;
    if (!primaryTabTitle) {
      throw new Error("Primary workspace tab title missing before settings detour");
    }
    await openSettingsWorkspaceTab(agentBrowser, recovery);
    await returnToPrimaryProject(agentBrowser, recovery, primaryProjectPath, primaryTabTitle);
    await waitForEvalRecovered(
      agentBrowser,
      recovery,
      `!!document.querySelector('[aria-label="Project navigator"]')`,
      "project navigator after settings tab",
      120000,
    );

    for (const theme of ["light", "dark"] as const) {
      await selectWorkspaceTab(agentBrowser, recovery, primaryTabTitle);
      await sleep(300);
      await captureTopNavStates(agentBrowser, recovery, theme, primaryTabTitle, "Settings");
      await selectWorkspaceTab(agentBrowser, recovery, primaryTabTitle);
      await sleep(400);
      await ensureProjectNavigatorExpanded(agentBrowser, recovery);
      clickNavigatorTab(agentBrowser, NAV_CANVAS);
      await sleep(300);
      await captureNavigatorStates(agentBrowser, recovery, theme, NAV_CANVAS, NAV_TIMELINE);
      await openDirectorStageTab(agentBrowser, recovery, NAV_DIRECTOR);
      await captureDirectorInspectorStates(agentBrowser, recovery, theme);
      await captureSettingsFocusStates(agentBrowser, recovery, theme);
    }

    await writeStyleAudit();
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
