import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ViewportPortal, useViewport } from "@xyflow/react";
import type { AgentAnnotationDraft } from "@clash/shared-types";
import { annotationLocateSelector } from "@clash/web-ui/lib/agentAnnotationLocate";

import { AgentAnnotationActionsContextMenu } from "./AgentAnnotationBlock";
import { projectCanvasAnnotationPin } from "./canvasAnnotationPins";

interface CanvasPin {
  id: string;
  number: number;
  x: number;
  y: number;
  visible: boolean;
}

function samePins(a: CanvasPin[], b: CanvasPin[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((pin, index) => {
    const next = b[index];
    return (
      pin.id === next.id &&
      pin.number === next.number &&
      pin.visible === next.visible &&
      Math.abs(pin.x - next.x) < 0.5 &&
      Math.abs(pin.y - next.y) < 0.5
    );
  });
}

/**
 * Canvas object pins live in React Flow's viewport instead of the outer
 * workspace overlay. This prevents a second layout coordinate system from
 * shifting pins into the copilot pane after the canvas is panned or resized.
 */
export function CanvasAnnotationPinLayer({
  annotations,
  active = true,
  canvasId,
  flowBoundsRef,
  activeId,
  onSelect,
  onLocate,
  onRemove,
}: {
  annotations: readonly AgentAnnotationDraft[];
  active?: boolean;
  canvasId: string;
  flowBoundsRef: RefObject<HTMLDivElement | null>;
  activeId: string | null;
  onSelect: (annotationId: string) => void;
  onLocate?: (annotationId: string) => void;
  onRemove: (annotationId: string) => void;
}) {
  const viewport = useViewport();
  const [pins, setPins] = useState<CanvasPin[]>([]);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  const relevant = useMemo(
    () =>
      annotations.flatMap((annotation, index) => {
        const { target } = annotation;
        if (
          target.surface !== "canvas" ||
          target.surfaceId !== canvasId ||
          target.selection?.visualRects?.length
        ) {
          return [];
        }
        return [{ annotation, number: index + 1 }];
      }),
    [annotations, canvasId],
  );

  useEffect(() => {
    if (!active || relevant.length === 0) {
      setPins((current) => (current.length > 0 ? [] : current));
      return undefined;
    }

    let frame = 0;
    const measure = () => {
      const flowBounds = flowBoundsRef.current?.getBoundingClientRect();
      if (!flowBounds) return;
      const next = relevant.flatMap(({ annotation, number }) => {
        const element = document.querySelector<HTMLElement>(
          annotationLocateSelector(annotation.target),
        );
        if (!element) return [];
        const rect = element.getBoundingClientRect();
        const currentViewport = viewportRef.current;
        const pin = projectCanvasAnnotationPin({
          targetRect: rect,
          flowRect: flowBounds,
          viewport: currentViewport,
        });
        const visible =
          rect.bottom > flowBounds.top + 2 &&
          rect.top < flowBounds.bottom - 2 &&
          rect.right > flowBounds.left + 2 &&
          rect.left < flowBounds.right - 2;
        return [
          {
            id: annotation.id,
            number,
            x: pin.x,
            y: pin.y,
            visible,
          },
        ];
      });
      setPins((current) => (samePins(current, next) ? current : next));
      frame = window.requestAnimationFrame(measure);
    };

    measure();
    return () => window.cancelAnimationFrame(frame);
  }, [active, flowBoundsRef, relevant, viewport.x, viewport.y, viewport.zoom]);

  const inverseZoom = 1 / Math.max(viewport.zoom, Number.EPSILON);

  if (!active || relevant.length === 0) return null;

  return (
    <ViewportPortal>
      {pins
        .filter((pin) => pin.visible)
        .map((pin) => {
          const annotation = relevant.find(
            (candidate) => candidate.annotation.id === pin.id,
          )?.annotation;
          if (!annotation) return null;
          return (
            <AgentAnnotationActionsContextMenu
              key={pin.id}
              annotation={annotation}
              onOpen={() => onSelect(pin.id)}
              onLocate={onLocate ? () => onLocate(pin.id) : undefined}
              onRemove={() => onRemove(pin.id)}
            >
              <button
                type="button"
                data-agent-annotation-canvas-pin=""
                data-agent-annotation-anchor={pin.id}
                aria-label={`Annotation ${pin.number}`}
                aria-pressed={activeId === pin.id}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(pin.id);
                }}
                className={`nodrag nopan nowheel pointer-events-auto absolute flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-semibold leading-none text-white shadow-[0_4px_12px_rgba(215,78,58,0.28)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${
                  activeId === pin.id
                    ? "ring-2 ring-white ring-offset-2 ring-offset-brand"
                    : ""
                }`}
                style={{
                  left: pin.x,
                  top: pin.y,
                  zIndex: 10000,
                  transform: `translate(-50%, -50%) scale(${inverseZoom})`,
                }}
              >
                {pin.number}
              </button>
            </AgentAnnotationActionsContextMenu>
          );
        })}
    </ViewportPortal>
  );
}
