import { createLogger } from "../../lib/logger";
import { appendActionCardInput, createActionCardPromptEdit, reorderActionCardInputs } from "@clash/shared-types";
import { editModelKeyframes, evenlySpacedFrameIndices, keyframeFrameIndices, planKeyframeInsertion, KEYFRAME_FRAME_INDICES_PARAM, KEYFRAME_TIMING_CUSTOMIZED_PARAM } from "@clash/shared-types";
export { planKeyframeInsertion } from "@clash/shared-types";
import { canvasModelGeneratorRevisionData } from "@clash/shared-types";
import type { GeneratorDraftEdit } from "../../lib/generatorDraftEditor";
import { useNativeGeneratorDraft } from "../../hooks/useNativeGeneratorDraft";
import {
  Fragment,
  memo,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Handle,
  NodeToolbar,
  Position,
  type Node as RFNode,
  NodeProps,
  useReactFlow,
  useNodeConnections,
  useStoreApi,
} from "@xyflow/react";
import {
  VideoCamera,
  Image as ImageIcon,
  CaretDown,
  X,
  Play,
  Spinner,
  PuzzlePiece,
  Plus,
  Lock,
  Copy,
  SpeakerHigh,
  TextT,
  Cube,
  SlidersHorizontal,
} from "@phosphor-icons/react";
import { motion, Reorder } from "framer-motion";
import {
  AspectRatioPicker,
  parseAspectRatio,
  type AspectRatioOption,
} from "@clash/remotion-ui";
import { useProject } from "../ProjectContext";
import { useOptionalLoroSyncContext } from "../LoroSyncContext";
import { usePeersSelectingNode } from "../PresenceAwarenessContext";
import PeerSelectionRing from "../PeerSelectionRing";
import { useLayoutManager } from "@clash/web-ui/lib/layout";
import { generateSemanticId } from "@clash/web-ui/lib/utils/semanticId";
import { ProjectedImage } from "../ProjectedMedia";
import { getAsset, useAsset } from "@clash/web-ui/lib/hooks/useAsset";
import { NativeMediaReference } from "./NativeMediaReference";
import { NativeDocumentReference } from "./NativeDocumentReference";
import { NativeOrderedPrompt } from "./NativeOrderedPrompt";
import { modelPromptParts, modelPromptPartsWithInputs, withModelPromptParts, removeModelPromptInput, modelInputRefsInPromptOrder, reorderModelMediaInputs } from "../../lib/modelPromptContent";
import { createModelPromptEdit, createModelTextReferenceEdit } from "../../lib/modelPromptMentions";
import { createModelMediaInput } from "../../lib/modelMediaInput";
import { assetThumbnailImageUrl } from "../../features/assets/media-url";
import { VideoPoster } from "../../features/assets/VideoPoster";
import {
  activeModelParameterIds,
  applyModelParameterChange,
  normalizeModelParametersForCard,
  listCompatibleModelCatalogEntries,
  modelRouteSupportsParameters,
  MODEL_CARDS,
  resolveAspectRatioParameter,
  snapAspectRatio,
  parsePromptParts,
  extractPromptText,
  composePromptWithTextRefs,
  buildMention,
  capability,
  capabilityFromCustom,
  customActionDefaultParams,
  directorReferencePackets,
  referenceAssetId,
  canvasAssetRevision,
  referenceModality,
  validateReferenceMedia,
  validateRefs,
  type DirectorReferencePacket,
  type ExecutablePluginBinding,
  type ModelCard,
  type ModelParameter,
  type CustomActionDefinition,
  type AigcActionKind,
  type Modality,
  type ReferenceMediaMetadata,
} from "@clash/shared-types";
import {
  applyLayoutPatchesToLoro,
  collectLayoutNodePatches,
} from "@clash/web-ui/lib/loroNodeSync";
import { useProjectCustomActions } from "../CustomActionsContext";
import {
  useRuntimes,
  isCustomActionRuntimeOnline,
  RUNTIME_OFFLINE_TOOLTIP,
  RUNTIME_OFFLINE_LABEL,
} from "@clash/web-ui/hooks/useRuntimes";
import MilkdownEditor from "../MilkdownEditor";
import { useConfirm } from "../ConfirmDialog";
import { SelectMenu, type SelectOption, type SelectValue } from "../ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../ui/accordion";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Tooltip } from "../ui/tooltip";
import { Slider, SliderRange, SliderThumb, SliderTrack } from "../ui/slider";
import {
  ComboboxItem,
  ComboboxList,
  ComboboxProvider,
  useComboboxStore,
  type ComboboxStore,
} from "../ui/combobox";
import { replaceContentEditableHtmlPreservingFocus } from "../contentEditableSync";
import { handleMentionComboboxKeyDown } from "../mentionComboboxKeyboard";
import { actionIsCheckpointLocked } from "@clash/web-ui/lib/actionCheckpoint";
import { useSpawnPendingAsset } from "./useSpawnPendingAsset";
import ActionBadgePipelineMenu from "./ActionBadgePipelineMenu";
import AttributionLine from "./AttributionLine";
import { getModelDropdownSecondaryText } from "./modelDisplay";
import {
  preferredModelRoutePluginBinding,
  resolveModelProjectorBinding,
} from "./modelPluginBinding";
import { NodeModalDialog } from "./NodeModalDialog";
import { useCanvasTransientUiOwner } from "../CanvasTransientUiContext";
import {
  generationChoiceDefaults,
  listGenerationActionChoices,
} from "./generationActionChoices";
import { resolveBuiltInActionKind } from "./generationActionKind";

type ModelParams = Record<string, string | number | boolean>;

const mediaLog = createLogger("actions");

export function normalizeActionAspectRatioOptions(
  parameter: ModelParameter,
): AspectRatioOption<string | number>[] {
  return (parameter.options ?? []).map((option) => {
    const resolved = resolveAspectRatioParameter(parameter, option.value);
    const label =
      resolved === "auto" || resolved === "adaptive"
        ? "Auto"
        : (resolved ?? option.label);
    return { ...option, label };
  });
}

const FALLBACK_MODEL_BY_KIND: Record<AigcActionKind, string> = {
  image: "nano-banana-2",
  video: "sora-2",
  audio: "gemini-3.1-flash-tts",
  text: "gpt-5.4",
  model: "meshy-6",
};

const BATCH_COUNT_OPTIONS: SelectOption<number>[] = [
  { value: 1, label: "x1" },
  { value: 2, label: "x2" },
  { value: 3, label: "x3" },
  { value: 4, label: "x4" },
];

const PARAM_BOOLEAN_OPTIONS: SelectOption<boolean>[] = [
  { value: true, label: "On" },
  { value: false, label: "Off" },
];
const NODE_INTERACTION_BOUNDARY_CLASS = "nodrag nopan";
const ACTION_DEFINITION_UPDATED_LABEL = "Action definition updated";
const ACTION_DEFINITION_UPDATED_RUN_LABEL =
  "Action definition updated. Update before running.";

function executablePluginBindingsMatch(
  left: ExecutablePluginBinding | undefined,
  right: ExecutablePluginBinding | undefined,
): boolean {
  return (
    left?.pluginId === right?.pluginId &&
    left?.version === right?.version &&
    left?.exportId === right?.exportId &&
    left?.schemaHash === right?.schemaHash
  );
}

function formatFrameTime(frameIndex: number, frameRate: number): string {
  const seconds = frameIndex / frameRate;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(2)}s`;
}

function FrameReferenceStrip({
  ariaLabel,
  children,
  layout,
  message,
  trailingControl,
}: {
  ariaLabel: string;
  children: ReactNode;
  layout: "fixed" | "scroll";
  message?: ReactNode;
  trailingControl?: ReactNode;
}) {
  const scroll = layout === "scroll";
  const content = (
    <div
      className={
        scroll
          ? "flex min-w-max items-start gap-x-1.5 pr-1"
          : "flex items-start gap-x-1.5"
      }
      role="list"
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );
  if (!scroll) {
    return (
      <div
        data-testid="frame-reference-strip"
        data-frame-layout={layout}
        className="pointer-events-auto relative mb-2 px-1"
      >
        {content}
        {message}
      </div>
    );
  }
  return (
    <div
      data-testid="frame-reference-strip"
      data-frame-layout={layout}
      className="pointer-events-auto relative mb-2 w-[18rem] min-w-0 max-w-[min(18rem,calc(100vw-3rem))] flex-none px-1"
      style={{
        width: "18rem",
        maxWidth: "calc(100vw - 3rem)",
        minWidth: 0,
        flex: "none",
      }}
    >
      <div className="flex min-w-0 items-start gap-1.5">
        <div
          data-testid="frame-reference-scroll"
          className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden pb-1 pt-1"
        >
          {content}
        </div>
        {trailingControl && (
          <div className="flex-none pt-2">{trailingControl}</div>
        )}
      </div>
      {message}
    </div>
  );
}

function FrameReferenceSlot({
  assetReference,
  badge,
  emptyControl,
  filled,
  label,
  onRemove,
  removeLabel,
  thumb,
  timeControl,
  timeLabel,
}: {
  assetReference?: { projectId: string; assetId: string };
  badge?: ReactNode;
  emptyControl?: ReactNode;
  filled: boolean;
  label: string;
  onRemove?: () => void;
  removeLabel?: string;
  thumb?: string;
  timeControl?: ReactNode;
  timeLabel?: string;
}) {
  const asset = useAsset(assetReference?.projectId ?? "", assetReference?.assetId);
  const resolvedThumb = thumb ?? (assetReference ? asset?.thumbnailUrl ?? (asset?.kind === "image" ? asset.url : undefined) : undefined);
  return (
    <Tooltip label={label}>
      <div className="group/thumb relative w-10 flex-shrink-0">
        {filled ? (
          <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border border-warm-border bg-warm-muted shadow-sm">
            {resolvedThumb ? (
              <ProjectedImage
                src={resolvedThumb}
                alt={label}
                className="h-full w-full object-cover"
              />
            ) : (
              <ImageIcon size={15} className="text-content-secondary" />
            )}
          </div>
        ) : (
          emptyControl
        )}
        <span className="sr-only">{label}</span>
        {badge != null && (
          <span className="clash-node-ref-index pointer-events-none absolute -left-1 -top-1 min-w-[14px] rounded px-1 text-center text-[9px] font-bold leading-[14px]">
            {badge}
          </span>
        )}
        {timeControl ??
          (timeLabel && (
            <div className="mt-1 text-center text-[9px] tabular-nums leading-none text-content-secondary">
              {timeLabel}
            </div>
          ))}
        {onRemove && removeLabel && (
          <IconButton
            label={removeLabel}
            icon="×"
            size="sm"
            shape="circle"
            onClick={onRemove}
            className={`${NODE_INTERACTION_BOUNDARY_CLASS} clash-node-ref-remove absolute -right-1 -top-1 hidden h-5 min-h-5 w-5 min-w-5 text-[11px] leading-none group-hover/thumb:flex`}
          />
        )}
      </div>
    </Tooltip>
  );
}

const KEYFRAME_TIME_SLOT_CLASS =
  "mt-1 flex h-4 w-10 items-center justify-center text-center text-[9px] tabular-nums leading-none text-content-secondary";

function KeyframeTimeInput({
  frameIndex,
  frameRate,
  label,
  maxFrame,
  minFrame,
  onCommit,
}: {
  frameIndex: number;
  frameRate: number;
  label: string;
  maxFrame: number;
  minFrame: number;
  onCommit: (frameIndex: number) => void;
}) {
  const canonical = (frameIndex / frameRate).toFixed(2);
  const [draft, setDraft] = useState(canonical);
  useEffect(() => setDraft(canonical), [canonical]);

  const commit = () => {
    const seconds = Number.parseFloat(draft);
    const requestedFrame = Number.isFinite(seconds)
      ? Math.round(seconds * frameRate)
      : frameIndex;
    const nextFrame = Math.max(minFrame, Math.min(maxFrame, requestedFrame));
    onCommit(nextFrame);
    setDraft((nextFrame / frameRate).toFixed(2));
  };

  return (
    <label
      data-testid="keyframe-time-slot"
      className={`relative ${KEYFRAME_TIME_SLOT_CLASS}`}
      title={`${label} · exact position at ${frameRate} fps`}
    >
      <span className="sr-only">{label}</span>
      <Input
        aria-label={label}
        type="number"
        inputMode="decimal"
        min={(minFrame / frameRate).toFixed(2)}
        max={(maxFrame / frameRate).toFixed(2)}
        step={(1 / frameRate).toFixed(4)}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(canonical);
            event.currentTarget.blur();
          }
        }}
        className={`${NODE_INTERACTION_BOUNDARY_CLASS} block h-full w-full rounded border border-transparent bg-transparent px-0.5 text-center text-[9px] tabular-nums leading-none text-content-secondary outline-none transition-colors hover:border-warm-border hover:bg-warm-surface focus:border-ring/45 focus:bg-warm-surface focus:text-content-primary`}
      />
    </label>
  );
}

function TimelineKeyframeMarker({
  children,
  draggable,
  frameIndex,
  lastFrame,
  maxFrame,
  minFrame,
  onCommit,
  trackRef,
}: {
  children: (previewFrame: number) => ReactNode;
  draggable: boolean;
  frameIndex: number;
  lastFrame: number;
  maxFrame: number;
  minFrame: number;
  onCommit: (frameIndex: number) => void;
  trackRef: RefObject<HTMLDivElement | null>;
}) {
  const [previewFrame, setPreviewFrame] = useState(frameIndex);
  const previewFrameRef = useRef(frameIndex);
  const dragStartRef = useRef<{
    pointerId: number;
    clientX: number;
    frameIndex: number;
  } | null>(null);
  useEffect(() => {
    previewFrameRef.current = frameIndex;
    setPreviewFrame(frameIndex);
  }, [frameIndex]);

  const updateFromPointer = (clientX: number) => {
    const dragStart = dragStartRef.current;
    const track = trackRef.current;
    if (!dragStart || !track || lastFrame <= 0) return;
    const width = track.getBoundingClientRect().width;
    if (width <= 0) return;
    const deltaFrames = Math.round(
      ((clientX - dragStart.clientX) / width) * lastFrame,
    );
    const nextFrame = Math.max(
      minFrame,
      Math.min(maxFrame, dragStart.frameIndex + deltaFrames),
    );
    previewFrameRef.current = nextFrame;
    setPreviewFrame(nextFrame);
  };

  const finishDrag = (pointerId: number) => {
    if (dragStartRef.current?.pointerId !== pointerId) return;
    dragStartRef.current = null;
    onCommit(previewFrameRef.current);
  };

  return (
    <div
      className={`group/timeline-marker absolute top-4 z-10 -translate-x-1/2 transition-[left] duration-75 hover:z-30 focus-within:z-30 ${draggable ? "cursor-ew-resize touch-none" : ""}`}
      style={{
        left: `${lastFrame > 0 ? (previewFrame / lastFrame) * 100 : 0}%`,
      }}
      onPointerDown={(event) => {
        if (!draggable || (event.target as HTMLElement).closest("button,input"))
          return;
        dragStartRef.current = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          frameIndex: previewFrame,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (dragStartRef.current?.pointerId !== event.pointerId) return;
        updateFromPointer(event.clientX);
      }}
      onPointerUp={(event) => finishDrag(event.pointerId)}
      onPointerCancel={(event) => finishDrag(event.pointerId)}
    >
      <span
        aria-hidden
        className={`pointer-events-none absolute left-1/2 top-[-14px] h-2 w-2 -translate-x-1/2 rounded-full border border-warm-border bg-warm-surface shadow-sm transition-colors ${draggable ? "group-hover/timeline-marker:border-brand/60 group-hover/timeline-marker:bg-brand/15" : ""}`}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[-7px] h-[7px] w-px -translate-x-1/2 bg-warm-border"
      />
      {children(previewFrame)}
    </div>
  );
}

function referenceMediaMetadata(node: {
  type?: string;
  data?: Record<string, any>;
}): ReferenceMediaMetadata | null {
  const modality = referenceModality(node);
  if (!modality || modality === "text") return null;
  const data = node.data ?? {};
  const metadata =
    data.metadata && typeof data.metadata === "object" ? data.metadata : {};
  const numeric = (key: string, fallbackKey?: string): number | undefined => {
    const value =
      data[key] ??
      metadata[key] ??
      (fallbackKey ? (data[fallbackKey] ?? metadata[fallbackKey]) : undefined);
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  };
  return {
    modality,
    contentType: data.contentType ?? metadata.contentType,
    fileName: data.originalName ?? metadata.originalName,
    bytes: numeric("bytes"),
    width: numeric("naturalWidth", "width"),
    height: numeric("naturalHeight", "height"),
    durationMs: numeric("durationMs"),
    frameRate: numeric("frameRate", "fps"),
    videoCodec: data.videoCodec ?? metadata.videoCodec,
    audioCodec: data.audioCodec ?? metadata.audioCodec,
  };
}

function paramOptionsToSelectOptions(
  param: ModelParameter,
): SelectOption<SelectValue>[] {
  return (param.options ?? []).map((option) => ({
    value: option.value as SelectValue,
    label: option.label,
  }));
}

function normalizeSliderValue(value: unknown, fallback: number): number {
  const numericValue =
    typeof value === "number" ? value : Number(value ?? fallback);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function ModelParamSlider({
  ariaLabel,
  className = `${NODE_INTERACTION_BOUNDARY_CLASS} h-4 w-full`,
  max,
  min,
  onChange,
  step,
  trackClassName,
  value,
}: {
  ariaLabel: string;
  className?: string;
  max?: number;
  min?: number;
  onChange: (value: number) => void;
  step?: number;
  trackClassName: string;
  value: number;
}) {
  return (
    <Slider
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      value={[value]}
      onValueChange={(nextValue) => onChange(nextValue[0] ?? value)}
      className={className}
    >
      <SliderTrack className={`h-1.5 rounded-full ${trackClassName}`}>
        <SliderRange className="inset-y-0 rounded-full bg-brand" />
      </SliderTrack>
      <SliderThumb className="h-4 w-4 rounded-full border border-brand bg-warm-surface shadow-sm" />
    </Slider>
  );
}

type ActionMentionNode = {
  id: string;
  type: string;
  label: string;
  thumbnail?: string;
};

const actionMentionItemId = (nodeId: string): string =>
  `action-mention-${nodeId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
const escapeHtmlAttribute = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function ActionMentionPicker({
  nodes,
  store,
}: {
  nodes: ActionMentionNode[];
  store: ComboboxStore;
}) {
  return (
    <ComboboxProvider store={store}>
      <ComboboxList
        aria-label="Reference asset matches"
        alwaysVisible
        className="clash-action-mention-menu absolute inset-x-4 bottom-full z-50 mb-1 max-h-48 overflow-y-auto rounded-xl border border-warm-border bg-warm-surface shadow-lg"
      >
        {nodes.map((node) => {
          return (
            <ComboboxItem
              id={actionMentionItemId(node.id)}
              key={node.id}
              value={node.id}
              focusOnHover
              setValueOnClick={false}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              className="flex w-full cursor-default items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors outline-none hover:bg-warm-muted data-[active-item]:bg-warm-muted"
            >
              {node.thumbnail ? (
                <ProjectedImage
                  src={node.thumbnail}
                  alt={node.label}
                  className="h-8 w-8 flex-shrink-0 rounded border border-warm-border object-cover"
                />
              ) : (
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded border border-warm-border bg-warm-muted">
                  <span className="text-[9px] uppercase text-stone-700 dark:text-stone-300">
                    {node.type}
                  </span>
                </span>
              )}
              <span className="truncate font-medium text-slate-900 dark:text-slate-50">
                {node.label}
              </span>
            </ComboboxItem>
          );
        })}
      </ComboboxList>
    </ComboboxProvider>
  );
}

// Helper to extract meaningful label from prompt content
const extractLabelFromPrompt = (
  promptText: string,
  fallback: string,
): string => {
  if (!promptText || promptText.trim() === "") return fallback;

  // Remove markdown headers and get first non-empty line
  const lines = promptText
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !line.startsWith("#") &&
        line !== "Prompt" &&
        line !== "Enter your prompt here...",
    );

  if (lines.length === 0) return fallback;

  // Take first 50 chars of first meaningful line
  const firstLine = lines[0];
  if (firstLine.length > 50) {
    return firstLine.substring(0, 50) + "...";
  }
  return firstLine;
};

type NativeGeneratorDraft = NonNullable<ReturnType<typeof useNativeGeneratorDraft>>;
const PromptActionNode = ({
  data,
  selected,
  id,
  nativeDraft,
}: NodeProps<RFNode<Record<string, any>>> & { nativeDraft?: NativeGeneratorDraft }) => {
  // `data.openPanel` is a one-shot handoff from `handleCopy` — a freshly
  // cloned node mounts with its config panel already open, then clears the
  // flag in an effect so subsequent loads don't re-open.
  const {
    close: closeActionPanel,
    isOpen: showPanel,
    open: openActionPanel,
  } = useCanvasTransientUiOwner("action-panel", id);
  const flowStore = useStoreApi();
  // Configuration belongs to the real canvas selection, so its highlight
  // and keyboard deletion always target the same node.
  const selectAction = () => {
    if (!selected) flowStore.getState().addSelectedNodes([id]);
  };
  useEffect(() => {
    if (!selected) closeActionPanel();
  }, [selected, closeActionPanel]);
  const [showModal, setShowModal] = useState(false);
  // Peers (other connected users) who currently have this node selected.
  const peersSelecting = usePeersSelectingNode(id);
  const [isExecuting, setIsExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // @ mention state
  const [showMentionMenu, setShowMentionMenu] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");

  // Canvas-node ref picker (click + to attach). Value is slot target:
  // 'append' for non-startEnd strip, 'start' | 'end' for startEnd slots.
  const [refPickerTarget, setRefPickerTarget] = useState<
    null | "append" | "start" | "end"
  >(null);
  const keyframeTrackRef = useRef<HTMLDivElement>(null);
  const [keyframeTimelineOpen, setKeyframeTimelineOpen] = useState(false);
  const [selectedKeyframeId, setSelectedKeyframeId] = useState<string | null>(
    null,
  );

  // React Flow hooks
  const { enabledModelCatalog, projectId, configureModels } = useProject();
  const { getNode, getNodes, getEdges, addEdges, setNodes, setEdges } =
    useReactFlow();
  const loroSync = useOptionalLoroSyncContext();
  const connections = useNodeConnections({ id });
  const connectedEdges = useMemo(
    () =>
      connections.map((connection) => ({
        id: connection.edgeId,
        source: connection.source,
        target: connection.target,
      })),
    [connections],
  );
  const confirm = useConfirm();
  const onNodesMutated = useCallback(
    (prevNodes: RFNode[], nextNodes: RFNode[]) => {
      if (!loroSync) return;
      const patches = collectLayoutNodePatches(prevNodes, nextNodes);
      applyLayoutPatchesToLoro(loroSync, patches);
    },
    [loroSync],
  );
  const { addNodeWithAutoLayout, addNodeWithLayout } = useLayoutManager({
    onNodesMutated,
  });

  // Prompt editing state
  const cleanContent = (val: string | undefined) => {
    if (!val) return "";
    // Strip legacy default placeholder
    if (
      val.trim() === "# Prompt\nEnter your prompt here..." ||
      val.trim() === "# Prompt\n\nEnter your prompt here..."
    )
      return "";
    return val;
  };
  const [label, setLabel] = useState(data.label || "Prompt");
  const [content, setContent] = useState(cleanContent(data.content));
  const [lyrics, setLyrics] = useState(
    typeof data.lyrics === "string" ? data.lyrics : "",
  );
  const isCheckpointLocked = useMemo(() => {
    const checkpointEdges = getEdges();
    const downstreamIds = new Set<string>();
    const pendingSourceIds = [id];

    while (pendingSourceIds.length > 0) {
      const sourceId = pendingSourceIds.pop();
      if (!sourceId) break;
      for (const edge of checkpointEdges) {
        if (edge.source !== sourceId || downstreamIds.has(edge.target))
          continue;
        downstreamIds.add(edge.target);
        pendingSourceIds.push(edge.target);
      }
    }

    const checkpointNodes = Array.from(downstreamIds)
      .map((nodeId) => getNode(nodeId))
      .filter((node): node is RFNode => Boolean(node));
    return actionIsCheckpointLocked({
      nodeId: id,
      nodes: checkpointNodes,
      edges: checkpointEdges,
    });
  }, [id, data.hasRun, connectedEdges, getNode, getEdges]);
  const [showRefPicker, setShowRefPicker] = useState(false);
  const [paramsPopoverOpen, setParamsPopoverOpen] = useState(false);
  const [aspectRatioPopoverOpen, setAspectRatioPopoverOpen] = useState(false);
  const [aspectRatioPopoverValue, setAspectRatioPopoverValue] = useState<
    string | number | undefined
  >(undefined);

  const resolveConfiguredModelId = (
    type: "image-gen" | "video-gen",
    explicitId?: string,
    legacyName?: string,
  ): string | undefined => {
    if (explicitId) return explicitId;
    if (!legacyName) return undefined;
    const lower = legacyName.toLowerCase();
    if (type === "video-gen") return "sora-2";
    if (lower.includes("pro")) return "nano-banana-2";
    return "nano-banana-2";
  };

  const [actionType, setActionType] = useState<string>(
    data.actionType || "image-gen",
  );
  const lastIncomingActionType = useRef<string>(data.actionType || "image-gen");
  const isCustom = actionType.startsWith("custom:");
  const customActionId = isCustom ? actionType.replace("custom:", "") : null;

  const customActions = useProjectCustomActions();
  const customDef: CustomActionDefinition | undefined = customActionId
    ? customActions.find((a) => a.id === customActionId)
    : undefined;

  // Live runtime list (polled). Used to grey out custom-action affordances
  // when their owning runtime is offline — the server already refuses
  // dispatch in that case, this is just to tell the user beforehand.
  const { runtimes: knownRuntimes, loading: runtimesLoading } = useRuntimes();
  // While the first /api/v1/runtimes response is in flight, treat the
  // action as online to avoid a flash-disabled state on every mount.
  // Once we have data, the helper does the real check.
  const customActionOnline = isCustom
    ? runtimesLoading
      ? true
      : isCustomActionRuntimeOnline(customDef, knownRuntimes)
    : true;
  const customActionOffline = !customActionOnline;

  // Custom action params state
  const [customActionParams, setCustomActionParams] = useState<ModelParams>({
    ...(customDef ? customActionDefaultParams(customDef) : {}),
    ...((data.customActionParams as ModelParams) ?? {}),
  });

  const editorRef = useRef<HTMLDivElement>(null);

  const actionKind = customDef?.outputType ?? resolveBuiltInActionKind(actionType);
  const initialModelId = isCustom
    ? ""
    : (actionKind === "image" || actionKind === "video"
        ? resolveConfiguredModelId(
            actionType as "image-gen" | "video-gen",
            data.modelId as string | undefined,
            data.modelName,
          )
        : (data.modelId as string | undefined)) ||
      (enabledModelCatalog.find((entry) => entry.model.kind === actionKind)
        ?.model.id ?? "");
  const initialModelCard =
    enabledModelCatalog.find((entry) => entry.model.id === initialModelId)
      ?.model ?? MODEL_CARDS.find((card) => card.id === initialModelId);

  const [modelId, setModelId] = useState<string>(initialModelId);
  const [modelParams, setModelParams] = useState<ModelParams>({
    ...(initialModelCard?.defaultParams ?? {}),
    ...(data.modelParams ?? {}),
  });

  const Icon = isCustom
    ? PuzzlePiece
    : actionKind === "video"
      ? VideoCamera
      : actionKind === "audio"
        ? SpeakerHigh
        : actionKind === "text"
          ? TextT
          : actionKind === "model"
            ? Cube
          : ImageIcon;
  const colorClass = isCustom
    ? "text-custom"
    : actionKind === "video"
      ? "text-video"
      : actionKind === "audio"
        ? "text-audio"
        : actionKind === "text"
          ? "text-slate-800 dark:text-slate-200"
          : actionKind === "model"
            ? "text-slate-800 dark:text-slate-200"
          : "text-image";
  const bgClass = isCustom
    ? "bg-custom-light"
    : actionKind === "video"
      ? "bg-video-light"
      : actionKind === "audio"
        ? "bg-audio-light"
        : actionKind === "text"
          ? "bg-warm-muted"
          : actionKind === "model"
            ? "bg-warm-muted"
          : "bg-image-light";
  const ringClass = isCustom
    ? "ring-custom"
    : actionKind === "video"
      ? "ring-video"
      : actionKind === "audio"
        ? "ring-audio"
        : actionKind === "text"
          ? "ring-slate-500"
          : actionKind === "model"
            ? "ring-slate-500"
          : "ring-image";
  const btnClass = isCustom
    ? "bg-custom hover:opacity-90"
    : actionKind === "video"
      ? "bg-video hover:opacity-90"
      : actionKind === "audio"
        ? "bg-audio hover:opacity-90"
        : actionKind === "text"
          ? "clash-node-primary"
          : actionKind === "model"
            ? "clash-node-primary"
          : "bg-image hover:opacity-90";

  const availableModels = useMemo(
    () =>
      enabledModelCatalog
        .map((entry) => entry.model)
        .filter((card) => card.kind === actionKind),
    [actionKind, enabledModelCatalog],
  );
  const selectedCatalogEntry = useMemo(
    () =>
      isCustom
        ? undefined
        : enabledModelCatalog.find((entry) => entry.model.id === modelId),
    [enabledModelCatalog, isCustom, modelId],
  );
  const modelUnavailable = !isCustom && !selectedCatalogEntry;
  const modelUnavailableReason = "No connected provider or executable route for this model. Connect a provider or choose an available model.";
  const unavailableParameterIds = useMemo(
    () => new Set(selectedCatalogEntry?.unavailableParameterIds ?? []),
    [selectedCatalogEntry?.unavailableParameterIds],
  );
  const selectedModel = useMemo<ModelCard | undefined>(
    // For custom actions, fall back to `undefined` rather than the
    // first image model card — otherwise the picker chip shows
    // "Nano Banana 2" on a grid-split badge because the .find()
    // returned nothing and `?? availableModels[0]` picked a random
    // image model. Custom actions have their own name source
    // (`customDef.name`) — see modelDisplay below.
    () =>
      isCustom
        ? undefined
        : (availableModels.find((card) => card.id === modelId) ??
          MODEL_CARDS.find((card) => card.id === modelId) ??
          availableModels[0]),
    [availableModels, modelId, isCustom],
  );
  const selectedModelRoute = useMemo(() => {
    if (!selectedCatalogEntry?.routes?.length)
      return selectedCatalogEntry?.selectedRoute;
    const requestedParameterIds = activeModelParameterIds(modelParams);
    return selectedCatalogEntry.routes.find((route) =>
      modelRouteSupportsParameters(route, requestedParameterIds),
    );
  }, [modelParams, selectedCatalogEntry]);
  useEffect(() => {
    if (!selectedModel) return;
    setModelParams((current) => {
      const next = normalizeModelParametersForCard(selectedModel, current);
      for (const parameterId of unavailableParameterIds)
        delete next[parameterId];
      const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
      return [...keys].every((key) => current[key] === next[key])
        ? current
        : next;
    });
  }, [selectedModel, unavailableParameterIds]);
  // A card that declares `musicInput` is one that takes lyrics, and says where they go. This
  // read `selectedModel?.task === 'music-generation'` until that field was removed: producing one
  // class of output is one action, so speech and music are both audio and what separates them is
  // this parameter. The textarea below already read `musicInput.maxLyricsCharacters`, so the flag
  // and the declaration were two names for one fact -- and they disagreed, because `lyria-3-pro`
  // was tagged music while declaring no lyrics input, which drew it a box that went nowhere.
  const isMusicModel = Boolean(selectedModel?.musicInput);
  const storedPluginBinding = data.pluginBinding as
    ExecutablePluginBinding | undefined;
  const routePluginBinding =
    preferredModelRoutePluginBinding(selectedModelRoute);
  const resolvedPluginBinding = resolveModelProjectorBinding(
    storedPluginBinding,
    routePluginBinding,
  );
  const effectivePluginBinding = resolvedPluginBinding.binding;
  const currentCustomPluginBinding = customDef?.pluginBinding;
  const customActionDefinitionUpdated =
    isCustom &&
    data.actionType === actionType &&
    Boolean(currentCustomPluginBinding) &&
    !executablePluginBindingsMatch(
      storedPluginBinding,
      currentCustomPluginBinding,
    );

  const modelDisplay = isCustom
    ? (customDef?.name ?? customActionId ?? "Custom action")
    : (selectedModel?.name ?? modelId);
  const countValue = Number(
    (isCustom ? customActionParams.count : modelParams.count) ?? 1,
  );
  const modelPickerLabel = customActionOffline
    ? RUNTIME_OFFLINE_TOOLTIP
    : modelDisplay;
  const checkpointRunLabel = customActionDefinitionUpdated
    ? ACTION_DEFINITION_UPDATED_RUN_LABEL
    : customActionOffline
      ? RUNTIME_OFFLINE_TOOLTIP
      : "Run again with current parameters";
  const panelRunLabel = customActionDefinitionUpdated
    ? ACTION_DEFINITION_UPDATED_RUN_LABEL
    : customActionOffline
      ? RUNTIME_OFFLINE_TOOLTIP
      : "Run action";

  // Single derivation — all per-modality questions read fields off `cap`.
  // See packages/shared-types/src/model-capabilities.ts.
  const cap = useMemo(
    () =>
      customDef
        ? capabilityFromCustom(customDef)
        : selectedModel
          ? capability(selectedModel)
          : null,
    [customDef, selectedModel],
  );
  const acceptsTextRef = cap?.ref.text.accepts ?? false;
  const acceptsImageRef = cap?.ref.image.accepts ?? false;
  const acceptsVideoRef = cap?.ref.video.accepts ?? false;
  const acceptsAudioRef = cap?.ref.audio.accepts ?? false;
  const acceptsAnyRef =
    acceptsTextRef || acceptsImageRef || acceptsVideoRef || acceptsAudioRef;
  const isStartEnd = cap?.ref.image.isStartEnd ?? false;
  const isKeyframePresentation =
    selectedModel?.input.presentation?.type === "keyframes";
  const isContinuationPresentation =
    selectedModel?.input.presentation?.type === "video-continuation";
  const keyframeLimit = cap?.ref.image.max ?? 0;
  const continuationVideoMin = cap?.ref.video.min ?? 1;
  const continuationVideoLimit = cap?.ref.video.max ?? 1;
  const continuationVideoConstraints = cap?.ref.video.constraints;
  const continuationVideoSummary =
    continuationVideoLimit === 1
      ? [
          continuationVideoConstraints?.fileExtensions
            ?.map((extension) => extension.toUpperCase())
            .join("/"),
          continuationVideoConstraints?.maxDurationMs
            ? `up to ${continuationVideoConstraints.maxDurationMs / 1000}s`
            : undefined,
          continuationVideoConstraints?.maxBytes
            ? `${Math.round(continuationVideoConstraints.maxBytes / (1024 * 1024))} MB`
            : undefined,
        ]
          .filter(Boolean)
          .join(" · ")
      : [
          `${continuationVideoMin}–${continuationVideoLimit} videos`,
          cap?.ref.video.maxTotalDurationMs
            ? `up to ${cap.ref.video.maxTotalDurationMs / 1000}s total`
            : undefined,
        ]
          .filter(Boolean)
          .join(" · ");
  const keyframeFrameRate =
    selectedModel?.input.presentation?.type === "keyframes"
      ? (selectedModel.input.presentation.frameRate ?? 24)
      : 24;
  const keyframeDurationSeconds = (() => {
    const value = Number(modelParams.duration);
    return Number.isFinite(value) && value > 0 ? value : 5;
  })();
  const keyframeLastFrame = Math.round(
    keyframeDurationSeconds * keyframeFrameRate,
  );
  const keyframeTimingCustomized =
    modelParams[KEYFRAME_TIMING_CUSTOMIZED_PARAM] === true;

  const resolveTextRef = useCallback(
    (
      node: { type?: string; data?: Record<string, unknown> } | undefined,
    ): string | undefined => {
      if (!node || !cap || node.type !== "text" || !cap.ref.text.accepts)
        return undefined;
      const raw = node.data?.content ?? node.data?.prompt ?? node.data?.label;
      return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
    },
    [cap],
  );

  // Does `node` have a modality this action accepts? Availability is
  // resolved from its stable Project Asset id by the Host at run time.
  const hasCompatibleModality = useCallback(
    (
      node: { type?: string; data?: Record<string, unknown> } | undefined,
    ): boolean => {
      if (!node || !cap) return false;
      const t = referenceModality(node);
      return t ? cap.ref[t].accepts : false;
    },
    [cap],
  );

  // Attached node IDs = incoming edges whose source has a compatible modality,
  // including drafts (empty src, will materialize when Build runs).
  const nativeInputKey = nativeDraft?.projection ? JSON.stringify([nativeDraft.projection.revision.persistentInputRefs, nativeDraft.projection.revision.state.contentParts]) : null;
  const attachedNodeIds = useMemo(() => {
    if (nativeDraft?.projection) {
      const nodes = getNodes();
      const revision = nativeDraft.projection.revision;
      return (isCustom ? revision.persistentInputRefs : modelInputRefsInPromptOrder(revision.state, revision.persistentInputRefs)).flatMap((ref) => {
        if (!("kind" in ref.target) || ref.target.kind !== "media") return [];
        const assetId = ref.target.projectAssetId;
        const node = nodes.find((candidate) => referenceAssetId(candidate) === assetId);
        return node ? [node.id] : [];
      });
    }
    return connectedEdges
      .filter((e) => e.target === id)
      .map((e) => getNode(e.source))
      .filter(
        (n): n is NonNullable<typeof n> => !!n && hasCompatibleModality(n),
      )
      .map((n) => n.id);
  }, [connectedEdges, id, getNode, getNodes, hasCompatibleModality, nativeInputKey, isCustom]);

  const refNodeIds = useMemo(() => {
    const order = Array.isArray(data.referenceImageOrder)
      ? (data.referenceImageOrder as string[])
      : [];
    const attachedSet = new Set(attachedNodeIds);
    const ordered = order.filter((nid) => attachedSet.has(nid));
    const seen = new Set(ordered);
    const extras = attachedNodeIds.filter((nid) => !seen.has(nid));
    return [...ordered, ...extras];
  }, [attachedNodeIds, data.referenceImageOrder]);
  const keyframeInputs = useMemo(() => {
    const before = nativeDraft?.projection?.revision;
    return new Map(before && !isCustom ? modelInputRefsInPromptOrder(before.state, before.persistentInputRefs)
      .filter(ref => ref.slot === "image" && "kind" in ref.target && ref.target.kind === "media")
      .map(ref => [JSON.stringify([ref.slot, ref.itemKey ?? null]), ref]) : []);
  }, [nativeInputKey, isCustom]);
  const keyframeKeys = useMemo(() => nativeDraft ? [...keyframeInputs.keys()] : refNodeIds, [nativeDraft, keyframeInputs, refNodeIds]);
  const keyframeAssetReference = (key: string) => {
    const input = keyframeInputs.get(key);
    return input && "kind" in input.target && input.target.kind === "media" ? { projectId, assetId: input.target.projectAssetId } : undefined;
  };
  const keyframeFrames = useMemo(
    () =>
      keyframeFrameIndices(
        modelParams[KEYFRAME_FRAME_INDICES_PARAM],
        keyframeKeys.length,
        keyframeLastFrame,
        keyframeTimingCustomized,
      ),
    [
      keyframeLastFrame,
      keyframeTimingCustomized,
      modelParams,
      keyframeKeys.length,
    ],
  );

  // Group attached refs by kind once — used by the model-compat check below.
  const refKindCounts = useMemo(() => {
    const byKind: Record<Modality, number> = {
      text: 0,
      image: 0,
      video: 0,
      audio: 0,
      model: 0,
    };
    if (nativeDraft?.projection) {
      for (const ref of nativeDraft.projection.revision.persistentInputRefs) {
        const kind = ref.slot === "startFrame" || ref.slot === "endFrame" ? "image" : ref.slot;
        if ("kind" in ref.target && ref.target.kind === "media" && (kind === "image" || kind === "video" || kind === "audio" || kind === "model")) byKind[kind] += 1;
      }
      return byKind;
    }
    for (const nid of refNodeIds) {
      const n = getNode(nid);
      const t = n ? referenceModality(n) : undefined;
      if (t) byKind[t] += 1;
    }
    return byKind;
  }, [refNodeIds, getNode, nativeInputKey]);

  const referenceValidationError = useMemo(() => {
    if (!cap) return null;
    const validationTarget = selectedModel ?? cap;
    const activeParams = isCustom ? customActionParams : modelParams;
    const countError = validateRefs(validationTarget, refKindCounts, {
      modelParams: activeParams,
    });
    if (countError) return countError;
    const references = refNodeIds
      .map((nodeId) => getNode(nodeId))
      .filter((node): node is NonNullable<typeof node> => !!node)
      .map(referenceMediaMetadata)
      .filter((metadata): metadata is ReferenceMediaMetadata => !!metadata);
    return validateReferenceMedia(validationTarget, references, {
      modelParams: activeParams,
    });
  }, [
    cap,
    customActionParams,
    getNode,
    isCustom,
    modelParams,
    refKindCounts,
    refNodeIds,
    selectedModel,
  ]);

  const compatibleModelIds = useMemo(
    () =>
      new Set(
        listCompatibleModelCatalogEntries({
          outputKind: actionKind,
          referenceCounts: refKindCounts,
          enforceMinimums: false,
          models: enabledModelCatalog.map((entry) => entry.model),
        }).map((entry) => entry.model.id),
      ),
    [actionKind, enabledModelCatalog, refKindCounts],
  );

  // Whether `card` can consume the currently attached refs as-is. The UI
  // sees only candidate IDs returned by the catalog anti-corruption layer.
  const isModelCompatibleWithRefs = useCallback(
    (card: ModelCard): boolean => {
      return compatibleModelIds.has(card.id);
    },
    [compatibleModelIds],
  );

  const compatibleAvailableModels = useMemo(
    () =>
      refNodeIds.length === 0
        ? availableModels
        : availableModels.filter(isModelCompatibleWithRefs),
    [availableModels, isModelCompatibleWithRefs, refNodeIds.length],
  );

  const generationChoices = useMemo(
    () =>
      listGenerationActionChoices({
        outputKind: actionKind,
        models: compatibleAvailableModels,
        customActions,
        referenceCounts: refKindCounts,
      }).filter((choice) => !nativeDraft || (isCustom ? choice.kind === "action" && choice.id === customActionId : choice.kind === "model")),
    [actionKind, compatibleAvailableModels, customActions, refKindCounts, nativeDraft, isCustom, customActionId],
  );

  const clearAllRefs = useCallback(() => {
    const edgeIds = connectedEdges
      .filter((e) => e.target === id)
      .map((e) => e.id);
    if (edgeIds.length > 0) {
      setEdges((eds) => eds.filter((e) => !edgeIds.includes(e.id)));
      if (loroSync) {
        edgeIds.forEach((eid) => loroSync.removeEdge(eid));
      }
    }
  }, [id, connectedEdges, setEdges, loroSync]);

  // Read natural dims from an image/video node. Videos store width/height too.
  const getNodeNaturalDims = useCallback(
    (nodeId?: string): { w: number; h: number } | null => {
      if (!nodeId) return null;
      const n = getNode(nodeId);
      if (!n) return null;
      const w = Number(n.data?.naturalWidth) || 0;
      const h = Number(n.data?.naturalHeight) || 0;
      if (!w || !h) return null;
      return { w, h };
    },
    [getNode],
  );

  // Default the model's aspect_ratio from the start reference whenever it
  // changes. Kling i2v / Kling 3 / Seedance i2v all derive output ratio from
  // the source image; pre-selecting the nearest option keeps the pending-node
  // placeholder honest and gives the user a chance to override before submit.
  const startRefId = refNodeIds[0];
  useEffect(() => {
    const dims = getNodeNaturalDims(startRefId);
    if (!dims) return;
    const snap = snapAspectRatio(modelId, dims.w, dims.h);
    if (!snap) return;
    const currentValue = modelParams[snap.paramId];
    if (currentValue === snap.value) return;
    const next = { ...modelParams, [snap.paramId]: snap.value } as ModelParams;
    setModelParams(next);
    syncModelState(modelId, next);
    // Only re-run when the start ref itself changes (or model switches), not on
    // every modelParams update — otherwise user overrides would be clobbered.
  }, [startRefId, modelId]);

  // Endpoint mismatch warning shared by fixed start/end and expandable
  // keyframe presentations. In keyframe mode the final reference is End.
  const startEndMismatch = useMemo(() => {
    if (!isStartEnd && !isKeyframePresentation) return null;
    const s = getNodeNaturalDims(refNodeIds[0]);
    const endIndex = isKeyframePresentation ? refNodeIds.length - 1 : 1;
    const e = getNodeNaturalDims(refNodeIds[endIndex]);
    if (!s || !e) return null;
    // 3% tolerance on log-ratio difference — covers pixel rounding.
    return Math.abs(Math.log(s.w / s.h / (e.w / e.h))) > 0.03 ? { s, e } : null;
  }, [isStartEnd, isKeyframePresentation, refNodeIds, getNodeNaturalDims]);

  const persistRefOrder = useCallback(
    (next: string[]) => {
      // Single writer for referenceImageOrder — dedup here so no duplicate
      // ever lands in Loro. Order preserved (first occurrence wins).
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const nid of next) {
        if (!nid || seen.has(nid)) continue;
        seen.add(nid);
        cleaned.push(nid);
      }
      if (nativeDraft) {
        const orderedAssets = cleaned.flatMap((nodeId) => { const node = getNode(nodeId); return node ? [referenceAssetId(node)] : []; }).filter(Boolean);
        void nativeDraft.editDraft((before) => ({
          state: isCustom ? before.state : reorderModelMediaInputs(before.state, before.persistentInputRefs, orderedAssets as string[]),
          persistentInputRefs: isCustom ? reorderActionCardInputs(before.persistentInputRefs, (orderedAssets as string[]).map(projectAssetId => ({ kind: "media", projectAssetId }))) : before.persistentInputRefs,
        })).catch((error) => setError(error instanceof Error ? error.message : String(error)));
        return;
      }
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id
            ? { ...n, data: { ...n.data, referenceImageOrder: cleaned } }
            : n,
        ),
      );
      if (loroSync) {
        loroSync.updateNode(id, { data: { referenceImageOrder: cleaned } });
      }
    },
    [id, setNodes, loroSync, nativeDraft, getNode, isCustom],
  );

  const persistKeyframeFrames = useCallback(
    (next: number[], customized = keyframeTimingCustomized) => {
      const serialized = JSON.stringify(next);
      const nextParams = {
        ...modelParams,
        [KEYFRAME_FRAME_INDICES_PARAM]: serialized,
        [KEYFRAME_TIMING_CUSTOMIZED_PARAM]: customized,
      };
      setModelParams(nextParams);
      if (nativeDraft) {
        const expectedKeys = JSON.stringify(keyframeKeys);
        void nativeDraft.editDraft(before => {
          const currentKeys = modelInputRefsInPromptOrder(before.state, before.persistentInputRefs)
            .filter(ref => ref.slot === "image" && "kind" in ref.target && ref.target.kind === "media")
            .map(ref => JSON.stringify([ref.slot, ref.itemKey ?? null]));
          if (JSON.stringify(currentKeys) !== expectedKeys || next.length !== currentKeys.length) throw new Error("The keyframe sequence changed. Read the draft again before editing timing.");
          return { state: { ...before.state, params: {
            ...(before.state.params && typeof before.state.params === "object" && !Array.isArray(before.state.params) ? before.state.params : {}),
            [KEYFRAME_FRAME_INDICES_PARAM]: serialized, [KEYFRAME_TIMING_CUSTOMIZED_PARAM]: customized,
          } }, persistentInputRefs: before.persistentInputRefs };
        }).catch((error) => setError(error instanceof Error ? error.message : String(error)));
        return;
      }
      setNodes((nodes) =>
        nodes.map((node) =>
          node.id === id
            ? { ...node, data: { ...node.data, modelParams: nextParams } }
            : node,
        ),
      );
      if (loroSync) {
        loroSync.updateNode(id, { data: { modelParams: nextParams } });
      }
    },
    [id, keyframeTimingCustomized, loroSync, modelParams, setNodes, nativeDraft, keyframeKeys],
  );

  const addNativeMediaReference = useCallback((sourceNodeId: string, endpoint?: "start" | "end") => {
    if (!nativeDraft) return;
    const node = getNode(sourceNodeId);
    if (isCustom && customDef?.generator) {
      if (node?.type === "text" && node.data?.documentRevision === undefined && typeof node.data?.content === "string") {
        const text = node.data.content;
        void nativeDraft.edit((state) => ({ ...state, prompt: `${state.prompt ?? ""}\n\n${text}` })).catch((error) => setError(String(error)));
        return;
      }
      try {
        const asset = canvasAssetRevision(node);
        const kind = node && referenceModality(node);
        if (!asset || !kind) throw new Error("This reference needs an applied Asset.");
        const placement = loroSync?.doc?.getMap("nodes").get(id) as { canvasId?: string } | undefined;
        void nativeDraft.prepare((before, definition) => ({
          ...appendActionCardInput(before, customDef.generator!, definition, asset, kind),
          canvasInputConnections: [{ canvasId: placement?.canvasId ?? "main", sourceNodeId, targetNodeId: id, asset }],
        })).catch((error) => setError(error instanceof Error ? error.message : String(error)));
      } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
      return;
    }
    if (node?.type === "text") {
      try {
        const edit = createModelTextReferenceEdit(node, typeof node.data?.label === "string" ? node.data.label : "Text");
        const asset = canvasAssetRevision(node);
        const placement = loroSync?.doc?.getMap("nodes").get(id) as { canvasId?: string } | undefined;
        void nativeDraft.editDraft((before) => ({ ...edit(before), ...(asset ? {
          canvasInputConnections: [{ canvasId: placement?.canvasId ?? "main", sourceNodeId, targetNodeId: id, asset }],
        } : {}) })).catch((error) => setError(error instanceof Error ? error.message : String(error)));
      } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
      return;
    }
    const assetId = node && referenceAssetId(node);
    const modality = node && referenceModality(node);
    if (!assetId || !modality || modality === "text") {
      setError("This reference needs an applied media Asset before it can be attached.");
      return;
    }
    const placement = loroSync?.doc?.getMap("nodes").get(id) as { canvasId?: string } | undefined;
    void nativeDraft.editDraft((before) => {
      const model = enabledModelCatalog.find((entry) => entry.model.id === before.state.modelId)?.model;
      if (model?.input.presentation?.type === "keyframes") {
        if (modality !== "image") throw new Error("Keyframes require image Assets.");
        return { ...editModelKeyframes(before, model, { type: "add", projectAssetId: assetId, position: endpoint ?? "append" }),
          canvasInputConnections: [{ canvasId: placement?.canvasId ?? "main", sourceNodeId, targetNodeId: id, asset: { kind: "media" as const, projectAssetId: assetId } }] };
      }
      const refs = before.persistentInputRefs;
      const existing = !endpoint && refs.find((ref) => "kind" in ref.target && ref.target.kind === "media" && ref.target.projectAssetId === assetId);
      const added = existing || createModelMediaInput({
        modelId: before.state.modelId,
        model: enabledModelCatalog.find((entry) => entry.model.id === before.state.modelId)?.model,
        inputs: refs, kind: modality, projectAssetId: assetId, endpoint,
      });
      const next = endpoint ? refs.filter((ref) => ref.slot !== added.slot) : refs;
      const persistentInputRefs = existing ? refs : endpoint === "start" ? [added, ...next] : [...next, added];
      let state = before.state;
      {
        const parts = modelPromptPartsWithInputs(state, refs).filter((part) => !endpoint || part.type !== "input" || part.slot !== added.slot);
        // Picking an already attached Asset does not invent another occurrence.
        if (!existing || !parts.some((part) => part.type === "input" && part.slot === added.slot && part.itemKey === added.itemKey)) {
          parts.push({ type: "input", slot: added.slot, ...(added.itemKey ? { itemKey: added.itemKey } : {}), label: "" });
        }
        state = withModelPromptParts(state, parts);
      }
      return { state, persistentInputRefs, canvasInputConnections: [{ canvasId: placement?.canvasId ?? "main", sourceNodeId, targetNodeId: id, asset: { kind: "media" as const, projectAssetId: assetId } }] };
    }).catch((error) => setError(error instanceof Error ? error.message : String(error)));
  }, [nativeDraft, getNode, loroSync, id, enabledModelCatalog, isCustom, customDef]);

  const addRefNode = useCallback(
    (sourceNodeId: string) => {
      if (nativeDraft) { addNativeMediaReference(sourceNodeId); return; }
      // Deterministic edgeId means re-adding the same source is a no-op
      // *iff* we early-return when the edge already exists. Without this
      // guard reactflow's setEdges still grows the array (it dedups on
      // change-set, not against current state) and Loro overwrites the
      // entry — but transient duplicates flicker through React Flow.
      const edgeId = `${sourceNodeId}-${id}`;
      if (connectedEdges.some((e) => e.id === edgeId)) return;
      addEdges({
        id: edgeId,
        source: sourceNodeId,
        target: id,
        type: "default",
      });
      if (loroSync) {
        loroSync.addEdge(edgeId, {
          id: edgeId,
          source: sourceNodeId,
          target: id,
          type: "default",
        });
      }
    },
    [id, connectedEdges, addEdges, loroSync, nativeDraft, addNativeMediaReference],
  );

  const removeRefNode = useCallback(
    (sourceNodeId: string, endpointSlot?: string) => {
      if (nativeDraft) {
        const source = getNode(sourceNodeId);
        const assetId = source && referenceAssetId(source);
        if (!assetId) return;
        const removed = nativeDraft.projection?.revision.persistentInputRefs.filter((ref) => (!endpointSlot || ref.slot === endpointSlot) && "kind" in ref.target && ref.target.kind === "media" && ref.target.projectAssetId === assetId) ?? [];
        void nativeDraft.edit((state) => isCustom ? state : removed.reduce((next, ref) => removeModelPromptInput(next, ref), state), (refs) => refs.filter((ref) => !removed.some((item) => item.slot === ref.slot && item.itemKey === ref.itemKey)))
          .catch((error) => setError(error instanceof Error ? error.message : String(error)));
        return;
      }
      const edgeIds = connectedEdges
        .filter((e) => e.target === id && e.source === sourceNodeId)
        .map((e) => e.id);
      if (edgeIds.length === 0) return;
      setEdges((eds) => eds.filter((e) => !edgeIds.includes(e.id)));
      if (loroSync) {
        edgeIds.forEach((eid) => loroSync.removeEdge(eid));
      }
    },
    [id, connectedEdges, setEdges, loroSync, nativeDraft, getNode, isCustom],
  );

  const removeContinuationRef = useCallback(
    (sourceNodeId: string) => {
      persistRefOrder(refNodeIds.filter((nodeId) => nodeId !== sourceNodeId));
      removeRefNode(sourceNodeId);
    },
    [persistRefOrder, refNodeIds, removeRefNode],
  );

  const removeKeyframeRef = useCallback(
    (sourceNodeId: string) => {
      if (nativeDraft) {
        const input = keyframeInputs.get(sourceNodeId);
        const projectAssetId = input && "kind" in input.target && input.target.kind === "media" ? input.target.projectAssetId : undefined;
        if (!projectAssetId) return;
        void nativeDraft.editDraft(before => {
          const model = enabledModelCatalog.find(entry => entry.model.id === before.state.modelId)?.model;
          if (!model) throw new Error("The Model is unavailable. Read the draft again.");
          return editModelKeyframes(before, model, { type: "remove", projectAssetId, input });
        }).catch(error => setError(error instanceof Error ? error.message : String(error)));
        return;
      }
      const removedIndex = refNodeIds.indexOf(sourceNodeId);
      if (removedIndex < 0) return;
      const nextOrder = refNodeIds.filter((nodeId) => nodeId !== sourceNodeId);
      let nextFrames = keyframeFrames.filter(
        (_, index) => index !== removedIndex,
      );
      if (keyframeTimingCustomized) {
        if (nextFrames.length > 0) nextFrames[0] = 0;
        if (nextFrames.length > 1)
          nextFrames[nextFrames.length - 1] = keyframeLastFrame;
      } else {
        nextFrames = evenlySpacedFrameIndices(
          nextOrder.length,
          keyframeLastFrame,
        );
      }
      persistRefOrder(nextOrder);
      persistKeyframeFrames(nextFrames);
      removeRefNode(sourceNodeId);
    },
    [
      nativeDraft, keyframeInputs, enabledModelCatalog,
      keyframeFrames,
      keyframeLastFrame,
      keyframeTimingCustomized,
      persistKeyframeFrames,
      persistRefOrder,
      refNodeIds,
      removeRefNode,
    ],
  );

  // One-shot cleanup for pre-existing dirty data:
  //   1. referenceImageOrder may have duplicate ids (from before
  //      persistRefOrder dedup'd).
  //   2. Loro may have parallel incoming edges (drag-connect + @-mention
  //      created two edges with different ids for the same source-target,
  //      from before ProjectEditor.onConnect used the canonical id).
  // Rewrite via the canonical writers; no-op for clean data.
  useEffect(() => {
    const order = Array.isArray(data.referenceImageOrder)
      ? (data.referenceImageOrder as string[])
      : null;
    if (order && order.length > 0) {
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const nid of order) {
        if (!nid || seen.has(nid)) continue;
        seen.add(nid);
        cleaned.push(nid);
      }
      if (cleaned.length !== order.length) persistRefOrder(cleaned);
    }

    const incoming = connectedEdges.filter((e) => e.target === id);
    const bySource = new Map<string, typeof incoming>();
    for (const e of incoming) {
      const list = bySource.get(e.source) ?? [];
      list.push(e);
      bySource.set(e.source, list);
    }
    const stale: string[] = [];
    for (const [, list] of bySource) {
      if (list.length <= 1) continue;
      // Prefer the canonical id; if absent, keep the first.
      const canonical = `${list[0].source}-${id}`;
      const keeper = list.find((e) => e.id === canonical) ?? list[0];
      for (const e of list) {
        if (e.id !== keeper.id) stale.push(e.id);
      }
    }
    if (stale.length > 0) {
      setEdges((eds) => eds.filter((e) => !stale.includes(e.id)));
      if (loroSync) {
        stale.forEach((eid) => loroSync.removeEdge(eid));
      }
    }
  }, []);
  // Drafts qualify (src empty for now — cascade runner waits for them before
  // adopting this action). Cycle guard: exclude anything that transitively
  // depends on this action so users can't pick a descendant.
  const shouldComputeRefPickerCandidates =
    showRefPicker || refPickerTarget !== null;
  const refPickerCandidates = useMemo(() => {
    if (!shouldComputeRefPickerCandidates) return [];
    const attached = new Set(refNodeIds);
    const downstream = new Set<string>([id]);
    {
      const queue: string[] = [id];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        for (const e of getEdges()) {
          if (e.source === cur && !downstream.has(e.target)) {
            downstream.add(e.target);
            queue.push(e.target);
          }
        }
      }
    }
    return getNodes().filter((n) => {
      if (downstream.has(n.id)) return false;
      const t = referenceModality(n);
      if (attached.has(n.id)) return false;
      if (t === "text") {
        const reference = n.data?.documentRevision as { documentAssetId?: unknown; revisionId?: unknown } | undefined;
        if (reference && isCustom && !customDef?.generator?.inputSlots.text) return false;
        const alreadyAttached = reference && nativeDraft?.projection?.revision.persistentInputRefs.some(ref =>
          "kind" in ref.target && ref.target.kind === "document" &&
          ref.target.documentAssetId === reference.documentAssetId && ref.target.revisionId === reference.revisionId);
        return acceptsTextRef && !alreadyAttached;
      }
      if (t === "image") return acceptsImageRef;
      if (t === "video") return acceptsVideoRef;
      if (t === "audio") return acceptsAudioRef;
      return false;
    });
  }, [
    shouldComputeRefPickerCandidates,
    isCustom,
    customDef,
    nativeInputKey,
    refNodeIds,
    getNodes,
    getEdges,
    connectedEdges,
    id,
    acceptsTextRef,
    acceptsImageRef,
    acceptsVideoRef,
    acceptsAudioRef,
  ]);

  // Attach a picked canvas node into the target slot. Keyframe append means
  // "append a middle frame": insert immediately before the fixed End slot.
  const attachRefToSlot = useCallback(
    (sourceNodeId: string, target: "append" | "start" | "end") => {
      if (
        target === "append" &&
        isKeyframePresentation &&
        keyframeKeys.length >= keyframeLimit
      )
        return;
      if (
        target === "append" &&
        isContinuationPresentation &&
        refNodeIds.length >= continuationVideoLimit
      )
        return;
      if (nativeDraft) {
        addNativeMediaReference(sourceNodeId, target === "append" ? undefined : target);
        return;
      }
      addRefNode(sourceNodeId);
      const existing = Array.isArray(data.referenceImageOrder)
        ? [...(data.referenceImageOrder as string[])]
        : [...refNodeIds];
      if (target === "append") {
        if (isContinuationPresentation) {
          persistRefOrder([...existing, sourceNodeId]);
          return;
        }
        if (!isKeyframePresentation) return;
        const insertion = planKeyframeInsertion(
          keyframeFrames,
          keyframeLastFrame,
          keyframeTimingCustomized,
        );
        const insertionIndex = insertion.insertionIndex;
        existing.splice(insertionIndex, 0, sourceNodeId);
        persistRefOrder(existing);
        persistKeyframeFrames(insertion.frameIndices, keyframeTimingCustomized);
        return;
      }
      if (target === "end" && isKeyframePresentation && existing.length === 0)
        return;
      const slotIdx =
        target === "start" ? 0 : isKeyframePresentation ? existing.length : 1;
      while (existing.length <= slotIdx) existing.push("");
      existing[slotIdx] = sourceNodeId;
      persistRefOrder(existing.filter(Boolean));
      if (isKeyframePresentation) {
        persistKeyframeFrames(
          target === "start" ? [0] : [0, keyframeLastFrame],
          false,
        );
      }
    },
    [
      addRefNode,
      continuationVideoLimit,
      data.referenceImageOrder,
      isContinuationPresentation,
      isKeyframePresentation,
      keyframeFrames,
      keyframeLastFrame,
      keyframeLimit, keyframeKeys.length,
      keyframeTimingCustomized,
      persistKeyframeFrames,
      refNodeIds,
      persistRefOrder,
      nativeDraft,
      addNativeMediaReference,
    ],
  );

  // Resolve ref node -> current-Host Project Asset preview URL. Used for
  // @-mention thumbnails, start/end slot previews, and the generic ref grid.
  // URLs are read-only projections; the node keeps only stable Asset identity.
  const [refThumbByNodeId, setRefThumbByNodeId] = useState<Map<string, string>>(
    () => new Map(),
  );
  useEffect(() => {
    if (refNodeIds.length === 0) {
      setRefThumbByNodeId(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      const next = new Map<string, string>();
      for (const nid of refNodeIds) {
        const n = getNode(nid);
        if (!n) continue;
        const assetId = referenceAssetId(n);
        if (!assetId) continue;
        try {
          const asset = await getAsset(projectId, assetId);
          const previewUrl = assetThumbnailImageUrl(asset);
          if (previewUrl) next.set(nid, previewUrl);
        } catch {
          // asset not yet available; skip
        }
      }
      if (!cancelled) setRefThumbByNodeId(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [refNodeIds, getNode, projectId]);

  const resolveRefSrc = useCallback(
    (
      node:
        | { id: string; type?: string; data?: Record<string, unknown> }
        | undefined,
    ): string | undefined => {
      if (!node || !cap) return undefined;
      const modality = referenceModality(node);
      if (!modality || !cap.ref[modality].accepts) return undefined;
      return refThumbByNodeId.get(node.id);
    },
    [cap, refThumbByNodeId],
  );

  // @ mention: only attached reference images, with positional labels "Image 1", "Image 2"...
  const mentionableNodes = useMemo(() => {
    return refNodeIds.map((nodeId, i) => {
      const node = getNode(nodeId);
      const type = (node ? referenceModality(node) : undefined) || "image";
      const prefix =
        type === "text"
          ? "Text"
          : type === "video"
            ? "Video"
            : type === "audio"
              ? "Audio"
              : "Image";
      return {
        id: nodeId,
        type,
        label: `${prefix} ${i + 1}`,
        thumbnail: refThumbByNodeId.get(nodeId),
      };
    });
  }, [refNodeIds, getNode, refThumbByNodeId]);

  const filteredMentionNodes = useMemo(() => {
    if (!mentionQuery) return mentionableNodes;
    return mentionableNodes.filter(
      (n) =>
        n.label.toLowerCase().includes(mentionQuery) ||
        n.id.toLowerCase().includes(mentionQuery),
    );
  }, [mentionableNodes, mentionQuery]);

  // Render content string → HTML with inline mention chips
  const contentToHtml = useCallback(
    (raw: string) => {
      if (!raw) return "";
      const MENTION_RE = /@\[([^\]]*)\]\(node:([^)]+)\)/g;
      return raw.replace(MENTION_RE, (_match, label, nodeId) => {
        const node = mentionableNodes.find((n) => n.id === nodeId);
        const src = node?.thumbnail;
        const resolvedUrl = src ? escapeHtmlAttribute(src) : undefined;
        const safeNodeId = escapeHtmlAttribute(nodeId);
        const safeLabel = escapeHtmlAttribute(label);
        if (resolvedUrl) {
          return `<span contenteditable="false" data-mention-id="${safeNodeId}" data-mention-label="${safeLabel}" aria-label="${safeLabel}" style="display:inline-block;vertical-align:middle;margin:0 2px;"><img src="${resolvedUrl}" style="height:20px;width:20px;border-radius:4px;object-fit:cover;display:block;" /></span>`;
        }
        return `<span contenteditable="false" data-mention-id="${safeNodeId}" data-mention-label="${safeLabel}" aria-label="${safeLabel}" style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:4px;margin:0 2px;font-size:8px;color:#94a3b8;vertical-align:middle;">${node?.type?.charAt(0).toUpperCase() || "?"}</span>`;
      });
    },
    [mentionableNodes],
  );

  // Read back HTML → content string
  const htmlToContent = useCallback((el: HTMLDivElement): string => {
    let result = "";
    el.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.textContent || "";
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const elem = node as HTMLElement;
        const mentionId = elem.getAttribute("data-mention-id");
        if (mentionId) {
          const label =
            elem.getAttribute("data-mention-label") ||
            elem.textContent ||
            mentionId;
          result += buildMention(label, mentionId);
        } else if (elem.tagName === "BR") {
          result += "\n";
        } else {
          const inner = htmlToContent(elem as HTMLDivElement);
          result += inner;
          if (elem.tagName === "DIV" || elem.tagName === "P") result += "\n";
        }
      }
    });
    return result;
  }, []);

  // Sync editor HTML when content changes externally
  const lastContentRef = useRef(content);
  useEffect(() => {
    if (editorRef.current && content !== lastContentRef.current) {
      replaceContentEditableHtmlPreservingFocus(
        editorRef.current,
        contentToHtml(content),
      );
      lastContentRef.current = content;
    }
  }, [content, contentToHtml]);

  // Init editor on mount
  useEffect(() => {
    if (editorRef.current && showPanel) {
      editorRef.current.innerHTML = contentToHtml(content);
      lastContentRef.current = content;
    }
  }, [showPanel]);

  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveNativePrompt = useCallback(async (raw: string) => {
    if (!nativeDraft) throw new Error("Native draft is unavailable.");
    return isCustom && customDef?.generator
      ? nativeDraft.prepare(createActionCardPromptEdit(raw, customDef.generator, getNode))
      : nativeDraft.editDraft(createModelPromptEdit(raw, getNode));
  }, [nativeDraft, getNode, isCustom, customDef]);

  const handleEditorInput = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const raw = htmlToContent(el);
    lastContentRef.current = raw;
    setContent(raw);

    // Debounce sync to Loro (300ms)
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      if (nativeDraft) {
        void saveNativePrompt(raw).catch((error) => setError(error instanceof Error ? error.message : String(error)));
        return;
      }
      setNodes((nds) =>
        nds.map((node) =>
          node.id === id
            ? { ...node, data: { ...node.data, content: raw } }
            : node,
        ),
      );
      if (loroSync) {
        loroSync.updateNode(id, { data: { content: raw } });
      }
    }, 300);

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (range.startContainer.nodeType !== Node.TEXT_NODE) {
      setShowMentionMenu(false);
      return;
    }
    const textBefore = (range.startContainer.textContent || "").slice(
      0,
      range.startOffset,
    );
    const atMatch = textBefore.match(/@(\w*)$/);
    if (atMatch) {
      setMentionQuery(atMatch[1].toLowerCase());
      setShowMentionMenu(true);
    } else {
      setShowMentionMenu(false);
    }
  }, [htmlToContent, id, setNodes, loroSync, nativeDraft, saveNativePrompt]);

  const insertMention = useCallback(
    (node: { id: string; label: string; src?: string }) => {
      const el = editorRef.current;
      if (!el) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (range.startContainer.nodeType === Node.TEXT_NODE) {
        const text = range.startContainer.textContent || "";
        const before = text.slice(0, range.startOffset);
        const atPos = before.lastIndexOf("@");
        if (atPos >= 0) {
          range.startContainer.textContent =
            text.slice(0, atPos) + text.slice(range.startOffset);
          range.setStart(range.startContainer, atPos);
          range.collapse(true);
        }
      }
      const mentionHtml = contentToHtml(buildMention(node.label, node.id));
      const temp = document.createElement("span");
      temp.innerHTML = mentionHtml + "&nbsp;";
      const frag = document.createDocumentFragment();
      let lastInserted: globalThis.Node | null = null;
      while (temp.firstChild) {
        lastInserted = temp.firstChild;
        frag.appendChild(temp.firstChild);
      }
      range.insertNode(frag);
      if (lastInserted) {
        const newRange = document.createRange();
        newRange.setStartAfter(lastInserted);
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
      }
      const raw = htmlToContent(el);
      lastContentRef.current = raw;
      setContent(raw);
      setShowMentionMenu(false);
      if (nativeDraft) {
        if (syncTimerRef.current) { clearTimeout(syncTimerRef.current); syncTimerRef.current = null; }
        void saveNativePrompt(raw).catch((error) => setError(error instanceof Error ? error.message : String(error)));
        return;
      }
      const edgeId = `${node.id}-${id}`;
      addEdges({ id: edgeId, source: node.id, target: id, type: "default" });
      if (loroSync) {
        loroSync.addEdge(edgeId, {
          id: edgeId,
          source: node.id,
          target: id,
          type: "default",
        });
      }
    },
    [contentToHtml, htmlToContent, id, addEdges, loroSync, nativeDraft, saveNativePrompt],
  );

  const mentionCombobox = useComboboxStore({
    value: mentionQuery,
    setValue: () => undefined,
    setSelectedValue: (selectedValue) => {
      const node = filteredMentionNodes.find(
        (candidate) => candidate.id === selectedValue,
      );
      if (node) insertMention(node);
    },
    focusLoop: true,
    focusWrap: true,
    orientation: "vertical",
  });

  useEffect(() => {
    if (!showMentionMenu || filteredMentionNodes.length === 0) {
      mentionCombobox.setActiveId(undefined);
      return;
    }
    mentionCombobox.setActiveId(
      actionMentionItemId(filteredMentionNodes[0].id),
    );
  }, [mentionCombobox, showMentionMenu, filteredMentionNodes]);

  const handleEditorKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!showMentionMenu || filteredMentionNodes.length === 0) return;

      handleMentionComboboxKeyDown(e, {
        store: mentionCombobox,
        items: filteredMentionNodes,
        getItemId: (node) => actionMentionItemId(node.id),
        onSelect: insertMention,
        onClose: () => setShowMentionMenu(false),
      });
    },
    [filteredMentionNodes, insertMention, mentionCombobox, showMentionMenu],
  );

  const syncModelState = useCallback(
    (
      nextModelId: string,
      nextParams: ModelParams,
      nextPluginBinding:
        ExecutablePluginBinding | undefined = effectivePluginBinding,
    ) => {
      if (nativeDraft) {
        void nativeDraft.edit({ modelId: nextModelId, params: nextParams }).catch((error) => setError(error instanceof Error ? error.message : String(error)));
        return;
      }
      setNodes((nds) =>
        nds.map((node) => {
          if (node.id === id) {
            return {
              ...node,
              data: {
                ...node.data,
                modelId: nextModelId,
                model: nextModelId,
                modelParams: nextParams,
                pluginBinding: nextPluginBinding,
              },
            };
          }
          return node;
        }),
      );
      if (loroSync) {
        loroSync.updateNode(id, {
          data: {
            modelId: nextModelId,
            model: nextModelId,
            modelParams: nextParams,
            pluginBinding: nextPluginBinding,
          },
        });
      }
    },
    [effectivePluginBinding, id, loroSync, setNodes, nativeDraft],
  );

  const syncActionState = useCallback(
    (nextData: Record<string, unknown>) => {
      // Native placements keep their Definition; model state is saved above.
      if (nativeDraft) return;
      setNodes((nodes) =>
        nodes.map((node) =>
          node.id === id
            ? { ...node, data: { ...node.data, ...nextData } }
            : node,
        ),
      );
      if (loroSync) {
        loroSync.updateNode(id, { data: nextData });
      }
    },
    [id, loroSync, setNodes, nativeDraft],
  );

  useEffect(() => {
    if (nativeDraft || !routePluginBinding || !resolvedPluginBinding.persistRouteBinding)
      return;
    syncModelState(modelId, modelParams, routePluginBinding);
  }, [
    modelId,
    modelParams,
    resolvedPluginBinding.persistRouteBinding,
    routePluginBinding,
    syncModelState,
    nativeDraft,
  ]);

  const handleModelChange = useCallback(
    async (nextId: string) => {
      const nextModel =
        availableModels.find((card) => card.id === nextId) ||
        MODEL_CARDS.find((card) => card.id === nextId) ||
        availableModels[0];
      if (
        nextModel &&
        refNodeIds.length > 0 &&
        !isModelCompatibleWithRefs(nextModel)
      ) {
        const ok = await confirm({
          title: `Switch to ${nextModel.name}?`,
          message: `This model can't use the ${refNodeIds.length} attached reference${refNodeIds.length === 1 ? "" : "s"}. Switching will detach them.`,
          confirmText: "Switch & clear",
          cancelText: "Keep current",
          destructive: true,
        });
        if (!ok) return;
        clearAllRefs();
      }
      const nextParams = { ...(nextModel?.defaultParams ?? {}) } as ModelParams;
      const resolvedId = nextModel?.id ?? nextId;
      const nextPluginBinding = preferredModelRoutePluginBinding(
        enabledModelCatalog.find((entry) => entry.model.id === resolvedId)
          ?.selectedRoute,
      );
      setModelId(resolvedId);
      setModelParams(nextParams);
      syncModelState(resolvedId, nextParams, nextPluginBinding);
    },
    [
      availableModels,
      enabledModelCatalog,
      refNodeIds.length,
      isModelCompatibleWithRefs,
      clearAllRefs,
      confirm,
      syncModelState,
    ],
  );

  const handleGenerationChoiceChange = useCallback(
    async (value: string) => {
      const choice = generationChoices.find(
        (candidate) => candidate.value === value,
      );
      if (!choice) return;
      if (choice.kind === "action") {
        const nextActionType = `custom:${choice.id}`;
        const nextParams = generationChoiceDefaults(choice.action);
        setActionType(nextActionType);
        setCustomActionParams(nextParams);
        setModelId("");
        setModelParams({});
        syncActionState({
          actionType: nextActionType,
          customActionId: choice.id,
          customActionParams: nextParams,
          modelId: undefined,
          model: undefined,
          modelParams: undefined,
          pluginBinding: choice.action.pluginBinding,
        });
        return;
      }

      await handleModelChange(choice.id);
      const nextActionType = `${choice.model.kind}-gen`;
      setActionType(nextActionType);
      setCustomActionParams({});
      syncActionState({
        actionType: nextActionType,
        customActionId: undefined,
        customActionParams: undefined,
      });
    },
    [generationChoices, handleModelChange, syncActionState],
  );

  const updateModelParam = useCallback(
    (paramId: string, value: string | number | boolean) => {
      if (isCustom) {
        const next = customDef
          ? applyModelParameterChange(
              {
                parameters: customDef.parameters,
                defaultParams: customActionDefaultParams(customDef),
                constraints: customDef.constraints,
              },
              customActionParams,
              paramId,
              value,
            )
          : { ...customActionParams, [paramId]: value };
        setCustomActionParams(next);
        if (nativeDraft) {
          void nativeDraft.edit(next).catch((error) => setError(error instanceof Error ? error.message : String(error)));
          return;
        }
        syncActionState({ customActionParams: next });
        return;
      }
      const next = applyModelParameterChange(
        selectedModel,
        modelParams,
        paramId,
        value,
      );
      if (isKeyframePresentation && paramId === "duration") {
        const nextDuration = Number(value);
        const nextLastFrame = Math.round(nextDuration * keyframeFrameRate);
        const nextFrames = keyframeFrameIndices(
          modelParams[KEYFRAME_FRAME_INDICES_PARAM],
          refNodeIds.length,
          nextLastFrame,
          keyframeTimingCustomized,
        );
        next[KEYFRAME_FRAME_INDICES_PARAM] = JSON.stringify(nextFrames);
        next[KEYFRAME_TIMING_CUSTOMIZED_PARAM] = keyframeTimingCustomized;
      }
      setModelParams(next);
      syncModelState(modelId, next);
    },
    [
      customActionParams,
      customDef,
      isCustom,
      isKeyframePresentation,
      keyframeFrameRate,
      keyframeTimingCustomized,
      modelId,
      modelParams,
      refNodeIds.length,
      selectedModel,
      syncActionState,
      syncModelState,
      nativeDraft,
    ],
  );

  const updateLyrics = useCallback(
    (nextLyrics: string) => {
      setLyrics(nextLyrics);
      if (nativeDraft) {
        void nativeDraft.edit({ lyrics: nextLyrics }).catch((error) => setError(error instanceof Error ? error.message : String(error)));
        return;
      }
      setNodes((nodes) =>
        nodes.map((node) =>
          node.id === id
            ? { ...node, data: { ...node.data, lyrics: nextLyrics } }
            : node,
        ),
      );
      if (loroSync) {
        loroSync.updateNode(id, { data: { lyrics: nextLyrics } });
      }
    },
    [id, setNodes, loroSync, nativeDraft],
  );

  // Sync content and label when data changes (from Loro or other sources)
  useEffect(() => {
    if (data.label) {
      setLabel((prev: string) => (prev !== data.label ? data.label : prev));
    }
    if (data.content !== undefined) {
      const cleaned = cleanContent(data.content);
      setContent((prev: string) => (prev !== cleaned ? cleaned : prev));
    }
    if (data.lyrics !== undefined) {
      const nextLyrics = typeof data.lyrics === "string" ? data.lyrics : "";
      setLyrics((prev) => (prev !== nextLyrics ? nextLyrics : prev));
    }
  }, [data.label, data.content, data.lyrics]);

  useEffect(() => {
    const incomingType = data.actionType || "image-gen";
    if (incomingType === lastIncomingActionType.current) return;
    lastIncomingActionType.current = incomingType;
    setActionType(incomingType);
  }, [data.actionType]);

  useEffect(() => {
    if (!customDef) return;
    const next = {
      ...customActionDefaultParams(customDef),
      ...((data.customActionParams as ModelParams | undefined) ?? {}),
    };
    setCustomActionParams((current) => {
      const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
      return [...keys].every((key) => current[key] === next[key])
        ? current
        : next;
    });
  }, [customDef, data.customActionParams]);

  // Clear the one-shot `openPanel` flag once consumed, so reloading or
  // re-hydrating from Loro doesn't force the panel open on every mount.
  useEffect(() => {
    if (!data.openPanel) return;
    selectAction();
    openActionPanel();
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, openPanel: undefined } } : n,
      ),
    );
    if (loroSync) {
      loroSync.updateNode(id, { data: { openPanel: undefined } });
    }
    // Run once on mount if the flag is present; deps intentionally minimal.
  }, []);

  useEffect(() => {
    // Legacy remap only applies to built-in image/video actions — custom
    // actions (`custom:<id>`) resolve their model id through customDef.
    if (actionType !== "image-gen" && actionType !== "video-gen") {
      if (data.modelId && data.modelId !== modelId) {
        const nextModel =
          availableModels.find((card) => card.id === data.modelId) ||
          MODEL_CARDS.find((card) => card.id === data.modelId) ||
          selectedModel;
        const nextParams = {
          ...(nextModel?.defaultParams ?? {}),
          ...(data.modelParams ?? {}),
        } as ModelParams;
        setModelId(nextModel?.id ?? (data.modelId as string));
        setModelParams(nextParams);
        return;
      }
      if (data.modelParams) {
        setModelParams((prev) => {
          const next = {
            ...(selectedModel?.defaultParams ?? {}),
            ...prev,
            ...data.modelParams,
          } as ModelParams;
          const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
          return [...keys].every((key) => prev[key] === next[key])
            ? prev
            : next;
        });
      }
      return;
    }
    const incomingModelId = resolveConfiguredModelId(
      actionType,
      data.modelId as string | undefined,
      data.modelName,
    );
    if (incomingModelId && incomingModelId !== modelId) {
      const nextModel =
        availableModels.find((card) => card.id === incomingModelId) ||
        MODEL_CARDS.find((card) => card.id === incomingModelId) ||
        selectedModel;
      const nextParams = {
        ...(nextModel?.defaultParams ?? {}),
        ...(data.modelParams ?? {}),
      } as ModelParams;
      setModelId(nextModel?.id ?? incomingModelId);
      setModelParams(nextParams);
    } else if (data.modelParams) {
      setModelParams((prev) => {
        const next = {
          ...(selectedModel?.defaultParams ?? {}),
          ...prev,
          ...data.modelParams,
        } as ModelParams;
        const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
        return [...keys].every((key) => prev[key] === next[key]) ? prev : next;
      });
    }
  }, [
    actionType,
    availableModels,
    data.modelId,
    data.modelName,
    data.modelParams,
    modelId,
    selectedModel,
  ]);

  useEffect(() => {
    // Custom actions intentionally have selectedModel === undefined
    // (they don't use ModelCard at all — see the useMemo at line ~207).
    // Without this guard, the fallback fires for every custom badge,
    // writes modelId = nano-banana-2, which re-renders, selectedModel
    // is still undefined because isCustom is true, fallback fires
    // again — infinite update loop. The fallback only makes sense
    // for built-in gens that lost their model card (legacy data).
    if (isCustom || nativeDraft) return;
    if (!selectedModel && availableModels[0]) {
      const fallback = availableModels[0];
      const nextParams = { ...(fallback.defaultParams ?? {}) } as ModelParams;
      setModelId(fallback.id);
      setModelParams(nextParams);
      syncModelState(fallback.id, nextParams);
    }
  }, [availableModels, selectedModel, syncModelState, isCustom, nativeDraft]);

  const handleSave = useCallback(() => {
    setShowModal(false);
    if (nativeDraft) {
      void (isCustom || nativeDraft.projection?.revision.state.contentParts === undefined ? saveNativePrompt(content) : nativeDraft.flush()).then(() => loroSync?.updateNode(id, { data: { label } }))
        .catch((error) => setError(error instanceof Error ? error.message : String(error)));
      return;
    }
    setNodes((nds) =>
      nds.map((node) => {
        if (node.id === id) {
          return { ...node, data: { ...node.data, label, content } };
        }
        return node;
      }),
    );
    if (loroSync) {
      loroSync.updateNode(id, { data: { label, content } });
    }
  }, [id, label, content, setNodes, loroSync, nativeDraft, saveNativePrompt, isCustom]);

  const handleCancel = useCallback(() => {
    setShowModal(false);
    setLabel(data.label || "Prompt");
    setContent(cleanContent(data.content));
  }, [data.label, data.content]);

  const handleCopy = useCallback(async () => {
    if (nativeDraft) {
      try {
        if (syncTimerRef.current) { clearTimeout(syncTimerRef.current); syncTimerRef.current = null; }
        await nativeDraft.copy({ sourceNodeId: id, nodeId: await generateSemanticId(projectId), label,
          ...(isCustom && customDef?.generator ? { draftEdit: createActionCardPromptEdit(content, customDef.generator, getNode) }
            : nativeDraft.projection?.revision.state.contentParts === undefined ? { draftEdit: createModelPromptEdit(content, getNode) } : {}),
          statePatch: isCustom ? customActionParams : { modelId, params: modelParams, ...(isMusicModel ? { lyrics } : {}) } });
        setShowModal(false);
        closeActionPanel();
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    const newId = await generateSemanticId(projectId);
    const currentNode = getNode(id);
    const pos = currentNode?.position ?? { x: 0, y: 0 };
    const newNode = {
      id: newId,
      type: "action-badge" as const,
      position: { x: pos.x + 290, y: pos.y },
      // `openPanel: true` — one-shot flag the mounted ActionBadge consumes
      // to auto-open its config panel. Clone also re-attaches ref edges,
      // so the user lands in a ready-to-tweak state.
      data: {
        label,
        content,
        lyrics,
        actionType,
        modelId,
        modelParams,
        ...(isCustom
          ? {
              customActionId,
              customActionParams,
              pluginBinding:
                currentCustomPluginBinding ?? storedPluginBinding,
            }
          : {}),
        referenceImageOrder: refNodeIds,
        openPanel: true,
      },
    };
    setNodes((nds) => [...nds, newNode as any]);
    if (loroSync) {
      loroSync.addNode(newId, newNode);
    }
    // Duplicate incoming reference edges so the new copy shares the same attachments
    refNodeIds.forEach((srcId) => {
      const edgeId = `${srcId}-${newId}`;
      addEdges({ id: edgeId, source: srcId, target: newId, type: "default" });
      if (loroSync) {
        loroSync.addEdge(edgeId, {
          id: edgeId,
          source: srcId,
          target: newId,
          type: "default",
        });
      }
    });
    setShowModal(false);
    closeActionPanel();
  }, [
    id,
    label,
    content,
    lyrics,
    actionType,
    modelId,
    modelParams,
    isCustom,
    isMusicModel,
    customActionId,
    customActionParams,
    currentCustomPluginBinding,
    customDef,
    storedPluginBinding,
    refNodeIds,
    projectId,
    getNode,
    setNodes,
    addEdges,
    loroSync,
    closeActionPanel,
    nativeDraft,
  ]);

  const handleUpdateCustomAction = useCallback(() => {
    if (!currentCustomPluginBinding || isCheckpointLocked) return;
    if (nativeDraft) {
      void nativeDraft.prepare((before) => before).then(() => setError(null))
        .catch((error) => setError(error instanceof Error ? error.message : String(error)));
      return;
    }
    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === id
          ? {
              ...node,
              data: {
                ...node.data,
                pluginBinding: currentCustomPluginBinding,
              },
            }
          : node,
      ),
    );
    loroSync?.updateNode(id, {
      data: { pluginBinding: currentCustomPluginBinding },
    });
    setError(null);
  }, [currentCustomPluginBinding, id, isCheckpointLocked, loroSync, setNodes, nativeDraft]);

  const handleLabelChange = (evt: React.ChangeEvent<HTMLInputElement>) => {
    const newLabel = evt.target.value;
    setLabel(newLabel);
  };

  const prepareNativeRevision = useCallback(async () => {
    if (!nativeDraft) throw new Error("Native Generator draft is unavailable.");
    if (syncTimerRef.current) { clearTimeout(syncTimerRef.current); syncTimerRef.current = null; }
    const updatePrompt: GeneratorDraftEdit | null = isCustom && customDef?.generator ? createActionCardPromptEdit(content, customDef.generator, getNode)
      : nativeDraft.projection?.revision.state.contentParts === undefined ? createModelPromptEdit(content, getNode) : null;
    const accepted = await nativeDraft.prepare((before, definition) => {
      const next = updatePrompt ? updatePrompt(before, definition) : before;
      return { state: { ...next.state, ...(isCustom ? customActionParams : { modelId, params: modelParams, ...(isMusicModel ? { lyrics } : {}) }) }, persistentInputRefs: next.persistentInputRefs };
    });
    return { generatorId: accepted.generator.id, generatorRevisionId: accepted.revision.id };
  }, [nativeDraft, modelId, content, modelParams, getNode, isMusicModel, lyrics, isCustom, customDef, customActionParams]);

  // Shared pending-asset primitives. Run always creates a fresh pending
  // output; only a draft node's Build action may adopt that draft.
  const { spawnPending, spawnDraft, canSpawn, disabledReason, outputKind } =
    useSpawnPendingAsset({
      actionBadgeId: id,
      resolveGeneratorRevision: nativeDraft ? prepareNativeRevision : undefined,
      actionType,
      isCustom,
      customDef,
      customActionParams,
      modelId,
      modelParams,
      selectedModel,
      content,
      lyrics: isMusicModel ? lyrics : "",
      dataPrompt: data.prompt as string | undefined,
      pluginBinding: effectivePluginBinding,
      projectId,
      refNodeIds,
      getNodes,
      addNodeWithAutoLayout,
      addNodeWithLayout,
      addEdges,
      setNodes,
      loroSync,
    });

  // Auto-run effect
  const handleExecute = useCallback(async () => {
    setIsExecuting(true);
    setError(null);

    try {
      if (modelUnavailable) throw new Error(modelUnavailableReason);
      if (customActionDefinitionUpdated) {
        throw new Error(ACTION_DEFINITION_UPDATED_RUN_LABEL);
      }
      if (!nativeDraft && referenceValidationError) throw new Error(referenceValidationError);
      let generatorRevision: { generatorId: string; generatorRevisionId: string } | undefined;
      if (nativeDraft) {
        generatorRevision = await prepareNativeRevision();
      }
      // Capture and clear pre-allocated asset ID (provided by backend; treat as single-use)
      const preAllocatedAssetId = data.preAllocatedAssetId as
        string | undefined;
      if (preAllocatedAssetId) {
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? { ...n, data: { ...n.data, preAllocatedAssetId: undefined } }
              : n,
          ),
        );
      }

      // Compute the batch-label base once. Custom actions always spawn 1;
      // image-gen/video-gen honor the countValue chip.
      const rawPrompt =
        (content && content.trim() !== "" ? content : "") ||
        (data.prompt as string) ||
        "";
      const textRefs = refNodeIds
        .map((nid) => resolveTextRef(getNode(nid)))
        .filter((text): text is string => !!text);
      const composedPrompt = composePromptWithTextRefs(rawPrompt, textRefs);
      const parts = parsePromptParts(composedPrompt);
      const promptText = extractPromptText(parts);
      let baseLabel: string;
      if (isCustom && customDef) {
        baseLabel = extractLabelFromPrompt(
          composedPrompt,
          `${customDef.name} Result`,
        );
      } else if (actionType === "video-gen") {
        baseLabel = extractLabelFromPrompt(promptText, "Generated Video");
      } else if (actionType === "audio-gen") {
        baseLabel = extractLabelFromPrompt(promptText, "Generated Audio");
      } else if (actionType === "text-gen") {
        baseLabel = extractLabelFromPrompt(promptText, "Generated Text");
      } else if (actionType === "model-gen") {
        baseLabel = extractLabelFromPrompt(promptText, "Generated Model");
      } else {
        baseLabel = extractLabelFromPrompt(promptText, "Generated Image");
      }

      const directorShotItems =
        !nativeDraft && actionType === "video-gen"
          ? refNodeIds.flatMap((nodeId) => {
              const node = getNode(nodeId);
              if (!node) return [];
              return directorReferencePackets(node)
                .filter(
                  (
                    packet,
                  ): packet is DirectorReferencePacket & {
                    scope: {
                      kind: "shot";
                      selectedShotIds: [string, ...string[]];
                    };
                  } =>
                    packet.scope?.kind === "shot" &&
                    packet.scope.selectedShotIds.length === 1,
                )
                .map((packet) => ({
                  packet,
                  shotId: packet.scope.selectedShotIds[0],
                  shotName: packet.shotSpec.shots[0]?.name,
                }));
            })
          : [];

      if (directorShotItems.length > 0) {
        const groupId = await generateSemanticId(projectId);
        const selectedShotIds = directorShotItems.map((item) => item.shotId);
        const firstPacket = directorShotItems[0].packet;
        const groupNode = addNodeWithAutoLayout(
          {
            id: groupId,
            type: "group",
            data: {
              label: `Director shots · ${directorShotItems.length}`,
              directorShotGroupId: groupId,
              sourceDirectorStageId: firstPacket.stageId,
              sourceDirectorStageRevisionId: firstPacket.stageRevisionId,
              selectedDirectorShotIds: selectedShotIds,
            },
            style: {
              width: 560,
              height: Math.max(420, 112 + directorShotItems.length * 360),
            },
          },
          id,
          { x: 340, y: 0 },
        );
        if (!groupNode) {
          throw new Error("Failed to create Director Shot Group.");
        }
        if (loroSync) {
          loroSync.addNode(groupNode.id, groupNode);
        }

        for (let i = 0; i < directorShotItems.length; i++) {
          const item = directorShotItems[i];
          const created = await spawnPending({
            assetId: i === 0 ? preAllocatedAssetId : undefined,
            directorReferencePacket: item.packet,
            directorShotGroupId: groupId,
            groupIndex: i,
            labelOverride: item.shotName || `${baseLabel} · ${item.shotId}`,
            parentGroupId: groupId,
            sourceDirectorStageId: item.packet.stageId,
            sourceDirectorStageRevisionId: item.packet.stageRevisionId,
            sourceDirectorStageShotId: item.shotId,
          });
          if (!created && i === 0) {
            throw new Error("Failed to create pending Director Shot node.");
          }
        }
      } else {
        const batchCount = isCustom && customDef ? 1 : countValue;
        for (let i = 0; i < batchCount; i++) {
          const labelOverride =
            batchCount > 1 ? `${baseLabel} (${i + 1})` : baseLabel;
          const assetId = i === 0 ? preAllocatedAssetId : undefined;
          const created = await spawnPending({ assetId, labelOverride, ...(generatorRevision ? { generatorRevision } : {}) });
          if (!created && i === 0) {
            throw new Error("Failed to create pending node.");
          }
        }
      }

      // Clear preAllocatedAssetId (idempotent) + mark run successful, then freeze
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== id) return n;
          return {
            ...n,
            data: {
              ...n.data,
              preAllocatedAssetId: undefined,
              status: "success",
              hasRun: true,
            },
          };
        }),
      );
      if (loroSync) {
        loroSync.updateNode(id, { data: { hasRun: true } });
      }
    } catch (err: any) {
      setError(err.message);
      mediaLog.error("action.execution_failed", { nodeId: id, error: err });
    } finally {
      setIsExecuting(false);
    }
  }, [
    id,
    content,
    data.prompt,
    data.preAllocatedAssetId,
    refNodeIds,
    getNode,
    resolveTextRef,
    actionType,
    isCustom,
    customDef,
    countValue,
    spawnPending,
    setNodes,
    loroSync,
    projectId,
    addNodeWithAutoLayout,
    cap,
    customActionDefinitionUpdated,
    modelUnavailable,
    referenceValidationError,
    nativeDraft,
    prepareNativeRevision,
  ]);

  // Helper to extract meaningful label from prompt content (already moved outside)

  // Execute action: generate image or video
  useEffect(() => {
    const requiredUpstreams: string[] = Array.isArray(data.upstreamNodeIds)
      ? data.upstreamNodeIds
      : [];

    if (data.autoRun && !isExecuting) {
      if (requiredUpstreams.length > 0) {
        const connectedSources = connectedEdges
          .filter((e) => e.target === id)
          .map((e) => e.source);
        const allConnected = requiredUpstreams.every((uid: string) =>
          connectedSources.includes(uid),
        );

        if (!allConnected) {
          return;
        }
      }

      // Clear the flag to prevent infinite loops
      data.autoRun = false;

      // Small delay to ensure React Flow state is fully synced
      setTimeout(() => {
        handleExecute();
      }, 500);
    }
  }, [
    data,
    data.autoRun,
    connectedEdges,
    data.upstreamNodeIds,
    id,
    isExecuting,
    handleExecute,
  ]);

  // Modal content (from PromptNode)
  const modalContent = showModal ? (
    <NodeModalDialog
      open={showModal}
      onClose={handleCancel}
      ariaLabel="Expanded prompt editor"
      overlayClassName="bg-warm-page/80"
    >
      {/* Header with Title Input */}
      <div className="px-12 pt-8 pb-2 flex justify-between items-start">
        <Input
          type="text"
          value={label}
          onChange={handleLabelChange}
          disabled={isCheckpointLocked}
          placeholder="Untitled Prompt"
          className="w-full text-4xl font-bold text-slate-900 dark:text-slate-50 placeholder:text-stone-300 bg-transparent border-none outline-none focus:outline-none disabled:opacity-60"
          style={{
            fontFamily:
              "var(--font-space-grotesk), var(--font-inter), sans-serif",
            letterSpacing: "-0.02em",
          }}
        />
        <div className="flex gap-2 items-center">
          {isCheckpointLocked ? (
            <>
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-warm-muted text-slate-700 dark:text-slate-300 text-sm font-medium">
                <Lock size={13} weight="bold" />
                Checkpoint
              </div>
              <Button
                onClick={handleCopy}
                leftIcon={<Copy size={14} weight="bold" />}
                size="sm"
                shape="rounded"
                className="clash-node-primary rounded-xl px-4 py-2 text-sm font-medium"
              >
                Copy to revise
              </Button>
            </>
          ) : (
            <Button
              onClick={handleSave}
              size="sm"
              shape="rounded"
              className="clash-node-primary rounded-xl px-4 py-2 text-sm font-medium"
            >
              Save
            </Button>
          )}
          <IconButton
            label="Close expanded prompt editor"
            onClick={handleCancel}
            icon={<X className="w-5 h-5" weight="bold" />}
            size="md"
            shape="rounded"
            className="text-stone-700 hover:bg-warm-muted hover:text-stone-600 dark:text-stone-300"
          />
        </div>
      </div>

      {/* Image Attachment Row */}
      {(refNodeIds.length > 0 || !isCheckpointLocked) && (
        <div className="px-12 py-3 flex items-center gap-2 flex-wrap border-b border-warm-border">
          <Reorder.Group
            axis="x"
            values={refNodeIds}
            onReorder={persistRefOrder}
            className="flex items-center gap-2 flex-wrap"
            as="div"
          >
            {refNodeIds.map((nodeId, i) => {
              const node = getNode(nodeId);
              const src = resolveRefSrc(node);
              const textRef = resolveTextRef(node);
              const isText = node?.type === "text";
              return (
                <Reorder.Item
                  key={nodeId}
                  value={nodeId}
                  drag={isCheckpointLocked ? false : "x"}
                  className="relative group/thumb flex-shrink-0"
                  as="div"
                  whileDrag={{ scale: 1.08, zIndex: 10 }}
                  style={{ cursor: isCheckpointLocked ? "default" : "grab" }}
                >
                  <div className="w-10 h-10 rounded-lg overflow-hidden border border-warm-border bg-warm-muted flex items-center justify-center pointer-events-none">
                    {src ? (
                      <ProjectedImage
                        src={src}
                        alt={`Image ${i + 1}`}
                        className="w-full h-full object-cover"
                      />
                    ) : isText && textRef ? (
                      <TextT
                        size={16}
                        className="text-slate-700 dark:text-slate-300"
                        weight="bold"
                      />
                    ) : (
                      <ImageIcon
                        size={16}
                        className="text-slate-700 dark:text-slate-300"
                      />
                    )}
                  </div>
                  <span className="clash-node-ref-index absolute -top-1 -left-1 text-[9px] font-bold rounded px-1 min-w-[14px] text-center leading-[14px] pointer-events-none">
                    {i + 1}
                  </span>
                  {!isCheckpointLocked && (
                    <IconButton
                      label={`Remove reference ${i + 1}`}
                      icon="×"
                      size="sm"
                      shape="circle"
                      onClick={() => removeRefNode(nodeId)}
                      className={`${NODE_INTERACTION_BOUNDARY_CLASS} clash-node-ref-remove absolute -top-1 -right-1 hidden h-5 min-h-5 w-5 min-w-5 text-[11px] leading-none group-hover/thumb:flex`}
                    />
                  )}
                </Reorder.Item>
              );
            })}
          </Reorder.Group>
          {!isCheckpointLocked && (
            <Popover open={showRefPicker} onOpenChange={setShowRefPicker}>
              <PopoverTrigger asChild>
                <IconButton
                  label="Add reference from canvas"
                  icon={<Plus size={16} weight="bold" />}
                  size="lg"
                  shape="rounded"
                  className="h-10 min-h-10 w-10 min-w-10 rounded-lg border border-dashed border-warm-border text-content-secondary hover:border-brand/45 hover:bg-transparent hover:text-content-primary"
                />
              </PopoverTrigger>
              <PopoverContent
                side="bottom"
                align="start"
                sideOffset={4}
                className="z-[9999] w-56 overflow-hidden rounded-xl p-0"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                {(() => {
                  const available = getNodes().filter((n) => {
                    if (refNodeIds.includes(n.id)) return false;
                    return (
                      !!resolveTextRef(n) ||
                      (hasCompatibleModality(n) && !!referenceAssetId(n))
                    );
                  });
                  if (available.length === 0) {
                    return (
                      <div className="px-3 py-3 text-xs text-slate-700 dark:text-slate-300">
                        No references available
                      </div>
                    );
                  }
                  return available.map((n) => {
                    const refSrc = resolveRefSrc(n);
                    const textRef = resolveTextRef(n);
                    const assetId = referenceAssetId(n);
                    if (!assetId && !textRef) return null;
                    return (
                      <Button
                        key={n.id}
                        size="sm"
                        shape="rounded"
                        className="w-full justify-start rounded-none border-0 bg-transparent px-3 py-2 text-left shadow-none hover:bg-warm-muted"
                        onClick={() => {
                          addRefNode(n.id);
                          setShowRefPicker(false);
                        }}
                      >
                        <div className="w-7 h-7 rounded overflow-hidden border border-warm-border flex-shrink-0">
                          {refSrc ? (
                            <ProjectedImage
                              src={refSrc}
                              className="w-full h-full object-cover"
                            />
                          ) : textRef ? (
                            <div className="w-full h-full bg-warm-muted flex items-center justify-center text-slate-700 dark:text-slate-300">
                              <TextT size={14} weight="bold" />
                            </div>
                          ) : (
                            <div className="w-full h-full bg-warm-muted flex items-center justify-center text-slate-700 dark:text-slate-300">
                              <ImageIcon size={14} weight="bold" />
                            </div>
                          )}
                        </div>
                        <span className="text-xs text-slate-800 dark:text-slate-200 truncate">
                          {(n.data.label as string) || n.id}
                        </span>
                      </Button>
                    );
                  });
                })()}
              </PopoverContent>
            </Popover>
          )}
        </div>
      )}

      {/* Editor Content */}
      <div
        className="flex-1 overflow-y-auto bg-warm-surface"
        style={
          isCheckpointLocked
            ? { pointerEvents: "none", opacity: 0.7 }
            : undefined
        }
      >
        <MilkdownEditor
          value={content}
          onChange={setContent}
          mentionableNodes={mentionableNodes}
          promptModalities={[...(cap?.promptModalities ?? ["text"])]}
          connectedNodeIds={refNodeIds}
        />
      </div>
    </NodeModalDialog>
  ) : null;

  const keyframeTimelineDialog = isKeyframePresentation ? (
    <NodeModalDialog
      open={keyframeTimelineOpen}
      onClose={() => setKeyframeTimelineOpen(false)}
      ariaLabel="Edit keyframe timing"
      contentClassName="h-auto max-h-[min(28rem,calc(100vh-2rem))] w-[min(48rem,calc(100vw-2rem))] max-w-none overflow-hidden rounded-2xl"
    >
      <div className="flex items-center justify-between border-b border-warm-border px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-content-primary">
            Keyframe timing
          </div>
          <div className="mt-0.5 text-[10px] text-content-secondary">
            {keyframeTimingCustomized ? "Custom timing" : "Evenly distributed"}{" "}
            · {keyframeFrameRate} fps · {keyframeDurationSeconds}s
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            aria-label="Distribute keyframes evenly"
            size="sm"
            shape="rounded"
            onClick={() =>
              persistKeyframeFrames(
                evenlySpacedFrameIndices(keyframeKeys.length, keyframeLastFrame),
                false,
              )
            }
            className="border border-warm-border bg-warm-surface text-content-secondary shadow-none hover:bg-warm-muted hover:text-content-primary"
          >
            Distribute evenly
          </Button>
          <IconButton
            label="Close keyframe timing"
            icon={<X size={15} weight="bold" />}
            size="md"
            shape="rounded"
            onClick={() => setKeyframeTimelineOpen(false)}
          />
        </div>
      </div>

      <div className="overflow-x-auto px-8 pb-6 pt-7">
        <div className="min-w-[38rem]">
          <div
            ref={keyframeTrackRef}
            data-testid="keyframe-timeline-track"
            className="relative mx-5 h-20"
          >
            <div
              aria-hidden
              className="absolute inset-x-0 top-1 h-1 rounded-full bg-warm-muted shadow-inner"
            />
            <div
              aria-hidden
              className="absolute left-0 top-0 h-3 w-px bg-content-secondary/60"
            />
            <div
              aria-hidden
              className="absolute right-0 top-0 h-3 w-px bg-content-secondary/60"
            />
            {keyframeKeys.map((nodeId, index) => {
              const isStart = index === 0;
              const isEnd =
                index === keyframeKeys.length - 1 && keyframeKeys.length > 1;
              const frameIndex = keyframeFrames[index] ?? 0;
              const minFrame = isStart
                ? 0
                : (keyframeFrames[index - 1] ?? 0) + 1;
              const maxFrame = isEnd
                ? keyframeLastFrame
                : (keyframeFrames[index + 1] ?? keyframeLastFrame) - 1;
              const label = isStart
                ? "Start"
                : isEnd
                  ? "End"
                  : `Frame ${index + 1}`;
              return (
                <TimelineKeyframeMarker
                  key={nodeId}
                  frameIndex={frameIndex}
                  lastFrame={keyframeLastFrame}
                  minFrame={minFrame}
                  maxFrame={maxFrame}
                  draggable={!isCheckpointLocked && !isStart && !isEnd}
                  onCommit={(nextFrame) => {
                    if (isStart || isEnd) return;
                    const nextFrames = [...keyframeFrames];
                    nextFrames[index] = nextFrame;
                    persistKeyframeFrames(nextFrames, true);
                    setSelectedKeyframeId(nodeId);
                  }}
                  trackRef={keyframeTrackRef}
                >
                  {(previewFrame) => (
                    <div
                      aria-label={`${label} at ${formatFrameTime(previewFrame, keyframeFrameRate)}`}
                      onPointerDown={() => setSelectedKeyframeId(nodeId)}
                      className={`${NODE_INTERACTION_BOUNDARY_CLASS} rounded-lg outline-none transition-shadow ${selectedKeyframeId === nodeId ? "ring-2 ring-brand/55 ring-offset-2 ring-offset-warm-surface" : "focus-visible:ring-2 focus-visible:ring-ring/45"}`}
                    >
                      <FrameReferenceSlot
                        filled
                        label={label}
                        thumb={refThumbByNodeId.get(nodeId)}
                        assetReference={keyframeAssetReference(nodeId)}
                        timeControl={
                          isStart || isEnd ? (
                            <div
                              data-testid="keyframe-time-slot"
                              className={KEYFRAME_TIME_SLOT_CLASS}
                            >
                              {formatFrameTime(previewFrame, keyframeFrameRate)}
                            </div>
                          ) : (
                            <KeyframeTimeInput
                              frameIndex={previewFrame}
                              frameRate={keyframeFrameRate}
                              label={`${label} time in seconds`}
                              minFrame={minFrame}
                              maxFrame={maxFrame}
                              onCommit={(nextFrame) => {
                                const nextFrames = [...keyframeFrames];
                                nextFrames[index] = nextFrame;
                                persistKeyframeFrames(nextFrames, true);
                                setSelectedKeyframeId(nodeId);
                              }}
                            />
                          )
                        }
                      />
                    </div>
                  )}
                </TimelineKeyframeMarker>
              );
            })}
          </div>
        </div>
      </div>
    </NodeModalDialog>
  ) : null;

  // Computed display name for the badge
  const badgeDisplayName = isCustom
    ? customDef?.name || customActionId || "Custom"
    : selectedModel?.name ||
      modelId ||
      (actionKind === "video"
        ? "Video"
        : actionKind === "audio"
          ? "Audio"
          : actionKind === "text"
            ? "Text"
            : "Image");

  // Resolve current param display chips
  const paramChips = useMemo(() => {
    const chips: { label: string; value: string; paramId: string }[] = [];
    const params = isCustom ? customDef?.parameters : selectedModel?.parameters;
    const activeParams = isCustom ? customActionParams : modelParams;
    if (!params) return chips;
    params.forEach((p: any) => {
      if (p.id === "count") return; // count is shown separately as xN chip
      const val = activeParams[p.id] ?? p.defaultValue;
      if (val === undefined) return;
      if (p.type === "select" && p.options) {
        const opt = p.options.find((o: any) => String(o.value) === String(val));
        chips.push({
          label: p.label,
          value: opt?.label ?? String(val),
          paramId: p.id,
        });
      } else if (p.type === "boolean") {
        chips.push({
          label: p.label,
          value: val ? "On" : "Off",
          paramId: p.id,
        });
      } else {
        chips.push({ label: p.label, value: String(val), paramId: p.id });
      }
    });
    return chips;
  }, [isCustom, customActionParams, customDef, selectedModel, modelParams]);
  // Every card and custom action names the ratio parameter `aspect_ratio`.
  const aspectRatioParamId = "aspect_ratio";
  const activeParameters =
    (isCustom ? customDef?.parameters : selectedModel?.parameters) ?? [];
  const aspectRatioParameter = activeParameters.find(
    (parameter) =>
      parameter.type === "select" &&
      parameter.id === aspectRatioParamId &&
      (parameter.options ?? []).some(
        (option) => parseAspectRatio(option) !== null,
      ),
  ) as ModelParameter | undefined;
  const aspectRatioCurrentValue = aspectRatioParameter
    ? ((isCustom ? customActionParams : modelParams)[aspectRatioParameter.id] ??
      aspectRatioParameter.defaultValue)
    : undefined;
  const aspectRatioPresentedValue =
    aspectRatioPopoverValue ?? aspectRatioCurrentValue;
  const resolvedAspectRatioLabel = resolveAspectRatioParameter(
    aspectRatioParameter,
    aspectRatioPresentedValue,
  );
  const aspectRatioCurrentLabel =
    resolvedAspectRatioLabel === "auto" || resolvedAspectRatioLabel === "adaptive"
      ? "Auto"
      : (resolvedAspectRatioLabel ?? String(aspectRatioPresentedValue ?? ""));
  const actionAspectRatioOptions = aspectRatioParameter
    ? normalizeActionAspectRatioOptions(aspectRatioParameter)
    : [];
  const aspectRatioSelectedOption = aspectRatioParameter?.options?.find(
    (option) => String(option.value) === String(aspectRatioPresentedValue),
  );
  const aspectRatioEditorVisible = aspectRatioSelectedOption
    ? parseAspectRatio(aspectRatioSelectedOption) !== null
    : aspectRatioPresentedValue !== undefined &&
      parseAspectRatio({
        label: String(aspectRatioPresentedValue),
        value: aspectRatioPresentedValue as string | number,
      }) !== null;
  const secondaryParamChips = paramChips.filter(
    (chip) => chip.paramId !== aspectRatioParamId,
  );
  const secondaryParameters = activeParameters.filter(
    (parameter) => parameter.id !== aspectRatioParamId,
  );

  const closeConfigPanelControls = useCallback(() => {
    setParamsPopoverOpen(false);
    setAspectRatioPopoverOpen(false);
    setAspectRatioPopoverValue(undefined);
    setRefPickerTarget(null);
  }, []);

  useEffect(() => {
    if (showPanel) return;
    closeConfigPanelControls();
    setShowMentionMenu(false);
  }, [closeConfigPanelControls, showPanel]);

  useEffect(() => {
    if (!showPanel) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeActionPanel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeActionPanel, showPanel]);

  // ReactFlow's NodeToolbar owns screen-space positioning, so this panel
  // follows node drag and viewport transforms without a floating-ui poll.
  const configPanel = (
    <motion.div
      initial={{ y: 16, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ type: "spring", damping: 30, stiffness: 400 }}
      data-action-config-panel={id}
      className="w-[min(42rem,calc(100vw-2rem))] max-w-none flex flex-col items-start"
    >
      {/* Reference images strip above the prompt panel.
                        - startEnd models: two labeled Start/End slots joined by ⇌, always visible.
                        - Other models: Reorder.Group of numbered thumbs (drag to reorder, × to detach). */}
      {nativeDraft?.projection && (() => {
        const revision = nativeDraft.projection.revision;
        const inputs = revision.persistentInputRefs.filter(input => "kind" in input.target && input.target.kind === "document");
        if (inputs.length === 0) return null;
        const parts = !isCustom && revision.state.contentParts !== undefined ? modelPromptParts(revision.state) : [];
        return <ul aria-label="Text references" className="mb-2 flex w-full flex-col gap-1">
          {inputs.map(input => {
            const part = parts.find(part => part.type === "input" && part.slot === input.slot && part.itemKey === input.itemKey);
            const label = part?.type === "input" && part.label ? part.label : "Text";
            return <NativeDocumentReference key={JSON.stringify([input.slot, input.itemKey ?? null])} projectId={projectId} input={input} label={label}
              onRemove={isCheckpointLocked ? undefined : removed => {
                void nativeDraft.editDraft(before => ({
                  state: isCustom ? before.state : removeModelPromptInput(before.state, removed),
                  persistentInputRefs: before.persistentInputRefs.filter(ref => ref.slot !== removed.slot || ref.itemKey !== removed.itemKey),
                })).catch(error => setError(error instanceof Error ? error.message : String(error)));
              }} />;
          })}
        </ul>;
      })()}
      {nativeDraft?.projection && (() => {
        const placedAssets = new Set(getNodes().flatMap((node) => { const assetId = referenceAssetId(node); return assetId ? [assetId] : []; }));
        const revision = nativeDraft.projection.revision;
        const inputs = (isCustom ? revision.persistentInputRefs : modelInputRefsInPromptOrder(revision.state, revision.persistentInputRefs)).filter((input) => "kind" in input.target && input.target.kind === "media" && !placedAssets.has(input.target.projectAssetId) && !(isKeyframePresentation && input.slot === "image"));
        if (inputs.length === 0) return null;
        return <ul aria-label="Media references" className="mb-2 flex w-full flex-col gap-1">
          {inputs.map((input) => <NativeMediaReference key={JSON.stringify([input.slot, input.itemKey ?? null])} projectId={projectId} input={input}
            onRemove={isCheckpointLocked ? undefined : (removed) => {
              void nativeDraft.editDraft(before => {
                const model = isCustom ? undefined : enabledModelCatalog.find(entry => entry.model.id === before.state.modelId)?.model;
                if (model?.input.presentation?.type === "keyframes" && removed.slot === "image" && "kind" in removed.target && removed.target.kind === "media") {
                  return editModelKeyframes(before, model, { type: "remove", projectAssetId: removed.target.projectAssetId, input: removed });
                }
                return { state: isCustom ? before.state : removeModelPromptInput(before.state, removed), persistentInputRefs: before.persistentInputRefs.filter(ref => ref.slot !== removed.slot || ref.itemKey !== removed.itemKey) };
              }).catch((error) => setError(error instanceof Error ? error.message : String(error)));
            }} />)}
        </ul>;
      })()}
      {isKeyframePresentation ? (
        (() => {
          const startNodeId = keyframeKeys[0];
          const endNodeId =
            keyframeKeys.length >= 2
              ? keyframeKeys[keyframeKeys.length - 1]
              : undefined;
          const middleNodeIds =
            keyframeKeys.length > 2 ? keyframeKeys.slice(1, -1) : [];
          const pickerSlot = (
            slot: "start" | "end",
            label: string,
            timeLabel: string,
            disabled = false,
          ) => (
            <FrameReferenceSlot
              filled={false}
              label={label}
              timeLabel={timeLabel}
              emptyControl={
                <Popover
                  open={refPickerTarget === slot}
                  onOpenChange={(open) =>
                    setRefPickerTarget(open ? slot : null)
                  }
                >
                  <PopoverTrigger asChild>
                    <IconButton
                      label={`Pick ${label} keyframe`}
                      title={`Up to ${keyframeLimit} keyframes · exact positions at ${keyframeFrameRate} fps`}
                      icon={<Plus size={14} weight="bold" />}
                      size="lg"
                      shape="rounded"
                      disabled={isCheckpointLocked || disabled}
                      className="h-10 min-h-10 w-10 min-w-10 rounded-lg border border-dashed border-warm-border bg-warm-surface text-content-secondary shadow-sm hover:border-brand/45 hover:bg-warm-muted hover:text-content-primary"
                    />
                  </PopoverTrigger>
                  <PopoverContent
                    side="top"
                    align="start"
                    className="z-[9999] w-[320px] overflow-hidden rounded-xl p-0"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <RefPickerContent
                      projectId={projectId}
                      title={`Pick ${label.toLowerCase()} keyframe`}
                      candidates={refPickerCandidates}
                      onPick={(nodeId) => {
                        attachRefToSlot(nodeId, slot);
                        setRefPickerTarget(null);
                      }}
                    />
                  </PopoverContent>
                </Popover>
              }
            />
          );

          return (
            <FrameReferenceStrip
              ariaLabel="FLUX 3 keyframes"
              layout="scroll"
              trailingControl={
                keyframeKeys.length >= 2 ? (
                  <IconButton
                    label="Edit keyframe timing"
                    title="Edit keyframe timing"
                    icon={<SlidersHorizontal size={15} weight="bold" />}
                    size="md"
                    shape="rounded"
                    onClick={() => setKeyframeTimelineOpen(true)}
                    className={`${NODE_INTERACTION_BOUNDARY_CLASS} h-7 min-h-7 w-7 min-w-7 border border-warm-border bg-warm-surface text-content-secondary shadow-sm hover:bg-warm-muted hover:text-content-primary`}
                  />
                ) : undefined
              }
              message={
                startEndMismatch ? (
                  <p className="mt-1.5 text-[10px] leading-tight text-amber-600">
                    Start and end frames have different aspect ratios (
                    {formatRatio(startEndMismatch.s.w, startEndMismatch.s.h)} vs{" "}
                    {formatRatio(startEndMismatch.e.w, startEndMismatch.e.h)}).
                    Use frames with matching dimensions.
                  </p>
                ) : undefined
              }
            >
              <div role="listitem">
                {startNodeId ? (
                  <FrameReferenceSlot
                    filled
                    label="Start"
                    thumb={refThumbByNodeId.get(startNodeId)}
                    assetReference={keyframeAssetReference(startNodeId)}
                    timeLabel="0s"
                    onRemove={
                      isCheckpointLocked
                        ? undefined
                        : () => removeKeyframeRef(startNodeId)
                    }
                    removeLabel="Remove start keyframe"
                  />
                ) : (
                  pickerSlot("start", "Start", "0s")
                )}
              </div>

              {middleNodeIds.map((nodeId, middleIndex) => {
                const sequenceIndex = middleIndex + 1;
                return (
                  <div
                    key={nodeId}
                    role="listitem"
                    aria-label={`Frame ${sequenceIndex + 1} at ${formatFrameTime(keyframeFrames[sequenceIndex], keyframeFrameRate)}`}
                  >
                    <FrameReferenceSlot
                      filled
                      label={`Frame ${sequenceIndex + 1}`}
                      thumb={refThumbByNodeId.get(nodeId)}
                    assetReference={keyframeAssetReference(nodeId)}
                      timeLabel={formatFrameTime(
                        keyframeFrames[sequenceIndex],
                        keyframeFrameRate,
                      )}
                      onRemove={
                        isCheckpointLocked
                          ? undefined
                          : () => removeKeyframeRef(nodeId)
                      }
                      removeLabel={`Remove frame ${sequenceIndex + 1} keyframe`}
                    />
                  </div>
                );
              })}

              {!isCheckpointLocked &&
                endNodeId &&
                keyframeKeys.length < keyframeLimit && (
                  <div role="listitem" className="w-10 flex-shrink-0">
                    <Popover
                      open={refPickerTarget === "append"}
                      onOpenChange={(open) =>
                        setRefPickerTarget(open ? "append" : null)
                      }
                    >
                      <PopoverTrigger asChild>
                        <IconButton
                          label="Add middle keyframe"
                          title={`Up to ${keyframeLimit} keyframes`}
                          icon={<Plus size={14} weight="bold" />}
                          size="lg"
                          shape="rounded"
                          className="h-10 min-h-10 w-10 min-w-10 rounded-lg border border-dashed border-warm-border bg-warm-surface text-content-secondary shadow-sm hover:border-brand/45 hover:bg-warm-muted hover:text-content-primary"
                        />
                      </PopoverTrigger>
                      <PopoverContent
                        side="top"
                        align="start"
                        className="z-[9999] w-[320px] overflow-hidden rounded-xl p-0"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <RefPickerContent
                          projectId={projectId}
                          title="Pick a middle keyframe"
                          candidates={refPickerCandidates}
                          onPick={(nodeId) => {
                            attachRefToSlot(nodeId, "append");
                            setSelectedKeyframeId(nodeId);
                            setRefPickerTarget(null);
                            if (keyframeTimingCustomized)
                              setKeyframeTimelineOpen(true);
                          }}
                        />
                      </PopoverContent>
                    </Popover>
                  </div>
                )}

              <div role="listitem">
                {endNodeId ? (
                  <FrameReferenceSlot
                    filled
                    label="End"
                    thumb={refThumbByNodeId.get(endNodeId)}
                    assetReference={keyframeAssetReference(endNodeId)}
                    timeLabel={formatFrameTime(
                      keyframeLastFrame,
                      keyframeFrameRate,
                    )}
                    onRemove={
                      isCheckpointLocked
                        ? undefined
                        : () => removeKeyframeRef(endNodeId)
                    }
                    removeLabel="Remove end keyframe"
                  />
                ) : (
                  pickerSlot(
                    "end",
                    "End",
                    formatFrameTime(keyframeLastFrame, keyframeFrameRate),
                    !startNodeId,
                  )
                )}
              </div>
            </FrameReferenceStrip>
          );
        })()
      ) : isContinuationPresentation ? (
        <div className="pointer-events-auto mb-2 min-w-[18rem] rounded-xl border border-warm-border bg-warm-surface px-3 py-2.5 shadow-sm">
          <div className="mb-2">
            <div className="text-[11px] font-semibold text-content-primary">
              {continuationVideoLimit === 1 ? "Source video" : "Source videos"}
            </div>
            <div className="text-[10px] text-content-secondary">
              {continuationVideoSummary}
            </div>
          </div>
          {refNodeIds.length > 0 && (
            <div
              className="mb-2 flex max-w-[30rem] flex-wrap gap-2"
              role="list"
              aria-label="Source videos"
            >
              {refNodeIds.map((sourceNodeId, index) => {
                const sourceNode = getNode(sourceNodeId);
                const thumb = refThumbByNodeId.get(sourceNodeId);
                return (
                  <div
                    key={sourceNodeId}
                    role="listitem"
                    className="group/thumb relative flex w-52 items-center gap-2 rounded-lg border border-warm-border bg-warm-muted p-1.5"
                  >
                    <div className="flex h-10 w-14 flex-shrink-0 items-center justify-center overflow-hidden rounded-md bg-video/15 text-video">
                      {thumb ? (
                        <ProjectedImage
                          src={thumb}
                          alt={`Source video ${index + 1}`}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <VideoCamera size={16} weight="bold" />
                      )}
                    </div>
                    <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-content-primary">
                      {(sourceNode?.data?.label as string | undefined) ??
                        sourceNodeId}
                    </span>
                    {!isCheckpointLocked && (
                      <IconButton
                        label={`Remove source video ${index + 1}`}
                        icon="×"
                        size="sm"
                        shape="circle"
                        onClick={() => removeContinuationRef(sourceNodeId)}
                        className={`${NODE_INTERACTION_BOUNDARY_CLASS} h-6 min-h-6 w-6 min-w-6 text-[11px]`}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {!isCheckpointLocked &&
            refNodeIds.length < continuationVideoLimit && (
              <Popover
                open={refPickerTarget === "append"}
                onOpenChange={(open) =>
                  setRefPickerTarget(open ? "append" : null)
                }
              >
                <PopoverTrigger asChild>
                  <Button
                    aria-label={
                      refNodeIds.length === 0
                        ? "Choose source video"
                        : "Add source video"
                    }
                    size="sm"
                    shape="rounded"
                    leftIcon={<Plus size={14} weight="bold" />}
                    className="border border-dashed border-warm-border bg-transparent text-content-secondary shadow-none hover:bg-warm-muted hover:text-content-primary"
                  >
                    {refNodeIds.length === 0
                      ? "Choose source video"
                      : "Add source video"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="start"
                  className="z-[9999] w-[320px] overflow-hidden rounded-xl p-0"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                >
                  <RefPickerContent
                    projectId={projectId}
                    title="Pick a source video"
                    candidates={refPickerCandidates}
                    onPick={(nodeId) => {
                      attachRefToSlot(nodeId, "append");
                      setRefPickerTarget(null);
                    }}
                  />
                </PopoverContent>
              </Popover>
            )}
        </div>
      ) : isStartEnd ? (
        <FrameReferenceStrip
          ariaLabel="Start and end frames"
          layout="fixed"
          message={
            startEndMismatch ? (
              <p className="mt-1.5 text-[10px] leading-tight text-amber-600">
                Start and end frames have different aspect ratios (
                {formatRatio(startEndMismatch.s.w, startEndMismatch.s.h)} vs{" "}
                {formatRatio(startEndMismatch.e.w, startEndMismatch.e.h)}).
                Output will likely be distorted — use frames with matching
                dimensions.
              </p>
            ) : undefined
          }
        >
          {(["start", "end"] as const).map((slot, slotIdx) => {
            const endpointSlot = slot === "start" ? "startFrame" : "endFrame";
            const input = nativeDraft?.projection?.revision.persistentInputRefs.find((ref) => ref.slot === endpointSlot);
            const assetId = input && "kind" in input.target && input.target.kind === "media" ? input.target.projectAssetId : null;
            const nodeId = nativeDraft ? getNodes().find((node) => assetId && referenceAssetId(node) === assetId)?.id : refNodeIds[slotIdx];
            const node = nodeId ? getNode(nodeId) : undefined;
            const thumb = nodeId ? refThumbByNodeId.get(nodeId) : undefined;
            const badge = slot === "start" ? "S" : "E";
            const fullLabel = slot === "start" ? "Start" : "End";

            return (
              <Fragment key={slot}>
                {slotIdx === 1 && (
                  <span
                    className="text-slate-700 dark:text-slate-300 text-xs select-none px-0.5"
                    aria-hidden
                  >
                    ⇌
                  </span>
                )}
                <div role="listitem">
                  <FrameReferenceSlot
                    badge={badge}
                    filled={Boolean(node)}
                    label={fullLabel}
                    thumb={thumb}
                    onRemove={
                      !isCheckpointLocked && nodeId
                        ? () => removeRefNode(nodeId, nativeDraft ? endpointSlot : undefined)
                        : undefined
                    }
                    removeLabel={`Clear ${fullLabel} frame`}
                    emptyControl={
                      node ? undefined : (
                        <Popover
                          open={refPickerTarget === slot}
                          onOpenChange={(open) =>
                            setRefPickerTarget(open ? slot : null)
                          }
                        >
                          <PopoverTrigger asChild>
                            <IconButton
                              label={`Pick ${fullLabel} frame`}
                              icon={<Plus size={14} weight="bold" />}
                              size="lg"
                              shape="rounded"
                              disabled={isCheckpointLocked}
                              className="h-10 min-h-10 w-10 min-w-10 rounded-lg border border-dashed border-warm-border bg-warm-surface text-content-secondary shadow-sm hover:border-brand/45 hover:bg-warm-muted hover:text-content-primary"
                            />
                          </PopoverTrigger>
                          <PopoverContent
                            side="top"
                            align="start"
                            className="z-[9999] w-[320px] overflow-hidden rounded-xl p-0"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <RefPickerContent
                              projectId={projectId}
                              candidates={refPickerCandidates}
                              onPick={(nid) => {
                                attachRefToSlot(nid, slot);
                                setRefPickerTarget(null);
                              }}
                            />
                          </PopoverContent>
                        </Popover>
                      )
                    }
                  />
                </div>
              </Fragment>
            );
          })}
        </FrameReferenceStrip>
      ) : (
        acceptsAnyRef && (
          <div className="pointer-events-auto mb-2 px-1 relative">
            <div className="flex items-center gap-1.5">
              <Reorder.Group
                axis="x"
                values={refNodeIds}
                onReorder={persistRefOrder}
                className="flex gap-1.5"
                as="div"
              >
                {refNodeIds.map((nodeId, i) => {
                  const node = getNode(nodeId);
                  if (!node) return null;
                  // The current Host resolves the stable Project Asset identity
                  // above. A video whose bytes are not ready yet renders as an
                  // icon tile via the `isVideo` fallback below.
                  const thumb = refThumbByNodeId.get(nodeId);
                  const isText = node.type === "text";
                  const isAudio = node.type === "audio";
                  const isVideo = node.type === "video";
                  if (!thumb && !isText && !isAudio && !isVideo) return null;
                  const badge = `${i + 1}`;
                  return (
                    <Reorder.Item
                      key={nodeId}
                      value={nodeId}
                      drag={isCheckpointLocked ? false : "x"}
                      as="div"
                      className="relative group/thumb flex-shrink-0"
                      whileDrag={{ scale: 1.08, zIndex: 10 }}
                      style={{
                        cursor: isCheckpointLocked ? "default" : "grab",
                      }}
                    >
                      {isText ? (
                        <div className="h-10 w-10 rounded-lg bg-warm-muted border border-warm-border shadow-sm flex items-center justify-center text-slate-700 dark:text-slate-300 pointer-events-none">
                          <TextT size={16} weight="bold" />
                        </div>
                      ) : isAudio ? (
                        <div className="h-10 w-10 rounded-lg bg-audio/15 border border-warm-border shadow-sm flex items-center justify-center text-audio text-lg pointer-events-none">
                          ♪
                        </div>
                      ) : isVideo && !thumb ? (
                        <div className="h-10 w-10 rounded-lg bg-video/15 border border-warm-border shadow-sm flex items-center justify-center text-video pointer-events-none">
                          <VideoCamera size={14} weight="bold" />
                        </div>
                      ) : (
                        <ProjectedImage
                          src={thumb!}
                          alt={(node.data.label as string) || nodeId}
                          className="h-10 w-10 rounded-lg object-cover border border-warm-border shadow-sm pointer-events-none"
                        />
                      )}
                      <span className="clash-node-ref-index absolute -top-1 -left-1 text-[9px] font-bold rounded px-1 min-w-[14px] text-center leading-[14px] pointer-events-none">
                        {badge}
                      </span>
                      {!isCheckpointLocked && (
                        <IconButton
                          label={`Remove reference ${i + 1}`}
                          icon="×"
                          size="sm"
                          shape="circle"
                          onClick={() => removeRefNode(nodeId)}
                          className={`${NODE_INTERACTION_BOUNDARY_CLASS} clash-node-ref-remove absolute -top-1 -right-1 hidden h-5 min-h-5 w-5 min-w-5 text-[11px] leading-none group-hover/thumb:flex`}
                        />
                      )}
                    </Reorder.Item>
                  );
                })}
              </Reorder.Group>
              {!isCheckpointLocked && (
                <Popover
                  open={refPickerTarget === "append"}
                  onOpenChange={(open) =>
                    setRefPickerTarget(open ? "append" : null)
                  }
                >
                  <PopoverTrigger asChild>
                    <IconButton
                      label="Add reference from canvas"
                      icon={<Plus size={14} weight="bold" />}
                      size="lg"
                      shape="rounded"
                      className="h-10 min-h-10 w-10 min-w-10 flex-shrink-0 rounded-lg border border-dashed border-warm-border bg-warm-surface text-content-secondary shadow-sm hover:border-brand/45 hover:bg-warm-muted hover:text-content-primary"
                    />
                  </PopoverTrigger>
                  <PopoverContent
                    side="top"
                    align="start"
                    className="z-[9999] w-[320px] overflow-hidden rounded-xl p-0"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <RefPickerContent
                      projectId={projectId}
                      candidates={refPickerCandidates}
                      onPick={(nid) => {
                        attachRefToSlot(nid, "append");
                        setRefPickerTarget(null);
                      }}
                    />
                  </PopoverContent>
                </Popover>
              )}
            </div>
          </div>
        )
      )}

      <div
        className="pointer-events-auto w-full rounded-2xl bg-warm-surface shadow-2xl border border-warm-border overflow-visible"
        onClick={() => {
          setParamsPopoverOpen(false);
          setAspectRatioPopoverOpen(false);
        }}
      >
        {/* Prompt editor with inline @ mention chips. Materialized
                        checkpoints render read-only because downstream lineage
                        now depends on these inputs. */}
        <div className="relative px-4 pt-3 pb-4 nodrag">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-content-secondary">
            Prompt
          </div>
          {!isCustom && nativeDraft?.projection?.revision.state.contentParts !== undefined ? <NativeOrderedPrompt
            state={nativeDraft.projection.revision.state} disabled={isCheckpointLocked} edit={nativeDraft.edit}
          /> : <div
            ref={editorRef}
            aria-label="Prompt"
            contentEditable={!isCheckpointLocked}
            suppressContentEditableWarning
            className={`${NODE_INTERACTION_BOUNDARY_CLASS} w-full max-h-[40vh] overflow-y-auto text-sm focus:outline-none leading-relaxed empty:before:content-[attr(data-placeholder)] empty:before:text-stone-400 ${
              isCheckpointLocked
                ? "text-stone-700 dark:text-stone-300 cursor-default select-text"
                : "text-slate-900 dark:text-slate-50"
            }`}
            style={{ minHeight: "3em" }}
            data-placeholder="Describe anything you want to generate... (@ to ref assets)"
            onInput={isCheckpointLocked ? undefined : handleEditorInput}
            onKeyDown={isCheckpointLocked ? undefined : handleEditorKeyDown}
          />}
          {showMentionMenu && filteredMentionNodes.length > 0 && (
            <ActionMentionPicker
              nodes={filteredMentionNodes}
              store={mentionCombobox}
            />
          )}
        </div>

        {isMusicModel && (
          <div className="border-t border-warm-border px-4 py-3 nodrag">
            <label
              htmlFor={`action-lyrics-${id}`}
              className="mb-2 block text-[10px] font-semibold uppercase tracking-wide text-content-secondary"
            >
              Lyrics
            </label>
            <Textarea
              id={`action-lyrics-${id}`}
              aria-label="Lyrics"
              value={lyrics}
              onChange={(event) => updateLyrics(event.target.value)}
              disabled={isCheckpointLocked}
              maxLength={selectedModel?.musicInput?.maxLyricsCharacters}
              placeholder="Write lyrics..."
              controlSize="lg"
              className={`${NODE_INTERACTION_BOUNDARY_CLASS} min-h-24 resize-y leading-relaxed disabled:cursor-default`}
            />
          </div>
        )}

        {/* Bottom toolbar: model selector + clickable param chips */}
        <div className="flex items-center gap-1.5 px-3 pb-3 flex-nowrap overflow-visible">
          {/* Model / Custom Action selector. Keep it available when
                            the current custom runtime is offline so the user can
                            switch back to another model or installed action. */}
          <div
            className="relative"
            style={customActionOffline ? { opacity: 0.5 } : undefined}
          >
            {modelUnavailable && availableModels.length === 0 && configureModels ? (
              <Button size="sm" shape="pill" onClick={(event) => { event.stopPropagation(); configureModels(); }}>Configure models in Settings</Button>
            ) : <Tooltip label={modelPickerLabel}>
              <span className="inline-flex min-w-0">
                <SelectMenu<string>
                  className="relative"
                  triggerClassName="px-2.5 py-1 text-xs"
                  value={
                    isCustom ? `action:${customActionId}` : `model:${modelId}`
                  }
                  options={generationChoices.map((choice) => ({
                    value: choice.value,
                    label: choice.label,
                    description:
                      choice.kind === "action"
                        ? `Custom Action · ${choice.description ?? "Marketplace integration"}`
                        : getModelDropdownSecondaryText(true),
                  }))}
                  onValueChange={(nextChoice) => {
                    void handleGenerationChoiceChange(nextChoice);
                    setParamsPopoverOpen(false);
                    setAspectRatioPopoverOpen(false);
                  }}
                  ariaLabel="Model"
                  triggerLabel={modelDisplay}
                  triggerPrefix={
                    <Icon size={12} weight="bold" className={colorClass} />
                  }
                  variant="pill"
                  size="sm"
                  placement="top"
                  menuWidth={240}
                  maxMenuHeight={192}
                  stopPropagation
                />
              </span>
            </Tooltip>}
            {customActionOffline && (
              <span className="ml-2 text-[10px] text-slate-700 dark:text-slate-300 align-middle">
                {RUNTIME_OFFLINE_LABEL}
              </span>
            )}
          </div>

          {/* Aspect ratio is a first-class toolbar control. It opens
                            its own secondary panel instead of hiding inside the
                            generic parameter accordion. */}
          {!modelUnavailable && aspectRatioParameter && (
            <Popover
              open={aspectRatioPopoverOpen}
              onOpenChange={(nextOpen) => {
                setAspectRatioPopoverOpen(nextOpen);
                if (!nextOpen) setAspectRatioPopoverValue(undefined);
                if (nextOpen) setParamsPopoverOpen(false);
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  aria-label={`${aspectRatioParameter.label}: ${aspectRatioCurrentLabel}`}
                  disabled={
                    aspectRatioParameter.readOnly ||
                    unavailableParameterIds.has(aspectRatioParameter.id)
                  }
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs transition-colors ${
                    aspectRatioPopoverOpen
                      ? "bg-warm-hover text-slate-900 dark:text-slate-50"
                      : "bg-warm-muted hover:bg-warm-hover text-stone-700 dark:text-stone-300"
                  } h-auto min-h-0 border-0 shadow-none`}
                  onClick={(event) => event.stopPropagation()}
                >
                  <span className="font-medium text-current">
                    {aspectRatioCurrentLabel}
                  </span>
                  <CaretDown
                    size={10}
                    weight="bold"
                    className="text-stone-700 dark:text-stone-300"
                  />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="start"
                sideOffset={-16}
                data-aspect-ratio-popover={
                  aspectRatioEditorVisible ? "editable" : "automatic"
                }
                style={{
                  width: aspectRatioEditorVisible ? "32.5rem" : "22rem",
                }}
                className="z-[9999] max-w-[calc(100vw-2rem)] overflow-hidden rounded-[14px] p-5 transition-[width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                <div className="text-[15px] font-medium tracking-[-0.012em] text-content-primary">
                  Aspect ratio
                </div>
                <div className="mt-2.5">
                  <AspectRatioPicker<string | number>
                    allowCustom={aspectRatioParameter.allowCustom}
                    ariaLabel="Model aspect ratio"
                    options={actionAspectRatioOptions}
                    value={aspectRatioPresentedValue as string | number}
                    onValueChange={(nextValue) => {
                      setAspectRatioPopoverValue(nextValue);
                      updateModelParam(aspectRatioParameter.id, nextValue);
                    }}
                  />
                </div>
              </PopoverContent>
            </Popover>
          )}

          {/* Remaining parameters share the compact generic panel. */}
          {!modelUnavailable && secondaryParameters.length > 0 && (
            <Popover
              open={paramsPopoverOpen}
              onOpenChange={(nextOpen) => {
                setParamsPopoverOpen(nextOpen);
                if (nextOpen) setAspectRatioPopoverOpen(false);
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  aria-label="Parameters"
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs transition-colors ${
                    paramsPopoverOpen
                      ? "bg-warm-hover text-slate-900 dark:text-slate-50"
                      : "bg-warm-muted hover:bg-warm-hover text-stone-700 dark:text-stone-300"
                  } h-auto min-h-0 border-0 shadow-none`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="font-medium text-current">
                    {secondaryParamChips
                      .map((c) => c.value)
                      .filter(Boolean)
                      .join(" · ") || "Parameters"}
                  </span>
                  <CaretDown
                    size={10}
                    weight="bold"
                    className="text-stone-700 dark:text-stone-300"
                  />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="start"
                className="z-[9999] min-w-[240px] overflow-hidden rounded-2xl p-0"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <Accordion type="single" collapsible>
                  {secondaryParameters.map((param: any, idx: number) => {
                    const p = param as ModelParameter;
                    const unavailable = unavailableParameterIds.has(p.id);
                    const currentVal =
                      (isCustom ? customActionParams : modelParams)[p.id] ??
                      p.defaultValue;
                    const currentLabel =
                      p.type === "select"
                        ? (p.options?.find(
                            (o) => String(o.value) === String(currentVal),
                          )?.label ?? String(currentVal))
                        : p.type === "boolean"
                          ? currentVal
                            ? "On"
                            : "Off"
                          : currentVal === undefined || currentVal === ""
                            ? "Default"
                            : String(currentVal);
                    const sliderValue =
                      p.type === "slider"
                        ? normalizeSliderValue(currentVal, p.min ?? 0)
                        : 0;
                    return (
                      <AccordionItem
                        key={p.id}
                        value={p.id}
                        className={idx > 0 ? "border-t border-warm-border" : ""}
                      >
                        <AccordionTrigger asChild>
                          <Button
                            size="sm"
                            shape="rounded"
                            disabled={p.readOnly || unavailable}
                            className="group w-full justify-between rounded-none border-0 bg-transparent px-4 py-2.5 shadow-none hover:bg-warm-muted"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <span className="flex items-center gap-1.5 text-xs text-stone-700 dark:text-stone-300">
                              {p.label}
                              {(p.readOnly || unavailable) && (
                                <span className="rounded-full bg-warm-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">
                                  {unavailable ? "Unavailable" : "Fixed"}
                                </span>
                              )}
                            </span>
                            <span className="flex items-center gap-1 text-xs font-semibold text-slate-900 dark:text-slate-50">
                              {currentLabel}
                              <CaretDown
                                size={10}
                                weight="bold"
                                className="text-stone-700 transition-transform group-data-[state=open]:rotate-180 dark:text-stone-300"
                              />
                            </span>
                          </Button>
                        </AccordionTrigger>
                        <AccordionContent>
                          <div className="px-3 pb-3">
                            {p.type === "select" && (
                              <SelectMenu<SelectValue>
                                ariaLabel={p.label}
                                value={currentVal as SelectValue}
                                options={paramOptionsToSelectOptions(p)}
                                onValueChange={(nextValue) =>
                                  updateModelParam(p.id, nextValue)
                                }
                                triggerLabel={currentLabel}
                                variant="field"
                                placement="bottom"
                                menuWidth="trigger"
                                stopPropagation
                              />
                            )}
                            {p.type === "boolean" && (
                              <SelectMenu<boolean>
                                ariaLabel={p.label}
                                value={Boolean(currentVal)}
                                options={PARAM_BOOLEAN_OPTIONS}
                                onValueChange={(nextValue) =>
                                  updateModelParam(p.id, nextValue)
                                }
                                triggerLabel={currentLabel}
                                variant="field"
                                placement="bottom"
                                menuWidth="trigger"
                                stopPropagation
                              />
                            )}
                            {p.type === "number" && (
                              <Input
                                type="number"
                                min={p.min}
                                max={p.max}
                                step={p.step}
                                value={currentVal as number}
                                onChange={(e) =>
                                  updateModelParam(p.id, Number(e.target.value))
                                }
                                className={`${NODE_INTERACTION_BOUNDARY_CLASS} w-full text-xs border border-warm-border rounded-lg px-3 py-2 focus:outline-none focus:border-ring/70`}
                                onClick={(e) => e.stopPropagation()}
                              />
                            )}
                            {p.type === "text" && (
                              <Input
                                aria-label={p.label}
                                type="text"
                                value={
                                  typeof currentVal === "string"
                                    ? currentVal
                                    : ""
                                }
                                placeholder={p.placeholder}
                                onChange={(event) =>
                                  updateModelParam(p.id, event.target.value)
                                }
                                className={`${NODE_INTERACTION_BOUNDARY_CLASS} w-full rounded-lg border border-warm-border px-3 py-2 text-xs focus:border-ring/70 focus:outline-none`}
                                onClick={(event) => event.stopPropagation()}
                              />
                            )}
                            {p.type === "slider" && (
                              <div
                                className="space-y-1.5"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <div className="flex justify-between text-[10px] text-stone-700 dark:text-stone-300">
                                  <span>{p.min}</span>
                                  <span className="font-semibold text-slate-900 dark:text-slate-50">
                                    {sliderValue}
                                  </span>
                                  <span>{p.max}</span>
                                </div>
                                <ModelParamSlider
                                  ariaLabel={p.label}
                                  min={p.min}
                                  max={p.max}
                                  step={p.step}
                                  value={sliderValue}
                                  onChange={(nextValue) =>
                                    updateModelParam(p.id, nextValue)
                                  }
                                  trackClassName="bg-warm-hover"
                                />
                              </div>
                            )}
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    );
                  })}
                </Accordion>
              </PopoverContent>
            </Popover>
          )}

          {/* Spacer */}
          <div className="flex-1 min-w-[8px]" />

          {/* Batch count chip (xN). Stays interactive even when checkpoint-locked —
                            user can bump the count and then Run to spawn more siblings. */}
          {!isCustom && !modelUnavailable && (
            <SelectMenu<number>
              ariaLabel="Batch count"
              value={countValue}
              options={BATCH_COUNT_OPTIONS}
              onValueChange={(nextCount) =>
                updateModelParam("count", nextCount)
              }
              triggerLabel={`x${countValue}`}
              variant="pill"
              size="sm"
              align="end"
              placement="top"
              menuWidth={80}
              maxMenuHeight={176}
              showCaret
              stopPropagation
              triggerClassName="h-auto min-h-0 px-2.5 py-1 text-xs"
            />
          )}

          {/* Materialized-checkpoint lock: Run again or copy into a fresh revision. */}
          {isCheckpointLocked && (
            <>
              <Tooltip label={nativeDraft ? "Create an independent Generator copy" : "Duplicate this panel and open the copy"}>
                <Button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCopy();
                  }}
                  disabled={isExecuting}
                  leftIcon={<Copy size={12} weight="bold" />}
                  size="sm"
                  shape="pill"
                  className="h-7 min-h-7 flex-shrink-0 border-0 bg-warm-muted px-2.5 text-xs font-medium text-stone-800 shadow-none hover:bg-warm-hover dark:text-stone-200"
                  aria-label={nativeDraft ? "Create an independent Generator copy" : "Duplicate this panel and open the copy"}
                >
                  {nativeDraft ? "Copy" : "Copy & open"}
                </Button>
              </Tooltip>
              <Tooltip label={modelUnavailable ? modelUnavailableReason : checkpointRunLabel}>
                <span className="inline-flex flex-shrink-0">
                  <Button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (
                        modelUnavailable ||
                      customActionOffline ||
                        customActionDefinitionUpdated
                      )
                        return;
                      handleExecute();
                    }}
                    disabled={
                      isExecuting ||
                      modelUnavailable ||
                      customActionOffline ||
                      customActionDefinitionUpdated ||
                      !!referenceValidationError
                    }
                    leftIcon={
                      isExecuting ? (
                        <Spinner
                          size={12}
                          weight="bold"
                          className="animate-spin"
                        />
                      ) : (
                        <Play size={11} weight="fill" />
                      )
                    }
                    size="sm"
                    shape="pill"
                    className="clash-node-primary h-7 min-h-7 flex-shrink-0 px-3 text-xs font-semibold"
                    aria-label={checkpointRunLabel}
                    aria-disabled={
                      modelUnavailable ||
                      customActionOffline ||
                      customActionDefinitionUpdated ||
                      !!referenceValidationError ||
                      undefined
                    }
                  >
                    Run
                  </Button>
                </span>
              </Tooltip>
            </>
          )}
        </div>
      </div>
    </motion.div>
  );

  return (
    <>
      {/* Outer width matches the capsule so left/right handles snap to
                the visible edges. Without `w-[260px]`, the wrapper inherits
                the wider React Flow bounding rect and the handle floats. */}
      <div className="group relative w-[260px]">
        {/* Peer selection rings — drawn behind the capsule. Local
                        blue ring is inset on the capsule itself, so peer rings
                        on the outside don't visually fight it. */}
        <PeerSelectionRing peers={peersSelecting} />

        <div
          className={`w-[260px] ${bgClass} rounded-xl overflow-hidden transition-all duration-300 hover:shadow-lg ${
            selected
              ? `ring-4 ${ringClass} ring-offset-2`
              : "ring-1 ring-slate-200"
          }`}
        >
          <div className="flex items-stretch">
            <Button
              aria-label="Configure action"
              size="sm"
              shape="rounded"
              onClick={(event) => {
                event.stopPropagation();
                selectAction();
                openActionPanel();
              }}
              className="h-auto min-h-0 min-w-0 flex-1 cursor-pointer justify-start gap-2.5 rounded-none border-0 bg-transparent px-3.5 py-4 text-left shadow-none hover:bg-transparent focus-visible:ring-inset"
            >
              <div className={`flex-shrink-0 ${colorClass}`}>
                <Icon size={16} weight="fill" />
              </div>
              <div className="flex flex-col min-w-0 flex-1">
                <span
                  className={`text-xs font-bold font-display ${colorClass} truncate`}
                >
                  {label || "Action"}
                </span>
                <span className="text-[10px] text-slate-700 dark:text-slate-300 truncate leading-none">
                  {modelUnavailable ? "No available model selected" : badgeDisplayName}
                </span>

                {/* Phase 0 attribution — only renders when actor info is populated. */}
                <AttributionLine
                  actorType={data.actorType as "user" | "agent" | undefined}
                  actorUserId={data.actorUserId as string | undefined}
                  actorAgentId={data.actorAgentId as string | undefined}
                />
              </div>
            </Button>
            <div className="flex flex-shrink-0 items-center pr-3.5">
              {/* Run button — separate click target */}
              <Tooltip label={modelUnavailable ? modelUnavailableReason : panelRunLabel}>
                <span className="inline-flex flex-shrink-0">
                  <Button
                    className={`nodrag h-7 min-h-7 flex-shrink-0 rounded-lg px-3 text-xs font-semibold text-white transition-transform hover:scale-[1.02] active:scale-95 ${btnClass}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (
                        modelUnavailable ||
                      customActionOffline ||
                        customActionDefinitionUpdated
                      )
                        return;
                      handleExecute();
                    }}
                    disabled={
                      isExecuting ||
                      modelUnavailable ||
                      customActionOffline ||
                      customActionDefinitionUpdated ||
                      !!referenceValidationError
                    }
                    aria-label={panelRunLabel}
                    aria-disabled={
                      modelUnavailable ||
                      customActionOffline ||
                      customActionDefinitionUpdated ||
                      !!referenceValidationError ||
                      undefined
                    }
                    leftIcon={
                      isExecuting ? (
                        <Spinner size={12} className="animate-spin" />
                      ) : (
                        <Play size={12} weight="fill" />
                      )
                    }
                    size="sm"
                    shape="rounded"
                  >
                    {isExecuting ? "Running" : "Run"}
                  </Button>
                </span>
              </Tooltip>
            </div>
          </div>

          {customActionDefinitionUpdated && (
            <div
              role="alert"
              className="flex items-center justify-between gap-2 border-t border-amber-200/70 px-3 py-2 text-[10px] leading-tight text-amber-800 dark:border-amber-800/60 dark:text-amber-300"
            >
              <span>{ACTION_DEFINITION_UPDATED_LABEL}</span>
              <Button
                aria-label={
                  isCheckpointLocked ? "Copy to update" : "Update action"
                }
                size="sm"
                shape="pill"
                className="h-6 min-h-6 border border-amber-300 bg-transparent px-2 text-[10px] text-amber-900 shadow-none hover:bg-amber-100 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-950/40"
                onClick={(event) => {
                  event.stopPropagation();
                  if (isCheckpointLocked) {
                    void handleCopy();
                    return;
                  }
                  handleUpdateCustomAction();
                }}
              >
                {isCheckpointLocked ? "Update copy" : "Update"}
              </Button>
            </div>
          )}

          {(referenceValidationError || error) && (
            <div
              role="alert"
              className="px-3 pb-2 text-[10px] leading-tight text-red-500"
            >
              {referenceValidationError || error}
            </div>
          )}
        </div>

        {/* Handles */}
        <Handle
          type="target"
          position={Position.Left}
          style={{
            left: -8,
            top: "50%",
            transform: "translateY(-50%)",
            zIndex: 100,
          }}
          className="!h-4 !w-4 !border-4 !border-warm-surface !bg-stone-400 transition-all hover:scale-125 shadow-sm hover:!bg-brand"
        />
        <ActionBadgePipelineMenu
          nodeId={id}
          spawnDraft={spawnDraft}
          canSpawn={canSpawn}
          disabledReason={disabledReason}
          outputKind={outputKind}
        />
      </div>
      <NodeToolbar
        nodeId={id}
        isVisible={showPanel}
        position={Position.Bottom}
        align="center"
        offset={12}
        className="nodrag nopan nowheel pointer-events-auto z-[9998]"
        style={{ zIndex: 9998 }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {configPanel}
      </NodeToolbar>

      {modalContent}
      {keyframeTimelineDialog}
    </>
  );
};

// Reduce raw W/H dimensions to a simplest-form "W:H" label via GCD. Works
// because image/video natural dims are integers, so common ratios collapse
// cleanly (1920×1080 → 16:9) without any hardcoded table of "known" ratios.
function formatRatio(w: number, h: number): string {
  const a = Math.max(1, Math.round(w));
  const b = Math.max(1, Math.round(h));
  const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x);
  const g = gcd(a, b);
  return `${a / g}:${b / g}`;
}

const RefPickerContent = ({
  projectId,
  candidates,
  onPick,
  title = "Pick a canvas asset",
}: {
  projectId: string;
  candidates: RFNode[];
  onPick: (nodeId: string) => void;
  title?: string;
}) => {
  return (
    <>
      <div className="px-3 py-2 text-[11px] font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide border-b border-warm-border">
        {title}
      </div>
      {candidates.length === 0 ? (
        <div className="px-3 py-6 text-xs text-slate-700 dark:text-slate-300 text-center">
          No eligible canvas nodes available.
        </div>
      ) : (
        <div className="max-h-60 overflow-y-auto p-2 grid grid-cols-4 gap-2">
          {candidates.map((n) => (
            <RefPickerOptionButton
              key={n.id}
              projectId={projectId}
              node={n}
              onPick={onPick}
            />
          ))}
        </div>
      )}
    </>
  );
};

function RefPickerOptionButton({
  projectId,
  node,
  onPick,
}: {
  projectId: string;
  node: RFNode;
  onPick: (nodeId: string) => void;
}) {
  const asset = useAsset(projectId, referenceAssetId(node));
  const modality = referenceModality(node);
  const thumb = asset ? assetThumbnailImageUrl(asset) : null;
  const label = (node.data?.label as string) || node.id;
  const handlePick = useCallback(() => {
    onPick(node.id);
  }, [node.id, onPick]);

  return (
    <Tooltip label={label}>
      <Button
        onClick={handlePick}
        size="sm"
        shape="rounded"
        className="group relative h-auto min-h-0 overflow-hidden rounded-lg border border-warm-border bg-transparent p-0 shadow-none hover:border-slate-900 hover:bg-transparent hover:shadow-md"
        aria-label={label}
      >
        {node.type === "text" ? (
          <div className="h-16 w-full bg-warm-muted flex items-center justify-center text-slate-700 dark:text-slate-300">
            <TextT size={22} weight="bold" />
          </div>
        ) : node.type === "audio" ||
          (!thumb && modality !== "video") ||
          !asset ? (
          <div
            className={`h-16 w-full flex items-center justify-center text-xl ${node.type === "audio" ? "bg-audio/15 text-audio" : "bg-warm-muted text-slate-500"}`}
          >
            {node.type === "audio" ? "♪" : "?"}
          </div>
        ) : modality === "video" ? (
          <VideoPoster
            thumbnailSrc={asset.thumbnailUrl}
            videoSrc={asset.url}
            status={asset.status}
            alt={label}
            className="h-16 w-full object-cover"
            fallback={
              <div className="flex h-16 w-full items-center justify-center bg-video/15 text-video">
                <VideoCamera size={18} weight="bold" />
              </div>
            }
          />
        ) : (
          <ProjectedImage
            src={thumb ?? undefined}
            alt={label}
            className="h-16 w-full object-cover"
          />
        )}
        <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 py-1 text-[10px] text-white truncate">
          {label}
        </div>
      </Button>
    </Tooltip>
  );
}

function ActionBadgeNode(props: NodeProps<RFNode<Record<string, any>>>) {
  const { projectId } = useProject();
  const cards = useProjectCustomActions();
  const loroSync = useOptionalLoroSyncContext();
  const native = useNativeGeneratorDraft({ projectId, doc: loroSync?.doc ?? null,
    generatorId: typeof props.data.generatorId === "string" ? props.data.generatorId : null });
  if (!native) return <PromptActionNode {...props} />;
  if (native.error || !native.projection) return <div role="alert" className="rounded-xl border border-red-300 bg-warm-surface p-4 text-sm text-red-600">{native.error}</div>;
  let data: Record<string, unknown>;
  try {
    data = canvasModelGeneratorRevisionData(props.data, native.projection.revision);
    if (typeof props.data.actionCardId === "string") {
      const card = cards.find((entry) => entry.id === props.data.actionCardId);
      const ref = native.projection.revision.definitionRef;
      if (!card?.generator || card.pluginBinding?.pluginId !== ref.pluginId || card.generator.definitionId !== ref.definitionId) throw new Error("The Action Card for this Generator is unavailable.");
      data.pluginBinding = { pluginId: ref.pluginId, version: ref.version, schemaHash: ref.schemaHash, exportId: card.pluginBinding.exportId };
    }
  }
  catch (error) { return <div role="alert" className="rounded-xl border border-red-300 bg-warm-surface p-4 text-sm text-red-600">{error instanceof Error ? error.message : String(error)}</div>; }
  return <PromptActionNode {...props} data={data} nativeDraft={native} />;
}
export default memo(ActionBadgeNode);
