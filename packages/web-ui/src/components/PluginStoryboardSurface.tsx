import { GeneratorOutput } from "@clash/action-sdk/ui";
import type { PendingGeneratorOutput } from "@clash/shared-types";
import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowDown,
  ArrowUp,
  CaretDown,
  Check,
  DotsSixVertical,
  FilmSlate,
  Image as ImageIcon,
  MusicNotes,
  PencilSimple,
  Plus,
  Shapes,
  Sparkle,
  Trash,
  X,
} from "@phosphor-icons/react";
import {
  Fragment,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
  ProjectCanvas,
  ResolvedAsset,
  StoryboardViewItem,
  StoryboardViewMaterial,
  StoryboardViewResource,
  StoryboardViewShot,
  StoryboardViewState,
} from "@clash/shared-types";
import type { StoryboardGeneratorChoice } from "../lib/storyboardGenerator";
import { AssetThumbnail } from "../features/assets/AssetThumbnail";
import { projectAssetDisplayName } from "../features/assets/projectAssetPresentation";
import { projectAssetPlaybackUrl } from "../features/assets/media-url";
import { Button } from "./ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { Dialog } from "./ui/dialog";
import { IconButton } from "./ui/icon-button";
import { Tooltip } from "./ui/tooltip";
import { ParentCanvasButton } from "./ParentCanvasButton";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Textarea } from "./ui/textarea";
import { SelectMenu } from "./ui/select";
import { ScopedAssetPicker } from "./ScopedAssetPicker";
import { buildComposerAssetSections } from "./scopedAssetPickerModel";

type ItemSection = "keyElements" | "shots" | "audioLayers";
type Item = StoryboardViewItem | StoryboardViewShot;
type Target = { section: ItemSection; itemId: string; materialId: string };
type AttachmentTarget = { target: Target; draft?: StoryboardViewMaterial };
type Preview = { candidate: StoryboardViewResource; target?: Target };

export type StoryboardComposeRequest = {
  material: StoryboardViewMaterial;
  choice: StoryboardGeneratorChoice;
  mode: "new" | "edit" | "prompt" | "regenerate";
  candidate?: StoryboardViewResource;
};
export interface PluginStoryboardSurfaceProps {
  projectId: string;
  nodeId: string;
  label: string;
  headerEndInset?: number;
  state: StoryboardViewState;
  assets: readonly ResolvedAsset[];
  generators: readonly StoryboardGeneratorChoice[];
  onSave: (state: StoryboardViewState) => void;
  /** Adds an Asset identity to the current chat draft without running generation. */
  onReference?: (resource: StoryboardViewResource) => void;
  onGenerate: (
    material: StoryboardViewMaterial,
    choice: StoryboardGeneratorChoice,
  ) => Promise<StoryboardViewResource> | StoryboardViewResource;
  onCompose?: (
    request: StoryboardComposeRequest,
    callbacks: {
      onResult: (candidate: StoryboardViewResource) => void;
      onPending: (output: PendingGeneratorOutput) => void;
      onClose: () => void;
    },
  ) => Promise<ReactNode>;
  onUpload?: (file: File) => Promise<ResolvedAsset>;
  parentCanvas?: Pick<ProjectCanvas, "id" | "name">;
  onOpenCanvas: (canvasId: string) => void;
}

// Disclosure preferences belong to this machine's UI, not shared project facts.
const DisclosureScope = createContext("");
const OutputPreviewScope = createContext<
  (output: PendingGeneratorOutput) => void
>(() => {});
const OutputReadyScope = createContext<
  (output: PendingGeneratorOutput, asset: StoryboardViewResource) => void
>(() => {});
function useDisclosure(id: string, defaultOpen: boolean) {
  const scope = useContext(DisclosureScope);
  const key = `storyboard-disclosure:${scope}:${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? defaultOpen : saved === "true";
    } catch {
      return defaultOpen;
    }
  });
  return [
    open,
    (value: boolean) => {
      setOpen(value);
      try {
        localStorage.setItem(key, String(value));
      } catch {
        // Keep the controls usable when browser storage is unavailable.
      }
    },
  ] as const;
}
function SavedCollapsible({
  disclosureId,
  defaultOpen = true,
  ...props
}: ComponentProps<typeof Collapsible> & { disclosureId: string }) {
  const [open, onOpenChange] = useDisclosure(disclosureId, defaultOpen);
  return <Collapsible {...props} open={open} onOpenChange={onOpenChange} />;
}

const sectionMeta = {
  keyElements: {
    label: "Key elements",
    singular: "key element",
    hint: "Characters, places, and objects shared across your shots.",
    mediaKind: "image",
    icon: Shapes,
  },
  shots: {
    label: "Shots",
    singular: "shot",
    hint: "Build the sequence with a description and media for each shot.",
    mediaKind: "video",
    icon: FilmSlate,
  },
  audioLayers: {
    label: "Audio layers",
    singular: "audio layer",
    hint: "Voice, music, and sound, with timing and mix directions.",
    mediaKind: "audio",
    icon: MusicNotes,
  },
} as const;
const mediaLabels = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  model: "3D model",
};
const itemName = (item: Item) => item.label || item.id;
const materialName = (material: StoryboardViewMaterial) =>
  material.label || mediaLabels[material.mediaKind];
const nextId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const targetKey = (target: Target) => JSON.stringify(target);
function findMaterial(state: StoryboardViewState, target?: Target) {
  return (
    target &&
    state[target.section]
      .find((item) => item.id === target.itemId)
      ?.materials.find((material) => material.id === target.materialId)
  );
}
function candidateName(
  candidate: StoryboardViewResource,
  assets: readonly ResolvedAsset[],
) {
  if (candidate.generatedBy) {
    return `Generated ${mediaLabels[candidate.mediaKind].toLowerCase()}`;
  }
  const asset = assets.find((entry) => entry.id === candidate.projectAssetId);
  return asset
    ? projectAssetDisplayName(asset)
    : candidate.modelName || mediaLabels[candidate.mediaKind];
}

function CandidateCard({
  candidate,
  assets,
  selected,
  onPreview,
}: {
  candidate: StoryboardViewResource;
  assets: readonly ResolvedAsset[];
  selected?: boolean;
  onPreview: () => void;
}) {
  const asset = assets.find((entry) => entry.id === candidate.projectAssetId);
  const label = candidateName(candidate, assets);
  return (
    <Button
      variant={null}
      size={null}
      shape={null}
      aria-label={`Preview ${label}`}
      onClick={onPreview}
      className={`clash-storyboard-candidate relative shrink-0 flex-col text-left ${selected ? "border-ring bg-accent" : "border-transparent hover:bg-warm-hover"}`}
    >
      <span className="clash-storyboard-candidate-image relative block w-full">
        <AssetThumbnail
          kind={candidate.mediaKind}
          src={asset ? (projectAssetPlaybackUrl(asset) ?? "") : ""}
          thumbnailSrc={asset?.thumbnailUrl}
          status={asset?.status}
          label={label}
          variant="card"
          decorative
        />
        {selected && (
          <span
            className="absolute right-1 top-1 rounded bg-background p-0.5 text-foreground"
            aria-label="Selected version"
          >
            <Check className="h-3 w-3" weight="bold" />
          </span>
        )}
      </span>
      <span className="w-full truncate text-xs text-content-secondary">
        {label}
      </span>
    </Button>
  );
}

function AddItem({
  section,
  onAdd,
}: {
  section: ItemSection;
  onAdd: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const label = `Add ${sectionMeta[section].singular}`;
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        setName("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant={null}
          size="sm"
          aria-label={label}
          className="w-full justify-start text-content-secondary hover:bg-warm-hover"
          leftIcon={<Plus className="h-3.5 w-3.5" />}
        >
          Add {sectionMeta[section].singular}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            onAdd(name.trim());
            setOpen(false);
            setName("");
          }}
        >
          <label className="block space-y-1 text-xs font-medium">
            <span>Name</span>
            <Input
              aria-label="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={`Name this ${sectionMeta[section].singular}`}
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              type="submit"
              variant="primary"
              disabled={!name.trim()}
            >
              Add
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function ItemDetails({
  entityNames,
  item,
  section,
  onSave,
}: {
  entityNames: ReadonlyMap<string, string>;
  item: Item;
  section: ItemSection;
  onSave: (item: Item) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(item);
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) setDraft(structuredClone(item));
      }}
    >
      <PopoverTrigger asChild>
        <IconButton
          label={`Edit ${itemName(item)}`}
          size="sm"
          icon={<PencilSimple className="h-3.5 w-3.5" />}
        />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[75vh] w-80 overflow-y-auto p-4"
      >
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!(draft.label ?? draft.id).trim()) return;
            onSave({
              ...item,
              label: (draft.label ?? draft.id).trim(),
              description: draft.description,
              details: draft.details,
              ...(section === "shots" && "durationSeconds" in draft
                ? { durationSeconds: draft.durationSeconds }
                : {}),
            });
            setOpen(false);
          }}
        >
          <label className="block space-y-1 text-xs">
            <span>Name</span>
            <Input
              aria-label={`Name for ${itemName(item)}`}
              value={draft.label ?? draft.id}
              onChange={(event) =>
                setDraft({ ...draft, label: event.target.value })
              }
            />
          </label>
          <div className="space-y-2 text-xs">
            <span>Description</span>
            {(draft.description.length
              ? draft.description
              : [{ type: "text" as const, text: "" }]
            ).map((part, index) =>
              part.type === "entity-reference" ? (
                <span key={index} className="block text-content-secondary">
                  @{entityNames.get(part.entityId) ?? part.entityId}
                </span>
              ) : (
                <Textarea
                  key={index}
                  aria-label={`Description text ${index + 1} for ${itemName(item)}`}
                  rows={3}
                  value={part.text}
                  onChange={(event) => {
                    const description = draft.description.length
                      ? [...draft.description]
                      : [{ type: "text" as const, text: "" }];
                    description[index] = {
                      type: "text",
                      text: event.target.value,
                    };
                    setDraft({ ...draft, description });
                  }}
                />
              ),
            )}
          </div>
          {section === "shots" && (
            <label className="block space-y-1 text-xs">
              <span>Duration (seconds)</span>
              <Input
                aria-label={`Duration for ${itemName(item)}`}
                type="number"
                min="0.1"
                step="any"
                value={
                  "durationSeconds" in draft
                    ? (draft.durationSeconds ?? "")
                    : ""
                }
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    durationSeconds: event.target.value
                      ? Number(event.target.value)
                      : undefined,
                  })
                }
              />
            </label>
          )}
          <label className="block space-y-1 text-xs">
            <span>
              {section === "audioLayers" ? "Timing and mix direction" : "Notes"}
            </span>
            <Textarea
              aria-label={`Direction for ${itemName(item)}`}
              rows={2}
              value={draft.details ?? ""}
              onChange={(event) =>
                setDraft({ ...draft, details: event.target.value })
              }
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={!(draft.label ?? draft.id).trim()}
            >
              Save details
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function MaterialRow({
  material,
  assets,
  onPreview,
  onOpen,
}: {
  material: StoryboardViewMaterial;
  assets: readonly ResolvedAsset[];
  onPreview: (candidate: StoryboardViewResource) => void;
  onOpen: () => void;
}) {
  const onOutputReady = useContext(OutputReadyScope);
  const onPendingPreview = useContext(OutputPreviewScope);
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (material.pendingOutputs?.length && strip.current)
      strip.current.scrollLeft = strip.current.scrollWidth;
  }, [material.pendingOutputs?.length]);
  // Old Add media clicks persisted empty default slots. Keep their data, but
  // only show an empty slot when it carries an intentional label or prompt.
  if (!material.candidates.length && !material.pendingOutputs?.length) {
    if (
      (!material.label || material.label === mediaLabels[material.mediaKind]) &&
      !material.promptDraft?.text.trim()
    )
      return null;
    return (
      <Button
        variant={null}
        size="sm"
        onClick={onOpen}
        leftIcon={<Plus className="h-3.5 w-3.5" />}
      >
        Add {materialName(material)}
      </Button>
    );
  }
  return (
    <div
      role="group"
      aria-label={`${materialName(material)} media`}
      className="space-y-2"
    >
      <button
        type="button"
        onClick={onOpen}
        className="text-xs font-medium text-content-secondary hover:text-content-primary"
      >
        {materialName(material)}
      </button>
      {material.candidates.length || material.pendingOutputs?.length ? (
        <div ref={strip} className="flex gap-2 overflow-x-auto pb-1">
          {material.candidates.map((candidate) => (
            <CandidateCard
              key={candidate.id}
              candidate={candidate}
              assets={assets}
              selected={material.selectedCandidateId === candidate.id}
              onPreview={() => onPreview(candidate)}
            />
          ))}
          {material.pendingOutputs?.map((output) => (
            <GeneratorOutput
              key={output.actionRunId + output.outputSlot}
              output={output}
              onPreview={() => onPendingPreview(output)}
              onReady={(asset) => onOutputReady(output, asset)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StoryboardItemCard({
  entityNames,
  onOpenMaterial,
  item,
  section,
  assets,
  generators,
  busy,
  active,
  onChange,
  onDelete,
  onGenerate,
  onPreview,
  onPickAsset,
  onAddMedia,
}: {
  onOpenMaterial: (material: StoryboardViewMaterial) => void;
  entityNames: ReadonlyMap<string, string>;
  item: Item;
  section: ItemSection;
  assets: readonly ResolvedAsset[];
  generators: readonly StoryboardGeneratorChoice[];
  busy: ReadonlySet<string>;
  active: boolean;
  onChange: (item: Item) => void;
  onDelete: () => void;
  onGenerate: (
    material: StoryboardViewMaterial,
    choice: StoryboardGeneratorChoice,
  ) => Promise<void>;
  onPreview: (
    candidate: StoryboardViewResource,
    material: StoryboardViewMaterial,
  ) => void;
  onPickAsset: (material: StoryboardViewMaterial) => void;
  onAddMedia: () => void;
}) {
  const sortable = useSortable({ id: item.id });
  return (
    <div
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
        opacity: sortable.isDragging ? 0.5 : 1,
      }}
    >
      <SavedCollapsible
        disclosureId={`item:${section}:${item.id}`}
        className={`border-b border-b-warm-border border-l-2 py-1 ${active ? "border-l-content-primary" : "border-l-transparent"}`}
      >
        <div className="flex items-center gap-1 px-3">
          <IconButton
            label={`Reorder ${itemName(item)}`}
            size="sm"
            icon={<DotsSixVertical className="h-3.5 w-3.5" />}
            className="touch-none cursor-grab"
            {...sortable.attributes}
            {...sortable.listeners}
          />
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left text-sm font-semibold text-content-primary focus-visible:outline-2 focus-visible:outline-ring [&[data-state=open]_.caret]:rotate-180">
            <CaretDown className="caret h-3 w-3 shrink-0 motion-safe:transition-transform" />
            <span className="truncate">{itemName(item)}</span>
            {"durationSeconds" in item && item.durationSeconds && (
              <span className="ml-auto text-xs font-normal tabular-nums text-content-secondary">
                {item.durationSeconds}s
              </span>
            )}
          </CollapsibleTrigger>
          <ItemDetails
            entityNames={entityNames}
            item={item}
            section={section}
            onSave={onChange}
          />
          <IconButton
            label={`Remove ${itemName(item)} from storyboard`}
            size="sm"
            icon={<Trash className="h-3.5 w-3.5" />}
            onClick={onDelete}
          />
        </div>
        <CollapsibleContent className="space-y-2 pl-10 pr-3 pb-2 pt-1">
          {item.description.length > 0 ? (
            <p className="whitespace-pre-wrap break-words text-sm leading-5 text-content-secondary">
              {item.description.map((part, index) =>
                part.type === "text" ? (
                  <Fragment key={index}>{part.text}</Fragment>
                ) : (
                  <span
                    key={index}
                    className="rounded bg-warm-hover px-1 text-xs font-medium"
                  >
                    @{entityNames.get(part.entityId) ?? part.entityId}
                  </span>
                ),
              )}
            </p>
          ) : (
            <p className="text-xs text-content-secondary">
              Add a description using Edit.
            </p>
          )}
          {item.details && (
            <p className="whitespace-pre-wrap border-l-2 border-warm-border pl-3 text-xs leading-5 text-content-secondary">
              {item.details}
            </p>
          )}
          {item.materials.map((material) => (
            <MaterialRow
              key={material.id}
              material={material}
              assets={assets}
              onOpen={() => onOpenMaterial(material)}
              onPreview={(candidate) => onPreview(candidate, material)}
            />
          ))}
          <Button
            variant={null}
            size="sm"
            aria-label={`Add media to ${itemName(item)}`}
            className="h-7 px-2 text-content-secondary hover:bg-warm-hover"
            leftIcon={<Plus className="h-3.5 w-3.5" />}
            onClick={onAddMedia}
          >
            Add media
          </Button>
        </CollapsibleContent>
      </SavedCollapsible>
    </div>
  );
}

function MediaPreview({
  actions,
  composer,
  preview,
  assets,
  selected,
  onUse,
  onClose,
  onPrevious,
  onNext,
  onCloseComposer,
  onNewVersion,
  composerLabel,
}: {
  actions?: ReactNode;
  composer?: ReactNode;
  preview: Preview;
  assets: readonly ResolvedAsset[];
  selected: boolean;
  onUse?: () => void;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  onCloseComposer?: () => void;
  onNewVersion?: () => void;
  composerLabel?: string;
}) {
  const asset = assets.find(
    (entry) => entry.id === preview.candidate.projectAssetId,
  );
  const url = asset ? projectAssetPlaybackUrl(asset) : undefined;
  const label = candidateName(preview.candidate, assets);
  const [failed, setFailed] = useState(false);
  const reduceMotion = useReducedMotion();
  return (
    <section
      aria-label="Media preview"
      className="absolute inset-0 z-10 flex min-h-0 min-w-0 flex-col overflow-hidden bg-warm-page @[720px]:static @[720px]:flex-1"
    >
      <header className="flex h-[var(--clash-project-sidebar-header-height,2.5rem)] shrink-0 items-center gap-[var(--clash-workspace-control-gap)] border-b border-warm-border px-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {label}
        </span>
        {onNewVersion && (
          <Tooltip label="Add a version" placement="bottom">
            <IconButton
              label="New version"
              size="sm"
              className="clash-workspace-icon-control text-content-secondary"
              icon={<Plus className="h-4 w-4" weight="bold" />}
              onClick={onNewVersion}
            />
          </Tooltip>
        )}
        <Tooltip label="Close preview" placement="bottom">
          <IconButton
            label="Close preview"
            size="sm"
            className="clash-workspace-icon-control text-content-secondary"
            icon={<X className="h-4 w-4" weight="bold" />}
            onClick={onClose}
          />
        </Tooltip>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-warm-muted p-5">
        {!url || failed ? (
          <p className="max-w-64 text-center text-sm leading-5 text-content-secondary">
            {failed
              ? "This media could not be loaded. Reopen the preview to try again."
              : asset?.status === "unavailable"
                ? "This asset is currently unavailable."
                : "Preview is not available for this asset yet."}
          </p>
        ) : preview.candidate.mediaKind === "video" ? (
          <video
            key={url}
            src={url}
            controls
            preload="metadata"
            aria-label={label}
            className="max-h-full max-w-full"
            onError={() => setFailed(true)}
          />
        ) : preview.candidate.mediaKind === "audio" ? (
          <div className="w-full max-w-md space-y-6">
            <MusicNotes className="mx-auto h-10 w-10 text-content-secondary" />
            <audio
              key={url}
              src={url}
              controls
              preload="metadata"
              aria-label={label}
              className="w-full"
              onError={() => setFailed(true)}
            />
          </div>
        ) : preview.candidate.mediaKind === "image" ? (
          <img
            src={url}
            alt={label}
            className="h-full w-full object-contain"
            onError={() => setFailed(true)}
          />
        ) : (
          <p className="text-sm text-content-secondary">
            3D preview is available in the asset workspace.
          </p>
        )}
      </div>
      <footer className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2">
        <IconButton
          label="Previous version"
          size="sm"
          icon={<ArrowUp className="h-4 w-4" />}
          disabled={!onPrevious}
          onClick={onPrevious}
        />
        <IconButton
          label="Next version"
          size="sm"
          icon={<ArrowDown className="h-4 w-4" />}
          disabled={!onNext}
          onClick={onNext}
        />
        <span className="min-w-0 flex-1 truncate text-xs text-content-secondary">
          {composer
            ? (composerLabel ?? "Reference")
            : preview.candidate.modelName ||
              mediaLabels[preview.candidate.mediaKind]}
        </span>
        {onUse && (
          <Button
            size="sm"
            disabled={selected}
            onClick={onUse}
            leftIcon={selected ? <Check className="h-3.5 w-3.5" /> : undefined}
          >
            {selected ? "Selected version" : "Use this version"}
          </Button>
        )}
        {composer ? (
          <Button
            size="sm"
            variant={null}
            className="bg-transparent shadow-none text-content-secondary"
            onClick={onCloseComposer}
          >
            Close composer
          </Button>
        ) : (
          actions
        )}
      </footer>
      {composer && (
        <motion.section
          aria-label="Generator composer"
          initial={reduceMotion ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.12, ease: "easeOut" }}
          className="flex min-h-0 max-h-[60%] shrink-0 flex-col overflow-hidden bg-warm-surface"
        >
          {composer}
        </motion.section>
      )}
    </section>
  );
}

export function PluginStoryboardSurface({
  onCompose,
  onReference,
  onUpload,
  projectId,
  nodeId,
  label,
  headerEndInset = 0,
  state,
  assets,
  generators,
  onSave,
  onGenerate,
  parentCanvas,
  onOpenCanvas,
}: PluginStoryboardSurfaceProps) {
  const entityNames = useMemo(
    () =>
      new Map(
        [...state.keyElements, ...state.shots, ...state.audioLayers].map(
          (item) => [item.id, itemName(item)],
        ),
      ),
    [state.keyElements, state.shots, state.audioLayers],
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const latest = useRef(state);
  latest.current = state;
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const pending = useRef(new Set<string>());
  const [preview, setCandidatePreview] = useState<Preview | null>(null);
  const [pendingPreview, setPendingPreview] = useState<{
    output: PendingGeneratorOutput;
    target: Target;
  } | null>(null);
  const setPreview = (next: Preview | null) => {
    setAdding(null);
    setPendingPreview(null);
    setCandidatePreview(next);
  };
  const [picker, setPicker] = useState<AttachmentTarget | null>(null);
  const [adding, setAdding] = useState<AttachmentTarget | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [activeTarget, setActiveTarget] = useState<Target | null>(null);
  const [composer, setComposerState] = useState<ReactNode>(null);
  const composerRequest = useRef(0);
  const setComposer = (next: ReactNode) => {
    if (next === null) {
      composerRequest.current += 1;
      setOpeningComposer(false);
    }
    setComposerState(next);
  };
  const [composerMode, setComposerMode] =
    useState<StoryboardComposeRequest["mode"]>("new");
  const [composeError, setComposeError] = useState<string | null>(null);
  const [openingComposer, setOpeningComposer] = useState(false);
  const [newAssetOpen, setNewAssetOpen] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const save = (next: StoryboardViewState) => {
    onSave(next);
    latest.current = next;
  };
  const updateItem = (
    section: ItemSection,
    itemId: string,
    change: (item: Item) => Item,
  ) => {
    const next = structuredClone(latest.current);
    next[section] = next[section].map((item) =>
      item.id === itemId ? change(item) : item,
    );
    save(next);
  };
  const updateMaterial = (
    target: Target,
    change: (material: StoryboardViewMaterial) => StoryboardViewMaterial,
  ) =>
    updateItem(target.section, target.itemId, (item) => ({
      ...item,
      materials: item.materials.map((material) =>
        material.id === target.materialId ? change(material) : material,
      ),
    }));
  const openMaterial = (target: Target, material: StoryboardViewMaterial) => {
    setAdding(null);
    setActiveTarget(target);
    setComposer(null);
    setComposeError(null);
    const candidate =
      material.candidates.find(
        (entry) => entry.id === material.selectedCandidateId,
      ) ?? material.candidates[0];
    setPreview(candidate ? { candidate, target } : null);
    if (!candidate && !material.pendingOutputs?.length) setNewAssetOpen(true);
  };
  const target =
    adding?.target ??
    pendingPreview?.target ??
    (preview ? preview.target : (activeTarget ?? undefined));
  const targetMaterial = findMaterial(state, target) ?? adding?.draft;
  const generationKinds = [
    ...new Set(generators.map((choice) => choice.mediaKind)),
  ];
  const compatibleChoices = generators.filter(
    (choice) => choice.mediaKind === targetMaterial?.mediaKind,
  );
  const beginAddMedia = (section: ItemSection, itemId: string) => {
    const mediaKind = generationKinds.includes(sectionMeta[section].mediaKind)
      ? sectionMeta[section].mediaKind
      : (generationKinds[0] ?? sectionMeta[section].mediaKind);
    const material: StoryboardViewMaterial = {
      id: nextId("media"),
      label: mediaLabels[mediaKind],
      mediaKind,
      candidates: [],
    };
    setComposer(null);
    setComposeError(null);
    setAdding({
      target: { section, itemId, materialId: material.id },
      draft: material,
    });
    setNewAssetOpen(true);
  };
  const closeAddMedia = () => {
    setNewAssetOpen(false);
    setAdding(null);
  };
  const attachMaterial = (
    next: StoryboardViewState,
    destination: AttachmentTarget,
    mediaKind: StoryboardViewMaterial["mediaKind"],
  ) => {
    const current = findMaterial(next, destination.target);
    if (current) return current.mediaKind === mediaKind ? current : undefined;
    const item = next[destination.target.section].find(
      (entry) => entry.id === destination.target.itemId,
    );
    if (!item || !destination.draft) return undefined;
    const material = {
      ...structuredClone(destination.draft),
      mediaKind,
      label: mediaLabels[mediaKind],
    };
    item.materials.push(material);
    return material;
  };
  const compose = async (mode: StoryboardComposeRequest["mode"]) => {
    const choice = compatibleChoices[0];
    if (!target || !targetMaterial || !choice || !onCompose) return;
    const destination = { target, draft: adding?.draft };
    setNewAssetOpen(false);
    setComposeError(null);
    const requestId = ++composerRequest.current;
    setOpeningComposer(true);
    if (mode !== "regenerate") {
      setComposerMode(mode);
      setComposer(
        <div
          role="status"
          aria-label="Preparing composer"
          className="flex min-h-40 items-center justify-center p-4 text-sm text-content-secondary"
        >
          Preparing composer…
        </div>,
      );
    }
    try {
      const result = await onCompose(
        {
          material: structuredClone(targetMaterial),
          choice,
          mode,
          candidate: mode === "new" ? undefined : preview?.candidate,
        },
        {
          onPending: (output) => {
            const next = structuredClone(latest.current);
            const material = attachMaterial(
              next,
              destination,
              output.mediaKind,
            );
            if (!material) return;
            if (
              !material.pendingOutputs?.some(
                (entry) =>
                  entry.actionRunId === output.actionRunId &&
                  entry.outputSlot === output.outputSlot,
              )
            )
              material.pendingOutputs = [
                ...(material.pendingOutputs ?? []),
                output,
              ];
            save(next);
            setAdding(null);
            setCandidatePreview(null);
            setPendingPreview({ output, target });
            setComposer(null);
            setOpeningComposer(false);
          },
          onClose: () => {
            setComposer(null);
            setAdding(null);
          },
          onResult: (candidate) => {
            if (!mounted.current) return;
            const next = structuredClone(latest.current),
              current = attachMaterial(next, destination, candidate.mediaKind);
            const candidates = current?.candidates ?? next.uncategorized;
            if (!candidates.some((entry) => entry.id === candidate.id))
              candidates.push(candidate);
            save(next);
            setAdding(null);
            setPreview({ candidate, ...(current ? { target } : {}) });
            setComposer(null);
          },
        },
      );
      if (requestId !== composerRequest.current) return;
      if (mode !== "regenerate") {
        setComposerMode(mode);
        setComposer(result);
      }
    } catch (cause) {
      if (requestId !== composerRequest.current) return;
      setComposer(null);
      setAdding(null);
      setComposeError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestId === composerRequest.current) setOpeningComposer(false);
    }
  };
  const previewActions =
    preview && (targetMaterial || onReference) ? (
      <div className="flex w-full flex-wrap items-center gap-2 border-t border-warm-border pt-2">
        {preview && onReference && (
          <Button size="sm" onClick={() => onReference(preview.candidate)}>
            Reference
          </Button>
        )}
        {targetMaterial &&
          onCompose &&
          compatibleChoices.length > 0 &&
          preview.candidate.generatedBy && (
            <>
              <Button
                size="sm"
                disabled={openingComposer || !preview?.candidate.generatedBy}
                onClick={() => void compose("prompt")}
              >
                Prompt
              </Button>
              <Button
                size="sm"
                disabled={openingComposer || !preview?.candidate.generatedBy}
                onClick={() => void compose("regenerate")}
              >
                Regenerate
              </Button>
            </>
          )}
        {openingComposer && (
          <span role="status" className="text-xs">
            Opening…
          </span>
        )}
        {composeError && (
          <p role="alert" className="w-full text-xs text-red-700">
            {composeError}
          </p>
        )}
      </div>
    ) : null;
  const assigned = new Set(
    (Object.keys(sectionMeta) as ItemSection[]).flatMap((section) =>
      state[section].flatMap((item) =>
        item.materials.flatMap((material) =>
          material.candidates.map((candidate) => candidate.projectAssetId),
        ),
      ),
    ),
  );
  const loose = [
    ...new Map(
      [
        ...assets
          .filter(
            (asset) =>
              asset.lifecycle.state === "active" &&
              ["image", "video", "audio", "model"].includes(asset.kind),
          )
          .map(
            (asset) =>
              ({
                id: `asset:${asset.id}`,
                projectAssetId: asset.id,
                mediaKind: asset.kind,
              }) as StoryboardViewResource,
          ),
        ...state.uncategorized,
      ]
        .filter((candidate) => !assigned.has(candidate.projectAssetId))
        .map((candidate) => [candidate.projectAssetId, candidate]),
    ).values(),
  ];
  const generate = async (
    target: Target,
    material: StoryboardViewMaterial,
    choice: StoryboardGeneratorChoice,
  ) => {
    const key = targetKey(target);
    if (pending.current.has(key)) return;
    pending.current.add(key);
    setBusy(new Set(pending.current));
    try {
      const candidate = await onGenerate(structuredClone(material), choice);
      if (!mounted.current) return;
      const next = structuredClone(latest.current);
      const current = findMaterial(next, target);
      if (current) current.candidates.push(candidate);
      else next.uncategorized.push(candidate);
      save(next);
    } finally {
      pending.current.delete(key);
      if (mounted.current) setBusy(new Set(pending.current));
    }
  };
  const previewMaterial = findMaterial(state, preview?.target);
  const versions = previewMaterial?.candidates ?? loose;
  const previewIndex = preview
    ? versions.findIndex((candidate) => candidate.id === preview.candidate.id)
    : -1;
  const pickerMaterial =
    picker && !picker.draft ? findMaterial(state, picker.target) : undefined;
  const pickerSections = buildComposerAssetSections({
    projectAssets: assets.filter(
      (asset) =>
        !pickerMaterial ||
        (asset.kind === pickerMaterial.mediaKind &&
          !pickerMaterial.candidates.some(
            (candidate) => candidate.projectAssetId === asset.id,
          )),
    ),
    globalAssets: [],
  })
    .map((section) =>
      section.scope === "external"
        ? {
            ...section,
            label: "Local files",
            allowLocalUpload: Boolean(onUpload),
          }
        : section,
    )
    .filter(
      (section) =>
        section.assets.length ||
        section.scope === "project" ||
        section.allowLocalUpload,
    );
  const attachPickedAsset = (
    asset: Pick<ResolvedAsset, "id" | "kind">,
    destination: AttachmentTarget,
  ) => {
    if (
      !(["image", "video", "audio", "model"] as string[]).includes(asset.kind)
    )
      throw new Error("Choose an image, video, or audio asset.");
    const next = structuredClone(latest.current);
    const material = attachMaterial(
      next,
      destination,
      asset.kind as StoryboardViewMaterial["mediaKind"],
    );
    if (!material)
      throw new Error(
        "This material is no longer available or does not accept this media type.",
      );
    const resource = [
      ...next.uncategorized,
      ...(Object.keys(sectionMeta) as ItemSection[]).flatMap((section) =>
        next[section].flatMap((item) =>
          item.materials.flatMap((entry) => entry.candidates),
        ),
      ),
    ].find((entry) => entry.projectAssetId === asset.id) ?? {
      id: nextId("resource"),
      projectAssetId: asset.id,
      mediaKind: material.mediaKind,
    };
    if (!material.candidates.some((entry) => entry.projectAssetId === asset.id))
      material.candidates.push(resource);
    next.uncategorized = next.uncategorized.filter(
      (entry) => entry.projectAssetId !== asset.id,
    );
    save(next);
    setAdding(null);
    setPicker(null);
    setPreview({ candidate: resource, target: destination.target });
  };
  return (
    <OutputReadyScope.Provider
      value={(output, asset) => {
        const next = structuredClone(latest.current);
        let changed = false;
        for (const section of Object.keys(sectionMeta) as ItemSection[]) {
          for (const item of next[section])
            for (const material of item.materials) {
              if (
                !material.pendingOutputs?.some(
                  (entry) =>
                    entry.actionRunId === output.actionRunId &&
                    entry.outputSlot === output.outputSlot,
                )
              )
                continue;
              material.pendingOutputs = material.pendingOutputs.filter(
                (entry) =>
                  entry.actionRunId !== output.actionRunId ||
                  entry.outputSlot !== output.outputSlot,
              );
              if (!material.candidates.some((entry) => entry.id === asset.id))
                material.candidates.push(asset);
              changed = true;
            }
        }
        if (changed) save(next);
        if (
          pendingPreview?.output.actionRunId === output.actionRunId &&
          pendingPreview.output.outputSlot === output.outputSlot
        )
          setPreview({ candidate: asset, target: pendingPreview.target });
      }}
    >
      <OutputPreviewScope.Provider
        value={(output) => {
          for (const section of Object.keys(sectionMeta) as ItemSection[])
            for (const item of latest.current[section])
              for (const material of item.materials)
                if (
                  material.pendingOutputs?.some(
                    (entry) =>
                      entry.actionRunId === output.actionRunId &&
                      entry.outputSlot === output.outputSlot,
                  )
                ) {
                  setAdding(null);
                  setComposer(null);
                  setComposeError(null);
                  setCandidatePreview(null);
                  setPendingPreview({
                    output,
                    target: {
                      section,
                      itemId: item.id,
                      materialId: material.id,
                    },
                  });
                  return;
                }
        }}
      >
        <DisclosureScope.Provider
          key={`${projectId}:${nodeId}`}
          value={JSON.stringify([projectId, nodeId])}
        >
          <div
            className="@container absolute inset-0 z-10 flex min-h-0 flex-col bg-warm-page text-content-primary"
            data-plugin-view="storyboard"
          >
            <header className="flex h-[var(--clash-project-sidebar-header-height,2.5rem)] shrink-0 items-center gap-[var(--clash-workspace-control-gap)] border-b border-warm-border px-3">
              {parentCanvas ? (
                <ParentCanvasButton
                  canvas={parentCanvas}
                  onOpenCanvas={onOpenCanvas}
                />
              ) : null}
              <Shapes
                className="h-4 w-4 text-content-secondary"
                weight="duotone"
              />
              <h1
                className="min-w-0 flex-1 truncate text-sm font-semibold"
                style={{ paddingRight: headerEndInset }}
              >
                {label}
              </h1>
            </header>
            <div className="relative flex min-h-0 flex-1 gap-3 p-3">
              {/* Lazy editor styles also emit .hidden; keep the wide layout visible
            regardless of stylesheet load order. */}
              <div
                className={`${preview || pendingPreview ? "hidden @[720px]:block!" : ""} min-h-0 w-full shrink-0 overflow-y-auto @[720px]:w-[42%] @[720px]:min-w-72 @[720px]:max-w-lg rounded-xl border border-warm-border bg-warm-surface shadow-sm`}
              >
                {(Object.keys(sectionMeta) as ItemSection[]).map((section) => {
                  const meta = sectionMeta[section];
                  const Icon = meta.icon;
                  const items = state[section];
                  const add = (name: string) => {
                    const next = structuredClone(latest.current);
                    const id = nextId(section);
                    next[section].push({
                      id,
                      label: name,
                      description: [],
                      materials: [],
                    });
                    save(next);
                  };
                  return (
                    <SavedCollapsible
                      key={section}
                      disclosureId={`section:${section}`}
                      className="border-b border-warm-border"
                    >
                      <div className="sticky top-0 z-[1] flex h-11 items-center bg-warm-page px-4">
                        <CollapsibleTrigger className="flex w-full items-center gap-2 rounded py-2 text-left text-sm font-semibold focus-visible:outline-2 focus-visible:outline-ring [&[data-state=open]_.caret]:rotate-180">
                          <CaretDown className="caret h-3 w-3 text-content-secondary motion-safe:transition-transform" />
                          <Icon className="h-4 w-4 text-content-secondary" />
                          <span>{meta.label}</span>
                          <span className="ml-auto text-xs font-normal tabular-nums text-content-secondary">
                            {items.length}
                          </span>
                        </CollapsibleTrigger>
                      </div>
                      <CollapsibleContent>
                        {!items.length && (
                          <p className="px-5 pb-2 text-xs leading-5 text-content-secondary">
                            {meta.hint}
                          </p>
                        )}
                        <div className="px-3 pb-1">
                          <AddItem
                            section={section}
                            onAdd={(name) => add(name)}
                          />
                        </div>
                        <DndContext
                          sensors={sensors}
                          collisionDetection={closestCenter}
                          onDragEnd={({ active, over }) => {
                            if (!over || active.id === over.id) return;
                            const next = structuredClone(latest.current);
                            const from = next[section].findIndex(
                              (item) => item.id === active.id,
                            );
                            const to = next[section].findIndex(
                              (item) => item.id === over.id,
                            );
                            if (from < 0 || to < 0) return;
                            next[section] = arrayMove(next[section], from, to);
                            save(next);
                          }}
                        >
                          <SortableContext
                            items={items.map((item) => item.id)}
                            strategy={verticalListSortingStrategy}
                          >
                            {items.map((item) => (
                              <Fragment key={item.id}>
                                <StoryboardItemCard
                                  entityNames={entityNames}
                                  onOpenMaterial={(material) =>
                                    openMaterial(
                                      {
                                        section,
                                        itemId: item.id,
                                        materialId: material.id,
                                      },
                                      material,
                                    )
                                  }
                                  item={item}
                                  section={section}
                                  assets={assets}
                                  generators={generators}
                                  busy={busy}
                                  active={
                                    preview?.target?.section === section &&
                                    preview.target.itemId === item.id
                                  }
                                  onChange={(changed) =>
                                    updateItem(section, item.id, () => changed)
                                  }
                                  onDelete={() => {
                                    const next = structuredClone(
                                      latest.current,
                                    );
                                    const removed = next[section].find(
                                      (entry) => entry.id === item.id,
                                    );
                                    const looseIds = new Set(
                                      next.uncategorized.map(
                                        (entry) => entry.projectAssetId,
                                      ),
                                    );
                                    for (const material of removed?.materials ??
                                      []) {
                                      for (const candidate of material.candidates) {
                                        if (
                                          !looseIds.has(
                                            candidate.projectAssetId,
                                          )
                                        ) {
                                          next.uncategorized.push(candidate);
                                          looseIds.add(
                                            candidate.projectAssetId,
                                          );
                                        }
                                      }
                                    }
                                    next[section] = next[section].filter(
                                      (entry) => entry.id !== item.id,
                                    );
                                    save(next);
                                  }}
                                  onGenerate={(material, choice) =>
                                    generate(
                                      {
                                        section,
                                        itemId: item.id,
                                        materialId: material.id,
                                      },
                                      material,
                                      choice,
                                    )
                                  }
                                  onPreview={(candidate, material) => {
                                    setAdding(null);
                                    setComposer(null);
                                    setComposeError(null);
                                    setPreview({
                                      candidate,
                                      target: {
                                        section,
                                        itemId: item.id,
                                        materialId: material.id,
                                      },
                                    });
                                  }}
                                  onPickAsset={(material) => {
                                    setPicker({
                                      target: {
                                        section,
                                        itemId: item.id,
                                        materialId: material.id,
                                      },
                                    });
                                  }}
                                  onAddMedia={() =>
                                    beginAddMedia(section, item.id)
                                  }
                                />
                              </Fragment>
                            ))}
                          </SortableContext>
                        </DndContext>
                      </CollapsibleContent>
                    </SavedCollapsible>
                  );
                })}
                <SavedCollapsible
                  disclosureId="section:uncategorized"
                  className="pb-2"
                >
                  <CollapsibleTrigger className="flex h-11 w-full items-center gap-2 px-4 text-left text-sm font-semibold focus-visible:outline-2 focus-visible:outline-ring [&[data-state=open]_.caret]:rotate-180">
                    <CaretDown className="caret h-3 w-3 text-content-secondary" />
                    <ImageIcon className="h-4 w-4 text-content-secondary" />
                    <span>Uncategorized</span>
                    <span className="ml-auto text-xs font-normal tabular-nums text-content-secondary">
                      {loose.length}
                    </span>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="px-4">
                    {loose.length ? (
                      <div className="flex flex-wrap gap-2">
                        {loose.map((candidate) => (
                          <CandidateCard
                            key={candidate.id}
                            candidate={candidate}
                            assets={assets}
                            onPreview={() => setPreview({ candidate })}
                          />
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs leading-5 text-content-secondary">
                        Project media not yet used in this storyboard appears
                        here.
                      </p>
                    )}
                  </CollapsibleContent>
                </SavedCollapsible>
              </div>
              {composer &&
              !(
                (composerMode === "edit" || composerMode === "prompt") &&
                preview
              ) ? (
                <section
                  aria-label="Generator composer"
                  className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto bg-warm-surface"
                >
                  {composer}
                </section>
              ) : pendingPreview ? (
                <section
                  aria-label="Pending media preview"
                  className="flex min-h-0 min-w-0 flex-1 flex-col bg-warm-surface"
                >
                  <header className="flex h-[var(--clash-project-sidebar-header-height,2.5rem)] shrink-0 items-center justify-between px-3">
                    <span className="text-sm font-medium">
                      Generating{" "}
                      {mediaLabels[
                        pendingPreview.output.mediaKind
                      ].toLowerCase()}
                    </span>
                    <Tooltip label="Close preview" placement="bottom">
                      <IconButton
                        label="Close preview"
                        icon={<X className="h-4 w-4" weight="bold" />}
                        className="clash-workspace-icon-control text-content-secondary"
                        size="sm"
                        onClick={() => setPreview(null)}
                      />
                    </Tooltip>
                  </header>
                  <div className="min-h-0 flex-1 p-3">
                    <OutputReadyScope.Consumer>
                      {(onReady) => (
                        <GeneratorOutput
                          key={
                            pendingPreview.output.actionRunId +
                            pendingPreview.output.outputSlot
                          }
                          output={pendingPreview.output}
                          presentation="preview"
                          onReady={(asset) =>
                            onReady(pendingPreview.output, asset)
                          }
                        />
                      )}
                    </OutputReadyScope.Consumer>
                  </div>
                </section>
              ) : preview ? (
                <MediaPreview
                  composer={
                    composerMode === "edit" || composerMode === "prompt"
                      ? composer
                      : null
                  }
                  onNewVersion={
                    targetMaterial ? () => setNewAssetOpen(true) : undefined
                  }
                  composerLabel={
                    composerMode === "prompt" ? "Prompt" : "Reference"
                  }
                  onCloseComposer={() => setComposer(null)}
                  actions={previewActions}
                  key={`${preview.candidate.projectAssetId}:${preview.candidate.id}`}
                  preview={preview}
                  assets={assets}
                  selected={
                    previewMaterial?.selectedCandidateId ===
                    preview.candidate.id
                  }
                  onClose={() => {
                    setComposer(null);
                    setPreview(null);
                  }}
                  onUse={
                    previewMaterial && preview.target
                      ? () =>
                          updateMaterial(preview.target!, (material) => ({
                            ...material,
                            selectedCandidateId: preview.candidate.id,
                          }))
                      : undefined
                  }
                  onPrevious={
                    previewIndex > 0
                      ? () => {
                          setComposer(null);
                          setPreview({
                            ...preview,
                            candidate: versions[previewIndex - 1]!,
                          });
                        }
                      : undefined
                  }
                  onNext={
                    previewIndex >= 0 && previewIndex < versions.length - 1
                      ? () => {
                          setComposer(null);
                          setPreview({
                            ...preview,
                            candidate: versions[previewIndex + 1]!,
                          });
                        }
                      : undefined
                  }
                />
              ) : (
                <div className="hidden min-w-0 flex-1 items-center justify-center p-8 @[720px]:flex!">
                  <p className="text-sm text-content-secondary">
                    Select media to preview.
                  </p>
                  {composeError && (
                    <p role="alert" className="text-sm text-red-700">
                      {composeError}
                    </p>
                  )}
                </div>
              )}
            </div>
            <Dialog
              open={newAssetOpen}
              onClose={closeAddMedia}
              title="Add media"
            >
              <div className="flex flex-col gap-3">
                {adding?.draft && generationKinds.length > 1 && onCompose && (
                  <SelectMenu
                    ariaLabel="Generate media type"
                    value={adding.draft.mediaKind}
                    options={generationKinds.map((kind) => ({
                      value: kind,
                      label: mediaLabels[kind],
                    }))}
                    onValueChange={(mediaKind) =>
                      setAdding({
                        ...adding,
                        draft: {
                          ...adding.draft!,
                          mediaKind,
                          label: mediaLabels[mediaKind],
                        },
                      })
                    }
                  />
                )}
                {onCompose && compatibleChoices.length > 0 && (
                  <Button
                    leftIcon={<Sparkle className="h-4 w-4" />}
                    onClick={() => void compose("new")}
                  >
                    Generate media
                  </Button>
                )}
                <Button
                  onClick={() => {
                    setNewAssetOpen(false);
                    setPickerError(null);
                    if (target) setPicker({ target, draft: adding?.draft });
                  }}
                >
                  Choose project asset
                </Button>
              </div>
            </Dialog>
            <ScopedAssetPicker
              projectId={projectId}
              open={Boolean(picker)}
              sections={pickerSections}
              busy={pickerBusy}
              error={pickerError}
              onClose={() => {
                if (!pickerBusy) {
                  setPicker(null);
                  setAdding(null);
                }
              }}
              onSelect={(option) => {
                if (!picker) return;
                try {
                  attachPickedAsset(
                    { id: option.assetId, kind: option.type },
                    picker,
                  );
                } catch (cause) {
                  setPickerError(
                    cause instanceof Error ? cause.message : String(cause),
                  );
                }
              }}
              onUpload={async (file) => {
                if (!picker || !onUpload) return;
                const destination = picker;
                setPickerBusy(true);
                setPickerError(null);
                try {
                  if (
                    pickerMaterial &&
                    !file.type.startsWith(`${pickerMaterial.mediaKind}/`)
                  )
                    throw new Error(
                      `Choose a ${pickerMaterial.mediaKind} file for this material.`,
                    );
                  attachPickedAsset(await onUpload(file), destination);
                } catch (cause) {
                  setPickerError(
                    cause instanceof Error ? cause.message : String(cause),
                  );
                } finally {
                  setPickerBusy(false);
                }
              }}
            />
          </div>
        </DisclosureScope.Provider>
      </OutputPreviewScope.Provider>
    </OutputReadyScope.Provider>
  );
}
