-- Admin identity on the Node admin listener (#372), separate from product
-- users (#394): the PostgreSQL mirror of D1 0040. Admin accounts are their own
-- Better Auth instance (apps/api-node/src/admin-auth.ts, base path
-- /api/admin-auth, cookie prefix clash-admin) over these tables, never
-- auth_user / auth_session / auth_account. Column names are Better Auth's
-- field names, as in 0010. No foreign keys (AGENTS.md).
--
-- Sign-up is off: accounts are created by `pnpm admin-account:create`
-- (src/admin-account-cli.ts). A disabled account (disabledAt set) cannot sign in.
CREATE TABLE admin_account (
 id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
 "emailVerified" boolean NOT NULL DEFAULT false, image text,
 -- The permission set the account holds (gateway-core admin-authz.ts).
 role text NOT NULL DEFAULT 'platform_admin' CHECK (role IN ('platform_admin', 'support_agent')),
 "disabledAt" timestamptz,
 "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL
);
CREATE TABLE admin_session (
 id text PRIMARY KEY, "expiresAt" timestamptz NOT NULL, token text NOT NULL UNIQUE,
 "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL,
 "ipAddress" text, "userAgent" text, "userId" text NOT NULL
);
CREATE INDEX admin_session_user_idx ON admin_session("userId");
-- Better Auth's "account" model: the credential (password hash) of an admin account.
CREATE TABLE admin_credential (
 id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
 "userId" text NOT NULL, "accessToken" text, "refreshToken" text, "idToken" text,
 "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz,
 scope text, password text, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL
);
CREATE INDEX admin_credential_user_idx ON admin_credential("userId");
CREATE TABLE admin_verification (
 id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL,
 "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL
);
CREATE INDEX admin_verification_identifier_idx ON admin_verification(identifier);
CREATE TABLE admin_rate_limit (
 id text PRIMARY KEY, key text NOT NULL UNIQUE, count integer NOT NULL, "lastRequest" bigint NOT NULL
);
