import { Command } from "commander";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  credentialsFilePath,
  saveConfig as saveConfigFile,
  loadConfig as loadConfigFile,
  getApiKey,
  getServerUrl,
  type ClashConfig,
} from "../lib/config";

const CLI_CLIENT_ID = "clash-cli";
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export function redactApiKeyForDisplay(apiKey: string): string {
  const token = apiKey.trim();
  if (!token) return "[redacted]";
  const prefix = token.startsWith("clsh_")
    ? "clsh_"
    : token.slice(0, Math.min(4, token.length));
  const suffix = token.length >= 12 ? token.slice(-4) : "";
  return suffix ? `${prefix}...${suffix}` : `${prefix}...`;
}

export function createPkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function normalizeHttpOrigin(value: string, label: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(`${label} must be an HTTP(S) origin.`);
  }
  return url.origin;
}

export function resolveCliBrowserOrigin(
  serverUrl: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.CLASH_AUTH_URL?.trim();
  if (configured) return normalizeHttpOrigin(configured, "CLASH_AUTH_URL");
  const apiOrigin = new URL(normalizeHttpOrigin(serverUrl, "Clash API URL"));
  if (apiOrigin.hostname === "api.clash.art") {
    apiOrigin.hostname = "clash.art";
  }
  return apiOrigin.origin;
}

type PendingLoopbackCallback = {
  redirectUri: string;
  waitForCode: Promise<string>;
  close: () => Promise<void>;
};

function responseHeaders(contentType: string): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "content-type": contentType,
    "x-content-type-options": "nosniff",
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

async function startLoopbackCallback(
  expectedState: string,
  timeoutMs: number,
): Promise<PendingLoopbackCallback> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const waitForCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((req, res) => {
    const callback = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || callback.pathname !== "/callback") {
      res.writeHead(404, responseHeaders("text/plain; charset=utf-8"));
      res.end("Not found.");
      return;
    }

    const state = callback.searchParams.get("state") ?? "";
    const code = callback.searchParams.get("code") ?? "";
    if (state !== expectedState) {
      res.writeHead(400, responseHeaders("text/plain; charset=utf-8"));
      res.end("Invalid OAuth state.");
      return;
    }
    if (!/^[A-Za-z0-9_-]{8,512}$/.test(code)) {
      res.writeHead(400, responseHeaders("text/plain; charset=utf-8"));
      res.end("Missing or invalid authorization code.");
      return;
    }

    res.writeHead(200, responseHeaders("text/html; charset=utf-8"));
    res.end(
      '<!doctype html><meta charset="utf-8"><title>Clash CLI authenticated</title>' +
        "<style>body{font-family:system-ui;text-align:center;padding:80px;color:#222}</style>" +
        "<h1>Authentication complete</h1><p>You can close this tab and return to the terminal.</p>",
      () => {
        void closeServer(server);
      },
    );
    if (!settled) {
      settled = true;
      if (timer) clearTimeout(timer);
      resolveCode(code);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      void waitForCode.catch(() => undefined);
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  server.on("error", (error) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    rejectCode(error);
  });
  timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectCode(new Error("Authentication timed out."));
    void closeServer(server);
  }, timeoutMs);

  const port = (server.address() as AddressInfo).port;
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    waitForCode,
    close: async () => {
      if (timer) clearTimeout(timer);
      await closeServer(server);
    },
  };
}

function buildAuthorizationUrl(
  browserOrigin: string,
  redirectUri: string,
  state: string,
  challenge: string,
): string {
  const url = new URL(
    "/auth/cli",
    `${normalizeHttpOrigin(browserOrigin, "Browser authorization URL")}/`,
  );
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLI_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

async function openSystemBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32.exe"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function exchangeAuthorizationCode(options: {
  serverUrl: string;
  redirectUri: string;
  code: string;
  verifier: string;
  fetchImpl: typeof fetch;
}): Promise<string> {
  const tokenUrl = new URL(
    "/api/v1/cli-auth/token",
    `${normalizeHttpOrigin(options.serverUrl, "Clash API URL")}/`,
  );
  const response = await options.fetchImpl(tokenUrl.toString(), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLI_CLIENT_ID,
      redirect_uri: options.redirectUri,
      code: options.code,
      code_verifier: options.verifier,
    }).toString(),
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const error =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : "token_exchange_failed";
    throw new Error(`Token exchange failed (${response.status}, ${error}).`);
  }
  const accessToken =
    body && typeof body === "object" && "access_token" in body
      ? (body as { access_token: unknown }).access_token
      : null;
  const tokenType =
    body && typeof body === "object" && "token_type" in body
      ? (body as { token_type: unknown }).token_type
      : null;
  if (
    typeof accessToken !== "string" ||
    !/^clsh_[0-9a-f]{40}$/.test(accessToken) ||
    tokenType !== "Bearer"
  ) {
    throw new Error(
      "Token exchange returned an invalid access token response.",
    );
  }
  return accessToken;
}

export type CliLoginOptions = {
  serverUrl?: string;
  browserOrigin?: string;
  timeoutMs?: number;
  openBrowser?: (url: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  loadConfig?: () => ClashConfig;
  saveConfig?: (config: ClashConfig) => void;
  log?: (message: string) => void;
};

export type CliLoginResult = {
  accessToken: string;
  authorizationUrl: string;
};

export async function runCliLogin(
  options: CliLoginOptions = {},
): Promise<CliLoginResult> {
  const serverUrl = normalizeHttpOrigin(
    options.serverUrl ?? getServerUrl(),
    "Clash API URL",
  );
  const browserOrigin = options.browserOrigin
    ? normalizeHttpOrigin(options.browserOrigin, "Browser authorization URL")
    : resolveCliBrowserOrigin(serverUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const openBrowser = options.openBrowser ?? openSystemBrowser;
  const readConfig = options.loadConfig ?? loadConfigFile;
  const writeConfig = options.saveConfig ?? saveConfigFile;
  const log = options.log ?? console.log;
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createPkceChallenge(verifier);
  const callback = await startLoopbackCallback(state, timeoutMs);
  const authorizationUrl = buildAuthorizationUrl(
    browserOrigin,
    callback.redirectUri,
    state,
    challenge,
  );

  try {
    log("Opening browser for authentication...");
    log(`If the browser does not open, visit:\n  ${authorizationUrl}\n`);
    log("Waiting for authentication...");
    try {
      await openBrowser(authorizationUrl);
    } catch {
      log("Could not open the browser automatically; use the URL above.");
    }

    const code = await callback.waitForCode;
    const accessToken = await exchangeAuthorizationCode({
      serverUrl,
      redirectUri: callback.redirectUri,
      code,
      verifier,
      fetchImpl,
    });
    writeConfig({ ...readConfig(), apiKey: accessToken });
    return { accessToken, authorizationUrl };
  } finally {
    await callback.close();
  }
}

export const authCommand = new Command("auth")
  .description(`Manage optional cloud-sync authentication

Run: clash auth login (OAuth 2.0 Authorization Code + PKCE)
Set CLASH_AUTH_URL when the browser app and API use different local origins.
Pure local projects do not require login.
Credentials stored at: $CLASH_HOME/credentials.json, or ~/.clash/credentials.json by default`);

authCommand
  .command("login")
  .description(
    "Authenticate cloud sync via browser with OAuth 2.0 Authorization Code + PKCE",
  )
  .action(async () => {
    try {
      await runCliLogin();
      console.log("\nAuthenticated successfully!");
      console.log(`API key saved to ${credentialsFilePath()}`);
    } catch (error) {
      console.error(
        `\nAuthentication failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    }
  });

authCommand
  .command("status")
  .description("Check authentication status")
  .action(async () => {
    const apiKey = getApiKey();
    const serverUrl = getServerUrl();

    if (!apiKey) {
      console.log("Cloud sync is not authenticated. Local projects are unaffected.");
      console.log("Run `clash auth login` only when cloud sync is needed.");
      process.exit(1);
    }

    console.log(`API key: ${redactApiKeyForDisplay(apiKey)}`);
    console.log(`Server:  ${serverUrl}`);

    try {
      const res = await fetch(`${serverUrl}/api/v1/projects`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        const data = (await res.json()) as { projects: unknown[] };
        console.log(
          `Status:  Authenticated (${data.projects.length} projects)`,
        );
      } else if (res.status === 401) {
        console.log("Status:  Invalid token");
        process.exit(1);
      } else {
        console.log(`Status:  Server error (${res.status})`);
      }
    } catch {
      console.log(`Status:  Cannot reach server at ${serverUrl}`);
    }
  });

authCommand
  .command("logout")
  .description("Remove saved API key")
  .action(() => {
    const config = loadConfigFile();
    delete config.apiKey;
    saveConfigFile(config);
    console.log("API key removed.");
  });
