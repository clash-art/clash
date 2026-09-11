import { createLogger } from "../../lib/logger";
import { memo, useState, useRef, useEffect, useMemo, useCallback } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import SourceHandleMenu from "./SourceHandleMenu";
import DraftPlaceholder from "./DraftPlaceholder";
import {
  Play,
  Pause,
  Eye,
  X,
  SpeakerHigh,
  SkipBack,
  SkipForward,
  Spinner,
} from "@phosphor-icons/react";
import { useMediaViewer } from "../MediaViewerContext";
import { useAsset } from "@clash/web-ui/lib/hooks/useAsset";
import { useProject } from "../ProjectContext";
import {
  normalizeStatus,
  isActiveStatus,
  type AssetStatus,
} from "@clash/web-ui/lib/assetStatus";
import { NodeModalDialog } from "./NodeModalDialog";
import { IconButton } from "../ui/icon-button";
import { Input } from "../ui/input";
import { Slider, SliderRange, SliderThumb, SliderTrack } from "../ui/slider";
import { Tooltip } from "../ui/tooltip";
import { useOptionalLoroSyncContext } from "../LoroSyncContext";
import { PendingAssetConnectionHint } from "./PendingAssetConnectionHint";

const MEDIA_NODE_CONTROL_CLASS =
  "nodrag nopan bg-black/50 text-white backdrop-blur-sm hover:bg-black/70 focus-visible:ring-white/80 focus-visible:ring-offset-black/20";

const WAVEFORM_BARS = 128;
const SKIP_SECONDS = 10;
const WAVEFORM_CACHE_MAX_ENTRIES = 48;
const WAVEFORM_CACHE_TTL_MS = 30 * 60 * 1_000;

// Disposable browser cache for one immutable Project Asset. A projected media
// URL is only a locator: it can rotate, and the same URL path is not an
// authority boundary between Projects.
type WaveformCacheEntry = {
  peaks: number[];
  duration: number;
  expiresAt: number;
};

const waveformCache = new Map<string, WaveformCacheEntry>();

const mediaLog = createLogger("audio");

function readWaveformCache(key: string): WaveformCacheEntry | undefined {
  const cached = waveformCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    waveformCache.delete(key);
    return undefined;
  }
  waveformCache.delete(key);
  waveformCache.set(key, cached);
  return cached;
}

function writeWaveformCache(
  key: string,
  value: Pick<WaveformCacheEntry, "peaks" | "duration">,
): void {
  const now = Date.now();
  for (const [candidate, cached] of waveformCache) {
    if (cached.expiresAt <= now) waveformCache.delete(candidate);
  }
  waveformCache.delete(key);
  waveformCache.set(key, {
    peaks: [...value.peaks],
    duration: value.duration,
    expiresAt: now + WAVEFORM_CACHE_TTL_MS,
  });
  while (waveformCache.size > WAVEFORM_CACHE_MAX_ENTRIES) {
    const oldest = waveformCache.keys().next().value as string | undefined;
    if (!oldest) break;
    waveformCache.delete(oldest);
  }
}

function scopedWaveformCacheKey(
  projectId: string | undefined,
  projectAssetId: string | undefined,
): string | undefined {
  return projectId && projectAssetId
    ? JSON.stringify([projectId, projectAssetId])
    : undefined;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/** Downsample decoded mono/stereo PCM to N normalized peaks in [0, 1]. */
function computePeaks(audioBuffer: AudioBuffer, bars: number): number[] {
  const channelData: Float32Array[] = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c += 1) {
    channelData.push(audioBuffer.getChannelData(c));
  }
  const totalSamples = audioBuffer.length;
  const samplesPerBar = Math.max(1, Math.floor(totalSamples / bars));
  const peaks: number[] = new Array(bars).fill(0);
  let max = 0;

  for (let i = 0; i < bars; i += 1) {
    const start = i * samplesPerBar;
    const end = Math.min(start + samplesPerBar, totalSamples);
    let peak = 0;
    for (let j = start; j < end; j += 1) {
      let sample = 0;
      for (const ch of channelData)
        sample = Math.max(sample, Math.abs(ch[j] ?? 0));
      if (sample > peak) peak = sample;
    }
    peaks[i] = peak;
    if (peak > max) max = peak;
  }
  if (max > 0) {
    for (let i = 0; i < bars; i += 1) peaks[i] = peaks[i] / max;
  }
  return peaks;
}

function parseWaveformProjection(value: unknown): {
  peaks: number[];
  duration: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid waveform representation");
  }
  const projection = value as Record<string, unknown>;
  if (
    typeof projection.recipe !== "string" ||
    !projection.recipe.startsWith("audio-waveform/") ||
    !Array.isArray(projection.peaks) ||
    projection.peaks.length !== WAVEFORM_BARS ||
    !projection.peaks.every(
      (peak) =>
        typeof peak === "number" &&
        Number.isFinite(peak) &&
        peak >= 0 &&
        peak <= 1,
    ) ||
    (projection.durationMs !== undefined &&
      (!Number.isSafeInteger(projection.durationMs) ||
        (projection.durationMs as number) < 0))
  ) {
    throw new Error("Invalid waveform representation");
  }
  return {
    peaks: projection.peaks as number[],
    duration:
      typeof projection.durationMs === "number"
        ? projection.durationMs / 1_000
        : 0,
  };
}

const AudioNode = ({
  data,
  selected,
  id,
}: NodeProps<Node<Record<string, any>>>) => {
  const [label, setLabel] = useState(data.label || "Audio Node");
  const { projectId } = useProject();
  const { openAssetPreview } = useMediaViewer();
  const loroSync = useOptionalLoroSyncContext();
  const projectAssetId =
    typeof data.assetId === "string" && data.assetId.length > 0
      ? data.assetId
      : undefined;
  const asset = useAsset(projectId, projectAssetId);
  const projectedAudioUrl = asset?.url;
  const projectedWaveformUrl = asset?.waveformUrl;
  const waveformCacheKey = scopedWaveformCacheKey(projectId, projectAssetId);
  const [status, setStatus] = useState<AssetStatus>(
    normalizeStatus(data.status) || (data.assetId ? "completed" : "generating"),
  );
  const [audioUrl, setAudioUrl] = useState<string | undefined>(
    projectedAudioUrl,
  );
  const pendingAwaitingConnection =
    data.status === "pending" && loroSync?.connected === false;

  // Duration may come from byte inspection. Inline waveform is migration-only;
  // new Assets resolve a Host-derived waveform and cache that bounded payload.
  const metaDurationMs = asset?.metadata?.durationMs;
  const legacyWaveform = asset?.metadata?.waveform;

  const [showModal, setShowModal] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(() =>
    typeof metaDurationMs === "number" && metaDurationMs > 0
      ? metaDurationMs / 1000
      : 0,
  );
  const [peaks, setPeaks] = useState<number[] | undefined>(() =>
    Array.isArray(legacyWaveform) && legacyWaveform.length > 0
      ? legacyWaveform
      : undefined,
  );
  const [decoding, setDecoding] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);

  // Sync status + audioUrl from Loro changes.
  useEffect(() => {
    setStatus((prev) => {
      const next = normalizeStatus(data.status);
      return next !== prev ? next : prev;
    });
    setAudioUrl((prev) =>
      projectedAudioUrl !== prev ? projectedAudioUrl : prev,
    );
  }, [data.status, projectedAudioUrl]);

  // Reset / re-seed state when the source or its server-side metadata changes.
  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(
      typeof metaDurationMs === "number" && metaDurationMs > 0
        ? metaDurationMs / 1000
        : 0,
    );
    setPeaks(
      Array.isArray(legacyWaveform) && legacyWaveform.length > 0
        ? legacyWaveform
        : undefined,
    );
  }, [
    projectedAudioUrl,
    projectedWaveformUrl,
    metaDurationMs,
    legacyWaveform,
  ]);

  // Prefer the Host's durable representation. Browser decoding remains a
  // compatibility fallback for Hosts that have not derived it yet.
  useEffect(() => {
    if (!audioUrl || (!showModal && !projectedWaveformUrl)) return;
    const hasDuration = duration > 0;
    const hasPeaks = !!peaks && peaks.length > 0;
    if (hasDuration && hasPeaks) return;
    const cached = waveformCacheKey
      ? readWaveformCache(waveformCacheKey)
      : undefined;
    if (cached) {
      if (!hasPeaks) setPeaks(cached.peaks);
      if (!hasDuration) setDuration(cached.duration);
      return;
    }
    let aborted = false;
    const controller = new AbortController();
    setDecoding(true);
    (async () => {
      try {
        if (projectedWaveformUrl) {
          try {
            const representationResponse = await fetch(projectedWaveformUrl, {
              signal: controller.signal,
            });
            if (!representationResponse.ok) {
              throw new Error(`fetch ${representationResponse.status}`);
            }
            const representation = parseWaveformProjection(
              await representationResponse.json(),
            );
            if (aborted) return;
            const representationDuration =
              representation.duration > 0
                ? representation.duration
                : duration;
            if (waveformCacheKey) {
              writeWaveformCache(waveformCacheKey, {
                peaks: representation.peaks,
                duration: representationDuration,
              });
            }
            setPeaks(representation.peaks);
            if (representation.duration > 0) {
              setDuration((previous) =>
                previous > 0 ? previous : representation.duration,
              );
            }
            return;
          } catch (error) {
            if (aborted || controller.signal.aborted) return;
            mediaLog.warn("audio.waveform_failed", { nodeId: id, error });
          }
        }
        if (!showModal) return;
        const resp = await fetch(audioUrl, { signal: controller.signal });
        if (!resp.ok) throw new Error(`fetch ${resp.status}`);
        const buf = await resp.arrayBuffer();
        const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
        if (!Ctor) throw new Error("Web Audio API unavailable");
        const ctx: AudioContext = new Ctor();
        try {
          const decoded = await ctx.decodeAudioData(buf.slice(0));
          if (aborted) return;
          const computed = computePeaks(decoded, WAVEFORM_BARS);
          if (waveformCacheKey) {
            writeWaveformCache(waveformCacheKey, {
              peaks: computed,
              duration: decoded.duration,
            });
          }
          setPeaks((prev) => (prev && prev.length > 0 ? prev : computed));
          setDuration((prev) => (prev > 0 ? prev : decoded.duration));
        } finally {
          ctx.close().catch(() => {});
        }
      } catch (e) {
        if (!aborted) mediaLog.warn("audio.decode_failed", { nodeId: id, error: e });
      } finally {
        if (!aborted) setDecoding(false);
      }
    })();
    return () => {
      aborted = true;
      controller.abort();
    };
  }, [showModal, audioUrl, projectedWaveformUrl, waveformCacheKey]);

  // Bind <audio> element events — drives currentTime + provides a duration
  // fallback in case decode hasn't finished yet.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrentTime(audio.currentTime);
    const onMeta = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration((prev) => (prev > 0 ? prev : audio.duration));
      }
    };
    const onEnd = () => {
      setIsPlaying(false);
      setCurrentTime(0);
      audio.currentTime = 0;
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("durationchange", onMeta);
    audio.addEventListener("ended", onEnd);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
      audio.removeEventListener("ended", onEnd);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
    };
  }, [audioUrl]);

  // Pause playback when modal closes.
  useEffect(() => {
    if (!showModal && audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
    }
  }, [showModal]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }, []);

  const seekTo = useCallback(
    (seconds: number) => {
      const audio = audioRef.current;
      if (!audio || !Number.isFinite(seconds)) return;
      const d = duration || audio.duration || 0;
      const clamped = Math.max(0, Math.min(seconds, d || seconds));
      audio.currentTime = clamped;
      setCurrentTime(clamped);
    },
    [duration],
  );

  const handleSkipBack = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    seekTo(audio.currentTime - SKIP_SECONDS);
  }, [seekTo]);

  const handleSkipForward = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    seekTo(audio.currentTime + SKIP_SECONDS);
  }, [seekTo]);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  const waveformBars = useMemo(() => {
    if (peaks && peaks.length > 0) return peaks.map((p) => Math.max(0.04, p));
    // Card placeholder: gentle sine so it looks like a waveform but doesn't imply real peaks.
    return Array.from(
      { length: 64 },
      (_, i) => 0.25 + 0.5 * Math.abs(Math.sin((i / 63) * Math.PI * 3)),
    );
  }, [peaks]);

  const modalContent = (
    <NodeModalDialog
      open={showModal}
      onClose={() => setShowModal(false)}
      ariaLabel="Audio Player"
      overlayClassName="bg-black/50"
      contentClassName="max-w-md h-auto rounded-2xl shadow-2xl p-6 gap-6 animate-in fade-in zoom-in-95 duration-200"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-bold text-content-primary">Audio Player</h3>
        <IconButton
          label="Close audio player"
          onClick={() => setShowModal(false)}
          icon={<X size={20} />}
          size="sm"
          shape="circle"
          className="text-content-secondary hover:bg-warm-hover hover:text-content-primary"
        />
      </div>

      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-center py-8 bg-warm-muted rounded-xl">
          <div className="flex h-32 w-32 items-center justify-center rounded-full border border-warm-border bg-warm-page text-content-secondary shadow-inner">
            <SpeakerHigh size={48} weight="fill" />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex justify-between text-xs font-medium tabular-nums text-content-secondary">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
          <Slider
            aria-label="Audio seek"
            value={[
              duration > 0 ? Math.max(0, Math.min(currentTime, duration)) : 0,
            ]}
            min={0}
            max={Math.max(0.001, duration)}
            step={0.01}
            disabled={!duration}
            onValueChange={(value) => seekTo(value[0] ?? 0)}
            className="relative h-12 w-full cursor-pointer group/waveform disabled:cursor-not-allowed disabled:opacity-70"
          >
            {decoding && !peaks && (
              <div className="absolute inset-0 flex items-center justify-center text-content-secondary">
                <Spinner size={20} className="animate-spin" />
              </div>
            )}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-[2px]">
              {waveformBars.map((p, index) => {
                const barPercent = ((index + 0.5) / waveformBars.length) * 100;
                const isPlayed = barPercent <= progress;
                return (
                  <div
                    key={index}
                    className={`w-1.5 rounded-full transition-all duration-150 ${isPlayed ? "bg-brand" : "bg-content-disabled group-hover/waveform:bg-content-muted"}`}
                    style={{ height: `${Math.max(6, p * 100)}%` }}
                  />
                );
              })}
            </div>
            <SliderTrack className="absolute inset-0 h-full w-full bg-transparent">
              <SliderRange className="top-0 bottom-0 bg-transparent" />
            </SliderTrack>
            <SliderThumb
              aria-label="Audio playhead"
              className="h-5 w-1.5 rounded-full bg-brand opacity-0 transition-opacity focus-visible:opacity-100 group-hover/waveform:opacity-100 data-[disabled]:hidden"
            />
          </Slider>
        </div>

        <div className="flex items-center justify-center gap-6">
          <IconButton
            onClick={handleSkipBack}
            disabled={!duration}
            label={`Skip back ${SKIP_SECONDS}s`}
            icon={<SkipBack size={24} weight="fill" />}
            size="md"
            shape="circle"
            className="text-content-secondary hover:bg-transparent hover:text-content-primary disabled:opacity-30"
          />
          <IconButton
            onClick={togglePlay}
            disabled={!audioUrl}
            label={isPlaying ? "Pause" : "Play"}
            icon={
              isPlaying ? (
                <Pause size={28} weight="fill" />
              ) : (
                <Play size={28} weight="fill" className="ml-1" />
              )
            }
            size="lg"
            shape="circle"
            className="h-16 min-h-16 w-16 min-w-16 bg-brand text-brand-foreground shadow-lg transition-transform hover:scale-105 hover:bg-brand/90 active:scale-95 disabled:opacity-50 disabled:hover:scale-100"
          />
          <IconButton
            onClick={handleSkipForward}
            disabled={!duration}
            label={`Skip forward ${SKIP_SECONDS}s`}
            icon={<SkipForward size={24} weight="fill" />}
            size="md"
            shape="circle"
            className="text-content-secondary hover:bg-transparent hover:text-content-primary disabled:opacity-30"
          />
        </div>
      </div>
    </NodeModalDialog>
  );

  return (
    <>
      <div className="group relative min-w-[200px]">
        <div
          className="absolute -top-8 left-4 z-10"
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <Input
            className="bg-transparent text-lg font-bold font-display text-slate-700 dark:text-slate-300 focus:text-slate-900 focus:outline-none"
            value={label}
            onChange={(evt) => {
              setLabel(evt.target.value);
              data.label = evt.target.value;
            }}
          />
        </div>

        <div
          className={`w-full bg-warm-surface shadow-md rounded-matrix overflow-hidden transition-all duration-300 hover:shadow-lg cursor-pointer ${selected ? "ring-4 ring-brand ring-offset-2" : "ring-1 ring-warm-border"}`}
          onDoubleClick={() =>
            audioUrl && status === "completed" && setShowModal(true)
          }
        >
          {typeof data.assetId === "string" &&
          data.assetId &&
          openAssetPreview ? (
            <div className="absolute right-2 top-2 z-10">
              <Tooltip label="Preview asset">
                <IconButton
                  label="Preview asset"
                  icon={<Eye size={14} weight="bold" />}
                  size="sm"
                  shape="circle"
                  className={MEDIA_NODE_CONTROL_CLASS}
                  onClick={(event) => {
                    event.stopPropagation();
                    openAssetPreview(data.assetId);
                  }}
                  onDoubleClick={(event) => event.stopPropagation()}
                />
              </Tooltip>
            </div>
          ) : null}
          <div
            className={`flex h-16 items-center justify-center ${status === "draft" ? "" : "px-4"}`}
          >
            {status === "draft" ? (
              <DraftPlaceholder
                nodeId={id}
                modality="audio"
                height={64}
                compact
              />
            ) : isActiveStatus(status) && !audioUrl ? (
              pendingAwaitingConnection ? (
                <PendingAssetConnectionHint compact />
              ) : (
                <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                  <Spinner size={24} className="animate-spin" />
                  <span className="text-sm font-medium">
                    Generating audio...
                  </span>
                </div>
              )
            ) : status === "failed" ? (
              <div className="flex items-center gap-2 text-red-500">
                <X size={24} weight="bold" />
                <span className="text-sm font-medium">Generation failed</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 w-full justify-center">
                <SpeakerHigh
                  size={20}
                  weight="fill"
                  className="text-slate-700 dark:text-slate-300 shrink-0"
                />
                <div className="flex items-center gap-[2px] h-8 flex-1 justify-center">
                  {waveformBars.slice(0, 48).map((p, index) => (
                    <div
                      key={index}
                      className="w-1 rounded-full bg-audio/35"
                      style={{ height: `${Math.max(12, p * 100)}%` }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          {audioUrl && (
            <audio
              ref={audioRef}
              src={audioUrl || undefined}
              preload="metadata"
            />
          )}
        </div>

        <Handle
          type="target"
          position={Position.Left}
          style={{ top: "50%", left: "-8px" }}
          className="!h-4 !w-4 !border-4 !border-warm-surface !bg-stone-400 transition-all hover:!bg-brand hover:scale-125 shadow-sm"
        />
        <SourceHandleMenu nodeId={id} sourceType="audio" />
      </div>

      {modalContent}
    </>
  );
};

export default memo(AudioNode);
