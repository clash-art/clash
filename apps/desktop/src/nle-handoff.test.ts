import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  detectNleAvailability,
  isNleApplicationBundle,
  materializeNleHandoff,
  materializedAssetPath,
  nleApplicationName,
  replaceAssetTokens,
  safeHandoffName,
} from './nle-handoff';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'clash-nle-handoff-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('desktop NLE handoff', () => {
  it('maps each target to the intended desktop application', () => {
    expect(nleApplicationName('premiere-pro')).toBe('Adobe Premiere Pro');
    expect(nleApplicationName('final-cut-pro')).toBe('Final Cut Pro');
    expect(nleApplicationName('davinci-resolve')).toBe('DaVinci Resolve');
  });

  it('recognizes versioned Premiere bundles without confusing unrelated apps', () => {
    expect(isNleApplicationBundle('premiere-pro', 'Adobe Premiere Pro 2026.app')).toBe(true);
    expect(isNleApplicationBundle('premiere-pro', 'Adobe Premiere Rush.app')).toBe(false);
    expect(isNleApplicationBundle('final-cut-pro', 'Final Cut Pro.app')).toBe(true);
    expect(isNleApplicationBundle('davinci-resolve', 'DaVinci Resolve.app')).toBe(true);
  });

  it('reports real installed state from a read-only application probe', async () => {
    const availability = await detectNleAvailability(async (target) =>
      target === 'final-cut-pro' ? '/Applications/Final Cut Pro.app' : null,
    );

    expect(availability).toEqual([
      { target: 'premiere-pro', applicationName: 'Adobe Premiere Pro', installed: false },
      {
        target: 'final-cut-pro',
        applicationName: 'Final Cut Pro',
        installed: true,
        applicationPath: '/Applications/Final Cut Pro.app',
      },
      { target: 'davinci-resolve', applicationName: 'DaVinci Resolve', installed: false },
    ]);
  });

  it('creates stable safe export names', () => {
    expect(safeHandoffName('  Launch / Cut  ', 'rev:7')).toBe('Launch-Cut-rev-7');
  });

  it('keeps local assets in place and materializes remote assets beside the handoff', () => {
    expect(materializedAssetPath('/tmp/handoff/media', '/Users/me/clip.mov', 'clip.mov')).toBe('/Users/me/clip.mov');
    expect(materializedAssetPath('/tmp/handoff/media', 'file:///Users/me/clip.mov', 'clip.mov')).toBe('/Users/me/clip.mov');
    expect(materializedAssetPath('/tmp/handoff/media', 'https://media.example/clip.mov', 'clip.mov')).toBe('/tmp/handoff/media/clip.mov');
  });

  it('replaces every opaque asset token with a file URL', () => {
    expect(replaceAssetTokens('A={{asset:0}} B={{asset:1}}', [
      { token: '{{asset:0}}', path: '/tmp/A Clip.mov' },
      { token: '{{asset:1}}', path: '/tmp/B.mov' },
    ])).toBe('A=file:///tmp/A%20Clip.mov B=file:///tmp/B.mov');
  });

  it('streams remote assets to disk and publishes the handoff only on success', async () => {
    const root = await tempRoot();
    const bytes = new TextEncoder().encode('remote-media-bytes');
    const documentPath = await materializeNleHandoff(root, {
      target: 'premiere-pro',
      timelineName: 'Launch / Cut',
      revisionId: 'rev:7',
      extension: 'otio',
      content: 'media={{asset:0}}',
      assets: [
        { token: '{{asset:0}}', source: 'https://media.example/clip.mov', filename: 'clip.mov' },
      ],
    }, {
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      })),
    });

    expect(documentPath).toBe(join(root, 'Launch-Cut-rev-7', 'Launch-Cut-rev-7.otio'));
    expect(await readFile(documentPath, 'utf8')).toBe(
      replaceAssetTokens('media={{asset:0}}', [{
        token: '{{asset:0}}',
        path: join(root, 'Launch-Cut-rev-7', 'media', '001-clip.mov'),
      }]),
    );
    expect(await readFile(join(root, 'Launch-Cut-rev-7', 'media', '001-clip.mov'), 'utf8')).toBe(
      'remote-media-bytes',
    );
    expect(await readdir(root)).toEqual(['Launch-Cut-rev-7']);
  });

  it('removes partial media and the handoff when a download body fails', async () => {
    const root = await tempRoot();
    await expect(materializeNleHandoff(root, {
      target: 'premiere-pro',
      timelineName: 'Launch',
      revisionId: 'rev-7',
      extension: 'otio',
      content: 'media={{asset:0}}',
      assets: [
        { token: '{{asset:0}}', source: 'https://media.example/clip.mov', filename: 'clip.mov' },
      ],
    }, {
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'));
          controller.error(new Error('connection reset'));
        },
      })),
    })).rejects.toMatchObject({ code: 'NLE_HANDOFF_DOWNLOAD_FAILED' });

    expect(await readdir(root)).toEqual([]);
  });

  it('fails offline with a coded download error inside the timeout', async () => {
    const root = await tempRoot();
    const fetchThatNeverCompletes: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason);
        });
      });
    const started = Date.now();
    await expect(materializeNleHandoff(root, {
      target: 'premiere-pro',
      timelineName: 'Launch',
      revisionId: 'rev-7',
      extension: 'otio',
      content: 'media={{asset:0}}',
      assets: [
        { token: '{{asset:0}}', source: 'https://media.example/clip.mov', filename: 'clip.mov' },
      ],
    }, {
      fetch: fetchThatNeverCompletes,
      downloadTimeoutMs: 10,
    })).rejects.toMatchObject({ code: 'NLE_HANDOFF_DOWNLOAD_FAILED' });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await readdir(root)).toEqual([]);
  });

  it('fails a non-2xx download with the same coded error', async () => {
    const root = await tempRoot();
    await expect(materializeNleHandoff(root, {
      target: 'premiere-pro',
      timelineName: 'Launch',
      revisionId: 'rev-7',
      extension: 'otio',
      content: '',
      assets: [
        { token: '{{asset:0}}', source: 'https://media.example/clip.mov', filename: 'clip.mov' },
      ],
    }, {
      fetch: async () => new Response('missing', { status: 404 }),
    })).rejects.toMatchObject({ code: 'NLE_HANDOFF_DOWNLOAD_FAILED' });

    expect(await readdir(root)).toEqual([]);
  });
});
