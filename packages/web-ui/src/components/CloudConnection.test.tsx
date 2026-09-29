// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  CloudAccountPanel,
  ProjectCloudButton,
  ProjectCloudPanel,
} from "./CloudConnection";
vi.mock("../lib/runtimeConfig", () => ({
  runtimeApiUrl: (path: string) => path,
  isDesktopRuntime: () => true,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("opens project cloud settings from a compact named control without enabling sync", async () => {
  const fetcher = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        serviceUrl: "https://clash.art",
        authenticated: true,
        admission: null,
        webUrl: null,
        user: null,
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  render(<ProjectCloudButton projectId="p" />);
  const trigger = screen.getByRole("button", { name: "Cloud sync" });
  expect(trigger.textContent).toBe("");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  expect(
    await screen.findByRole("dialog", { name: "Cloud sync" }),
  ).toBeTruthy();
  await screen.findByRole("button", { name: "Enable cloud sync" });
  expect(fetcher.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(
    true,
  );
});
it("signs in to the chosen self-host without admitting any project", async () => {
  const openExternal = vi.fn(async () => {});
  vi.stubGlobal("__CLASH_DESKTOP__", { openExternal });
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/local/cloud/login")
        return Response.json(
          {
            id: "login",
            state: "pending",
            authorizationUrl: "https://selfhost.example/auth/cli?state=opaque",
            serviceUrl: "https://selfhost.example",
          },
          { status: 201 },
        );
      if (url.includes("/login/"))
        return Response.json({ id: "login", state: "pending" });
      return Response.json({
        serviceUrl: "https://clash.art",
        official: true,
        user: null,
      });
    },
  );
  vi.stubGlobal("fetch", fetcher);
  render(<CloudAccountPanel />);
  fireEvent.click(await screen.findByRole("radio", { name: /Self-hosted/ }));
  fireEvent.change(screen.getByLabelText("Service address"), {
    target: { value: "https://selfhost.example" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() =>
    expect(openExternal).toHaveBeenCalledWith(
      "https://selfhost.example/auth/cli?state=opaque",
    ),
  );
  expect(
    fetcher.mock.calls.some(([url]) => String(url).includes("cloud-admission")),
  ).toBe(false);
  expect(screen.queryByLabelText(/token/i)).toBeNull();
});
it("requires explicit project admission and exposes Web only after server-confirmed readiness", async () => {
  let enabled = false,
    ready = false;
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") enabled = true;
      return Response.json({
        serviceUrl: "https://clash.art",
        user: { id: "u", email: "u@example.test", name: "User" },
        authenticated: true,
        admission: enabled
          ? { status: ready ? "ready" : "syncing", lastError: null }
          : null,
        webUrl: ready ? "https://clash.art/projects/p" : null,
      });
    },
  );
  vi.stubGlobal("fetch", fetcher);
  render(<ProjectCloudPanel projectId="p" />);
  const enable = await screen.findByRole("button", {
    name: "Enable cloud sync",
  });
  expect(enabled).toBe(false);
  expect(screen.queryByRole("button", { name: "Open in Web" })).toBeNull();
  fireEvent.click(enable);
  await screen.findByText("Syncing project data and media…");
  expect(screen.queryByRole("button", { name: "Open in Web" })).toBeNull();
  ready = true;
  await waitFor(
    () =>
      expect(screen.getByRole("button", { name: "Open in Web" })).toBeTruthy(),
    { timeout: 4000 },
  );
});
it("recovers from a temporary Host failure before offering project sync", async () => {
  let available = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (!available) throw Error("Host is reconnecting");
      return Response.json({
        serviceUrl: "https://clash.art",
        authenticated: true,
        admission: null,
        webUrl: null,
        user: null,
      });
    }),
  );
  render(<ProjectCloudPanel projectId="p" />);
  await screen.findByText("Host is reconnecting");
  available = true;
  await waitFor(
    () =>
      expect(
        screen.getByRole("button", { name: "Enable cloud sync" }),
      ).toBeTruthy(),
    { timeout: 4000 },
  );
  expect(screen.queryByText("Host is reconnecting")).toBeNull();
});
