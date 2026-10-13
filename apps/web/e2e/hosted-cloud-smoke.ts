// Opt-in browser smoke against a deployed hosted Web origin (e.g. staging).
// It signs in with a dedicated test account, visits the authenticated
// surfaces, records every same-origin /api response, and fails when the
// gateway answers 5xx. It creates no data.
//
//   CLASH_HOSTED_WEB_URL=https://… CLASH_HOSTED_E2E_EMAIL=… \
//   CLASH_HOSTED_E2E_PASSWORD=… node e2e/hosted-cloud-smoke.ts
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CdpClient,
  assert,
  capture,
  chromeBinary,
  click,
  clickByText,
  evaluate,
  findFreePort,
  sleep,
  stopProcess,
  typeText,
  waitFor,
  waitForTarget,
} from "../../../scripts/e2e/harness.ts";

type ApiCall = { page: string; method: string; path: string; status: number };

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the hosted cloud smoke.`);
  return value;
}

const webOrigin = new URL(requiredEnv("CLASH_HOSTED_WEB_URL")).origin;
const email = requiredEnv("CLASH_HOSTED_E2E_EMAIL");
const password = requiredEnv("CLASH_HOSTED_E2E_PASSWORD");
const projectId = process.env.CLASH_HOSTED_E2E_PROJECT_ID?.trim();
const captureDir =
  process.env.CLASH_HOSTED_E2E_CAPTURE_DIR ??
  path.join(os.tmpdir(), "clash-hosted-cloud-smoke");
const chromeDataDir = path.join(os.tmpdir(), `clash-hosted-cloud-chrome-${process.pid}`);

// Same-origin API responses are recorded in the page because the shared CDP
// client is request/response only and does not surface Network events.
const recordApiCalls = `(() => {
  const calls = [];
  globalThis.__hostedSmokeApiCalls = calls;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await original(input, init);
    try {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
      if (url.origin === location.origin && url.pathname.startsWith("/api/")) {
        calls.push({
          method: (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase(),
          path: url.pathname,
          status: response.status,
        });
      }
    } catch {}
    return response;
  };
})()`;

async function main() {
  await mkdir(captureDir, { recursive: true });
  const cdpPort = await findFreePort(49880);
  const screenshots: string[] = [];
  const apiCalls: ApiCall[] = [];
  let chrome: ChildProcess | null = null;
  let cdp: CdpClient | null = null;

  const visit = async (label: string, pathname?: string) => {
    assert(cdp, "CDP client is not connected");
    if (pathname) {
      await cdp.send("Page.navigate", { url: `${webOrigin}${pathname}` });
    }
    await waitFor(cdp, `document.readyState === "complete"`, `${label} load`, 30000);
    // Client loaders fetch after the shell renders; give them time to settle.
    await sleep(4000);
    const target = path.join(captureDir, `${label}.png`);
    await capture(cdp, target);
    screenshots.push(target);
    const calls = await evaluate<Array<Omit<ApiCall, "page">>>(
      cdp,
      `(globalThis.__hostedSmokeApiCalls ?? []).splice(0)`,
    );
    for (const call of calls) apiCalls.push({ page: label, ...call });
    return evaluate<string>(cdp, "location.pathname");
  };

  try {
    chrome = spawn(chromeBinary(), [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${chromeDataDir}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--window-size=1440,1000",
      "about:blank",
    ], { stdio: "ignore" });

    cdp = new CdpClient(await waitForTarget(cdpPort));
    await cdp.ready();
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: recordApiCalls });

    await visit("01-login", "/login");
    await waitFor(cdp, `!!document.querySelector('input[type="email"]')`, "email field", 20000);
    // The default login mode is the emailed verification code.
    await clickByText(cdp, "Use email and password");
    await waitFor(cdp, `!!document.querySelector('input[type="password"]')`, "password field", 10000);
    await typeText(cdp, 'input[type="email"]', email);
    await typeText(cdp, 'input[type="password"]', password);
    await capture(cdp, path.join(captureDir, "02-login-filled.png"));
    screenshots.push(path.join(captureDir, "02-login-filled.png"));
    await click(cdp, `document.querySelector('form button[type="submit"]')`, "login submit");
    const signInStartedAt = Date.now();
    try {
      // A cold hosted Worker has taken ~20s to answer the first sign-in.
      await waitFor(cdp, `location.pathname !== "/login"`, "post-login navigation", 90000);
    } catch (error) {
      await visit("03-login-stuck");
      console.error(JSON.stringify({ apiCalls }, null, 2));
      throw error;
    }
    const signInMs = Date.now() - signInStartedAt;
    const landed = await visit("03-after-login");

    const projectsPath = await visit("04-projects", "/projects");
    const assetsPath = await visit("05-assets", "/assets");
    const settingsPath = await visit("06-settings", "/settings");
    const projectPath = projectId
      ? await visit("07-project", `/project/${encodeURIComponent(projectId)}`)
      : null;

    const serverErrors = apiCalls.filter((call) => call.status >= 500);
    const report = {
      webOrigin,
      landed,
      signInMs,
      pages: { projectsPath, assetsPath, settingsPath, projectPath },
      apiCalls,
      serverErrors,
      screenshots,
    };
    await writeFile(path.join(captureDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));

    assert(projectsPath === "/projects", "Signed-in user was redirected away from /projects", report.pages);
    assert(serverErrors.length === 0, "Hosted gateway returned 5xx to the signed-in Web app", serverErrors);
  } finally {
    cdp?.close();
    await stopProcess(chrome);
    await rm(chromeDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
