import { useEffect } from "react";
import { useLocation } from "react-router";
import TopNavigation from "./TopNavigation";
import Background from "./Background";
import { ConfirmDialogProvider } from "./ConfirmDialog";
import { AppFeedbackProvider } from "./AppFeedback";
import { isDesktopRuntime } from "../lib/runtimeConfig";
import DashboardComposerDock from "./DashboardComposerDock";
import { DashboardComposerProvider } from "./DashboardComposerContext";

export default function LayoutContent({
  children,
  isAuthenticated,
  pendingPathname,
}: {
  children: React.ReactNode;
  isAuthenticated: boolean;
  pendingPathname?: string | null;
}) {
  const isDesktop = isDesktopRuntime();
  const currentPathname = useLocation().pathname;
  const pathname =
    isDesktop && pendingPathname ? pendingPathname : currentPathname;

  // 检查是否是项目详情页面或 Landing Page
  const isProjectDetailPage = /^\/projects\/[^\/]+$/.test(pathname ?? "");
  const isDesktopProjectDetailPage = isDesktop && isProjectDetailPage;
  const isLoginPage = pathname === "/login";
  const isLandingPage = pathname === "/landing";
  const isAuthPage = pathname?.startsWith("/auth/");
  const isSettingsPage = pathname === "/settings";
  const isDesktopSettingsPage = isDesktop && isSettingsPage;
  const showsDashboardComposer = isDesktop && pathname === "/";
  const showsDesktopChrome =
    isDesktop &&
    isAuthenticated &&
    !isLoginPage &&
    !isLandingPage &&
    !isAuthPage;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("clash-desktop-route", showsDesktopChrome);
    root.classList.toggle(
      "clash-desktop-project-route",
      !!isDesktopProjectDetailPage,
    );
    return () => {
      root.classList.remove("clash-desktop-route");
      root.classList.remove("clash-desktop-project-route");
    };
  }, [isDesktopProjectDetailPage, showsDesktopChrome]);

  useEffect(() => {
    if (!showsDesktopChrome) {
      document.documentElement.classList.remove("clash-is-scrolling");
      return undefined;
    }

    const hideTimers = new Map<Element, number>();
    const markScrolling = (event: Event) => {
      const target = event.target;
      const scroller =
        target instanceof Element
          ? target
          : target === document || target === event.currentTarget
            ? (document.scrollingElement ?? document.documentElement)
            : null;
      if (!scroller) return;
      scroller.classList.add("clash-is-scrolling");
      const previous = hideTimers.get(scroller);
      if (previous !== undefined) window.clearTimeout(previous);
      hideTimers.set(
        scroller,
        window.setTimeout(() => {
          scroller.classList.remove("clash-is-scrolling");
          hideTimers.delete(scroller);
        }, 450),
      );
    };

    const listenerOptions = { capture: true, passive: true };
    window.addEventListener("scroll", markScrolling, listenerOptions);

    return () => {
      window.removeEventListener("scroll", markScrolling, listenerOptions);
      for (const [scroller, timer] of hideTimers) {
        window.clearTimeout(timer);
        scroller.classList.remove("clash-is-scrolling");
      }
      hideTimers.clear();
    };
  }, [showsDesktopChrome]);

  // If unauthenticated, or on login page, or on fullscreen project page, or explicit landing page
  // Don't show dashboard navigation and background
  if (
    !isAuthenticated ||
    isLoginPage ||
    (isProjectDetailPage && !isDesktop) ||
    isLandingPage ||
    isAuthPage ||
    (isSettingsPage && !isDesktop)
  ) {
    return (
      <ConfirmDialogProvider>
        <AppFeedbackProvider>{children}</AppFeedbackProvider>
      </ConfirmDialogProvider>
    );
  }

  // 其他页面 (Dashboard/App): 显示TopNavigation和背景
  const mainContent = (
    <main
      className={`${
        isDesktopProjectDetailPage
          ? "box-border mt-[var(--clash-desktop-chrome-height)] h-[calc(100dvh-var(--clash-desktop-chrome-height))] overflow-hidden [--clash-desktop-chrome-height:2.5rem] [--clash-project-editor-height:calc(100dvh-var(--clash-desktop-chrome-height))]"
          : isDesktopSettingsPage
            ? "box-border mt-[var(--clash-desktop-chrome-height)] h-[calc(100dvh-var(--clash-desktop-chrome-height))] overflow-hidden [--clash-desktop-chrome-height:2.5rem]"
            : isDesktop
              ? "clash-desktop-scroll-root box-border mt-10 h-[calc(100dvh-2.5rem)] min-h-0 overflow-y-auto overflow-x-hidden pl-[var(--clash-app-sidebar-width)] pt-0 [--app-page-sticky-header-top:0px] transition-[padding-left] duration-200 ease-out motion-reduce:transition-none"
              : "min-h-screen pt-24"
      }${showsDashboardComposer ? " clash-dashboard-has-composer" : ""}`}
    >
      {children}
    </main>
  );

  return (
    <ConfirmDialogProvider>
      <AppFeedbackProvider>
        <TopNavigation pendingPathname={pendingPathname} />
        {!isDesktopProjectDetailPage && !isDesktopSettingsPage && (
          <Background />
        )}
        {showsDashboardComposer ? (
          <DashboardComposerProvider>
            {mainContent}
            <DashboardComposerDock />
          </DashboardComposerProvider>
        ) : (
          mainContent
        )}
      </AppFeedbackProvider>
    </ConfirmDialogProvider>
  );
}
