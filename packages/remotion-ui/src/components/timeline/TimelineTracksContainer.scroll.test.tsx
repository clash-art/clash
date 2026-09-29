// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { EditorProvider } from '@clash/remotion-core';
import { Profiler } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelineTracksContainer } from './TimelineTracksContainer';

afterEach(cleanup);

function viewport() {
  window.currentDraggedItem = null;
  const noop = () => {};
  const onScrollXChange = vi.fn();
  const onRender = vi.fn();
  const { container } = render(
    <EditorProvider initialState={{ tracks: [{ id: 'story', name: 'Media', items: [] }] }}>
      <Profiler id="tracks" onRender={onRender}>
      <TimelineTracksContainer
        durationInFrames={3600} pixelsPerFrame={1} fps={30}
        selectedTrackId={null} selectedItemId={null} assets={[]} dragPreview={null}
        onSelectTrack={noop} onSelectItem={noop} onDeleteItem={noop} onUpdateItem={noop}
        onDragOver={noop} onDrop={noop} onEmptyDrop={noop} onItemDragStart={noop}
        onItemDragOver={noop} onItemDrop={noop} onItemDragEnd={noop}
        onScrollXChange={onScrollXChange}
      />
      </Profiler>
    </EditorProvider>,
  );
  const target = container.querySelector('.tracks-viewport') as HTMLDivElement;
  // jsdom has no layout; provide the measured viewport/content boundary only.
  Object.defineProperties(target, {
    clientWidth: { value: 800 }, clientHeight: { value: 200 },
    scrollWidth: { value: 5000 }, scrollHeight: { value: 1000 },
  });
  fireEvent.scroll(target);
  return { target, container, onScrollXChange, onRender };
}

describe('Timeline scroll viewport', () => {
  it('synchronizes scrolling without rerendering track contents', () => {
    const { target, container, onScrollXChange, onRender } = viewport();
    const labels = container.querySelector('.track-labels-panel') as HTMLElement;
    onRender.mockClear();
    target.scrollLeft = 120;
    target.scrollTop = 80;
    fireEvent.scroll(target);
    expect(labels.scrollTop).toBe(80);
    expect(onScrollXChange).toHaveBeenLastCalledWith(120);
    labels.scrollTop = 160;
    fireEvent.scroll(labels);
    expect(target.scrollTop).toBe(160);
    expect(onRender).not.toHaveBeenCalled();
  });

  it('follows the predominant axis of each event without waiting for a gesture timeout', () => {
    const { target } = viewport();
    expect(fireEvent.wheel(target, { deltaX: 30, deltaY: 8 })).toBe(false);
    const left = target.scrollLeft;
    expect(left).toBeGreaterThan(0);
    expect(target.scrollTop).toBe(0);
    fireEvent.wheel(target, { deltaX: 4, deltaY: 20 });
    expect(target.scrollLeft).toBe(left);
    const top = target.scrollTop;
    expect(top).toBeGreaterThan(0);
    fireEvent.wheel(target, { deltaX: -12, deltaY: 2 });
    expect(target.scrollLeft).toBeLessThan(left);
    expect(target.scrollTop).toBe(top);
  });

  it('bounds both axes and reports actual DOM scrolling to ruler and labels', () => {
    const { target, container, onScrollXChange } = viewport();
    fireEvent.wheel(target, { deltaX: 10000 });
    expect(target.scrollLeft).toBe(4200);
    fireEvent.wheel(target, { deltaY: 10000 });
    expect(target.scrollTop).toBe(800);
    fireEvent.scroll(target);
    expect(onScrollXChange).toHaveBeenLastCalledWith(4200);
    expect((container.querySelector('.track-labels-panel') as HTMLElement).scrollTop).toBe(800);
    fireEvent.wheel(target, { deltaX: -10000 });
    fireEvent.wheel(target, { deltaY: -10000 });
    expect(target.scrollLeft).toBe(0);
    expect(target.scrollTop).toBe(0);
  });

  it('leaves Ctrl/Meta zoom input to the parent without scrolling the viewport', () => {
    const { target } = viewport();
    for (const modifier of ['ctrlKey', 'metaKey']) {
      expect(fireEvent.wheel(target, { deltaY: 60, [modifier]: true })).toBe(true);
    }
    expect(target.scrollLeft).toBe(0);
    expect(target.scrollTop).toBe(0);
    fireEvent.wheel(target, { deltaX: 20 });
    expect(target.scrollLeft).toBeGreaterThan(0);
  });
});
