// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorProvider, useEditorHistory, useEditorStaticState } from '@clash/remotion-core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Timeline } from './Timeline';

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

const LayoutProbe = () => {
  const { tracks } = useEditorStaticState();
  const { undo } = useEditorHistory();
  return (
    <>
      <output aria-label="Layout">
        {tracks.map((track) => `${track.id}:${track.items.map((item) => item.from).join(',')}`).join('|')}
      </output>
      <button type="button" onClick={undo}>Undo paste</button>
    </>
  );
};

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  window.currentDraggedItem = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('Ctrl+C / Ctrl+V pastes at the playhead, walking up past a conflicting track, as one Undo step', async () => {
  render(
    <EditorProvider
      initialState={{
        currentFrame: 70,
        selectedItemId: 'a',
        tracks: [
          { id: 'top', name: 'Top', category: 'visual', items: [{ id: 't', type: 'video', src: 't.mp4', from: 0, durationInFrames: 20 }] },
          { id: 'middle', name: 'Middle', category: 'visual', items: [{ id: 'm', type: 'video', src: 'm.mp4', from: 50, durationInFrames: 100 }] },
          {
            id: 'primary',
            name: 'Media',
            category: 'primary',
            items: [
              { id: 'a', type: 'video', src: 'a.mp4', from: 0, durationInFrames: 30 },
              { id: 'b', type: 'video', src: 'b.mp4', from: 60, durationInFrames: 60 },
            ],
          },
        ],
        primaryTrackId: 'primary',
      }}
    >
      <Timeline />
      <LayoutProbe />
    </EditorProvider>,
  );
  const layout = () => screen.getByLabelText('Layout').textContent;
  expect(layout()).toBe('top:0|middle:50|primary:0,60');

  fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
  fireEvent.keyDown(window, { key: 'v', ctrlKey: true });
  await waitFor(() => expect(layout()).toBe('top:0,70|middle:50|primary:0,60'));

  fireEvent.click(screen.getByRole('button', { name: 'Undo paste' }));
  await waitFor(() => expect(layout()).toBe('top:0|middle:50|primary:0,60'));
});
