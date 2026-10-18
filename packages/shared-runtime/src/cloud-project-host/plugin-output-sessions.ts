/**
 * Run-scoped output upload sessions for remote (third-party) plugins.
 *
 * A remote plugin cannot mint a Project Asset and its response is capped at
 * 1 MiB, so it cannot return media bytes inline. For each media output the
 * Host issues a capability whose begin URL opens a chunked Project Asset
 * import session through the shared import-session module — the same token,
 * staging and multipart protocol the Asset SDK drives — bound to one durable
 * run output:
 *
 *   POST <beginUrl>  { byteLength, contentType?, fileName? }
 *     → 201 { sessionId, upload: { url } }       (shared createProjectAssetImportSession)
 *   PUT  upload.url?upload=begin|part|complete    (shared multipart protocol)
 *
 * The Asset id is pre-assigned from the durable key, so every attempt of one
 * run targets the same id and the same staging object; a retry never makes a
 * second Asset. The plugin never finalizes: the Host accepts the plugin's
 * asset answer only when this run's staged upload completed, then commits and
 * publishes it through its own Durable Run stage/publication path, keyed by
 * the run. Capabilities are built per invocation and never journaled.
 */
import type { AssetKind } from "@clash/shared-types";
import { PROJECT_ASSET_IMPORT_MAX_BYTES } from "@clash/asset-sdk";

import {
  durableRunIdempotencyKey,
  type DurableRunIdentity,
} from "../durable-run-engine.js";
import type { RemotePluginOutputCapability } from "../executable-plugin-remote.js";
import { sha256Hex } from "../sha256-hex.js";
import {
  importCapabilityKey,
  signCapability,
  verifyCapability,
} from "../signed-capability.js";
import {
  createProjectAssetImportSession,
  handleProjectAssetImportSessionContent,
  PROJECT_ASSET_IMPORT_SESSION_TTL_MS,
  PROJECT_ASSET_IMPORT_STAGING_PREFIX,
  type ProjectAssetImportSessionPorts,
  type ProjectAssetImportSessionResult,
} from "./project-asset-import-sessions.js";

const GRANT_DOMAIN = "clash-plugin-output-v1:";
const KINDS = new Set<AssetKind>(["image", "video", "audio", "model"]);

/** What a begin URL authorizes: one import session for one durable run output. */
export interface PluginOutputGrant {
  version: 1;
  ownerId: string;
  projectId: string;
  actionRunId: string;
  outputSlot: string;
  kind: AssetKind;
  expiresAt: string;
}

export interface PluginOutputGrantCodec {
  sign(grant: PluginOutputGrant): Promise<string>;
  verify(token: string): Promise<PluginOutputGrant | null>;
}

export interface PluginOutputSessionPorts {
  grants: PluginOutputGrantCodec;
  /** The adapter's existing import-session ports (token codec, access, staging). */
  sessions: Pick<
    ProjectAssetImportSessionPorts,
    "clock" | "tokens" | "access" | "staging"
  >;
  /** Absolute URL that opens a session for `grant`. */
  beginUrl(grant: string): string;
  /** Absolute multipart URL for one session opened under `grant`. */
  contentUrl(grant: string, sessionId: string): string;
}

const runDigest = (run: DurableRunIdentity) =>
  sha256Hex(durableRunIdempotencyKey(run));

/** The Project Asset id every attempt of `run` publishes its media output under. */
export function pluginOutputAssetId(run: DurableRunIdentity): string {
  return `plugin-output-${runDigest(run).slice(0, 32)}`;
}

const stagingSuffix = (run: DurableRunIdentity) =>
  `plugin-output-${runDigest(run)}`;

/** The private staging object a completed upload for `run` lands in. */
export function pluginOutputStagingLocator(run: DurableRunIdentity): string {
  return `${PROJECT_ASSET_IMPORT_STAGING_PREFIX}${stagingSuffix(run)}`;
}

const grantRun = (grant: PluginOutputGrant): DurableRunIdentity => ({
  actionRunId: grant.actionRunId,
  outputSlot: grant.outputSlot,
});

function toBase64Url(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function parseGrant(value: unknown): PluginOutputGrant | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !text(record.ownerId) ||
    !text(record.projectId) ||
    !text(record.actionRunId) ||
    !text(record.outputSlot) ||
    !KINDS.has(record.kind as AssetKind) ||
    !text(record.expiresAt) ||
    !Number.isFinite(Date.parse(record.expiresAt))
  )
    return null;
  return {
    version: 1,
    ownerId: record.ownerId,
    projectId: record.projectId,
    actionRunId: record.actionRunId,
    outputSlot: record.outputSlot,
    kind: record.kind as AssetKind,
    expiresAt: record.expiresAt,
  };
}

/** HMAC grant tokens over the shared capability helper, domain-separated from every other use of the secret. */
export function createPluginOutputGrants(options: {
  secret: string;
  now(): number;
}): PluginOutputGrantCodec {
  let key: Promise<CryptoKey> | undefined;
  const keyOf = () => (key ??= importCapabilityKey(options.secret));
  const exp = (grant: PluginOutputGrant) =>
    Math.floor(Date.parse(grant.expiresAt) / 1000);
  return {
    async sign(grant) {
      if (Date.parse(grant.expiresAt) <= options.now())
        throw new Error("Plugin output grant expiry must be in the future.");
      const payload = toBase64Url(JSON.stringify(grant));
      return `${payload}.${await signCapability(await keyOf(), payload, exp(grant), GRANT_DOMAIN)}`;
    },
    async verify(token) {
      const parts = token.split(".");
      if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
      const [payload, signature] = parts as [string, string];
      let grant: PluginOutputGrant | null;
      try {
        grant = parseGrant(JSON.parse(fromBase64Url(payload)));
      } catch {
        return null;
      }
      if (
        !grant ||
        !(await verifyCapability(
          await keyOf(),
          payload,
          exp(grant),
          signature,
          GRANT_DOMAIN,
        )) ||
        Date.parse(grant.expiresAt) <= options.now()
      )
        return null;
      return grant;
    },
  };
}

/**
 * The upload capabilities for one invocation: one per plugin-side slot name
 * the run accepts. The names alias one durable output, so all of them carry
 * the same pre-assigned Asset id and the same grant.
 */
export async function issuePluginOutputCapabilities(
  input: {
    run: DurableRunIdentity;
    ownerId: string;
    projectId: string;
    kind: AssetKind;
    slots: readonly string[];
  },
  ports: Pick<PluginOutputSessionPorts, "grants" | "beginUrl" | "sessions">,
): Promise<RemotePluginOutputCapability[]> {
  if (input.slots.length === 0) return [];
  const expiresAt = new Date(
    ports.sessions.clock.now() + PROJECT_ASSET_IMPORT_SESSION_TTL_MS,
  ).toISOString();
  const grant = await ports.grants.sign({
    version: 1,
    ownerId: input.ownerId,
    projectId: input.projectId,
    actionRunId: input.run.actionRunId,
    outputSlot: input.run.outputSlot,
    kind: input.kind,
    expiresAt,
  });
  const assetId = pluginOutputAssetId(input.run);
  return input.slots.map((slot) => ({
    slot,
    asset: { assetId, uri: `clash-asset://${assetId}`, kind: input.kind },
    upload: {
      beginUrl: ports.beginUrl(grant),
      expiresAt,
      maxBytes: PROJECT_ASSET_IMPORT_MAX_BYTES,
    },
  }));
}

const invalidGrant = {
  status: 403 as const,
  body: { error: "Invalid plugin output grant" },
};

/**
 * `POST <beginUrl>`: open the run's import session. Owner, Project, kind and
 * Asset id come from the grant, never from the plugin; the staging object is
 * the run's own, so a repeated begin replaces rather than duplicates it.
 */
export async function beginPluginOutputSession(
  input: { grant: string; body: unknown },
  ports: PluginOutputSessionPorts,
): Promise<ProjectAssetImportSessionResult> {
  const grant = await ports.grants.verify(input.grant);
  if (!grant) return invalidGrant;
  const run = grantRun(grant);
  const body =
    input.body && typeof input.body === "object" && !Array.isArray(input.body)
      ? (input.body as Record<string, unknown>)
      : {};
  return createProjectAssetImportSession(
    {
      projectId: grant.projectId,
      ownerId: grant.ownerId,
      body: {
        kind: grant.kind,
        projectAssetId: pluginOutputAssetId(run),
        fileName: text(body.fileName) ? body.fileName : `${grant.kind}-output`,
        byteLength: body.byteLength,
        ...(typeof body.contentType === "string"
          ? { contentType: body.contentType }
          : {}),
        // A plugin may legitimately return bytes the Project already holds.
        duplicateContent: "allow",
      },
    },
    {
      ...ports.sessions,
      newId: () => stagingSuffix(run),
      uploadUrl: (sessionId) => ports.contentUrl(input.grant, sessionId),
    },
  );
}

/** `PUT <upload.url>`: the shared multipart protocol, for a session of this grant only. */
export async function handlePluginOutputSessionContent(
  request: Request,
  input: { grant: string; sessionId: string },
  ports: PluginOutputSessionPorts,
): Promise<Response> {
  const grant = await ports.grants.verify(input.grant);
  if (!grant) return Response.json(invalidGrant.body, { status: 403 });
  const run = grantRun(grant);
  const claims = await ports.sessions.tokens.verify(input.sessionId);
  if (
    !claims ||
    claims.stagingLocator !== pluginOutputStagingLocator(run) ||
    claims.projectAssetId !== pluginOutputAssetId(run)
  )
    return Response.json(
      { error: "Import session does not belong to this plugin output" },
      { status: 403 },
    );
  return handleProjectAssetImportSessionContent(
    request,
    {
      projectId: grant.projectId,
      sessionId: input.sessionId,
      ownerId: grant.ownerId,
    },
    ports.sessions,
  );
}

/**
 * The completed upload for `run`, or undefined. Staged bytes become visible
 * only when the multipart `complete` verified the session's exact length.
 */
export async function readPluginOutputUpload(
  run: DurableRunIdentity,
  staging: Pick<ProjectAssetImportSessionPorts["staging"], "store">,
): Promise<{ locator: string; size: number; contentType?: string } | undefined> {
  const locator = pluginOutputStagingLocator(run);
  const head = await staging.store.head(locator);
  return head
    ? {
        locator,
        size: head.size,
        ...(head.contentType ? { contentType: head.contentType } : {}),
      }
    : undefined;
}
