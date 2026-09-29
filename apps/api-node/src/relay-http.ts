import type { NodeAuth } from "./auth.ts";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import {
  readReplicaPage,
  replicaCursor,
  type GatewayNotificationSource,
} from "@clash/replica/replica-relay";
import { createProjectAuthenticator } from "@clash/shared-runtime/project-authorization";
import { createPostgresProjectAuthorizationStore } from "@clash/shared-runtime/project-authorization-postgres";
import type { PostgresTransactionPort } from "@clash/shared-runtime/project-cloud-admission-postgres";
import { createRelayStore } from "./relay-store.ts";

// Only the server interprets offsets; SDK consumers preserve the returned tokens.
const offset = (cursor: number) => String(cursor).padStart(16, "0");
function fromOffset(value: string) {
  if (value === "-1") return 0;
  if (!/^\d{16}$/.test(value)) throw Error("Invalid stream offset");
  return replicaCursor(value);
}
const records = (page: Awaited<ReturnType<typeof readReplicaPage>>) =>
  page.events.map((event) => ({
    id: event.id,
    update: Buffer.from(event.update).toString("base64"),
  }));

/** Authenticated SDK read/append/snapshot/SSE profile; not a general stream provisioning service. */
export function createReplicaHttpGateway(options: {
  db: PostgresTransactionPort;
  notifications?: GatewayNotificationSource;
  pollMs?: number;
  auth?: NodeAuth;
  publicUrl?: string;
}) {
  const app = new Hono();
  const auth = createProjectAuthenticator({
    store: createPostgresProjectAuthorizationStore(options.db),
    resolveSession: async (request) => {
      const session = await options.auth?.api.getSession({
        headers: request.headers,
      });
      return session
        ? {
            session: {
              id: session.session.id,
              expiresAt: session.session.expiresAt.getTime(),
            },
            user: { id: session.user.id, name: session.user.name },
          }
        : null;
    },
  });
  const subscriptions = new Map<string, Set<() => void>>();
  const closers = new Set<() => void>();
  let closed = false;
  const notify = async (id: string) => {
    for (const wake of subscriptions.get(id) ?? []) wake();
  };
  const reconcile = async () => {
    for (const id of subscriptions.keys()) await notify(id);
  };
  const listener = options.notifications?.start(notify, reconcile);
  const timer = setInterval(() => {
    void reconcile();
  }, options.pollMs ?? 1000);
  timer.unref();
  // Includes JSON/base64 envelope overhead; decoded updates retain the 8 MiB limit.
  app.use("*", bodyLimit({ maxSize: 12 * 1024 * 1024 }));
  app.all(
    "/api/v1/projects/:id/replica/:operation?/:snapshotOffset?",
    async (c) => {
      const id = c.req.param("id");
      const operation = c.req.param("operation") ?? "";
      c.header("cache-control", "no-store");
      try {
        const identity = await auth.authenticate(c.req.raw, id);
        if (
          identity.authorization.kind === "session" &&
          !["GET", "HEAD"].includes(c.req.method) &&
          (!options.publicUrl ||
            c.req.header("origin") !== new URL(options.publicUrl).origin)
        )
          return c.json({ error: "Forbidden origin" }, 403);
        async function allowed() {
          if (!(await auth.revalidate(identity))) return false;
          const { rows } = await options.db.query(
            `SELECT a.project_id FROM project_cloud_admission a JOIN project p ON p.id=a.project_id
           WHERE a.project_id=$1 AND a.user_id=$2 AND p.tenant_id=a.tenant_id AND a.status IN ('pending','syncing','ready') LIMIT 1`,
            [id, identity.userId],
          );
          return rows.length > 0;
        }
        if (!(await allowed()))
          return c.json({ error: "Project not found" }, 404);
        if (closed) return c.json({ error: "Gateway shutting down" }, 503);
        const store = createRelayStore(options.db, id);
        if (c.req.method === "HEAD" && operation === "") {
          const head = await store.head();
          const snapshot = await store.loadCheckpoint();
          if (!(await allowed())) return c.json({ error: "Unauthorized" }, 401);
          c.header("content-type", "application/json");
          c.header("stream-next-offset", offset(head));
          if (snapshot)
            c.header("stream-snapshot-offset", offset(snapshot.cursor));
          return c.body(null, 200);
        }
        if (c.req.method === "GET" && operation === "snapshot") {
          const snapshot = await store.loadCheckpoint();
          if (!snapshot) return c.notFound();
          if (!(await allowed())) return c.json({ error: "Unauthorized" }, 401);
          const requested = c.req.param("snapshotOffset");
          if (!requested)
            return c.redirect(`${c.req.path}/${offset(snapshot.cursor)}`, 307);
          if (requested !== offset(snapshot.cursor)) return c.notFound();
          return new Response(snapshot.data.slice().buffer, {
            headers: {
              "content-type": "application/octet-stream",
              "cache-control": "no-store",
              "stream-snapshot-offset": offset(snapshot.cursor),
              "stream-next-offset": offset(snapshot.cursor),
              "stream-up-to-date": String(
                snapshot.cursor === (await store.head()),
              ),
            },
          });
        }
        if (operation !== "") return c.notFound();
        if (c.req.method === "POST") {
          // These capabilities require additional durable producer state; never silently acknowledge them.
          if (
            [
              "producer-id",
              "producer-epoch",
              "producer-seq",
              "stream-closed",
              "stream-seq",
            ].some((name) => c.req.header(name) !== undefined)
          )
            return c.json(
              {
                error: "Producer sessions and stream lifecycle are unsupported",
              },
              400,
            );
          const key = c.req.header("idempotency-key");
          if (!key || key.length > 128)
            return c.json({ error: "Idempotency-Key required" }, 400);
          if (
            c.req.header("content-type")?.split(";")[0] !== "application/json"
          )
            return c.json({ error: "JSON record required" }, 415);
          let record: unknown;
          try {
            record = await c.req.json();
          } catch {
            return c.json({ error: "Invalid JSON" }, 400);
          }
          if (
            typeof record !== "object" ||
            record === null ||
            !("id" in record) ||
            !("update" in record) ||
            record.id !== key ||
            typeof record.update !== "string" ||
            Object.keys(record).some((key) => key !== "id" && key !== "update")
          )
            return c.json({ error: "Invalid replica record" }, 400);
          const bytes = Buffer.from(record.update, "base64");
          if (bytes.length > 8 * 1024 * 1024)
            return c.json({ error: "Update too large" }, 413);
          if (bytes.toString("base64") !== record.update)
            return c.json({ error: "Invalid replica bytes" }, 400);
          if (!(await allowed())) return c.json({ error: "Unauthorized" }, 401);
          try {
            const cursor = await store.append(key, bytes);
            await notify(id);
            c.header("stream-next-offset", offset(cursor));
            return c.body(null, 204);
          } catch (error) {
            if (
              error instanceof Error &&
              error.message.startsWith("Idempotency conflict")
            )
              return c.json({ error: "Idempotency conflict" }, 409);
            throw error;
          }
        }
        if (c.req.method !== "GET")
          return c.json({ error: "Unsupported stream operation" }, 405);
        if (c.req.query("offset") === undefined)
          return c.json({
            protocol: "loro-streams-v1",
            head: await store.head(),
          });
        let after: number;
        try {
          after =
            c.req.query("offset") === "now"
              ? await store.head()
              : fromOffset(c.req.query("offset")!);
        } catch {
          return c.json({ error: "Invalid offset" }, 400);
        }
        let initial;
        try {
          initial = await readReplicaPage(store, after);
        } catch (error) {
          if (error instanceof Error && error.message === "Replica log gap")
            return c.json({ error: "Snapshot required" }, 410);
          if (error instanceof Error && error.message === "Cursor beyond head")
            return c.json({ error: "Invalid offset" }, 409);
          throw error;
        }
        if (!(await allowed())) return c.json({ error: "Unauthorized" }, 401);
        if (!c.req.query("live")) {
          c.header("stream-next-offset", offset(initial.cursor));
          c.header(
            "stream-up-to-date",
            String(initial.cursor === initial.head),
          );
          return c.json(records(initial));
        }
        if (c.req.query("live") !== "sse")
          return c.json({ error: "Only SSE live mode is supported" }, 400);
        if (
          closers.size >= 1024 ||
          (!subscriptions.has(id) && subscriptions.size >= 128)
        )
          return c.json({ error: "Subscription capacity" }, 503);
        return streamSSE(c, async (stream) => {
          let stopped = false;
          let dirty = true;
          let wake: () => void = () => {};
          const signal = () => {
            dirty = true;
            wake();
          };
          const stop = () => {
            stopped = true;
            wake();
          };
          let set = subscriptions.get(id);
          if (!set) {
            set = new Set();
            subscriptions.set(id, set);
          }
          set.add(signal);
          closers.add(stop);
          stream.onAbort(stop);
          try {
            while (!stopped && !closed) {
              if (!dirty)
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
              dirty = false;
              if (stopped || closed || !(await allowed())) break;
              const page = await readReplicaPage(store, after);
              if (!(await allowed())) break;
              let deadline: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([
                  (async () => {
                    if (page.events.length)
                      await stream.writeSSE({
                        event: "data",
                        data: JSON.stringify(records(page)),
                      });
                    await stream.writeSSE({
                      event: "control",
                      data: JSON.stringify({
                        streamNextOffset: offset(page.cursor),
                        upToDate: page.cursor === page.head,
                      }),
                    });
                  })(),
                  new Promise<never>((_, reject) => {
                    deadline = setTimeout(
                      () => reject(Error("Slow subscriber")),
                      5000,
                    );
                  }),
                ]);
              } finally {
                clearTimeout(deadline);
              }
              after = page.cursor;
              if (after < page.head) dirty = true;
            }
          } finally {
            set.delete(signal);
            if (!set.size) subscriptions.delete(id);
            closers.delete(stop);
          }
        });
      } catch (error) {
        return c.json(
          { error: "Replica request failed" },
          error instanceof Error && error.message === "Unauthorized"
            ? 401
            : error instanceof Error && error.message === "Forbidden"
              ? 404
              : 503,
        );
      }
    },
  );
  return {
    app,
    notify,
    reconcile,
    async close() {
      closed = true;
      clearInterval(timer);
      for (const close of closers) close();
      await listener?.close();
    },
  };
}
