import { loadHostServer, type ClosableServer } from "./host-artifacts.ts";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CdpClient,
  assert,
  capture,
  chromeBinary,
  click,
  clickByText,
  evaluate,
  findFreePort,
  startViteDevServer,
  stopProcess,
  tail,
  typeText,
  waitFor,
  waitForHttp,
  waitForTarget,
} from "../../../scripts/e2e/harness.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webDir, "..", "..");

const dataDir = process.env.CLASH_WEB_GUI_E2E_DATA_DIR ?? path.join(repoRoot, ".tmp", "web-gui-e2e-local-api-data");
const chromeDataDir = process.env.CLASH_WEB_GUI_E2E_CHROME_DATA_DIR ?? path.join(repoRoot, ".tmp", "web-gui-e2e-chrome");
const captureDir = process.env.CLASH_WEB_GUI_E2E_CAPTURE_DIR ?? path.join(repoRoot, ".tmp", "web-gui-e2e-captures");
const latestScreenshot = path.join(captureDir, "latest-web-gui.png");

async function readRequestBody(req: IncomingMessage) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function startMockReplicateApi() {
  const port = await findFreePort(49750);
  const origin = `http://127.0.0.1:${port}`;
  const requests: Array<{ method: string; path: string; authorization?: string; body?: unknown }> = [];
  const predictionId = "replicate-gui-smoke-1";
  const mediaUrl = `${origin}/media/${predictionId}.png`;
  const prediction = {
    id: predictionId,
    status: "succeeded",
    output: [mediaUrl],
    urls: { get: `${origin}/v1/predictions/${predictionId}` },
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", origin);
    if (url.pathname === "/v1/models/google/nano-banana-2/predictions" && req.method === "POST") {
      const raw = await readRequestBody(req);
      requests.push({
        method: req.method,
        path: url.pathname,
        authorization: req.headers.authorization ?? "",
        body: raw.byteLength ? JSON.parse(raw.toString("utf8")) : {},
      });
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify(prediction));
      return;
    }
    if (url.pathname === `/v1/predictions/${predictionId}` && req.method === "GET") {
      requests.push({
        method: req.method,
        path: url.pathname,
        authorization: req.headers.authorization ?? "",
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(prediction));
      return;
    }
    if (url.pathname === `/media/${predictionId}.png` && req.method === "GET") {
      requests.push({ method: req.method, path: url.pathname });
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from("replicate-gui-smoke-image"));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    url: `${origin}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startWeb({ webPort, apiOrigin }: { webPort: number; apiOrigin: string }) {
  return startViteDevServer({
    webDir,
    repoRoot,
    port: webPort,
    env: {
      VITE_CLASH_API_BASE_URL: apiOrigin,
      VITE_CLASH_WS_BASE_URL: apiOrigin.replace("http:", "ws:"),
    },
  });
}

async function assertNoCriticalA11yRegressions(cdp: CdpClient) {
  const state = await evaluate<{ bodyColor: string; bodyBackground: string; unlabeled: unknown[] }>(cdp, `(() => {
    const visibleControls = [...document.querySelectorAll("button, a, input, textarea, [role='button'], [role='menuitem']")]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none";
      })
      .map((el) => ({
        tag: el.tagName,
        role: el.getAttribute("role"),
        aria: el.getAttribute("aria-label"),
        text: (el.innerText || el.textContent || el.getAttribute("placeholder") || "").trim(),
        id: el.id,
      }));
    const unlabeled = visibleControls.filter((el) =>
      (el.tag === "BUTTON" || el.role === "button" || el.role === "menuitem") &&
      !el.aria &&
      !el.text &&
      !el.id
    );
    const body = getComputedStyle(document.body);
    return {
      bodyColor: body.color,
      bodyBackground: body.backgroundColor,
      unlabeled: unlabeled.slice(0, 8),
    };
  })()`);
  assert(
    !(state.bodyColor === "rgb(255, 255, 255)" && state.bodyBackground !== "rgb(0, 0, 0)"),
    "body text must stay readable on the page background",
    state,
  );
  assert(state.unlabeled.length === 0, "visible clickable controls need text or aria labels", state);
}

async function openSettingsFromHome(cdp: CdpClient) {
  await waitFor(cdp, `document.body.innerText.includes("Home")`, "home content");
  const hasSettingsLink = await evaluate(cdp, `!!document.querySelector("a[aria-label='Settings']")`);
  if (hasSettingsLink) {
    await click(cdp, `document.querySelector("a[aria-label='Settings']")`, "Settings link");
    await waitFor(cdp, `location.pathname === "/settings" && document.body.innerText.includes("Settings")`, "settings page");
    return;
  }
  await click(
    cdp,
    `([...document.querySelectorAll("button")].find((button) => {
      const label = button.getAttribute("aria-label") || "";
      const text = (button.innerText || button.textContent || "").trim();
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && (label.includes("Account menu") || text.includes("Local User") || text === "?");
    }))`,
    "account menu",
  );
  await clickByText(cdp, "Settings", "Settings menu item");
  await waitFor(cdp, `document.querySelector('[role="dialog"]')?.innerText.includes("Runtimes")`, "settings dialog");
}

async function exerciseSettingsDialog(cdp: CdpClient) {
  await openSettingsFromHome(cdp);
  const hasApiKeysSection = await evaluate(cdp, `([...document.querySelectorAll("button, [role='tab']")].some((el) => {
    const text = (el.innerText || el.textContent || "").trim();
    return text === "API Keys";
  }))`);
  if (!hasApiKeysSection) return;
  await clickByText(cdp, "API Keys", "API Keys settings section");
  await waitFor(cdp, `document.body.innerText.includes("OpenAI image generation")`, "API Keys section");
  await click(
    cdp,
    `document.querySelector("button[aria-label='OpenAI · OPENAI_API_KEY']")`,
    "OpenAI provider preset",
  );
  const keyValue = await evaluate(cdp, `(() => {
    const input = [...document.querySelectorAll("input")].find((el) => el.placeholder === "KEY_NAME");
    return input?.value ?? "";
  })()`);
  assert(keyValue === "OPENAI_API_KEY", "provider preset fills the variable key input", { keyValue });
  const hasCloseButton = await evaluate(cdp, `!!document.querySelector("button[aria-label='Close settings']")`);
  if (hasCloseButton) {
    await click(cdp, `document.querySelector("button[aria-label='Close settings']")`, "Close settings");
    await waitFor(cdp, `!document.querySelector('[role="dialog"]')`, "settings dialog closes");
  }
}

async function seedMockProvider(apiOrigin: string) {
  const res = await fetch(`${apiOrigin}/api/v1/model-providers`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      providers: [
        {
          id: "mock-primary",
          label: "Mock primary",
          providerId: "mock",
          upstreamId: "mock",
          enabled: true,
          priority: 10,
        },
        {
          id: "replicate-primary",
          label: "Replicate primary",
          providerId: "replicate",
          upstreamId: "replicate",
          enabled: true,
          priority: 20,
          credentials: { apiKey: "r8-gui-smoke-key" },
        },
        {
          id: "replicate-secondary",
          label: "Replicate secondary",
          providerId: "replicate",
          upstreamId: "replicate",
          enabled: true,
          priority: 30,
          credentials: { apiKey: "r8-gui-smoke-key-2" },
        },
      ],
    }),
  });
  assert(res.ok, "mock provider seed should save", { status: res.status, body: await res.text().catch(() => "") });
  const test = await fetch(`${apiOrigin}/api/v1/model-providers/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: { id: "mock-primary", providerId: "mock", upstreamId: "mock", enabled: true },
      modelId: "nano-banana-2",
    }),
  });
  assert(test.ok, "mock provider test endpoint should be reachable", {
    status: test.status,
    body: await test.text().catch(() => ""),
  });
}

async function exerciseProviderModelRouting(cdp: CdpClient, { webOrigin, apiOrigin }: { webOrigin: string; apiOrigin: string }) {
  await seedMockProvider(apiOrigin);
  await cdp.send("Page.navigate", { url: `${webOrigin}/settings?section=providers` });
  await waitFor(cdp, `document.body.innerText.includes("BYOK")`, "BYOK settings page");
  await evaluate(cdp, `(() => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = ${JSON.stringify({
      mode: "desktop",
      apiBaseUrl: apiOrigin,
      wsBaseUrl: apiOrigin.replace("http:", "ws:"),
    })};
    return true;
  })()`);
  await click(
    cdp,
    `document.querySelector("button[aria-label='Open Mock Provider BYOK settings']")`,
    "Mock Provider settings row",
  );
  await waitFor(
    cdp,
    `document.body.innerText.includes("Mock primary") || document.body.innerText.includes("API key 1")`,
    "mock provider config row",
  );
  await click(
    cdp,
    `([...document.querySelectorAll("button[aria-label^='Expand ']")].find((button) => {
      const label = button.getAttribute("aria-label") || "";
      return label.includes("Mock primary") || label.includes("API key 1");
    }))`,
    "Expand mock provider config",
  );
  await waitFor(
    cdp,
    `document.body.innerText.includes("Model to test") && !!document.querySelector("button[aria-label='Run provider test']")`,
    "provider test controls",
  );
  await click(
    cdp,
    `document.querySelector("button[aria-label='Run provider test']")`,
    "Run mock provider test",
  );
  await waitFor(
    cdp,
    `document.body.innerText.includes("Mock provider ran Nano Banana 2 through fal-ai/nano-banana-2.")`,
    "mock provider test result",
  );
  await click(
    cdp,
    `document.querySelector("button[aria-label='Model access']")`,
    "Open model access menu",
  );
  await click(
    cdp,
    `([...document.querySelectorAll("[role='menuitemradio'], [role='option']")].find((item) => (item.innerText || item.textContent || "").includes("Specific models")))`,
    "Select specific model access",
  );
  await waitFor(
    cdp,
    `!!document.querySelector("button[aria-label='Add supported model']")`,
    "specific model access controls",
  );
  await click(
    cdp,
    `document.querySelector("button[aria-label='Add supported model']")`,
    "Open supported model picker",
  );
  await click(
    cdp,
    `([...document.querySelectorAll("[role='listbox'] [role='option']")].find((item) => (item.innerText || item.textContent || "").includes("GPT Image 2")))`,
    "Add GPT Image 2 to mock account access",
  );
  await waitFor(
    cdp,
    `document.body.innerText.includes("GPT Image 2") && (() => {
      const editor = document.querySelector("[aria-label='Mock primary Mock Provider API key']");
      return !![...(editor?.querySelectorAll("button") ?? [])].find((button) => (button.innerText || button.textContent || "").trim() === "Save" && !button.disabled);
    })()`,
    "mock provider model allowlist draft",
  );
  await click(
    cdp,
    `(() => {
      const editor = document.querySelector("[aria-label='Mock primary Mock Provider API key']");
      return [...(editor?.querySelectorAll("button") ?? [])].find((button) => (button.innerText || button.textContent || "").trim() === "Save" && !button.disabled);
    })()`,
    "Save mock provider model allowlist",
  );
  await waitFor(
    cdp,
    `fetch(${JSON.stringify(`${apiOrigin}/api/v1/model-providers`)})
      .then((res) => res.json())
      .then((json) => json.providers?.some((provider) =>
        provider.id === "mock-primary" &&
        Array.isArray(provider.supportedModelIds) &&
        provider.supportedModelIds.length === 1 &&
        provider.supportedModelIds[0] === "gpt-image-2"
      ))
      .catch(() => false)`,
    "mock provider model allowlist saved",
  );
  await click(
    cdp,
    `document.querySelector("a[aria-label='View supported models']")`,
    "View mock supported models",
  );
  await waitFor(
    cdp,
    `location.pathname === "/settings" &&
      location.search.includes("section=models") &&
      location.search.includes("provider=mock%3Amock%3A") &&
      document.body.innerText.includes("Models supported by Mock Provider")`,
    "mock provider scoped models page",
  );
  await click(
    cdp,
    `document.querySelector("button[aria-label='Edit provider order for GPT Image 2']")`,
    "Open GPT Image 2 provider order",
  );
  await waitFor(
    cdp,
    `!!document.querySelector("[aria-label='GPT Image 2 provider order']")`,
    "GPT Image 2 provider order list",
  );
  await click(
    cdp,
    `document.querySelector("button[aria-label='Move Replicate up for GPT Image 2']")`,
    "Move Replicate above mock for GPT Image 2",
  );
  await waitFor(
    cdp,
    `fetch(${JSON.stringify(`${apiOrigin}/api/v1/model-providers`)})
      .then((res) => res.json())
      .then((json) => {
        const providers = json.providers ?? [];
        const replicate = providers.find((provider) => provider.id === "replicate-primary");
        const mock = providers.find((provider) => provider.id === "mock-primary");
        return replicate?.modelPriorities?.["gpt-image-2"] === 10 &&
          mock?.modelPriorities?.["gpt-image-2"] === 20;
      })
      .catch(() => false)`,
    "GPT Image 2 provider order saved",
  );
  await cdp.send("Page.navigate", { url: `${webOrigin}/settings?section=providers` });
  await waitFor(cdp, `document.body.innerText.includes("BYOK")`, "BYOK settings page after model order");
  await click(
    cdp,
    `document.querySelector("button[aria-label='Open Replicate BYOK settings']")`,
    "Replicate settings row",
  );
  await waitFor(
    cdp,
    `document.body.innerText.includes("Replicate primary") && document.body.innerText.includes("Replicate secondary")`,
    "replicate provider config rows",
  );
  await click(
    cdp,
    `document.querySelector("button[aria-label='Move Replicate secondary up']")`,
    "Move Replicate secondary above primary",
  );
  await waitFor(
    cdp,
    `fetch(${JSON.stringify(`${apiOrigin}/api/v1/model-providers`)})
      .then((res) => res.json())
      .then((json) => {
        const providers = json.providers ?? [];
        const primary = providers.find((provider) => provider.id === "replicate-primary");
        const secondary = providers.find((provider) => provider.id === "replicate-secondary");
        return primary?.priority === 20 && secondary?.priority === 10;
      })
      .catch(() => false)`,
    "replicate provider key order saved",
  );
  await click(
    cdp,
    `([...document.querySelectorAll("button[aria-label^='Expand ']")].find((button) => {
      const label = button.getAttribute("aria-label") || "";
      return label.includes("Replicate primary");
    }))`,
    "Expand replicate provider config",
  );
  await waitFor(
    cdp,
    `document.body.innerText.includes("Model to test") && !!document.querySelector("button[aria-label='Run provider test']")`,
    "replicate provider test controls",
  );
  await click(
    cdp,
    `document.querySelector("button[aria-label='Run provider test']")`,
    "Run replicate provider readiness check",
  );
  await waitFor(
    cdp,
    `document.body.innerText.includes("Replicate ran Nano Banana 2 through google/nano-banana-2.")`,
    "replicate provider readiness result",
  );
}

async function createProject(cdp: CdpClient) {
  await clickByText(cdp, "Projects", "Projects nav");
  await waitFor(cdp, `location.pathname === "/projects"`, "projects route");
  await waitFor(cdp, `document.body.innerText.includes("New Project")`, "new project card");
  await clickByText(cdp, "New Project", "New Project");
  await waitFor(
    cdp,
    `location.pathname.startsWith("/projects/") && location.pathname !== "/projects" && !!document.querySelector("#editor-header")`,
    "project editor route",
    15000,
  );
}

async function exerciseRuntimeGui(cdp: CdpClient) {
  await createProject(cdp);
  await assertNoCriticalA11yRegressions(cdp);
  const hasRuntimePickerButton = await evaluate(cdp, `(() => {
    const button = document.querySelector("button[aria-label='Run on (Cloud / local runtime)']") ||
      document.querySelector("button[aria-label='运行环境（云端 / 本地）']");
    if (!button) return false;
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden";
  })()`);

  if (hasRuntimePickerButton) {
    await click(
      cdp,
      `document.querySelector("button[aria-label='Run on (Cloud / local runtime)']") ||
        document.querySelector("button[aria-label='运行环境（云端 / 本地）']")`,
      "Run on runtime picker",
    );
    await waitFor(cdp, `document.body.innerText.includes("Mock Desktop")`, "runtime menu lists mock desktop");
    await click(
      cdp,
      `([...document.querySelectorAll("[role='menuitem'], button")].find((el) => {
        const text = (el.innerText || el.textContent || "").trim();
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return text.includes("Mock Desktop") &&
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden";
      }))`,
      "Mock Desktop runtime option",
    );
    await waitFor(cdp, `document.querySelector('[role="dialog"]')?.innerText.includes("Start local helper on Mock Desktop")`, "runtime dialog");
    await waitFor(
      cdp,
      `(document.querySelector('[role="dialog"]')?.innerText || "").toLowerCase().includes("resume a session")`,
      "resume picker",
    );
    await waitFor(cdp, `document.querySelector('[role="dialog"]')?.innerText.includes("Start fresh")`, "fresh session option");
    await clickByText(cdp, "Start helper", "Start helper");
    await waitFor(
      cdp,
      `document.body.innerText.includes("Local agent connected") ||
        document.body.innerText.includes("本地 Agent 已连接") ||
        document.body.innerText.includes("Mock ACP")`,
      "local agent connected",
      15000,
    );
  } else {
    await waitFor(
      cdp,
      `document.body.innerText.includes("Mock ACP")`,
      "default mock ACP runtime selected",
      15000,
    );
  }

  const prompt = "gui e2e choreograph a small canvas";
  await typeText(cdp, `.milkdown-chat-input [contenteditable='true']`, prompt);
  await click(
    cdp,
    `([...document.querySelectorAll("button")].find((button) => {
      const label = (button.getAttribute("aria-label") || "").toLowerCase();
      const rect = button.getBoundingClientRect();
      return (label.includes("send") || label.includes("发送")) &&
        !button.disabled &&
        rect.width > 0 &&
        rect.height > 0;
    }))`,
    "Send prompt",
  );
  await waitFor(
    cdp,
    `document.body.innerText.includes(${JSON.stringify(prompt)}) &&
      document.body.innerText.includes(${JSON.stringify(`Mock ACP reply: ${prompt}`)})`,
    "mock helper reply",
    15000,
  );
  await waitFor(
    cdp,
    `(() => {
      const nodes = [...document.querySelectorAll(".react-flow__node")].map((node) => ({
        id: node.getAttribute("data-id") || "",
        text: (node.querySelector("input")?.value || "") + " " + (node.innerText || node.textContent || ""),
        rect: (() => {
          const rect = node.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        })(),
      }));
      return nodes.some((node) => node.id.includes("mock-agent-stage-") && node.rect.width > 300 && node.rect.height > 160) &&
        nodes.some((node) => node.text.includes("Agent Brief")) &&
        nodes.some((node) => node.text.includes("Agent Image Pass"));
    })()`,
    "agent-created visible canvas nodes",
    15000,
  );

  return evaluate(cdp, `(() => ({
    href: location.href,
    title: document.title,
    text: document.body.innerText.slice(0, 1000),
    nodes: [...document.querySelectorAll(".react-flow__node")].map((node) => ({
      id: node.getAttribute("data-id"),
      text: ((node.querySelector("input")?.value || "") + " " + (node.innerText || node.textContent || "")).trim().slice(0, 200),
      rect: (() => {
        const rect = node.getBoundingClientRect();
        return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
      })(),
    })).filter((node) =>
      (node.id || "").includes("mock-agent-stage-") ||
      node.text.includes("Agent Brief") ||
      node.text.includes("Agent Image Pass")
    ),
  }))()`);
}

async function main() {
  process.env.CLASH_E2E_STUB_ACP = "1";
  await rm(dataDir, { recursive: true, force: true });
  await rm(chromeDataDir, { recursive: true, force: true });
  await mkdir(captureDir, { recursive: true });
  const previousReplicateUrl = process.env.CLASH_REPLICATE_URL;

  const apiPort = await findFreePort(49800);
  const webPort = await findFreePort(49850);
  const cdpPort = await findFreePort(49900);
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const mockReplicate = await startMockReplicateApi();
  process.env.CLASH_REPLICATE_URL = mockReplicate.url;

  const { startLocalApiServer } = await loadHostServer();
  const apiServer = await startLocalApiServer({ port: apiPort, dataDir });
  const { child: web, logs: webLogs } = await startWeb({ webPort, apiOrigin });
  const chromeLogs: string[] = [];
  let chrome;
  let cdp;

  try {
    await waitForHttp(webOrigin, "Vite web server");
    chrome = spawn(chromeBinary(), [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${chromeDataDir}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-renderer-backgrounding",
      "--window-size=1440,1000",
      "about:blank",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    chrome.stdout.on("data", (buf) => chromeLogs.push(String(buf)));
    chrome.stderr.on("data", (buf) => chromeLogs.push(String(buf)));

    cdp = new CdpClient(await waitForTarget(cdpPort));
    await cdp.ready();
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `globalThis.__CLASH_RUNTIME_CONFIG__ = ${JSON.stringify({
        mode: "desktop",
        apiBaseUrl: apiOrigin,
        wsBaseUrl: apiOrigin.replace("http:", "ws:"),
      })};`,
    });
    await cdp.send("Page.navigate", { url: webOrigin });

    await exerciseSettingsDialog(cdp);
    await exerciseProviderModelRouting(cdp, { webOrigin, apiOrigin });
    await cdp.send("Page.navigate", { url: webOrigin });
    await waitFor(cdp, `location.pathname === "/" && document.body.innerText.includes("Projects")`, "home after provider settings");
    const state = await exerciseRuntimeGui(cdp);
    await capture(cdp, latestScreenshot);
    console.log("[web-gui] state", JSON.stringify(state));
    console.log(`[web-gui] screenshot ${latestScreenshot}`);
  } catch (error) {
    process.exitCode = 1;
    console.error("[web-gui] caught", error instanceof Error ? error.stack ?? error.message : error);
    if (cdp) {
      try {
        await capture(cdp, latestScreenshot);
        console.error(`[web-gui] failure screenshot ${latestScreenshot}`);
      } catch {
        // Ignore capture failure while unwinding.
      }
    }
    console.error("[web-gui] web logs\n" + tail(webLogs));
    console.error("[web-gui] chrome logs\n" + tail(chromeLogs));
    throw error;
  } finally {
    if (cdp) cdp.close();
    await stopProcess(chrome);
    await stopProcess(web);
    await new Promise((resolve) => apiServer.close(resolve));
    await mockReplicate.close();
    if (previousReplicateUrl === undefined) delete process.env.CLASH_REPLICATE_URL;
    else process.env.CLASH_REPLICATE_URL = previousReplicateUrl;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
