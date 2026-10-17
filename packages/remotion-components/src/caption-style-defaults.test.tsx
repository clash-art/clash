import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TIMELINE_CAPTION_STYLE_DEFAULTS } from '@clash/remotion-core';
import { VideoComposition } from './VideoComposition';

vi.mock('remotion', () => ({
  AbsoluteFill: ({ children, style, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div style={style} {...props}>{children}</div>
  ),
  Sequence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Img: (props: React.ImgHTMLAttributes<HTMLImageElement>) => <img {...props} />,
  useCurrentFrame: () => 0,
  useVideoConfig: () => ({ width: 1080, height: 1920, fps: 30, durationInFrames: 30 }),
  interpolate: (
    input: number,
    [inputStart, inputEnd]: [number, number],
    [outputStart, outputEnd]: [number, number],
  ) => {
    const progress = inputEnd === inputStart ? 1 : (input - inputStart) / (inputEnd - inputStart);
    return outputStart + ((outputEnd - outputStart) * Math.min(1, Math.max(0, progress)));
  },
}));

vi.mock('@remotion/media', () => ({
  Video: (props: React.VideoHTMLAttributes<HTMLVideoElement>) => <video {...props} />,
  Audio: (props: React.AudioHTMLAttributes<HTMLAudioElement>) => <audio {...props} />,
}));

describe('caption renderer defaults', () => {
  it('renders an absent caption style with the shared inspector defaults', () => {
    const markup = renderToStaticMarkup(
      <VideoComposition tracks={[{
        id: 'captions',
        name: 'Captions',
        role: 'subtitle',
        items: [{
          id: 'caption',
          type: 'text',
          text: 'Hello',
          color: '#ff0000',
          from: 0,
          durationInFrames: 30,
          cues: [{ id: 'cue', startFrame: 0, durationInFrames: 30, text: 'Hello' }],
        }],
      }]} />,
    );

    expect(markup).toContain(`background-color:${TIMELINE_CAPTION_STYLE_DEFAULTS.backgroundColor}`);
    expect(markup).toContain(`color:${TIMELINE_CAPTION_STYLE_DEFAULTS.color}`);
    expect(markup).toContain(`font-family:${TIMELINE_CAPTION_STYLE_DEFAULTS.fontFamily}`);
    expect(markup).toContain(`font-size:${TIMELINE_CAPTION_STYLE_DEFAULTS.fontSize}px`);
    expect(markup).toContain(`font-weight:${TIMELINE_CAPTION_STYLE_DEFAULTS.fontWeight}`);
    expect(markup).toContain(`line-height:${TIMELINE_CAPTION_STYLE_DEFAULTS.lineHeight}`);
  });
});
