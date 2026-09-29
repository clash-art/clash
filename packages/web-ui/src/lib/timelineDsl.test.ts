import { describe, expect, it } from 'vitest';
import type { Track } from '@clash/remotion-core';
import { stripSrcFromTracks } from './timelineDsl';

describe('stripSrcFromTracks', () => {
    it('does not turn an Asset lookup fallback into an authored Canvas reference', () => {
        const item = { id: 'video', type: 'video' as const, assetId: 'asset-video', from: 20, durationInFrames: 60 };
        expect(stripSrcFromTracks([{ id: 'media', name: 'Media', items: [{ ...item, src: '/resolved-video.mp4' }] }])[0]!.items[0]).toEqual(item);
    });

    it('preserves self-contained data sources while stripping external media URLs', () => {
        const tracks: Track[] = [{
            id: 'visuals',
            name: 'Visuals',
            items: [
                {
                    id: 'spark',
                    type: 'sticker',
                    from: 0,
                    durationInFrames: 90,
                    src: 'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E',
                },
                {
                    id: 'photo',
                    type: 'image',
                    from: 0,
                    durationInFrames: 90,
                    src: 'https://signed.example.test/photo.jpg?token=stale',
                    sourceNodeId: 'canvas-photo',
                    assetId: 'asset-photo',
                },
            ],
        }];

        const items = stripSrcFromTracks(tracks)[0]!.items;

        expect(items[0]).toMatchObject({
            id: 'spark',
            src: 'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E',
        });
        expect(items[1]).not.toHaveProperty('src');
        expect(items[1]).toMatchObject({
            sourceNodeId: 'canvas-photo',
            assetId: 'asset-photo',
        });
    });

    it('strips disposable waveform samples from newly persisted Project media', () => {
        const tracks: Track[] = [{
            id: 'audio',
            name: 'Audio',
            items: [{
                id: 'voice',
                type: 'audio',
                assetId: 'asset-voice',
                sourceNodeId: 'canvas-voice',
                from: 0,
                durationInFrames: 980,
                src: 'https://signed.example.test/voice.wav?token=stale',
                waveform: [0.1, 0.8, 0.3],
            }],
        }];

        expect(stripSrcFromTracks(tracks)[0]!.items[0]).not.toHaveProperty('waveform');
    });
});
