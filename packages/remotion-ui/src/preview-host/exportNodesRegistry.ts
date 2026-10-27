/**
 * Latest Canvas/runtime node map for browser Timeline export hydration (#448).
 * CanvasPreview publishes; the apps/web timeline-render adapter reads.
 * No audio-master-clock; plain record so postMessage can clone it.
 */

let snapshot: Record<string, unknown> | undefined;

export function publishTimelineExportNodes(
  nodes: Map<string, unknown> | Record<string, unknown> | undefined,
): void {
  if (!nodes) {
    snapshot = undefined;
    return;
  }
  if (nodes instanceof Map) {
    snapshot = Object.fromEntries(nodes.entries());
    return;
  }
  snapshot = { ...nodes };
}

export function readTimelineExportNodes(): Record<string, unknown> | undefined {
  return snapshot;
}

export function clearTimelineExportNodes(): void {
  snapshot = undefined;
}
