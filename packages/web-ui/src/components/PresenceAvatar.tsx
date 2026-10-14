/**
 * The one visual identity for a collaborator, shared by the toolbar peer list,
 * peer cursors and selection rings. A user's sessions all carry that user's
 * avatar, name and colour; an agent session adds the corner agent badge.
 * `kind` is stamped by the server from how the connection authenticated.
 */
import type { ReactNode } from 'react';
import { Robot } from '@phosphor-icons/react';
import { presenceLabel, type PresenceKind } from '@clash/shared-types';
import { AvatarFallback, AvatarImage, AvatarRoot, type AvatarSize } from './ui/avatar';
import { Badge } from './ui/badge';

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

/** Corner marker for an agent session; the parent must be `relative`. */
export function PresenceAgentBadge({ color }: { color: string }) {
  return (
    <Badge
      data-presence-agent-badge
      aria-hidden="true"
      className="absolute -bottom-1 -right-1 size-4 border-warm-surface p-0 text-white shadow-sm [&>svg]:size-2.5"
      style={{ background: color }}
    >
      <Robot weight="fill" />
    </Badge>
  );
}

interface PresenceIdentity {
  name: string;
  kind: PresenceKind;
  /** The user's colour; an agent shares the colour of the user it acts for. */
  color: string;
}

export function PresenceAvatar({
  name,
  kind,
  color,
  avatar,
  size,
}: PresenceIdentity & { avatar?: string; size?: AvatarSize }) {
  return (
    <span className="relative inline-flex" data-presence-kind={kind}>
      <AvatarRoot
        size={size}
        aria-label={presenceLabel({ name, kind })}
        className="border-2 border-warm-surface shadow-sm"
      >
        {avatar && <AvatarImage src={avatar} alt={name} />}
        <AvatarFallback
          className="text-xs font-bold text-white"
          style={{ background: color }}
        >
          {getInitials(name)}
        </AvatarFallback>
      </AvatarRoot>
      {kind === 'agent' && <PresenceAgentBadge color={color} />}
    </span>
  );
}

/** Name pill in the user's colour, used next to cursors and selection rings. */
export function PresenceNameBadge({
  name,
  kind,
  color,
  agentIcon = false,
  className = '',
  children,
}: PresenceIdentity & {
  /** Inline agent icon, for surfaces without a corner badge. */
  agentIcon?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Badge
      data-presence-kind={kind}
      className={`border-transparent text-white shadow-sm ${className}`}
      style={{ background: color }}
    >
      {agentIcon && kind === 'agent' && <Robot weight="fill" aria-hidden="true" />}
      {presenceLabel({ name, kind })}
      {children}
    </Badge>
  );
}
