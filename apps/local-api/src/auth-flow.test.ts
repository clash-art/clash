import { describe, expect, it } from "vitest";

import { runLoopbackFlow } from "./auth-flow.js";

/**
 * The loopback port is the Host's part of a browser sign-in. PKCE, `state`, the authorization URL
 * and the code exchange are shared with every adapter and tested in
 * `@clash/shared-runtime/provider-oauth-flow`.
 */
describe("the loopback callback", () => {
  it("refuses a callback whose state does not match", async () => {
    // The whole purpose of `state`. Without this comparison an attacker can hand the user a link
    // that binds the attacker's account to the user's session.
    const flow = runLoopbackFlow({ open: (url) => void url, timeoutMs: 2000 });
    const started = await flow.started;
    const response = await fetch(`${started.redirectUri}?code=abc&state=wrong`);
    expect(response.status).toBe(400);
    const cancelled = expect(flow.result).rejects.toThrow(/cancelled/i);
    flow.cancel();
    await cancelled;
  });

  it("hands back the parameters when the state matches", async () => {
    let opened = "";
    const flow = runLoopbackFlow({ open: (url) => { opened = url; }, timeoutMs: 5000 });
    const started = await flow.started;
    await fetch(`${started.redirectUri}?code=abc&state=${encodeURIComponent(started.state)}`);
    await expect(flow.result).resolves.toMatchObject({ code: "abc" });
    expect(opened).toBe("");
  });

  it("stops listening once it has an answer", async () => {
    // A port left bound after the flow finishes is a port that will answer the next callback, for
    // a flow nobody started.
    const flow = runLoopbackFlow({ open: () => {}, timeoutMs: 5000 });
    const started = await flow.started;
    await fetch(`${started.redirectUri}?code=abc&state=${encodeURIComponent(started.state)}`);
    await flow.result;
    await expect(fetch(started.redirectUri)).rejects.toThrow();
  });

  it("gives up rather than holding the port forever", async () => {
    const flow = runLoopbackFlow({ open: () => {}, timeoutMs: 300 });
    await flow.started;
    await expect(flow.result).rejects.toThrow(/timed out|timeout/i);
  });
});
