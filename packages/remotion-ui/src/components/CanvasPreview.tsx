import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import * as Ariakit from "@ariakit/react";
import {
  useEditorDispatch,
  useEditorHistory,
  useEditorPlayback,
  useEditorPlaybackRefs,
  useEditorStaticState,
} from "@clash/remotion-core";
import {
  InteractiveCanvas,
  type CanvasViewportCommand,
} from "./InteractiveCanvas";
import { TimelineIconButton, TimelineRangeInput } from "./ui/controls";
import { colors, typography } from "./timeline/styles";
import { formatTimecode } from "./timeline/utils/timeFormatter";
import {
  getPreviewAudioMeterValue,
  type PreviewAudioMeterStore,
  type StereoAudioLevels,
} from "./previewAudioMeter";

const PREVIEW_STYLES = `
  ::view-transition-group(clash-canvas-preview),
  ::view-transition-old(clash-canvas-preview),
  ::view-transition-new(clash-canvas-preview) {
    animation: none;
    mix-blend-mode: normal;
  }
  @container preview (max-width: 560px) {
    [data-canvas-preview] [data-preview-duration],
    [data-canvas-preview] [data-preview-aspect] {
      display: none !important;
    }
    [data-canvas-preview] [data-preview-transport] {
      grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) !important;
      padding-inline: 10px !important;
    }
  }
`;

const buttonStyle: React.CSSProperties = {
  width: 30,
  height: 30,
  padding: 0,
  border: 0,
  borderRadius: 7,
  background: "transparent",
  color: colors.text.secondary,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};

const greatestCommonDivisor = (a: number, b: number): number =>
  b === 0 ? a : greatestCommonDivisor(b, a % b);

const METER_ICON_HEIGHT = 14;
const SILENT_AUDIO_LEVELS: StereoAudioLevels = { left: 0, right: 0 };
const subscribeToSilence = () => () => undefined;
const getSilentAudioLevels = () => SILENT_AUDIO_LEVELS;

const shouldClaimCanvasKeyboardFocus = (
  target: EventTarget | null,
): boolean =>
  target instanceof HTMLElement &&
  !target.closest(
    'button, input, textarea, select, [contenteditable="true"], [role="slider"], [role="spinbutton"]',
  );

const isCanvasSelectionTarget = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  Boolean(
    target.closest(
      '.item-clickable, .control-handle, [aria-label="Canvas minimap"], button, input, textarea, select, [contenteditable="true"], [role="slider"], [role="spinbutton"]',
    ),
  );

const getMeterFillGeometry = (amplitude: number) => {
  const height =
    (getPreviewAudioMeterValue(amplitude).percentage / 100) * METER_ICON_HEIGHT;
  return { y: 16 - height, height };
};

const StereoMeterIcon: React.FC<{ levels: StereoAudioLevels }> = ({
  levels,
}) => {
  const left = getMeterFillGeometry(levels.left);
  const right = getMeterFillGeometry(levels.right);
  return (
    <svg
      data-stereo-meter-icon=""
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden="true"
    >
      <g data-audio-meter-channel="L">
        <rect
          x="3"
          y="2"
          width="4"
          height="14"
          rx="2"
          fill="currentColor"
          opacity="0.14"
        />
        <rect
          data-audio-meter-fill="L"
          x="3"
          y={left.y}
          width="4"
          height={left.height}
          rx="2"
          fill="var(--clash-accent, #ff6b50)"
        />
      </g>
      <g data-audio-meter-channel="R">
        <rect
          x="11"
          y="2"
          width="4"
          height="14"
          rx="2"
          fill="currentColor"
          opacity="0.14"
        />
        <rect
          data-audio-meter-fill="R"
          x="11"
          y={right.y}
          width="4"
          height={right.height}
          rx="2"
          fill="var(--clash-accent, #ff6b50)"
        />
      </g>
    </svg>
  );
};

type CanvasPreviewProps = {
  audioMeterOpen?: boolean;
  onToggleAudioMeter?: () => void;
  audioMeterStore?: PreviewAudioMeterStore;
  /** Live Canvas nodes resolved by Timeline items such as remotion-component. */
  runtimeNodes?: TimelineRuntimeNode[];
};

export type TimelineRuntimeNode = {
  id: string;
  type: string;
  data: Record<string, unknown>;
};

export const CanvasPreview: React.FC<CanvasPreviewProps> = React.memo(
  ({
    audioMeterOpen = false,
    onToggleAudioMeter,
    audioMeterStore,
    runtimeNodes = [],
  }) => {
    const dispatch = useEditorDispatch();
    const { beginHistoryGroup, endHistoryGroup } = useEditorHistory();
    const {
      tracks,
      assets,
      selectedItemId,
      compositionWidth,
      compositionHeight,
      fps,
      durationInFrames: timelineDuration,
    } = useEditorStaticState();
    const { currentFrame, playing } = useEditorPlayback();
    const { currentFrameRef, playingRef } = useEditorPlaybackRefs();
    const rootRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const canvasKeyboardActiveRef = useRef(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [viewportCommand, setViewportCommand] =
      useState<CanvasViewportCommand>();
    const [canvasZoom, setCanvasZoom] = useState(1);
    const compactAudioLevels = useSyncExternalStore(
      audioMeterStore?.subscribe ?? subscribeToSilence,
      audioMeterStore?.getSnapshot ?? getSilentAudioLevels,
      audioMeterStore?.getSnapshot ?? getSilentAudioLevels,
    );

    const allNodesMap = useMemo(() => {
      const map = new Map<string, any>();
      for (const asset of assets) {
        const nodeData = {
          type: asset.type,
          data: {
            src: asset.src,
            naturalWidth: asset.width,
            naturalHeight: asset.height,
          },
        };
        map.set(asset.id, nodeData);
        if (asset.sourceNodeId && asset.sourceNodeId !== asset.id) {
          map.set(asset.sourceNodeId, nodeData);
        }
        if (asset.projectAssetId) {
          map.set(asset.projectAssetId, nodeData);
        }
      }
      for (const node of runtimeNodes) {
        map.set(node.id, node);
      }
      return map;
    }, [assets, runtimeNodes]);

    const aspectRatio = useMemo(() => {
      const divisor =
        greatestCommonDivisor(compositionWidth, compositionHeight) || 1;
      return `${compositionWidth / divisor}:${compositionHeight / divisor}`;
    }, [compositionHeight, compositionWidth]);
    const displayFrame = Math.min(
      currentFrame,
      Math.max(0, timelineDuration - 1),
    );

    useEffect(() => {
      const handleFullscreenChange = () => {
        setIsFullscreen(document.fullscreenElement === rootRef.current);
      };
      document.addEventListener("fullscreenchange", handleFullscreenChange);
      return () =>
        document.removeEventListener(
          "fullscreenchange",
          handleFullscreenChange,
        );
    }, []);

    const toggleFullscreen = useCallback(() => {
      if (document.fullscreenElement === rootRef.current) {
        void document.exitFullscreen?.();
        return;
      }
      void rootRef.current?.requestFullscreen?.();
    }, []);

    const claimCanvasKeyboardFocus = useCallback(
      (event: React.SyntheticEvent<HTMLElement>) => {
        const shouldClaim = shouldClaimCanvasKeyboardFocus(event.target);
        canvasKeyboardActiveRef.current = shouldClaim;
        if (!shouldClaim) return;
        stageRef.current?.focus({ preventScroll: true });
      },
      [],
    );

    const handleCanvasSurfacePress = useCallback(
      (event: React.SyntheticEvent<HTMLDivElement>) => {
        claimCanvasKeyboardFocus(event);
        const target = event.target;
        if (
          !selectedItemId ||
          !(target instanceof Node) ||
          !stageRef.current?.contains(target) ||
          isCanvasSelectionTarget(target)
        ) {
          return;
        }
        dispatch({ type: "SELECT_ITEM", payload: null });
      },
      [claimCanvasKeyboardFocus, dispatch, selectedItemId],
    );

    useEffect(() => {
      const deactivateOutsideCanvas = (event: Event) => {
        const root = rootRef.current;
        if (!root || !(event.target instanceof Node)) return;
        if (!root.contains(event.target)) {
          canvasKeyboardActiveRef.current = false;
        }
      };
      document.addEventListener("pointerdown", deactivateOutsideCanvas, true);
      document.addEventListener("mousedown", deactivateOutsideCanvas, true);
      return () => {
        document.removeEventListener(
          "pointerdown",
          deactivateOutsideCanvas,
          true,
        );
        document.removeEventListener("mousedown", deactivateOutsideCanvas, true);
      };
    }, []);

    useEffect(() => {
      const handleCanvasDelete = (event: KeyboardEvent) => {
        const key = event.key.toLowerCase();
        if (
          !canvasKeyboardActiveRef.current ||
          event.defaultPrevented ||
          event.metaKey ||
          event.ctrlKey ||
          (key !== "delete" && key !== "backspace") ||
          !selectedItemId
        ) {
          return;
        }
        const selectedTrack = tracks.find((track) =>
          track.items.some((item) => item.id === selectedItemId),
        );
        if (!selectedTrack) return;

        event.preventDefault();
        event.stopImmediatePropagation();
        dispatch({
          type: "REMOVE_ITEM",
          payload: { trackId: selectedTrack.id, itemId: selectedItemId },
        });
      };
      window.addEventListener("keydown", handleCanvasDelete, true);
      return () =>
        window.removeEventListener("keydown", handleCanvasDelete, true);
    }, [dispatch, selectedItemId, tracks]);

    return (
      <div
        ref={rootRef}
        data-testid="canvas-preview"
        data-canvas-preview=""
        data-surface="warm-panel"
        onPointerDownCapture={handleCanvasSurfacePress}
        onMouseDownCapture={handleCanvasSurfacePress}
        onClickCapture={claimCanvasKeyboardFocus}
        style={{ ...styles.container, outline: "none" }}
      >
        <style>{PREVIEW_STYLES}</style>
        <div
          ref={stageRef}
          role="application"
          tabIndex={0}
          aria-label="Canvas editor"
          data-preview-stage=""
          onFocusCapture={() => {
            canvasKeyboardActiveRef.current = true;
          }}
          onBlurCapture={(event) => {
            const nextTarget = event.relatedTarget;
            if (
              !(nextTarget instanceof Node) ||
              !rootRef.current?.contains(nextTarget)
            ) {
              canvasKeyboardActiveRef.current = false;
            }
          }}
          className="outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/45"
          style={styles.stage}
        >
          <InteractiveCanvas
            key="interactive-canvas"
            tracks={tracks}
            allNodesMap={allNodesMap}
            selectedItemId={selectedItemId}
            currentFrame={currentFrame}
            compositionWidth={compositionWidth}
            compositionHeight={compositionHeight}
            fps={fps}
            durationInFrames={timelineDuration}
            viewportCommand={viewportCommand}
            onViewportZoomChange={setCanvasZoom}
            audioMeterEnabled={audioMeterOpen || Boolean(audioMeterStore)}
            onAudioLevelsChange={audioMeterStore?.setLevels}
            onTransformStart={beginHistoryGroup}
            onTransformEnd={endHistoryGroup}
            onUpdateItem={(trackId, itemId, updates) => {
              dispatch({
                type: "UPDATE_ITEM",
                payload: { trackId, itemId, updates },
              });
            }}
            onSelectItem={(itemId) =>
              dispatch({ type: "SELECT_ITEM", payload: itemId })
            }
            playing={playing}
            onPlayingChange={(nextPlaying) => {
              if (playingRef.current !== nextPlaying) {
                dispatch({ type: "SET_PLAYING", payload: nextPlaying });
              }
            }}
            onFrameUpdate={(frame) => {
              const roundedFrame = Math.round(frame);
              if (roundedFrame !== currentFrameRef.current) {
                dispatch({ type: "SET_CURRENT_FRAME", payload: roundedFrame });
              }
            }}
            onSeek={(frame) => {
              if (frame !== currentFrameRef.current) {
                dispatch({ type: "SET_CURRENT_FRAME", payload: frame });
              }
            }}
          />
        </div>

        <div data-preview-transport="" style={styles.transport}>
          <div style={styles.timecodeGroup}>
            <output
              aria-label="Current timecode"
              style={styles.currentTimecode}
            >
              {formatTimecode(displayFrame, fps)}
            </output>
            <span data-preview-duration="" style={styles.durationGroup}>
              <span aria-hidden="true">/</span>
              <output aria-label="Duration timecode">
                {formatTimecode(timelineDuration, fps)}
              </output>
            </span>
            <TimelineIconButton
              aria-label="Audio level meter"
              aria-pressed={audioMeterOpen}
              title={
                audioMeterOpen
                  ? "Hide audio level meter"
                  : "Show audio level meter"
              }
              onClick={onToggleAudioMeter}
              style={{
                ...styles.audioMeterButton,
                ...(audioMeterOpen ? styles.audioMeterButtonActive : null),
              }}
            >
              <StereoMeterIcon levels={compactAudioLevels} />
            </TimelineIconButton>
          </div>

          <TimelineIconButton
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause" : "Play"}
            onClick={() =>
              dispatch({ type: "SET_PLAYING", payload: !playingRef.current })
            }
            style={styles.playButton}
          >
            {playing ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
              </svg>
            ) : (
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </TimelineIconButton>

          <div style={styles.trailingControls}>
            <span
              data-preview-aspect=""
              aria-label="Composition aspect ratio"
              style={styles.aspectRatio}
            >
              {aspectRatio}
            </span>
            <Ariakit.PopoverProvider placement="top-end">
              <Ariakit.PopoverDisclosure
                render={<TimelineIconButton style={buttonStyle} />}
                aria-label="Canvas zoom"
                title={`Canvas zoom · ${Math.round(canvasZoom * 100)}%`}
              >
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5" />
                  <rect x="7" y="7" width="10" height="10" rx="1.5" />
                </svg>
              </Ariakit.PopoverDisclosure>
              <Ariakit.Popover
                portal
                gutter={8}
                role="dialog"
                aria-label="Canvas zoom controls"
                style={styles.zoomPopover}
              >
                <div style={styles.zoomPopoverHeader}>
                  <span>Canvas zoom</span>
                  <output
                    aria-label="Canvas zoom percentage"
                    style={styles.zoomPercentage}
                  >
                    {Math.round(canvasZoom * 100)}%
                  </output>
                </div>
                <div style={styles.zoomRegulatorRow}>
                  <TimelineRangeInput
                    aria-label="Canvas zoom level"
                    min={10}
                    max={500}
                    step={1}
                    value={Math.round(canvasZoom * 100)}
                    onChange={(event) => {
                      const zoom = Number(event.currentTarget.value) / 100;
                      setCanvasZoom(zoom);
                      setViewportCommand((command) => ({
                        id: (command?.id ?? 0) + 1,
                        type: "set-zoom",
                        zoom,
                      }));
                    }}
                    style={styles.zoomRange}
                  />
                  <TimelineIconButton
                    aria-label="Fit canvas"
                    title="Fit canvas"
                    onClick={() => {
                      setCanvasZoom(1);
                      setViewportCommand((command) => ({
                        id: (command?.id ?? 0) + 1,
                        type: "reset",
                      }));
                    }}
                    style={styles.fitButton}
                  >
                    Fit
                  </TimelineIconButton>
                </div>
              </Ariakit.Popover>
            </Ariakit.PopoverProvider>
            <TimelineIconButton
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              onClick={toggleFullscreen}
              style={buttonStyle}
            >
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                {isFullscreen ? (
                  <path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" />
                ) : (
                  <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5" />
                )}
              </svg>
            </TimelineIconButton>
          </div>
        </div>
      </div>
    );
  },
);

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    container: "preview / inline-size",
    backgroundColor: colors.bg.primary,
    color: colors.text.primary,
  },
  stage: {
    position: "relative",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    backgroundColor: colors.bg.primary,
    viewTransitionName: "clash-canvas-preview",
  },
  transport: {
    position: "relative",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)",
    alignItems: "center",
    flex: "0 0 50px",
    gap: 12,
    padding: "0 14px",
    borderTop: `1px solid ${colors.border.subtle}`,
    backgroundColor: colors.bg.primary,
  },
  timecodeGroup: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    gap: 7,
    fontFamily: typography.fontFamily.mono,
    fontSize: typography.fontSize.sm,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  currentTimecode: {
    color: colors.accent.primary,
    fontWeight: typography.fontWeight.semibold,
  },
  durationGroup: {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    color: colors.text.tertiary,
  },
  audioMeterButton: {
    ...buttonStyle,
    flex: "0 0 auto",
    marginLeft: 2,
  },
  audioMeterButtonActive: {
    backgroundColor: colors.bg.hover,
    color: colors.text.primary,
  },
  playButton: {
    width: 32,
    height: 32,
    padding: 0,
    border: 0,
    borderRadius: 999,
    backgroundColor: colors.accent.primary,
    color: "#ffffff",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  },
  trailingControls: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 5,
  },
  aspectRatio: {
    marginRight: 3,
    color: colors.text.tertiary,
    fontFamily: typography.fontFamily.mono,
    fontSize: typography.fontSize.xs,
    fontVariantNumeric: "tabular-nums",
  },
  zoomPopover: {
    zIndex: 1200,
    width: 226,
    padding: "10px 11px 11px",
    border: `1px solid ${colors.border.default}`,
    borderRadius: 9,
    backgroundColor: colors.bg.primary,
    color: colors.text.primary,
    boxShadow: "0 12px 32px rgba(45, 38, 31, 0.14)",
    outline: "none",
  },
  zoomPopoverHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 9,
    color: colors.text.secondary,
    fontFamily: typography.fontFamily.sans,
    fontSize: typography.fontSize.xs,
    fontWeight: typography.fontWeight.semibold,
  },
  zoomPercentage: {
    color: colors.accent.primary,
    fontFamily: typography.fontFamily.mono,
    fontVariantNumeric: "tabular-nums",
  },
  zoomRegulatorRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  zoomRange: {
    flex: 1,
    minWidth: 0,
    height: 18,
    margin: 0,
    accentColor: colors.accent.primary,
    cursor: "pointer",
  },
  fitButton: {
    minWidth: 36,
    height: 26,
    padding: "0 8px",
    border: `1px solid ${colors.border.default}`,
    borderRadius: 6,
    backgroundColor: colors.bg.secondary,
    color: colors.text.secondary,
    cursor: "pointer",
    fontFamily: typography.fontFamily.sans,
    fontSize: typography.fontSize.xs,
    fontWeight: typography.fontWeight.semibold,
  },
};
