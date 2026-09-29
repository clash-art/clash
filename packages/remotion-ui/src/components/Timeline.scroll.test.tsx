// @vitest-environment jsdom
import React, { Profiler } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EditorProvider } from '@clash/remotion-core';
import { afterEach, expect, it, vi } from 'vitest';
import { Timeline } from './Timeline';

const { itemCommits } = vi.hoisted(() => ({ itemCommits: vi.fn() }));

// Keep the actual item and DnD tree; only insert a React measurement boundary.
vi.mock('./timeline/TimelineItem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./timeline/TimelineItem')>();
  return {
    ...actual,
    TimelineItem: (props: React.ComponentProps<typeof actual.TimelineItem>) => (
      <Profiler id="item" onRender={itemCommits}><actual.TimelineItem {...props} /></Profiler>
    ),
  };
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('scrolls the full Timeline ruler without committing unchanged clip contents', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  window.currentDraggedItem = null;
  const { container } = render(
    <EditorProvider initialState={{
      fps: 30, durationInFrames: 3600, zoom: 1,
      tracks: [{ id: 'visual', name: 'Media', items: [{
        id: 'clip', type: 'solid', color: '#123456', from: 0, durationInFrames: 900,
      }] }],
    }}><Timeline /></EditorProvider>,
  );
  const viewport = container.querySelector('.tracks-viewport') as HTMLDivElement;
  Object.defineProperties(viewport, {
    clientWidth: { value: 800 }, clientHeight: { value: 200 },
    scrollWidth: { value: 7200 }, scrollHeight: { value: 800 },
  });
  fireEvent.scroll(viewport);
  const rulerContent = container.querySelector('[data-timeline-ruler] > svg') as SVGElement;
  const initialRulerLeft = parseFloat(rulerContent.style.left);
  const playhead = screen.getByRole('slider', { name: 'Playhead' });
  const initialPlayheadLeft = parseFloat(playhead.style.left);
  itemCommits.mockClear();
  viewport.scrollTop = 20;
  fireEvent.scroll(viewport);
  expect(itemCommits).not.toHaveBeenCalled();
  viewport.scrollLeft = 120;
  fireEvent.scroll(viewport);
  expect(viewport.scrollLeft).toBe(120);
  expect(parseFloat(rulerContent.style.left)).toBe(initialRulerLeft - 120);
  expect(parseFloat(playhead.style.left)).toBe(initialPlayheadLeft - 120);
  viewport.scrollLeft = 40;
  fireEvent.scroll(viewport);
  expect(parseFloat(rulerContent.style.left)).toBe(initialRulerLeft - 40);
  expect(parseFloat(playhead.style.left)).toBe(initialPlayheadLeft - 40);
  expect(itemCommits).not.toHaveBeenCalled();

  // Presentation isolation must not freeze real edits/zoom updates.
  const item = container.querySelector('.timeline-item') as HTMLElement;
  const initialWidth = parseFloat(item.style.width);
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
  expect(parseFloat(item.style.width)).toBeGreaterThan(initialWidth);
  expect(itemCommits).toHaveBeenCalled();
});
