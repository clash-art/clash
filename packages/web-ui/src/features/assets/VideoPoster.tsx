import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ResolvedAsset } from "@clash/shared-types";
import { resolveAssetMediaUrl } from "./media-url";

const BROWSER_POSTER_MAX_EDGE = 640;

interface BrowserPoster {
  source: string;
  url: string;
}

export interface VideoPosterProps {
  /** Optional legacy/remote still projection; new Local video derives in-browser. */
  thumbnailSrc?: string | null;
  /** Current-Host playback projection; consumed only while status is ready. */
  videoSrc?: string | null;
  status?: ResolvedAsset["status"];
  alt: string;
  className?: string;
  decorative?: boolean;
  fallback?: ReactNode;
}

function revokeBrowserPoster(url: string): void {
  if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
}

/**
 * Frontend video-still presentation with a compatibility preview input.
 *
 * The browser frame is disposable presentation state. It is never cached by
 * playback URL or persisted into Project state. A supplied legacy/remote still
 * may be displayed, but current Local Assets never require a backend poster.
 */
export function VideoPoster({
  thumbnailSrc,
  videoSrc,
  status,
  alt,
  className = "",
  decorative = false,
  fallback = null,
}: VideoPosterProps) {
  const hostPoster = resolveAssetMediaUrl(thumbnailSrc);
  const playback = resolveAssetMediaUrl(videoSrc);
  const [failedHostPoster, setFailedHostPoster] = useState<string | null>(null);
  const [browserPoster, setBrowserPoster] = useState<BrowserPoster | null>(
    null,
  );
  const [failedCapture, setFailedCapture] = useState<string | null>(null);
  const captureStarted = useRef<string | null>(null);
  const mounted = useRef(false);
  const latest = useRef({
    canCapture: false,
    hostPoster: null as string | null,
    playback: null as string | null,
  });

  const usableHostPoster =
    hostPoster && hostPoster !== failedHostPoster ? hostPoster : null;
  const usableBrowserPoster =
    status === "ready" && browserPoster?.source === playback
      ? browserPoster.url
      : null;
  const canCapture = Boolean(
    status === "ready" &&
    playback &&
    !usableHostPoster &&
    !usableBrowserPoster &&
    failedCapture !== playback,
  );
  latest.current = { canCapture, hostPoster: usableHostPoster, playback };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      latest.current.canCapture = false;
    };
  }, []);

  useEffect(() => {
    captureStarted.current = null;
    setFailedCapture(null);
    setBrowserPoster((current) =>
      current?.source === playback ? current : null,
    );
  }, [playback]);

  useEffect(() => {
    if (status === "ready") return;
    captureStarted.current = null;
    setBrowserPoster(null);
  }, [status]);

  useEffect(() => {
    return () => {
      if (browserPoster) revokeBrowserPoster(browserPoster.url);
    };
  }, [browserPoster]);

  const capture = (video: HTMLVideoElement) => {
    const source = playback;
    if (!source || captureStarted.current === source) return;
    captureStarted.current = source;

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      setFailedCapture(source);
      return;
    }

    try {
      const scale = Math.min(
        1,
        BROWSER_POSTER_MAX_EDGE / Math.max(width, height),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      if (!context || typeof canvas.toBlob !== "function") {
        setFailedCapture(source);
        return;
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => {
          const current = latest.current;
          if (!mounted.current) return;
          if (!blob || typeof URL.createObjectURL !== "function") {
            if (current.playback === source) setFailedCapture(source);
            return;
          }
          const objectUrl = URL.createObjectURL(blob);
          if (
            !current.canCapture ||
            current.playback !== source ||
            current.hostPoster
          ) {
            revokeBrowserPoster(objectUrl);
            return;
          }
          setBrowserPoster({ source, url: objectUrl });
        },
        "image/jpeg",
        0.72,
      );
    } catch {
      setFailedCapture(source);
    }
  };

  const visiblePoster = usableHostPoster ?? usableBrowserPoster;

  return (
    <>
      {visiblePoster ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={visiblePoster}
          alt={decorative ? "" : alt}
          className={className}
          draggable={false}
          onLoad={() => {
            if (visiblePoster === usableHostPoster) setBrowserPoster(null);
          }}
          onError={() => {
            if (visiblePoster === usableHostPoster && usableHostPoster) {
              setFailedHostPoster(usableHostPoster);
              return;
            }
            if (browserPoster) {
              setFailedCapture(browserPoster.source);
              setBrowserPoster(null);
            }
          }}
        />
      ) : (
        fallback
      )}
      {canCapture ? (
        <video
          key={playback}
          src={playback ?? undefined}
          className="pointer-events-none absolute h-px w-px opacity-0"
          aria-hidden="true"
          tabIndex={-1}
          muted
          playsInline
          preload="metadata"
          crossOrigin="anonymous"
          onLoadedData={(event) => {
            // Chromium may report loadeddata before drawImage can access the
            // decoded frame. An explicit seek to the start completes decoding
            // without changing which frame is used as the cover.
            event.currentTarget.currentTime = 0;
          }}
          onSeeked={(event) => capture(event.currentTarget)}
          onError={() => {
            if (playback) setFailedCapture(playback);
          }}
        />
      ) : null}
    </>
  );
}
