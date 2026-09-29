// @vitest-environment jsdom
import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Link, MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import TopNavigation from "./TopNavigation";

vi.mock("./UserControls", () => ({
  default: () => <button type="button">Account</button>,
}));

vi.mock("framer-motion", async () => {
  const React = await import("react");
  return {
    motion: new Proxy(
      {},
      {
        get:
          (_target, tag: string) =>
          ({ children, ...props }: { children?: ReactNode }) =>
            React.createElement(tag, props, children),
      },
    ),
  };
});

function LocationEcho() {
  const location = useLocation();
  return <output aria-label="location">{location.pathname}</output>;
}

function enableDesktop() {
  globalThis.__CLASH_DESKTOP__ = {
    isDesktop: true,
    newWindow: vi.fn(),
  };
}

describe("TopNavigation desktop chrome", () => {
  afterEach(() => {
    cleanup();
    localStorage.removeItem("project-navigator-collapsed");
    localStorage.removeItem("clash.desktop.sidebar-collapsed");
    localStorage.removeItem("clash.desktop.sidebar-width");
    delete document.documentElement.dataset.clashSidebarCollapsed;
    delete globalThis.__CLASH_DESKTOP__;
    delete globalThis.__CLASH_RUNTIME_CONFIG__;
  });

  it("keeps project tabs in the desktop window chrome", async () => {
    enableDesktop();

    const { container } = render(
      <MemoryRouter initialEntries={["/projects/project-1"]}>
        <TopNavigation />
      </MemoryRouter>,
    );

    const tablist = await screen.findByRole("tablist", {
      name: "Open workspaces",
    });
    expect(
      screen
        .getByRole("tab", { name: "Project" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeTruthy();
    expect(
      container
        .querySelector('[data-desktop-chrome="true"]')
        ?.contains(tablist),
    ).toBe(true);
  });

  it("renders the desktop Settings tab strip from runtime mode when the Electron bridge is unavailable", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = { mode: "desktop" };

    render(
      <MemoryRouter
        initialEntries={["/settings?section=models&model=seedream-5-pro"]}
      >
        <TopNavigation />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "Dashboard" })).toBeTruthy();
    expect(
      screen.getByRole("tablist", { name: "Open workspaces" }),
    ).toBeTruthy();
    expect(
      (await screen.findByRole("tab", { name: "Settings" })).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
  });

  it("keeps project navigator controls out of the titlebar", async () => {
    enableDesktop();

    const { container } = render(
      <MemoryRouter initialEntries={["/projects/project-1"]}>
        <TopNavigation />
      </MemoryRouter>,
    );

    await screen.findByRole("tab", { name: "Project" });
    const toolbar = container.querySelector<HTMLElement>(
      '[data-desktop-toolbar="true"]',
    )!;
    expect(
      within(toolbar).queryByRole("button", { name: /project sidebar/i }),
    ).toBeNull();
    expect(
      within(toolbar).getByRole("link", { name: "Dashboard" }),
    ).toBeTruthy();
    expect(
      within(toolbar).getByRole("tablist", { name: "Open workspaces" }),
    ).toBeTruthy();
  });

  it("updates a project tab from the real desktop title event", async () => {
    enableDesktop();
    render(
      <MemoryRouter initialEntries={["/projects/project-1"]}>
        <TopNavigation />
      </MemoryRouter>,
    );

    await screen.findByRole("tab", { name: "Project" });
    window.dispatchEvent(
      new CustomEvent("clash:desktop-tab-title", {
        detail: {
          path: "/projects/project-1",
          title: "Storyboard draft",
        },
      }),
    );

    expect(
      await screen.findByRole("tab", { name: "Storyboard draft" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Close Storyboard draft" }),
    ).toBeTruthy();
  });

  it("shows the Project Loro connection failure on the owning tab", async () => {
    enableDesktop();
    const { container } = render(
      <MemoryRouter initialEntries={["/projects/project-1"]}>
        <TopNavigation />
      </MemoryRouter>,
    );

    await screen.findByRole("tab", { name: "Project" });
    window.dispatchEvent(
      new CustomEvent("clash:desktop-tab-connection", {
        detail: {
          path: "/projects/project-1",
          connection: "disconnected",
        },
      }),
    );

    await waitFor(() => {
      expect(
        container.querySelector('[data-desktop-tab-connection="disconnected"]'),
      ).toBeTruthy();
    });
  });

  it("keeps two projects open while the titlebar new-tab control opens the project picker", async () => {
    enableDesktop();
    render(
      <MemoryRouter initialEntries={["/"]}>
        <TopNavigation />
        <Link to="/projects/project-alpha">Open Alpha</Link>
        <Link to="/projects/project-beta">Open Beta</Link>
        <LocationEcho />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Open Alpha" }));
    await screen.findByRole("tab", { name: "Project" });
    window.dispatchEvent(
      new CustomEvent("clash:desktop-tab-title", {
        detail: {
          path: "/projects/project-alpha",
          title: "Alpha",
        },
      }),
    );
    expect(await screen.findByRole("tab", { name: "Alpha" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => {
      expect(screen.getByLabelText("location").textContent).toBe("/projects");
    });

    fireEvent.click(screen.getByRole("link", { name: "Open Beta" }));
    await waitFor(() => {
      expect(screen.getByLabelText("location").textContent).toBe(
        "/projects/project-beta",
      );
    });
    window.dispatchEvent(
      new CustomEvent("clash:desktop-tab-title", {
        detail: {
          path: "/projects/project-beta",
          title: "Beta",
        },
      }),
    );

    expect(await screen.findByRole("tab", { name: "Alpha" })).toBeTruthy();
    expect(await screen.findByRole("tab", { name: "Beta" })).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("renders the selected Paper-style project tab after a fixed Dashboard entry", async () => {
    enableDesktop();
    const { container } = render(
      <MemoryRouter initialEntries={["/projects/project-1"]}>
        <TopNavigation />
      </MemoryRouter>,
    );

    const dashboard = await screen.findByRole("link", { name: "Dashboard" });
    const tablist = screen.getByRole("tablist", { name: "Open workspaces" });
    const projectTab = screen.getByRole("tab", { name: "Project" });
    const openProject = screen.getByRole("button", { name: "Open project" });
    const projectShell = projectTab.closest<HTMLElement>(
      "[data-desktop-workspace-tab]",
    );

    expect(
      container.querySelector('[data-desktop-dashboard-icon="true"]'),
    ).toBeTruthy();
    expect(projectShell?.dataset.active).toBe("true");
    expect(
      projectShell?.querySelector('[data-workspace-tab-icon="true"]'),
    ).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Home" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Forward" })).toBeNull();
    expect(
      dashboard.compareDocumentPosition(tablist) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      tablist.compareDocumentPosition(openProject) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("closes an active project tab back to Dashboard", async () => {
    enableDesktop();
    render(
      <MemoryRouter initialEntries={["/projects/project-1"]}>
        <TopNavigation />
        <LocationEcho />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("tab", { name: "Project" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Project" }));

    await waitFor(() => {
      expect(screen.getByLabelText("location").textContent).toBe("/");
      expect(
        screen
          .getByRole("link", { name: "Dashboard" })
          .getAttribute("aria-current"),
      ).toBe("page");
    });
    expect(screen.queryByRole("tab", { name: "Project" })).toBeNull();
  });

  it("opens the real Global Assets product surface on the web", () => {
    render(
      <MemoryRouter initialEntries={["/assets"]}>
        <TopNavigation />
      </MemoryRouter>,
    );

    const primary = screen.getByRole("navigation", { name: "Primary" });
    const assets = within(primary).getByRole("link", { name: "Assets" });
    expect(assets.getAttribute("href")).toBe("/assets");
    expect(assets.getAttribute("aria-current")).toBe("page");
  });

  it("anchors an explicit collapse action in the brand row and keeps hidden-only restore", async () => {
    enableDesktop();
    localStorage.setItem("clash.desktop.sidebar-width", "344");

    render(
      <MemoryRouter initialEntries={["/"]}>
        <TopNavigation />
      </MemoryRouter>,
    );

    const primary = await screen.findByRole("navigation", { name: "Primary" });
    const sidebar = screen.getByRole("complementary", {
      name: "Application shortcuts",
    });
    expect(primary.getAttribute("data-orientation")).toBe("vertical");
    expect(sidebar.getAttribute("data-state")).toBe("expanded");
    expect(sidebar).toHaveStyle({ width: "344px" });
    expect(
      within(sidebar).getByRole("link", { name: "Clash home" }),
    ).toBeTruthy();
    expect(
      within(sidebar).getByRole("link", { name: "Clash home" }).textContent,
    ).toContain("Clash");
    expect(
      within(sidebar)
        .getByRole("link", { name: "Clash home" })
        .querySelector('[data-slot="clash-agent-avatar"], img'),
    ).toBeTruthy();
    expect(sidebar.querySelector("[data-sidebar-header-anchor]")).toBeTruthy();

    const collapseSidebar = screen.getByRole("button", {
      name: "Collapse Application shortcuts",
    });
    expect(collapseSidebar.parentElement?.className).toContain(
      "h-[var(--clash-app-sidebar-header-height)]",
    );
    expect(collapseSidebar.parentElement?.className).toContain("items-center");
    expect(
      screen.queryByRole("button", { name: "Open Application shortcuts" }),
    ).toBeNull();

    for (const name of ["Home", "Projects", "Assets", "Store"]) {
      const shortcut = within(primary).getByRole("button", { name });
      expect(shortcut.textContent).toContain(name);
      expect(shortcut.getAttribute("title")).toBeNull();
    }

    for (const [name, kind] of [
      ["Home", "home"],
      ["Projects", "projects"],
      ["Assets", "assets"],
      ["Store", "store"],
    ] as const) {
      expect(
        within(primary)
          .getByRole("button", { name })
          .querySelector(`[data-slot="product-nav-icon"][data-kind="${kind}"]`),
      ).toBeTruthy();
    }

    fireEvent.click(collapseSidebar);

    await waitFor(() => {
      expect(sidebar.getAttribute("data-state")).toBe("collapsed");
    });
    expect(localStorage.getItem("clash.desktop.sidebar-collapsed")).toBe(
      "true",
    );
    expect(document.documentElement.dataset.clashSidebarCollapsed).toBe("true");
    expect(sidebar.style.width).toBe("0px");
    expect(document.querySelector("[data-sidebar-restore]")).toBeNull();

    // Collapsed is fully hidden, never an icon rail: the full labeled contents
    // stay mounted off canvas and inert.
    const panel = sidebar.querySelector<HTMLElement>("[data-sidebar-panel]")!;
    expect(panel).toHaveAttribute("inert");
    expect(panel.style.transform).toBe("translateX(calc(-100% - 1.5rem))");
    // Off canvas the contents are hidden from assistive tech, so assert the DOM
    // directly: the full labeled sidebar is still what is mounted.
    expect(panel.querySelector('[aria-label="Clash home"]')).toBeTruthy();
    for (const name of ["Home", "Projects", "Assets", "Store"]) {
      const shortcut = panel.querySelector<HTMLElement>(
        `nav[aria-label="Primary"] button[aria-label="${name}"]`,
      );
      expect(shortcut?.textContent?.trim()).toBe(name);
    }

    expect(
      screen.queryByRole("button", { name: "Open Application shortcuts" }),
    ).toBeNull();
  });

  it("uses shared sidebar vertical anchors for its first control", async () => {
    enableDesktop();

    render(
      <MemoryRouter initialEntries={["/"]}>
        <TopNavigation />
      </MemoryRouter>,
    );

    const sidebar = await screen.findByRole("complementary", {
      name: "Application shortcuts",
    });
    const header = sidebar.querySelector<HTMLElement>(
      "[data-sidebar-header-anchor]",
    )!;
    const search = within(sidebar).getByRole("button", {
      name: "Search Clash",
    });
    const searchSlot = search.parentElement!;
    const brand = within(header).getByRole("link", { name: "Clash home" });
    const collapse = within(header).getByRole("button", {
      name: "Collapse Application shortcuts",
    });

    expect(header.dataset.slot).toBe("desktop-sidebar-header");
    expect(header.className).toContain(
      "h-[var(--clash-app-sidebar-header-height)]",
    );
    expect(header.className).toContain("items-center");
    expect(header.className).toContain(
      "pt-[var(--clash-app-sidebar-section-gap)]",
    );
    expect(header.className).toContain("pb-0");
    expect(header.className).not.toContain("py-0");
    expect(brand.className).toContain(
      "h-[var(--clash-project-control-height,2rem)]",
    );
    expect(collapse.className).toContain("h-8");
    expect(header.nextElementSibling).toBe(searchSlot);
    expect(searchSlot.className).toContain(
      "pt-[var(--clash-app-sidebar-section-gap)]",
    );
    expect(searchSlot.className).not.toMatch(/\b(?:mt|mb|pb)-/);
  });

  it("previews the full global sidebar from the left edge without persisting state", async () => {
    enableDesktop();
    localStorage.setItem("clash.desktop.sidebar-collapsed", "true");

    render(
      <MemoryRouter initialEntries={["/"]}>
        <TopNavigation />
      </MemoryRouter>,
    );

    const sidebar = await screen.findByRole("complementary", {
      name: "Application shortcuts",
    });
    expect(sidebar.getAttribute("data-state")).toBe("collapsed");
    expect(document.querySelector("[data-sidebar-restore]")).toBeNull();

    const recovery = screen.getByRole("button", {
      name: "Show Application shortcuts",
    });
    const hoverRail = sidebar.querySelector<HTMLElement>(
      "[data-sidebar-hover-rail]",
    )!;
    fireEvent.pointerEnter(hoverRail);

    await waitFor(() => {
      expect(sidebar.getAttribute("data-state")).toBe("preview");
    });
    // Preview shows the full labeled sidebar, not an icon rail.
    const primary = within(sidebar).getByRole("navigation", {
      name: "Primary",
    });
    expect(
      within(primary).getByRole("button", { name: "Projects" }).textContent,
    ).toContain("Projects");
    expect(
      within(sidebar).getByRole("button", {
        name: "Keep Application shortcuts open",
      }),
    ).toBeTruthy();
    // Preview never writes persisted state.
    expect(localStorage.getItem("clash.desktop.sidebar-collapsed")).toBe(
      "true",
    );
    expect(document.documentElement.dataset.clashSidebarCollapsed).toBe("true");

    const previewPanel = sidebar.querySelector<HTMLElement>(
      "[data-sidebar-panel]",
    )!;
    fireEvent.pointerEnter(previewPanel);
    expect(sidebar.getAttribute("data-state")).toBe("preview");

    fireEvent.pointerLeave(hoverRail);
    await waitFor(() => {
      expect(sidebar.getAttribute("data-state")).toBe("collapsed");
    });
    expect(localStorage.getItem("clash.desktop.sidebar-collapsed")).toBe(
      "true",
    );

    fireEvent.pointerEnter(hoverRail);
    fireEvent.click(
      within(sidebar).getByRole("button", {
        name: "Keep Application shortcuts open",
      }),
    );
    expect(sidebar.getAttribute("data-state")).toBe("expanded");
    expect(localStorage.getItem("clash.desktop.sidebar-collapsed")).toBe(
      "false",
    );
    expect(document.documentElement.dataset.clashSidebarCollapsed).toBe(
      "false",
    );
  });

  it("keeps the preview below top chrome without dimming the workspace", async () => {
    enableDesktop();
    localStorage.setItem("clash.desktop.sidebar-collapsed", "true");

    const { container } = render(
      <MemoryRouter initialEntries={["/"]}>
        <TopNavigation />
      </MemoryRouter>,
    );

    expect(
      container.querySelector<HTMLElement>('[data-desktop-chrome="true"]'),
    ).toBeTruthy();

    fireEvent.pointerEnter(
      await screen.findByRole("button", {
        name: "Show Application shortcuts",
      }),
    );

    expect(
      screen.queryByTestId("desktop-auto-hide-sidebar-scrim"),
    ).not.toBeInTheDocument();
    const panel = document.querySelector<HTMLElement>("[data-sidebar-panel]");
    expect(panel?.className).toContain(
      "top-[calc(var(--clash-desktop-chrome-height,0px)+0.5rem)]",
    );
  });

  it("omits sidebar restore controls where there is no sidebar", async () => {
    enableDesktop();

    const { unmount } = render(
      <MemoryRouter initialEntries={["/settings"]}>
        <TopNavigation />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("link", { name: "Dashboard" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /sidebar/i })).toBeNull();
    unmount();

    render(
      <MemoryRouter initialEntries={["/projects/project-1"]}>
        <TopNavigation />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("tab", { name: "Project" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /project sidebar/i }),
    ).toBeNull();
  });

  it("opens real product navigation from the global Cmd-K palette", async () => {
    enableDesktop();

    render(
      <MemoryRouter initialEntries={["/"]}>
        <TopNavigation />
        <LocationEcho />
      </MemoryRouter>,
    );

    const trigger = await screen.findByRole("button", {
      name: "Search Clash",
    });
    expect(trigger.textContent).toContain("Search");
    expect(trigger.textContent).toContain("⌘K");

    fireEvent.keyDown(window, { key: "k", metaKey: true });

    const search = await screen.findByRole("combobox", {
      name: "Search Clash",
    });
    fireEvent.change(search, { target: { value: "assets" } });
    fireEvent.click(screen.getByRole("option", { name: "Assets" }));

    await waitFor(() => {
      expect(screen.getByLabelText("location").textContent).toBe("/assets");
    });
    expect(screen.queryByRole("combobox", { name: "Search Clash" })).toBeNull();
  });

  it("keeps product shortcuts and account controls outside the draggable window chrome", async () => {
    enableDesktop();

    const { container } = render(
      <MemoryRouter initialEntries={["/"]}>
        <TopNavigation />
      </MemoryRouter>,
    );

    const desktopChrome = container.querySelector(
      '[data-desktop-chrome="true"]',
    );
    const shortcuts = await screen.findByRole("navigation", {
      name: "Primary",
    });
    const account = await screen.findByRole("button", { name: "Account" });

    expect(desktopChrome?.contains(shortcuts)).toBe(false);
    expect(desktopChrome?.contains(account)).toBe(false);
    expect(shortcuts.closest("aside")?.contains(account)).toBe(true);
    expect(desktopChrome?.contains(screen.getByRole("tablist"))).toBe(true);
  });

  it("opens Settings as a selected and closable workspace tab", async () => {
    enableDesktop();

    const { container } = render(
      <MemoryRouter initialEntries={["/settings"]}>
        <TopNavigation />
        <LocationEcho />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("link", { name: "Dashboard" })).toBeTruthy();
    expect(
      container.querySelector('[data-desktop-chrome="true"]'),
    ).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Account" })).toBeNull();
    expect(
      screen.getByRole("tablist", { name: "Open workspaces" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: "Settings" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close Settings" }));
    await waitFor(() => {
      expect(screen.getByLabelText("location").textContent).toBe("/");
    });
    expect(screen.queryByRole("tab", { name: "Settings" })).toBeNull();
  });

  it("keeps global hubs out of the workspace tab history when Settings closes", async () => {
    enableDesktop();

    render(
      <MemoryRouter initialEntries={["/projects/project-1"]}>
        <TopNavigation />
        <Link to="/projects">Open project picker</Link>
        <Link to="/settings">Open Settings</Link>
        <LocationEcho />
      </MemoryRouter>,
    );

    await screen.findByRole("tab", { name: "Project" });
    fireEvent.click(screen.getByRole("link", { name: "Open project picker" }));
    await waitFor(() => {
      expect(screen.getByLabelText("location").textContent).toBe("/projects");
    });
    expect(screen.queryByRole("tab", { name: "Projects" })).toBeNull();

    fireEvent.click(screen.getByRole("link", { name: "Open Settings" }));
    expect(await screen.findByRole("tab", { name: "Settings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Settings" }));

    await waitFor(() => {
      expect(screen.getByLabelText("location").textContent).toBe(
        "/projects/project-1",
      );
    });
    expect(screen.getByRole("tab", { name: "Project" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Settings" })).toBeNull();
  });

  it("keeps a global hub open when a background workspace tab closes", async () => {
    enableDesktop();

    render(
      <MemoryRouter initialEntries={["/projects/project-1"]}>
        <TopNavigation />
        <Link to="/projects">Open project picker</Link>
        <LocationEcho />
      </MemoryRouter>,
    );

    await screen.findByRole("tab", { name: "Project" });
    fireEvent.click(screen.getByRole("link", { name: "Open project picker" }));
    await waitFor(() => {
      expect(screen.getByLabelText("location").textContent).toBe("/projects");
    });

    fireEvent.click(screen.getByRole("button", { name: "Close Project" }));

    await waitFor(() => {
      expect(screen.queryByRole("tab", { name: "Project" })).toBeNull();
    });
    expect(screen.getByLabelText("location").textContent).toBe("/projects");
  });

  it("waits for Dashboard navigation instead of preselecting it on pointer down", async () => {
    enableDesktop();

    render(
      <MemoryRouter initialEntries={["/projects/project-1"]}>
        <TopNavigation />
        <LocationEcho />
      </MemoryRouter>,
    );

    const projectTab = await screen.findByRole("tab", { name: "Project" });
    const dashboard = screen.getByRole("link", { name: "Dashboard" });
    expect(dashboard.getAttribute("href")).toBe("/");
    expect(dashboard.dataset.active).toBe("false");

    fireEvent.pointerDown(dashboard);

    expect(dashboard.dataset.active).toBe("false");
    expect(projectTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByLabelText("location").textContent).toBe(
      "/projects/project-1",
    );

    fireEvent.click(dashboard);
    await waitFor(() => {
      expect(screen.getByLabelText("location").textContent).toBe("/");
    });
    expect(screen.getByRole("tab", { name: "Project" })).toBeTruthy();

    fireEvent.click(projectTab);
    await waitFor(() => {
      expect(screen.getByLabelText("location").textContent).toBe(
        "/projects/project-1",
      );
    });
  });

  it("keeps the empty native chrome draggable and aligned with macOS traffic lights", async () => {
    enableDesktop();

    const { container } = render(
      <MemoryRouter initialEntries={["/"]}>
        <TopNavigation />
      </MemoryRouter>,
    );

    const desktopChrome = container.querySelector<HTMLElement>(
      '[data-desktop-chrome="true"]',
    );
    const toolbar = container.querySelector<HTMLElement>(
      '[data-desktop-toolbar="true"]',
    );
    await screen.findByRole("navigation", { name: "Primary" });

    expect(
      desktopChrome?.style.getPropertyValue("--clash-desktop-chrome-height"),
    ).toBe("40px");
    expect(
      desktopChrome?.style.getPropertyValue(
        "--clash-desktop-toolbar-left-inset",
      ),
    ).toBe("92px");
    expect(desktopChrome?.className).toContain("desktop-drag-region");
    expect(toolbar?.className).toContain(
      "pl-[max(var(--clash-desktop-toolbar-left-inset),env(safe-area-inset-left))]",
    );
    expect(toolbar?.querySelector(".desktop-drag-region")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New Tab" })).toBeNull();
  });
});

it("uses vertical shared navigation on hosted Web", () => {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <TopNavigation />
      <LocationEcho />
    </MemoryRouter>,
  );
  const nav = screen.getByRole("navigation", { name: "Primary" });
  expect(nav.getAttribute("data-orientation")).toBe("vertical");
  fireEvent.click(within(nav).getByRole("link", { name: "Assets" }));
  expect(screen.getByLabelText("location").textContent).toBe("/assets");
});
