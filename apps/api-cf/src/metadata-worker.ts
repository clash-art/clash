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
}

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
      const service = createMetadataService(createCloudflareMetadataPorts(env, defer));
      const response = await service.handle(clean);
      if (response) return response;
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  };
}

export default createMetadataWorker();
