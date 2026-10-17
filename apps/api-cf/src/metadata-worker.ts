/**
 * clash-meta: lean Project metadata Worker (issue #138).
 *
 * Composition root only: Cloudflare adapters (./services/metadata-cloud)
 * wired into the platform-agnostic `@clash/metadata-service`. It imports no
 * better-auth, no ORM, no shared-types barrel, no Loro and no AI SDK, and
 * exports no Durable Object. ROOM binds api-cf's ProjectRoom by script_name
 * (card previews read canvas nodes). Requests the service defers (a Better
 * Auth session due for its sliding refresh) go to api-cf via API_CF, which
 * serves the same routes in-process.
 */
import { createMetadataService } from "@clash/metadata-service";
import { createCloudflareMetadataPorts, type MetadataCloudEnv } from "./services/metadata-cloud";

export interface MetadataWorkerEnv extends MetadataCloudEnv {
  API_CF?: { fetch(request: Request): Promise<Response> };
  /**
   * "auto" = serve GETs through a D1 Sessions API session that may read a
   * nearby read replica (issue #139). Needs read replication enabled on the
   * database; without it the session simply reads the primary.
   */
  D1_READ_REPLICAS?: string;
}

/** Statuses a lagging replica can produce for data that exists on the primary. */
const PRIMARY_RETRY = new Set([401, 403, 404]);

export function createMetadataWorker() {
  return {
    async fetch(request: Request, env: MetadataWorkerEnv): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (path === "/health")
        return Response.json({ status: "ok", service: "clash-meta" });
      // Caller identity is always derived here, never trusted from headers.
      const clean = new Request(request);
      clean.headers.delete("x-user-id");
      const defer = env.API_CF ? (r: Request) => env.API_CF!.fetch(r) : undefined;
      const serve = async (db: MetadataCloudEnv["DB"], req: Request) => {
        const ports = createCloudflareMetadataPorts({ ...env, DB: db }, defer);
        return (
          (await createMetadataService(ports).handle(req)) ??
          Response.json({ error: "not_found" }, { status: 404 })
        );
      };
      if (env.D1_READ_REPLICAS === "auto" && request.method === "GET" && typeof env.DB.withSession === "function") {
        // Reads only: a replica may lag the primary. A just-created session,
        // token or project would then look missing, so any auth/not-found
        // answer is re-checked against the primary before it is returned.
        const replica = env.DB.withSession("first-unconstrained") as unknown as D1Database;
        const response = await serve(replica, new Request(clean));
        if (!PRIMARY_RETRY.has(response.status)) return response;
      }
      return serve(env.DB, clean);
    },
  };
}

export default createMetadataWorker();
