/**
 * Worker-side sealing of Project Asset bytes into the tenant's immutable R2
 * Resource registry. Shared by the Project Asset import routes and the hosted
 * Timeline render publication, so both seal one Resource fact the same way;
 * the document commit itself runs in ProjectRoom (`project-asset-room.ts`).
 */
import type { AssetKind, Resource } from "@clash/shared-types";
import type { Env } from "../config";
import {
  createR2ResourceRegistry,
  resourceLocator,
} from "./project-content-cloud";

export function digestHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function resourceFor(input: {
  digest: string;
  kind: AssetKind;
  byteLength: number;
  contentType?: string;
}): Resource {
  return {
    id: `sha256:${input.digest}`,
    kind: input.kind,
    digest: { algorithm: "sha256", value: input.digest },
    byteLength: input.byteLength,
    ...(input.contentType ? { contentType: input.contentType } : {}),
  };
}

/** `tenant_id`, or `personal:<owner>` before one is pinned; null for a missing or deleted Project. */
export async function readEffectiveTenant(
  env: Env,
  projectId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(tenant_id, 'personal:' || owner_id) AS tenant_id FROM project WHERE id = ? AND deleted_at IS NULL LIMIT 1",
  )
    .bind(projectId)
    .first<{ tenant_id: string | null }>();
  return row?.tenant_id ?? null;
}

/** Pins the Project's effective tenant before a Resource is claimed under it. */
export async function persistTenant(env: Env, projectId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE project SET tenant_id = COALESCE(tenant_id, 'personal:' || owner_id) WHERE id = ?",
  )
    .bind(projectId)
    .run();
}

export async function claimResource(
  env: Env,
  tenantId: string,
  resource: Resource,
): Promise<Resource> {
  const registry = createR2ResourceRegistry(env.R2_BUCKET as never);
  return (await registry(tenantId, resource.id, resource)) ?? resource;
}

export async function placeContent(
  env: Env,
  tenantId: string,
  stagedKey: string,
  resource: Resource,
): Promise<void> {
  const contentKey = await resourceLocator(tenantId, resource);
  const existing = await env.R2_BUCKET.head(contentKey);
  if (existing?.size === resource.byteLength) return;
  const staged = await env.R2_BUCKET.get(stagedKey);
  if (!staged) throw new Error("Staged Project Asset bytes are missing");
  await env.R2_BUCKET.put(
    contentKey,
    staged.body,
    resource.contentType
      ? { httpMetadata: { contentType: resource.contentType } }
      : undefined,
  );
}

/**
 * Digest bytes already in R2 at `stagedKey`, claim their Resource for the
 * Project's tenant and place them at the Resource locator. Re-sealing the
 * same bytes returns the same Resource (first immutable fact wins).
 */
export async function sealStagedResource(
  env: Env,
  input: {
    projectId: string;
    tenantId: string;
    stagedKey: string;
    kind: AssetKind;
    byteLength: number;
    contentType?: string;
  },
): Promise<Resource> {
  const object = await env.R2_BUCKET.get(input.stagedKey);
  if (!object) throw new Error("Staged Project Asset bytes are missing");
  const digestStream = new crypto.DigestStream("SHA-256");
  await object.body.pipeTo(digestStream);
  const resource = resourceFor({
    digest: digestHex(await digestStream.digest),
    kind: input.kind,
    byteLength: input.byteLength,
    ...(input.contentType ? { contentType: input.contentType } : {}),
  });
  await persistTenant(env, input.projectId);
  const claimed = await claimResource(env, input.tenantId, resource);
  await placeContent(env, input.tenantId, input.stagedKey, claimed);
  return claimed;
}
