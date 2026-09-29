// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EditorProvider,
  TIMELINE_CAPTION_STYLE_DEFAULTS,
  type TextItem,
} from '@clash/remotion-core';
import { PropertiesPanel } from './PropertiesPanel';

afterEach(() => cleanup());

describe('PropertiesPanel caption defaults', () => {
  it('shows the same absent-style defaults that the renderer applies', () => {
    const caption: TextItem = {
      id: 'caption',
      type: 'text',
      text: 'Hello',
      color: '#ff0000',
      from: 0,
      durationInFrames: 30,
      cues: [{ id: 'cue', startFrame: 0, durationInFrames: 30, text: 'Hello' }],
    };
    render(
      <EditorProvider initialState={{
        tracks: [{ id: 'captions', name: 'Captions', role: 'subtitle', items: [caption] }],
        selectedItemId: caption.id,
      }}>
        <PropertiesPanel />
      </EditorProvider>,
    );

    expect(screen.getByRole('combobox', { name: 'Caption position' }).textContent)
      .toContain('Bottom');
    expect((screen.getByRole('spinbutton', { name: 'Caption font size' }) as HTMLInputElement).value)
      .toBe(String(TIMELINE_CAPTION_STYLE_DEFAULTS.fontSize));
    expect((screen.getByRole('textbox', { name: 'Caption text color' }) as HTMLInputElement).value)
      .toBe(TIMELINE_CAPTION_STYLE_DEFAULTS.color);
    expect((screen.getByRole('textbox', { name: 'Caption background color' }) as HTMLInputElement).value)
      .toBe(TIMELINE_CAPTION_STYLE_DEFAULTS.backgroundColor);
    expect(screen.getByRole('button', { name: 'Caption font family' }).textContent)
      .toContain(TIMELINE_CAPTION_STYLE_DEFAULTS.fontFamily);
    expect(screen.getByRole('combobox', { name: 'Caption font weight' }).textContent)
      .toContain('Bold');
  });
});
