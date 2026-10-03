import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  desktopChromeMetrics,
  type RuntimeEndpointConfig,
} from "@clash/shared-runtime";
import type { NleAvailability } from "@clash/remotion-core";
import {
  File,
  MagnifyingGlass,
  Plus,
  SlidersHorizontal,
  SquaresFour,
  X,
} from "@phosphor-icons/react";
import UserControls from "./UserControls";
import {
  DesktopAutoHideSidebar,
  DesktopSidebarCollapseButton,
} from "./DesktopAutoHideSidebar";
import { Button } from "./ui/button";
import {
  Combobox,
  ComboboxItem,
  ComboboxList,
  ComboboxProvider,
  useComboboxStore,
} from "./ui/combobox";
import { Dialog } from "./ui/dialog";
import { IconButton } from "./ui/icon-button";
import { Tab, TabList, TabProvider, appTabTriggerClassName } from "./ui/tabs";
import { Tooltip } from "./ui/tooltip";
import { HarnessUpdateNotifier } from "./HarnessUpdateNotifier";
import { BrandAsset } from "./BrandAsset";
import { AgentMotion } from "./copilot/AgentMotion";
import { ProductNavIcon, type ProductNavIconKind } from "./ProductNavIcon";
import { isDesktopRuntime } from "../lib/runtimeConfig";
import {
  activateDesktopPath,
  closeDesktopTab,
  createDesktopTab,
  DESKTOP_TAB_CONNECTION_EVENT,
  DESKTOP_TAB_TITLE_EVENT,
  isDesktopWorkspaceTabPath,
  type DesktopTab,
  type DesktopTabConnectionEventDetail,
  type DesktopTabTitleEventDetail,
  updateDesktopTabConnection,
  updateDesktopTabTitle,
} from "../lib/desktopTabs";

declare global {
  var __CLASH_DESKTOP__:
    | {
        isDesktop: true;
        newWindow: () => Promise<{ windowId: number; windowCount: number }>;
        onProjectBrowserOpenTab?: (
          listener: (request: { url: string; disposition: string }) => void,
        ) => () => void;
        refreshRuntime?: () => Promise<RuntimeEndpointConfig>;
        authorizeProvider?: (request: {
          verificationUri: string;
          callbackScheme: string;
        }) => Promise<{ cancelled: boolean; callbackUrl?: string }>;
        openExternal?: (url: string) => Promise<void>;
        getNleAvailability?: () => Promise<NleAvailability[]>;
        exportDirectorVideo?: (
          request: unknown,
        ) => Promise<{ canceled: boolean; outputPath?: string }>;
        openInNle?: (request: unknown) => Promise<{ documentPath: string }>;
      }
    | undefined;
}

const navItems = [
  { name: "Home", href: "/", kind: "home" },
  { name: "Projects", href: "/projects", kind: "projects" },
  { name: "Assets", href: "/assets", kind: "assets" },
  { name: "Store", href: "/marketplace/manage", kind: "store" },
] satisfies Array<{
  name: string;
  href: string;
  kind: ProductNavIconKind;
}>;

const desktopCommands: Array<{
  name: string;
  href: string;
  kind?: ProductNavIconKind;
  icon?: typeof SlidersHorizontal;
}> = [
  ...navItems,
  { name: "Settings", href: "/settings", icon: SlidersHorizontal },
];

const DESKTOP_SIDEBAR_COLLAPSED_KEY = "clash.desktop.sidebar-collapsed";
const HOME_DESKTOP_TAB_ID = "tab-home";

function ensureHomeDesktopTab(tabs: DesktopTab[]): DesktopTab[] {
  const homeTab = tabs.find((tab) => tab.path === "/");
  const remainingTabs = tabs.filter((tab) => tab.path !== "/");
  return [
    homeTab ?? createDesktopTab("/", HOME_DESKTOP_TAB_ID),
    ...remainingTabs,
  ];
}

function readDesktopSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.localStorage.getItem(DESKTOP_SIDEBAR_COLLAPSED_KEY) === "true"
    );
  } catch {
    return false;
  }
}

function persistDesktopSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(
      DESKTOP_SIDEBAR_COLLAPSED_KEY,
      String(collapsed),
    );
  } catch {
    // The sidebar still works when storage is unavailable.
  }
}

function DesktopCommandPalette({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);
  const selectCommand = useCallback(
    (href: string) => {
      const command = desktopCommands.find(
        (candidate) => candidate.href === href,
      );
      if (!command) return;
      onNavigate(command.href);
      close();
    },
    [close, onNavigate],
  );
  const store = useComboboxStore({
    value: query,
    setValue: setQuery,
    setSelectedValue: (value) => {
      if (typeof value === "string") selectCommand(value);
    },
    focusLoop: true,
    focusWrap: true,
    orientation: "vertical",
  });
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const results = desktopCommands.filter((command) =>
    command.name.toLocaleLowerCase().includes(normalizedQuery),
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLocaleLowerCase() === "k"
      ) {
        event.preventDefault();
        setOpen(true);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const trigger = (
    <Button
      aria-label="Search Clash"
      variant={null}
      size={null}
      shape={null}
      onClick={() => setOpen(true)}
      className={[
        "h-[var(--clash-app-sidebar-search-height)] justify-start rounded-lg border border-warm-border bg-warm-surface text-[13px] font-normal text-content-muted shadow-none hover:bg-warm-hover hover:text-content-primary focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/50 focus-visible:ring-offset-0",
        collapsed ? "w-9 justify-center px-0" : "w-full gap-2 px-2.5",
      ].join(" ")}
      leftIcon={<MagnifyingGlass className="h-4 w-4" weight="regular" />}
    >
      {!collapsed ? (
        <>
          <span className="min-w-0 flex-1 truncate text-left">Search</span>
          <kbd className="font-sans text-[11px] font-medium text-content-disabled">
            ⌘K
          </kbd>
        </>
      ) : null}
    </Button>
  );

  return (
    <>
      {collapsed ? (
        <Tooltip label="Search" placement="right">
          {trigger}
        </Tooltip>
      ) : (
        trigger
      )}
      <Dialog
        open={open}
        onClose={close}
        ariaLabel="Search Clash"
        size="auto"
        hideCloseButton
        unstyled
        containerClassName="items-start pt-[12vh]"
        contentClassName="w-full max-w-lg overflow-hidden rounded-xl border border-warm-border bg-warm-surface shadow-overlay"
      >
        <ComboboxProvider store={store}>
          <div className="relative border-b border-warm-border">
            <MagnifyingGlass
              aria-hidden="true"
              className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-content-muted"
            />
            <Combobox
              aria-label="Search Clash"
              autoComplete="list"
              autoSelect
              autoFocus
              placeholder="Go to a page"
              className="h-12 w-full bg-transparent pl-11 pr-4 text-sm text-content-primary outline-none placeholder:text-content-disabled focus-visible:ring-0"
            />
          </div>
          <ComboboxList
            aria-label="Clash commands"
            alwaysVisible
            className="max-h-80 overflow-y-auto p-1.5"
          >
            {results.length === 0 ? (
              <div
                role="status"
                className="flex h-12 items-center justify-center text-xs text-content-muted"
              >
                No results
              </div>
            ) : (
              results.map((command) => {
                const CommandIcon = command.icon;
                return (
                  <ComboboxItem
                    key={command.href}
                    value={command.href}
                    focusOnHover
                    setValueOnClick={false}
                    aria-label={command.name}
                    className="flex h-10 w-full cursor-default items-center gap-3 rounded-lg px-3 text-left text-sm text-content-primary outline-none hover:bg-warm-hover data-[active-item]:bg-warm-hover focus-visible:bg-warm-hover"
                  >
                    {command.kind ? (
                      <ProductNavIcon
                        kind={command.kind}
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0 text-content-muted"
                      />
                    ) : CommandIcon ? (
                      <CommandIcon
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0 text-content-muted"
                      />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {command.name}
                    </span>
                  </ComboboxItem>
                );
              })
            )}
          </ComboboxList>
        </ComboboxProvider>
      </Dialog>
    </>
  );
}

const desktopChromeStyle = {
  "--clash-desktop-chrome-height": `${desktopChromeMetrics.tabStripHeight}px`,
  "--clash-desktop-toolbar-left-inset": `${desktopChromeMetrics.toolbarLeftInset}px`,
} as CSSProperties;

export default function TopNavigation({
  pendingPathname,
}: {
  pendingPathname?: string | null;
} = {}) {
  const currentPathname = useLocation().pathname;
  const navigate = useNavigate();
  const isDesktop = isDesktopRuntime();
  const pathname =
    isDesktop && pendingPathname ? pendingPathname : currentPathname;
  const isProjectDetailPage = /^\/projects\/[^/]+$/.test(pathname);
  const isSettingsPage = pathname === "/settings";
  const [desktopTabs, setDesktopTabs] = useState<DesktopTab[]>([]);
  const [activeDesktopTabId, setActiveDesktopTabId] = useState<string | null>(
    null,
  );
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(() =>
    !isDesktop && typeof window !== "undefined" && window.innerWidth < 768
      ? true
      : readDesktopSidebarCollapsed(),
  );
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.clashSidebarCollapsed = String(desktopSidebarCollapsed);
    return () => {
      delete root.dataset.clashSidebarCollapsed;
    };
  }, [desktopSidebarCollapsed, isDesktop]);

  useEffect(() => {
    if (!isDesktop) return;
    const id = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    setDesktopTabs((tabs) => {
      const next = activateDesktopPath(
        ensureHomeDesktopTab(tabs),
        pathname,
        id,
        HOME_DESKTOP_TAB_ID,
      );
      setActiveDesktopTabId(next.activeTabId);
      return ensureHomeDesktopTab(next.tabs);
    });
  }, [isDesktop, pathname]);

  useEffect(() => {
    if (!isDesktop) return;

    const handleDesktopTabTitle = (event: Event) => {
      const detail = (event as CustomEvent<DesktopTabTitleEventDetail>).detail;
      if (
        !detail ||
        typeof detail.path !== "string" ||
        typeof detail.title !== "string"
      ) {
        return;
      }
      setDesktopTabs((tabs) =>
        updateDesktopTabTitle(tabs, detail.path, detail.title),
      );
    };

    window.addEventListener(DESKTOP_TAB_TITLE_EVENT, handleDesktopTabTitle);
    return () =>
      window.removeEventListener(
        DESKTOP_TAB_TITLE_EVENT,
        handleDesktopTabTitle,
      );
  }, [isDesktop]);

  useEffect(() => {
    if (!isDesktop) return;

    const handleDesktopTabConnection = (event: Event) => {
      const detail = (event as CustomEvent<DesktopTabConnectionEventDetail>)
        .detail;
      if (!detail || typeof detail.path !== "string") return;
      setDesktopTabs((tabs) =>
        updateDesktopTabConnection(tabs, detail.path, detail.connection),
      );
    };

    window.addEventListener(
      DESKTOP_TAB_CONNECTION_EVENT,
      handleDesktopTabConnection,
    );
    return () =>
      window.removeEventListener(
        DESKTOP_TAB_CONNECTION_EVENT,
        handleDesktopTabConnection,
      );
  }, [isDesktop]);

  const openDesktopPath = (path: string) => {
    if (pathname !== path) navigate(path);
  };
  const selectDesktopTabId = (tabId: string | null | undefined) => {
    const tab = desktopTabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    setActiveDesktopTabId(tab.id);
    if (tab.path !== pathname) navigate(tab.path);
  };
  const closeTab = (tabId: string) => {
    const tabToClose = desktopTabs.find((tab) => tab.id === tabId);
    if (!tabToClose || tabToClose.path === "/") return;
    const wasActiveWorkspace = tabId === activeDesktopTabId;

    if (!activeDesktopTabId) {
      setDesktopTabs((tabs) =>
        ensureHomeDesktopTab(tabs.filter((tab) => tab.id !== tabId)),
      );
      return;
    }

    const result = closeDesktopTab(
      ensureHomeDesktopTab(desktopTabs),
      activeDesktopTabId,
      tabId,
      HOME_DESKTOP_TAB_ID,
    );
    const nextTabs = ensureHomeDesktopTab(result.tabs);
    const nextActiveTab =
      nextTabs.find((tab) => tab.id === result.activeTabId) ?? nextTabs[0];
    setDesktopTabs(nextTabs);
    setActiveDesktopTabId(nextActiveTab.id);
    if (wasActiveWorkspace && nextActiveTab.path !== pathname) {
      navigate(nextActiveTab.path);
    }
  };
  const setDesktopSidebarVisibility = (collapsed: boolean) => {
    setDesktopSidebarCollapsed(collapsed);
    persistDesktopSidebarCollapsed(collapsed);
  };

  const hasGlobalSidebar = !isProjectDetailPage && !isSettingsPage;
  const openWorkspaceTabs = desktopTabs.filter((tab) =>
    isDesktopWorkspaceTabPath(tab.path),
  );
  const dashboardActive = activeDesktopTabId === HOME_DESKTOP_TAB_ID;

  if (isDesktop) {
    return (
      <>
        <header
          data-desktop-chrome="true"
          style={desktopChromeStyle}
          className="desktop-drag-region fixed left-0 right-0 top-0 z-50 h-[var(--clash-desktop-chrome-height)] border-b border-warm-border bg-warm-muted text-content-primary"
        >
          <div
            data-desktop-toolbar="true"
            className="flex h-full items-center gap-1.5 pl-[max(var(--clash-desktop-toolbar-left-inset),env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))]"
          >
            <Link
              data-desktop-dashboard="true"
              data-active={String(dashboardActive)}
              aria-label="Dashboard"
              aria-current={pathname === "/" ? "page" : undefined}
              to="/"
              className={`desktop-no-drag inline-flex h-8 flex-none items-center gap-2 rounded-lg px-2 text-sm font-medium shadow-none outline-none transition-colors hover:bg-warm-hover hover:text-content-primary focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-0 focus-visible:ring-offset-warm-muted ${
                dashboardActive
                  ? "bg-warm-surface text-content-primary shadow-raised"
                  : "bg-transparent text-content-secondary"
              }`}
            >
              <SquaresFour
                data-desktop-dashboard-icon="true"
                aria-hidden="true"
                className="h-[18px] w-[18px]"
                weight="regular"
              />
              Dashboard
            </Link>
            <span
              aria-hidden="true"
              className="mx-1 h-6 w-px flex-none bg-warm-border"
            />
            <TabProvider
              selectedId={activeDesktopTabId ?? undefined}
              setSelectedId={selectDesktopTabId}
              focusLoop
            >
              <TabList
                aria-label="Open workspaces"
                className="desktop-drag-region flex min-w-0 items-center gap-1.5 overflow-x-auto"
              >
                {openWorkspaceTabs.map((tab) => {
                  const active = tab.id === activeDesktopTabId;
                  const TabIcon =
                    tab.path === "/settings" ? SlidersHorizontal : File;

                  return (
                    <div
                      key={tab.id}
                      data-desktop-workspace-tab="true"
                      data-active={String(active)}
                      className={`desktop-no-drag group relative flex h-8 min-w-36 max-w-64 items-center gap-1 rounded-lg border pl-2.5 pr-1 text-sm font-medium transition-[background-color,border-color,box-shadow,color] ${
                        active
                          ? "border-warm-border shadow-raised"
                          : "border-transparent"
                      }`}
                    >
                      <Tab
                        id={tab.id}
                        aria-label={tab.title}
                        className={appTabTriggerClassName({
                          selected: active,
                          className: `flex min-w-0 flex-1 items-center gap-2 truncate text-left ${
                            active
                              ? "text-content-primary"
                              : "text-content-muted hover:text-content-primary"
                          }`,
                        })}
                      >
                        <TabIcon
                          data-workspace-tab-icon="true"
                          aria-hidden="true"
                          className="h-[18px] w-[18px] flex-none"
                          weight="regular"
                        />
                        <span className="truncate">{tab.title}</span>
                      </Tab>
                      {tab.connection ? (
                        <span
                          role="status"
                          aria-label={`Project connection: ${tab.connection}`}
                          title={`Project connection: ${tab.connection}`}
                          data-desktop-tab-connection={tab.connection}
                          className={`h-2 w-2 flex-none rounded-full ${
                            tab.connection === "connected"
                              ? "bg-emerald-500"
                              : tab.connection === "connecting"
                                ? "animate-pulse bg-amber-400"
                                : "bg-red-500 ring-2 ring-red-500/20"
                          }`}
                        />
                      ) : null}
                      <Tooltip label={`Close ${tab.title}`}>
                        <IconButton
                          label={`Close ${tab.title}`}
                          icon={<X className="h-3 w-3" weight="bold" />}
                          size="sm"
                          shape="circle"
                          onClick={() => closeTab(tab.id)}
                          className="flex-none text-content-muted hover:bg-black/10 hover:text-content-primary dark:hover:bg-white/10"
                        />
                      </Tooltip>
                    </div>
                  );
                })}
              </TabList>
            </TabProvider>
            <Tooltip label="Open project">
              <IconButton
                label="Open project"
                icon={<Plus className="h-4 w-4" weight="regular" />}
                size="sm"
                onClick={() => openDesktopPath("/projects")}
                className="desktop-no-drag flex-none text-content-secondary hover:bg-warm-hover hover:text-content-primary"
              />
            </Tooltip>
            <HarnessUpdateNotifier />
          </div>
        </header>

        {hasGlobalSidebar && (
          /*
           * The global sidebar is never an icon rail: expanded and preview both
           * render the same full, labeled contents, and collapsed takes the
           * whole panel off canvas with zero layout width.
           */
          <DesktopAutoHideSidebar
            collapsed={desktopSidebarCollapsed}
            onCollapsedChange={setDesktopSidebarVisibility}
            expandedWidth="var(--clash-app-sidebar-expanded-width)"
            label="Application shortcuts"
            widthStorageKey="clash.desktop.sidebar-width"
            style={desktopChromeStyle}
            className="pointer-events-none fixed bottom-0 left-0 top-[var(--clash-desktop-chrome-height)] z-40 h-auto"
            panelClassName="flex flex-col border-warm-border bg-warm-muted"
          >
            <div
              data-sidebar-header-anchor
              data-slot="desktop-sidebar-header"
              className="desktop-no-drag pointer-events-auto flex h-[var(--clash-app-sidebar-header-height)] flex-none items-center justify-between px-3 pb-0 pt-[var(--clash-app-sidebar-section-gap)]"
            >
              <Link
                to="/"
                aria-label="Clash home"
                className="flex h-[var(--clash-project-control-height,2rem)] min-w-0 items-center gap-1.5 rounded-lg px-1.5 text-content-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-0 focus-visible:ring-offset-warm-muted"
              >
                <AgentMotion
                  state="idle"
                  className="clash-agent-motion--compact h-6 w-6 shrink-0"
                />
                <span className="truncate font-display text-[var(--clash-project-title-size,0.8125rem)] font-medium">
                  Clash
                </span>
              </Link>
              <DesktopSidebarCollapseButton
                collapsed={desktopSidebarCollapsed}
                label="Application shortcuts"
                onCollapsedChange={setDesktopSidebarVisibility}
                className="pointer-events-auto"
              />
            </div>
            <div className="desktop-no-drag pointer-events-auto px-3 pt-[var(--clash-app-sidebar-section-gap)]">
              <DesktopCommandPalette
                collapsed={false}
                onNavigate={openDesktopPath}
              />
            </div>
            <nav
              aria-label="Primary"
              data-orientation="vertical"
              className="desktop-no-drag pointer-events-auto flex min-w-0 flex-col gap-1 px-3 pb-3 pt-2"
            >
              {navItems.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <button
                    key={item.name}
                    type="button"
                    onClick={() => openDesktopPath(item.href)}
                    aria-label={item.name}
                    aria-current={isActive ? "page" : undefined}
                    className={`flex h-9 min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-0 focus-visible:ring-offset-warm-muted ${
                      isActive
                        ? "bg-warm-hover text-content-primary"
                        : "text-content-secondary hover:bg-warm-hover hover:text-content-primary"
                    }`}
                  >
                    <ProductNavIcon
                      kind={item.kind}
                      className="h-4 w-4 flex-none"
                      aria-hidden="true"
                    />
                    <span className="truncate">{item.name}</span>
                  </button>
                );
              })}
            </nav>
            <div className="desktop-no-drag pointer-events-auto mt-auto border-t border-warm-border p-3">
              <UserControls compact sidebarExpanded />
            </div>
          </DesktopAutoHideSidebar>
        )}
      </>
    );
  }

  return (
    <>
      {desktopSidebarCollapsed ? (
        <div className="fixed left-3 top-3 z-40">
          <DesktopSidebarCollapseButton
            collapsed
            label="Application shortcuts"
            onCollapsedChange={setDesktopSidebarVisibility}
          />
        </div>
      ) : null}
      <DesktopAutoHideSidebar
        collapsed={desktopSidebarCollapsed}
        onCollapsedChange={setDesktopSidebarVisibility}
        expandedWidth="var(--clash-app-sidebar-expanded-width)"
        label="Application shortcuts"
        widthStorageKey="clash.web.sidebar-width"
        style={desktopChromeStyle}
        className="pointer-events-none fixed inset-y-0 left-0 z-40 h-auto"
        panelClassName="flex flex-col border-warm-border bg-warm-muted"
      >
        <div
          data-sidebar-header-anchor
          className="pointer-events-auto flex h-14 shrink-0 items-center justify-between px-3"
        >
          <Link
            to="/"
            aria-label="Clash home"
            className="flex items-center gap-2 font-display text-sm font-medium"
          >
            <BrandAsset name="mark" alt="" className="size-7" />
            Clash
          </Link>
          <DesktopSidebarCollapseButton
            collapsed={desktopSidebarCollapsed}
            label="Application shortcuts"
            onCollapsedChange={setDesktopSidebarVisibility}
          />
        </div>
        <nav
          aria-label="Primary"
          data-orientation="vertical"
          className="pointer-events-auto flex flex-col gap-1 px-3 py-2"
        >
          {navItems.map((item) => (
            <Link
              key={item.href}
              to={item.href}
              aria-current={pathname === item.href ? "page" : undefined}
              className={`flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${pathname === item.href ? "bg-warm-hover text-content-primary" : "text-content-secondary hover:bg-warm-hover"}`}
            >
              <ProductNavIcon
                kind={item.kind}
                className="size-4 shrink-0"
                aria-hidden="true"
              />
              {item.name}
            </Link>
          ))}
        </nav>
        <div className="pointer-events-auto mt-auto border-t border-warm-border p-3">
          <UserControls compact sidebarExpanded />
        </div>
      </DesktopAutoHideSidebar>
    </>
  );
}
