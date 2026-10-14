import type { PresenceClient } from "@clash/shared-types";

/** Hides only this connection. The same user's other devices, windows and
 * agents stay visible as peers. */
export function visiblePresenceClients(
  clients: PresenceClient[],
  selfClientId: string | undefined,
): PresenceClient[] {
  return clients.filter((client) => client.id !== selfClientId);
}
