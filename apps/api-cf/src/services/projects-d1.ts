import { serverLog } from "../logger";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "../db";
import { DEV_USER_ID } from "./session";
import { projects, assets, assetRefs } from "../db/app.schema";
import { signAssetPath } from "./asset-signing";
import type { Env as AppEnv } from "../config";

const projectsLog = serverLog.child("projects-d1");

type ApiFetcher = { fetch: (request: Request | string) => Promise<Response> };
type Env = Pick<AppEnv, "DB" | "JWT_SECRET"> & {
  ROOM?: AppEnv["ROOM"];
  API_CF?: ApiFetcher;
  API_CF_URL?: string;
  NODE_ENV?: string;
};

type ProjectRow = typeof projects.$inferSelect;

type ProjectAssetPreview = {
  id: string;
  assetId: string;
  url: string;
  type: "image" | "video";
  createdAt: Date | null;
};

type ProjectWithAssets = ProjectRow & {
  assets: Array<{
    id: string;
    assetId: string;
    url: string;
    type: "image" | "video";
    createdAt: Date | null;
  }>;
  assetCount: number;
};

async function ensureDevUser(db: ReturnType<typeof getDb>, env: Env) {
  if (env.NODE_ENV !== "development") return;
  await db.run(
    sql`INSERT OR IGNORE INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (${DEV_USER_ID}, ${"Dev User"}, ${"dev@local"}, ${0}, ${Date.now()}, ${Date.now()})`,
  );
}

async function fetchNodes(env: Env, projectId: string): Promise<unknown[]> {
  const path = `/sync/${projectId}/nodes`;
  // Prefer the in-process DO binding when available — works on the hosted
  // Worker which has no API_CF service binding or API_CF_URL set, and avoids
  // a hairpin over the public internet when it does. Surface errors instead
  // of silently returning [] so a broken thumbnail pipeline is visible in
  // wrangler tail rather than masquerading as "project has no assets".
  if (env.ROOM) {
    try {
      const id = env.ROOM.idFromName(projectId);
      const res = await env.ROOM.get(id).fetch(`https://room${path}`);
      if (res.ok) return (await res.json()) as unknown[];
      projectsLog.warn("project_nodes.fetch_failed", { via: "ROOM", project_id: projectId, status: res.status });
    } catch (err) {
      projectsLog.warn("project_nodes.fetch_failed", { via: "ROOM", project_id: projectId, error: err });
    }
  }
  if (env.API_CF) {
    try {
      const res = await env.API_CF.fetch(`https://api-cf${path}`);
      if (res.ok) return (await res.json()) as unknown[];
      projectsLog.warn("project_nodes.fetch_failed", { via: "API_CF", project_id: projectId, status: res.status });
    } catch (err) {
      projectsLog.warn("project_nodes.fetch_failed", { via: "API_CF", project_id: projectId, error: err });
    }
  } else if (env.API_CF_URL) {
    try {
      const res = await fetch(`${env.API_CF_URL}${path}`);
      if (res.ok) return (await res.json()) as unknown[];
      projectsLog.warn("project_nodes.fetch_failed", { via: "API_CF_URL", project_id: projectId, status: res.status });
    } catch (err) {
      projectsLog.warn("project_nodes.fetch_failed", { via: "API_CF_URL", project_id: projectId, error: err });
    }
  }
  return [];
}

async function resolveProjectAssets(
  env: Env,
  db: ReturnType<typeof getDb>,
  userId: string,
  project: ProjectRow,
): Promise<ProjectAssetPreview[]> {
  const nodes = await fetchNodes(env, project.id);
  const mediaNodes = (nodes as any[]).filter(
    (node) =>
      (node.type === "image" || node.type === "video") &&
      typeof node.data?.assetId === "string",
  );
  const assetIds = Array.from(
    new Set(mediaNodes.map((n: any) => n.data.assetId as string)),
  );
  const assetRows = assetIds.length
    ? await db
        .select({
          id: assets.id,
          srcR2Key: assets.srcR2Key,
          coverR2Key: assets.coverR2Key,
        })
        .from(assets)
        .where(inArray(assets.id, assetIds))
    : [];
  const assetById = new Map(assetRows.map((r) => [r.id, r]));

  const projectAssetCandidates = await Promise.all(
    mediaNodes.map(async (node: any) => {
      const assetId = node.data.assetId as string;
      const row = assetById.get(assetId);
      if (!row) return null;
      if (node.type === "video" && !row.coverR2Key) return null;
      const r2Key = node.type === "video" ? row.coverR2Key! : row.srcR2Key;
      return {
        id: node.id,
        assetId,
        url: await signAssetPath(env as AppEnv, r2Key),
        type: node.type as "image" | "video",
        createdAt: (() => {
          if (node.data?.createdAt) return new Date(node.data.createdAt);
          if (node.createdAt) return new Date(node.createdAt);
          return project.updatedAt || project.createdAt;
        })(),
      };
    }),
  ).then((arr) => arr.filter((a): a is NonNullable<typeof a> => a !== null));

  const placedAssetIds = new Set<string>();
  const projectAssets = projectAssetCandidates.filter((asset) => {
    if (placedAssetIds.has(asset.assetId)) return false;
    placedAssetIds.add(asset.assetId);
    return true;
  });

  const seenAssetIds = new Set(
    mediaNodes
      .map((node: any) => node.data?.assetId)
      .filter(
        (assetId: unknown): assetId is string => typeof assetId === "string",
      ),
  );
  const seenPreviewKeys = new Set(
    mediaNodes
      .map((node: any) => {
        const row = assetById.get(node.data?.assetId);
        if (!row) return undefined;
        return node.type === "video" ? row.coverR2Key : row.srcR2Key;
      })
      .filter((r2Key: unknown): r2Key is string => typeof r2Key === "string"),
  );
  const fallbackRows = await db
    .select({
      id: assets.id,
      srcR2Key: assets.srcR2Key,
      coverR2Key: assets.coverR2Key,
      kind: assets.kind,
      createdAt: assets.createdAt,
      importedAt: assetRefs.importedAt,
    })
    .from(assets)
    .innerJoin(assetRefs, eq(assetRefs.assetId, assets.id))
    .where(and(eq(assetRefs.projectId, project.id), eq(assets.userId, userId)))
    .orderBy(desc(assetRefs.importedAt), desc(assets.createdAt))
    .limit(1000);

  const fallbackAssets = await Promise.all(
    fallbackRows.map(async (row) => {
      if (seenAssetIds.has(row.id)) return null;
      if (row.kind !== "image" && row.kind !== "video") return null;
      if (row.kind === "video" && !row.coverR2Key) return null;
      const r2Key = row.kind === "video" ? row.coverR2Key! : row.srcR2Key;
      if (seenPreviewKeys.has(r2Key)) return null;
      seenAssetIds.add(row.id);
      seenPreviewKeys.add(r2Key);
      return {
        id: row.id,
        assetId: row.id,
        url: await signAssetPath(env as AppEnv, r2Key),
        type: row.kind as "image" | "video",
        createdAt:
          row.createdAt ||
          row.importedAt ||
          project.updatedAt ||
          project.createdAt,
      };
    }),
  ).then((arr) => arr.filter((a): a is NonNullable<typeof a> => a !== null));

  return [...projectAssets, ...fallbackAssets];
}

export async function listProjectsWithAssets(
  env: Env,
  userId: string,
  limit = 10,
  archive: "active" | "only" | "include" = "active",
): Promise<ProjectWithAssets[]> {
  const db = getDb(env.DB);
  if (userId === DEV_USER_ID) await ensureDevUser(db, env);

  const projectsData = await db.query.projects.findMany({
    where:
      archive === "include"
        ? eq(projects.ownerId, userId)
        : and(
            eq(projects.ownerId, userId),
            archive === "only"
              ? isNotNull(projects.deletedAt)
              : isNull(projects.deletedAt),
          ),
    orderBy: [desc(projects.createdAt)],
    limit,
  });

  return Promise.all(
    projectsData.map(async (project) => {
      const resolvedAssets = await resolveProjectAssets(
        env,
        db,
        userId,
        project,
      );
      return {
        ...project,
        assets: resolvedAssets.slice(0, 4),
        assetCount: resolvedAssets.length,
      };
    }),
  );
}

export async function getProjectById(env: Env, userId: string, id: string) {
  const db = getDb(env.DB);
  if (userId === DEV_USER_ID) await ensureDevUser(db, env);
  const project = await db.query.projects.findFirst({
    where: and(
      eq(projects.id, id),
      eq(projects.ownerId, userId),
      isNull(projects.deletedAt),
    ),
  });
  if (!project) return project;
  const resolvedAssets = await resolveProjectAssets(env, db, userId, project);
  return {
    ...project,
    assets: resolvedAssets,
    assetCount: resolvedAssets.length,
  };
}

export async function createNewProject(
  env: Env,
  userId: string,
  prompt: string,
) {
  const db = getDb(env.DB);
  if (userId === DEV_USER_ID) await ensureDevUser(db, env);
  const [project] = await db
    .insert(projects)
    .values({
      ownerId: userId,
      name: prompt.length > 20 ? prompt.substring(0, 20) + "..." : prompt,
      description: prompt,
    })
    .returning();
  return project;
}

export async function renameProject(
  env: Env,
  userId: string,
  id: string,
  name: string,
) {
  const db = getDb(env.DB);
  if (userId === DEV_USER_ID) await ensureDevUser(db, env);
  await db
    .update(projects)
    .set({ name })
    .where(and(eq(projects.id, id), eq(projects.ownerId, userId)));
}

export async function removeProject(env: Env, userId: string, id: string) {
  const db = getDb(env.DB);
  if (userId === DEV_USER_ID) await ensureDevUser(db, env);
  await db
    .delete(projects)
    .where(and(eq(projects.id, id), eq(projects.ownerId, userId)));
}
