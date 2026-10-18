// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelineHeader } from './TimelineHeader';

afterEach(() => cleanup());

describe('TimelineHeader', () => {
  it('uses surface spacing instead of a persistent header rule', () => {
    const { container } = render(
      <TimelineHeader
        zoom={1}
        snapEnabled
        canUndo={false}
        canRedo={false}
        onUndo={() => {}}
        onRedo={() => {}}
        onZoomIn={() => {}}
        onZoomOut={() => {}}
        onToggleSnap={() => {}}
        onZoomChange={() => {}}
      />,
    );

    expect((container.firstElementChild as HTMLElement).style.borderBottom).toBe('');
  });

  it('keeps transport controls out of the Timeline header', () => {
    render(
      <TimelineHeader
        zoom={1}
        snapEnabled
        canUndo={false}
        canRedo={false}
        onUndo={() => {}}
        onRedo={() => {}}
        onZoomIn={() => {}}
        onZoomOut={() => {}}
        onZoomToFit={() => {}}
        onZoomReset={() => {}}
        onToggleSnap={() => {}}
        onZoomChange={() => {}}
        zoomLimits={{ min: 0.02, max: 8 }}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Timeline zoom' })).toBeTruthy();
  });

  it('does not offer a manual add-track control (tracks are created by dragging media in)', () => {
    render(
      <TimelineHeader
        zoom={1}
        snapEnabled
        canUndo={false}
        canRedo={false}
        onUndo={() => {}}
        onRedo={() => {}}
        onZoomIn={() => {}}
        onZoomOut={() => {}}
        onToggleSnap={() => {}}
        onZoomChange={() => {}}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Add video track' })).toBeNull();
    expect(screen.queryByText('Video track')).toBeNull();
  });

  it('exposes working Undo and Redo controls with disabled state', () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    const { rerender } = render(
      <TimelineHeader
        zoom={1}
        snapEnabled
        canUndo
        canRedo={false}
        onUndo={onUndo}
        onRedo={onRedo}
        onZoomIn={() => {}}
        onZoomOut={() => {}}
        onZoomToFit={() => {}}
        onZoomReset={() => {}}
        onToggleSnap={() => {}}
        onZoomChange={() => {}}
      />,
    );

    const undo = screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement;
    const redo = screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    expect(redo.disabled).toBe(true);
    undo.click();
    redo.click();
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onRedo).not.toHaveBeenCalled();

    rerender(
      <TimelineHeader
        zoom={1}
        snapEnabled
        canUndo={false}
        canRedo
        onUndo={onUndo}
        onRedo={onRedo}
        onZoomIn={() => {}}
        onZoomOut={() => {}}
        onToggleSnap={() => {}}
        onZoomChange={() => {}}
      />,
    );
    redo.click();
    expect(onRedo).toHaveBeenCalledOnce();
  });

  it('keeps split, trim, and delete tools pinned in the timeline header', () => {
    const onSplitSelected = vi.fn();
    const onTrimLeftSelected = vi.fn();
    const onTrimRightSelected = vi.fn();
    const onDeleteSelected = vi.fn();
    render(
      <TimelineHeader
        zoom={1}
        snapEnabled
        canUndo={false}
        canRedo={false}
        canEditSelected
        hasSelectedItem
        onUndo={() => {}}
        onRedo={() => {}}
        onSplitSelected={onSplitSelected}
        onTrimLeftSelected={onTrimLeftSelected}
        onTrimRightSelected={onTrimRightSelected}
        onDeleteSelected={onDeleteSelected}
        onZoomIn={() => {}}
        onZoomOut={() => {}}
        onToggleSnap={() => {}}
        onZoomChange={() => {}}
      />,
    );

    screen.getByRole('button', { name: 'Split at playhead' }).click();
    screen.getByRole('button', { name: 'Trim start to playhead' }).click();
    screen.getByRole('button', { name: 'Trim end to playhead' }).click();
    screen.getByRole('button', { name: 'Delete selected item' }).click();

    expect(onSplitSelected).toHaveBeenCalledOnce();
    expect(onTrimLeftSelected).toHaveBeenCalledOnce();
    expect(onTrimRightSelected).toHaveBeenCalledOnce();
    expect(onDeleteSelected).toHaveBeenCalledOnce();
  });
});
