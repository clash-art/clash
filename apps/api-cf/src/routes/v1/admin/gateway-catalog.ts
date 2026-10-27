/**
 * Platform catalog and upstream accounts (#353), under /api/v1/admin/gateway:
 *
 *   GET    /catalog                                          versions, live one marked        catalog.read
 *   GET    /catalog/versions/:version                        models of one version            catalog.read
 *   POST   /catalog/versions/:version/clone                  new draft copying `from`         catalog.write
 *   POST   /catalog/versions/:version/seed                   AIGC/media-first launch draft    catalog.write
 *   PUT    /catalog/versions/:version/models/:modelCode      create/replace a draft model     catalog.write
 *   DELETE /catalog/versions/:version/models/:modelCode      remove a draft model             catalog.write
 *   POST   /catalog/versions/:version/publish                make the draft live              catalog.write
 *   GET    /upstreams                                        accounts (never secrets)         upstreams.read
 *   POST   /upstreams                                        create (secret write-only)       upstreams.write
 *   PATCH  /upstreams/:id                                    non-secret fields, disable       upstreams.write
 *   POST   /upstreams/:id/rotate                             add key vN+1 (previous drains)   upstreams.write
 *   POST   /upstreams/:id/revoke                             revoke one key version           upstreams.write
 */
import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../../../config";
import {
  GatewayCatalogCloneRequestSchema,
  GatewayCatalogModelRequestSchema,
  GatewayCatalogSeedRequestSchema,
  GatewayCatalogVersionSchema,
  GatewayModelCodeSchema,
  GatewayUpstreamCreateRequestSchema,
  GatewayUpstreamRevokeRequestSchema,
  GatewayUpstreamRotateRequestSchema,
  GatewayUpstreamUpdateRequestSchema,
} from "../../../domain/requests";
import { createD1CatalogAdmin } from "../../../gateway/d1-catalog-admin";
import { monotonicClock } from "../../../gateway/d1-common";
import { gatewayEncryptionKey, readSecretBinding } from "../../../gateway/d1-credentials";
import { createD1GatewayRoutesPort } from "../../../gateway/d1-routes";
import { createD1UpstreamAdmin } from "../../../gateway/d1-upstream-admin";
import { OFFICIAL_IDENTITY } from "../../../gateway/official-provider";
import { workersLogger } from "../../../gateway/workers-logger";
import { hostedBaseModelCards } from "../../../generation/hosted-model-cards";
import { gatewayParam, readGatewayJson } from "../../../services/gateway-admin";
import { adminJson as ok, platformRoute } from "../../../services/gateway-authz";

const AccountIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

export const adminCatalogRoutes = new Hono<{ Bindings: Env }>();

const catalog = (env: Env) => createD1CatalogAdmin(env.DB, { clock: monotonicClock() });
const upstreams = (env: Env) =>
  createD1UpstreamAdmin(env.DB, {
    clock: monotonicClock(),
    ...gatewayEncryptionKey(env),
    secret: (name) => readSecretBinding(env, name),
  });
const versionParam = (value: string | undefined) => gatewayParam(GatewayCatalogVersionSchema, value, "version");
const modelParam = (value: string | undefined) => gatewayParam(GatewayModelCodeSchema, value, "modelCode");

adminCatalogRoutes.get(
  "/catalog",
  platformRoute("catalog.read", async (c) => ok(c, { versions: await catalog(c.env).list() })),
);

adminCatalogRoutes.get(
  "/catalog/versions/:version",
  platformRoute("catalog.read", async (c) =>
    ok(c, { version: await catalog(c.env).read(versionParam(c.req.param("version"))) }),
  ),
);

adminCatalogRoutes.post(
  "/catalog/versions/:version/clone",
  platformRoute("catalog.write", async (c, actor) => {
    const version = versionParam(c.req.param("version"));
    const body = await readGatewayJson(c, GatewayCatalogCloneRequestSchema);
    return ok(c, { version: await catalog(c.env).cloneVersion({ version, from: body.from, actor }) }, 201);
  }),
);

adminCatalogRoutes.post(
  "/catalog/versions/:version/seed",
  platformRoute("catalog.write", async (c, actor) => {
    const version = versionParam(c.req.param("version"));
    const body = await readGatewayJson(c, GatewayCatalogSeedRequestSchema);
    // The official accounts as routing reads them: enabled ones, never their secrets.
    const routes = createD1GatewayRoutesPort(c.env.DB, { clock: monotonicClock(), logger: workersLogger() });
    const [cards, accounts] = await Promise.all([
      hostedBaseModelCards(),
      routes.providers(OFFICIAL_IDENTITY, "official"),
    ]);
    const seeded = await catalog(c.env).seedVersion({
      version,
      cards,
      accounts,
      ...(body.textModelCodes ? { textModelCodes: body.textModelCodes } : {}),
      actor,
    });
    return ok(c, seeded, 201);
  }),
);

adminCatalogRoutes.put(
  "/catalog/versions/:version/models/:modelCode",
  platformRoute("catalog.write", async (c, actor) => {
    const version = versionParam(c.req.param("version"));
    const modelCode = modelParam(c.req.param("modelCode"));
    const body = await readGatewayJson(c, GatewayCatalogModelRequestSchema);
    const model = await catalog(c.env).putModel({
      version,
      modelCode,
      card: body.card,
      enabled: body.enabled,
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.maxOutputTokens !== undefined ? { maxOutputTokens: body.maxOutputTokens } : {}),
      ...(body.rateLimit !== undefined ? { rateLimit: body.rateLimit } : {}),
      actor,
    });
    return ok(c, { model });
  }),
);

adminCatalogRoutes.delete(
  "/catalog/versions/:version/models/:modelCode",
  platformRoute("catalog.write", async (c, actor) => {
    const version = versionParam(c.req.param("version"));
    const modelCode = modelParam(c.req.param("modelCode"));
    await catalog(c.env).removeModel({ version, modelCode, actor });
    return ok(c, { removed: true });
  }),
);

adminCatalogRoutes.post(
  "/catalog/versions/:version/publish",
  platformRoute("catalog.write", async (c, actor) =>
    ok(c, { version: await catalog(c.env).publish({ version: versionParam(c.req.param("version")), actor }) }),
  ),
);

adminCatalogRoutes.get(
  "/upstreams",
  platformRoute("upstreams.read", async (c) => ok(c, { upstreams: await upstreams(c.env).list() })),
);

adminCatalogRoutes.post(
  "/upstreams",
  platformRoute("upstreams.write", async (c, actor) => {
    const body = await readGatewayJson(c, GatewayUpstreamCreateRequestSchema);
    return ok(c, { upstream: await upstreams(c.env).create({ ...body, actor }) }, 201);
  }),
);

adminCatalogRoutes.patch(
  "/upstreams/:id",
  platformRoute("upstreams.write", async (c, actor) => {
    const id = gatewayParam(AccountIdSchema, c.req.param("id"), "id");
    const body = await readGatewayJson(c, GatewayUpstreamUpdateRequestSchema);
    return ok(c, { upstream: await upstreams(c.env).update(id, body, actor) });
  }),
);

adminCatalogRoutes.post(
  "/upstreams/:id/rotate",
  platformRoute("upstreams.write", async (c, actor) => {
    const id = gatewayParam(AccountIdSchema, c.req.param("id"), "id");
    const body = await readGatewayJson(c, GatewayUpstreamRotateRequestSchema);
    return ok(c, {
      upstream: await upstreams(c.env).rotate(id, {
        credential: body.credential,
        ...(body.drain !== undefined ? { drain: body.drain } : {}),
        ...(body.reason ? { reason: body.reason } : {}),
        actor,
      }),
    });
  }),
);

adminCatalogRoutes.post(
  "/upstreams/:id/revoke",
  platformRoute("upstreams.write", async (c, actor) => {
    const id = gatewayParam(AccountIdSchema, c.req.param("id"), "id");
    const body = await readGatewayJson(c, GatewayUpstreamRevokeRequestSchema);
    return ok(c, {
      upstream: await upstreams(c.env).revokeKey(id, {
        keyVersion: body.keyVersion,
        ...(body.reason ? { reason: body.reason } : {}),
        actor,
      }),
    });
  }),
);
