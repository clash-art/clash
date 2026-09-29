import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ProjectContentQuerySchema,
  getDocumentKindDefinition,
  listDocumentAttachments,
  listProjectAssets,
  listProjectDocumentAssets,
  parseDocumentBody,
  readDocumentAssetRevision,
  type AssetRevisionRef,
  type DocumentAssetRevision,
  type DocumentAssetRevisionRef,
  type DocumentAttachment,
  type ProjectAssetEntry,
  type ProjectContentItem,
  type ProjectContentMatch,
  type ProjectContentQuery,
  type ProjectContentResult,
} from "@clash/shared-types";
import { readMetadataBody } from "@clash/shared-runtime";
import type { LocalDocumentProjectAuthority } from "./local-document-product.js";
import {
  documentEvidenceText,
  normalizedContentText,
  type DocumentEvidenceText,
} from "./document-evidence-text.js";

type EvidenceSource = {
  revision: DocumentAssetRevision;
  attachment?: DocumentAttachment;
};
type ContentCandidate = { item: ProjectContentItem; sources: EvidenceSource[] };
const cursorSchema = z
  .object({
    version: z.literal(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    offset: z.number().int().positive(),
  })
  .strict();

function cursorError(status: 400 | 409, code: string, error: string): never {
  throw new HTTPException(status, {
    res: Response.json({ code, error }, { status }),
  });
}

function readCursor(value: string) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    cursorError(
      400,
      "CONTENT_CURSOR_INVALID",
      "Invalid content cursor. Restart without cursor.",
    );
  }
  const parsed = cursorSchema.safeParse(decoded);
  if (!parsed.success || !/^[A-Za-z0-9_-]+$/.test(value)) {
    cursorError(
      400,
      "CONTENT_CURSOR_INVALID",
      "Invalid content cursor. Restart without cursor.",
    );
  }
  return parsed.data;
}
const documentRef = (
  revision: DocumentAssetRevision,
): DocumentAssetRevisionRef => ({
  kind: "document",
  documentAssetId: revision.documentAssetId,
  revisionId: revision.id,
});
function sameRef(left: AssetRevisionRef, right: AssetRevisionRef): boolean {
  return left.kind === "media" && right.kind === "media"
    ? left.projectAssetId === right.projectAssetId
    : left.kind === "document" &&
        right.kind === "document" &&
        left.documentAssetId === right.documentAssetId &&
        left.revisionId === right.revisionId;
}
function searchable(revision: DocumentAssetRevision): boolean {
  return (
    getDocumentKindDefinition(
      revision.documentKind,
      revision.schemaVersion,
    )?.productConsumers.includes("search") === true
  );
}
function sourceLocation(
  revision: DocumentAssetRevision,
  text: DocumentEvidenceText,
  activeAssets: ProjectAssetEntry[],
) {
  if (text.startMs === undefined || text.endMs === undefined) return undefined;
  // A timestamp without one proven source identity is not a usable seek location.
  // In particular, an attachment to an output does not move source time to that output.
  const sources = [
    ...new Set(
      revision.sourceRefs.flatMap((ref) =>
        ref.slot === "source" &&
        "kind" in ref.target &&
        ref.target.kind === "media"
          ? [ref.target.projectAssetId]
          : [],
      ),
    ),
  ];
  if (sources.length !== 1) return undefined;
  const source = activeAssets.find((asset) => asset.id === sources[0]);
  if (!source || (source.kind !== "video" && source.kind !== "audio"))
    return undefined;
  return {
    asset: { kind: "media" as const, projectAssetId: source.id },
    startMs: text.startMs,
    endMs: text.endMs,
  };
}

export function createLocalProjectContentService(options: {
  dataDir: string;
  authority: LocalDocumentProjectAuthority;
}) {
  async function read(
    projectId: string,
    input: ProjectContentQuery,
    mode: "list" | "search",
  ): Promise<ProjectContentResult> {
    const query = ProjectContentQuerySchema.parse(input);
    const cursor = query.cursor ? readCursor(query.cursor) : undefined;
    const snapshot = await options.authority.inspect(projectId, (doc) => {
      const activeAssets = listProjectAssets(doc).filter(
        (asset) => asset.lifecycle.state === "active",
      );
      const attachments = listDocumentAttachments(doc);
      const candidates: ContentCandidate[] = [];
      for (const asset of activeAssets) {
        const ref = { kind: "media" as const, projectAssetId: asset.id };
        if (query.within && !sameRef(query.within, ref)) continue;
        const sources = attachments.flatMap((attachment) => {
          if (
            attachment.target.kind !== "project-asset" ||
            attachment.target.projectAssetId !== asset.id
          )
            return [];
          const revision = readDocumentAssetRevision(doc, attachment.document);
          return revision && searchable(revision)
            ? [{ revision, attachment }]
            : [];
        });
        const { width, height, durationMs } = asset.metadata;
        candidates.push({
          item: {
            ref,
            name: asset.name ?? asset.metadata.originalName ?? asset.id,
            kind: asset.kind,
            info: {
              ...(width === undefined ? {} : { width }),
              ...(height === undefined ? {} : { height }),
              ...(durationMs === undefined ? {} : { durationMs }),
              hasEvidence: sources.length > 0,
            },
            matches: [],
          },
          sources,
        });
      }
      if (!query.within || query.within.kind === "document") {
        const refs =
          query.within?.kind === "document"
            ? [query.within]
            : listProjectDocumentAssets(doc).map((asset) => ({
                kind: "document" as const,
                documentAssetId: asset.id,
                revisionId: asset.headRevisionId,
              }));
        for (const ref of refs) {
          const revision = readDocumentAssetRevision(doc, ref);
          if (!revision) continue;
          candidates.push({
            item: {
              ref,
              name: revision.documentAssetId,
              kind: "document",
              info: { documentKind: revision.documentKind },
              matches: [],
            },
            sources: searchable(revision) ? [{ revision }] : [],
          });
        }
      }
      return { activeAssets, candidates };
    });
    const needle = normalizedContentText(query.query ?? "");
    const bodies = new Map<string, Promise<unknown>>();
    const items: ProjectContentItem[] = [];
    const countsByKind: ProjectContentResult["countsByKind"] = {
      image: 0,
      video: 0,
      audio: 0,
      model: 0,
      document: 0,
    };
    for (const candidate of snapshot.candidates) {
      const matches: ProjectContentMatch[] = [];
      if (mode === "list" && needle) {
        const brief = [
          candidate.item.name,
          candidate.item.kind,
          candidate.item.info.width,
          candidate.item.info.height,
          candidate.item.info.durationMs,
          candidate.item.info.documentKind,
        ]
          .filter((value) => value !== undefined)
          .join(" ");
        if (!normalizedContentText(brief).includes(needle)) continue;
      }
      if (mode === "search") {
        if (
          needle &&
          normalizedContentText(candidate.item.name).includes(needle)
        )
          matches.push({ field: "name", text: candidate.item.name });
        for (const { revision, attachment } of candidate.sources) {
          let body = bodies.get(revision.body.digest);
          if (!body) {
            body = readMetadataBody({
              dataDir: options.dataDir,
              contentHash: revision.body.digest,
            });
            bodies.set(revision.body.digest, body);
          }
          const parsed = parseDocumentBody(
            revision.documentKind,
            revision.schemaVersion,
            await body,
          );
          for (const text of documentEvidenceText(
            revision.documentKind,
            parsed,
          )) {
            if (needle && !normalizedContentText(text.text).includes(needle))
              continue;
            const location = sourceLocation(
              revision,
              text,
              snapshot.activeAssets,
            );
            matches.push({
              field: "content",
              text: text.text,
              document: documentRef(revision),
              documentKind: revision.documentKind,
              producer: revision.producer,
              sourceRefs: revision.sourceRefs,
              ...(attachment ? { attachmentId: attachment.id } : {}),
              ...(location ? { location } : {}),
            });
          }
        }
        if (needle && !matches.length) continue;
      }
      // Each candidate is one Media identity or exact Document revision;
      // multiple matching evidence fragments never increase the object count.
      countsByKind[candidate.item.kind] += 1;
      if (!query.kinds || query.kinds.includes(candidate.item.kind))
        items.push({ ...candidate.item, matches });
    }
    // Stable object ordering makes a bounded read repeatable without claiming a relevance score.
    items.sort((left, right) =>
      JSON.stringify(left.ref).localeCompare(JSON.stringify(right.ref)),
    );
    const limit = query.limit ?? 50;
    // Bind continuation to the scope and visible result set, not mutable offsets
    // alone. Unrelated Project edits need not invalidate a browse session.
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          projectId,
          mode,
          query: needle,
          kinds: query.kinds ? [...new Set(query.kinds)].sort() : null,
          within: query.within ?? null,
          items,
          countsByKind,
        }),
      )
      .digest("hex");
    if (
      cursor &&
      (cursor.fingerprint !== fingerprint || cursor.offset >= items.length)
    ) {
      cursorError(
        409,
        "CONTENT_CURSOR_STALE",
        "Content or query changed. Restart without cursor and keep the same filters between pages.",
      );
    }
    const offset = cursor?.offset ?? 0;
    const end = offset + limit;
    const nextCursor =
      end < items.length
        ? Buffer.from(
            JSON.stringify({ version: 1, fingerprint, offset: end }),
          ).toString("base64url")
        : null;
    return {
      items: items.slice(offset, end),
      countsByKind,
      truncated: nextCursor !== null,
      nextCursor,
      matchMode: mode === "search" || needle ? "literal-text" : null,
    };
  }
  return {
    list: (projectId: string, query: ProjectContentQuery = {}) =>
      read(projectId, query, "list"),
    search: (projectId: string, query: ProjectContentQuery = {}) =>
      read(projectId, query, "search"),
  };
}

export function createLocalProjectContentRoutes(options: {
  dataDir: string;
  authority?: LocalDocumentProjectAuthority;
}) {
  const app = new Hono();
  app.get("/api/v1/projects/:projectId/content", async (c) => {
    if (!options.authority)
      return c.json(
        { error: "Document Project authority is unavailable" },
        503,
      );
    const params = c.req.queries();
    if (
      Object.keys(params).some(
        (key) =>
          key !== "kind" &&
          key !== "kinds" &&
          key !== "limit" &&
          key !== "cursor" &&
          key !== "query",
      ) ||
      (params.kind && params.kinds) ||
      (params.kinds && params.kinds.length !== 1) ||
      (params.query && params.query.length !== 1) ||
      (params.cursor && params.cursor.length !== 1)
    )
      return c.json({ error: "Invalid content list query" }, 400);
    const kinds = params.kinds?.[0]?.split(",") ?? params.kind;
    const query = ProjectContentQuerySchema.safeParse({
      ...(kinds ? { kinds } : {}),
      ...(params.query ? { query: params.query[0] } : {}),
      ...(params.cursor ? { cursor: params.cursor[0] } : {}),
      ...(params.limit
        ? { limit: params.limit.length === 1 ? Number(params.limit[0]) : NaN }
        : {}),
    });
    if (!query.success)
      return c.json(
        { error: "Invalid content list query", details: query.error.issues },
        400,
      );
    return c.json(
      await createLocalProjectContentService({
        ...options,
        authority: options.authority,
      }).list(c.req.param("projectId"), query.data),
    );
  });
  app.post("/api/v1/projects/:projectId/content", async (c) => {
    if (!options.authority)
      return c.json(
        { error: "Document Project authority is unavailable" },
        503,
      );
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid content search JSON" }, 400);
    }
    const query = ProjectContentQuerySchema.safeParse(body);
    if (!query.success)
      return c.json(
        { error: "Invalid content search query", details: query.error.issues },
        400,
      );
    return c.json(
      await createLocalProjectContentService({
        ...options,
        authority: options.authority,
      }).search(c.req.param("projectId"), query.data),
    );
  });
  return app;
}
