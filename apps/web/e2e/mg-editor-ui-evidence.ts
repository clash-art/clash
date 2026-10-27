/**
 * Editor/preview UI Evidence for dual MG (#444) and PreviewHost-adjacent canvas (#442).
 * Seeds html_motion + remotion via host-command, opens ProjectEditor, captures screenshots.
 *
 *   CHROME_BIN=/usr/bin/google-chrome pnpm exec tsx apps/web/e2e/mg-editor-ui-evidence.ts
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
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
  waitFor,
  waitForHttp,
  waitForTarget,
} from "../../../scripts/e2e/harness.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webDir, "..", "..");
const captureDir =
  process.env.CLASH_MG_EDITOR_CAPTURE_DIR ??
  path.join(repoRoot, "docs/evidence/mg-dual-runtime");
const dataDir =
  process.env.CLASH_MG_EDITOR_DATA_DIR ??
  path.join(repoRoot, ".tmp", "mg-editor-ui-evidence-data");

const HTML_DOC = `<!doctype html><html><head><meta charset="utf-8"/><style>
html,body{margin:0;height:100%;display:grid;place-items:center;background:#0f172a;color:#e2e8f0;font:600 42px Inter,system-ui,sans-serif}
</style></head><body><h1>HTML Motion Evidence</h1></body></html>`;

const REMOTION_SRC = `import React from "react";
import { AbsoluteFill } from "remotion";
const EvidenceTitle: React.FC = () => (
  <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", background: "#111", color: "white", fontSize: 48 }}>
    Remotion Evidence
  </AbsoluteFill>
);
export default EvidenceTitle;
`;

async function main() {
  await mkdir(captureDir, { recursive: true });
  const apiPort = await findFreePort(49320);
  const webPort = await findFreePort(49340);
  const cdpPort = await findFreePort(49360);
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

  let chrome;
  let cdp: CdpClient | undefined;
  try {
    await waitForHttp(`${apiOrigin}/health`, "local-api");
    await waitForHttp(webOrigin, "vite");

    const createRes = await fetch(`${apiOrigin}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "MG Dual Evidence" }),
    });
    if (!createRes.ok) {
      throw new Error(`project create failed: ${createRes.status} ${await createRes.text()}`);
    }
    const project = (await createRes.json()) as { id: string };
    const projectId = project.id;

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
      return json as { node_id?: string; node?: { type?: string } };
    };

    const htmlNode = await hostAdd({
      action: "add",
      type: "html_motion",
      label: "Evidence HTML Motion",
      content: HTML_DOC,
      actorClientType: "cli",
    });
    const remotionNode = await hostAdd({
      action: "add",
      type: "remotion",
      label: "Evidence Remotion",
      content: REMOTION_SRC,
      actorClientType: "cli",
    });

    chrome = spawn(
      chromeBinary(),
      [
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${path.join(dataDir, "chrome")}`,
        "--headless=new",
        "--no-first-run",
        "--window-size=1440,1100",
        `${webOrigin}/projects/${projectId}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    cdp = new CdpClient(await waitForTarget(cdpPort));
    await cdp.ready();
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    await waitFor(
      cdp,
      `location.pathname.includes(${JSON.stringify(projectId)}) && !!document.querySelector("#editor-header, .react-flow, [data-testid='html-motion-preview'], body")`,
      "project editor",
      120_000,
    );
    // Wait for RF nodes / labels
    await waitFor(
      cdp,
      `document.body.innerText.includes("Evidence HTML Motion") || document.body.innerText.includes("HTML Motion") || [...document.querySelectorAll(".react-flow__node")].length > 0`,
      "canvas nodes visible",
      120_000,
    );
    await new Promise((r) => setTimeout(r, 2000));
    await evaluate(
      cdp,
      `(() => {
        const fit = [...document.querySelectorAll("button")].find((b) => {
          const aria = (b.getAttribute("aria-label") || "").toLowerCase();
          return aria.includes("fit") || aria.includes("zoom to fit");
        });
        fit?.click();
        // Also try React Flow controls
        const ctrl = document.querySelector(".react-flow__controls-fitview");
        if (ctrl) ctrl.click();
        return true;
      })()`,
    );
    await new Promise((r) => setTimeout(r, 1000));
    await capture(cdp, path.join(captureDir, "10-editor-dual-mg-peers.png"));

    // Open create menu via toolbar +
    await evaluate(
      cdp,
      `(() => {
        const plus = [...document.querySelectorAll("button")].find((b) => {
          const aria = (b.getAttribute("aria-label") || "").toLowerCase();
          return aria.includes("create") || aria === "add" || aria.includes("create node");
        });
        plus?.click();
        return !!plus;
      })()`,
    );
    await new Promise((r) => setTimeout(r, 600));

    // Open create menu via pane context if possible
    await evaluate(
      cdp,
      `(() => {
        const pane = document.querySelector(".react-flow__pane") || document.querySelector(".react-flow");
        if (!pane) return false;
        const rect = pane.getBoundingClientRect();
        const evt = new MouseEvent("contextmenu", {
          bubbles: true, cancelable: true, clientX: rect.left + 80, clientY: rect.top + 80, button: 2,
        });
        pane.dispatchEvent(evt);
        return true;
      })()`,
    );
    await new Promise((r) => setTimeout(r, 800));
    const menuVisible = await evaluate<boolean>(
      cdp,
      `document.body.innerText.includes("HTML Motion") && document.body.innerText.includes("Remotion Component")`,
    );
    if (menuVisible) {
      await capture(cdp, path.join(captureDir, "11-create-menu-html-and-remotion.png"));
    }

    // Click Edit HTML on html-motion node if present
    await evaluate(
      cdp,
      `(() => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
          (b.getAttribute("aria-label") || "").includes("Edit HTML") ||
          (b.innerText || "").trim() === "Edit HTML"
        );
        btn?.click();
        return !!btn;
      })()`,
    );
    await new Promise((r) => setTimeout(r, 1000));
    await capture(cdp, path.join(captureDir, "12-html-motion-editor-dialog.png"));

    await writeFile(
      path.join(captureDir, "10-editor-ui-README.md"),
      [
        "# Editor/preview UI Evidence",
        "",
        `- Project: ${projectId}`,
        `- html_motion node: ${htmlNode.node_id ?? "?"} (${htmlNode.node?.type ?? "html-motion"})`,
        `- remotion node: ${remotionNode.node_id ?? "?"} (${remotionNode.node?.type ?? "remotion-component"})`,
        "- Seeded via `POST /host-command` with types `html_motion` + `remotion` (agent/CLI surface).",
        "- Screenshots: dual peers on canvas, create menu (when available), HTML editor dialog.",
        "",
      ].join("\n"),
    );

    console.log("[mg-editor-ui-evidence] ok", {
      projectId,
      htmlNode: htmlNode.node_id,
      remotionNode: remotionNode.node_id,
      captureDir,
    });
  } catch (error) {
    process.exitCode = 1;
    if (cdp) {
      try {
        await capture(cdp, path.join(captureDir, "10-editor-ui-failure.png"));
      } catch {
        // ignore
      }
    }
    console.error("[mg-editor-ui-evidence]", error);
    console.error(webLogs.slice(-30).join(""));
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
