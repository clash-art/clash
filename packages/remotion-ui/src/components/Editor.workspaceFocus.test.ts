import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./Editor.tsx', import.meta.url), 'utf8');

describe('Editor workspace focus targets', () => {
  it('suppresses the UA focus ring on every programmatically focused workspace container', () => {
    const tags = [...source.matchAll(/<(aside|main|div)\s[^>]*?data-editor-workspace="[^"]+"[\s\S]*?className=(?:\{`|")([^`"]*)/g)];
    expect(tags.length).toBeGreaterThanOrEqual(6);
    for (const [, , className] of tags) {
      expect(className).toContain('outline-none');
    }
  });
});
