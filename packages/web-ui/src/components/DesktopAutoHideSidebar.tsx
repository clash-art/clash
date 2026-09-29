"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { SidebarSimple } from "@phosphor-icons/react";

import { cn } from "./ai-elements/utils";
import { DESKTOP_SHELL_LAYERS } from "./desktopShellLayers";
import { IconButton } from "./ui/icon-button";

/**
 * Time after a collapse during which the left-edge recovery zone refuses to open
 * a preview. Without it, a pointer released after crossing the divider can end
 * up over the newly exposed edge and snap the sidebar straight back open.
 */
export const JUST_COLLAPSED_SUPPRESSION_MS = 190;
export const DESKTOP_SIDEBAR_DEFAULT_WIDTH = 256;
export const DESKTOP_SIDEBAR_MIN_WIDTH = 220;
export const DESKTOP_SIDEBAR_MAX_WIDTH = 360;
export const DESKTOP_SIDEBAR_WIDTH_CSS_PROPERTY =
  "--clash-app-sidebar-expanded-width";

type SidebarVisualState = "expanded" | "collapsed" | "preview";

export interface DesktopAutoHideSidebarProps {
  /** Persisted collapsed state; owned by the caller. */
  collapsed: boolean;
  /**
   * Layout width used when expanded and by the off-canvas panel. A number is
   * treated as px; a string is passed through as a CSS length, so callers can
   * hand over `var(--clash-app-sidebar-expanded-width)` without hardcoding it.
   */
  expandedWidth: number | string;
  /** Accessible name for the sidebar region. */
  label: string;
  children: ReactNode;
  className?: string;
  /** Merged into the root region's computed style (width / stacking). */
  style?: CSSProperties;
  panelClassName?: string;
  recoveryZoneClassName?: string;
  /** Persists a full/hidden transition owned by the surrounding shell. */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Optional localStorage key used to persist this sidebar's expanded width. */
  widthStorageKey?: string;
}

export interface DesktopSidebarCollapseButtonProps {
  collapsed: boolean;
  label: string;
  onCollapsedChange: (collapsed: boolean) => void;
  className?: string;
}

export function DesktopSidebarCollapseButton({
  collapsed,
  label,
  onCollapsedChange,
  className,
}: DesktopSidebarCollapseButtonProps) {
  return (
    <IconButton
      data-sidebar-visibility="true"
      data-state={collapsed ? "collapsed" : "expanded"}
      label={collapsed ? `Keep ${label} open` : `Collapse ${label}`}
      icon={<SidebarSimple className="h-4 w-4" weight="regular" />}
      size="sm"
      shape="rounded"
      onClick={() => onCollapsedChange(!collapsed)}
      className={cn(
        "flex-none bg-transparent text-content-muted shadow-none hover:bg-warm-hover hover:text-content-primary",
        className,
      )}
    />
  );
}

const MOTION_CLASSES =
  "transition-[width,flex-basis,transform,opacity,box-shadow] duration-[180ms] [transition-timing-function:cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none motion-reduce:duration-0";

function clampSidebarWidth(width: number): number {
  return Math.max(
    DESKTOP_SIDEBAR_MIN_WIDTH,
    Math.min(DESKTOP_SIDEBAR_MAX_WIDTH, width),
  );
}

function readPersistedSidebarWidth(
  storageKey: string | undefined,
): number | null {
  if (!storageKey || typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === null) return DESKTOP_SIDEBAR_DEFAULT_WIDTH;
    const parsed = Number.parseInt(stored, 10);
    return Number.isFinite(parsed)
      ? clampSidebarWidth(parsed)
      : DESKTOP_SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return DESKTOP_SIDEBAR_DEFAULT_WIDTH;
  }
}

export function DesktopAutoHideSidebar({
  collapsed,
  expandedWidth,
  label,
  children,
  className,
  style,
  panelClassName,
  recoveryZoneClassName,
  onCollapsedChange,
  widthStorageKey,
}: DesktopAutoHideSidebarProps) {
  const [previewing, setPreviewing] = useState(false);
  const [previewReady, setPreviewReady] = useState(true);
  const [resizedWidth, setResizedWidth] = useState<number | null>(() =>
    readPersistedSidebarWidth(widthStorageKey),
  );
  const [measuredExpandedWidth, setMeasuredExpandedWidth] = useState<
    number | null
  >(null);
  const previousCollapsedRef = useRef(collapsed);
  const panelRef = useRef<HTMLDivElement>(null);
  const hoverRailRef = useRef<HTMLDivElement>(null);
  const pointerWithinSidebarRef = useRef(false);

  useLayoutEffect(() => {
    if (resizedWidth === null) return;
    document.documentElement.style.setProperty(
      DESKTOP_SIDEBAR_WIDTH_CSS_PROPERTY,
      `${resizedWidth}px`,
    );
  }, [resizedWidth]);

  useEffect(() => {
    if (collapsed && !previousCollapsedRef.current) {
      // Match the Linear shell: let the collapse finish before the now-exposed
      // edge rail is allowed to reveal the same sidebar again.
      pointerWithinSidebarRef.current = false;
      setPreviewReady(false);
      setPreviewing(false);
      const previewTimer = window.setTimeout(() => {
        setPreviewReady(true);
      }, JUST_COLLAPSED_SUPPRESSION_MS);
      previousCollapsedRef.current = collapsed;
      return () => window.clearTimeout(previewTimer);
    }
    if (!collapsed) {
      setPreviewReady(false);
      setPreviewing(false);
    } else {
      setPreviewReady(true);
    }
    previousCollapsedRef.current = collapsed;
    return undefined;
  }, [collapsed]);

  const openPreview = useCallback(() => {
    if (!collapsed || !previewReady) return;
    setPreviewing(true);
  }, [collapsed, previewReady]);

  useEffect(() => {
    if (collapsed && previewReady && pointerWithinSidebarRef.current) {
      // CSS :hover in the Linear template starts matching as soon as its
      // preview-ready guard is enabled. Mirror that behavior without requiring
      // a second pointerenter after the 190ms post-collapse guard.
      setPreviewing(true);
    }
  }, [collapsed, previewReady]);

  const closePreview = useCallback(() => {
    setPreviewing(false);
  }, []);

  const enterSidebarPointerSurface = useCallback(() => {
    pointerWithinSidebarRef.current = true;
    openPreview();
  }, [openPreview]);

  const leaveSidebarPointerSurface = useCallback(() => {
    pointerWithinSidebarRef.current = false;
    if (!hoverRailRef.current?.contains(document.activeElement)) {
      closePreview();
    }
  }, [closePreview]);

  useEffect(() => {
    if (!onCollapsedChange) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key === "\\"
      ) {
        event.preventDefault();
        onCollapsedChange(!collapsed);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [collapsed, onCollapsedChange]);

  const persistSidebarWidth = useCallback(
    (width: number) => {
      if (!widthStorageKey) return;
      try {
        window.localStorage.setItem(widthStorageKey, String(width));
      } catch {
        // Resizing remains functional when storage is unavailable.
      }
    },
    [widthStorageKey],
  );

  const applySidebarWidth = useCallback(
    (width: number, persist: boolean): number => {
      const clampedWidth = clampSidebarWidth(width);
      setResizedWidth(clampedWidth);
      document.documentElement.style.setProperty(
        DESKTOP_SIDEBAR_WIDTH_CSS_PROPERTY,
        `${clampedWidth}px`,
      );
      if (persist) persistSidebarWidth(clampedWidth);
      return clampedWidth;
    },
    [persistSidebarWidth],
  );

  const readRenderedPanelWidth = useCallback((): number | null => {
    const panel = panelRef.current;
    if (!panel) return null;
    const measuredWidth = panel.getBoundingClientRect().width;
    if (measuredWidth > 0) return clampSidebarWidth(measuredWidth);
    const computedWidth = Number.parseFloat(
      window.getComputedStyle(panel).width,
    );
    return Number.isFinite(computedWidth) && computedWidth > 0
      ? clampSidebarWidth(computedWidth)
      : null;
  }, []);

  useLayoutEffect(() => {
    if (resizedWidth !== null || typeof expandedWidth === "number") {
      setMeasuredExpandedWidth(null);
      return;
    }
    const renderedWidth = readRenderedPanelWidth();
    if (renderedWidth !== null) setMeasuredExpandedWidth(renderedWidth);
  }, [expandedWidth, readRenderedPanelWidth, resizedWidth]);

  const currentSidebarWidth = useCallback((): number => {
    if (resizedWidth !== null) return resizedWidth;
    if (typeof expandedWidth === "number") {
      return clampSidebarWidth(expandedWidth);
    }
    if (measuredExpandedWidth !== null) return measuredExpandedWidth;
    const renderedWidth = readRenderedPanelWidth();
    if (renderedWidth !== null) return renderedWidth;
    return DESKTOP_SIDEBAR_DEFAULT_WIDTH;
  }, [
    expandedWidth,
    measuredExpandedWidth,
    readRenderedPanelWidth,
    resizedWidth,
  ]);

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (collapsed || !onCollapsedChange) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth =
        panelRef.current?.getBoundingClientRect().width ?? event.clientX;
      document.body.classList.add("is-resizing-sidebar");

      const finish = () => {
        document.body.classList.remove("is-resizing-sidebar");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      const applyWidth = (clientX: number): number | null => {
        const nextWidth = startWidth + clientX - startX;
        if (nextWidth < 170) {
          document.documentElement.style.setProperty(
            DESKTOP_SIDEBAR_WIDTH_CSS_PROPERTY,
            `${clampSidebarWidth(startWidth)}px`,
          );
          onCollapsedChange(true);
          finish();
          return null;
        }
        return applySidebarWidth(nextWidth, false);
      };
      const onMove = (moveEvent: PointerEvent) => applyWidth(moveEvent.clientX);
      const onUp = (upEvent: PointerEvent) => {
        const committedWidth = applyWidth(upEvent.clientX);
        if (committedWidth !== null) persistSidebarWidth(committedWidth);
        finish();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [applySidebarWidth, collapsed, onCollapsedChange, persistSidebarWidth],
  );

  const resizeWithKeyboard = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const currentWidth = currentSidebarWidth();
      let nextWidth: number | null = null;
      if (event.key === "ArrowLeft") nextWidth = currentWidth - 8;
      if (event.key === "ArrowRight") nextWidth = currentWidth + 8;
      if (event.key === "Home") nextWidth = DESKTOP_SIDEBAR_MIN_WIDTH;
      if (event.key === "End") nextWidth = DESKTOP_SIDEBAR_MAX_WIDTH;
      if (nextWidth === null) return;
      event.preventDefault();
      applySidebarWidth(nextWidth, true);
    },
    [applySidebarWidth, currentSidebarWidth],
  );

  const state: SidebarVisualState = collapsed
    ? previewing
      ? "preview"
      : "collapsed"
    : "expanded";

  const hidden = state === "collapsed";
  const effectiveExpandedWidth = resizedWidth ?? expandedWidth;
  const numericExpandedWidth =
    resizedWidth ??
    (typeof expandedWidth === "number"
      ? clampSidebarWidth(expandedWidth)
      : (measuredExpandedWidth ?? undefined));

  const rootStyle: CSSProperties = {
    ...style,
    width: collapsed ? 0 : effectiveExpandedWidth,
    flexBasis: collapsed ? 0 : effectiveExpandedWidth,
    // Preview floats above content instead of pushing it.
    ...(state === "preview"
      ? { zIndex: DESKTOP_SHELL_LAYERS.sidebarPreview }
      : null),
  };

  const panelStyle: CSSProperties = {
    width: effectiveExpandedWidth,
    // Match the Linear template: clear both the panel's own width and the
    // floating inset, then keep a small safety buffer beyond the viewport.
    transform: hidden ? "translateX(calc(-100% - 1.5rem))" : "translateX(0)",
    opacity: hidden ? 0 : 1,
    ...(state === "preview"
      ? { zIndex: DESKTOP_SHELL_LAYERS.sidebarPreview }
      : null),
  };

  const panel = (
    <div
      ref={panelRef}
      data-sidebar-panel=""
      data-state={state}
      // Off-canvas children stay mounted but must not be reachable by
      // assistive tech, tab order, or pointer until a preview opens.
      aria-hidden={hidden ? "true" : undefined}
      // React 19 renders `inert` as a boolean attribute.
      inert={hidden}
      style={panelStyle}
      className={cn(
        "border-r border-warm-border",
        collapsed
          ? "fixed bottom-2 left-2 top-[calc(var(--clash-desktop-chrome-height,0px)+0.5rem)] h-auto overflow-hidden rounded-lg border"
          : "absolute inset-y-0 left-0 h-full overflow-hidden",
        state === "preview"
          ? "bg-warm-surface [box-shadow:var(--clash-shadow-sidebar-preview)]"
          : "bg-warm-muted",
        MOTION_CLASSES,
        panelClassName,
      )}
    >
      {children}
      {state === "expanded" && onCollapsedChange ? (
        <div
          data-sidebar-resize="true"
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={`Resize ${label}`}
          aria-valuemin={DESKTOP_SIDEBAR_MIN_WIDTH}
          aria-valuemax={DESKTOP_SIDEBAR_MAX_WIDTH}
          aria-valuenow={numericExpandedWidth}
          onPointerDown={startResize}
          onKeyDown={resizeWithKeyboard}
          className="pointer-events-auto absolute inset-y-0 -right-1 z-50 w-2 cursor-col-resize touch-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring after:absolute after:right-1 after:top-1/2 after:h-11 after:w-px after:-translate-y-1/2 after:rounded-full after:bg-transparent hover:after:bg-content-disabled"
        />
      ) : null}
    </div>
  );

  return (
    <aside
      aria-label={label}
      data-state={state}
      style={rootStyle}
      className={cn(
        "relative h-full shrink-0 overflow-visible",
        MOTION_CLASSES,
        className,
      )}
    >
      {/*
          The recovery button is rendered before the panel so that tabbing off
          it moves focus into the sidebar it just revealed, not past it.
        */}
      <div
        ref={hoverRailRef}
        data-sidebar-rail=""
        data-sidebar-hover-rail={collapsed ? "" : undefined}
        data-state={state}
        onPointerEnter={enterSidebarPointerSurface}
        onPointerLeave={leaveSidebarPointerSurface}
        onBlur={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null) &&
            !pointerWithinSidebarRef.current
          ) {
            closePreview();
          }
        }}
        style={{
          zIndex:
            state === "preview"
              ? DESKTOP_SHELL_LAYERS.sidebarPreview
              : DESKTOP_SHELL_LAYERS.sidebarRecovery,
        }}
        className={cn(
          "min-w-0 overflow-visible",
          collapsed
            ? "pointer-events-auto fixed bottom-0 left-0 top-[var(--clash-desktop-chrome-height,0px)] w-[14px]"
            : "relative h-full w-full",
          MOTION_CLASSES,
        )}
      >
        {collapsed ? (
          <button
            type="button"
            aria-label={`Show ${label}`}
            onFocus={openPreview}
            style={{
              zIndex:
                state === "preview"
                  ? DESKTOP_SHELL_LAYERS.sidebarPreview
                  : DESKTOP_SHELL_LAYERS.sidebarRecovery,
            }}
            className={cn(
              // Keyboard-equivalent affordance for the otherwise invisible
              // Linear-style edge rail.
              "pointer-events-auto absolute inset-0 h-full w-full",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-black dark:focus-visible:ring-white",
              "motion-reduce:transition-none",
              recoveryZoneClassName,
            )}
          />
        ) : null}
        {panel}
      </div>
    </aside>
  );
}

export default DesktopAutoHideSidebar;
