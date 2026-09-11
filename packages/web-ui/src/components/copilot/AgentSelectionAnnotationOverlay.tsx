import { isMcpProjectApp } from "../../lib/mcpProject";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  type FormEvent,
  type ComponentPropsWithoutRef,
} from "react";
import { ArrowUp } from "@phosphor-icons/react";
import type {
  AgentAnnotationDraft,
  AgentAnnotationTarget,
  AgentAnnotationVisualRect,
} from "@clash/shared-types";

import { IconButton } from "../ui/icon-button";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { AgentAnnotationActionsContextMenu } from "./AgentAnnotationBlock";

const TEXT_CONTEXT_LENGTH = 160;

export interface AgentSelectionAnnotationOverlayHandle {
  captureSelection: (root: HTMLElement) => boolean;
}

interface SelectionDraft {
  target: AgentAnnotationTarget;
}

interface PendingSelection {
  annotation: AgentAnnotationDraft;
  number: number;
  rects: AgentAnnotationVisualRect[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeRects(
  rects: readonly DOMRect[],
  rootRect: DOMRect,
): AgentAnnotationVisualRect[] {
  if (rootRect.width <= 0 || rootRect.height <= 0) return [];
  return rects
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .slice(0, 32)
    .map((rect) => {
      const x = clamp((rect.left - rootRect.left) / rootRect.width, 0, 1);
      const y = clamp((rect.top - rootRect.top) / rootRect.height, 0, 1);
      const right = clamp((rect.right - rootRect.left) / rootRect.width, x, 1);
      const bottom = clamp(
        (rect.bottom - rootRect.top) / rootRect.height,
        y,
        1,
      );
      return {
        x,
        y,
        width: Math.max(right - x, 0.001),
        height: Math.max(bottom - y, 0.001),
      };
    });
}

function textBeforeRange(root: HTMLElement, range: Range): string {
  const before = range.cloneRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString();
}

function textAfterRange(root: HTMLElement, range: Range): string {
  const after = range.cloneRange();
  after.selectNodeContents(root);
  after.setStart(range.endContainer, range.endOffset);
  return after.toString();
}

function selectionRects(range: Range): DOMRect[] {
  const rects =
    typeof range.getClientRects === "function"
      ? Array.from(range.getClientRects())
      : [];
  if (rects.length > 0) return rects;
  const fallback = range.getBoundingClientRect?.();
  return fallback ? [fallback] : [];
}

function selectionObjectTarget(
  target: AgentAnnotationTarget,
  range: Range,
): AgentAnnotationTarget {
  const selector = "[data-agent-annotation-object-id]";
  const startElement =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  const endElement =
    range.endContainer.nodeType === Node.ELEMENT_NODE
      ? (range.endContainer as Element)
      : range.endContainer.parentElement;
  const startTarget = startElement?.closest<HTMLElement>(selector);
  const endTarget = endElement?.closest<HTMLElement>(selector);
  const objectId = startTarget?.dataset.agentAnnotationObjectId?.trim();
  if (!startTarget || !objectId || startTarget !== endTarget) {
    return target;
  }

  const objectType =
    startTarget.dataset.agentAnnotationObjectType?.trim() || target.objectType;
  const objectLabel =
    startTarget.dataset.agentAnnotationObjectLabel?.trim() ||
    target.objectLabel;
  const explicitPath = startTarget.dataset.agentAnnotationObjectPath?.trim();
  const parentId = startTarget.dataset.agentAnnotationParentId?.trim();
  const objectPath =
    explicitPath ||
    (() => {
      if (target.surface === "canvas") {
        return `${target.objectPath}/nodes/${objectId}`;
      }
      if (target.surface === "timeline") {
        return objectType === "timeline-track"
          ? `${target.objectPath}/tracks/${objectId}`
          : `${target.objectPath}/tracks/${parentId ?? "unknown"}/items/${objectId}`;
      }
      if (objectType === "director-scene") {
        return `${target.objectPath}/scene`;
      }
      if (objectType === "director-camera") {
        return `${target.objectPath}/cameras/${objectId}`;
      }
      return `${target.objectPath}/objects/${objectId}`;
    })();
  return {
    ...target,
    objectId,
    objectType,
    objectLabel,
    objectPath,
    ...(parentId ? { parentId } : {}),
  };
}

function rectStyle(rect: AgentAnnotationVisualRect) {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  };
}

function AnnotationHighlight({
  annotation,
  rects,
  number,
  draft = false,
  active = false,
  onSelect,
  onLocate,
  onRemove,
}: {
  annotation?: AgentAnnotationDraft;
  rects: readonly AgentAnnotationVisualRect[];
  number: number;
  draft?: boolean;
  active?: boolean;
  onSelect?: (annotationId: string) => void;
  onLocate?: (annotationId: string) => void;
  onRemove?: (annotationId: string) => void;
}) {
  const finalRect = rects.at(-1);
  const pinClassName = `absolute flex h-6 min-w-6 -translate-y-1/2 translate-x-1/3 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-semibold leading-none text-white shadow-[0_4px_12px_rgba(215,78,58,0.28)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${
    annotation ? "pointer-events-auto cursor-pointer" : ""
  } ${active ? "ring-2 ring-white ring-offset-2 ring-offset-brand" : ""}`;
  const pinStyle = finalRect
    ? {
        left: `${(finalRect.x + finalRect.width) * 100}%`,
        top: `${(finalRect.y + finalRect.height / 2) * 100}%`,
      }
    : undefined;
  const content = (
    <>
      {rects.map((rect, index) => (
        <span
          key={`${rect.x}-${rect.y}-${index}`}
          data-agent-annotation-highlight=""
          aria-hidden="true"
          className={`absolute rounded-[3px] ${
            draft ? "bg-brand/20" : "bg-brand/14"
          } ring-1 ring-inset ring-brand/25 ${
            annotation && onSelect
              ? "pointer-events-auto cursor-pointer hover:bg-brand/20"
              : ""
          }`}
          style={rectStyle(rect)}
          onPointerDown={
            annotation && onSelect
              ? (event) => event.stopPropagation()
              : undefined
          }
          onClick={
            annotation && onSelect
              ? (event) => {
                  event.stopPropagation();
                  onSelect(annotation.id);
                }
              : undefined
          }
        />
      ))}
      {finalRect ? (
        annotation && onSelect ? (
          <button
            type="button"
            data-agent-annotation-pin=""
            data-agent-annotation-anchor={annotation.id}
            aria-label={`Annotation ${number}`}
            aria-pressed={active}
            className={pinClassName}
            style={pinStyle}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(annotation.id);
            }}
          >
            {number}
          </button>
        ) : (
          <span
            data-agent-annotation-pin=""
            aria-label={`Annotation ${number}`}
            className={pinClassName}
            style={pinStyle}
          >
            {number}
          </span>
        )
      ) : null}
    </>
  );

  return annotation && onSelect ? (
    <AgentAnnotationActionsContextMenu
      annotation={annotation}
      onOpen={() => onSelect(annotation.id)}
      onLocate={onLocate ? () => onLocate(annotation.id) : undefined}
      onRemove={onRemove ? () => onRemove(annotation.id) : undefined}
    >
      <span data-agent-annotation-interaction-root="" className="contents">
        {content}
      </span>
    </AgentAnnotationActionsContextMenu>
  ) : (
    content
  );
}

const LocalAgentSelectionAnnotationOverlay = forwardRef<
  AgentSelectionAnnotationOverlayHandle,
  {
    target: AgentAnnotationTarget | null;
    annotations: readonly AgentAnnotationDraft[];
    onCreate: (target: AgentAnnotationTarget, note: string) => void;
    /** Restrict this overlay to one editor-owned object. */
    objectId?: string;
    /** Keep object types owned by a nested editor out of a broader surface overlay. */
    excludedObjectTypes?: readonly string[];
    activeId?: string | null;
    onSelect?: (annotationId: string) => void;
    onLocate?: (annotationId: string) => void;
    onRemove?: (annotationId: string) => void;
  }
>(function AgentSelectionAnnotationOverlay(
  {
    target,
    annotations,
    onCreate,
    objectId,
    excludedObjectTypes = [],
    activeId = null,
    onSelect,
    onLocate,
    onRemove,
  },
  ref,
) {
  const [draft, setDraft] = useState<SelectionDraft | null>(null);
  const [comment, setComment] = useState("");

  const pendingSelections = useMemo<PendingSelection[]>(
    () =>
      annotations.flatMap((annotation, index) => {
        const selection = annotation.target.selection;
        if (
          !selection?.visualRects?.length ||
          annotation.target.surfaceId !== target?.surfaceId ||
          (objectId && annotation.target.objectId !== objectId) ||
          excludedObjectTypes.includes(annotation.target.objectType)
        ) {
          return [];
        }
        return [
          {
            annotation,
            number: index + 1,
            rects: selection.visualRects,
          },
        ];
      }),
    [annotations, excludedObjectTypes, objectId, target?.surfaceId],
  );

  useEffect(() => {
    if (draft && draft.target.surfaceId !== target?.surfaceId) {
      setDraft(null);
      setComment("");
    }
  }, [draft, target?.surfaceId]);

  useImperativeHandle(
    ref,
    () => ({
      captureSelection(root) {
        if (!target) return false;
        const selection = window.getSelection?.();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
          return false;
        }

        const range = selection.getRangeAt(0);
        if (
          !root.contains(range.startContainer) ||
          !root.contains(range.endContainer)
        ) {
          return false;
        }

        const startElement =
          range.startContainer.nodeType === Node.ELEMENT_NODE
            ? (range.startContainer as Element)
            : range.startContainer.parentElement;
        const annotationSelectionRoot = startElement?.closest<HTMLElement>(
          "[data-agent-annotation-selection-root]",
        );
        const editable = startElement?.closest("[contenteditable='true']");
        if (
          startElement?.closest("input, textarea") ||
          (annotationSelectionRoot && annotationSelectionRoot !== root) ||
          (editable && !annotationSelectionRoot)
        ) {
          return false;
        }

        const exact = range.toString().trim();
        if (!exact) return false;

        const visualRects = normalizeRects(
          selectionRects(range),
          root.getBoundingClientRect(),
        );
        if (visualRects.length === 0) return false;

        const prefix = textBeforeRange(root, range).slice(-TEXT_CONTEXT_LENGTH);
        const suffix = textAfterRange(root, range).slice(
          0,
          TEXT_CONTEXT_LENGTH,
        );
        const resolvedTarget = selectionObjectTarget(target, range);
        if (
          (objectId && resolvedTarget.objectId !== objectId) ||
          excludedObjectTypes.includes(resolvedTarget.objectType)
        ) {
          return false;
        }
        setDraft({
          target: {
            ...resolvedTarget,
            selection: {
              kind: "text-quote",
              exact,
              ...(prefix ? { prefix } : {}),
              ...(suffix ? { suffix } : {}),
              visualRects,
            },
          },
        });
        setComment("");
        selection.removeAllRanges();
        return true;
      },
    }),
    [excludedObjectTypes, objectId, target],
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    onCreate(draft.target, comment.trim());
    setDraft(null);
    setComment("");
  };

  const draftRects = draft?.target.selection?.visualRects ?? [];
  const draftNumber = pendingSelections.length + 1;
  const anchorRect = draftRects.at(-1);

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[70]"
      aria-live="polite"
    >
      {pendingSelections.map(({ annotation, number, rects }) => (
        <AnnotationHighlight
          key={annotation.id}
          annotation={annotation}
          rects={rects}
          number={number}
          active={activeId === annotation.id}
          onSelect={onSelect}
          onLocate={onLocate}
          onRemove={onRemove}
        />
      ))}

      {draft && draftRects.length > 0 ? (
        <AnnotationHighlight rects={draftRects} number={draftNumber} draft />
      ) : null}

      <Popover
        open={Boolean(draft)}
        onOpenChange={(open) => {
          if (!open) {
            setDraft(null);
            setComment("");
          }
        }}
      >
        {anchorRect ? (
          <PopoverAnchor asChild>
            <span
              aria-hidden="true"
              className="absolute h-px w-px"
              style={{
                left: `${(anchorRect.x + anchorRect.width) * 100}%`,
                top: `${(anchorRect.y + anchorRect.height) * 100}%`,
              }}
            />
          </PopoverAnchor>
        ) : null}
        <PopoverContent
          side="top"
          align="start"
          className="pointer-events-auto w-[min(360px,calc(100vw-24px))] rounded-full p-1.5"
        >
          <form className="flex items-center gap-1.5" onSubmit={submit}>
            <input
              autoFocus
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Add an optional comment…"
              aria-label="Selection annotation comment"
              className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-stone-400 dark:text-slate-100 dark:placeholder:text-stone-500"
            />
            <IconButton
              type="submit"
              label="Add selection annotation"
              icon={<ArrowUp className="h-4 w-4" weight="bold" />}
              variant="active"
              size="sm"
              shape="circle"
              className="shrink-0"
            />
          </form>
        </PopoverContent>
      </Popover>
    </div>
  );
});

export const AgentSelectionAnnotationOverlay = forwardRef<
  AgentSelectionAnnotationOverlayHandle,
  ComponentPropsWithoutRef<typeof LocalAgentSelectionAnnotationOverlay>
>(function AgentSelectionAnnotationOverlayForHost(props, ref) {
  return isMcpProjectApp() ? null : <LocalAgentSelectionAnnotationOverlay {...props} ref={ref} />;
});
