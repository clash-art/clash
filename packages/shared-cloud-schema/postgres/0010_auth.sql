-- Better Auth 1.6.23 core field contract (getAuthTables); application-owned schema, no SQL foreign keys.
CREATE TABLE auth_user (
 id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
 "emailVerified" boolean NOT NULL DEFAULT false, image text,
 "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL
);
CREATE TABLE auth_session (
 id text PRIMARY KEY, "expiresAt" timestamptz NOT NULL, token text NOT NULL UNIQUE,
 "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL,
 "ipAddress" text, "userAgent" text, "userId" text NOT NULL
);
CREATE INDEX auth_session_user_idx ON auth_session("userId");
CREATE TABLE auth_account (
 id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
 "userId" text NOT NULL, "accessToken" text, "refreshToken" text, "idToken" text,
 "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz,
 scope text, password text, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL
);
CREATE INDEX auth_account_user_idx ON auth_account("userId");
CREATE TABLE auth_verification (
 id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL,
 "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL
);
CREATE INDEX auth_verification_identifier_idx ON auth_verification(identifier);
CREATE TABLE auth_rate_limit (
 id text PRIMARY KEY, key text NOT NULL UNIQUE, count integer NOT NULL, "lastRequest" bigint NOT NULL
);
