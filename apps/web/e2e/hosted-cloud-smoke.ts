// Opt-in browser smoke against a deployed hosted Web origin (e.g. staging).
// It signs in with a dedicated test account, visits the authenticated
// surfaces, records every same-origin document and /api response from CDP
// Network events, and fails when the gateway answers 5xx or bounces a
// signed-in route back to /login. It creates no data.
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

type RecordedResponse = {
  page: string;
  kind: "document" | "api";
  method: string;
  path: string;
  status: number;
};

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

// A cold hosted Worker has taken ~20s to answer the first sign-in.
const SIGN_IN_TIMEOUT_MS = 90_000;
const IDLE_QUIET_MS = 750;
const IDLE_TIMEOUT_MS = 45_000;

/** Tracks same-origin traffic from CDP Network events, including navigations. */
function observeNetwork(cdp: CdpClient) {
  const responses: RecordedResponse[] = [];
  const inFlight = new Map<string, { method: string; url: string }>();
  let currentPage = "startup";
  let lastActivityAt = Date.now();

  cdp.on<{ requestId: string; type?: string; request: { method: string; url: string } }>(
    "Network.requestWillBeSent",
    ({ requestId, type, request }) => {
      lastActivityAt = Date.now();
      // Long-lived streams never finish and must not hold the page "busy".
      if (type === "WebSocket" || type === "EventSource") return;
      inFlight.set(requestId, { method: request.method, url: request.url });
    },
  );
  cdp.on<{ requestId: string; type?: string; response: { url: string; status: number } }>(
    "Network.responseReceived",
    ({ requestId, type, response }) => {
      lastActivityAt = Date.now();
      let url: URL;
      try {
        url = new URL(response.url);
      } catch {
        return;
      }
      if (url.origin !== webOrigin) return;
      const kind = type === "Document" ? "document" : url.pathname.startsWith("/api/") ? "api" : null;
      if (!kind) return;
      responses.push({
        page: currentPage,
        kind,
        method: inFlight.get(requestId)?.method ?? "GET",
        path: url.pathname,
        status: response.status,
      });
    },
  );
  const settle = ({ requestId }: { requestId: string }) => {
    lastActivityAt = Date.now();
    inFlight.delete(requestId);
  };
  cdp.on("Network.loadingFinished", settle);
  cdp.on("Network.loadingFailed", settle);

  return {
    responses,
    setPage(label: string) {
      currentPage = label;
      lastActivityAt = Date.now();
    },
    async idle(label: string) {
      const deadline = Date.now() + IDLE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (inFlight.size === 0 && Date.now() - lastActivityAt >= IDLE_QUIET_MS) return;
        await sleep(100);
      }
      throw new Error(
        `Timed out waiting for network idle on ${label}: ${JSON.stringify([...inFlight.values()].slice(0, 5))}`,
      );
    },
  };
}

async function main() {
  await mkdir(captureDir, { recursive: true });
  const cdpPort = await findFreePort(49880);
  const screenshots: string[] = [];
  const pages: Record<string, { expected: string; landed: string }> = {};
  let responses: RecordedResponse[] = [];
  let signInMs: number | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: CdpClient | null = null;
  let failure: unknown = null;

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

    const client = new CdpClient(await waitForTarget(cdpPort));
    cdp = client;
    await client.ready();
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    const network = observeNetwork(client);
    responses = network.responses;
    await client.send("Network.enable");

    const shoot = async (label: string) => {
      const target = path.join(captureDir, `${label}.png`);
      await capture(client, target);
      screenshots.push(target);
    };
    const visit = async (label: string, pathname: string) => {
      network.setPage(label);
      await client.send("Page.navigate", { url: `${webOrigin}${pathname}` });
      await waitFor(client, `document.readyState === "complete"`, `${label} load`, 30000);
      await network.idle(label);
      await shoot(label);
      const landed = await evaluate<string>(client, "location.pathname");
      pages[label] = { expected: pathname, landed };
      return landed;
    };

    await visit("01-login", "/login");
    await waitFor(client, `!!document.querySelector('input[type="email"]')`, "email field", 20000);
    // The default login mode is the emailed verification code.
    await clickByText(client, "Use email and password");
    await waitFor(client, `!!document.querySelector('input[type="password"]')`, "password field", 10000);
    await typeText(client, 'input[type="email"]', email);
    await typeText(client, 'input[type="password"]', password);
    await shoot("02-login-filled");

    network.setPage("03-after-login");
    const signInStartedAt = Date.now();
    await click(client, `document.querySelector('form button[type="submit"]')`, "login submit");
    try {
      await waitFor(client, `location.pathname !== "/login"`, "post-login navigation", SIGN_IN_TIMEOUT_MS);
    } catch (error) {
      await shoot("03-login-stuck");
      throw error;
    }
    signInMs = Date.now() - signInStartedAt;
    await network.idle("03-after-login");
    await shoot("03-after-login");

    await visit("04-projects", "/projects");
    await visit("05-assets", "/assets");
    await visit("06-settings", "/settings");
    if (projectId) await visit("07-project", `/project/${encodeURIComponent(projectId)}`);

    for (const [label, page] of Object.entries(pages)) {
      if (label === "01-login") continue;
      assert(
        page.landed === page.expected,
        `Signed-in route ${page.expected} was redirected to ${page.landed}`,
        pages,
      );
    }
    const serverErrors = responses.filter((response) => response.status >= 500);
    assert(serverErrors.length === 0, "Hosted origin returned 5xx to the signed-in Web app", serverErrors);
  } catch (error) {
    failure = error;
  } finally {
    // The report is the evidence for a failed run too, including a failed sign-in.
    const report = {
      webOrigin,
      ok: failure === null,
      error: failure === null ? null : failure instanceof Error ? failure.message : String(failure),
      signInMs,
      pages,
      serverErrors: responses.filter((response) => response.status >= 500),
      responses,
      screenshots,
    };
    await writeFile(path.join(captureDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ ...report, responses: undefined }, null, 2));
    cdp?.close();
    await stopProcess(chrome);
    await rm(chromeDataDir, { recursive: true, force: true });
  }
  if (failure !== null) throw failure;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
