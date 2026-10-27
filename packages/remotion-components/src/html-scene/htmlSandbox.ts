/**
 * HTML MG preview sandbox helpers (#447).
 *
 * Hilo interactive-hosting pattern: sandboxed iframe with `allow-scripts` and
 * **without** `allow-same-origin` so the document gets an opaque origin.
 * Prefer blob: URLs over srcDoc for production paint. Capacity bounds come
 * from `@clash/shared-types` HTML_MOTION_* constants — fail closed.
 *
 * Channel messages are correlation only (not credentials). The producer owns
 * its local clock; this module never introduces an audio-master-clock.
 */
import {
  HTML_MOTION_DOCUMENT_MAX_BYTES,
} from "@clash/shared-types";

/** Sandbox tokens for HTML MG documents. No same-origin. */
export const HTML_SCENE_SANDBOX = "allow-scripts" as const;

/**
 * Wire protocol the host posts into an HTML MG document after load.
 * Distinct from clash.preview-host.v1 (parent ↔ preview-frame).
 */
export const HTML_SCENE_DOCUMENT_PROTOCOL = "clash.html-scene-doc.v1" as const;

/** Default CSP for wrapped HTML MG documents (opaque-origin iframe). */
export const HTML_SCENE_DEFAULT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'unsafe-inline'",
  "img-src data: blob: https:",
  "font-src data:",
  "media-src data: blob: https:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export type HtmlDocumentCapacityResult =
  | { ok: true; byteLength: number }
  | { ok: false; reason: string; byteLength: number };

export function measureHtmlDocumentBytes(source: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(source).byteLength;
  }
  // Fallback for exotic environments without TextEncoder.
  return unescape(encodeURIComponent(source)).length;
}

export function validateHtmlDocumentCapacity(
  source: string,
  maxBytes: number = HTML_MOTION_DOCUMENT_MAX_BYTES,
): HtmlDocumentCapacityResult {
  const byteLength = measureHtmlDocumentBytes(source);
  if (byteLength > maxBytes) {
    return {
      ok: false,
      reason: `HTML MG document exceeds capacity (${byteLength} > ${maxBytes} bytes)`,
      byteLength,
    };
  }
  return { ok: true, byteLength };
}

export type HtmlSceneDocCommand =
  | {
      protocol: typeof HTML_SCENE_DOCUMENT_PROTOCOL;
      type: "seek";
      frame: number;
      fps: number;
      durationInFrames: number;
    }
  | {
      protocol: typeof HTML_SCENE_DOCUMENT_PROTOCOL;
      type: "play";
      frame: number;
      fps: number;
    }
  | {
      protocol: typeof HTML_SCENE_DOCUMENT_PROTOCOL;
      type: "pause";
      frame: number;
    };

/**
 * Bootstrap injected into HTML MG documents so seek/play can drive local
 * animations without the host reading the opaque-origin document.
 */
export function htmlSceneBootstrapScript(): string {
  return `(function(){
  var PROTOCOL=${JSON.stringify(HTML_SCENE_DOCUMENT_PROTOCOL)};
  function applySeek(frame, fps, duration){
    var root=document.documentElement;
    root.dataset.clashFrame=String(frame);
    root.dataset.clashFps=String(fps);
    if(typeof duration==="number") root.dataset.clashDuration=String(duration);
    var t=fps>0?frame/fps:0;
    try{
      var anims=document.getAnimations?document.getAnimations():[];
      for(var i=0;i<anims.length;i++){
        try{ anims[i].currentTime=t*1000; }catch(e){}
      }
    }catch(e){}
    try{
      root.dispatchEvent(new CustomEvent("clash-html-scene-frame",{detail:{frame:frame,fps:fps,durationInFrames:duration}}));
    }catch(e){}
  }
  window.addEventListener("message",function(ev){
    var data=ev&&ev.data;
    if(!data||data.protocol!==PROTOCOL) return;
    if(data.type==="seek") applySeek(data.frame,data.fps,data.durationInFrames);
    else if(data.type==="play") applySeek(data.frame,data.fps);
    else if(data.type==="pause") applySeek(data.frame, data.fps||30);
  });
})();`;
}

export function wrapHtmlDocumentForPreview(
  source: string,
  options?: { csp?: string },
): string {
  const csp = options?.csp ?? HTML_SCENE_DEFAULT_CSP;
  const bootstrap =
    "<script>" + htmlSceneBootstrapScript() + "</scr" + "ipt>";
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, "&quot;")}" />`;
  const trimmed = source.trim();
  if (/<head[\s>]/i.test(trimmed)) {
    return trimmed.replace(
      /<head([^>]*)>/i,
      `<head$1>${cspMeta}${bootstrap}`,
    );
  }
  if (/<html[\s>]/i.test(trimmed)) {
    return trimmed.replace(
      /<html([^>]*)>/i,
      `<html$1><head>${cspMeta}${bootstrap}</head>`,
    );
  }
  return `<!doctype html><html><head>${cspMeta}${bootstrap}</head><body>${trimmed}</body></html>`;
}

export type HtmlSceneBlobHandle = {
  url: string;
  revoke: () => void;
};

/**
 * Creates a blob: URL for an already-wrapped HTML document.
 * Caller must revoke when the surface unmounts.
 */
export function createHtmlSceneBlobUrl(wrappedHtml: string): HtmlSceneBlobHandle {
  const blob = new Blob([wrappedHtml], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  return {
    url,
    revoke: () => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    },
  };
}

export function isHtmlSceneDocCommand(
  value: unknown,
): value is HtmlSceneDocCommand {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.protocol !== HTML_SCENE_DOCUMENT_PROTOCOL) return false;
  if (record.type === "seek") {
    return (
      typeof record.frame === "number" &&
      typeof record.fps === "number" &&
      typeof record.durationInFrames === "number"
    );
  }
  if (record.type === "play") {
    return typeof record.frame === "number" && typeof record.fps === "number";
  }
  if (record.type === "pause") {
    return typeof record.frame === "number";
  }
  return false;
}
