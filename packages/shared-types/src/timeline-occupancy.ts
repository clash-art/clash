import type { TimelineDslValidationIssue } from './timeline-dsl-schema.js';
import { timelineDslFromYaml } from './timeline-yaml.js';

export type TimelineLaneItem = { id: string; from: number; durationInFrames: number };
export const timelineItemsOverlap = (a: TimelineLaneItem, b: TimelineLaneItem): boolean =>
  a.from < b.from + b.durationInFrames && b.from < a.from + a.durationInFrames;

/** Write-boundary check. Legacy revisions remain readable and renderable. */
export function timelineOccupancyIssues(state: unknown): TimelineDslValidationIssue[] {
  const tracks = (state as { tracks?: Array<{ id: string; items: Array<TimelineLaneItem> }> } | null)?.tracks;
  if (!Array.isArray(tracks)) return [];
  if (tracks.some(track => track.items.some(item => typeof item.from === 'string'))) {
    const resolved = timelineDslFromYaml(JSON.stringify(state));
    if (!resolved.ok) return [{ ruleId: 'timeline.track.overlap', code: 'custom', path: ['tracks'], message: resolved.error }];
    return timelineOccupancyIssues(resolved.dsl);
  }
  const issues: TimelineDslValidationIssue[] = [];
  tracks.forEach((track, trackIndex) => {
    const ordered = track.items.map((item, index) => ({ item, index })).sort((a, b) => a.item.from - b.item.from);
    let covering: typeof ordered[number] | undefined;
    for (const entry of ordered) {
      if (covering && timelineItemsOverlap(covering.item, entry.item)) {
        issues.push({
          ruleId: 'timeline.track.overlap', code: 'custom',
          path: ['tracks', trackIndex, 'items', entry.index, 'from'],
          message: `Track "${track.id}": "${entry.item.id}" overlaps "${covering.item.id}". Put simultaneous layers on separate tracks, or adjust the clip range.`,
        });
      }
      if (!covering || entry.item.from + entry.item.durationInFrames > covering.item.from + covering.item.durationInFrames) covering = entry;
    }
  });
  return issues;
}
