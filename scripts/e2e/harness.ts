import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function assert(condition: unknown, message: string, details?: unknown): asserts condition {
  if (!condition) {
    throw new Error(`${message}${details === undefined ? "" : `: ${JSON.stringify(details)}`}`);
  }
}

export async function findFreePort(start: number) {
  for (let port = start; port < start + 100; port += 1) {
    const ok = await new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(true));
      });
    });
    if (ok) return port;
  }
  throw new Error(`No free port found from ${start}`);
}

export async function waitForHttp(url: string, label: string, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for ${label}: ${url}` +
      (lastError ? ` (${lastError instanceof Error ? lastError.message : String(lastError)})` : ""),
  );
}

export function tail(lines: string[], max = 100) {
  return lines.slice(Math.max(0, lines.length - max)).join("");
}

export function chromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter((candidate): candidate is string => typeof candidate === "string");
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error("No Chrome-compatible browser found. Set CHROME_BIN to run GUI E2E.");
  }
  return found;
}

export function viteCli({ webDir, repoRoot }: { webDir: string; repoRoot: string }) {
  const localVite = path.join(webDir, "node_modules", "vite", "bin", "vite.js");
  if (existsSync(localVite)) return localVite;
  const rootVite = path.join(repoRoot, "node_modules", "vite", "bin", "vite.js");
  if (existsSync(rootVite)) return rootVite;
  throw new Error("Vite CLI not found. Run dependency install before web E2E.");
}

export function startViteDevServer({ webDir, repoRoot, port, env = {} }: { webDir: string; repoRoot: string; port: number; env?: NodeJS.ProcessEnv }) {
  const logs: string[] = [];
  const child = spawn(process.execPath, [viteCli({ webDir, repoRoot }), "--host", "127.0.0.1", "--port", String(port)], {
    cwd: webDir,
    env: {
      ...process.env,
      CLASH_WEB_E2E_NO_CLOUDFLARE: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (buf) => {
    const text = String(buf);
    logs.push(text);
    process.stdout.write(text);
  });
  child.stderr.on("data", (buf) => {
    const text = String(buf);
    logs.push(text);
    process.stderr.write(text);
  });
  return { child, logs };
}

export async function waitForTarget(cdpPort: number, timeoutMs = 15000) {
  const url = `http://127.0.0.1:${cdpPort}/json/list`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const targets = await res.json() as Array<{ type: string; webSocketDebuggerUrl?: string }>;
        const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch {
      // CDP is still booting.
    }
    await sleep(200);
  }
  throw new Error("Timed out waiting for Chrome CDP target");
}

export class CdpClient {
  private id: number;
  private pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  private ws: WebSocket;
  constructor(url: string) {
    this.id = 0;
    this.pending = new Map();
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as { id?: number; error?: unknown; result?: unknown };
      if (!msg.id || !this.pending.has(msg.id)) return;
      const pending = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
    });
  }

  async ready() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    }) as Promise<T>;
  }

  close() {
    this.ws.close();
  }
}

export async function evaluate<T = unknown>(cdp: CdpClient, expression: string, { timeoutMs = 12000 } = {}): Promise<T> {
  const result = await cdp.send<{ result: { value: T }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Runtime evaluation failed");
  }
  return result.result.value;
}

export async function pageDiagnostics(cdp: CdpClient) {
  try {
    return await evaluate(cdp, `(() => ({
      href: location.href,
      title: document.title,
      bodyText: document.body.innerText.slice(0, 2400),
      activeElement: document.activeElement ? {
        tag: document.activeElement.tagName,
        text: (document.activeElement.innerText || document.activeElement.textContent || "").trim().slice(0, 200),
        aria: document.activeElement.getAttribute("aria-label"),
      } : null,
      dialogs: [...document.querySelectorAll("[role='dialog']")].map((el) => (el.innerText || el.textContent || "").trim().slice(0, 1000)),
      buttons: [...document.querySelectorAll("button, a, [role='button'], [role='menuitem'], [role='tab']")]
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        })
        .slice(0, 80)
        .map((el) => ({
          tag: el.tagName,
          text: (el.innerText || el.textContent || "").trim().slice(0, 160),
          aria: el.getAttribute("aria-label"),
          role: el.getAttribute("role"),
          disabled: el.disabled || el.getAttribute("aria-disabled"),
        })),
    }))()`, { timeoutMs: 3000 });
  } catch (error) {
    return { diagnosticsError: error instanceof Error ? error.message : String(error) };
  }
}

export async function waitFor<T = unknown>(cdp: CdpClient, expression: string, label: string, timeoutMs = 12000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate<T>(cdp, expression);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  const diagnostics = await pageDiagnostics(cdp);
  throw new Error(
    `Timed out waiting for ${label}` +
      (lastError ? `; last error: ${lastError instanceof Error ? lastError.message : String(lastError)}` : "") +
      `; page: ${JSON.stringify(diagnostics)}`,
  );
}

async function resolveVisibleElement(cdp: CdpClient, selectorExpression: string, label: string) {
  return waitFor<{ x: number; y: number; text: string; aria: string | null; tag: string }>(
    cdp,
    `(() => {
      const el = (${selectorExpression});
      if (!el) return false;
      el.scrollIntoView({ block: "center", inline: "center" });
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none") return false;
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        text: (el.innerText || el.textContent || "").trim().slice(0, 200),
        aria: el.getAttribute("aria-label"),
        tag: el.tagName,
      };
    })()`,
    `resolve ${label}`,
  );
}

export async function click(cdp: CdpClient, selectorExpression: string, label: string) {
  const point = await resolveVisibleElement(cdp, selectorExpression, label);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "none",
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  return point;
}

export function clickableByTextExpression(label: string) {
  return `([...document.querySelectorAll("a, button, [role='button'], [role='menuitem'], [role='tab']")].find((el) => {
    const text = (el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim();
    if (text !== ${JSON.stringify(label)}) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }))`;
}

export async function clickByText(cdp: CdpClient, label: string, description = label) {
  return click(cdp, clickableByTextExpression(label), description);
}

export async function typeText(cdp: CdpClient, selector: string, text: string) {
  const inserted = await evaluate(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    if (el.isContentEditable) {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, ${JSON.stringify(text)});
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: ${JSON.stringify(text)}
      }));
      return (el.innerText || el.textContent || "").includes(${JSON.stringify(text)});
    }
    if ("value" in el) {
      const valueSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
      if (valueSetter) valueSetter.call(el, ${JSON.stringify(text)});
      else el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: ${JSON.stringify(text)}
      }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value === ${JSON.stringify(text)};
    }
    return false;
  })()`);
  if (!inserted) {
    const diagnostics = await pageDiagnostics(cdp);
    throw new Error(`Could not type into ${selector}: ${JSON.stringify(diagnostics)}`);
  }
}

export async function capture(cdp: CdpClient, targetPath: string) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await writeFile(targetPath, Buffer.from(shot.data, "base64"));
}

export async function stopProcess(child: ChildProcess | null | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    sleep(3000).then(() => false),
  ]);
  if (!exited) child.kill("SIGKILL");
}
