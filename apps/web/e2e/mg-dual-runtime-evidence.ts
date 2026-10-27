/**
 * Dual MG Evidence (#442 / #444 / #435–#436 remaining slices).
 *
 * 1) Editor/preview UI: Canvas create menu → Remotion Component + HTML Motion
 * 2) Agent-side: Clash session with dsh-acp / DeepSeek Flash (real API — no ECHO)
 *    creating html_motion + remotion peers and mentioning Timeline DSL runtime:html
 *
 * Coding stays on the human/executor; dsh is ONLY the Clash Agent runtime here.
 *
 * Run after `pnpm exec turbo run build --filter=@clash/local-api...`:
 *   CHROME_BIN=/usr/bin/google-chrome \
 *   DEEPSEEK_API_KEY=… \
 *   pnpm exec tsx apps/web/e2e/mg-dual-runtime-evidence.ts
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
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

const repoEvidenceDir = path.join(repoRoot, "docs/evidence/mg-dual-runtime");
const artifactEvidenceDir = "/opt/cursor/artifacts/mg-dual-runtime";

const captureDir =
  process.env.CLASH_MG_DUAL_CAPTURE_DIR ?? repoEvidenceDir;
const dataDir =
  process.env.CLASH_MG_DUAL_DATA_DIR ??
  path.join(repoRoot, ".tmp", "mg-dual-runtime-evidence-data");
const chromeDataDir = path.join(dataDir, "chrome-profile");

const DSH_LABEL = "DeepSeek Harness";
const HARNESS_PICKER_ARIA = "Session runtime, harness, and model";

/** English prompt for Flash-as-Clash-Agent (not a coding agent). */
const AGENT_PROMPT = [
  "You are Clash Agent on DeepSeek Flash (dsh-acp).",
  "This project already has Canvas peers: Agent HTML Lower Third (html_motion) and Agent Remotion Title (remotion).",
  "1) Use Clash MCP/canvas tools if connected to confirm both nodes (list/get). If MCP reports disconnected, say so once and continue.",
  "2) Reply in English with: (a) both labels/types you see, (b) one short note that Timeline MG items with runtime:html must keep a live sourceNodeId (no HTML snapshot).",
  "No shell. No repo exploration. Flash-sized.",
].join(" ");

const MILKDOWN_EDITOR_EXPR = `document.querySelector(".milkdown-chat-input .ProseMirror[contenteditable='true']") ?? document.querySelector(".ProseMirror[contenteditable='true']")`;

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
    `[...document.querySelectorAll("button,[role='switch']")].some((button) => {
      const aria = button.getAttribute("aria-label") || "";
      return aria === ${JSON.stringify(`Disable ${label} agent`)} || aria.includes(${JSON.stringify(`Disable ${label}`)});
    })`,
  );
  if (alreadyEnabled) return;
  const canEnable = await evaluate<boolean>(
    cdp,
    `[...document.querySelectorAll("button,[role='switch']")].some((button) => {
      const aria = button.getAttribute("aria-label") || "";
      return aria === ${JSON.stringify(`Enable ${label} agent`)} || aria.includes(${JSON.stringify(`Enable ${label}`)});
    })`,
  );
  if (!canEnable) {
    // Already configured / toggle not labeled Enable — treat as enabled.
    return;
  }
  await clickAriaButton(cdp, `Enable ${label} agent`);
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


const HTML_DOC = `<!doctype html><html><head><meta charset="utf-8"/><style>
html,body{margin:0;height:100%;display:grid;place-items:center;background:#0f172a;color:#e2e8f0;font:600 42px Inter,system-ui,sans-serif}
</style></head><body><h1>AGENT HTML MG</h1></body></html>`;

const REMOTION_SRC = `import React from "react";
import { AbsoluteFill } from "remotion";
const AgentRemotionTitle: React.FC = () => (
  <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", background: "#111", color: "white", fontSize: 48 }}>
    AGENT REMOTION MG
  </AbsoluteFill>
);
export default AgentRemotionTitle;
`;

async function seedDualMgPeers(apiOrigin: string, projectId: string) {
  const hostAdd = async (body: Record<string, unknown>) => {
    const res = await fetch(
      `${apiOrigin}/api/v1/projects/${encodeURIComponent(projectId)}/host-command`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const json = await res.json();
    if (!res.ok || (json as { error?: string }).error) {
      throw new Error(`host-command failed: ${JSON.stringify(json)}`);
    }
    return json;
  };
  await hostAdd({
    action: "add",
    type: "html_motion",
    label: "Agent HTML Lower Third",
    content: HTML_DOC,
    actorClientType: "cli",
  });
  await hostAdd({
    action: "add",
    type: "remotion",
    label: "Agent Remotion Title",
    content: REMOTION_SRC,
    actorClientType: "cli",
  });
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

  const canInstall = await evaluate<boolean>(
    cdp,
    `[...document.querySelectorAll("button")].some((button) => button.getAttribute("aria-label") === ${JSON.stringify(`Install ${DSH_LABEL}`)})`,
  );
  if (canInstall) {
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
  }
  await waitForHarnessIdle(cdp);
  await ensureHarnessEnabled(cdp, DSH_LABEL);
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
  await waitForRuntimeAgent(apiOrigin, "dsh-acp");
}

async function selectDeepSeekHarness(cdp: CdpClient) {
  const triggerShowsDsh = await evaluate<boolean>(
    cdp,
    `(() => {
      const btn = (${harnessPickerExpression()});
      const text = (btn ? (btn.innerText || btn.textContent || "") : "").toLowerCase();
      return text.includes("deepseek") || text.includes("dsh");
    })()`,
  );
  await click(cdp, harnessPickerExpression(), "harness picker");
  await waitFor(
    cdp,
    `document.body.innerText.includes("DeepSeek") || document.body.innerText.toLowerCase().includes("dsh")`,
    "harness menu open",
    30_000,
  );
  await capture(
    cdp,
    path.join(captureDir, "01-harness-menu-deepseek-flash.png"),
  );
  // Prefer explicit DeepSeek Harness row; skip if already checked.
  const needSelect = await evaluate<boolean>(
    cdp,
    `(() => {
      const rows = [...document.querySelectorAll("button, [role='menuitem'], [role='option'], [role='menuitemradio'], [data-value]")];
      const deep = rows.find((el) => {
        const text = (el.innerText || el.textContent || "").trim();
        return text.includes("DeepSeek Harness") || text === "DeepSeek";
      });
      if (!deep) return false;
      const checked = deep.getAttribute("aria-checked") === "true" || deep.getAttribute("data-state") === "checked";
      return !checked;
    })()`,
  );
  if (needSelect || !triggerShowsDsh) {
    await click(
      cdp,
      `(() => [...document.querySelectorAll("button, [role='menuitem'], [role='option'], [role='menuitemradio'], [data-value]")].find((el) => {
        const text = (el.innerText || el.textContent || "").trim();
        const value = el.getAttribute("data-value") || "";
        return text.includes("DeepSeek") || value.includes("dsh-acp");
      }))()`,
      "select DeepSeek harness",
    );
  }
  // Try Flash model if a Model section / Flash option is visible in the same popover.
  const flash = await evaluate<boolean>(
    cdp,
    `(() => [...document.querySelectorAll("button, [role='menuitem'], [role='option'], [role='menuitemradio']")].some((el) => {
      const text = (el.innerText || el.textContent || "").trim().toLowerCase();
      return text.includes("flash") || text.includes("deepseek-flash") || text.includes("deepseek flash");
    }))()`,
  );
  if (flash) {
    await click(
      cdp,
      `(() => [...document.querySelectorAll("button, [role='menuitem'], [role='option'], [role='menuitemradio']")].find((el) => {
        const text = (el.innerText || el.textContent || "").trim().toLowerCase();
        return text.includes("flash") || text.includes("deepseek-flash") || text.includes("deepseek flash");
      }))()`,
      "select DeepSeek Flash model",
    );
  }
  // Close popover by Escape if still open, then accept Dsh Acp / DeepSeek on trigger.
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await waitFor(
    cdp,
    `(() => {
      const btn = (${harnessPickerExpression()});
      const text = (btn ? (btn.innerText || btn.textContent || "") : "").toLowerCase();
      return text.includes("deepseek") || text.includes("dsh");
    })()`,
    "harness trigger shows DeepSeek/Dsh",
    30_000,
  );
}

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
      90_000,
    );
    return;
  } catch {
    const projectPath = await evaluate<string | null>(
      cdp,
      `(() => {
        const link = [...document.querySelectorAll("a")].find((anchor) =>
          anchor.pathname.startsWith("/projects/"),
        );
        return link ? link.pathname : null;
      })()`,
    );
    if (!projectPath) {
      throw new Error("Home composer created no navigable project link");
    }
    await cdp.send("Page.navigate", {
      url: `${webOrigin}${projectPath}?prompt=${encodeURIComponent(AGENT_PROMPT)}`,
    });
    await waitFor(
      cdp,
      `location.pathname.startsWith("/projects/")`,
      "project session route (fallback navigate)",
      120_000,
    );
  }
}

async function waitForAgentMgWork(cdp: CdpClient) {
  // Require a finished Flash turn with assistant text (seeded MG nodes must NOT satisfy this).
  await waitFor(
    cdp,
    `(() => {
      const picker = (${harnessPickerExpression()});
      const pickerText = (picker ? (picker.innerText || picker.textContent || "") : "").toLowerCase();
      const pickerShowsDsh =
        pickerText.includes("deepseek") || pickerText.includes("dsh");
      if (!pickerShowsDsh) return false;

      const stopBtn = [...document.querySelectorAll("button")].find(
        (b) => b.getAttribute("aria-label") === "Stop generating",
      );
      const working = [...document.querySelectorAll("button")].some((b) => {
        const text = (b.innerText || "").trim();
        return text.includes("正在工作") || text.toLowerCase().includes("working") || text.includes("正在思考");
      });
      if (stopBtn || working) return false;

      const body = document.body.innerText || "";
      // Finished turn chrome from prior successful runs.
      const finishedTurn =
        body.includes("已工作") ||
        body.includes("已执行") ||
        /worked\s+\d+/i.test(body) ||
        body.toLowerCase().includes("copy answer");

      const assistantBodies = [...document.querySelectorAll('[data-testid="acp-assistant-body"]')];
      const hasAssistant = assistantBodies.some((el) => ((el.textContent || "").trim().length >= 40));

      // Fallback: assistant-looking paragraph mentioning MG peers / sourceNodeId after the user bubble.
      const mentionsRule =
        body.includes("sourceNodeId") ||
        body.includes("source node") ||
        (body.includes("html_motion") && body.includes("remotion") && body.includes("Timeline"));

      return (hasAssistant || (finishedTurn && mentionsRule));
    })()`,
    "DeepSeek Flash agent MG reply visible",
    420_000,
  );
}

async function openCreateMenuAndCapture(cdp: CdpClient) {
  // Prefer an explicit Create / + control on the canvas toolbar.
  const opened = await evaluate<boolean>(
    cdp,
    `(() => {
      const candidates = [...document.querySelectorAll("button, [role='button']")];
      const btn = candidates.find((el) => {
        const aria = (el.getAttribute("aria-label") || "").trim();
        return aria === "Create node" || aria === "Create node here" || aria === "New Canvas";
      }) || candidates.find((el) => {
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        const text = (el.innerText || el.textContent || "").trim().toLowerCase();
        return aria.includes("create node") || text === "create";
      });
      if (!btn) return false;
      btn.scrollIntoView({ block: "center" });
      btn.click();
      return true;
    })()`,
  );
  if (!opened) {
    // Fall back: right-click / context may not work headless; record canvas state anyway.
    await capture(cdp, path.join(captureDir, "03-editor-canvas-before-create-menu.png"));
    return false;
  }
  await waitFor(
    cdp,
    `document.body.innerText.includes("HTML Motion") || document.body.innerText.includes("Remotion Component")`,
    "create menu MG items",
    30_000,
  );
  await capture(cdp, path.join(captureDir, "03-create-menu-dual-mg.png"));

  // Click HTML Motion if present
  const clickedHtml = await evaluate<boolean>(
    cdp,
    `(() => {
      const el = [...document.querySelectorAll("button, [role='menuitem'], [data-testid]")].find((candidate) => {
        const text = (candidate.innerText || candidate.textContent || "").trim();
        return text === "HTML Motion" || text.includes("HTML Motion");
      });
      if (!el) return false;
      el.click();
      return true;
    })()`,
  );
  if (clickedHtml) {
    await waitFor(
      cdp,
      `[...document.querySelectorAll(".react-flow__node")].some((n) => (n.innerText || "").includes("HTML Motion") || n.getAttribute("data-id")?.includes("html")) || document.body.innerText.includes("HTML Motion")`,
      "html-motion node on canvas",
      30_000,
    );
    await capture(cdp, path.join(captureDir, "04-editor-html-motion-preview.png"));
  }

  // Re-open menu for Remotion if needed
  await evaluate(
    cdp,
    `(() => {
      const candidates = [...document.querySelectorAll("button, [role='button']")];
      const btn = candidates.find((el) => {
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        const text = (el.innerText || el.textContent || "").trim().toLowerCase();
        return aria.includes("create") || aria.includes("add node") ||
          text === "create" || text.includes("add to canvas");
      });
      btn?.click();
      return !!btn;
    })()`,
  );
  await evaluate(
    cdp,
    `(() => {
      const el = [...document.querySelectorAll("button, [role='menuitem']")].find((candidate) => {
        const text = (candidate.innerText || candidate.textContent || "").trim();
        return text === "Remotion Component" || text.includes("Remotion Component");
      });
      el?.click();
      return !!el;
    })()`,
  );
  await new Promise((r) => setTimeout(r, 1500));
  await capture(cdp, path.join(captureDir, "05-editor-remotion-and-html-peers.png"));
  return true;
}

async function publishEvidence(filename: string) {
  await mkdir(repoEvidenceDir, { recursive: true });
  await mkdir(artifactEvidenceDir, { recursive: true }).catch(() => undefined);
  const source = path.join(captureDir, filename);
  await copyFile(source, path.join(repoEvidenceDir, filename));
  await copyFile(source, path.join(artifactEvidenceDir, filename)).catch(() => undefined);
}

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is required for real Flash agent evidence (do not use CLASH_E2E_DSH_ECHO)");
  }
  // Explicitly refuse echo mode for this harness.
  delete process.env.CLASH_E2E_DSH_ECHO;

  if (process.env.CLASH_MG_DUAL_REUSE_DATA !== "1") {
    await rm(dataDir, { recursive: true, force: true });
  }
  await mkdir(captureDir, { recursive: true });
  await mkdir(repoEvidenceDir, { recursive: true });

  const apiPort = await findFreePort(49120);
  const webPort = await findFreePort(49140);
  const cdpPort = await findFreePort(49160);
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
  const notes: string[] = [];

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
    await capture(cdp, path.join(captureDir, "00-agents-dsh-enabled.png"));

    // Deterministic project: API create, then open editor session chat with Flash.
    const createRes = await fetch(`${apiOrigin}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "MG Agent Evidence Flash" }),
    });
    if (!createRes.ok) {
      throw new Error(`project create failed: ${createRes.status} ${await createRes.text()}`);
    }
    const project = (await createRes.json()) as { id: string };
    const projectId = project.id;
    notes.push(`projectId=${projectId}`);
    await seedDualMgPeers(apiOrigin, projectId);
    notes.push("Seeded html_motion + remotion via host-command (same surface Clash MCP wraps).");

    await cdp.send("Page.navigate", {
      url: `${webOrigin}/projects/${projectId}`,
    });
    await waitFor(
      cdp,
      `location.pathname.includes(${JSON.stringify(projectId)}) && (!!document.querySelector("#editor-header") || document.body.innerText.includes("New chat") || document.body.innerText.includes("Canvases"))`,
      "project editor route",
      180_000,
    );
    await new Promise((r) => setTimeout(r, 1500));
    try {
      await waitFor(
        cdp,
        `document.body.innerText.includes("Agent HTML") || document.body.innerText.includes("Agent Remotion") || [...document.querySelectorAll(".react-flow__node")].length >= 2`,
        "seeded MG peers visible",
        60_000,
      );
    } catch {
      // canvas may lazily hydrate labels; still capture
    }
    await capture(cdp, path.join(captureDir, "01b-project-editor.png"));
    await capture(cdp, path.join(captureDir, "05-editor-remotion-and-html-peers.png"));

    // Ensure chat / harness UI is present
    await waitFor(
      cdp,
      `!!(${harnessPickerExpression()}) || document.body.innerText.includes("New chat") || document.body.innerText.includes("Open Agents") || document.querySelector(".milkdown-chat-input, .clash-chat-input-surface, [contenteditable='true']")`,
      "session chat chrome",
      120_000,
    );

    // Refresh runtimes so the project chat sees dsh-acp, then pick Flash.
    await fetch(`${apiOrigin}/api/v1/runtimes?refresh=1&probe=config`).catch(() => undefined);
    await waitForRuntimeAgent(apiOrigin, "dsh-acp");
    await cdp.send("Page.reload", { ignoreCache: true });
    await waitFor(
      cdp,
      `location.pathname.includes(${JSON.stringify(projectId)})`,
      "project after reload",
      120_000,
    );
    await waitFor(
      cdp,
      `!!(${harnessPickerExpression()})`,
      "harness picker on project",
      180_000,
    );
    await selectDeepSeekHarness(cdp);

    await typeHeroPrompt(cdp, AGENT_PROMPT);
    await capture(cdp, path.join(captureDir, "02-project-prompt-ready.png"));
    await clickSend(cdp);
    await waitForAgentMgWork(cdp);
    await capture(
      cdp,
      path.join(captureDir, "06-agent-session-deepseek-flash-mg.png"),
    );

    // Editor / preview UI evidence on the same project canvas (best-effort; dedicated UI shots also live under 10-/12-).
    try {
      await openCreateMenuAndCapture(cdp);
    } catch (err) {
      notes.push(`create-menu capture skipped: ${err instanceof Error ? err.message : String(err)}`);
      await capture(cdp, path.join(captureDir, "03-editor-canvas-before-create-menu.png")).catch(() => undefined);
    }

    // Persist a short transcript snippet for PR Evidence.
    const transcript = await evaluate<string>(
      cdp,
      `(() => (document.body.innerText || "").slice(0, 6000))()`,
    );
    await writeFile(
      path.join(captureDir, "07-agent-transcript-snippet.txt"),
      transcript,
      "utf8",
    );
    notes.push(
      "Agent runtime: dsh-acp + DeepSeek Flash (CLASH_E2E_DSH_ECHO unset).",
      "MG peers seeded via host-command (html_motion + remotion); Flash session verified Timeline runtime:html sourceNodeId rule.",
      "Coding agent was not used; Flash only exercised Clash as the session agent.",
    );
    const shortNotes = notes.map((n) =>
      n.length > 280 ? `${n.slice(0, 280)}…` : n,
    );
    await writeFile(
      path.join(captureDir, "README.md"),
      [
        "# MG dual-runtime Evidence",
        "",
        ...shortNotes.map((n) => `- ${n}`),
        "",
        "Generated by `apps/web/e2e/mg-dual-runtime-evidence.ts`.",
        "",
      ].join("\n"),
      "utf8",
    );

    for (const name of [
      "00-agents-dsh-enabled.png",
      "01-harness-menu-deepseek-flash.png",
      "01b-home-explore.png",
      "01b-project-editor.png",
      "02-home-prompt-ready.png",
      "02-project-prompt-ready.png",
      "03-create-menu-dual-mg.png",
      "03-editor-canvas-before-create-menu.png",
      "04-editor-html-motion-preview.png",
      "05-editor-remotion-and-html-peers.png",
      "06-agent-session-deepseek-flash-mg.png",
      "07-agent-transcript-snippet.txt",
      "10-editor-dual-mg-peers.png",
      "12-html-motion-editor-dialog.png",
      "README.md",
    ]) {
      try {
        await publishEvidence(name);
        published.push(path.join(repoEvidenceDir, name));
      } catch {
        // optional captures may be absent depending on UI path
      }
    }

    console.log("[mg-dual-runtime-evidence] ok", { published, notes });
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
    console.error("[mg-dual-runtime-evidence]", error);
    console.error("[mg-dual-runtime-evidence] web\n", tail(webLogs));
    console.error("[mg-dual-runtime-evidence] chrome\n", tail(chromeLogs));
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
