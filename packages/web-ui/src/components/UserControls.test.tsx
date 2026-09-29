// @vitest-environment jsdom
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import UserControls from "./UserControls";

const authClientMock = vi.hoisted(() => ({
  useSession: vi.fn(),
  signOut: vi.fn(),
  signInSocial: vi.fn(),
}));

vi.mock("@clash/web-ui/lib/betterAuthClient", () => ({
  default: {
    useSession: authClientMock.useSession,
    signOut: authClientMock.signOut,
    signIn: {
      social: authClientMock.signInSocial,
    },
  },
}));

vi.mock("@clash/web-ui/hooks/useBillingBalance", () => ({
  useBillingBalance: () => ({ status: "unavailable" }),
}));

vi.mock("framer-motion", async () => {
  const React = await import("react");
  return {
    motion: new Proxy(
      {},
      {
        get: (_target, tag: string) =>
          ({ children, ...props }: { children?: ReactNode }) =>
            React.createElement(tag, props, children),
      },
    ),
  };
});

vi.mock("./SettingsDialog",()=>({SettingsDialog:({open}:{open:boolean})=>open?<div role="dialog" aria-label="Settings"/>:null}));
function renderUserControls() {
  return render(
    <MemoryRouter>
      <UserControls />
    </MemoryRouter>,
  );
}

describe("UserControls", () => {
  afterEach(() => {
    cleanup();
    delete globalThis.__CLASH_RUNTIME_CONFIG__;
    authClientMock.useSession.mockReset();
    authClientMock.signOut.mockReset();
    authClientMock.signInSocial.mockReset();
  });

  it("renders only a Settings entry in the local desktop runtime", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };
    authClientMock.useSession.mockReturnValue({
      data: {
        user: {
          name: "Local User",
          image: null,
        },
      },
    });

    renderUserControls();

    const settings = screen.getByRole("link", { name: "Settings" });
    expect(settings.getAttribute("href")).toBe("/settings");
    expect(screen.queryByText("Local User")).toBeNull();
    expect(screen.queryByRole("button", { name: /Account menu/i })).toBeNull();
    expect(authClientMock.useSession).not.toHaveBeenCalled();
  });

  it("keeps the compact desktop Settings entry visible on dark project chrome", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };

    render(
      <MemoryRouter>
        <UserControls compact />
      </MemoryRouter>,
    );

    const settings = screen.getByRole("link", { name: "Settings" });
    expect(settings.className).toContain("text-content-muted");
    expect(settings.className).toContain("hover:bg-warm-hover");
    expect(settings.className).toContain("hover:text-content-primary");
  });

  it("keeps the full-size desktop Settings entry visible on dark navigation chrome", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };

    renderUserControls();

    const settings = screen.getByRole("link", { name: "Settings" });
    expect(settings.className).toContain("text-content-secondary");
    expect(settings.className).toContain("hover:bg-warm-hover");
    expect(settings.className).toContain("hover:text-content-primary");
    expect(settings.className).not.toContain("hover:border-brand");
  });

  it("uses the shared tooltip primitive for icon controls instead of browser title attributes", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/web-ui/src/components/UserControls.tsx"),
      "utf8",
    );
    const tooltipSource = readFileSync(
      resolve(process.cwd(), "packages/gui/src/components/ui/tooltip.tsx"),
      "utf8",
    );

    expect(tooltipSource).toContain("@ariakit/react");
    expect(tooltipSource).toContain("TooltipProvider");
    expect(tooltipSource).toContain("TooltipAnchor");
    expect(tooltipSource).toContain("Tooltip");
    expect(source).toContain("./ui/tooltip");
    expect(source).toContain("<Tooltip label=");
    expect(source).not.toContain("UserControlTooltip");
    expect(source).not.toContain("TooltipProvider");
    expect(source).not.toContain("TooltipAnchor");
    expect(source).not.toContain("title=");
  });

  it("keeps the account menu in hosted mode", () => {
    authClientMock.useSession.mockReturnValue({
      data: {
        user: {
          name: "Local User",
          image: null,
        },
      },
    });

    renderUserControls();

    expect(screen.getByText("Local User")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Account menu.*Local User/i })).toBeTruthy();
    expect(authClientMock.useSession).toHaveBeenCalled();
  });

  it("uses Radix dropdown menu positioning for the hosted account menu", () => {
    authClientMock.useSession.mockReturnValue({
      data: {
        user: {
          name: "Local User",
          image: null,
        },
      },
    });

    renderUserControls();

    fireEvent.pointerDown(screen.getByRole("button", { name: /Account menu.*Local User/i }), {
      button: 0,
      ctrlKey: false,
    });

    const menu = screen.getByRole("menu");
    expect(menu.getAttribute("data-side")).toBe("bottom");
    expect(menu.getAttribute("data-align")).toBe("end");
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem",{name:"Settings"}));
    expect(screen.getByRole("dialog",{name:"Settings"})).toBeTruthy();
  });
});
