/**
 * MG element edit bridge for Timeline composition previews.
 *
 * Remotion composition items paint inside VideoComposition instead of the
 * fullscreen MgOpenSurface stage. This hook attaches the same Hilo-lite stage
 * gesture contract to the composition's AbsoluteFill root: pointer drag on
 * `[data-mg-id]` moves `data-mg-x` / `data-mg-y`, and dblclick edits text.
 *
 * The parent owns persistence; this only reports absolute patches for the
 * active source node so the Timeline inspector SessionDraft stays the SoT.
 */
import React from "react";

export type MgElementEditPatch = {
  text?: string;
  x?: number;
  y?: number;
};

export type MgElementEditHandlers = {
  activeSourceNodeId: string | null;
  onElementEdit: (
    sourceNodeId: string,
    elementId: string,
    patch: MgElementEditPatch,
  ) => void;
  onElementSelect: (sourceNodeId: string, elementId: string | null) => void;
};

function applyLiveTranslate(el: HTMLElement, x: number, y: number): void {
  el.setAttribute("data-mg-x", String(x));
  el.setAttribute("data-mg-y", String(y));
  const style = el.getAttribute("style") ?? "";
  const nextTranslate = `translate(${x}px, ${y}px)`;
  let nextStyle: string;
  if (/translate\([^)]*\)/.test(style)) {
    nextStyle = style.replace(/translate\([^)]*\)/, nextTranslate);
  } else if (style.trim()) {
    const trimmed = style.trim().replace(/;?\s*$/, "");
    nextStyle = `${trimmed}; transform: ${nextTranslate};`;
  } else {
    nextStyle = `transform: ${nextTranslate};`;
  }
  el.setAttribute("style", nextStyle);
}

export function useRemotionMgElementEdit({
  rootRef,
  enabled,
  sourceNodeId,
  compositionWidth,
  handlers,
}: {
  rootRef: React.RefObject<HTMLElement | null>;
  enabled: boolean;
  sourceNodeId: string | undefined;
  compositionWidth: number;
  handlers: MgElementEditHandlers | undefined;
}) {
  const onEditRef = React.useRef(handlers?.onElementEdit);
  const onSelectRef = React.useRef(handlers?.onElementSelect);
  onEditRef.current = handlers?.onElementEdit;
  onSelectRef.current = handlers?.onElementSelect;

  React.useEffect(() => {
    if (!enabled || !sourceNodeId) return;
    const root = rootRef.current;
    if (!root) return;

    type DragState = {
      el: HTMLElement;
      id: string;
      startX: number;
      startY: number;
      baseX: number;
      baseY: number;
    };
    let drag: DragState | null = null;

    const scale = () => {
      const rect = root.getBoundingClientRect();
      return rect.width > 0 ? compositionWidth / rect.width : 1;
    };

    const editableOf = (el: Element) => {
      const raw = (el.getAttribute("data-mg-editable") || "")
        .split(",")
        .map((value) => value.trim());
      return {
        text: raw.includes("text"),
        position: raw.includes("position"),
      };
    };

    const readXY = (el: Element) => {
      const x = Number(el.getAttribute("data-mg-x") || "0");
      const y = Number(el.getAttribute("data-mg-y") || "0");
      return {
        x: Number.isFinite(x) ? x : 0,
        y: Number.isFinite(y) ? y : 0,
      };
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const el = target.closest("[data-mg-id]");
      if (!(el instanceof HTMLElement) || !root.contains(el)) return;
      const id = el.getAttribute("data-mg-id");
      if (!id) return;
      const caps = editableOf(el);
      onSelectRef.current?.(sourceNodeId, id);
      if (!caps.position) return;
      const xy = readXY(el);
      drag = {
        el,
        id,
        startX: event.clientX,
        startY: event.clientY,
        baseX: xy.x,
        baseY: xy.y,
      };
      try {
        el.setPointerCapture(event.pointerId);
      } catch {
        // ignore
      }
      event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!drag) return;
      const s = scale();
      const dx = (event.clientX - drag.startX) * s;
      const dy = (event.clientY - drag.startY) * s;
      applyLiveTranslate(
        drag.el,
        Math.round(drag.baseX + dx),
        Math.round(drag.baseY + dy),
      );
    };

    const endDrag = () => {
      if (!drag) return;
      const xy = readXY(drag.el);
      onEditRef.current?.(sourceNodeId, drag.id, { x: xy.x, y: xy.y });
      drag = null;
    };

    const onDblClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const el = target.closest("[data-mg-id]");
      if (!(el instanceof HTMLElement) || !root.contains(el)) return;
      if (!editableOf(el).text) return;
      const id = el.getAttribute("data-mg-id");
      if (!id) return;
      el.contentEditable = "true";
      el.focus();
      const commit = () => {
        el.contentEditable = "false";
        el.removeEventListener("blur", commit);
        onEditRef.current?.(sourceNodeId, id, {
          text: (el.textContent || "").trim(),
        });
      };
      el.addEventListener("blur", commit);
      event.preventDefault();
    };

    root.addEventListener("pointerdown", onPointerDown, true);
    root.addEventListener("pointermove", onPointerMove, true);
    root.addEventListener("pointerup", endDrag, true);
    root.addEventListener("pointercancel", endDrag, true);
    root.addEventListener("dblclick", onDblClick, true);
    return () => {
      root.removeEventListener("pointerdown", onPointerDown, true);
      root.removeEventListener("pointermove", onPointerMove, true);
      root.removeEventListener("pointerup", endDrag, true);
      root.removeEventListener("pointercancel", endDrag, true);
      root.removeEventListener("dblclick", onDblClick, true);
    };
  }, [compositionWidth, enabled, rootRef, sourceNodeId]);
}
