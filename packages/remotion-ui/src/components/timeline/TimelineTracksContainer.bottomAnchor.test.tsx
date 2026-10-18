// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { EditorProvider } from '@clash/remotion-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimelineTracksContainer } from './TimelineTracksContainer';
import { getTrackBandAtY, toTrackStackY } from './trackGeometry';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

beforeEach(() => {
  window.currentDraggedItem = null;
});

const noop = () => {};

const tracks = [
  { id: 'fx', name: 'FX', category: 'effect' as const, items: [] },
  { id: 'titles', name: 'Titles', category: 'text' as const, items: [] },
  { id: 'broll', name: 'B-roll', category: 'visual' as const, items: [] },
  { id: 'story', name: 'Media', category: 'primary' as const, items: [] },
  { id: 'music', name: 'Music', category: 'audio' as const, items: [] },
];

function renderContainer(
  options: {
    labelsPortal?: HTMLElement | null;
    initialStateTracks?: typeof tracks;
    onDrop?: (trackId: string, event: React.DragEvent) => void;
  } = {},
) {
  return render(
    <EditorProvider
      initialState={{
        primaryTrackId: 'story',
        tracks: options.initialStateTracks ?? tracks,
      }}
    >
      <TimelineTracksContainer
        durationInFrames={300}
        pixelsPerFrame={1}
        fps={30}
        selectedTrackId={null}
        selectedItemId={null}
        assets={[]}
        onSelectTrack={noop}
        onSelectItem={noop}
        onDeleteItem={noop}
        onUpdateItem={noop}
        onDragOver={noop}
        onDrop={options.onDrop ?? noop}
        onEmptyDrop={noop}
        onItemDragStart={noop}
        onItemDragOver={noop}
        onItemDrop={noop}
        onItemDragEnd={noop}
        dragPreview={null}
        labelsPortal={options.labelsPortal ?? undefined}
      />
    </EditorProvider>,
  );
}

function mockRect(element: Element, top: number, height: number) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      bottom: top + height,
      height,
      left: 0,
      right: 800,
      top,
      width: 800,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }),
  });
}

function dragDataTransfer() {
  return {
    types: [] as string[],
    dropEffect: 'none',
    effectAllowed: 'all',
    getData: () => '',
    setData: () => {},
  } as unknown as DataTransfer;
}

// jsdom does not implement DragEvent, and a plain Event drops clientY, so use
// a MouseEvent with the drag type name and attach the data transfer manually.
function fireDragEvent(
  element: Element,
  type: 'dragenter' | 'dragover' | 'drop',
  clientY: number,
  dataTransfer: DataTransfer,
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: 0,
    clientY,
  });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  fireEvent(element, event);
}

describe('TimelineTracksContainer bottom anchor', () => {
  it('bottom-anchors the lane stack and keeps the canonical track order', () => {
    const { container } = renderContainer();
    const stack = container.querySelector('[data-timeline-track-stack]') as HTMLElement;
    expect(stack).not.toBeNull();
    const lanesContent = stack.parentElement as HTMLElement;

    expect(lanesContent.style.display).toBe('flex');
    expect(lanesContent.style.flexDirection).toBe('column');
    expect(lanesContent.style.justifyContent).toBe('flex-end');
    expect(lanesContent.style.minHeight).toBe('100%');
    expect(stack.style.position).toBe('relative');
    expect(stack.style.flexShrink).toBe('0');

    const lanes = Array.from(stack.querySelectorAll('[data-track-lane]'));
    expect(lanes.map((lane) => lane.getAttribute('data-timeline-track-id'))).toEqual([
      'fx',
      'titles',
      'broll',
      'story',
      'music',
    ]);
    const primaryLaneIndex = lanes.findIndex((lane) => lane.hasAttribute('data-primary-track'));
    expect(primaryLaneIndex).toBe(3);
    expect(
      lanes.slice(primaryLaneIndex + 1).map((lane) => lane.getAttribute('data-timeline-track-id')),
    ).toEqual(['music']);
  });

  it('bottom-anchors the inline label column with a matching stack', () => {
    const { container } = renderContainer();
    const panel = container.querySelector('.track-labels-panel') as HTMLElement;
    const labelStack = panel.querySelector('[data-timeline-label-stack]') as HTMLElement;
    expect(labelStack).not.toBeNull();
    const inner = labelStack.parentElement as HTMLElement;

    expect(panel.style.height).toBe('100%');
    expect(inner.style.minHeight).toBe('100%');
    expect(inner.style.display).toBe('flex');
    expect(inner.style.flexDirection).toBe('column');
    expect(inner.style.justifyContent).toBe('flex-end');
    expect(inner.style.boxSizing).toBe('border-box');

    const labelRows = Array.from(labelStack.children);
    expect(labelRows.map((row) => row.getAttribute('data-agent-annotation-object-id'))).toEqual([
      'fx',
      'titles',
      'broll',
      'story',
      'music',
    ]);
    const primaryLabelIndex = labelRows.findIndex((row) => row.hasAttribute('data-primary-track'));
    expect(primaryLabelIndex).toBe(3);
  });

  it('bottom-anchors the portal label column too', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    renderContainer({ labelsPortal: host });

    const panel = host.querySelector('.track-labels-panel') as HTMLElement;
    const labelStack = panel.querySelector('[data-timeline-label-stack]') as HTMLElement;
    const inner = labelStack.parentElement as HTMLElement;
    expect(inner.style.display).toBe('flex');
    expect(inner.style.flexDirection).toBe('column');
    expect(inner.style.justifyContent).toBe('flex-end');
    expect(inner.style.minHeight).toBe('100%');
  });

  it('converts client Y against the bottom-anchored stack, not the content top', () => {
    const viewport = document.createElement('div');
    const stack = document.createElement('div');
    stack.setAttribute('data-timeline-track-stack', '');
    viewport.appendChild(stack);
    document.body.appendChild(viewport);
    mockRect(viewport, 100, 600);
    mockRect(stack, 400, 268);

    // Blank space above the stack is a real insertion zone at index 0.
    const blankY = toTrackStackY(viewport, 250);
    expect(blankY).toBe(-150);
    expect(blankY < 0).toBe(true);

    // A Y in the primary band maps to the primary track (effect/text/visual
    // bands total 132px in the canonical order above).
    const primaryY = toTrackStackY(viewport, 550);
    expect(primaryY).toBe(150);
    expect(getTrackBandAtY(primaryY, tracks, 'story')?.index).toBe(3);
  });

  it('inserts at 0 above the stack and hits the primary track inside its band', () => {
    const onDrop = vi.fn();
    const { container } = renderContainer({ onDrop });
    const tracksContainer = container.querySelector('.timeline-tracks-container') as HTMLElement;
    const viewport = container.querySelector('.tracks-viewport') as HTMLElement;
    const stack = container.querySelector('[data-timeline-track-stack]') as HTMLElement;
    mockRect(viewport, 100, 600);
    mockRect(stack, 400, 268);

    const dataTransfer = dragDataTransfer();
    fireDragEvent(tracksContainer, 'dragenter', 250, dataTransfer);
    fireDragEvent(viewport, 'dragover', 250, dataTransfer);
    expect(
      container.querySelector('[data-timeline-insert-indicator]')?.getAttribute(
        'data-timeline-insert-indicator',
      ),
    ).toBe('0');

    fireDragEvent(viewport, 'dragover', 550, dataTransfer);
    expect(container.querySelector('[data-timeline-insert-indicator]')).toBeNull();
    fireDragEvent(viewport, 'drop', 550, dataTransfer);
    expect(onDrop).toHaveBeenCalledWith('story', expect.anything());
  });

  it('keeps the primary lane flush with the lanes container bottom when only upper tracks exist', () => {
    // jsdom has no layout engine, so assert the CSS contract that produces the
    // flush bottom in a real browser: the lanes container is a flex column
    // packed to flex-end, the stack is its only in-flow child (overlays are
    // absolutely positioned), and nothing follows the primary lane inside the
    // stack. Real-browser pixel alignment is verified on staging (see PR).
    const primaryOnly = tracks.slice(0, 4);
    const { container } = renderContainer({ initialStateTracks: primaryOnly });
    const stack = container.querySelector('[data-timeline-track-stack]') as HTMLElement;
    const lanesContainer = stack.parentElement as HTMLElement;
    const primaryLane = stack.querySelector('[data-primary-track]') as HTMLElement;
    expect(primaryLane.getAttribute('data-timeline-track-id')).toBe('story');

    expect(lanesContainer.style.justifyContent).toBe('flex-end');
    const inFlowSiblings = Array.from(lanesContainer.children).filter(
      (child) => child !== stack && (child as HTMLElement).style.position !== 'absolute',
    );
    expect(inFlowSiblings).toEqual([]);
    expect(stack.lastElementChild).toBe(primaryLane);
  });

  it('starts scrolled to the bottom when the stack overflows the viewport', () => {
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('tracks-viewport') ? 1000 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('tracks-viewport') ? 200 : 0;
      },
    });
    try {
      const { container } = renderContainer();
      const viewport = container.querySelector('.tracks-viewport') as HTMLElement;
      expect(viewport.scrollTop).toBe(1000);
    } finally {
      if (scrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeight);
      if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight);
    }
  });

});