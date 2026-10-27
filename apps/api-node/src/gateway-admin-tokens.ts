/**
 * Admin credentials of the Node gateway admin listener (#371; guide:
 * apps/docs/guide/gateway-admin.md#node-admin-listener), over
 * `gateway_admin_token` (0021).
 *
 * An admin token is its own identity, never a product user (#394): a Better
 * Auth session, `clsh_` or `sk_gw_` token is refused. Tokens are
 * `gwa_<24 hex>.<64 hex>`; only the SHA-256 of the whole token is stored and
 * the plaintext is shown once, when it is issued. Tokens are read from the
 * Authorization header only (no cookie), so a browser never attaches one to a
 * cross-site request on its own.
 *
 * Single role: platform_admin only (#371). The first token is bootstrapped
 * explicitly from a shell with database access (no environment-variable grant):
 *
 *   DATABASE_URL=… pnpm --filter @clash/api-node admin-token --role platform_admin [--label ops]
 *
 * Further tokens are issued through POST /api/v1/admin/gateway/admin-tokens.
 * Every issue and revoke writes its gateway_admin_audit row in the same
 * transaction.
 */
import { createHash, randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { GatewayError } from "@clash/gateway-core";
import { databaseUrl } from "./config.ts";
import type {
  GatewayBudgetDatabase,
  GatewayBudgetSqlClient,
} from "./gateway-budget.ts";
import {
  isGatewayAdminRole,
  type GatewayAdminPrincipal,
  type GatewayAdminRole,
} from "./gateway-admin-authz.ts";
import {
  appendGatewayAdminAudit,
  type GatewayAdminAuditRow,
} from "./gateway-key-admin.ts";
import { migrateDatabase } from "./migrations.ts";
import { openPostgres } from "./postgres.ts";

export const GATEWAY_ADMIN_TOKEN_PREFIX = "gwa_";
const TOKEN_PATTERN = /^gwa_([0-9a-f]{24})\.([0-9a-f]{64})$/;

const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const toSeconds = (ms: number) => Math.floor(ms / 1000);

/** An admin token as listed: never its hash or plaintext. */
export interface GatewayAdminTokenView {
  id: string;
  prefix: string;
  role: GatewayAdminRole;
  label: string | null;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

interface TokenRow extends Record<string, unknown> {
  id: string;
  token_prefix: string;
  role: string;
  label: string | null;
  created_by: string;
  created_at: string | number;
  expires_at: string | number | null;
  revoked_at: string | number | null;
}

const TOKEN_COLUMNS =
  "id, token_prefix, role, label, created_by, created_at, expires_at, revoked_at";
const seconds = (value: string | number | null) =>
  value === null ? null : Number(value);

function tokenView(row: TokenRow): GatewayAdminTokenView {
  return {
    id: row.id,
    prefix: row.token_prefix,
    role: row.role as GatewayAdminRole,
    label: row.label,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
    expiresAt: seconds(row.expires_at),
    revokedAt: seconds(row.revoked_at),
  };
}

export interface GatewayAdminTokenIssueInput {
  role: GatewayAdminRole;
  label?: string;
  /** Unix seconds. */
  expiresAt?: number;
  actor: GatewayAdminAuditRow["actor"];
  reason?: string;
}

const invalid = (message: string, param: string) =>
  new GatewayError("GATEWAY_INVALID_REQUEST", {
    message,
    details: { param },
  });

export function createPgGatewayAdminTokens(deps: {
  db: GatewayBudgetDatabase;
  /** Epoch milliseconds. */
  now?: () => number;
}) {
  const { db } = deps;
  const now = deps.now ?? Date.now;

  async function row(
    sql: GatewayBudgetSqlClient,
    id: string,
  ): Promise<TokenRow | undefined> {
    const { rows } = await sql.query<TokenRow>(
      `SELECT ${TOKEN_COLUMNS} FROM gateway_admin_token WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  return {
    /** Issue a token; the plaintext is in this result only. */
    async issue(
      input: GatewayAdminTokenIssueInput,
    ): Promise<{ token: string; adminToken: GatewayAdminTokenView }> {
      if (!isGatewayAdminRole(input.role)) throw invalid("Unknown admin role.", "role");
      const nowS = toSeconds(now());
      if (input.expiresAt !== undefined && input.expiresAt <= nowS)
        throw invalid("The expiry is in the past.", "expiresAt");
      const publicId = randomBytes(12).toString("hex");
      const token = `${GATEWAY_ADMIN_TOKEN_PREFIX}${publicId}.${randomBytes(32).toString("hex")}`;
      const id = `gat_${publicId}`;
      const view = await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO gateway_admin_token
             (id, token_hash, token_prefix, role, label, created_by, expires_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            sha256Hex(token),
            token.slice(0, 16),
            input.role,
            input.label ?? null,
            input.actor.id,
            input.expiresAt ?? null,
            nowS,
          ],
        );
        const issued = tokenView((await row(tx, id))!);
        await appendGatewayAdminAudit(
          tx,
          {
            actor: input.actor,
            action: "admin_token.issue",
            targetType: "admin_token",
            targetId: id,
            after: issued,
            ...(input.reason ? { reason: input.reason } : {}),
          },
          nowS,
        );
        return issued;
      });
      return { token, adminToken: view };
    },

    async list(): Promise<GatewayAdminTokenView[]> {
      const { rows } = await db.query<TokenRow>(
        `SELECT ${TOKEN_COLUMNS} FROM gateway_admin_token ORDER BY created_at DESC, id`,
      );
      return rows.map(tokenView);
    },

    /**
     * Revoke a token. The last live platform_admin token cannot be revoked
     * (GATEWAY_LAST_ADMIN_ACCOUNT), so the listener is never left without an
     * admin; a repeated revoke is a no-op.
     */
    async revoke(input: {
      id: string;
      actor: GatewayAdminAuditRow["actor"];
      reason?: string;
    }): Promise<GatewayAdminTokenView> {
      const nowS = toSeconds(now());
      return db.transaction(async (tx) => {
        // Serialize revokes so two concurrent ones cannot both pass the last-admin check.
        await tx.query(
          `SELECT pg_advisory_xact_lock(hashtext('gateway_admin_token.revoke'))`,
        );
        const before = await row(tx, input.id);
        if (!before)
          throw new GatewayError("GATEWAY_ADMIN_ACCOUNT_NOT_FOUND", {
            details: { adminTokenId: input.id },
          });
        if (before.revoked_at !== null) return tokenView(before);
        if (before.role === "platform_admin") {
          const { rows } = await tx.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM gateway_admin_token
              WHERE role = 'platform_admin' AND revoked_at IS NULL AND id <> $1
                AND (expires_at IS NULL OR expires_at > $2)`,
            [input.id, nowS],
          );
          if ((rows[0]?.n ?? 0) === 0)
            throw new GatewayError("GATEWAY_LAST_ADMIN_ACCOUNT", {
              details: { adminTokenId: input.id },
            });
        }
        await tx.query(
          `UPDATE gateway_admin_token SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`,
          [input.id, nowS],
        );
        const after = tokenView((await row(tx, input.id))!);
        await appendGatewayAdminAudit(
          tx,
          {
            actor: input.actor,
            action: "admin_token.revoke",
            targetType: "admin_token",
            targetId: input.id,
            before: { revokedAt: null },
            after: { revokedAt: after.revokedAt },
            ...(input.reason ? { reason: input.reason } : {}),
          },
          nowS,
        );
        return after;
      });
    },

    /**
     * The admin principal of a request's `Authorization: Bearer gwa_…`, or
     * null when it carries no admin token (a product credential included).
     * A revoked or expired admin token is a coded refusal.
     */
    async verify(request: Request): Promise<GatewayAdminPrincipal | null> {
      const token = request.headers
        .get("authorization")
        ?.match(/^Bearer\s+(\S+)$/i)?.[1];
      if (!token || !TOKEN_PATTERN.test(token)) return null;
      const { rows } = await db.query<TokenRow>(
        `SELECT ${TOKEN_COLUMNS} FROM gateway_admin_token WHERE token_hash = $1`,
        [sha256Hex(token)],
      );
      const found = rows[0];
      if (!found) return null;
      if (found.revoked_at !== null)
        throw new GatewayError("GATEWAY_TOKEN_REVOKED", {
          details: { adminTokenId: found.id },
        });
      if (
        found.expires_at !== null &&
        Number(found.expires_at) <= toSeconds(now())
      )
        throw new GatewayError("GATEWAY_TOKEN_EXPIRED", {
          details: { adminTokenId: found.id },
        });
      return {
        id: found.id,
        role: found.role,
      };
    },
  };
}

export type PgGatewayAdminTokens = ReturnType<typeof createPgGatewayAdminTokens>;

/** Bootstrap CLI: issue one admin token, audited as the `bootstrap` actor. */
export async function issueGatewayAdminTokenFromCli(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      role: { type: "string" },
      label: { type: "string" },
    },
    strict: true,
  });
  if (!values.role || !isGatewayAdminRole(values.role))
    throw Error("--role must be platform_admin");
  const database = openPostgres({ connectionString: databaseUrl(env) });
  try {
    await migrateDatabase(database.db);
    const { token } = await createPgGatewayAdminTokens({
      db: database.db,
    }).issue({
      role: values.role,
      ...(values.label ? { label: values.label } : {}),
      actor: { kind: "bootstrap", id: "bootstrap", role: "bootstrap" },
      reason: "cli bootstrap",
    });
    return token;
  } finally {
    await database.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await issueGatewayAdminTokenFromCli(process.argv.slice(2))
    .then((token) => {
      // The only time the plaintext exists outside the caller's hands.
      console.log(token);
    })
    .catch((error: unknown) => {
      console.error(
        error instanceof GatewayError
          ? `${error.code}: ${error.message}`
          : error instanceof Error && error.message.startsWith("--")
            ? error.message
            : "Admin token issue failed",
      );
      process.exitCode = 1;
    });
}
