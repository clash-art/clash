import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import {
  createOAuthState,
  oauthStatesMatch,
} from "@clash/shared-runtime/provider-oauth-flow";

/**
 * The loopback half of a browser sign-in, which only a process on the user's machine can do.
 *
 * PKCE, `state`, the authorization URL and the code exchange are vendor-neutral and shared with
 * the Cloudflare adapter in `@clash/shared-runtime/provider-oauth-flow`. Binding a port is not:
 * Google requires loopback for desktop clients -- the out-of-band flow
 * (`urn:ietf:wg:oauth:2.0:oob`) was withdrawn in 2022 -- so that part stays with the Host.
 */

export interface LoopbackFlowOptions {
  open: (url: string) => void;
  timeoutMs?: number;
}

export interface LoopbackFlowStarted {
  redirectUri: string;
  state: string;
  port: number;
}

export interface LoopbackFlow {
  started: Promise<LoopbackFlowStarted>;
  result: Promise<Record<string, string>>;
  cancel: () => void;
}

/**
 * Bind 127.0.0.1 on a port the OS picks, and wait for one callback.
 *
 * One callback, then the port closes. A port left bound after the flow finishes is a port that
 * will answer the next callback, for a flow nobody started.
 */
export function runLoopbackFlow(options: LoopbackFlowOptions): LoopbackFlow {
  const state = createOAuthState();
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;

  let server: Server | undefined;
  let settle: ((params: Record<string, string>) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  let timer: NodeJS.Timeout | undefined;

  const close = () => {
    if (timer) clearTimeout(timer);
    server?.close();
    server = undefined;
  };

  const result = new Promise<Record<string, string>>((resolve, reject) => {
    settle = (params) => { close(); resolve(params); };
    fail = (error) => { close(); reject(error); };
  });

  const started = new Promise<LoopbackFlowStarted>((resolve, reject) => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const params = Object.fromEntries(url.searchParams.entries());

      if (!oauthStatesMatch(params.state, state)) {
        // The whole purpose of `state`. Without this an attacker can hand the user a link that
        // binds the attacker's account to the user's session.
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("This sign-in did not come from a request made here.");
        return;
      }

      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><p>Signed in. You can close this window.</p>");
      settle?.(params);
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server!.address() as AddressInfo).port;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      timer = setTimeout(() => {
        fail?.(new Error(`Sign-in timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref?.();
      resolve({ redirectUri, state, port });
    });
  });

  return {
    started,
    result,
    cancel: () => { fail?.(new Error("Sign-in was cancelled.")); },
  };
}
