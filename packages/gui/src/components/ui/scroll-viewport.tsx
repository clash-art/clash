/// <reference path="./monaco-scrollable.d.ts" />
import { forwardRef, useCallback, useLayoutEffect, useRef, type CSSProperties, type HTMLAttributes } from 'react';
import { DomScrollableElement } from 'monaco-editor/base/browser/ui/scrollbar/scrollableElement.js';

type ScrollViewportProps = HTMLAttributes<HTMLDivElement> & {
  containerStyle?: CSSProperties;
};

/** VS Code's DOM viewport. The forwarded element retains real DOM scroll offsets. */
export const ScrollViewport = forwardRef<HTMLDivElement, ScrollViewportProps>(function ScrollViewport(
  { children, style, containerStyle, ...props }, forwardedRef,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const setViewport = useCallback((element: HTMLDivElement | null) => {
    viewportRef.current = element;
    if (typeof forwardedRef === 'function') forwardedRef(element);
    else if (forwardedRef) forwardedRef.current = element;
  }, [forwardedRef]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    const viewport = viewportRef.current;
    if (!host || !viewport) return;
    const scrollable = new DomScrollableElement(viewport, {
      className: 'clash-scroll-viewport',
      useShadows: false,
      scrollPredominantAxis: true,
      // Clash owns Ctrl/Meta-wheel zoom. Route only ordinary wheel input to
      // the upstream viewport; don't let zoom input alter its scroll state.
      handleMouseWheel: false,
      consumeMouseWheelIfScrollbarIsNeeded: true,
    });
    const wrapper = scrollable.getDomNode();
    Object.assign(wrapper.style, { position: 'absolute', inset: '0' });
    wrapper.style.setProperty('--vscode-scrollbarSlider-background', 'rgba(110, 110, 110, .35)');
    wrapper.style.setProperty('--vscode-scrollbarSlider-hoverBackground', 'rgba(110, 110, 110, .55)');
    wrapper.style.setProperty('--vscode-scrollbarSlider-activeBackground', 'rgba(110, 110, 110, .75)');
    host.appendChild(wrapper);
    const scan = () => scrollable.scanDomNode();
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      // Include programmatic seeking/zoom offsets even before their scroll
      // event has been delivered. Direction, bounds and units belong upstream.
      scan();
      scrollable.delegateScrollFromMouseWheelEvent(event);
    };
    host.addEventListener('wheel', wheel, { passive: false });
    viewport.addEventListener('scroll', scan);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(scan);
    observer?.observe(viewport);
    if (contentRef.current) observer?.observe(contentRef.current);
    scan();
    return () => {
      observer?.disconnect();
      host.removeEventListener('wheel', wheel);
      viewport.removeEventListener('scroll', scan);
      scrollable.dispose();
      // Restore React's original parent before unmount or StrictMode replay.
      host.appendChild(viewport);
      wrapper.remove();
    };
  }, []);

  return (
    <div ref={hostRef} style={{ position: 'relative', minWidth: 0, minHeight: 0, ...containerStyle }}>
      <div {...props} ref={setViewport} style={{ ...style, width: '100%', height: '100%', overflow: 'hidden', boxSizing: 'border-box' }}>
        <div ref={contentRef} style={{ minWidth: '100%', minHeight: '100%', width: 'max-content' }}>{children}</div>
      </div>
    </div>
  );
});
