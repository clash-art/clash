/**
 * React surface that paints one HTML MG document in a Hilo-style sandbox.
 * Used by Timeline VideoComposition layers and by html-only preview-frame.
 *
 * Remotion Player is not required to render the HTML body — only Sequence
 * timing (when embedded) or the html-scene producer clock drives seek.
 */
import React, { useEffect, useRef } from "react";
import {
  HTML_SCENE_DOCUMENT_PROTOCOL,
  HTML_SCENE_SANDBOX,
  createHtmlSceneBlobUrl,
  isHtmlSceneDocOutbound,
  validateHtmlDocumentCapacity,
  wrapHtmlDocumentForPreview,
  type HtmlSceneElementEditEvent,
  type HtmlSceneElementSelectEvent,
} from "./htmlSandbox";

export type HtmlSceneSurfaceProps = {
  source: string;
  frame: number;
  fps: number;
  durationInFrames: number;
  title?: string;
  sourceNodeId?: string;
  compositionItemId?: string;
  style?: React.CSSProperties;
  className?: string;
  /** When capacity fails, render this instead of an iframe. */
  onCapacityError?: (reason: string) => void;
  /**
   * When true, inject Hilo-lite element edit bridge (select / drag position /
   * dblclick text) into the sandboxed document.
   */
  elementEdit?: boolean;
  /** Composition width for drag scale (defaults to 1920). */
  sceneWidth?: number;
  onElementEdit?: (event: HtmlSceneElementEditEvent) => void;
  onElementSelect?: (event: HtmlSceneElementSelectEvent) => void;
};

export const HtmlSceneSurface: React.FC<HtmlSceneSurfaceProps> = React.memo(
  function HtmlSceneSurface({
    source,
    frame,
    fps,
    durationInFrames,
    title = "HTML Motion",
    sourceNodeId,
    compositionItemId,
    style,
    className,
    onCapacityError,
    elementEdit = false,
    sceneWidth = 1920,
    onElementEdit,
    onElementSelect,
  }) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const revokeRef = useRef<(() => void) | null>(null);
    const capacityErrorRef = useRef(onCapacityError);
    capacityErrorRef.current = onCapacityError;
    const onElementEditRef = useRef(onElementEdit);
    onElementEditRef.current = onElementEdit;
    const onElementSelectRef = useRef(onElementSelect);
    onElementSelectRef.current = onElementSelect;

    useEffect(() => {
      const iframe = iframeRef.current;
      if (!iframe) return;

      const capacity = validateHtmlDocumentCapacity(source);
      if (!capacity.ok) {
        capacityErrorRef.current?.(capacity.reason);
        iframe.removeAttribute("src");
        return;
      }

      const wrapped = wrapHtmlDocumentForPreview(source, {
        elementEdit,
        sceneWidth,
      });
      const handle = createHtmlSceneBlobUrl(wrapped);
      revokeRef.current?.();
      revokeRef.current = handle.revoke;
      iframe.setAttribute("sandbox", HTML_SCENE_SANDBOX);
      iframe.src = handle.url;

      return () => {
        handle.revoke();
        if (revokeRef.current === handle.revoke) {
          revokeRef.current = null;
        }
      };
    }, [source, elementEdit, sceneWidth]);

    useEffect(() => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      try {
        win.postMessage(
          {
            protocol: HTML_SCENE_DOCUMENT_PROTOCOL,
            type: "seek",
            frame,
            fps,
            durationInFrames,
          },
          "*",
        );
      } catch {
        // Opaque origin / not yet loaded.
      }
    }, [frame, fps, durationInFrames]);

    useEffect(() => {
      if (!elementEdit) return;
      const onMessage = (event: MessageEvent) => {
        if (!isHtmlSceneDocOutbound(event.data)) return;
        if (event.data.type === "element-edit") {
          onElementEditRef.current?.(event.data);
        } else if (event.data.type === "element-select") {
          onElementSelectRef.current?.(event.data);
        }
      };
      window.addEventListener("message", onMessage);
      return () => window.removeEventListener("message", onMessage);
    }, [elementEdit]);

    return (
      <iframe
        ref={iframeRef}
        title={title}
        className={className}
        data-html-scene-surface=""
        data-html-scene-source-node-id={sourceNodeId}
        data-composition-item-id={compositionItemId}
        data-composition-runtime="html"
        data-html-scene-element-edit={elementEdit ? "true" : undefined}
        style={{
          width: "100%",
          height: "100%",
          border: 0,
          background: "transparent",
          display: "block",
          ...style,
        }}
      />
    );
  },
);
