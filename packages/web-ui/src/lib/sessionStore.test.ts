// @vitest-environment jsdom
/**
 * Issue #160: one shared client session source. These tests run the real
 * Better Auth client against a fetch mock and count get-session requests.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const GET_SESSION = "/api/better-auth/get-session";

let serverUser: { id: string } | null;
let requests: string[];
let documentListeners: [string, EventListenerOrEventListenerObject][];

function pathOf(input: unknown): string {
  return new URL(String(input), "http://localhost").pathname;
}

function sessionFetches(): number {
  return requests.filter((path) => path === GET_SESSION).length;
}

function sessionBody() {
  return serverUser
    ? { user: serverUser, session: { id: "session-1", userId: serverUser.id, token: "secret-token" } }
    : null;
}

async function load() {
  const store = await import("./sessionStore");
  const client = (await import("./betterAuthClient")).default;
  const runtime = await import("./runtimeConfig");
  return { ...store, client, runtime };
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  globalThis.__CLASH_RUNTIME_CONFIG__ = undefined;
  serverUser = { id: "user-1" };
  requests = [];
  localStorage.clear();
  // Each test gets fresh modules; drop the previous store's focus listener.
  documentListeners = [];
  const add = document.addEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation(
    (type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
      documentListeners.push([type, listener]);
      add(type, listener, options as AddEventListenerOptions);
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const path = pathOf(input);
      requests.push(path);
      const method = (init?.method ?? "GET").toUpperCase();
      if (path === GET_SESSION && method === "GET") {
        return Response.json(sessionBody());
      }
      if (path === "/api/better-auth/sign-in/email") {
        serverUser = { id: "user-2" };
        return Response.json({ redirect: false, token: "t", user: serverUser });
      }
      if (path === "/api/better-auth/sign-out") {
        serverUser = null;
        return Response.json({ success: true });
      }
      if (path === "/api/v1/projects") {
        return new Response(null, { status: 401 });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  for (const [type, listener] of documentListeners) {
    document.removeEventListener(type, listener);
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  globalThis.__CLASH_RUNTIME_CONFIG__ = undefined;
});

async function settle<T>(promise: Promise<T>): Promise<T> {
  await act(() => vi.advanceTimersByTimeAsync(10));
  return promise;
}

describe("shared session source (#160)", () => {
  it("serves every startup consumer from exactly one get-session", async () => {
    const { client, getSession, useSessionSignedIn } = await load();

    const views = [
      renderHook(() => client.useSession()),
      renderHook(() => client.useSession()),
    ];
    const signedIn = renderHook(() => useSessionSignedIn());
    const loaders = Promise.all([getSession(), getSession(), getSession()]);
    await act(() => vi.advanceTimersByTimeAsync(10));
    const sessions = await loaders;

    expect(sessionFetches()).toBe(1);
    for (const session of sessions) expect(session.data?.user?.id).toBe("user-1");
    for (const view of views) {
      expect(view.result.current.data?.user?.id).toBe("user-1");
    }
    expect(signedIn.result.current).toBe(true);
  });

  it("reuses the cache for loader re-runs and component remounts", async () => {
    const { client, getSession } = await load();
    const first = getSession();
    await vi.advanceTimersByTimeAsync(10);
    await first;

    for (let navigation = 0; navigation < 3; navigation += 1) {
      await getSession();
      const view = renderHook(() => client.useSession());
      view.unmount();
      // Longer than nanostores' unmount delay: the atom must stay mounted.
      await vi.advanceTimersByTimeAsync(2_000);
    }

    expect(sessionFetches()).toBe(1);
  });

  it("refetches on focus only after five minutes since the last fetch", async () => {
    const { getSession, SESSION_FOCUS_REFETCH_MS } = await load();
    const first = getSession();
    await vi.advanceTimersByTimeAsync(10);
    await first;

    for (let focus = 0; focus < 3; focus += 1) {
      setVisibility("hidden");
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(sessionFetches()).toBe(1);

    await vi.advanceTimersByTimeAsync(SESSION_FOCUS_REFETCH_MS);
    setVisibility("hidden");
    expect(sessionFetches()).toBe(1);
    setVisibility("visible");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionFetches()).toBe(2);
  });

  it("refetches once after sign-in and once after sign-out", async () => {
    const { client, getSession } = await load();
    serverUser = null;
    const first = getSession();
    await vi.advanceTimersByTimeAsync(10);
    expect((await first).data).toBeNull();

    await client.signIn.email({ email: "a@example.com", password: "pw" });
    // A loader right after sign-in must see the new user, not the cache.
    const afterSignIn = getSession();
    await vi.advanceTimersByTimeAsync(100);
    expect((await afterSignIn).data?.user?.id).toBe("user-2");
    expect(sessionFetches()).toBe(2);

    await client.signOut();
    const afterSignOut = getSession();
    await vi.advanceTimersByTimeAsync(100);
    expect((await afterSignOut).data).toBeNull();
    expect(sessionFetches()).toBe(3);
  });

  it("treats an API 401 as signed out without asking get-session again", async () => {
    const { getSession, runtime, useSessionSignedIn } = await load();
    const hook = renderHook(() => useSessionSignedIn());
    const first = getSession();
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect((await first).data?.user?.id).toBe("user-1");
    expect(hook.result.current).toBe(true);

    const response = await act(() =>
      runtime.runtimeFetch("/api/v1/projects", { credentials: "include" }),
    );
    expect(response.status).toBe(401);
    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect((await getSession()).data).toBeNull();
    expect(hook.result.current).toBe(false);
    expect(sessionFetches()).toBe(1);
  });

  it.each(["local", "desktop"] as const)(
    "never fetches get-session in a %s local-user runtime",
    async (mode) => {
      globalThis.__CLASH_RUNTIME_CONFIG__ = {
        mode,
        apiBaseUrl: "http://127.0.0.1:8789",
      };
      const { getSession, useSessionSignedIn } = await load();

      const hook = renderHook(() => useSessionSignedIn());
      await expect(getSession()).resolves.toEqual({ data: null, error: null });
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(hook.result.current).toBeNull();
      expect(sessionFetches()).toBe(0);
    },
  );

  it("a new tab reuses a fresh cross-tab snapshot instead of get-session", async () => {
    const first = await load();
    await settle(first.getSession());
    expect(sessionFetches()).toBe(1);
    // The persisted snapshot never carries the session token.
    const stored = localStorage.getItem("clash.session-snapshot.v1") ?? "";
    expect(stored).toContain("session-1");
    expect(stored).not.toContain("secret-token");

    // Another page load (new tab) within five minutes. The first tab's
    // document listeners belong to another document in a real browser.
    for (const [type, listener] of documentListeners.splice(0)) {
      document.removeEventListener(type, listener);
    }
    vi.resetModules();
    vi.advanceTimersByTime(60_000);
    const tab = await load();
    const view = renderHook(() => tab.client.useSession());
    const session = await settle(tab.getSession());
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(session.data?.user?.id).toBe("user-1");
    expect(view.result.current.data?.user?.id).toBe("user-1");
    expect(sessionFetches()).toBe(1);

    // Its focus throttle counts from the snapshot's age (fetched 60 s ago).
    vi.advanceTimersByTime(4 * 60_000 + 1_000);
    setVisibility("hidden");
    setVisibility("visible");
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(sessionFetches()).toBe(2);
  });

  it("an old snapshot, a signed-out answer or an API 401 is never reused", async () => {
    const first = await load();
    await settle(first.getSession());
    vi.resetModules();
    vi.advanceTimersByTime(5 * 60_000 + 1);
    const stale = await load();
    await settle(stale.getSession());
    expect(sessionFetches()).toBe(2);

    await settle(stale.runtime.runtimeFetch("/api/v1/projects"));
    expect(localStorage.getItem("clash.session-snapshot.v1")).toBeNull();
    vi.resetModules();
    const afterUnauthorized = await load();
    await settle(afterUnauthorized.getSession());
    expect(sessionFetches()).toBe(3);

    serverUser = null;
    vi.resetModules();
    vi.advanceTimersByTime(5 * 60_000 + 1);
    const signedOut = await load();
    expect((await settle(signedOut.getSession())).data).toBeNull();
    expect(localStorage.getItem("clash.session-snapshot.v1")).toBeNull();
  });
});
