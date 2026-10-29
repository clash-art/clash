/**
 * Project Timeline in-place MG composition inspector.
 *
 * Rendered by the host in the Properties panel when the selected Timeline
 * composition item resolves to a live Canvas html-motion / remotion-component
 * node. It reuses the same SessionDraft + element inspector as the fullscreen
 * MgOpenSurface, writes through to the Canvas node's `data.elementOverrides`
 * (plus derived HTML content for HTML motion), and reports live patches so the
 * Timeline preview can repaint before the Canvas round-trip lands.
 */
import { useEffect, useRef } from "react";
import type { CompositionItem } from "@clash/remotion-core";
import type { MgElementEditHandlers } from "@clash/remotion-ui";

import { normalizeElementOverrides } from "../lib/htmlMotionElementEdit";
import type { MgElementOverrides } from "../lib/htmlMotionElementEdit";
import {
  useMgElementEditSession,
  type MgElementEditSessionKind,
} from "../lib/useMgElementEditSession";
import { MgElementInspector } from "./MgElementInspector";

export type MgTimelineRuntimeNode = {
  id: string;
  type: string;
  data: Record<string, unknown>;
};

/** Live preview patch keyed by Canvas source node id. */
export type MgTimelinePreviewPatch = {
  elementOverrides: MgElementOverrides;
  /** HTML only — derived from the base template + overrides. */
  content?: string;
};

export type MgTimelineDraftChange = (
  sourceNodeId: string,
  patch: MgTimelinePreviewPatch | null,
) => void;

function sessionKindForItem(
  item: CompositionItem,
): MgElementEditSessionKind | null {
  if (item.runtime === "html") return "html-motion";
  if (item.runtime === "remotion") return "remotion-component";
  return null;
}

export function MgTimelineCompositionInspector({
  item,
  runtimeNodes,
  onDraftChange,
  onRegisterHandlers,
}: {
  item: CompositionItem;
  runtimeNodes: MgTimelineRuntimeNode[];
  onDraftChange: MgTimelineDraftChange;
  onRegisterHandlers?: (handlers: MgElementEditHandlers | null) => void;
}) {
  const sourceNodeId = item.sourceNodeId;
  const kind = sessionKindForItem(item);
  const node = sourceNodeId
    ? runtimeNodes.find(
        (candidate) => candidate.id === sourceNodeId && candidate.type === kind,
      )
    : undefined;
  if (!sourceNodeId || !kind || !node) return null;

  const source = typeof node.data.content === "string" ? node.data.content : "";
  const elementOverrides = normalizeElementOverrides(
    node.data.elementOverrides,
  );

  return (
    <MgTimelineCompositionInspectorSession
      key={`${sourceNodeId}:${kind}`}
      sourceNodeId={sourceNodeId}
      kind={kind}
      source={source}
      elementOverrides={elementOverrides}
      onDraftChange={onDraftChange}
      onRegisterHandlers={onRegisterHandlers}
    />
  );
}

function MgTimelineCompositionInspectorSession({
  sourceNodeId,
  kind,
  source,
  elementOverrides,
  onDraftChange,
  onRegisterHandlers,
}: {
  sourceNodeId: string;
  kind: MgElementEditSessionKind;
  source: string;
  elementOverrides: MgElementOverrides;
  onDraftChange: MgTimelineDraftChange;
  onRegisterHandlers?: (handlers: MgElementEditHandlers | null) => void;
}) {
  const {
    draftOverrides,
    elements,
    selectedElementId,
    setSelectedElementId,
    applyElementPatch,
    applyElementPatchImmediate,
    persistDraft,
    derivedSource,
  } = useMgElementEditSession({
    nodeId: sourceNodeId,
    kind,
    source,
    elementOverrides,
  });

  const draftChangeRef = useRef(onDraftChange);
  draftChangeRef.current = onDraftChange;
  const registerHandlersRef = useRef(onRegisterHandlers);
  registerHandlersRef.current = onRegisterHandlers;

  // Live preview: HTML sends the derived content; Remotion relies on
  // componentProps built from the override map (never TSX rewrite).
  useEffect(() => {
    draftChangeRef.current(sourceNodeId, {
      elementOverrides: draftOverrides,
      ...(kind === "html-motion" && derivedSource !== undefined
        ? { content: derivedSource }
        : {}),
    });
  }, [derivedSource, draftOverrides, kind, sourceNodeId]);

  // The Timeline preview stage (HtmlSceneSurface / Remotion AbsoluteFill)
  // routes element gestures back through the same SessionDraft.
  useEffect(() => {
    registerHandlersRef.current?.({
      activeSourceNodeId: sourceNodeId,
      onElementEdit: (nodeId, elementId, patch) => {
        if (nodeId !== sourceNodeId) return;
        applyElementPatchImmediate(elementId, patch);
      },
      onElementSelect: (nodeId, elementId) => {
        if (nodeId !== sourceNodeId) return;
        setSelectedElementId(elementId);
      },
    });
    return () => {
      registerHandlersRef.current?.(null);
    };
  }, [applyElementPatchImmediate, setSelectedElementId, sourceNodeId]);

  // Deselect/unmount: flush the draft, then drop the live preview patch so the
  // persisted Canvas node is the visible authority again.
  useEffect(
    () => () => {
      persistDraft();
      draftChangeRef.current(sourceNodeId, null);
    },
    [persistDraft, sourceNodeId],
  );

  return (
    <div
      data-testid="mg-timeline-composition-inspector"
      data-source-node-id={sourceNodeId}
    >
      <MgElementInspector
        elements={elements}
        selectedId={selectedElementId}
        onSelect={setSelectedElementId}
        onPatch={applyElementPatch}
      />
    </div>
  );
}
