/**
 * AttributionLine — small "Made by X" label for canvas nodes.
 *
 * Renders inside an ImageNode header or ActionBadge chip, showing who
 * is responsible for the node:
 *   - actorType='user'  → that user's display name ("Made by Alice")
 *   - actorType='agent' → the agent's display name plus, when the agent
 *                          isn't owned by the local user, a parenthetical
 *                          owner suffix ("Made by Test Agent (Bob's)").
 *
 * Name resolution prefers cheap in-memory sources:
 *   1. Presence peers (already loaded by the awareness layer) carry
 *      `userName` for every live participant — zero network cost.
 *   2. The Loro `customActions` map indirectly identifies which agent
 *      member registered each action; for full agent labels we fall back
 *      to `/api/v1/agents` cached per-mount.
 *   3. Worst case: show the raw id (truncated) so the UI never blanks.
 */
import { useEffect, useState } from "react";
import { usePeerName } from "../PresenceAwarenessContext";
import betterAuthClient from "@clash/web-ui/lib/betterAuthClient";
import { runtimeApiUrl } from "@clash/web-ui/lib/runtimeConfig";
import { Tooltip } from "../ui/tooltip";

interface AgentLite {
  id: string;
  user_id: string;
  display_name: string;
}

// Module-scoped agent cache. Agent membership rarely changes during a
// session and the same handful of agents appear across every node;
// caching once per page load avoids N round-trips per render. Not a
// React state on purpose — components mounting later still see the
// fetched result. Refresh happens on full page reload.
let agentCachePromise: Promise<AgentLite[]> | null = null;
function loadAgentOnce(): Promise<AgentLite[]> {
  if (!agentCachePromise) {
    agentCachePromise = fetch(runtimeApiUrl("/api/v1/agents"), {
      credentials: "include",
    })
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((j) => (j as { agents?: AgentLite[] }).agents ?? [])
      .catch(() => []);
  }
  return agentCachePromise;
}

interface AttributionLineProps {
  actorType?: "user" | "agent";
  actorUserId?: string;
  actorAgentId?: string;
}

export default function AttributionLine({
  actorType,
  actorUserId,
  actorAgentId,
}: AttributionLineProps) {
  // Awareness peers carry userName for every live participant; using
  // them first means most of the time we never hit the network.
  const peerName = usePeerName(actorUserId);
  const session = betterAuthClient.useSession();
  const localUserId = session.data?.user?.id;
  const localUserName = session.data?.user?.name ?? session.data?.user?.email;

  const [agents, setAgents] = useState<AgentLite[]>([]);
  useEffect(() => {
    let cancelled = false;
    void loadAgentOnce().then((rows) => {
      if (!cancelled) setAgents(rows);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!actorType || !actorUserId) return null;

  // Resolve user display name.
  const resolveUserName = (uid: string): string => {
    if (uid === localUserId) return localUserName || "you";
    if (uid === actorUserId && peerName !== undefined) return peerName;
    return uid.slice(0, 8);
  };

  if (actorType === "user") {
    const name = resolveUserName(actorUserId);
    return (
      <Tooltip label={`actorUserId=${actorUserId}`}>
        <span className="text-[10px] text-slate-500 dark:text-slate-400">
          Made by {name}
        </span>
      </Tooltip>
    );
  }

  // actorType === 'agent'
  const agent = actorAgentId
    ? agents.find((c) => c.id === actorAgentId)
    : undefined;
  const agentName =
    agent?.display_name ?? (actorAgentId ? actorAgentId.slice(0, 8) : "agent");
  const ownerSuffix =
    actorUserId !== localUserId ? ` (${resolveUserName(actorUserId)}'s)` : "";
  return (
    <Tooltip label={`actorAgentId=${actorAgentId} actorUserId=${actorUserId}`}>
      <span className="text-[10px] text-slate-500 dark:text-slate-400">
        Made by {agentName}
        {ownerSuffix}
      </span>
    </Tooltip>
  );
}
