/**
 * Cloudflare composition of the shared remote plugin output sessions
 * (`cloud-project-host/plugin-output-sessions.ts`): the shared import-session
 * token codec over JWT_SECRET, R2 staging with the multipart adapter, and D1
 * Project ownership. Begin and content requests are served under
 * `/assets/plugin-output/*`, where the signed grant is the only authority.
 *
 * `sealPluginOutputUpload` is the Durable Run stage half: it seals the run's
 * completed staging object as a tenant Resource. Publication then imports it
 * as the run's Project Asset together with the node output.
 */
import {
  ProjectAssetPublicationMetadataSchema,
  type AssetKind,
  type Resource,
} from "@clash/shared-types";
import type { DurableRunIdentity } from "@clash/shared-runtime/durable-run-engine";
import { GenerationPublicationConflict } from "@clash/shared-runtime/hosted-generation";
import { normalizeProjectAssetContentType } from "@clash/shared-runtime/cloud-project-host/project-assets";
import {
  createHmacProjectAssetImportSessionTokens,
  PROJECT_ASSET_IMPORT_STAGING_CLEANUP_FAILED,
} from "@clash/shared-runtime/cloud-project-host/project-asset-import-sessions";
import {
  createPluginOutputGrants,
  pluginOutputStagingLocator,
  readPluginOutputUpload,
  type PluginOutputSessionPorts,
} from "@clash/shared-runtime/cloud-project-host/plugin-output-sessions";

import type { Env } from "../config";
import { serverLog } from "../logger";
import { createD1ProjectAuthorizationStore } from "../loro/authorization-store";
import { createR2AssetDeliveryStore } from "../routes/asset-capability";
import { standaloneOrigin } from "./cloud-asset-delivery";
import { readEffectiveTenant, sealStagedResource } from "./project-asset-resources";
import { requireSecret } from "./require-secret";

/** Mounted by app-routes (routes/plugin-output-sessions.ts). */
const PLUGIN_OUTPUT_ROUTE_PREFIX = "/assets/plugin-output";

export function cloudPluginOutputSessionPorts(
  env: Env,
  now: () => number = Date.now,
): PluginOutputSessionPorts {
  const secret = requireSecret(
    env,
    "JWT_SECRET",
    env.JWT_SECRET,
    "dev-asset-delivery-secret",
  );
  const store = createR2AssetDeliveryStore(env.R2_BUCKET);
  const base = () =>
    `${standaloneOrigin(env).replace(/\/+$/, "")}${PLUGIN_OUTPUT_ROUTE_PREFIX}`;
  return {
    grants: createPluginOutputGrants({ secret, now }),
    sessions: {
      clock: { now },
      tokens: createHmacProjectAssetImportSessionTokens({ secret, now }),
      access: {
        async canAccessProject({ projectId, ownerId }) {
          const project = await createD1ProjectAuthorizationStore({
            DB: env.DB,
          }).readProject(projectId);
          return (
            !!project &&
            project.ownerId === ownerId &&
            project.deletedAt === null
          );
        },
      },
      staging: {
        store,
        delete: (locator) => env.R2_BUCKET.delete(locator),
      },
    },
    beginUrl: (grant) => `${base()}/${grant}`,
    contentUrl: (grant, sessionId) => `${base()}/${grant}/${sessionId}`,
  };
}

/** Whether `run`'s output session completed an upload into staging. */
export async function pluginOutputUploaded(
  env: Env,
  run: DurableRunIdentity,
): Promise<boolean> {
  return !!(await readPluginOutputUpload(run, {
    store: createR2AssetDeliveryStore(env.R2_BUCKET),
  }));
}

/**
 * After publication: staging is private transport. The node already shows
 * the published Asset, so a failed delete does not fail the run; it is
 * reported with the shared code and the import-staging sweep (same prefix)
 * removes the object later.
 */
export async function releasePluginOutputUpload(
  env: Env,
  run: DurableRunIdentity,
): Promise<void> {
  const locator = pluginOutputStagingLocator(run);
  try {
    await env.R2_BUCKET.delete(locator);
  } catch (error) {
    serverLog.error("project_asset_import_staging.cleanup_failed", {
      code: PROJECT_ASSET_IMPORT_STAGING_CLEANUP_FAILED,
      locator,
      error,
    });
  }
}

/**
 * Seal `run`'s completed upload as a tenant Resource. Staging stays until
 * publication succeeds, so a retried stage re-seals the same bytes into the
 * same first-wins Resource.
 */
export async function sealPluginOutputUpload(
  env: Env,
  input: {
    run: DurableRunIdentity;
    projectId: string;
    kind: AssetKind;
    mediaType?: string;
  },
): Promise<{ resource: Resource; metadata: Record<string, unknown> }> {
  const upload = await readPluginOutputUpload(input.run, {
    store: createR2AssetDeliveryStore(env.R2_BUCKET),
  });
  if (!upload)
    throw new Error(
      `Remote plugin output for run ${input.run.actionRunId} is missing from its upload session.`,
    );
  const tenantId = await readEffectiveTenant(env, input.projectId);
  if (!tenantId) throw new GenerationPublicationConflict("Project not found");
  const contentType = normalizeProjectAssetContentType({
    contentType: upload.contentType ?? input.mediaType,
    kind: input.kind,
  });
  const resource = await sealStagedResource(env, {
    projectId: input.projectId,
    tenantId,
    stagedKey: upload.locator,
    kind: input.kind,
    byteLength: upload.size,
    ...(contentType ? { contentType } : {}),
  });
  return {
    resource,
    metadata: ProjectAssetPublicationMetadataSchema.parse({
      bytes: upload.size,
      ...(contentType ? { contentType } : {}),
    }),
  };
}
