import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type SessionInfo,
} from "@agentclientprotocol/sdk";
import { NodeSpawner } from "./node-spawner.js";
import type { AgentSpec, Spawner } from "@openma/common/acp-runtime";

export interface AcpListedSession {
  id: string;
  title: string;
  cwd: string;
  modifiedAt: number;
}

export interface ListAgentSessionsOptions {
  agent: AgentSpec;
  cursor?: string | null;
}

function unixSeconds(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function toListedSession(session: SessionInfo): AcpListedSession {
  return {
    id: session.sessionId,
    title: session.title?.trim() ?? "",
    cwd: session.cwd,
    modifiedAt: unixSeconds(session.updatedAt),
  };
}

export async function listAgentSessions(
  spawner: Spawner,
  options: ListAgentSessionsOptions,
): Promise<AcpListedSession[]> {
  const child = await spawner.spawn(options.agent);
  try {
    const client: Client = {
      async sessionUpdate() {
        // `session/list` should not stream content. If an agent sends a
        // metadata update anyway, it is not part of the resume picker.
      },
      async requestPermission() {
        return { outcome: { outcome: "cancelled" } };
      },
    };
    const agent = new ClientSideConnection(() => client, ndJsonStream(child.stdin, child.stdout));
    const init = await agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    if (!init.agentCapabilities?.sessionCapabilities?.list || !agent.listSessions) {
      return [];
    }

    const response = await agent.listSessions({
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(options.agent.cwd ? { cwd: options.agent.cwd } : {}),
    });
    return response.sessions.map(toListedSession);
  } finally {
    await child.kill("SIGTERM").catch(() => undefined);
  }
}

export async function listLocalAgentSessions(agent: AgentSpec): Promise<AcpListedSession[]> {
  return listAgentSessions(new NodeSpawner(), { agent });
}
