// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EditorProvider, useEditorDispatch } from '@clash/remotion-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimelineTracksContainer } from './TimelineTracksContainer';

const observers: IntersectionObserverStub[] = [];
class IntersectionObserverStub {
  observed = new Set<Element>();
  constructor(private callback: IntersectionObserverCallback) { observers.push(this); }
  observe(element: Element) { this.observed.add(element); }
  disconnect() { this.observed.clear(); }
  notify(trackId: string, isIntersecting: boolean) {
    const target = [...this.observed].find(element => element.getAttribute('data-timeline-track-id') === trackId);
    expect(target).toBeDefined();
    this.callback([{ target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

beforeEach(() => {
  window.currentDraggedItem = null;
  observers.length = 0;
  vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const noop = () => {};
function EditNearTitle() {
  const dispatch = useEditorDispatch();
  return <button onClick={() => dispatch({ type: 'UPDATE_ITEM', payload: {
    trackId: 'near', itemId: 'near-title', updates: { text: 'EDITED' },
  } })}>Edit near title</button>;
}
function Scene({ selectedItemId = null, dragging = false }: { selectedItemId?: string | null; dragging?: boolean }) {
  return <EditorProvider initialState={{ tracks: [
    { id: 'near', name: 'Near', category: 'text', items: [{ id: 'near-title', type: 'text', color: '#ffffff', text: 'NEAR', from: 0, durationInFrames: 60 }] },
    { id: 'far', name: 'Far', category: 'text', items: [{ id: 'far-title', type: 'text', color: '#ffffff', text: 'FAR', from: 0, durationInFrames: 60 }] },
  ] }}>
    <EditNearTitle />
    <TimelineTracksContainer durationInFrames={300} pixelsPerFrame={2} fps={30}
      selectedTrackId={null} selectedItemId={selectedItemId} assets={[]} dragPreview={dragging ? {
        itemId: 'far-title', item: { id: 'far-title', type: 'text', color: '#ffffff', text: 'FAR', from: 0, durationInFrames: 60 },
        originalTrackId: 'far', originalFrom: 0, previewTrackId: 'near', previewFrame: 60,
      } : null}
      onSelectTrack={noop} onSelectItem={noop} onDeleteItem={noop} onUpdateItem={noop}
      onDragOver={noop} onDrop={noop} onEmptyDrop={noop} onItemDragStart={noop}
      onItemDragOver={noop} onItemDrop={noop} onItemDragEnd={noop} />
  </EditorProvider>;
}

describe('Timeline track content visibility', () => {
  it('keeps distant controls released while editing a visible item', () => {
    render(<Scene />);
    act(() => observers.at(-1)!.notify('far', false));
    expect(screen.queryByRole('button', { name: 'text: FAR' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit near title' }));
    expect(screen.getByRole('button', { name: 'text: EDITED' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'text: FAR' })).toBeNull();
  });

  it('unmounts distant clip controls while retaining lane geometry, then restores them on approach', () => {
    const { container } = render(<Scene />);
    const lane = container.querySelector('[data-timeline-track-id="far"]') as HTMLElement;
    expect(lane).not.toBeNull();
    const height = lane.style.height;
    expect(screen.getByRole('button', { name: 'text: FAR' })).toBeTruthy();
    act(() => observers.at(-1)!.notify('far', false));
    expect(screen.queryByRole('button', { name: 'text: FAR' })).toBeNull();
    expect(lane.isConnected).toBe(true);
    expect(lane.style.height).toBe(height);
    expect(screen.getByRole('button', { name: 'text: NEAR' })).toBeTruthy();
    act(() => observers.at(-1)!.notify('far', true));
    expect(screen.getByRole('button', { name: 'text: FAR' })).toBeTruthy();
  });

  it('retains the selected clip even outside the viewport and releases it after selection changes', () => {
    const { rerender } = render(<Scene selectedItemId="far-title" />);
    act(() => observers.at(-1)!.notify('far', false));
    expect(screen.getByRole('button', { name: 'text: FAR' })).toBeTruthy();
    rerender(<Scene selectedItemId="near-title" />);
    expect(screen.queryByRole('button', { name: 'text: FAR' })).toBeNull();
  });

  it('retains the drag source when autoscroll takes its lane out of view', () => {
    const { rerender } = render(<Scene dragging />);
    act(() => observers.at(-1)!.notify('far', false));
    expect(screen.getByRole('button', { name: 'text: FAR' })).toBeTruthy();
    rerender(<Scene />);
    expect(screen.queryByRole('button', { name: 'text: FAR' })).toBeNull();
  });
});
