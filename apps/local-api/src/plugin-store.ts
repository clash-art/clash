import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { createLocalSqliteConnection } from "./local-sqlite-connection.js";
import { resolveProviderSecretKey } from "./local-provider-store";

/**
 * What a plugin keeps, without the host knowing what any of it means.
 *
 * Settings used to live in fixed columns on `provider_accounts` -- `region`, `label`, `api_shape`,
 * `priority`, `weight` -- so anything outside that list had nowhere to go. A `--location` flag was
 * written, parsed, printed success, and dropped the value, because none of the columns was
 * `location`. Flow state was worse: `provider_oauth` carries a column per OAuth flow
 * (`device_code`, `user_code`, `interval_seconds`, `oauth_state`), so adding a flow meant altering a
 * table.
 *
 * Here a plugin chooses its own keys and the host stores them opaquely. Two fields are not opaque,
 * because the host acts on them:
 *
 *   secret     decides encryption at rest
 *   expiresAt  is what makes renewal schedulable -- without it the host cannot know when to wake
 *              a plugin, and every plugin would need its own timer
 *
 * Values are scoped to `(pluginId, accountId, key)`. Plugins hold their credentials in plaintext by
 * design, so this scoping is the boundary that remains: installing a plugin exposes the accounts
 * configured for that plugin, not every account on the machine.
 */

export interface PluginStoreEntryRef {
  pluginId: string;
  accountId: string;
  key: string;
}

export interface PluginStorePut extends PluginStoreEntryRef {
  value: string;
  /** Encrypt at rest. */
  secret?: boolean;
  /** Epoch millis after which the value is stale; the only scheduling signal the host reads. */
  expiresAt?: number;
}

export interface PluginStoreDueEntry extends PluginStoreEntryRef {
  expiresAt: number;
}

/**
 * A store already bound to one plugin and one account.
 *
 * This is what a plugin receives. It takes a key and nothing else, because the two components that
 * decide *whose* data this is are established by the host from the process it spawned -- not sent by
 * the plugin, which could then name any other.
 */
export interface BoundPluginStore {
  put(key: string, value: string, options?: { secret?: boolean; expiresAt?: number }): Promise<void>;
  get(key: string): Promise<string | undefined>;
  remove(key: string): Promise<void>;
}

export interface PluginStore {
  /** Hand a plugin its own view. The caller supplies the identity; the plugin never does. */
  forPlugin(owner: { pluginId: string; accountId: string }): BoundPluginStore;
  put(entry: PluginStorePut): Promise<void>;
  get(ref: PluginStoreEntryRef): Promise<string | undefined>;
  remove(ref: PluginStoreEntryRef): Promise<void>;
  dueForRenewal(options: { within: number; now?: number }): Promise<PluginStoreDueEntry[]>;
  /** The stored bytes, so a test can prove `secret` actually encrypted something. */
  rawValueForTest(ref: PluginStoreEntryRef): Promise<string | undefined>;
}

const SECRET_PREFIX = "enc:v1:";

function encrypt(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    SECRET_PREFIX + iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    body.toString("base64"),
  ].join(":");
}

function decrypt(stored: string, key: Buffer): string {
  const [head, tagText, bodyText] = stored.split(":").slice(2);
  if (!head || !tagText || !bodyText) {
    throw new Error("A stored secret is not in the expected format.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(head, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(bodyText, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export async function openPluginStore(options: { dataDir: string }): Promise<PluginStore> {
  // The SQLite worker migrates `plugin_store` and serves it on the Host's one
  // WAL + busy_timeout connection; this opener used to set neither.
  const db = createLocalSqliteConnection({ dataDir: options.dataDir }).db;
  await db.prepare("SELECT 1 FROM plugin_store LIMIT 1").get();
  const secretKey = await resolveProviderSecretKey(options.dataDir);

  const store: PluginStore = {
    forPlugin(owner) {
      return {
        put: (key, value, opts) => store.put({ ...owner, key, value, ...opts }),
        get: (key) => store.get({ ...owner, key }),
        remove: (key) => store.remove({ ...owner, key }),
      };
    },

    async put(entry) {
      const stored = entry.secret ? encrypt(entry.value, secretKey) : entry.value;
      // Replace, not append. A credential has one current value; keeping the previous one would
      // mean deciding which is live on every read, and leaving a revoked secret on disk.
      await db.prepare(`
        INSERT INTO plugin_store (plugin_id, account_id, key, value, is_secret, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (plugin_id, account_id, key)
        DO UPDATE SET value = excluded.value,
                      is_secret = excluded.is_secret,
                      expires_at = excluded.expires_at
      `).run(
        entry.pluginId,
        entry.accountId,
        entry.key,
        stored,
        entry.secret ? 1 : 0,
        entry.expiresAt ?? null,
      );
    },

    async get(ref) {
      const row = await db.prepare(
        "SELECT value, is_secret FROM plugin_store WHERE plugin_id = ? AND account_id = ? AND key = ?",
      ).get(ref.pluginId, ref.accountId, ref.key);
      if (!row) return undefined;
      const value = String(row.value ?? "");
      return Number(row.is_secret) === 1 ? decrypt(value, secretKey) : value;
    },

    async remove(ref) {
      await db.prepare(
        "DELETE FROM plugin_store WHERE plugin_id = ? AND account_id = ? AND key = ?",
      ).run(ref.pluginId, ref.accountId, ref.key);
    },

    async dueForRenewal({ within, now = Date.now() }) {
      // Only entries that stated an expiry. A value with none is not eternal -- it is a value whose
      // plugin never asked to be woken about it.
      return (await db.prepare(`
        SELECT plugin_id, account_id, key, expires_at
        FROM plugin_store
        WHERE expires_at IS NOT NULL AND expires_at <= ?
        ORDER BY expires_at ASC
      `).all(now + within)).map((row) => ({
        pluginId: String(row.plugin_id),
        accountId: String(row.account_id),
        key: String(row.key),
        expiresAt: Number(row.expires_at),
      }));
    },

    async rawValueForTest(ref) {
      const row = await db.prepare(
        "SELECT value FROM plugin_store WHERE plugin_id = ? AND account_id = ? AND key = ?",
      ).get(ref.pluginId, ref.accountId, ref.key);
      return row ? String(row.value ?? "") : undefined;
    },
  };

  return store;
}
