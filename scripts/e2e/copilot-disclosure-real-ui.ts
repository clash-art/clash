/**
 * Capture Backchat disclosure evidence in real Clash (project editor + Mock ACP),
 * not the codex copilot preview fixture.
 */
import type { ClosableServer } from "../../apps/web/e2e/host-artifacts.ts";
import {
  CdpClient,
  assert,
  capture,
  chromeBinary,
  click,
  evaluate,
  findFreePort,
  sleep,
  stopProcess,
  tail,
  typeText,
  viteCli,
  waitFor,
  waitForHttp,
  waitForTarget,
} from "./harness.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const webDir = path.join(repoRoot, "apps/web");

const evidenceRoot =
  process.env.OPENMA_EVIDENCE_DIR ??
  "/cursor/stores/bc-8af30c89-1c8d-5944-9e50-08179bf783ab/media/openma-common-0.7.8/real-ui";
const versionLabel = process.env.OPENMA_EVIDENCE_VERSION ?? "v0.7.8-after";
const outDir = path.join(evidenceRoot, versionLabel);

const dataDir = path.join(repoRoot, ".tmp", `openma-disclosure-${versionLabel}-data`);
const chromeDataDir = path.join(repoRoot, ".tmp", `openma-disclosure-${versionLabel}-chrome`);

const CANVAS_LIST_PROMPT = "列出画布上的节点";

function clickableByText(label: string) {
  return `([...document.querySelectorAll("a, button, [role='button'], [role='tab']")].find((el) => {
    const text = (el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim();
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return text === ${JSON.stringify(label)} &&
      rect.width > 0 && rect.height > 0 &&
      style.display !== "none" && style.visibility !== "hidden";
  }))`;
}

function disclosureRowExpr(includes: string) {
  return `([...document.querySelectorAll('[data-backchat-session-timeline="true"] button[data-chat-turn-disclosure-trigger="true"], [data-backchat-session-timeline="true"] button.activity-disclosure-row, [data-backchat-session-timeline="true"] button.chat-interactive-surface')].find((el) => {
    const text = (el.innerText || el.textContent || "").trim();
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return text.includes(${JSON.stringify(includes)}) &&
      rect.width > 0 && rect.height > 0 &&
      style.display !== "none" && style.visibility !== "hidden";
  }))`;
}

async function typeChatMessage(cdp: CdpClient, text: string) {
  const inserted = await evaluate<boolean>(cdp, `(() => {
    const editor = document.querySelector(".milkdown-chat-input [contenteditable='true']");
    if (!editor) return false;
    editor.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, ${JSON.stringify(text)});
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(text)} }));
    return (editor.innerText || editor.textContent || "").includes(${JSON.stringify(text)});
  })()`);
  assert(inserted, "Could not type into copilot chat editor");
}

async function mouseTo(cdp: CdpClient, x: number, y: number) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
  });
}

async function captureClip(cdp: CdpClient, selectorExpr: string, targetPath: string, padding = 12) {
  const clip = await evaluate<{ x: number; y: number; width: number; height: number } | null>(
    cdp,
    `(() => {
      const el = (${selectorExpr});
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const rect = el.getBoundingClientRect();
      const pad = ${padding};
      return {
        x: Math.max(0, rect.left - pad),
        y: Math.max(0, rect.top - pad),
        width: Math.min(window.innerWidth, rect.width + pad * 2),
        height: Math.min(window.innerHeight, rect.height + pad * 2),
        scale: 1,
      };
    })()`,
  );
  assert(clip, `clip target missing for ${targetPath}`);
  const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    clip,
  });
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, Buffer.from(shot.data, "base64"));
}

async function measureRowAlignment(cdp: CdpClient, selectorExpr: string) {
  return evaluate(cdp, `(() => {
    const row = (${selectorExpr});
    const timeline = document.querySelector('[data-backchat-session-timeline="true"]');
    if (!row || !timeline) return null;
    const summary =
      row.querySelector(".chat-transcript-disclosure-summary") ??
      row.querySelector("span.min-w-0") ??
      row;
    const leadingIcon =
      row.querySelector('[data-session-process-avatar="true"]') ??
      row.querySelector(".chat-activity-icon")?.closest("span") ??
      row.querySelector(".chat-activity-icon") ??
      row.firstElementChild;
    const body =
      timeline.querySelector('[data-session-turn-answer="true"] p') ??
      timeline.querySelector('[data-assistant-section="answer"] p') ??
      timeline.querySelector("[data-chat-markdown='settled'] p") ??
      timeline.querySelector(".chat-assistant-markdown p") ??
      timeline.querySelector('[data-session-turn-answer="true"]') ??
      timeline.querySelector("[data-chat-markdown='settled']") ??
      timeline.querySelector(".chat-assistant-markdown");
    if (!body) return { error: "body anchor missing" };
    const summaryRect = summary.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const iconRect = leadingIcon?.getBoundingClientRect();
    const summaryOffsetPx = Math.round((summaryRect.left - bodyRect.left) * 100) / 100;
    const rowOffsetPx = Math.round((rowRect.left - bodyRect.left) * 100) / 100;
    const iconOffsetPx =
      iconRect == null
        ? null
        : Math.round((iconRect.left - bodyRect.left) * 100) / 100;
    const iconWithin1px =
      iconOffsetPx === null ? false : Math.abs(iconOffsetPx) <= 1;
    return {
      bodyLeft: bodyRect.left,
      iconLeft: iconRect?.left ?? null,
      summaryLeft: summaryRect.left,
      rowLeft: rowRect.left,
      rowOffsetPx,
      iconOffsetPx,
      summaryOffsetPx,
      iconWithin1px,
      passCriterion: "icon aligned with body text (backchat #45)",
      summaryText: (summary.textContent || "").trim().slice(0, 80),
      bodyPreview: (body.textContent || "").trim().slice(0, 80),
    };
  })()`);
}

async function rowStyleAudit(cdp: CdpClient, selectorExpr: string) {
  return evaluate(cdp, `(() => {
    const el = (${selectorExpr});
    if (!el) return null;
    const style = getComputedStyle(el);
    const summary = el.querySelector(".chat-transcript-disclosure-summary");
    const summaryStyle = summary ? getComputedStyle(summary) : null;
    return {
      tag: el.tagName,
      className: el.className,
      text: (el.innerText || el.textContent || "").trim().slice(0, 120),
      ariaExpanded: el.getAttribute("aria-expanded"),
      outline: style.outline,
      outlineColor: style.outlineColor,
      outlineWidth: style.outlineWidth,
      outlineStyle: style.outlineStyle,
      boxShadow: style.boxShadow,
      backgroundColor: style.backgroundColor,
      color: style.color,
      summaryColor: summaryStyle?.color ?? null,
      summaryBackgroundColor: summaryStyle?.backgroundColor ?? null,
      activeElement: document.activeElement === el,
      activeTag: document.activeElement?.tagName ?? null,
      activeClass: document.activeElement?.className ?? null,
    };
  })()`);
}

async function captureAlignmentAnnotated(cdp: CdpClient, theme: "light" | "dark") {
  const targetPath = path.join(outDir, `alignment-guide-${theme}.png`);
  await evaluate(cdp, `(() => {
    document.querySelectorAll("[data-openma-alignment-guide]").forEach((node) => node.remove());
    const timeline = document.querySelector('[data-backchat-session-timeline="true"]');
    const body =
      timeline?.querySelector('[data-session-turn-answer="true"] p') ??
      timeline?.querySelector('[data-assistant-section="answer"] p');
    const processRow = timeline?.querySelector('button[data-chat-reasoning-trigger="true"]');
    const toolRow = [...(timeline?.querySelectorAll('button[data-chat-turn-disclosure-trigger="true"]') ?? [])]
      .find((el) => (el.textContent || "").includes("已执行"));
    if (!body || !processRow || !toolRow) return false;
    const bodyLeft = body.getBoundingClientRect().left;
    const rows = [
      { label: "body", left: bodyLeft, color: "#ef4444" },
      { label: "process icon", left: (processRow.querySelector('[data-session-process-avatar="true"]') ?? processRow.firstElementChild)?.getBoundingClientRect().left ?? bodyLeft, color: "#22c55e" },
      { label: "tool icon", left: (toolRow.querySelector(".chat-activity-icon")?.closest("span") ?? toolRow.firstElementChild)?.getBoundingClientRect().left ?? bodyLeft, color: "#3b82f6" },
      { label: "process summary", left: processRow.querySelector(".chat-transcript-disclosure-summary")?.getBoundingClientRect().left ?? bodyLeft, color: "#a855f7" },
      { label: "tool summary", left: toolRow.querySelector(".chat-transcript-disclosure-summary")?.getBoundingClientRect().left ?? bodyLeft, color: "#f97316" },
    ];
    const top = Math.min(body.getBoundingClientRect().top, processRow.getBoundingClientRect().top) - 8;
    const bottom = Math.max(body.getBoundingClientRect().bottom, toolRow.getBoundingClientRect().bottom) + 8;
    for (const guide of rows) {
      const line = document.createElement("div");
      line.setAttribute("data-openma-alignment-guide", "true");
      line.style.position = "fixed";
      line.style.left = guide.left + "px";
      line.style.top = top + "px";
      line.style.width = "2px";
      line.style.height = bottom - top + "px";
      line.style.background = guide.color;
      line.style.zIndex = "2147483646";
      line.style.pointerEvents = "none";
      document.body.appendChild(line);
      const tag = document.createElement("div");
      tag.setAttribute("data-openma-alignment-guide", "true");
      tag.textContent = guide.label;
      tag.style.position = "fixed";
      tag.style.left = (guide.left + 4) + "px";
      tag.style.top = (top - 18) + "px";
      tag.style.font = "11px monospace";
      tag.style.color = guide.color;
      tag.style.background = "rgba(255,255,255,0.92)";
      tag.style.padding = "1px 4px";
      tag.style.zIndex = "2147483647";
      tag.style.pointerEvents = "none";
      document.body.appendChild(tag);
    }
    return true;
  })()`);
  await captureClip(
    cdp,
    `document.querySelector('[data-backchat-session-timeline="true"]')`,
    targetPath,
    16,
  );
  await evaluate(cdp, `document.querySelectorAll("[data-openma-alignment-guide]").forEach((n) => n.remove()); true`);
}

async function publishEvidence() {
  const publishRoots = [
    process.env.OPENMA_PUBLISH_REPO_DIR ??
      path.join(repoRoot, "docs/evidence/openma-0.7.8/real-ui", versionLabel),
    process.env.OPENMA_PUBLISH_ARTIFACTS_DIR ??
      path.join("/opt/cursor/artifacts/openma-0.7.8/real-ui", versionLabel),
  ];
  for (const root of publishRoots) {
    await mkdir(root, { recursive: true });
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(outDir);
    for (const name of names) {
      if (name === "failure.png") continue;
      await cp(path.join(outDir, name), path.join(root, name));
    }
  }
}

async function openRealBackchatSession(cdp: CdpClient, webOrigin: string) {
  await cdp.send("Page.navigate", { url: webOrigin });
  await waitFor(cdp, `document.body.innerText.includes("Home")`, "home");
  await click(cdp, clickableByText("Projects"), "Projects");
  await waitFor(cdp, `location.pathname === "/projects"`, "projects page");
  await click(cdp, clickableByText("New Project"), "New Project");
  await waitFor(
    cdp,
    `document.querySelector('[role="dialog"]')?.innerText.includes("Create project")`,
    "create project dialog",
    10000,
  );
  await typeText(cdp, '[role="dialog"] input', "OpenMA disclosure evidence");
  await waitFor(
    cdp,
    `(() => {
      const btn = (${clickableByText("Create")});
      return !!btn && !btn.disabled;
    })()`,
    "create enabled",
    5000,
  );
  await click(cdp, clickableByText("Create"), "Create project");
  await waitFor(
    cdp,
    `location.pathname.startsWith("/projects/") && !!document.querySelector("#editor-header")`,
    "project editor",
    20000,
  );
  await waitFor(
    cdp,
    `document.body.innerText.includes("Mock ACP") || document.body.innerText.includes("本地 Agent 已连接") || document.body.innerText.includes("Local agent connected")`,
    "mock runtime ready",
    20000,
  );
  await typeChatMessage(cdp, CANVAS_LIST_PROMPT);
  await click(
    cdp,
    `([...document.querySelectorAll("button")].find((button) => {
      const label = (button.getAttribute("aria-label") || "").toLowerCase();
      const rect = button.getBoundingClientRect();
      return (label.includes("send") || label.includes("发送")) && !button.disabled && rect.width > 0;
    }))`,
    "Send prompt",
  );
  await waitFor(
    cdp,
    `!!document.querySelector('[data-backchat-session-timeline="true"]') &&
      document.body.innerText.includes("画布上当前有") &&
      document.body.innerText.includes("已工作") &&
      !document.body.innerText.includes("正在工作")`,
    "mock ACP turn settled",
    60000,
  );
  await ensureProcessExpanded(cdp);
  await waitFor(
    cdp,
    `!!document.querySelector('[data-backchat-session-timeline="true"] [data-session-process-activity]:not([hidden]) [data-tool-group-size]') || !!(${disclosureRowExpr("已执行")})`,
    "process activity or tool summary row",
    15000,
  );
}

type RowKind = "process" | "tool" | "thought";

const rowMatchers: Record<RowKind, string> = {
  process: "已工作",
  tool: "已执行",
  thought: "已思考",
};

function rowSelectorExpr(kind: RowKind): string {
  if (kind === "process") {
    return `document.querySelector('[data-backchat-session-timeline="true"] button[data-chat-reasoning-trigger="true"]')`;
  }
  if (kind === "tool") {
    return `([...document.querySelectorAll('[data-backchat-session-timeline="true"] button[data-chat-turn-disclosure-trigger="true"]')].find((el) => (el.textContent || "").includes("已执行")))`;
  }
  return disclosureRowExpr(rowMatchers[kind]);
}

async function ensureProcessExpanded(cdp: CdpClient) {
  await evaluate(cdp, `(() => {
    const activity = document.querySelector('[data-backchat-session-timeline="true"] [data-session-process-activity]:not([hidden]) [data-tool-group-size]');
    if (activity) return true;
    const btn = document.querySelector('[data-backchat-session-timeline="true"] button[data-chat-reasoning-trigger="true"]');
    if (btn instanceof HTMLButtonElement) btn.click();
    return !!document.querySelector('[data-backchat-session-timeline="true"] [data-session-process-activity]:not([hidden]) [data-tool-group-size]');
  })()`);
}

async function captureRowStates(
  cdp: CdpClient,
  kind: RowKind,
  theme: "light" | "dark",
) {
  const expr = rowSelectorExpr(kind);
  const exists = await evaluate<boolean>(cdp, `!!(${expr})`);
  if (!exists) return { kind, theme, skipped: true as const };

  const prefix = `${kind}-row-${theme}`;
  await mouseTo(cdp, 20, 20);
  await sleep(150);
  const restAudit = await rowStyleAudit(cdp, expr);
  await captureClip(cdp, expr, path.join(outDir, `${prefix}-rest.png`));

  const hoverPoint = await evaluate<{ x: number; y: number }>(cdp, `(() => {
    const el = (${expr});
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  await mouseTo(cdp, hoverPoint.x, hoverPoint.y);
  await sleep(200);
  const hoverAudit = await rowStyleAudit(cdp, expr);
  await captureClip(cdp, expr, path.join(outDir, `${prefix}-hover.png`));

  await click(cdp, expr, `${kind} row click`);
  await mouseTo(cdp, 30, 30);
  await sleep(250);
  const postClickAudit = await rowStyleAudit(cdp, expr);
  await captureClip(cdp, expr, path.join(outDir, `${prefix}-post-click-mouse-away.png`));
  if (kind === "tool") {
    await captureClip(
      cdp,
      `document.querySelector('[data-backchat-session-timeline="true"]')`,
      path.join(outDir, `${prefix}-post-click-timeline-clip.png`),
      4,
    );
    await writeFile(
      path.join(outDir, `${prefix}-post-click-styles.json`),
      JSON.stringify(postClickAudit, null, 2),
    );
  }

  await evaluate(cdp, `(() => { document.body.tabIndex = -1; document.body.focus(); return true; })()`);
  for (let i = 0; i < 40; i += 1) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    const focused = await evaluate<boolean>(
      cdp,
      `document.activeElement === (${expr}) || (${expr})?.contains(document.activeElement)`,
    );
    if (focused) break;
  }
  const tabAudit = await rowStyleAudit(cdp, expr);
  await captureClip(cdp, expr, path.join(outDir, `${prefix}-tab-focus.png`));

  if (kind === "tool" || kind === "thought") {
    await ensureProcessExpanded(cdp);
  }
  const alignment = await measureRowAlignment(cdp, expr);

  await click(cdp, expr, `${kind} row expand`);
  await sleep(200);
  await captureClip(cdp, expr, path.join(outDir, `${prefix}-expanded.png`));

  return {
    kind,
    theme,
    skipped: false as const,
    tabAudit,
    alignment,
    hover: { rest: restAudit, hover: hoverAudit },
  };
}

async function closeServer(server: ClosableServer) {
  await new Promise((resolve) => server.close(resolve));
}

async function main() {
  process.env.CLASH_E2E_STUB_ACP = "1";
  process.env.CHROME_BIN = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";
  await rm(dataDir, { recursive: true, force: true });
  await rm(chromeDataDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const apiPort = await findFreePort(49800);
  const webPort = await findFreePort(49850);
  const cdpPort = await findFreePort(49900);
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const webOrigin = `http://127.0.0.1:${webPort}`;

  const { startLocalApiServer } = await import("../../apps/local-api/src/server.ts");
  const apiServer = await startLocalApiServer({ port: apiPort, dataDir });
  let web: ChildProcess | undefined;
  let chrome: ChildProcess | undefined;
  let cdp: CdpClient | undefined;
  const webLogs: string[] = [];
  const chromeLogs: string[] = [];
  const audits: unknown[] = [];

  try {
    web = spawn(process.execPath, [viteCli({ webDir, repoRoot }), "--host", "127.0.0.1", "--port", String(webPort)], {
      cwd: webDir,
      env: {
        ...process.env,
        VITE_CLASH_API_BASE_URL: apiOrigin,
        VITE_CLASH_WS_BASE_URL: apiOrigin.replace("http:", "ws:"),
        CLASH_WEB_E2E_NO_CLOUDFLARE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    web.stdout?.on("data", (buf) => webLogs.push(String(buf)));
    web.stderr?.on("data", (buf) => webLogs.push(String(buf)));
    await waitForHttp(webOrigin, "vite");

    chrome = spawn(chromeBinary(), [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${chromeDataDir}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1440,1100",
      "about:blank",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    chrome.stdout?.on("data", (buf) => chromeLogs.push(String(buf)));
    chrome.stderr?.on("data", (buf) => chromeLogs.push(String(buf)));

    cdp = new CdpClient(await waitForTarget(cdpPort));
    await cdp.ready();
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    await openRealBackchatSession(cdp, webOrigin);
    for (const theme of ["light", "dark"] as const) {
      if (theme === "dark") {
        await evaluate(cdp, `document.documentElement.classList.add("dark"); true`);
      } else {
        await evaluate(cdp, `document.documentElement.classList.remove("dark"); true`);
      }
      await sleep(200);
      await ensureProcessExpanded(cdp);
      await capture(cdp, path.join(outDir, `context-${theme}.png`));
      await captureAlignmentAnnotated(cdp, theme);
      for (const kind of ["process", "tool", "thought"] as const) {
        await ensureProcessExpanded(cdp);
        if (kind === "tool") {
          const toolReady = await evaluate<boolean>(
            cdp,
            `!!(${disclosureRowExpr("已执行")})`,
          );
          if (!toolReady) {
            audits.push({ kind, theme, skipped: true as const, reason: "tool summary row missing" });
            continue;
          }
        }
        audits.push(await captureRowStates(cdp, kind, theme));
      }
    }

    const alignmentReport = {
      versionLabel,
      capturedAt: new Date().toISOString(),
      rows: audits,
    };
    await writeFile(path.join(outDir, "focus-audit.json"), JSON.stringify(audits, null, 2));
    await writeFile(
      path.join(outDir, "alignment-measurements.json"),
      JSON.stringify(alignmentReport, null, 2),
    );
    await publishEvidence();
    console.log(`[openma-evidence] wrote ${outDir}`);
  } catch (error) {
    if (cdp) {
      try {
        await capture(cdp, path.join(outDir, "failure.png"));
      } catch {
        // ignore
      }
    }
    console.error("[openma-evidence] web\n" + tail(webLogs));
    console.error("[openma-evidence] chrome\n" + tail(chromeLogs));
    throw error;
  } finally {
    cdp?.close();
    await stopProcess(chrome);
    await stopProcess(web);
    await closeServer(apiServer);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
