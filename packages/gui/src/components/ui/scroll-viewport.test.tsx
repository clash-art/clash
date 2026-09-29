// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScrollViewport } from './scroll-viewport';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function fixture() {
  let resize: ResizeObserverCallback = () => {};
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  const dimensions = { clientWidth: 800, clientHeight: 200, scrollWidth: 5000, scrollHeight: 1000 };
  const measure = vi.fn();
  const ref = (node: HTMLDivElement | null) => {
    if (!node) return;
    for (const key of Object.keys(dimensions) as (keyof typeof dimensions)[]) {
      Object.defineProperty(node, key, { configurable: true, get: () => { measure(); return dimensions[key]; } });
    }
  };
  const view = render(<StrictMode><ScrollViewport ref={ref} data-testid="viewport"><div>content</div></ScrollViewport></StrictMode>);
  const target = view.getByTestId('viewport');
  return { ...view, target, dimensions, measure,
    rerenderContent: () => view.rerender(<StrictMode><ScrollViewport ref={ref} data-testid="viewport"><div>updated content</div></ScrollViewport></StrictMode>),
    resize: () => act(() => resize([], {} as ResizeObserver)) };
}

describe('VS Code viewport adapter', () => {
  it('lets resize observation measure changed content without forcing layout on every React commit', () => {
    const { measure, rerenderContent, resize } = fixture();
    measure.mockClear();
    rerenderContent();
    expect(measure).not.toHaveBeenCalled();
    resize();
    expect(measure).toHaveBeenCalled();
  });

  it('survives StrictMode setup/cleanup and removes its wheel listener on unmount', () => {
    const { target, container, unmount } = fixture();
    expect(container.querySelectorAll('.monaco-scrollable-element')).toHaveLength(1);
    fireEvent.wheel(target, { deltaX: 40 });
    expect(target.scrollLeft).toBeGreaterThan(0);
    const left = target.scrollLeft;
    unmount();
    fireEvent.wheel(target, { deltaX: 40 });
    expect(target.scrollLeft).toBe(left);
  });

  it('uses external DOM offsets for the next wheel event, preserving seek and zoom writes', () => {
    const { target } = fixture();
    target.scrollLeft = 200;
    target.scrollTop = 60;
    fireEvent.wheel(target, { deltaX: 40, deltaY: 2 });
    expect(target.scrollLeft).toBeGreaterThan(200);
    expect(target.scrollTop).toBe(60);
  });

  it('reclamps after content shrinks and hides scrollbars when everything fits', () => {
    const { target, container, dimensions, resize } = fixture();
    fireEvent.wheel(target, { deltaX: 10000 });
    fireEvent.wheel(target, { deltaY: 10000 });
    expect(target.scrollLeft).toBe(4200);
    expect(target.scrollTop).toBe(800);
    dimensions.scrollWidth = 800;
    dimensions.scrollHeight = 200;
    resize();
    expect(target.scrollLeft).toBe(0);
    expect(target.scrollTop).toBe(0);
    expect(container.querySelector('.scrollbar.horizontal')?.classList.contains('invisible')).toBe(true);
    expect(container.querySelector('.scrollbar.vertical')?.classList.contains('invisible')).toBe(true);
  });
});
