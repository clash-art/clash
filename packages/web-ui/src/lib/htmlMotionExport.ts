/**
 * HTML MG export contracts (#448).
 *
 * Preview and export share the same live-reference rule: Timeline stores
 * `sourceNodeId`; sources resolve from Canvas `html-motion` nodes when a
 * preview or export starts. No audio-master-clock dependency.
 */

import { resolveHtmlMotionNodeContent } from "./htmlMotionElementEdit";

export const HTML_MOTION_EXPORT_PARITY = {
  protocolPreview: "clash.preview-host.v1",
  protocolExport: "clash.timeline-render.v1",
  identity: "sourceNodeId",
  canvasNodeType: "html-motion",
  timelineRuntime: "html",
  compositionKind: "motion-graphics",
  /**
   * Browser export paints the same VideoComposition + HtmlSceneSurface tree
   * preview uses. Native HTML-in-canvas (`allowHtmlInCanvas`) is optional and
   * off by default; when unsupported, the adapter may fall back to Host.
   */
  browserPaint: "VideoComposition/HtmlSceneSurface",
  hostFallback: "request_timeline_render",
} as const;

export type HtmlMotionExportNode = {
  type?: string;
  data?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function nodesRecordFromUnknown(
  allNodes: unknown,
): Record<string, HtmlMotionExportNode> {
  if (!allNodes) return {};
  if (allNodes instanceof Map) {
    return Object.fromEntries(
      [...allNodes.entries()].map(([id, node]) => [String(id), node as HtmlMotionExportNode]),
    );
  }
  if (isRecord(allNodes)) {
    const out: Record<string, HtmlMotionExportNode> = {};
    for (const [id, node] of Object.entries(allNodes)) {
      out[id] = node as HtmlMotionExportNode;
    }
    return out;
  }
  return {};
}

function resolveHtmlSource(
  sourceNodeId: string,
  nodes: Record<string, HtmlMotionExportNode>,
): string | undefined {
  const node = nodes[sourceNodeId];
  if (!node || node.type !== "html-motion") return undefined;
  const data =
    node.data && typeof node.data === "object"
      ? (node.data as Record<string, unknown>)
      : {};
  const resolved = resolveHtmlMotionNodeContent(data, "");
  return resolved.trim() ? resolved : undefined;
}

/**
 * Stamp render-start-only `htmlSource` onto live HTML MG items so the
 * cross-origin export frame can paint without a live Loro subscription.
 * Does not mutate stored Timeline state — operates on a tracks clone.
 */
export function hydrateHtmlMotionSourcesForExport(
  tracks: unknown[],
  allNodes: unknown,
): unknown[] {
  const nodes = nodesRecordFromUnknown(allNodes);
  return tracks.map((track) => {
    if (!isRecord(track) || !Array.isArray(track.items)) return track;
    return {
      ...track,
      items: track.items.map((item) => {
        if (!isRecord(item)) return item;
        if (item.type !== "composition" || item.runtime !== "html") return item;
        if (typeof item.htmlSource === "string" && item.htmlSource.trim()) {
          return item;
        }
        const sourceNodeId =
          typeof item.sourceNodeId === "string" ? item.sourceNodeId.trim() : "";
        if (!sourceNodeId) return item;
        const htmlSource = resolveHtmlSource(sourceNodeId, nodes);
        if (!htmlSource) return item;
        return { ...item, htmlSource };
      }),
    };
  });
}

export type HtmlMotionExportReadiness =
  | { ok: true; hydratedItemCount: number }
  | { ok: false; reason: string; missingSourceNodeIds: string[] };

/** Validate that every live HTML MG item can resolve a Canvas source. */
export function validateHtmlMotionExportReadiness(
  tracks: unknown[],
  allNodes: unknown,
): HtmlMotionExportReadiness {
  const nodes = nodesRecordFromUnknown(allNodes);
  const missing: string[] = [];
  let hydrated = 0;
  for (const track of tracks) {
    if (!isRecord(track) || !Array.isArray(track.items)) continue;
    for (const item of track.items) {
      if (!isRecord(item)) continue;
      if (item.type !== "composition" || item.runtime !== "html") continue;
      if (typeof item.htmlSource === "string" && item.htmlSource.trim()) {
        hydrated += 1;
        continue;
      }
      const sourceNodeId =
        typeof item.sourceNodeId === "string" ? item.sourceNodeId.trim() : "";
      if (!sourceNodeId || !resolveHtmlSource(sourceNodeId, nodes)) {
        missing.push(sourceNodeId || "(unset)");
        continue;
      }
      hydrated += 1;
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Missing HTML Motion sources for Canvas nodes: ${missing.join(", ")}`,
      missingSourceNodeIds: missing,
    };
  }
  return { ok: true, hydratedItemCount: hydrated };
}

/**
 * Legacy migrate-vs-coexist decision for #448 (reinforces spike B):
 * coexist — do not rewrite stored `runtime: react` custom comps or legacy
 * html+renderedAssetPath shapes in this slice. New MG authoring uses live
 * `sourceNodeId` + runtime html|remotion.
 */
export const HTML_MOTION_LEGACY_POLICY = {
  decision: "coexist",
  migrateStoredState: false,
  bannedTokens: [
    "MgCompositionSpec",
    "render-mg",
    "export-mg",
    "verify-mg-preview",
    "rasterizer",
    "spec.json",
  ] as const,
  allowedDualRuntimeSkillTokens: ["runtime: html", 'runtime: "html"', "html_motion"] as const,
} as const;
