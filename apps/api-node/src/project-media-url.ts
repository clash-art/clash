/**
 * Short-lived signed URLs for one Project Asset's bytes, so apps/render-server
 * can fetch Timeline media without a user credential.
 *
 * The signature is the shared capability helper keyed by BETTER_AUTH_SECRET
 * and domain-separated from every other use of that secret. A URL names one
 * Project and one Asset; the route serves only that Asset's stored bytes
 * (with Range support) and nothing else. Only the render worker mints these,
 * after the render run was admitted for the Project owner.
 */
import { resolve } from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { readProjectAsset } from "@clash/shared-types";
import {
  importCapabilityKey,
  signCapability,
  verifyCapability,
} from "@clash/shared-runtime/signed-capability";
import type { PostgresTransactionPort } from "@clash/shared-runtime/project-cloud-admission-postgres";
import { serveStoredMedia } from "./media-store.ts";
import { readProjectResource } from "./project-assets.ts";
import { withProjectDocument } from "./project-document.ts";

export const PROJECT_MEDIA_URL_DOMAIN = "clash-node-media-v1:";
export const PROJECT_MEDIA_URL_TTL_SECONDS = 3600;
/** Mounted outside `/api`: the signature, not a session, is the authority. */
export const PROJECT_MEDIA_URL_PREFIX = "/assets/project-media";

const subject = (projectId: string, assetId: string) =>
  `${encodeURIComponent(projectId)}/${encodeURIComponent(assetId)}`;

export async function signProjectMediaUrl(input: {
  secret: string;
  publicUrl: string;
  projectId: string;
  assetId: string;
  now?: number;
}): Promise<string> {
  const exp =
    Math.floor((input.now ?? Date.now()) / 1000) +
    PROJECT_MEDIA_URL_TTL_SECONDS;
  const path = subject(input.projectId, input.assetId);
  const sig = await signCapability(
    await importCapabilityKey(input.secret),
    path,
    exp,
    PROJECT_MEDIA_URL_DOMAIN,
  );
  return `${input.publicUrl.replace(/\/+$/u, "")}${PROJECT_MEDIA_URL_PREFIX}/${path}?exp=${exp}&sig=${sig}`;
}

export function createSignedProjectMediaRoutes(options: {
  db: PostgresTransactionPort;
  directory: string;
  secret: string;
  now?: () => number;
}) {
  const app = new Hono();
  const directory = resolve(options.directory);
  let key: Promise<CryptoKey> | undefined;
  app.get("/:projectId/:assetId", async (c) => {
    c.header("Cache-Control", "private, no-store");
    // Same as the Cloudflare signed /assets routes: the signature is the only
    // authority (no cookies), so any origin may read it. render-server's
    // headless browser fetches media cross-origin from its page.
    c.header("Access-Control-Allow-Origin", "*");
    const projectId = c.req.param("projectId"),
      assetId = c.req.param("assetId");
    const exp = c.req.query("exp") ?? "";
    const sig = c.req.query("sig") ?? "";
    if (!/^\d{1,12}$/u.test(exp) || !sig)
      return c.json({ error: "Invalid media signature" }, 403);
    if (Number(exp) * 1000 <= (options.now ?? Date.now)())
      return c.json({ error: "Media URL expired" }, 403);
    if (
      !(await verifyCapability(
        await (key ??= importCapabilityKey(options.secret)),
        subject(projectId, assetId),
        Number(exp),
        sig,
        PROJECT_MEDIA_URL_DOMAIN,
      ))
    )
      return c.json({ error: "Invalid media signature" }, 403);
    // The capability stands in for the owner's session; reads go through the
    // same owner-scoped Project document as authenticated media.
    const project = await options.db.query<{ owner_id: string }>(
      "SELECT owner_id FROM project WHERE id=$1 AND deleted_at IS NULL",
      [projectId],
    );
    const owner = project.rows[0]?.owner_id;
    if (!owner) return c.json({ error: "Asset not found" }, 404);
    const entry = await withProjectDocument(
      options.db,
      owner,
      projectId,
      false,
      (doc) => readProjectAsset(doc, assetId, { projectId }),
    );
    if (!entry || entry.lifecycle.state !== "active")
      return c.json({ error: "Asset not found" }, 404);
    const resource = await readProjectResource(
      options.db,
      projectId,
      entry.source.resourceId,
    );
    if (!resource) return c.json({ error: "Media unavailable" }, 404);
    return serveStoredMedia(c, directory, resource);
  });
  app.onError((error, c) => {
    if (error instanceof HTTPException)
      return c.json({ error: error.message }, error.status);
    if (error.message === "Project not found")
      return c.json({ error: "Asset not found" }, 404);
    return c.json({ error: "Project media unavailable" }, 503);
  });
  return app;
}
