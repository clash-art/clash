import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

function readSource(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('PresenceBar tooltip primitives', () => {
  it('uses the shared tooltip primitive instead of local Ariakit tooltip plumbing', () => {
    const source = readSource('packages/web-ui/src/components/PresenceBar.tsx');
    const avatarSource = readSource('packages/web-ui/src/components/PresenceAvatar.tsx');
    const tooltipSource = readSource('packages/gui/src/components/ui/tooltip.tsx');

    expect(tooltipSource).toContain('@ariakit/react');
    expect(tooltipSource).toContain('TooltipProvider');
    expect(tooltipSource).toContain('TooltipAnchor');
    expect(source).toContain('./ui/tooltip');
    expect(source).toContain('./ui/avatar');
    expect(source).toContain('<Tooltip label={presenceLabel(client)}>');
    expect(source).toContain('<PresenceAvatar');
    expect(avatarSource).toContain('./ui/avatar');
    expect(avatarSource).toContain('./ui/badge');
    expect(avatarSource).toContain('<AvatarRoot');
    expect(avatarSource).toContain('<AvatarImage');
    expect(avatarSource).toContain('<AvatarFallback');
    expect(avatarSource).not.toContain('<svg');
    expect(source).not.toContain("Avatar as AvatarPrimitive");
    expect(source).not.toContain('AvatarPrimitive.');
    expect(source).not.toContain("from 'radix-ui'");
    expect(source).not.toContain('@ariakit/react');
    expect(source).not.toContain('TooltipProvider');
    expect(source).not.toContain('TooltipAnchor');
    expect(source).not.toContain('tabIndex={0}');
    expect(source).not.toContain('<img');
    expect(source).not.toContain('role="tooltip"');
    expect(source).not.toContain('group-hover:opacity-100');
  });
});
