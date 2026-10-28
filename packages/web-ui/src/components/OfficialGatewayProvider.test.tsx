// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OfficialGatewayStatus } from "@clash/shared-types";
import {
  configureConsolePlugins,
  resetConsolePlugins,
} from "../lib/consolePlugins";
import {
  OfficialGatewayProviderRow,
  officialGatewayResponseError,
} from "./OfficialGatewayProvider";

const signedOut: OfficialGatewayStatus = {
  providerId: "clash-official",
  serviceUrl: "https://clash.example.test",
  signedIn: false,
  user: null,
  priority: "byok-first",
  token: { state: "none", expiresAt: null },
  handoffs: [],
  lastError: null,
};

function stubHost(initial: OfficialGatewayStatus) {
  let current = initial;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toContain("/api/v1/local/official-gateway");
    if (init?.method === "PATCH") {
      const { priority } = JSON.parse(String(init.body)) as {
        priority: OfficialGatewayStatus["priority"];
      };
      current = { ...current, priority };
    }
    return Response.json(current);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderRow() {
  return render(
    <MemoryRouter>
      <OfficialGatewayProviderRow />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (globalThis as { __CLASH_DESKTOP__?: unknown }).__CLASH_DESKTOP__;
  resetConsolePlugins();
});

describe("OfficialGatewayProviderRow", () => {
  it("sends a signed-out user to sign in and shows the stored priority", async () => {
    stubHost(signedOut);
    renderRow();
    const link = await screen.findByRole("link", { name: "Sign in to use Clash official" });
    expect(link.getAttribute("href")).toBe("/settings?section=sync");
    expect(
      screen.getByRole("radio", { name: /Your own keys first/ }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("saves the BYOK/official priority the user picks", async () => {
    const fetchMock = stubHost(signedOut);
    renderRow();
    fireEvent.click(await screen.findByRole("radio", { name: /Clash official first/ }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/local/official-gateway"),
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ priority: "official-first" }),
        }),
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("radio", { name: /Clash official first/ }).getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });

  it("shows the signed-in account, the key state without the key, and the last coded error", async () => {
    stubHost({
      ...signedOut,
      signedIn: true,
      user: { email: "u1@example.test", name: "User One" },
      token: { state: "active", expiresAt: "2026-10-27T10:15:00.000Z" },
      handoffs: [
        { harnessId: "codex-acp", methodId: "custom-endpoint", expiresAt: "2026-10-27T10:15:00.000Z" },
      ],
      lastError: { code: "GATEWAY_BUDGET_EXCEEDED", message: "Budget used up." },
    });
    renderRow();
    expect(await screen.findByText("Signed in as User One")).toBeTruthy();
    expect(screen.getByText(/Gateway key active until .* · Used by codex-acp/)).toBeTruthy();
    expect(screen.getByText("GATEWAY_BUDGET_EXCEEDED: Budget used up.")).toBeTruthy();
    // OSS empty registry: no billing top-up chrome on 402.
    expect(screen.queryByRole("link", { name: "Top up credits" })).toBeNull();
  });

  it("surfaces a top-up link on GATEWAY_BUDGET_EXCEEDED when the billing plugin is registered", async () => {
    configureConsolePlugins([
      {
        id: "billing",
        navGroups: [{ label: "Account", items: [{ to: "/billing", label: "Billing" }] }],
      },
    ]);
    stubHost({
      ...signedOut,
      signedIn: true,
      user: { email: "u1@example.test", name: "User One" },
      token: { state: "active", expiresAt: "2026-10-27T10:15:00.000Z" },
      handoffs: [],
      lastError: { code: "GATEWAY_BUDGET_EXCEEDED", message: "Budget used up." },
    });
    renderRow();
    const link = await screen.findByRole("link", { name: "Top up credits" });
    expect(link.getAttribute("href")).toBe("/billing");
  });
  it("opens hosted billing in the system browser on desktop when budget is exceeded", async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    (globalThis as { __CLASH_DESKTOP__: unknown }).__CLASH_DESKTOP__ = {
      isDesktop: true,
      openExternal,
    };
    stubHost({
      ...signedOut,
      signedIn: true,
      user: { email: "u1@example.test", name: "User One" },
      token: { state: "active", expiresAt: "2026-10-27T10:15:00.000Z" },
      handoffs: [],
      lastError: { code: "GATEWAY_BUDGET_EXCEEDED", message: "Budget used up." },
    });
    renderRow();
    const buttons = await screen.findAllByRole("button", { name: "Top up credits" });
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(buttons[0]!);
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith("https://clash.art/billing"),
    );
  });
  it("offers a desktop Top up credits control when signed in (no billing plugin)", async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    (globalThis as { __CLASH_DESKTOP__: unknown }).__CLASH_DESKTOP__ = {
      isDesktop: true,
      openExternal,
    };
    stubHost({
      ...signedOut,
      signedIn: true,
      user: { email: "u1@example.test", name: "User One" },
      token: { state: "active", expiresAt: "2026-10-27T10:15:00.000Z" },
      handoffs: [],
      lastError: null,
    });
    renderRow();
    const button = await screen.findByRole("button", { name: "Top up credits" });
    fireEvent.click(button);
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith("https://clash.art/billing"),
    );
  });


});

describe("officialGatewayResponseError", () => {
  it("prefixes a gateway code and leaves other Host errors as they are", async () => {
    await expect(
      officialGatewayResponseError(
        Response.json({ error: "Sign in first.", code: "GATEWAY_AUTH_REQUIRED" }, { status: 401 }),
      ),
    ).resolves.toMatchObject({ message: "GATEWAY_AUTH_REQUIRED: Sign in first." });
    await expect(
      officialGatewayResponseError(Response.json({ error: "Agent failed" }, { status: 500 })),
    ).resolves.toMatchObject({ message: "Agent failed" });
    await expect(
      officialGatewayResponseError(new Response("oops", { status: 502 })),
    ).resolves.toMatchObject({ message: "HTTP 502" });
  });
});
