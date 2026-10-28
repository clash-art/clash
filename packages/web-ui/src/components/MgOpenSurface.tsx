/**
 * Hilo-homage MG open chrome: full-bleed stage + right inspector strip.
 *
 * Topology mirrors Hilo's MotionNativeSurface (center stage) +
 * MotionGraphicInspector lite + MotionElementInspector (text/x/y) +
 * HtmlMotionPreviewControls (trusted transport) + bottom scrub bar.
 *
 * Preview + element edit lite (HTML + Remotion) — open-state SessionDraft for
 * elementOverrides; no Edit code / Edit HTML (#469). Local playhead only —
 * no audio-master-clock. Canvas SoT is elementOverrides (+ derived HTML content
 * on HTML checkpoint; Remotion keeps TSX content and applies overrides via
 * componentProps), not per-keystroke full source rewrite.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import { useReactFlow } from "@xyflow/react";
import { Code, FilmStrip, X } from "@phosphor-icons/react";
import { Player, type PlayerRef } from "@remotion/player";
import { HtmlSceneSurface, RemotionSourceComposition } from "@clash/remotion-components";

import { useOptionalLoroSyncContext } from "./LoroSyncContext";
import {
  deriveHtmlMotionContent,
  listHtmlMotionEditableElementsWithOverrides,
  mergeElementOverride,
  normalizeElementOverrides,
  seedElementOverridesFromHtml,
  serializeElementOverrides,
  type MgEditableElement,
  type MgElementOverrides,
  type MgElementPatch,
} from "../lib/htmlMotionElementEdit";
import {
  buildRemotionMgComponentProps,
  listRemotionEditableElementsWithOverrides,
  seedElementOverridesFromRemotionSource,
} from "../lib/remotionElementEdit";
import { Dialog } from "./ui/dialog";
import { IconButton } from "./ui/icon-button";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/** Match text document autosave cadence — avoid loro version explosion on inspector keystrokes. */
const MG_ELEMENT_AUTOSAVE_DELAY_MS = 500;

export type MgOpenSession = {
  nodeId: string;
  kind: "remotion-component" | "html-motion";
  label: string;
  /** Base/template HTML from node `data.content` (may already be derived). */
  source: string;
  /**
   * Authoritative element override map from node `data.elementOverrides`
   * (`data-mg-id` -> `{ text?, x?, y? }`). Absent/empty = parse from HTML
   * or Remotion TSX markers.
   */
  elementOverrides?: MgElementOverrides;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  componentId?: string;
  documentId?: string;
};

function durationSeconds(fps: number, durationInFrames: number): string {
  return (durationInFrames / Math.max(1, fps)).toFixed(2);
}

function formatTimecode(frame: number, fps: number): string {
  const safeFps = Math.max(1, fps);
  const totalSec = Math.max(0, frame) / safeFps;
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  const f = Math.max(0, frame) % safeFps;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
}

function StageProgressBar({
  frame,
  durationInFrames,
  fps,
  onSeek,
}: {
  frame: number;
  durationInFrames: number;
  fps: number;
  onSeek: (frame: number) => void;
}) {
  const max = Math.max(0, durationInFrames - 1);
  return (
    <div
      data-testid="mg-open-progress-bar"
      className="flex w-full shrink-0 items-center gap-3 border-t border-white/10 bg-black/80 px-4 py-2"
      aria-label="Preview progress"
    >
      <span
        data-testid="mg-open-progress-timecode"
        className="shrink-0 text-xs tabular-nums text-neutral-300"
      >
        {formatTimecode(frame, fps)}
      </span>
      <input
        data-testid="mg-open-progress-range"
        type="range"
        min={0}
        max={max}
        step={1}
        value={Math.min(frame, max)}
        aria-label="Scrub frame"
        className="h-1.5 w-full flex-1 cursor-pointer accent-cyan-400"
        onChange={(event) => onSeek(Number(event.target.value))}
      />
      <span
        data-testid="mg-open-progress-frame"
        className="shrink-0 text-xs tabular-nums text-neutral-400"
      >
        {frame} / {durationInFrames}f
      </span>
    </div>
  );
}

function HtmlStage({
  session,
  source,
  frame,
  onElementEdit,
  onElementSelect,
}: {
  session: MgOpenSession;
  source: string;
  frame: number;
  onElementEdit: (elementId: string, patch: MgElementPatch) => void;
  onElementSelect: (elementId: string | null) => void;
}) {
  return (
    <div
      data-testid="mg-open-stage-html"
      className="relative flex min-h-0 flex-1 items-center justify-center bg-black"
    >
      <div
        className="h-full max-h-full w-full max-w-full overflow-hidden"
        style={{ aspectRatio: `${session.width} / ${session.height}` }}
      >
        <HtmlSceneSurface
          source={source}
          frame={frame}
          fps={session.fps}
          durationInFrames={session.durationInFrames}
          title={session.label}
          sourceNodeId={session.nodeId}
          className="h-full w-full"
          style={{ width: "100%", height: "100%", border: 0 }}
          elementEdit
          sceneWidth={session.width}
          onElementEdit={(event) =>
            onElementEdit(event.elementId, event.patch)
          }
          onElementSelect={(event) => onElementSelect(event.elementId)}
        />
      </div>
    </div>
  );
}

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

function RemotionStage({
  session,
  source,
  componentProps,
  playerRef,
  autoPlay,
  onElementEdit,
  onElementSelect,
}: {
  session: MgOpenSession;
  source: string;
  componentProps: Record<string, unknown>;
  playerRef: RefObject<PlayerRef | null>;
  autoPlay: boolean;
  onElementEdit: (elementId: string, patch: MgElementPatch) => void;
  onElementSelect: (elementId: string | null) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const onEditRef = useRef(onElementEdit);
  const onSelectRef = useRef(onElementSelect);
  onEditRef.current = onElementEdit;
  onSelectRef.current = onElementSelect;

  // Stage drag / dblclick on [data-mg-id] inside the Player DOM (HTML parity).
  useEffect(() => {
    const root = stageRef.current;
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
      return rect.width > 0 ? session.width / rect.width : 1;
    };

    const editableOf = (el: Element) => {
      const raw = (el.getAttribute("data-mg-editable") || "")
        .split(",")
        .map((v) => v.trim());
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

    const onPointerDown = (ev: PointerEvent) => {
      const t = ev.target;
      if (!(t instanceof Element)) return;
      const el = t.closest("[data-mg-id]");
      if (!(el instanceof HTMLElement) || !root.contains(el)) return;
      const id = el.getAttribute("data-mg-id");
      if (!id) return;
      const caps = editableOf(el);
      onSelectRef.current(id);
      if (!caps.position) return;
      const xy = readXY(el);
      drag = {
        el,
        id,
        startX: ev.clientX,
        startY: ev.clientY,
        baseX: xy.x,
        baseY: xy.y,
      };
      try {
        el.setPointerCapture(ev.pointerId);
      } catch {
        // ignore
      }
      ev.preventDefault();
    };

    const onPointerMove = (ev: PointerEvent) => {
      if (!drag) return;
      const s = scale();
      const dx = (ev.clientX - drag.startX) * s;
      const dy = (ev.clientY - drag.startY) * s;
      applyLiveTranslate(
        drag.el,
        Math.round(drag.baseX + dx),
        Math.round(drag.baseY + dy),
      );
    };

    const endDrag = () => {
      if (!drag) return;
      const xy = readXY(drag.el);
      onEditRef.current(drag.id, { x: xy.x, y: xy.y });
      drag = null;
    };

    const onDblClick = (ev: MouseEvent) => {
      const t = ev.target;
      if (!(t instanceof Element)) return;
      const el = t.closest("[data-mg-id]");
      if (!(el instanceof HTMLElement) || !root.contains(el)) return;
      if (!editableOf(el).text) return;
      const id = el.getAttribute("data-mg-id");
      if (!id) return;
      el.contentEditable = "true";
      el.focus();
      const commit = () => {
        el.contentEditable = "false";
        el.removeEventListener("blur", commit);
        onEditRef.current(id, { text: (el.textContent || "").trim() });
      };
      el.addEventListener("blur", commit);
      ev.preventDefault();
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
  }, [session.width, session.nodeId, source]);

  return (
    <div
      ref={stageRef}
      data-testid="mg-open-stage-remotion"
      className="relative flex min-h-0 flex-1 items-center justify-center bg-black"
    >
      <div
        className="h-full max-h-full w-full max-w-full overflow-hidden"
        style={{ aspectRatio: `${session.width} / ${session.height}` }}
      >
        <Player
          ref={playerRef}
          key={`mg-open:${session.componentId ?? session.nodeId}:${source}`}
          component={RemotionSourceComposition}
          compositionWidth={session.width}
          compositionHeight={session.height}
          durationInFrames={session.durationInFrames}
          fps={session.fps}
          inputProps={{
            source,
            componentId: session.componentId ?? session.nodeId,
            componentProps,
          }}
          controls={false}
          autoPlay={autoPlay}
          loop
          clickToPlay={false}
          style={{ width: "100%", height: "100%" }}
        />
      </div>
    </div>
  );
}

function MgElementInspector({
  elements,
  selectedId,
  onSelect,
  onPatch,
}: {
  elements: MgEditableElement[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPatch: (elementId: string, patch: MgElementPatch) => void;
}) {
  const selected =
    elements.find((item) => item.id === selectedId) ?? elements[0] ?? null;

  if (!elements.length) {
    return (
      <div
        data-testid="mg-open-element-inspector-empty"
        className="space-y-1 border-t border-warm-border pt-4"
      >
        <p className="text-xs font-medium text-content-secondary">Elements</p>
        <p className="text-xs leading-relaxed text-content-muted">
          No editable elements. Author{" "}
          <code className="text-[10px]">data-mg-id</code> +{" "}
          <code className="text-[10px]">data-mg-editable=&quot;text,position&quot;</code>{" "}
          on HTML nodes or Remotion JSX (default create templates include one).
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="mg-open-element-inspector"
      className="space-y-3 border-t border-warm-border pt-4"
      aria-label="Motion element inspector"
    >
      <p className="text-xs font-medium text-content-secondary">Elements</p>
      <ul className="space-y-1" data-testid="mg-open-element-list">
        {elements.map((el) => (
          <li key={el.id}>
            <button
              type="button"
              data-testid={`mg-open-element-${el.id}`}
              aria-pressed={selected?.id === el.id}
              className={`w-full truncate rounded px-2 py-1.5 text-left text-xs ${
                selected?.id === el.id
                  ? "bg-warm-hover text-content-primary"
                  : "text-content-secondary hover:bg-warm-hover/60"
              }`}
              onClick={() => onSelect(el.id)}
            >
              {el.id}
            </button>
          </li>
        ))}
      </ul>

      {selected ? (
        <div className="space-y-3" data-testid="mg-open-element-fields">
          <p className="truncate text-xs text-content-muted">{selected.id}</p>
          {selected.editable.includes("text") ? (
            <label className="block space-y-1 text-xs text-content-secondary">
              <span>Text</span>
              <Input
                data-testid="mg-open-element-text"
                aria-label="Element text"
                value={selected.text}
                maxLength={8192}
                onChange={(event) =>
                  onPatch(selected.id, { text: event.target.value })
                }
              />
            </label>
          ) : null}
          {selected.editable.includes("position") ? (
            <div className="grid grid-cols-2 gap-2">
              <label className="block space-y-1 text-xs text-content-secondary">
                <span>X</span>
                <Input
                  data-testid="mg-open-element-x"
                  aria-label="Element X"
                  type="number"
                  step={1}
                  value={String(Math.round(selected.x * 100) / 100)}
                  onChange={(event) => {
                    const n = Number(event.target.value);
                    if (!Number.isFinite(n)) return;
                    onPatch(selected.id, { x: n });
                  }}
                />
              </label>
              <label className="block space-y-1 text-xs text-content-secondary">
                <span>Y</span>
                <Input
                  data-testid="mg-open-element-y"
                  aria-label="Element Y"
                  type="number"
                  step={1}
                  value={String(Math.round(selected.y * 100) / 100)}
                  onChange={(event) => {
                    const n = Number(event.target.value);
                    if (!Number.isFinite(n)) return;
                    onPatch(selected.id, { y: n });
                  }}
                />
              </label>
            </div>
          ) : null}
          <p className="text-[11px] leading-relaxed text-content-muted">
            Drag on stage to move position; double-click text on stage to edit.
            Draft overrides flush to Canvas on pause / drag end / close.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function MgInspector({
  session,
  frame,
  playing,
  elements,
  selectedElementId,
  onSelectElement,
  onElementPatch,
  onTogglePlay,
  onSeek,
  onClose,
}: {
  session: MgOpenSession;
  frame: number;
  playing: boolean;
  elements: MgEditableElement[];
  selectedElementId: string | null;
  onSelectElement: (id: string) => void;
  onElementPatch: (elementId: string, patch: MgElementPatch) => void;
  onTogglePlay: () => void;
  onSeek: (frame: number) => void;
  onClose: () => void;
}) {
  const [frameDraft, setFrameDraft] = useState(String(frame));
  useEffect(() => {
    setFrameDraft(String(frame));
  }, [frame]);

  const submitSeek = (event: FormEvent) => {
    event.preventDefault();
    const next = Number(frameDraft);
    if (!Number.isFinite(next)) return;
    const clamped = Math.max(
      0,
      Math.min(session.durationInFrames - 1, Math.round(next)),
    );
    onSeek(clamped);
  };

  const KindIcon = session.kind === "html-motion" ? Code : FilmStrip;

  return (
    <aside
      data-testid="mg-open-inspector"
      aria-label="Motion graphic inspector"
      className="flex h-full w-[300px] shrink-0 flex-col border-l border-warm-border bg-warm-surface"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-warm-border px-3">
        <KindIcon className="h-4 w-4 shrink-0 text-brand" weight="duotone" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-content-primary">
          {session.label}
        </h2>
        <IconButton
          label={
            session.kind === "html-motion"
              ? "Close HTML Motion preview"
              : "Close Remotion preview"
          }
          onClick={onClose}
          icon={<X className="h-5 w-5" weight="bold" />}
          size="sm"
          shape="circle"
          className="text-content-secondary hover:bg-warm-hover hover:text-content-primary"
        />
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div className="space-y-1">
          <p className="text-xs font-medium text-content-secondary">Name</p>
          <p
            data-testid="mg-open-inspector-name"
            className="truncate text-sm text-content-primary"
          >
            {session.label}
          </p>
        </div>

        <p
          data-testid="mg-open-inspector-meta"
          className="text-xs tabular-nums text-content-muted"
        >
          {session.width} × {session.height} · {session.fps} fps ·{" "}
          {durationSeconds(session.fps, session.durationInFrames)} s
        </p>

        <div
          data-testid="mg-open-transport"
          className="space-y-3 border-t border-warm-border pt-4"
          aria-label="Preview transport"
        >
          <p className="text-xs font-medium text-content-secondary">Transport</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              data-testid="mg-open-play-pause"
              onClick={onTogglePlay}
            >
              {playing ? "Pause" : "Play"}
            </Button>
            <span
              data-testid="mg-open-frame-readout"
              className="text-xs tabular-nums text-content-muted"
            >
              {frame} / {session.durationInFrames}f
            </span>
          </div>
          <form
            className="flex items-center gap-2"
            onSubmit={submitSeek}
            data-testid="mg-open-seek-form"
          >
            <Input
              aria-label="Frame"
              data-testid="mg-open-frame-input"
              className="h-8 w-24"
              type="number"
              min={0}
              max={Math.max(0, session.durationInFrames - 1)}
              value={frameDraft}
              onChange={(event) => setFrameDraft(event.target.value)}
            />
            <Button type="submit" variant="default" size="sm">
              Seek
            </Button>
          </form>
        </div>

        <MgElementInspector
          elements={elements}
          selectedId={selectedElementId}
          onSelect={onSelectElement}
          onPatch={onElementPatch}
        />

        <p className="mt-auto text-xs leading-relaxed text-content-muted">
          Preview + element edit lite (HTML + Remotion) — Hilo surface homage.
          Edit code / Edit HTML dialogs are not restored. No audio-master-clock.
        </p>
      </div>
    </aside>
  );
}

export function MgOpenSurface({
  session,
  onClose,
}: {
  session: MgOpenSession;
  onClose: () => void;
}) {
  const playerRef = useRef<PlayerRef>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true);
  const initialOverrides = normalizeElementOverrides(session.elementOverrides);
  const [draftOverrides, setDraftOverrides] =
    useState<MgElementOverrides>(initialOverrides);
  const [source, setSource] = useState(() =>
    session.kind === "html-motion"
      ? deriveHtmlMotionContent(session.source, initialOverrides)
      : session.source,
  );
  const [selectedElementId, setSelectedElementId] = useState<string | null>(
    null,
  );
  const loroSync = useOptionalLoroSyncContext();
  const reactFlow = useReactFlow();

  /** Base/template source (HTML doc or Remotion TSX) — not the draft-derived view. */
  const baseSourceRef = useRef(session.source);
  const latestOverridesRef = useRef<MgElementOverrides>(initialOverrides);
  const persistedOverridesRef = useRef<string>(
    serializeElementOverrides(initialOverrides),
  );
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const kindRef = useRef(session.kind);
  kindRef.current = session.kind;

  const sessionOverridesKey = serializeElementOverrides(
    normalizeElementOverrides(session.elementOverrides),
  );

  const remotionComponentProps = useMemo(
    () => buildRemotionMgComponentProps(draftOverrides),
    [draftOverrides],
  );

  useEffect(() => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const nextOverrides = normalizeElementOverrides(session.elementOverrides);
    baseSourceRef.current = session.source;
    latestOverridesRef.current = nextOverrides;
    persistedOverridesRef.current = serializeElementOverrides(nextOverrides);
    setDraftOverrides(nextOverrides);
    setSource(
      session.kind === "html-motion"
        ? deriveHtmlMotionContent(session.source, nextOverrides)
        : session.source,
    );
    setSelectedElementId(null);
    setFrame(0);
    setPlaying(true);
    // sessionOverridesKey fingerprints elementOverrides (avoid object-identity churn).
  }, [session.nodeId, session.source, session.kind, sessionOverridesKey]);

  const elements = useMemo(
    () =>
      session.kind === "html-motion"
        ? listHtmlMotionEditableElementsWithOverrides(
            baseSourceRef.current,
            draftOverrides,
          )
        : listRemotionEditableElementsWithOverrides(
            baseSourceRef.current,
            draftOverrides,
          ),
    [session.kind, draftOverrides, source],
  );

  useEffect(() => {
    if (!elements.length) {
      setSelectedElementId(null);
      return;
    }
    if (
      selectedElementId &&
      elements.some((item) => item.id === selectedElementId)
    ) {
      return;
    }
    setSelectedElementId(elements[0]!.id);
  }, [elements, selectedElementId]);

  // Keep canvas writers in refs so persistDraft stays identity-stable
  // (mirror TextDocumentEditorSurface onSaveRef) — otherwise the unmount-flush
  // effect re-runs cleanup on every render and defeats debounce.
  const nodeIdRef = useRef(session.nodeId);
  const reactFlowRef = useRef(reactFlow);
  const loroSyncRef = useRef(loroSync);
  nodeIdRef.current = session.nodeId;
  reactFlowRef.current = reactFlow;
  loroSyncRef.current = loroSync;

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
    const nodeId = nodeIdRef.current;
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
          node.id === nodeId
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
    loroSyncRef.current?.updateNode?.(nodeId, {
      data: dataPatch,
    });
    persistedOverridesRef.current = fingerprint;
    if (kindRef.current === "html-motion" && "content" in dataPatch) {
      setSource(dataPatch.content as string);
    }
  }, []);

  const schedulePersist = useCallback(() => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      persistDraft();
    }, MG_ELEMENT_AUTOSAVE_DELAY_MS);
  }, [persistDraft]);

  const commitOverridePatch = useCallback(
    (elementId: string, patch: MgElementPatch, mode: "debounce" | "immediate") => {
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
        if (kindRef.current === "html-motion") {
          setSource(deriveHtmlMotionContent(baseSourceRef.current, next));
        }
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
   * Stage pointerup / in-iframe text commit: already one-shot — persist immediately
   * (live translate stays in-iframe until pointerup; see htmlSandbox).
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

  const handleClose = useCallback(() => {
    persistDraft();
    onClose();
  }, [onClose, persistDraft]);

  // HTML: local interval playhead (not audio-master-clock).
  useEffect(() => {
    if (session.kind !== "html-motion" || !playing) return;
    const intervalMs = Math.max(1, Math.round(1000 / session.fps));
    const timer = window.setInterval(() => {
      setFrame((current) => (current + 1) % Math.max(1, session.durationInFrames));
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [playing, session.durationInFrames, session.fps, session.kind]);

  // Remotion: sync frame + playing from PlayerRef events.
  useEffect(() => {
    if (session.kind !== "remotion-component") return;
    const player = playerRef.current;
    if (!player) return;

    const onFrame = (event: { detail: { frame: number } }) => {
      setFrame(event.detail.frame);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    player.addEventListener("frameupdate", onFrame);
    player.addEventListener("play", onPlay);
    player.addEventListener("pause", onPause);
    setPlaying(player.isPlaying());
    setFrame(player.getCurrentFrame());
    return () => {
      player.removeEventListener("frameupdate", onFrame);
      player.removeEventListener("play", onPlay);
      player.removeEventListener("pause", onPause);
    };
  }, [session.kind, session.nodeId, session.source]);

  const togglePlay = () => {
    if (session.kind === "html-motion") {
      setPlaying((value) => !value);
      return;
    }
    const player = playerRef.current;
    if (!player) return;
    if (player.isPlaying()) player.pause();
    else player.play();
  };

  const seek = (next: number) => {
    const clamped = Math.max(
      0,
      Math.min(session.durationInFrames - 1, Math.round(next)),
    );
    if (session.kind === "html-motion") {
      setFrame(clamped);
      return;
    }
    playerRef.current?.seekTo(clamped);
    setFrame(clamped);
  };

  return (
    <Dialog
      open
      onClose={handleClose}
      ariaLabel={`Motion graphic: ${session.label}`}
      size="auto"
      hideCloseButton
      unstyled
      disableBackdropClose
      overlayClassName="z-[9999] bg-black/85 backdrop-blur-none"
      containerClassName="z-[9999] !inset-0 !p-0 flex items-stretch justify-stretch"
      contentClassName="!max-w-none !w-screen !h-screen !rounded-none !border-0 !shadow-none !p-0 overflow-hidden bg-neutral-950"
    >
      <div
        data-testid="mg-open-surface"
        data-mg-kind={session.kind}
        className="flex h-full min-h-0 w-full"
      >
        <div
          data-testid={
            session.kind === "html-motion"
              ? "html-motion-fullscreen-preview"
              : "remotion-component-fullscreen-preview"
          }
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          {session.kind === "html-motion" ? (
            <HtmlStage
              session={session}
              source={source}
              frame={frame}
              onElementEdit={applyElementPatchImmediate}
              onElementSelect={setSelectedElementId}
            />
          ) : (
            <RemotionStage
              session={session}
              source={source}
              componentProps={remotionComponentProps}
              playerRef={playerRef}
              autoPlay={playing}
              onElementEdit={applyElementPatchImmediate}
              onElementSelect={setSelectedElementId}
            />
          )}
          <StageProgressBar
            frame={frame}
            durationInFrames={session.durationInFrames}
            fps={session.fps}
            onSeek={seek}
          />
        </div>
        <MgInspector
          session={session}
          frame={frame}
          playing={playing}
          elements={elements}
          selectedElementId={selectedElementId}
          onSelectElement={setSelectedElementId}
          onElementPatch={applyElementPatch}
          onTogglePlay={togglePlay}
          onSeek={seek}
          onClose={handleClose}
        />
      </div>
    </Dialog>
  );
}
