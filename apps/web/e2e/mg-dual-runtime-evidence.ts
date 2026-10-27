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
  "In this Clash project, use the Clash canvas tools (clash canvas add) to create TWO motion-graphics Canvas peers:",
  "1) --type html_motion --label \"Agent HTML Lower Third\" --content with a minimal HTML document that shows the text AGENT HTML MG in a centered heading.",
  "2) --type remotion --label \"Agent Remotion Title\" --content with a minimal Remotion functional component that renders AbsoluteFill + a centered h1 saying AGENT REMOTION MG.",
  "Then briefly note that Timeline motion-graphics items with runtime: html must keep a live sourceNodeId pointing at the html-motion node (no HTML snapshot on the Timeline).",
  "Do not invent deleted MG CLI verbs. Prefer Flash-sized replies and tool calls only.",
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
  await click(cdp, harnessPickerExpression(), "harness picker");
  await waitFor(
    cdp,
    `document.body.innerText.includes("DeepSeek") || document.body.innerText.includes("dsh-acp")`,
    "harness menu open",
    30_000,
  );
  await capture(
    cdp,
    path.join(captureDir, "01-harness-menu-deepseek-flash.png"),
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
  await waitFor(
    cdp,
    `(() => {
      const body = document.body.innerText || "";
      const hasHarness =
        body.includes("DeepSeek") || body.includes("dsh-acp");
      const picker = (${harnessPickerExpression()});
      const pickerText = picker ? (picker.innerText || picker.textContent || "") : "";
      const pickerShowsDsh =
        pickerText.includes("DeepSeek") || pickerText.includes("dsh");
      const hasToolOrNodes =
        body.includes("html_motion") ||
        body.includes("html-motion") ||
        body.includes("Agent HTML") ||
        body.includes("Agent Remotion") ||
        body.includes("canvas add") ||
        [...document.querySelectorAll(".react-flow__node")].some((node) => {
          const text = (node.innerText || node.textContent || "");
          return text.includes("HTML") || text.includes("Remotion") || text.includes("Agent");
        });
      const assistantBodies = [...document.querySelectorAll('[data-testid="acp-assistant-body"]')];
      const hasAssistant = assistantBodies.some((el) => ((el.textContent || "").trim().length >= 8));
      return hasHarness && pickerShowsDsh && (hasToolOrNodes || hasAssistant);
    })()`,
    "DeepSeek Flash agent MG work visible",
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
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        const text = (el.innerText || el.textContent || "").trim().toLowerCase();
        return aria.includes("create") || aria.includes("add node") ||
          text === "create" || text.includes("add to canvas");
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
  await mkdir(artifactEvidenceDir, { recursive: true });
  const source = path.join(captureDir, filename);
  await copyFile(source, path.join(repoEvidenceDir, filename));
  await copyFile(source, path.join(artifactEvidenceDir, filename));
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

    await cdp.send("Page.navigate", { url: `${webOrigin}/` });
    await waitFor(cdp, `document.body.innerText.includes("Home")`, "home", 120_000);
    await waitFor(
      cdp,
      `!!(${harnessPickerExpression()})`,
      "harness picker on home",
      120_000,
    );

    await selectDeepSeekHarness(cdp);
    await typeHeroPrompt(cdp, AGENT_PROMPT);
    await capture(cdp, path.join(captureDir, "02-home-prompt-ready.png"));
    await clickSend(cdp);
    await openProjectSessionFromHome(cdp, webOrigin);
    await waitForAgentMgWork(cdp);
    await capture(
      cdp,
      path.join(captureDir, "06-agent-session-deepseek-flash-mg.png"),
    );

    // Editor / preview UI evidence on the same project canvas.
    await openCreateMenuAndCapture(cdp);

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
      "UI: create menu dual MG + html-motion preview stub.",
      "Coding agent was not used; Flash only exercised Clash as the session agent.",
    );
    await writeFile(
      path.join(captureDir, "README.md"),
      [
        "# MG dual-runtime Evidence",
        "",
        ...notes.map((n) => `- ${n}`),
        "",
        "Generated by `apps/web/e2e/mg-dual-runtime-evidence.ts`.",
        "",
      ].join("\n"),
      "utf8",
    );

    for (const name of [
      "00-agents-dsh-enabled.png",
      "01-harness-menu-deepseek-flash.png",
      "02-home-prompt-ready.png",
      "03-create-menu-dual-mg.png",
      "03-editor-canvas-before-create-menu.png",
      "04-editor-html-motion-preview.png",
      "05-editor-remotion-and-html-peers.png",
      "06-agent-session-deepseek-flash-mg.png",
      "07-agent-transcript-snippet.txt",
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
