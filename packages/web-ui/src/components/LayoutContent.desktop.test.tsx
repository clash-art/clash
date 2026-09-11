// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import LayoutContent from "./LayoutContent";
import { sourceMatches } from "../test-support/source-match";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

vi.mock("./TopNavigation", () => ({
  default: ({ pendingPathname }: { pendingPathname?: string | null }) => (
    <div
      data-testid="desktop-chrome"
      data-pending-pathname={pendingPathname ?? ""}
    />
  ),
}));

vi.mock("./Background", () => ({
  default: () => <div data-testid="dashboard-background" />,
}));

vi.mock("./DashboardComposerDock", () => ({
  default: () => <div data-testid="dashboard-composer" />,
}));

vi.mock("./DashboardComposerContext", () => ({
  DashboardComposerProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

function renderAt(
  pathname: string,
  children: ReactNode = <div>Project canvas</div>,
) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <LayoutContent isAuthenticated>{children}</LayoutContent>
    </MemoryRouter>,
  );
}

describe("LayoutContent desktop chrome", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.documentElement.classList.remove("clash-desktop-route");
    document.documentElement.classList.remove("clash-desktop-project-route");
    document.documentElement.classList.remove("clash-is-scrolling");
    delete globalThis.__CLASH_DESKTOP__;
    delete globalThis.__CLASH_RUNTIME_CONFIG__;
  });

  it("keeps desktop tabs visible on project detail pages in Electron", () => {
    globalThis.__CLASH_DESKTOP__ = {
      isDesktop: true,
      newWindow: vi.fn(),
    };

    renderAt("/projects/project-1");

    expect(screen.getByTestId("desktop-chrome")).toBeTruthy();
    expect(screen.queryByTestId("dashboard-background")).toBeNull();
    expect(screen.getByText("Project canvas")).toBeTruthy();
  });

  it("uses the pending Dashboard workspace chrome while its route is loading", () => {
    globalThis.__CLASH_DESKTOP__ = {
      isDesktop: true,
      newWindow: vi.fn(),
    };

    render(
      <MemoryRouter initialEntries={["/projects/project-1"]}>
        <LayoutContent
          {...({
            isAuthenticated: true,
            pendingPathname: "/",
          } as any)}
        >
          <div>Dashboard loading</div>
        </LayoutContent>
      </MemoryRouter>,
    );

    expect(screen.getByTestId("desktop-chrome").dataset.pendingPathname).toBe(
      "/",
    );
    expect(screen.getByTestId("dashboard-background")).toBeTruthy();
    expect(screen.getByTestId("dashboard-composer")).toBeTruthy();
    expect(screen.getByRole("main").className).toContain(
      "clash-desktop-scroll-root",
    );
    expect(screen.getByRole("main").className).not.toContain(
      "--clash-project-editor-height",
    );
  });

  it("reserves the desktop chrome row on a deep-linked Settings route from runtime mode alone", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };

    renderAt(
      "/settings?section=models&model=seedream-5-pro",
      <div>Model settings</div>,
    );

    expect(screen.getByTestId("desktop-chrome")).toBeTruthy();
    const main = screen.getByRole("main");
    expect(main.className).toContain("mt-[var(--clash-desktop-chrome-height)]");
    expect(main.className).toContain(
      "h-[calc(100dvh-var(--clash-desktop-chrome-height))]",
    );
    expect(main.className).toContain("[--clash-desktop-chrome-height:2.5rem]");
    expect(screen.getByText("Model settings")).toBeTruthy();
    expect(screen.queryByTestId("dashboard-background")).toBeNull();
  });

  it("locks page-level scrolling for desktop project detail pages", async () => {
    globalThis.__CLASH_DESKTOP__ = {
      isDesktop: true,
      newWindow: vi.fn(),
    };

    const { unmount } = renderAt("/projects/project-1");

    await waitFor(() => {
      expect(
        document.documentElement.classList.contains(
          "clash-desktop-project-route",
        ),
      ).toBe(true);
    });

    unmount();

    await waitFor(() => {
      expect(
        document.documentElement.classList.contains(
          "clash-desktop-project-route",
        ),
      ).toBe(false);
    });
  });

  it("starts desktop project content below the native tab strip instead of padding underneath it", () => {
    globalThis.__CLASH_DESKTOP__ = {
      isDesktop: true,
      newWindow: vi.fn(),
    };

    renderAt("/projects/project-1");

    const main = screen.getByRole("main");
    expect(main.className).toContain("mt-[var(--clash-desktop-chrome-height)]");
    expect(main.className).toContain(
      "h-[calc(100dvh-var(--clash-desktop-chrome-height))]",
    );
    expect(main.className).toContain("[--clash-desktop-chrome-height:2.5rem]");
    expect(main.className).toContain(
      "[--clash-project-editor-height:calc(100dvh-var(--clash-desktop-chrome-height))]",
    );
    expect(main.className).not.toContain("h-screen");
    expect(main.className).not.toContain("pt-10");
  });

  it("uses the shared collapsible sidebar width for desktop page content", async () => {
    globalThis.__CLASH_DESKTOP__ = {
      isDesktop: true,
      newWindow: vi.fn(),
    };

    renderAt("/projects", <div>Projects index</div>);

    const main = screen.getByRole("main");
    expect(main.className).toContain("clash-desktop-scroll-root");
    expect(main.className).toContain("min-h-0");
    expect(main.className).toContain("mt-10");
    expect(main.className).toContain("h-[calc(100dvh-2.5rem)]");
    expect(main.className).toContain("overflow-y-auto");
    expect(main.className).toContain("pl-[var(--clash-app-sidebar-width)]");
    expect(main.className).toContain("[--app-page-sticky-header-top:0px]");
    expect(main.className).toContain("transition-[padding-left]");
    expect(main.className).not.toContain("pl-20");
    expect(main.className).toContain("pt-0");
    expect(main.className).not.toContain("pt-[4.5rem]");

    await waitFor(() => {
      expect(
        document.documentElement.classList.contains("clash-desktop-route"),
      ).toBe(true);
    });
  });

  it("gives the collapsed desktop sidebar zero layout width so content reclaims it", () => {
    const css = readFileSync(
      resolve(repoRoot, "apps/web/app/globals.css"),
      "utf8",
    );

    // Collapsed is fully off canvas: the padding the main region reserves for
    // the sidebar must go to zero, not to an icon-rail width.
    expect(
      sourceMatches(css, /--clash-app-sidebar-collapsed-width:\s*0(px|rem)?;/),
    ).toBe(true);
    expect(
      sourceMatches(
        css,
        /html\.clash-desktop-route\[data-clash-sidebar-collapsed="true"\]\s*\{\s*--clash-app-sidebar-width:\s*var\(--clash-app-sidebar-collapsed-width\);\s*\}/,
      ),
    ).toBe(true);
  });

  it("reveals only the scrolled panel and expires each panel independently", () => {
    vi.useFakeTimers();
    globalThis.__CLASH_DESKTOP__ = { isDesktop: true, newWindow: vi.fn() };
    const { unmount } = renderAt(
      "/projects/project-1",
      <div data-testid="parent">
        <div data-testid="left" />
        <div data-testid="right" />
      </div>,
    );
    const left = screen.getByTestId("left");
    const right = screen.getByTestId("right");
    act(() => {
      right.dispatchEvent(new Event("scroll"));
    });
    expect(right).toHaveClass("clash-is-scrolling");
    expect(left).not.toHaveClass("clash-is-scrolling");
    expect(screen.getByTestId("parent")).not.toHaveClass("clash-is-scrolling");
    expect(document.documentElement).not.toHaveClass("clash-is-scrolling");
    act(() => {
      vi.advanceTimersByTime(300);
      left.dispatchEvent(new Event("scroll"));
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(right).not.toHaveClass("clash-is-scrolling");
    expect(left).toHaveClass("clash-is-scrolling");
    unmount();
    expect(left).not.toHaveClass("clash-is-scrolling");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("marks scrollbars visible only while a scroll is active", async () => {
    vi.useFakeTimers();
    globalThis.__CLASH_DESKTOP__ = {
      isDesktop: true,
      newWindow: vi.fn(),
    };

    renderAt("/projects", <div>Projects index</div>);

    expect(
      (
        document.scrollingElement ?? document.documentElement
      ).classList.contains("clash-is-scrolling"),
    ).toBe(false);

    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });

    expect(
      (
        document.scrollingElement ?? document.documentElement
      ).classList.contains("clash-is-scrolling"),
    ).toBe(true);

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(
      (
        document.scrollingElement ?? document.documentElement
      ).classList.contains("clash-is-scrolling"),
    ).toBe(false);
  });
});
