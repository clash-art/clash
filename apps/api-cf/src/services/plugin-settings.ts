/**
 * Per-user settings for third-party executable plugins.
 *
 * A plugin runs behind one user-configured HTTPS endpoint and signs every
 * request with one per-plugin secret. The secret only exists here as an
 * ACTION_SECRET_KEY envelope; list/read responses never include it.
 */
import { and, desc, eq } from "drizzle-orm";
import type { D1Database } from "@cloudflare/workers-types";
import { pluginIdSchema } from "@clash/shared-types";
import { validateRemotePluginEndpoint } from "@clash/shared-runtime/executable-plugin-remote";
import { getDb } from "../db";
import { pluginEndpointSettings } from "../db/app.schema";
import {
  decryptSecretJson,
  encryptSecretJson,
  requireSecretEnvelopeKey,
} from "@clash/shared-runtime/secret-envelope";

const PLUGIN_SECRET_SALT = "clash-plugin-endpoint-secret";
const SCHEMA_HASH = /^sha256:[0-9a-f]{64}$/;

export interface PluginEndpointSettingInput {
  pluginId?: unknown;
  endpoint?: unknown;
  secret?: unknown;
  version?: unknown;
  schemaHash?: unknown;
  exportIds?: unknown;
  idempotentSubmit?: unknown;
}

export interface PublicPluginEndpointSetting {
  pluginId: string;
  endpoint: string;
  version?: string;
  schemaHash?: `sha256:${string}`;
  exportIds: string[];
  idempotentSubmit: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Invalid caller input; the route maps it to 400. Anything else is a server fault. */
export class PluginSettingInputError extends Error {
  override name = "PluginSettingInputError";
}

type PluginEndpointSettingRow = typeof pluginEndpointSettings.$inferSelect;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalSchemaHash(value: unknown): `sha256:${string}` | undefined {
  const text = optionalString(value);
  if (!text) return undefined;
  if (!SCHEMA_HASH.test(text)) {
    throw new PluginSettingInputError("Plugin schemaHash must be sha256:<64 lowercase hex>.");
  }
  return text as `sha256:${string}`;
}

function exportIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new PluginSettingInputError("Plugin exportIds must be an array.");
  return [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function publicSetting(
  row: PluginEndpointSettingRow,
): PublicPluginEndpointSetting {
  return {
    pluginId: row.pluginId,
    endpoint: row.endpoint,
    ...(row.version ? { version: row.version } : {}),
    ...(row.schemaHash
      ? { schemaHash: row.schemaHash as `sha256:${string}` }
      : {}),
    exportIds: row.exportIds ? exportIdsSafe(row.exportIds) : [],
    idempotentSubmit: row.idempotentSubmit === 1,
    createdAt: Math.floor(new Date(row.createdAt).getTime() / 1000),
    updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
  };
}

function exportIdsSafe(serialized: string): string[] {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function normalizeInput(input: PluginEndpointSettingInput) {
  const pluginId = pluginIdSchema.safeParse(optionalString(input.pluginId));
  if (!pluginId.success) {
    throw new PluginSettingInputError("A plugin endpoint setting requires a valid pluginId.");
  }
  const endpoint = validateRemotePluginEndpoint(
    optionalString(input.endpoint) ?? "",
  );
  const secret = optionalString(input.secret);
  if (!secret) {
    throw new PluginSettingInputError("A plugin endpoint setting requires a signing secret.");
  }
  return {
    pluginId: pluginId.data,
    endpoint,
    secret,
    version: optionalString(input.version),
    schemaHash: optionalSchemaHash(input.schemaHash),
    exportIds: exportIds(input.exportIds),
    idempotentSubmit:
      input.idempotentSubmit === true ||
      input.idempotentSubmit === "true" ||
      input.idempotentSubmit === 1,
  };
}

export async function createPluginEndpointSetting(
  env: { DB: D1Database; ACTION_SECRET_KEY?: string },
  userId: string,
  input: PluginEndpointSettingInput,
): Promise<PublicPluginEndpointSetting> {
  const normalized = normalizeInput(input);
  const secretKey = requireSecretEnvelopeKey(
    env.ACTION_SECRET_KEY,
    "Plugin signing secret encryption key is not configured.",
  );
  const encryptedSecret = await encryptSecretJson(
    normalized.secret,
    secretKey,
    PLUGIN_SECRET_SALT,
  );
  const now = new Date();
  const db = getDb(env.DB);
  const [row] = await db
    .insert(pluginEndpointSettings)
    .values({
      userId,
      pluginId: normalized.pluginId,
      endpoint: normalized.endpoint,
      encryptedSecret,
      ...(normalized.version ? { version: normalized.version } : {}),
      ...(normalized.schemaHash ? { schemaHash: normalized.schemaHash } : {}),
      ...(normalized.exportIds.length
        ? { exportIds: JSON.stringify(normalized.exportIds) }
        : {}),
      idempotentSubmit: normalized.idempotentSubmit ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [pluginEndpointSettings.userId, pluginEndpointSettings.pluginId],
      set: {
        endpoint: normalized.endpoint,
        encryptedSecret,
        version: normalized.version ?? null,
        schemaHash: normalized.schemaHash ?? null,
        exportIds: normalized.exportIds.length
          ? JSON.stringify(normalized.exportIds)
          : null,
        idempotentSubmit: normalized.idempotentSubmit ? 1 : 0,
        updatedAt: now,
      },
    })
    .returning();
  if (!row) throw new Error("Plugin endpoint setting was not persisted.");
  return publicSetting(row);
}

export async function listPluginEndpointSettings(
  env: { DB: D1Database },
  userId: string,
): Promise<PublicPluginEndpointSetting[]> {
  const rows = await getDb(env.DB).query.pluginEndpointSettings.findMany({
    where: eq(pluginEndpointSettings.userId, userId),
    orderBy: [desc(pluginEndpointSettings.createdAt)],
  });
  return rows.map(publicSetting);
}

export async function deletePluginEndpointSetting(
  env: { DB: D1Database },
  userId: string,
  pluginId: string,
): Promise<boolean> {
  const parsed = pluginIdSchema.safeParse(pluginId);
  if (!parsed.success) return false;
  const result = await getDb(env.DB)
    .delete(pluginEndpointSettings)
    .where(
      and(
        eq(pluginEndpointSettings.userId, userId),
        eq(pluginEndpointSettings.pluginId, parsed.data),
      ),
    )
    .returning({ id: pluginEndpointSettings.id });
  return result.length > 0;
}

/** Resolve one remote binding's endpoint, secret and replay declaration. */
export async function resolveRemotePluginSettings(
  env: { DB: D1Database; ACTION_SECRET_KEY?: string },
  userId: string,
  pluginId: string,
): Promise<
  | (PublicPluginEndpointSetting & {
      signingSecret: string;
      exportIds: string[];
    })
  | undefined
> {
  const row = await getDb(env.DB).query.pluginEndpointSettings.findFirst({
    where: and(
      eq(pluginEndpointSettings.userId, userId),
      eq(pluginEndpointSettings.pluginId, pluginId),
    ),
  });
  if (!row) return undefined;
  const secretKey = requireSecretEnvelopeKey(
    env.ACTION_SECRET_KEY,
    "Plugin signing secret encryption key is not configured.",
  );
  const decrypted = await decryptSecretJson(
    row.encryptedSecret,
    secretKey,
    PLUGIN_SECRET_SALT,
  );
  if (typeof decrypted !== "string" || !decrypted.trim()) {
    throw new Error(
      `Plugin signing secret for ${pluginId} could not be opened.`,
    );
  }
  return {
    ...publicSetting(row),
    signingSecret: decrypted,
  };
}
