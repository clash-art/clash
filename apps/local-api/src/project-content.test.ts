import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt";
import { afterEach, expect, it } from "vitest";
import {
  MODEL_TEXT_DOCUMENT_KIND,
  createProjectAsset,
  trashProjectAsset,
} from "@clash/shared-types";
import { createProjectContentClient } from "@clash/shared-runtime/project-content-client";
import { metadataBodyBlobPath } from "@clash/shared-runtime";
import { createLocalApiApp } from "./app.js";
import {
  createLocalDocumentProductService,
  type LocalDocumentProjectAuthority,
} from "./local-document-product.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-project-content-"));
  directories.push(dataDir);
  const projects = new Map([
    ["project", new LoroDoc()],
    ["other", new LoroDoc()],
  ]);
  const authority: LocalDocumentProjectAuthority = {
    inspect: async (id, read) => read(projects.get(id)!),
    mutate: async (id, write) =>
      write(projects.get(id)!, async () => undefined),
  };
  for (const doc of projects.values()) {
    for (const asset of [
      {
        id: "video",
        kind: "video" as const,
        name: "Take A",
        metadata: {
          contentType: "video/mp4",
          width: 1080,
          height: 1920,
          durationMs: 14000,
        },
      },
      {
        id: "photo",
        kind: "image" as const,
        name: "Portrait",
        metadata: { contentType: "image/jpeg", width: 758, height: 1102 },
      },
    ]) {
      expect(
        createProjectAsset(doc, {
          ...asset,
          source: { kind: "owned", resourceId: `resource-${asset.id}` },
          lifecycle: { state: "active" },
        }).ok,
      ).toBe(true);
    }
  }
  const producer = { kind: "actor", actor: { kind: "agent" } } as const;
  const documents = createLocalDocumentProductService({
    dataDir,
    authority,
    producer,
  });
  const app = createLocalApiApp({
    dataDir,
    userId: "user",
    documentProjectAuthority: authority,
  } as Parameters<typeof createLocalApiApp>[0]);
  const post = (body: unknown, project = "project") =>
    app.request(`/api/v1/projects/${project}/content`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, dataDir, documents, projects, producer, post };
}

it.each(["list", "search"] as const)(
  "continues %s beyond 200 items with complete refs and stable counts",
  async (mode) => {
    const { app, projects } = await fixture();
    const expected: string[] = [];
    for (let i = 0; i < 205; i += 1) {
      const id = `take-${String(i).padStart(3, "0")}`;
      expected.push(id);
      expect(
        createProjectAsset(projects.get("project")!, {
          id,
          kind: "video",
          name: "Batch take",
          source: { kind: "owned", resourceId: id },
          lifecycle: { state: "active" },
          metadata: {},
        }).ok,
      ).toBe(true);
    }
    const client = createProjectContentClient(async (path, init) =>
      app.request(path, init),
    );
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page += 1) {
      const result = await client[mode]("project", {
        query: "Batch",
        kinds: ["video"],
        limit: 100,
        cursor,
      });
      expect(result.countsByKind.video).toBe(205);
      for (const item of result.items) {
        expect(item.ref.kind).toBe("media");
        if (item.ref.kind === "media") ids.push(item.ref.projectAssetId);
      }
      expect(result.truncated).toBe(Boolean(result.nextCursor));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(ids).toEqual(expected);
  },
);

it("rejects malformed, changed-scope and stale cursors instead of silently skipping results", async () => {
  const { app, projects, post } = await fixture();
  const first = await (
    await app.request("/api/v1/projects/project/content?limit=1")
  ).json();
  expect(first.nextCursor).toEqual(expect.any(String));
  for (const url of [
    `/api/v1/projects/other/content?cursor=${encodeURIComponent(first.nextCursor)}`,
    `/api/v1/projects/project/content?kinds=video&cursor=${encodeURIComponent(first.nextCursor)}`,
  ]) {
    const response = await app.request(url);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "CONTENT_CURSOR_STALE",
    });
  }
  expect((await post({ cursor: first.nextCursor })).status).toBe(409);
  expect(
    (await app.request("/api/v1/projects/project/content?cursor=broken"))
      .status,
  ).toBe(400);
  expect(
    createProjectAsset(projects.get("project")!, {
      id: "new",
      kind: "image",
      name: "New photo",
      source: { kind: "owned", resourceId: "new" },
      lifecycle: { state: "active" },
      metadata: {},
    }).ok,
  ).toBe(true);
  const stale = await app.request(
    `/api/v1/projects/project/content?cursor=${encodeURIComponent(first.nextCursor)}`,
  );
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: "CONTENT_CURSOR_STALE" });
});

it("lists active media and current Document heads through the shared content surface", async () => {
  const { app, documents, projects } = await fixture();
  await documents.create("project", {
    documentAssetId: "notes",
    revisionId: "notes-r1",
    documentKind: "media.observation",
    schemaVersion: 1,
    body: { summary: "First observation" },
    sourceRefs: [],
  });
  await documents.advance("project", {
    documentAssetId: "notes",
    expectedHeadRevisionId: "notes-r1",
    revisionId: "notes-r2",
    body: { summary: "Updated observation" },
    sourceRefs: [],
  });
  expect(
    trashProjectAsset(projects.get("project")!, {
      id: "photo",
      deleteOperationId: "trash-photo",
      deletedAt: "2026-09-22T00:00:00.000Z",
      purgeAfter: "2026-10-22T00:00:00.000Z",
    }).ok,
  ).toBe(true);
  const response = await app.request("/api/v1/projects/project/content");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ truncated: false, matchMode: null });
  expect(body.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        ref: { kind: "media", projectAssetId: "video" },
        kind: "video",
        name: "Take A",
        info: expect.objectContaining({
          width: 1080,
          height: 1920,
          durationMs: 14000,
        }),
      }),
      expect.objectContaining({
        ref: {
          kind: "document",
          documentAssetId: "notes",
          revisionId: "notes-r2",
        },
        kind: "document",
        info: expect.objectContaining({ documentKind: "media.observation" }),
      }),
    ]),
  );
  expect(
    body.items.some(
      (item: { ref: { projectAssetId?: string } }) =>
        item.ref.projectAssetId === "photo",
    ),
  ).toBe(false);
  const filtered = await app.request(
    "/api/v1/projects/project/content?kind=document",
  );
  expect(await filtered.json()).toMatchObject({
    items: [{ ref: { documentAssetId: "notes", revisionId: "notes-r2" } }],
  });
  const client = createProjectContentClient(async (path, init) =>
    app.request(path, init),
  );
  expect(await client.list("project", { kinds: ["document"] })).toMatchObject({
    items: [
      {
        ref: { documentAssetId: "notes", revisionId: "notes-r2" },
        matches: [],
      },
    ],
  });
});

it("searches names and attached content but preserves old evidence independently of the Document head", async () => {
  const { post, documents, producer } = await fixture();
  const sourceRefs = [
    {
      slot: "source",
      target: { kind: "media" as const, projectAssetId: "video" },
    },
  ];
  const document = {
    kind: "document" as const,
    documentAssetId: "notes",
    revisionId: "notes-r1",
  };
  await documents.create("project", {
    documentAssetId: document.documentAssetId,
    revisionId: document.revisionId,
    documentKind: "media.observation",
    schemaVersion: 1,
    body: {
      summary: "Folding clothes",
      observations: [
        { text: "Left sleeve / 左侧袖子", startMs: 6000, endMs: 8000 },
      ],
    },
    sourceRefs,
  });
  await documents.attach("project", {
    id: "video-note",
    target: { kind: "project-asset", projectAssetId: "video" },
    slot: "notes",
    document,
  });
  await documents.advance("project", {
    documentAssetId: "notes",
    expectedHeadRevisionId: "notes-r1",
    revisionId: "notes-r2",
    body: { summary: "New unattached head" },
    sourceRefs,
  });
  const named = await post({ query: "ＴＡＫＥ" });
  expect(await named.json()).toMatchObject({
    items: [{ ref: { kind: "media", projectAssetId: "video" } }],
    matchMode: "literal-text",
    truncated: false,
  });
  const found = await post({ query: "ＳＬＥＥＶＥ" });
  const result = await found.json();
  expect(result).toMatchObject({
    items: [
      {
        ref: { kind: "media", projectAssetId: "video" },
        matches: [
          {
            text: "Left sleeve / 左侧袖子",
            document,
            documentKind: "media.observation",
            producer,
            sourceRefs,
            attachmentId: "video-note",
            location: {
              asset: { kind: "media", projectAssetId: "video" },
              startMs: 6000,
              endMs: 8000,
            },
          },
        ],
      },
    ],
    matchMode: "literal-text",
    truncated: false,
  });
  const pinned = await post({ query: "袖子", within: document });
  expect(await pinned.json()).toMatchObject({
    items: [
      {
        ref: document,
        kind: "document",
        matches: [{ document, text: "Left sleeve / 左侧袖子" }],
      },
    ],
  });
  expect(await (await post({ query: "袖子" }, "other")).json()).toMatchObject({
    items: [],
  });
  expect(
    await (
      await post({
        query: "袖子",
        within: { kind: "media", projectAssetId: "photo" },
      })
    ).json(),
  ).toMatchObject({ items: [] });
});

it("returns standalone Document content without claiming an ambiguous source-time location", async () => {
  const { post, documents } = await fixture();
  const document = {
    kind: "document" as const,
    documentAssetId: "comparison",
    revisionId: "comparison-r1",
  };
  await documents.create("project", {
    documentAssetId: document.documentAssetId,
    revisionId: document.revisionId,
    documentKind: "media.observation",
    schemaVersion: 1,
    body: {
      summary: "Compare sources",
      observations: [
        { text: "Cross-source evidence", startMs: 1000, endMs: 2000 },
      ],
    },
    sourceRefs: [
      { slot: "source", target: { kind: "media", projectAssetId: "video" } },
      { slot: "source", target: { kind: "media", projectAssetId: "photo" } },
    ],
  });
  const response = await post({ query: "cross-source", kinds: ["document"] });
  const body = await response.json();
  expect(body).toMatchObject({
    items: [
      { ref: document, matches: [{ document, text: "Cross-source evidence" }] },
    ],
    truncated: false,
  });
  expect(body.items[0].matches[0]).not.toHaveProperty("location");
  expect(
    await (await post({ query: "cross-source", kinds: ["video"] })).json(),
  ).toMatchObject({ items: [] });
});

it("reports truncation and rejects invalid query shapes or bounds at the Host", async () => {
  const { app, post } = await fixture();
  const limited = await app.request("/api/v1/projects/project/content?limit=1");
  const body = await limited.json();
  expect(body.items).toHaveLength(1);
  expect(body.truncated).toBe(true);
  expect(body.matchMode).toBeNull();
  for (const query of [
    { limit: 0 },
    { limit: 201 },
    { kinds: ["unknown"] },
    { unexpected: true },
  ]) {
    expect((await post(query)).status).toBe(400);
  }
  for (const response of [
    await app.request("/api/v1/projects/project/content?kinds=vedio"),
    await post({ query: "sleeve", kinds: ["vedio"] }),
  ]) {
    expect(response.status).toBe(400);
    const error = await response.json();
    expect(error.details[0].message).toMatch(
      /Invalid content kind.*vedio.*Did you mean.*video/,
    );
    expect(error.details[0].message).toContain(
      "image, video, audio, model, document",
    );
  }
  expect(
    (await app.request("/api/v1/projects/project/content?kind=unknown")).status,
  ).toBe(400);
  expect(
    (await app.request("/api/v1/projects/project/content?kinds=video,unknown"))
      .status,
  ).toBe(400);
  expect(
    (await app.request("/api/v1/projects/project/content?unexpected=ignored"))
      .status,
  ).toBe(400);
  expect(
    (
      await app.request("/api/v1/projects/project/content", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      })
    ).status,
  ).toBe(400);
});

it("searches standalone plain text without weakening its attachment policy", async () => {
  const { documents, post } = await fixture();
  const document = {
    kind: "document" as const,
    documentAssetId: "speech",
    revisionId: "speech-r1",
  };
  await documents.create("project", {
    documentAssetId: document.documentAssetId,
    revisionId: document.revisionId,
    documentKind: MODEL_TEXT_DOCUMENT_KIND,
    schemaVersion: 1,
    body: "服务同学，奉献校园。",
    sourceRefs: [],
  });
  expect(
    await (await post({ query: "服务同学", kinds: ["document"] })).json(),
  ).toMatchObject({
    items: [
      {
        ref: document,
        matches: [
          {
            field: "content",
            document,
            documentKind: MODEL_TEXT_DOCUMENT_KIND,
            text: "服务同学，奉献校园。",
          },
        ],
      },
    ],
  });
  await expect(
    documents.attach("project", {
      id: "invalid-plain-attachment",
      slot: "plain",
      target: { kind: "project-asset", projectAssetId: "video" },
      document,
    }),
  ).rejects.toThrow();
});

it("does not turn source time into the time of another attached media asset", async () => {
  const { documents, post } = await fixture();
  const document = {
    kind: "document" as const,
    documentAssetId: "source-note",
    revisionId: "source-note-r1",
  };
  await documents.create("project", {
    documentAssetId: document.documentAssetId,
    revisionId: document.revisionId,
    documentKind: "media.observation",
    schemaVersion: 1,
    body: {
      summary: "Source analysis",
      observations: [{ text: "source moment", startMs: 6000, endMs: 8000 }],
    },
    sourceRefs: [
      { slot: "source", target: { kind: "media", projectAssetId: "video" } },
    ],
  });
  await documents.attach("project", {
    id: "note-on-photo",
    slot: "source-observation",
    target: { kind: "project-asset", projectAssetId: "photo" },
    document,
  });
  const body = await (
    await post({
      query: "source moment",
      within: { kind: "media", projectAssetId: "photo" },
    })
  ).json();
  expect(body).toMatchObject({
    items: [
      {
        ref: { kind: "media", projectAssetId: "photo" },
        matches: [
          {
            location: {
              asset: { kind: "media", projectAssetId: "video" },
              startMs: 6000,
              endMs: 8000,
            },
          },
        ],
      },
    ],
  });
});

it("can list Document identities without opening their unavailable bodies", async () => {
  const { app, documents, dataDir } = await fixture();
  const saved = await documents.create("project", {
    documentAssetId: "offline-note",
    revisionId: "offline-note-r1",
    documentKind: "media.observation",
    schemaVersion: 1,
    body: { summary: "Temporarily unavailable bytes" },
    sourceRefs: [],
  });
  await rm(metadataBodyBlobPath(dataDir, saved.revision.body.digest));
  const response = await app.request(
    "/api/v1/projects/project/content?kinds=document",
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    items: [
      {
        ref: { documentAssetId: "offline-note", revisionId: "offline-note-r1" },
        matches: [],
      },
    ],
    matchMode: null,
  });
  for (const query of ["ＯＦＦＬＩＮＥ", "media.observation"]) {
    const filtered = await app.request(
      `/api/v1/projects/project/content?kinds=document&query=${encodeURIComponent(query)}`,
    );
    expect(filtered.status).toBe(200);
    expect(await filtered.json()).toMatchObject({
      items: [
        {
          ref: {
            documentAssetId: "offline-note",
            revisionId: "offline-note-r1",
          },
        },
      ],
      matchMode: "literal-text",
    });
  }
  expect(
    await (
      await app.request("/api/v1/projects/project/content?query=Temporarily")
    ).json(),
  ).toMatchObject({ items: [] });
  for (const query of ["VIDEO", "1080"]) {
    const filtered = await app.request(
      `/api/v1/projects/project/content?query=${query}`,
    );
    expect(await filtered.json()).toMatchObject({
      items: [{ ref: { kind: "media", projectAssetId: "video" } }],
      matchMode: "literal-text",
    });
  }
});

it("counts all matching kinds before kind filtering and truncation without reading list bodies", async () => {
  const { app, documents, projects, dataDir } = await fixture();
  for (const [id, kind, name] of [
    ["second-video", "video", "Take B"],
    ["sound", "audio", "Take soundtrack"],
    ["mesh", "model", "Stage model"],
  ] as const) {
    expect(
      createProjectAsset(projects.get("project")!, {
        id,
        kind,
        name,
        source: { kind: "owned", resourceId: id },
        lifecycle: { state: "active" },
        metadata: {},
      }).ok,
    ).toBe(true);
  }
  const note = await documents.create("project", {
    documentAssetId: "take-note",
    revisionId: "take-note-r1",
    documentKind: "text.plain",
    schemaVersion: 1,
    body: "A body that overview must not read",
    sourceRefs: [],
  });
  await rm(metadataBodyBlobPath(dataDir, note.revision.body.digest));
  const full = await (
    await app.request("/api/v1/projects/project/content?kinds=video&limit=1")
  ).json();
  expect(full).toMatchObject({
    items: [{ kind: "video" }],
    truncated: true,
    countsByKind: { image: 1, video: 2, audio: 1, model: 1, document: 1 },
  });
  const matching = await (
    await app.request(
      "/api/v1/projects/project/content?query=take&kinds=image&limit=1",
    )
  ).json();
  expect(matching).toMatchObject({
    items: [],
    truncated: false,
    countsByKind: { image: 0, video: 2, audio: 1, model: 0, document: 1 },
  });
  expect(
    await (await app.request("/api/v1/projects/other/content?limit=1")).json(),
  ).toMatchObject({
    countsByKind: { image: 1, video: 1, audio: 0, model: 0, document: 0 },
  });
});

it("counts matched objects once across evidence fragments while honoring project and exact-reference scope", async () => {
  const { post, documents, projects } = await fixture();
  expect(
    createProjectAsset(projects.get("project")!, {
      id: "sound",
      kind: "audio",
      name: "Folding soundtrack",
      source: { kind: "owned", resourceId: "sound" },
      lifecycle: { state: "active" },
      metadata: {},
    }).ok,
  ).toBe(true);
  const document = {
    kind: "document" as const,
    documentAssetId: "notes",
    revisionId: "notes-r1",
  };
  await documents.create("project", {
    documentAssetId: document.documentAssetId,
    revisionId: document.revisionId,
    documentKind: "media.observation",
    schemaVersion: 1,
    body: {
      summary: "Folding clothes",
      observations: [
        { text: "Folding left sleeve" },
        { text: "Folding right sleeve" },
      ],
    },
    sourceRefs: [],
  });
  for (const id of ["video", "photo"])
    await documents.attach("project", {
      id: `evidence-${id}`,
      target: { kind: "project-asset", projectAssetId: id },
      slot: "notes",
      document,
    });
  await documents.advance("project", {
    documentAssetId: "notes",
    expectedHeadRevisionId: "notes-r1",
    revisionId: "notes-r2",
    body: { summary: "Unmatched current head" },
    sourceRefs: [],
  });
  await documents.create("project", {
    documentAssetId: "speech",
    revisionId: "speech-r1",
    documentKind: "text.plain",
    schemaVersion: 1,
    body: "Folding speech",
    sourceRefs: [],
  });
  for (const kinds of [undefined, ["video"]]) {
    const result = await (
      await post({ query: "folding", kinds, limit: 1 })
    ).json();
    expect(result).toMatchObject({
      countsByKind: { image: 1, video: 1, audio: 1, model: 0, document: 1 },
      truncated: kinds === undefined,
    });
    expect(result.items).toHaveLength(1);
    if (kinds) expect(result.items[0].kind).toBe("video");
  }
  expect(
    await (
      await post({ query: "folding", within: document, kinds: ["video"] })
    ).json(),
  ).toMatchObject({
    items: [],
    countsByKind: { image: 0, video: 0, audio: 0, model: 0, document: 1 },
  });
  expect(
    await (
      await post({
        query: "folding",
        within: { kind: "media", projectAssetId: "photo" },
      })
    ).json(),
  ).toMatchObject({
    countsByKind: { image: 1, video: 0, audio: 0, model: 0, document: 0 },
  });
  expect(
    await (await post({ query: "folding" }, "other")).json(),
  ).toMatchObject({
    items: [],
    countsByKind: { image: 0, video: 0, audio: 0, model: 0, document: 0 },
  });
});
