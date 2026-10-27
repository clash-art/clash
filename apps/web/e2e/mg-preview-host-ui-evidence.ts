/**
 * #442 / #441 PreviewHost editor/preview UI Evidence.
 * Opens the Remotion preview-probe (main-thread + iframe producer) and captures screenshots.
 *
 *   CHROME_BIN=/usr/bin/google-chrome pnpm exec tsx apps/web/e2e/mg-preview-host-ui-evidence.ts
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CdpClient,
  capture,
  chromeBinary,
  findFreePort,
  startViteDevServer,
  stopProcess,
  waitForHttp,
  waitForTarget,
} from "../../../scripts/e2e/harness.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webDir, "..", "..");
const captureDir =
  process.env.CLASH_MG_PREVIEW_CAPTURE_DIR ??
  path.join(repoRoot, "docs/evidence/mg-preview-host");
const artifactDir = "/opt/cursor/artifacts/mg-preview-host";

async function publish(name: string) {
  await mkdir(captureDir, { recursive: true });
  await mkdir(artifactDir, { recursive: true }).catch(() => undefined);
  const src = path.join(captureDir, name);
  await copyFile(src, path.join(artifactDir, name)).catch(() => undefined);
}

async function main() {
  await mkdir(captureDir, { recursive: true });
  const webPort = await findFreePort(49240);
  const cdpPort = await findFreePort(49260);
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const { child: web, logs } = await startViteDevServer({
    webDir,
    repoRoot,
    port: webPort,
    env: {},
  });
  let chrome;
  let cdp: CdpClient | undefined;
  try {
    await waitForHttp(webOrigin, "vite web");
    chrome = spawn(
      chromeBinary(),
      [
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${path.join(repoRoot, ".tmp", "mg-preview-host-chrome")}`,
        "--headless=new",
        "--no-first-run",
        "--window-size=1280,800",
        `${webOrigin}/e2e/preview-probe.html`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    cdp = new CdpClient(await waitForTarget(cdpPort));
    await cdp.ready();
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    // Wait for Player / probe ready marker if present
    await new Promise((r) => setTimeout(r, 4000));
    await capture(cdp, path.join(captureDir, "01-preview-probe-main-thread.png"));
    await writeFile(
      path.join(captureDir, "README.md"),
      [
        "# PreviewHost UI Evidence (#442 / #441)",
        "",
        "- `01-preview-probe-main-thread.png` — Remotion Player preview probe page (producer that PreviewHost hosts).",
        "- Isolation path: cross-site iframe (see `preview-iframe-longtask.ts` + spike report); no audio master clock.",
        "- Agent-side MG evidence for dual runtime lives under `docs/evidence/mg-dual-runtime/` (dsh + DeepSeek Flash as Clash Agent).",
        "",
      ].join("\n"),
    );
    await publish("01-preview-probe-main-thread.png");
    await publish("README.md");
    console.log("[mg-preview-host-ui-evidence] ok", { captureDir });
  } catch (error) {
    console.error("[mg-preview-host-ui-evidence]", error);
    console.error(logs.slice(-40).join(""));
    process.exitCode = 1;
    throw error;
  } finally {
    cdp?.close();
    await stopProcess(chrome);
    await stopProcess(web);
  }
}

void main();
