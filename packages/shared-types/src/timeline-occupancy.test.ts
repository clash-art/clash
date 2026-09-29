import { describe, expect, it } from 'vitest';
import { timelineOccupancyIssues } from './timeline-occupancy.js';

const clip = (id: string, from: number | string, durationInFrames = 30) => ({ id, type: 'text', text: id, from, durationInFrames });
describe('single-lane occupancy', () => {
  it('reports covering and nested clips with their source paths, regardless of input order', () => {
    const issues = timelineOccupancyIssues({ tracks: [{ id: 'titles', items: [clip('late', 40), clip('long', 0, 100), clip('inner', 10)] }] });
    expect(issues.map(issue => issue.path)).toEqual([['tracks', 0, 'items', 2, 'from'], ['tracks', 0, 'items', 0, 'from']]);
    expect(issues[0]?.message).toContain('long');
    expect(issues[0]?.message).toContain('inner');
  });
  it('allows touching boundaries and simultaneous clips on separate lanes', () => {
    expect(timelineOccupancyIssues({ tracks: [{ id: 'a', items: [clip('first', 0), clip('second', 30)] }, { id: 'b', items: [clip('above', 0)] }] })).toEqual([]);
  });
  it('resolves authoring expressions before checking occupancy', () => {
    expect(timelineOccupancyIssues({ tracks: [{ id: 'a', items: [clip('first', 0), clip('second', 'prev-5')] }] })[0]?.path).toEqual(['tracks', 0, 'items', 1, 'from']);
    expect(timelineOccupancyIssues({ tracks: [{ id: 'a', items: [clip('first', 0), clip('second', 'prev')] }] })).toEqual([]);
  });
});
