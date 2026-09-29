import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { createPostgresNotificationSource } from "./pg-notifications.ts";
it("reconciles after LISTEN and reconnects while ignoring malformed notices", async () => {
  const sessions: EventEmitter[] = [];
  const source = createPostgresNotificationSource(
    { connectionString: "unused" },
    () => {
      const events = new EventEmitter();
      sessions.push(events);
      return {
        on: events.on.bind(events),
        removeListener: events.removeListener.bind(events),
        connect: async () => {},
        query: async () => {},
        end: async () => {},
      };
    },
  );
  const notices: string[] = [];
  const reconciled: string[] = [];
  const running = source.start(
    async (id) => {
      notices.push(id);
    },
    async () => {
      reconciled.push("ready");
    },
  );
  try {
    await expect.poll(() => reconciled).toEqual(["ready"]);
    sessions[0]!.emit("notification", {
      channel: "clash_replica_events",
      payload: "not json",
    });
    sessions[0]!.emit("notification", {
      channel: "clash_replica_events",
      payload: JSON.stringify({ projectId: "p", cursor: 1 }),
    });
    await expect.poll(() => notices).toEqual(["p"]);
    sessions[0]!.emit("end");
    await expect
      .poll(() => reconciled, { timeout: 4000 })
      .toEqual(["ready", "ready"]);
    sessions[1]!.emit("notification", {
      channel: "clash_replica_events",
      payload: JSON.stringify({ projectId: "q", cursor: 2 }),
    });
    await expect.poll(() => notices).toEqual(["p", "q"]);
  } finally {
    await running.close();
  }
});
