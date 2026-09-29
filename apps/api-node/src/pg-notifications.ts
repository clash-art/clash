import { Client, type ClientConfig } from "pg";
import { setTimeout as delay } from "node:timers/promises";
import type { GatewayNotificationSource } from "@clash/replica/replica-relay";
import { REPLICA_NOTIFICATION_CHANNEL } from "./replica-log.ts";
interface Notice {
  channel: string;
  payload?: string;
}
interface NotificationClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<unknown>;
  on(event: "notification", listener: (notice: Notice) => void): unknown;
  on(event: "error" | "end", listener: () => void): unknown;
  removeListener(event: "notification", listener: (notice: Notice) => void): unknown;
  removeListener(event: "error" | "end", listener: () => void): unknown;
}
/** One dedicated LISTEN connection per gateway process, independent of the query pool.
 * Reconcile AFTER LISTEN completes. Periodic gateway replay covers lost notifications. */
export function createPostgresNotificationSource(
  config: ClientConfig,
  factory: () => NotificationClient = () =>
    new Client({
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      ...config,
    }),
): GatewayNotificationSource {
  return {
    start(notify, reconnected) {
      const stop = new AbortController();
      const task = (async () => {
        while (!stop.signal.aborted) {
          const client = factory();
          let ended: () => void = () => {};
          const disconnected = new Promise<void>((resolve) => {
            ended = resolve;
          });
          const onNotice = (message: Notice) => {
            if (
              message.channel !== REPLICA_NOTIFICATION_CHANNEL ||
              !message.payload ||
              stop.signal.aborted
            )
              return;
            try {
              const event = JSON.parse(message.payload) as {
                projectId?: unknown;
                cursor?: unknown;
              };
              if (
                typeof event.projectId === "string" &&
                event.projectId.length > 0 &&
                event.projectId.length <= 256 &&
                typeof event.cursor === "number" &&
                Number.isSafeInteger(event.cursor) &&
                event.cursor > 0
              )
                void notify(event.projectId).catch(() => {});
            } catch {}
          };
          client.on("error", ended);
          client.on("end", ended);
          client.on("notification", onNotice);
          stop.signal.addEventListener("abort", ended, { once: true });
          try {
            await client.connect();
            if (stop.signal.aborted) break;
            await client.query(`LISTEN ${REPLICA_NOTIFICATION_CHANNEL}`);
            await reconnected();
            await disconnected;
          } catch {
            /* Reconnect below; log replay remains authoritative. */
          } finally {
            stop.signal.removeEventListener("abort", ended);
            client.removeListener("notification", onNotice);
            try {
              await client.end();
            } catch {}
            client.removeListener("end", ended);
            client.removeListener("error", ended);
          }
          if (!stop.signal.aborted) {
            try {
              await delay(1000, undefined, { signal: stop.signal });
            } catch {}
          }
        }
      })();
      return {
        async close() {
          stop.abort();
          await task;
        },
      };
    },
  };
}
