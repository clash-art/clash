/**
 * SessionDraft hook for MG element edit (HTML + Remotion).
 *
 * Shared by the fullscreen MgOpenSurface and the Project Timeline in-place
 * composition inspector. The hook owns the local override draft and persists it
 * to the linked Canvas node on the same cadence as text documents:
 *
 * - inspector Text/X/Y: 500ms debounce
 * - stage pointerup / in-iframe text commit: immediate
 * - unmount / surface close: flush pending draft
 *
 * HTML writes `{ content: deriveHtmlMotionContent(base, overrides),
 * elementOverrides }`; Remotion writes `{ elementOverrides }` only and never
 * rewrites the component TSX.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";

import { useOptionalLoroSyncContext } from "../components/LoroSyncContext";
import {
  deriveHtmlMotionContent,
  listHtmlMotionEditableElementsWithOverrides,
  mergeElementOverride,
  normalizeElementOverrides,
  seedElementOverridesFromHtml,
  serializeElementOverrides,
  type MgElementOverrides,
  type MgElementPatch,
} from "./htmlMotionElementEdit";
import {
  buildRemotionMgComponentProps,
  listRemotionEditableElementsWithOverrides,
  seedElementOverridesFromRemotionSource,
} from "./remotionElementEdit";

/** Match text document autosave cadence — avoid loro version explosion on inspector keystrokes. */
export const MG_ELEMENT_AUTOSAVE_DELAY_MS = 500;

export type MgElementEditSessionKind = "html-motion" | "remotion-component";

export type UseMgElementEditSessionOptions = {
  nodeId: string;
  kind: MgElementEditSessionKind;
  /** Base/template source from node `data.content` (may already be derived). */
  source: string;
  /** Authoritative override map from node `data.elementOverrides`. */
  elementOverrides?: MgElementOverrides;
  /** Autosave debounce override; defaults to 500ms. */
  autosaveDelayMs?: number;
};

export function useMgElementEditSession({
  nodeId,
  kind,
  source,
  elementOverrides,
  autosaveDelayMs = MG_ELEMENT_AUTOSAVE_DELAY_MS,
}: UseMgElementEditSessionOptions) {
  const loroSync = useOptionalLoroSyncContext();
  const reactFlow = useReactFlow();

  const initialOverrides = normalizeElementOverrides(elementOverrides);
  const [draftOverrides, setDraftOverrides] =
    useState<MgElementOverrides>(initialOverrides);
  const [selectedElementId, setSelectedElementId] = useState<string | null>(
    null,
  );

  /** Base/template source (HTML doc or Remotion TSX) — not a derived view. */
  const baseSourceRef = useRef(source);
  const latestOverridesRef = useRef<MgElementOverrides>(initialOverrides);
  const persistedOverridesRef = useRef<string>(
    serializeElementOverrides(initialOverrides),
  );
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const nodeIdRef = useRef(nodeId);
  nodeIdRef.current = nodeId;
  const delayRef = useRef(autosaveDelayMs);
  delayRef.current = autosaveDelayMs;
  const reactFlowRef = useRef(reactFlow);
  reactFlowRef.current = reactFlow;
  const loroSyncRef = useRef(loroSync);
  loroSyncRef.current = loroSync;

  const sessionOverridesKey = serializeElementOverrides(
    normalizeElementOverrides(elementOverrides),
  );

  // Sync a new session (node/source/override map) into the draft. Fingerprint
  // the override map so object-identity churn does not reset active edits.
  useEffect(() => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const nextOverrides = normalizeElementOverrides(elementOverrides);
    baseSourceRef.current = source;
    latestOverridesRef.current = nextOverrides;
    persistedOverridesRef.current = serializeElementOverrides(nextOverrides);
    setDraftOverrides(nextOverrides);
    // sessionOverridesKey fingerprints elementOverrides (avoid object-identity churn).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, kind, source, sessionOverridesKey]);

  const elements = useMemo(
    () =>
      kind === "html-motion"
        ? listHtmlMotionEditableElementsWithOverrides(
            baseSourceRef.current,
            draftOverrides,
          )
        : listRemotionEditableElementsWithOverrides(
            baseSourceRef.current,
            draftOverrides,
          ),
    [kind, draftOverrides, source],
  );

  useEffect(() => {
    setSelectedElementId((current) => {
      if (current && elements.some((item) => item.id === current)) {
        return current;
      }
      return elements[0]?.id ?? null;
    });
  }, [elements]);

  const persistDraft = useCallback(() => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const overrides = latestOverridesRef.current;
    const fingerprint = serializeElementOverrides(overrides);
    if (fingerprint === persistedOverridesRef.current) {
      return;
    }
    const targetNodeId = nodeIdRef.current;
    const dataPatch =
      kindRef.current === "html-motion"
        ? {
            content: deriveHtmlMotionContent(baseSourceRef.current, overrides),
            elementOverrides: overrides,
          }
        : {
            // Remotion: keep TSX content; SoT is elementOverrides → componentProps.
            elementOverrides: overrides,
          };
    try {
      reactFlowRef.current.setNodes((nodes) =>
        nodes.map((node) =>
          node.id === targetNodeId
            ? {
                ...node,
                data: {
                  ...node.data,
                  ...dataPatch,
                },
              }
            : node,
        ),
      );
    } catch {
      // Outside ReactFlow in unit tests — persistence via loro still attempted.
    }
    loroSyncRef.current?.updateNode?.(targetNodeId, {
      data: dataPatch,
    });
    persistedOverridesRef.current = fingerprint;
  }, []);

  const schedulePersist = useCallback(() => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      persistDraft();
    }, delayRef.current);
  }, [persistDraft]);

  const commitOverridePatch = useCallback(
    (
      elementId: string,
      patch: MgElementPatch,
      mode: "debounce" | "immediate",
    ) => {
      try {
        let next = latestOverridesRef.current;
        // Migrate: first edit seeds absolute values from current source markers.
        if (kindRef.current === "html-motion") {
          next = seedElementOverridesFromHtml(baseSourceRef.current, next, [
            elementId,
          ]);
        } else {
          next = seedElementOverridesFromRemotionSource(
            baseSourceRef.current,
            next,
            [elementId],
          );
        }
        next = mergeElementOverride(next, elementId, patch);
        latestOverridesRef.current = next;
        setDraftOverrides(next);
        if (mode === "immediate") {
          persistDraft();
        } else {
          schedulePersist();
        }
      } catch {
        // Invalid patch — keep previous draft.
      }
    },
    [persistDraft, schedulePersist],
  );

  /** Inspector Text/X/Y: local draft immediate; Canvas/loro debounced. */
  const applyElementPatch = useCallback(
    (elementId: string, patch: MgElementPatch) => {
      commitOverridePatch(elementId, patch, "debounce");
    },
    [commitOverridePatch],
  );

  /**
   * Stage pointerup / in-iframe text commit: already one-shot — persist
   * immediately (live translate stays in-iframe until pointerup).
   */
  const applyElementPatchImmediate = useCallback(
    (elementId: string, patch: MgElementPatch) => {
      commitOverridePatch(elementId, patch, "immediate");
    },
    [commitOverridePatch],
  );

  useEffect(
    () => () => {
      persistDraft();
    },
    [persistDraft],
  );

  const remotionComponentProps = useMemo(
    () => buildRemotionMgComponentProps(draftOverrides),
    [draftOverrides],
  );

  const derivedSource = useMemo(
    () =>
      kind === "html-motion"
        ? deriveHtmlMotionContent(source, draftOverrides)
        : undefined,
    [kind, source, draftOverrides],
  );

  return {
    draftOverrides,
    elements,
    selectedElementId,
    setSelectedElementId,
    applyElementPatch,
    applyElementPatchImmediate,
    persistDraft,
    schedulePersist,
    remotionComponentProps,
    derivedSource,
  };
}
