import { and, desc, eq } from "drizzle-orm";
import type { D1Database } from "@cloudflare/workers-types";
import {
  apiTokens,
  userVariables,
  installedActions,
  installedSkills,
} from "../db/app.schema";
import { getDb } from "../db";
import { requireSecret } from "./require-secret";

type Env = { DB: D1Database; ACTION_SECRET_KEY?: string; ENVIRONMENT: string };

// ───────── API tokens ─────────

function generateToken(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `clsh_${hex}`;
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function createApiToken(env: Env, userId: string, name: string) {
  const db = getDb(env.DB);
  const plaintext = generateToken();
  const hash = await sha256(plaintext);
  const prefix = plaintext.slice(0, 13) + "...";
  const [row] = await db
    .insert(apiTokens)
    .values({
      userId,
      name: name || "Untitled Token",
      tokenHash: hash,
      tokenPrefix: prefix,
    })
    .returning();
  return {
    token: plaintext,
    info: {
      id: row.id,
      name: row.name,
      tokenPrefix: row.tokenPrefix,
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
    },
  };
}

export async function listApiTokens(env: Env, userId: string) {
  const db = getDb(env.DB);
  const rows = await db.query.apiTokens.findMany({
    where: eq(apiTokens.userId, userId),
    orderBy: [desc(apiTokens.createdAt)],
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    tokenPrefix: r.tokenPrefix,
    lastUsedAt: r.lastUsedAt,
    createdAt: r.createdAt,
  }));
}

export async function revokeApiToken(env: Env, userId: string, tokenId: string) {
  const db = getDb(env.DB);
  const row = await db.query.apiTokens.findFirst({
    where: eq(apiTokens.id, tokenId),
  });
  if (!row || row.userId !== userId) throw new Response("Not found", { status: 404 });
  await db.delete(apiTokens).where(eq(apiTokens.id, tokenId));
}

// ───────── User variables (encrypted) ─────────

async function getEncryptionKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode("clash-user-vars"),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptValue(secret: string, value: string): Promise<string> {
  const key = await getEncryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(value);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const combined = new Uint8Array(iv.length + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function setVariable(
  env: Env,
  userId: string,
  key: string,
  value: string,
) {
  const db = getDb(env.DB);
  const secret = requireSecret(env, "ACTION_SECRET_KEY", env.ACTION_SECRET_KEY, "dev-secret-key-change-in-prod");
  const encrypted = await encryptValue(secret, value);
  await db
    .delete(userVariables)
    .where(and(eq(userVariables.userId, userId), eq(userVariables.key, key)));
  const [row] = await db
    .insert(userVariables)
    .values({ userId, key, encryptedValue: encrypted })
    .returning();
  return {
    id: row.id,
    key: row.key,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listVariables(env: Env, userId: string) {
  const db = getDb(env.DB);
  const rows = await db.query.userVariables.findMany({
    where: eq(userVariables.userId, userId),
    orderBy: [desc(userVariables.createdAt)],
  });
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function deleteVariable(env: Env, userId: string, id: string) {
  const db = getDb(env.DB);
  const row = await db.query.userVariables.findFirst({
    where: eq(userVariables.id, id),
  });
  if (!row || row.userId !== userId) throw new Response("Not found", { status: 404 });
  await db.delete(userVariables).where(eq(userVariables.id, id));
}

// ───────── Installed actions ─────────

export async function listInstalledActions(env: Env, userId: string) {
  const db = getDb(env.DB);
  const rows = await db.query.installedActions.findMany({
    where: eq(installedActions.userId, userId),
    orderBy: [desc(installedActions.createdAt)],
  });
  return rows.map((r) => ({
    id: r.id,
    actionId: r.actionId,
    removable: true,
    name: r.name,
    description: r.description,
    runtime: r.runtime,
    version: r.version,
    author: r.author,
    repository: r.repository,
    workerUrl: r.workerUrl,
    icon: r.icon,
    color: r.color,
    tags: r.tags,
    manifest: r.manifest,
    createdAt: r.createdAt,
  }));
}

export async function installAction(
  _env: Env,
  _userId: string,
  _manifest?: unknown,
): Promise<never> {
  throw Response.json({ code: "LEGACY_ACTION_INSTALL_RETIRED", error: "Worker Action manifest installation is retired. Install an executable plugin through a supported Local Host marketplace." }, { status: 410 });
}

export async function uninstallAction(
  env: Env,
  userId: string,
  actionId: string,
) {
  const db = getDb(env.DB);
  await db
    .delete(installedActions)
    .where(
      and(
        eq(installedActions.userId, userId),
        eq(installedActions.actionId, actionId),
      ),
    );
}

// ───────── Installed skills ─────────

export async function listInstalledSkills(env: Env, userId: string) {
  const db = getDb(env.DB);
  const rows = await db.query.installedSkills.findMany({
    where: eq(installedSkills.userId, userId),
    orderBy: [desc(installedSkills.createdAt)],
  });
  return rows.map((r) => ({
    id: r.id,
    skillId: r.skillId,
    name: r.name,
    description: r.description,
    repository: r.repository,
    version: r.version,
    author: r.author,
    icon: r.icon,
    tags: r.tags,
    linkedActionId: r.linkedActionId,
    createdAt: r.createdAt,
  }));
}

export async function installSkill(
  env: Env,
  userId: string,
  def: Record<string, any>,
) {
  const db = getDb(env.DB);
  await db
    .delete(installedSkills)
    .where(
      and(
        eq(installedSkills.userId, userId),
        eq(installedSkills.skillId, def.id),
      ),
    );
  const [row] = await db
    .insert(installedSkills)
    .values({
      userId,
      skillId: def.id,
      name: def.name,
      description: def.description || null,
      repository: def.repository || null,
      version: def.version || null,
      author: def.author || null,
      icon: def.icon || null,
      tags: def.tags ? JSON.stringify(def.tags) : null,
      linkedActionId: def.linkedActionId || null,
    })
    .returning();
  return row;
}

export async function uninstallSkill(
  env: Env,
  userId: string,
  skillId: string,
) {
  const db = getDb(env.DB);
  await db
    .delete(installedSkills)
    .where(
      and(
        eq(installedSkills.userId, userId),
        eq(installedSkills.skillId, skillId),
      ),
    );
}
