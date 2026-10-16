import { motion, AnimatePresence } from "framer-motion";
import { Browser, Robot } from "@phosphor-icons/react";
import type { PresenceClient } from "@clash/shared-types";
import { colorForUserId } from "@clash/web-ui/hooks/usePresenceAwareness";
import { AvatarFallback, AvatarRoot } from "./ui/avatar";
import { PresenceAvatar } from "./PresenceAvatar";
import { Tooltip } from "./ui/tooltip";

export function groupPresenceClients(clients: PresenceClient[]) {
  const groups = new Map<string, PresenceClient[]>();
  for (const client of clients) {
    const sessions = groups.get(client.userId) ?? [];
    if (!sessions.some((session) => session.id === client.id))
      sessions.push(client);
    groups.set(client.userId, sessions);
  }
  return Array.from(groups.values());
}

export function PresenceSessions({ sessions }: { sessions: PresenceClient[] }) {
  return (
    <div className="space-y-1 text-left">
      <div className="font-semibold">{sessions[0].name}</div>
      {sessions.map((session) => {
        const Icon = session.kind === "agent" ? Robot : Browser;
        return (
          <div
            key={session.id}
            className="flex items-center gap-1.5 font-normal"
          >
            <Icon size={12} aria-hidden="true" />
            <span>
              {session.device ||
                (session.kind === "human"
                  ? "Another window"
                  : "Agent session")}{" "}
              · {session.kind === "agent" ? "Agent" : "Human"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function PresenceBar({
  clients,
}: {
  clients: PresenceClient[];
}) {
  const groups = groupPresenceClients(clients);
  if (!groups.length) return null;
  const visible = groups.slice(0, 4);
  const hidden = groups.slice(4);
  return (
    <div
      className="flex shrink-0 items-center -space-x-2"
      aria-label="Project participants"
    >
      <AnimatePresence mode="popLayout">
        {visible.map((sessions) => {
          const client = sessions[0];
          // One identity per user; the same corner badge as agent cursors signals
          // any agent activity. The tooltip preserves each session's own kind.
          const kind = sessions.some((session) => session.kind === "agent")
            ? "agent"
            : "human";
          return (
            <motion.div
              key={client.userId}
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
            >
              <Tooltip label={<PresenceSessions sessions={sessions} />}>
                <span
                  tabIndex={0}
                  aria-label={`${client.name} · ${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`}
                  className="relative inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <PresenceAvatar
                    name={client.name}
                    kind={kind}
                    avatar={client.avatar}
                    color={colorForUserId(client.userId)}
                    size="sm"
                  />
                </span>
              </Tooltip>
            </motion.div>
          );
        })}
      </AnimatePresence>
      {hidden.length > 0 && (
        <Tooltip
          label={
            <div className="space-y-2">
              {hidden.map((sessions) => (
                <PresenceSessions
                  key={sessions[0].userId}
                  sessions={sessions}
                />
              ))}
            </div>
          }
        >
          <span
            tabIndex={0}
            aria-label={`${hidden.length} more participants: ${hidden.map((sessions) => sessions[0].name).join(", ")}`}
            className="relative inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <AvatarRoot
              size="sm"
              className="border-2 border-warm-surface shadow-sm"
            >
              <AvatarFallback className="bg-warm-muted text-xs font-semibold text-content-secondary">
                +{hidden.length}
              </AvatarFallback>
            </AvatarRoot>
          </span>
        </Tooltip>
      )}
    </div>
  );
}
