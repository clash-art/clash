import React from "react";
import {
  normalizeEditorAsset,
  useEditorDispatch,
  useEditorPlaybackRefs,
  useEditorStaticState,
  type EditorState,
} from "@clash/remotion-core";
import {
  TIMELINE_LIBRARY_CATEGORIES,
  TIMELINE_LIBRARY_GROUPS,
  type TimelineLibraryCategory,
} from "@clash/shared-types/timeline-library";
import {
  queryTimelineLibrary,
  type TimelineLibraryCatalogRecord,
} from "../library/timelineLibraryCatalog";
import {
  buildTimelineLibraryApplication,
  findTimelineLibraryProjectAsset,
  timelineLibraryMediaAdmissionInput,
  type TimelineLibraryMediaAdmissionInput,
} from "../library/applyTimelineLibraryItem";
import { RemotionButton } from "./ui/controls";
import { emitTimelineNotice } from "./timeline/timelineNotice";

export let currentDraggedLibraryRecord: TimelineLibraryCatalogRecord | null =
  null;

const CATEGORY_LABELS: Record<TimelineLibraryCategory, string> = {
  text: "Text",
  stickers: "Stickers",
  "sound-effects": "Sound effects",
  transitions: "Transitions",
  fx: "FX",
  zoom: "Zoom",
  luts: "LUTs",
  "audio-fx": "Audio FX",
  captions: "Captions",
  filters: "Filters",
  adjustments: "Adjustments",
};

const CATEGORY_CLUSTER: Record<
  TimelineLibraryCategory,
  TimelineLibraryCategory[]
> = {
  text: ["text"],
  stickers: ["stickers"],
  "sound-effects": ["sound-effects", "audio-fx"],
  "audio-fx": ["sound-effects", "audio-fx"],
  transitions: ["fx", "transitions", "zoom"],
  fx: ["fx", "transitions", "zoom"],
  zoom: ["fx", "transitions", "zoom"],
  luts: ["filters", "luts", "adjustments"],
  filters: ["filters", "luts", "adjustments"],
  adjustments: ["filters", "luts", "adjustments"],
  captions: ["captions"],
};

const SearchIcon = () => (
  <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true">
    <circle
      cx="8.6"
      cy="8.6"
      r="5.2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    />
    <path
      d="m12.5 12.5 4 4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
    />
  </svg>
);

const ApplyIcon = () => (
  <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true">
    <path
      d="M10 3v14M3 10h14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  </svg>
);

const PreviewIcon = () => (
  <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true">
    <path d="m7.5 5.2 7 4.8-7 4.8z" fill="currentColor" />
  </svg>
);

function LibraryPreview({ record }: { record: TimelineLibraryCatalogRecord }) {
  const preview = record.preview;
  if (preview.kind === "image" && preview.src) {
    return (
      <img
        src={preview.src}
        alt=""
        draggable={false}
        className="h-16 w-full object-contain p-2"
      />
    );
  }
  if (preview.kind === "audio") {
    const waveform = preview.waveform ?? [];
    return (
      <div className="flex h-12 items-center gap-px px-2" aria-hidden="true">
        {waveform.slice(0, 42).map((peak, index) => (
          <span
            key={index}
            className="min-h-px flex-1 rounded-full bg-brand/55"
            style={{ height: `${Math.max(2, peak * 34)}px` }}
          />
        ))}
      </div>
    );
  }
  if (preview.kind === "text") {
    return (
      <div
        className="flex h-16 items-center justify-center overflow-hidden rounded-lg px-3 text-center font-display text-sm font-bold"
        style={{
          color: preview.colors?.[1] ?? "#ffffff",
          background: preview.colors?.[0] ?? "#1b2a41",
        }}
      >
        {record.item.label}
      </div>
    );
  }
  return (
    <div
      className="relative h-16 overflow-hidden rounded-lg"
      style={{
        background: `linear-gradient(135deg, ${preview.colors?.[0] ?? "#f5d8cf"}, ${preview.colors?.[1] ?? "#4f6ea9"})`,
      }}
    >
      <span className="absolute inset-0 bg-[radial-gradient(circle_at_25%_28%,rgba(255,255,255,.7),transparent_28%),linear-gradient(115deg,transparent_35%,rgba(255,255,255,.34)_50%,transparent_65%)]" />
      <span className="absolute bottom-2 left-2 rounded-md bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white">
        {preview.kind === "transition"
          ? "A → B"
          : preview.kind === "motion"
            ? "Motion"
            : "Effect"}
      </span>
    </div>
  );
}

const LibraryCard: React.FC<{
  record: TimelineLibraryCatalogRecord;
  disabledReason?: string;
  onApply: () => void;
}> = ({ record, disabledReason, onApply }) => {
  const reportsDisabledTransition = Boolean(
    disabledReason && record.item.category === "transitions",
  );
  const handlePreview = React.useCallback(() => {
    if (record.runtimeAsset?.src && typeof Audio !== "undefined") {
      const audio = new Audio(record.runtimeAsset.src);
      void audio.play().catch(() => undefined);
    }
  }, [record.runtimeAsset?.src]);

  return (
    <article
      data-library-card={true}
      draggable={!disabledReason || reportsDisabledTransition}
      onDragStart={(event) => {
        currentDraggedLibraryRecord = record;
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(
          "application/x-clash-timeline-library",
          record.item.id,
        );
        event.dataTransfer.setData("text/plain", record.item.id);
      }}
      onDragEnd={() => {
        currentDraggedLibraryRecord = null;
      }}
      className="group rounded-matrix bg-warm-page p-1.5 shadow-[0_1px_2px_rgba(66,48,35,0.06)] ring-1 ring-warm-border/70 transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-[0_6px_18px_rgba(66,48,35,0.10)]"
    >
      <LibraryPreview record={record} />
      <div className="flex min-w-0 items-center gap-1.5 px-1 pb-0.5 pt-1.5">
        <div className="min-w-0 flex-1">
          <h3 className="m-0 truncate text-[12px] font-semibold leading-4 text-slate-950 dark:text-stone-100">
            {record.item.label}
          </h3>
          <p className="m-0 truncate text-[10px] leading-4 text-stone-500 dark:text-stone-400">
            {CATEGORY_LABELS[record.item.category]}
          </p>
        </div>
        {record.preview.kind === "audio" ? (
          <RemotionButton
            type="button"
            aria-label={`Preview ${record.item.label}`}
            title={`Preview ${record.item.label}`}
            onClick={handlePreview}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-warm-muted hover:text-slate-950 dark:text-stone-400 dark:hover:text-stone-100"
          >
            <PreviewIcon />
          </RemotionButton>
        ) : null}
        <RemotionButton
          type="button"
          data-library-apply={true}
          aria-label={`Apply ${record.item.label}`}
          aria-disabled={Boolean(disabledReason)}
          title={disabledReason ?? `Apply ${record.item.label}`}
          disabled={Boolean(disabledReason) && !reportsDisabledTransition}
          onClick={onApply}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:bg-black/[0.035] disabled:text-stone-300 ${
            disabledReason
              ? "cursor-help bg-black/[0.035] text-stone-300"
              : "bg-brand/[0.10] text-brand hover:bg-brand/[0.18]"
          }`}
        >
          <ApplyIcon />
        </RemotionButton>
      </div>
    </article>
  );
};

type TimelineLibraryPanelProps = {
  selectedCategory?: TimelineLibraryCategory | null;
  onSelectedCategoryChange?: (category: TimelineLibraryCategory | null) => void;
  headerTrailingAction?: React.ReactNode;
  showCategoryChoices?: boolean;
  embedded?: boolean;
  onAdmitLibraryMedia?: (
    input: TimelineLibraryMediaAdmissionInput,
  ) => Promise<import("@clash/remotion-core").EditorAssetInput>;
};

export const TimelineLibraryPanel: React.FC<TimelineLibraryPanelProps> = ({
  selectedCategory,
  onSelectedCategoryChange,
  headerTrailingAction,
  showCategoryChoices = true,
  embedded = false,
  onAdmitLibraryMedia,
}) => {
  // Read the playhead through refs: the panel only needs the frame when an
  // item is applied, so it must not re-render on every playback frame.
  const staticState = useEditorStaticState();
  const { currentFrameRef, playingRef } = useEditorPlaybackRefs();
  const readState = (): EditorState => ({
    ...staticState,
    currentFrame: currentFrameRef.current,
    playing: playingRef.current,
  });
  const renderState = readState();
  const dispatch = useEditorDispatch();
  const [search, setSearch] = React.useState("");
  const [groupId, setGroupId] =
    React.useState<(typeof TIMELINE_LIBRARY_GROUPS)[number]["id"]>(
      "recommended",
    );
  const [uncontrolledCategory, setUncontrolledCategory] =
    React.useState<TimelineLibraryCategory | null>(null);
  const idCounter = React.useRef(0);
  const category =
    selectedCategory === undefined ? uncontrolledCategory : selectedCategory;
  const categoryChoices =
    selectedCategory === undefined || category === null
      ? TIMELINE_LIBRARY_CATEGORIES
      : CATEGORY_CLUSTER[category];
  const updateCategory = React.useCallback(
    (nextCategory: TimelineLibraryCategory | null) => {
      if (selectedCategory === undefined) {
        setUncontrolledCategory(nextCategory);
      }
      onSelectedCategoryChange?.(nextCategory);
    },
    [onSelectedCategoryChange, selectedCategory],
  );

  const records = React.useMemo(
    () =>
      queryTimelineLibrary({
        groupId: category ? undefined : groupId,
        categories: category ? [category] : undefined,
        search,
      }),
    [category, groupId, search],
  );

  const createId = React.useCallback((prefix: string) => {
    idCounter.current += 1;
    return `${prefix}-${Date.now().toString(36)}-${idCounter.current.toString(36)}`;
  }, []);

  return (
    <section
      data-timeline-library-panel=""
      data-embedded={embedded}
      className={`${embedded ? "" : "clash-timeline-panel-surface"} flex h-full min-h-0 flex-col overflow-hidden bg-warm-surface`}
    >
      <div className="shrink-0 space-y-2 p-3 pb-2">
        <div className="flex items-center gap-2">
          <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg bg-warm-page px-2.5 text-stone-500 ring-1 ring-warm-border/70 focus-within:ring-brand/45">
            <SearchIcon />
            <input
              aria-label="Search creative assets"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search effects, titles, sounds…"
              className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[12px] text-slate-950 outline-none placeholder:text-stone-400 dark:text-stone-100 dark:placeholder:text-stone-500"
            />
          </label>
          {headerTrailingAction}
        </div>
        {selectedCategory === undefined ? (
          <nav
            aria-label="Creative asset groups"
            className="flex gap-1 overflow-x-auto pb-0.5 [scrollbar-width:none]"
          >
            {TIMELINE_LIBRARY_GROUPS.map((group) => (
              <RemotionButton
                key={group.id}
                type="button"
                onClick={() => {
                  setGroupId(group.id);
                  updateCategory(null);
                }}
                className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium transition-colors ${
                  category === null && groupId === group.id
                    ? "bg-brand text-brand-foreground"
                    : "bg-warm-page text-stone-600 hover:bg-warm-muted hover:text-slate-950 dark:text-stone-400 dark:hover:text-stone-100"
                }`}
              >
                {group.label}
              </RemotionButton>
            ))}
          </nav>
        ) : null}
        {showCategoryChoices && categoryChoices.length > 1 ? (
          <div className="flex gap-1 overflow-x-auto pb-0.5 [scrollbar-width:none]">
            {categoryChoices.map((candidate) => (
              <RemotionButton
                key={candidate}
                type="button"
                aria-label={`Filter ${CATEGORY_LABELS[candidate]}`}
                onClick={() => updateCategory(candidate)}
                className={`shrink-0 rounded-md px-2 py-1 text-[10px] transition-colors ${
                  category === candidate
                    ? "bg-brand/[0.12] font-semibold text-brand"
                    : "text-stone-500 hover:bg-warm-muted hover:text-slate-950 dark:text-stone-400 dark:hover:text-stone-100"
                }`}
              >
                {CATEGORY_LABELS[candidate]}
              </RemotionButton>
            ))}
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {records.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-2">
            {records.map((record) => {
              const existingMediaAsset = findTimelineLibraryProjectAsset(
                staticState,
                record,
              );
              const admissionInput = timelineLibraryMediaAdmissionInput(record);
              const previewApplication = buildTimelineLibraryApplication({
                state: renderState,
                record,
                createId: (prefix) => `preview-${prefix}`,
                mediaAsset: existingMediaAsset,
              });
              const disabledReason =
                admissionInput && onAdmitLibraryMedia
                  ? undefined
                  : previewApplication.disabledReason;
              return (
                <LibraryCard
                  key={record.item.id}
                  record={record}
                  disabledReason={disabledReason}
                  onApply={() => {
                    if (disabledReason) {
                      emitTimelineNotice(disabledReason);
                      return;
                    }
                    void (async () => {
                      try {
                        const mediaAsset =
                          existingMediaAsset ??
                          (admissionInput && onAdmitLibraryMedia
                            ? normalizeEditorAsset(
                                await onAdmitLibraryMedia(admissionInput),
                              )
                            : undefined);
                        const application = buildTimelineLibraryApplication({
                          state: readState(),
                          record,
                          createId,
                          mediaAsset,
                        });
                        if (application.disabledReason) {
                          emitTimelineNotice(application.disabledReason);
                          return;
                        }
                        application.actions.forEach(dispatch);
                      } catch (error) {
                        emitTimelineNotice(
                          error instanceof Error
                            ? error.message
                            : "Could not add catalog media to the Project.",
                        );
                      }
                    })();
                  }}
                />
              );
            })}
          </div>
        ) : (
          <div className="flex h-40 flex-col items-center justify-center text-center">
            <p className="m-0 text-[12px] font-semibold text-slate-950 dark:text-stone-100">
              No matching library items
            </p>
            <p className="m-0 mt-1 text-[11px] text-stone-500 dark:text-stone-400">
              Try a category or a broader search.
            </p>
          </div>
        )}
      </div>
    </section>
  );
};
