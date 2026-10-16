/**
 * The one visual identity for a collaborator, shared by the toolbar peer list,
 * peer cursors and selection rings. A user's sessions all carry that user's
 * avatar, name and colour; an agent session adds the corner agent badge.
 * `kind` is stamped by the server from how the connection authenticated.
 */
import type { ReactNode } from "react";
import { AgentMotion } from "./copilot/AgentMotion";
import { presenceLabel, type PresenceKind } from "@clash/shared-types";
import {
  AvatarFallback,
  AvatarImage,
  AvatarRoot,
  type AvatarSize,
} from "./ui/avatar";
import { Badge } from "./ui/badge";

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

/** Corner marker for an agent session; the parent must be `relative`. */
export function PresenceAgentBadge() {
  return (
    <span
      data-presence-agent-badge
      aria-hidden="true"
      className="absolute -bottom-0.5 -right-0.5 inline-flex size-3.5 items-center justify-center drop-shadow-[0_0_1px_rgba(0,0,0,0.45)]"
    >
      <AgentMotion
        decorative
        state="idle"
        className="clash-agent-motion--compact clash-agent-motion--badge size-3.5"
      />
    </span>
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
      {kind === "agent" && <PresenceAgentBadge />}
    </span>
  );
}

/** Name pill in the user's colour, used next to cursors and selection rings. */
export function PresenceNameBadge({
  name,
  kind,
  color,
  agentIcon = false,
  className = "",
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
      {agentIcon && kind === "agent" && (
        <AgentMotion
          decorative
          state="idle"
          className="clash-agent-motion--compact clash-agent-motion--badge size-3.5"
        />
      )}
      {presenceLabel({ name, kind })}
      {children}
    </Badge>
  );
}
