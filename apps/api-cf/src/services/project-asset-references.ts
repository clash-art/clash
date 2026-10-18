/**
 * Cloudflare binding of the shared ProjectAssetReferenceResolver.
 *
 * A Project Asset is read from ProjectRoom (the live document inside the DO,
 * the internal `assets-get` read elsewhere), its committed Resource from the
 * tenant's R2 registry, and its URL is the same signed Resource capability
 * the Project Asset routes issue for project media. Remote plugin references
 * and server-side Timeline render both resolve through this one module.
 *
 * An id with no Project Asset may still name a generation output this
 * deployment published to the D1 `assets` library (the legacy projection of
 * hosted generation); only then is that library row, owned by the Project
 * owner, signed instead. A trashed or uncommitted Project Asset never falls
 * through to it.
 */
import type { LoroDoc } from "loro-crdt";
import { executableFailureFromThrown } from "@clash/action-sdk/executable-failure";
import { readProjectAsset, type ProjectAssetEntry } from "@clash/shared-types";
import {
  createProjectAssetReferenceResolver,
  resolveTimelineMediaReferences,
  type ProjectAssetReferenceResolver,
  type ProjectAssetReferenceTarget,
  type TimelineMediaReferenceOptions,
} from "@clash/shared-runtime/cloud-project-host/project-asset-references";

import type { Env } from "../config";
import { getAssetsByIds } from "./assets";
import { signAssetPath, SIGNED_URL_TTL } from "./asset-signing";
import { createCloudAssetDeliveryPort } from "./cloud-asset-delivery";
import { readEffectiveTenant } from "./project-asset-resources";
import {
  createR2ResourceRegistry,
  resourceLocator,
} from "./project-content-cloud";

export type ProjectAssetReader = (
  target: ProjectAssetReferenceTarget,
) => Promise<ProjectAssetEntry | null>;

/** Inside ProjectRoom: read the live document. */
export function docProjectAssetReader(doc: LoroDoc): ProjectAssetReader {
  return async ({ projectId, assetId }) =>
    readProjectAsset(doc, assetId, { projectId }) ?? null;
}

/** Outside ProjectRoom (Workflow, routes): the room's internal `assets-get` read. */
export function roomProjectAssetReader(env: Env): ProjectAssetReader {
  return async ({ projectId, assetId }) => {
    const response = await env.ROOM.get(env.ROOM.idFromName(projectId)).fetch(
      new Request(
        `http://internal/loro/${encodeURIComponent(projectId)}/assets-get?${new URLSearchParams({ assetId })}`,
        {
          headers: {
            "x-internal-loro": "true",
            "x-loro-project-id": projectId,
          },
        },
      ),
    );
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Project Asset read failed: HTTP ${response.status}`);
    }
    return ((await response.json()) as { entry: ProjectAssetEntry }).entry;
  };
}

/** Absolute origin for signed `/assets/<key>` library URLs. */
function libraryMediaBase(env: Env): string {
  const base =
    env.MEDIA_GATEWAY_URL ||
    env.WORKER_PUBLIC_URL ||
    (env.ENVIRONMENT === "development" ? "http://localhost:3000" : undefined);
  if (!base)
    throw new Error(
      "MEDIA_GATEWAY_URL or WORKER_PUBLIC_URL must be set to sign media for a remote consumer.",
    );
  return base.replace(/\/+$/, "");
}

export function createCloudProjectAssetReferenceResolver(
  env: Env,
  options: {
    readAsset: ProjectAssetReader;
    /** Owner of the Project; library rows are only signed for their owner. */
    libraryOwnerId: string;
  },
): ProjectAssetReferenceResolver {
  const tenants = new Map<string, Promise<string | null>>();
  const tenantOf = (projectId: string) => {
    let tenant = tenants.get(projectId);
    if (!tenant) {
      tenant = readEffectiveTenant(env, projectId);
      tenants.set(projectId, tenant);
    }
    return tenant;
  };
  const registry = createR2ResourceRegistry(env.R2_BUCKET as never);
  // Ownership was established by the caller; the capability resolver
  // re-checks the live Project and reference when the URL is consumed.
  const delivery = createCloudAssetDeliveryPort(env, {
    authorize: async () => true,
  });
  const projectAssets = createProjectAssetReferenceResolver({
    readAsset: options.readAsset,
    async readCommittedResource({ projectId }, entry) {
      const tenantId = await tenantOf(projectId);
      if (!tenantId) return null;
      const resource = await registry(tenantId, entry.source.resourceId);
      if (!resource || resource.kind !== entry.kind) return null;
      const stored = await env.R2_BUCKET.head(
        await resourceLocator(tenantId, resource),
      );
      return stored?.size === resource.byteLength ? resource : null;
    },
    async sign({ target, resource }) {
      const tenantId = await tenantOf(target.projectId);
      if (!tenantId) throw new Error("Project not found");
      const capability = await delivery.issueReadUrl({
        resourceId: resource.id,
        scope: { tenantId, projectId: target.projectId },
        purpose: "preview",
      });
      return { url: capability.url, expiresAt: capability.expiresAt };
    },
  });
  return {
    async resolve(target) {
      const resolved = await projectAssets.resolve(target);
      if (resolved.ok || resolved.reason !== "missing") return resolved;
      const [row] = await getAssetsByIds(
        env.DB,
        [target.assetId],
        options.libraryOwnerId,
      );
      if (!row) return resolved;
      const expiresAt = new Date(
        (Math.floor(Date.now() / 1000) + SIGNED_URL_TTL) * 1000,
      ).toISOString();
      const { width, height, contentType } = row.metadata ?? {};
      return {
        ok: true,
        reference: {
          assetId: row.id,
          kind: row.kind,
          url: `${libraryMediaBase(env)}${await signAssetPath(env, row.srcR2Key, SIGNED_URL_TTL)}`,
          expiresAt,
          ...(contentType ? { contentType } : {}),
          ...(width ? { width } : {}),
          ...(height ? { height } : {}),
        },
      };
    },
  };
}

/**
 * ProjectRoom's server-side Timeline render: every media item resolved
 * against the room's live document, or the structured failure the caller
 * projects onto the render node. Nothing here leaves a node `generating`.
 */
export async function resolveCloudTimelineMedia(
  env: Env,
  input: {
    doc: LoroDoc;
    projectId: string;
    actorUserId: string;
    timelineDsl: Record<string, unknown>;
  } & Pick<TimelineMediaReferenceOptions, "assetIdOf" | "typeOf" | "decorate">,
): Promise<
  | { ok: true; timelineDsl: Record<string, unknown> }
  | { ok: false; failure: { code: string; message: string } }
> {
  try {
    return {
      ok: true,
      timelineDsl: await resolveTimelineMediaReferences(input.timelineDsl, {
        projectId: input.projectId,
        references: createCloudProjectAssetReferenceResolver(env, {
          readAsset: docProjectAssetReader(input.doc),
          libraryOwnerId: input.actorUserId,
        }),
        assetIdOf: input.assetIdOf,
        ...(input.typeOf ? { typeOf: input.typeOf } : {}),
        ...(input.decorate ? { decorate: input.decorate } : {}),
      }),
    };
  } catch (error) {
    const { code, message } = executableFailureFromThrown(error, "submit");
    return { ok: false, failure: { code, message } };
  }
}
