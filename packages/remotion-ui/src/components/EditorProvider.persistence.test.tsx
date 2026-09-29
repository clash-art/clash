// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EditorProvider, useEditorDispatch, type Asset } from '@clash/remotion-core';

afterEach(cleanup);

it('persists zoom without traversing unchanged media and ignores playback-only changes', () => {
  let mediaReads = 0;
  const asset: Asset = {
    id: 'photo', type: 'image', name: 'Photo', createdAt: 0,
    get src() { mediaReads += 1; return 'photo.png'; },
  };
  const save = vi.fn();
  function Controls() {
    const dispatch = useEditorDispatch();
    return <>
      <button onClick={() => dispatch({ type: 'SET_ZOOM', payload: 2 })}>Zoom</button>
      <button onClick={() => dispatch({ type: 'SET_CURRENT_FRAME', payload: 30 })}>Seek</button>
      <button onClick={() => dispatch({ type: 'ADD_ASSET', payload: { id: 'second', type: 'image', name: 'Second', src: 'second.png', createdAt: 0 } })}>Add media</button>
    </>;
  }
  render(<EditorProvider initialState={{ assets: [asset] }} onStateChange={save}><Controls /></EditorProvider>);
  mediaReads = 0;
  save.mockClear();
  fireEvent.click(screen.getByText('Zoom'));
  expect(save).toHaveBeenCalledOnce();
  expect(save.mock.calls[0][0].zoom).toBe(2);
  expect(mediaReads).toBe(0);
  fireEvent.click(screen.getByText('Seek'));
  fireEvent.click(screen.getByText('Zoom'));
  expect(save).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText('Add media'));
  expect(save.mock.calls.at(-1)?.[0].assets.some((entry: Asset) => entry.id === 'second')).toBe(true);
  expect(mediaReads).toBeGreaterThan(0);
});
