import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt";
import { afterEach, expect, it } from "vitest";
import {
  AssetEvidenceSearchResultSchema,
  createProjectAsset,
  trashProjectAsset,
} from "@clash/shared-types";
import {
  createLocalDocumentProductService,
  type LocalDocumentProjectAuthority,
} from "./local-document-product.js";
import { createLocalApiApp } from "./app.js";
import { createAssetEvidenceClient } from "@clash/shared-runtime/asset-evidence-client";
import { createAssetSearchClient } from "@clash/shared-runtime/asset-search-client";
import { createActionsCommand } from "../../../packages/cli/src/commands/actions";
import { registerActionTools } from "../../../packages/shared-mcp/src/action-tools";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-evidence-search-"));
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
  const producer = { kind: "actor", actor: { kind: "agent" } } as const;
  const documents = createLocalDocumentProductService({
    dataDir,
    authority,
    producer,
  });
  for (const doc of projects.values()) {
    for (const id of ["original", "cropped"]) {
      expect(
        createProjectAsset(doc, {
          id,
          kind: "video",
          source: { kind: "owned", resourceId: `resource-${id}` },
          lifecycle: { state: "active" },
          metadata: { contentType: "video/mp4" },
        }).ok,
      ).toBe(true);
    }
  }
  return { dataDir, authority, documents, producer, projects };
}

it.each(["cli", "mcp"] as const)(
  "retains agent attribution for %s external observations and operation records",
  async (transport) => {
    const { dataDir, authority } = await fixture();
    const app = createLocalApiApp({
      dataDir,
      userId: "user",
      documentProjectAuthority: authority,
    } as Parameters<typeof createLocalApiApp>[0]);
    const request = async (path: string, init?: RequestInit) =>
      app.request(path, init);
    const body = {
      summary: "agent-reviewed folding sequence",
      tool: "external visual review",
      observations: [{ text: "folding completed", startMs: 1000, endMs: 2000 }],
    };
    if (transport === "cli") {
      const file = join(dataDir, "observation.json");
      await writeFile(file, JSON.stringify(body));
      for (const args of [
        [
          "observe",
          "--asset",
          "original",
          "--file",
          file,
          "--record-id",
          "agent-observation",
        ],
        [
          "record",
          "--source",
          "original",
          "--output",
          "cropped",
          "--title",
          "agent crop",
          "--detail",
          "external crop command",
          "--record-id",
          "agent-operation",
        ],
      ]) {
        await createActionsCommand({
          request,
          output: () => undefined,
        }).parseAsync(["node", "actions", ...args, "--project", "project"]);
      }
    } else {
      const calls = new Map<
        string,
        (args: Record<string, unknown>) => Promise<unknown>
      >();
      registerActionTools(
        {
          registerTool: (
            name: string,
            _config: unknown,
            call: (args: Record<string, unknown>) => Promise<unknown>,
          ) => calls.set(name, call),
        } as never,
        { request },
      );
      await calls.get("clash_assets_record_observation")!({
        projectId: "project",
        assetId: "original",
        body,
        recordId: "agent-observation",
      });
      await calls.get("clash_assets_record_operation")!({
        projectId: "project",
        sources: ["original"],
        outputs: ["cropped"],
        title: "agent crop",
        detail: "external crop command",
        recordId: "agent-operation",
      });
    }
    const search = createAssetSearchClient(request);
    for (const [assetId, query] of [
      ["original", "folding completed"],
      ["cropped", "external crop command"],
    ]) {
      const result = await search.search("project", { assetId, query });
      expect(result.matches).toEqual([
        expect.objectContaining({
          producer: { kind: "actor", actor: { kind: "agent" } },
          text: expect.stringContaining(query),
        }),
      ]);
    }
  },
);

it("stores an external operation as an immutable actor-authored document without inventing a Run", async () => {
  const { documents, producer } = await fixture();
  const body = {
    title: "裁剪视频",
    detail:
      "ffmpeg -i input.mp4 -ss 2 -t 6 output.mp4\nExternal command, recorded only.",
  };
  const sourceRefs = [
    {
      slot: "source",
      target: { kind: "media" as const, projectAssetId: "original" },
    },
    {
      slot: "output",
      target: { kind: "media" as const, projectAssetId: "cropped" },
    },
  ];
  const created = await documents.create("project", {
    documentAssetId: "trace",
    revisionId: "trace-r1",
    documentKind: "media.operation-trace",
    schemaVersion: 1,
    body,
    sourceRefs,
  });
  await documents.attach("project", {
    id: "trace-output",
    slot: "operation-trace",
    target: { kind: "project-asset", projectAssetId: "cropped" },
    document: {
      kind: "document",
      documentAssetId: "trace",
      revisionId: "trace-r1",
    },
  });
  expect(created.revision).toMatchObject({
    producer,
    sourceRefs,
    mutability: "immutable",
  });
  expect(
    (
      await documents.readRevision("project", {
        documentAssetId: "trace",
        revisionId: "trace-r1",
      })
    )?.body,
  ).toEqual(body);
  await expect(
    documents.advance("project", {
      documentAssetId: "trace",
      expectedHeadRevisionId: "trace-r1",
      revisionId: "trace-r2",
      body: { ...body, detail: "changed" },
      sourceRefs,
    }),
  ).rejects.toThrow(/immutable/i);
});

it("finds external timed observations at their attached revision and excludes other projects", async () => {
  const { dataDir, authority, documents, producer } = await fixture();
  const sourceRefs = [
    {
      slot: "source",
      target: { kind: "media" as const, projectAssetId: "original" },
    },
  ];
  const body = {
    summary: "生活片段",
    tool: "external-review",
    observations: [{ text: "叠衣服", startMs: 2000, endMs: 8000 }],
  };
  await documents.create("project", {
    documentAssetId: "observation",
    revisionId: "observed-r1",
    documentKind: "media.observation",
    schemaVersion: 1,
    body,
    sourceRefs,
  });
  await documents.attach("project", {
    id: "observed-source",
    slot: "observation",
    target: { kind: "project-asset", projectAssetId: "original" },
    document: {
      kind: "document",
      documentAssetId: "observation",
      revisionId: "observed-r1",
    },
  });
  await documents.advance("project", {
    documentAssetId: "observation",
    expectedHeadRevisionId: "observed-r1",
    revisionId: "observed-r2",
    body: { summary: "新修订仍未关联" },
    sourceRefs,
  });
  const app = createLocalApiApp({
    dataDir,
    userId: "user",
    documentProjectAuthority: authority,
  } as Parameters<typeof createLocalApiApp>[0]);
  const response = await app.request(
    "/api/v1/projects/project/asset-search?query=" +
      encodeURIComponent("叠衣服"),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    matches: [
      {
        projectAssetId: "original",
        document: { documentAssetId: "observation", revisionId: "observed-r1" },
        text: "叠衣服",
        startMs: 2000,
        endMs: 8000,
        producer,
        sourceRefs,
      },
    ],
  });
  const other = await app.request(
    "/api/v1/projects/other/asset-search?query=" + encodeURIComponent("叠衣服"),
  );
  expect(await other.json()).toEqual({ matches: [], truncated: false });
  const unrelated = await app.request(
    "/api/v1/projects/project/asset-search?assetId=cropped",
  );
  expect(await unrelated.json()).toEqual({ matches: [], truncated: false });
});

it("shares generic search's pinned evidence without assigning source times to a derived Asset", async () => {
  const { dataDir, authority, documents } = await fixture();
  const document = {
    kind: "document" as const,
    documentAssetId: "shared-observation",
    revisionId: "reviewed-original",
  };
  const sourceRefs = [
    {
      slot: "source",
      target: { kind: "media" as const, projectAssetId: "original" },
    },
  ];
  await documents.create("project", {
    documentAssetId: document.documentAssetId,
    revisionId: document.revisionId,
    documentKind: "media.observation",
    schemaVersion: 1,
    body: {
      summary: "生活片段",
      observations: [{ text: "叠衣服", startMs: 2000, endMs: 8000 }],
    },
    sourceRefs,
  });
  for (const projectAssetId of ["original", "cropped"]) {
    await documents.attach("project", {
      id: `shared-${projectAssetId}`,
      slot: "observation",
      target: { kind: "project-asset", projectAssetId },
      document,
    });
  }
  await documents.advance("project", {
    documentAssetId: document.documentAssetId,
    expectedHeadRevisionId: document.revisionId,
    revisionId: "unattached-new-head",
    body: { summary: "新修订没有原观察" },
    sourceRefs,
  });
  const app = createLocalApiApp({
    dataDir,
    userId: "user",
    documentProjectAuthority: authority,
  } as Parameters<typeof createLocalApiApp>[0]);
  const response = await app.request(
    "/api/v1/projects/project/asset-search?query=" +
      encodeURIComponent("叠衣服"),
  );
  expect(response.status).toBe(200);
  const legacy = await response.json();
  expect(
    legacy.matches.find(
      (match: { projectAssetId: string }) =>
        match.projectAssetId === "original",
    ),
  ).toMatchObject({ document, startMs: 2000, endMs: 8000 });
  const derived = legacy.matches.find(
    (match: { projectAssetId: string }) => match.projectAssetId === "cropped",
  );
  expect(derived).toMatchObject({ document, sourceRefs, text: "叠衣服" });
  expect(derived.startMs).toBeUndefined();
  expect(derived.endMs).toBeUndefined();
  const client = createAssetSearchClient(async (path, init) =>
    app.request(path, init),
  );
  expect(legacy).toEqual(await client.search("project", { query: "叠衣服" }));
});

it("reports generic search truncation through the legacy result contract", async () => {
  const { dataDir, authority, documents, projects } = await fixture();
  const document = {
    kind: "document" as const,
    documentAssetId: "many-attachments",
    revisionId: "review",
  };
  await documents.create("project", {
    documentAssetId: document.documentAssetId,
    revisionId: document.revisionId,
    documentKind: "media.observation",
    schemaVersion: 1,
    body: { summary: "shared evidence" },
    sourceRefs: [],
  });
  // Exceed the content API's supported maximum page size with real matching Assets.
  for (let index = 0; index < 201; index += 1) {
    const id = `clip-${index}`;
    expect(
      createProjectAsset(projects.get("project")!, {
        id,
        kind: "video",
        source: { kind: "owned", resourceId: `resource-${id}` },
        lifecycle: { state: "active" },
        metadata: { contentType: "video/mp4" },
      }).ok,
    ).toBe(true);
    await documents.attach("project", {
      id: `evidence-${id}`,
      slot: "observation",
      target: { kind: "project-asset", projectAssetId: id },
      document,
    });
  }
  const app = createLocalApiApp({
    dataDir,
    userId: "user",
    documentProjectAuthority: authority,
  } as Parameters<typeof createLocalApiApp>[0]);
  const response = await app.request(
    "/api/v1/projects/project/asset-search?query=evidence",
  );
  expect(response.status).toBe(200);
  const legacy = AssetEvidenceSearchResultSchema.parse(await response.json());
  expect(legacy.truncated).toBe(true);
  const client = createAssetSearchClient(async (path, init) =>
    app.request(path, init),
  );
  expect(legacy).toEqual(await client.search("project", { query: "evidence" }));
  expect(AssetEvidenceSearchResultSchema.parse({ matches: [] })).toEqual({
    matches: [],
  });
});

it("retries a one-call external recording without duplicate documents and rejects changed replay content", async () => {
  const { dataDir, authority, documents } = await fixture();
  const app = createLocalApiApp({
    dataDir,
    userId: "user",
    documentProjectAuthority: authority,
  } as Parameters<typeof createLocalApiApp>[0]);
  const client = createAssetEvidenceClient(async (path, init) =>
    app.request(path, init),
  );
  const input = {
    recordId: "manual-crop",
    title: "外部裁剪",
    detail: "ffmpeg -i input.mp4 -vf crop=100:100:0:0 output.mp4",
    sources: ["original"],
    outputs: ["cropped"],
  };
  const first = await client.recordTrace("project", input);
  const second = await client.recordTrace("project", input);
  expect(second).toEqual(first);
  expect(await documents.list("project")).toEqual([
    expect.objectContaining({ id: first.document.documentAssetId }),
  ]);
  expect(await documents.listAttachments("project")).toEqual(first.attachments);
  expect(JSON.stringify(first)).not.toContain("readToken");
  await expect(
    client.recordTrace("project", { ...input, detail: "different command" }),
  ).rejects.toThrow();
  const observed = await client.recordObservation("project", {
    recordId: "reviewed",
    assetId: "cropped",
    body: {
      summary: "叠衣服",
      tool: "human-review",
      observations: [{ text: "衣服叠好", startMs: 1000, endMs: 4000 }],
    },
  });
  expect(observed.attachments).toEqual([
    expect.objectContaining({
      target: { kind: "project-asset", projectAssetId: "cropped" },
      document: observed.document,
    }),
  ]);
});

it("repairs a failed attachment on replay and exposes the saved command as inert evidence", async () => {
  const { dataDir, authority, documents } = await fixture();
  const app = createLocalApiApp({
    dataDir,
    userId: "user",
    documentProjectAuthority: authority,
  } as Parameters<typeof createLocalApiApp>[0]);
  let failAttachment = true;
  const client = createAssetEvidenceClient(async (path, init) => {
    if (
      failAttachment &&
      path.endsWith("/document-attachments") &&
      init?.method === "POST"
    ) {
      failAttachment = false;
      return new Response("temporarily unavailable", { status: 503 });
    }
    const headers = new Headers(init?.headers);
    headers.set("x-clash-client-type", "agent");
    return app.request(path, { ...init, headers });
  });
  const input = {
    recordId: "retry-crop",
    title: "旋转",
    detail: "ffmpeg -i original.mp4 -vf transpose=1 cropped.mp4",
    sources: ["original"],
    outputs: ["cropped"],
  };
  await expect(client.recordTrace("project", input)).rejects.toThrow(/503/);
  expect(await documents.listAttachments("project")).toEqual([]);
  const repaired = await client.recordTrace("project", input);
  const search = createAssetSearchClient(async (path, init) =>
    app.request(path, init),
  );
  const found = await search.search("project", {
    assetId: "cropped",
    query: "transpose=1",
  });
  expect(found.matches).toEqual([
    expect.objectContaining({
      document: repaired.document,
      text: expect.stringContaining(input.detail),
      producer: { kind: "actor", actor: { kind: "agent" } },
    }),
  ]);
});

it("returns a replay identity after an uncertain save when the caller omitted recordId", async () => {
  const { dataDir, authority, documents } = await fixture();
  const app = createLocalApiApp({
    dataDir,
    userId: "user",
    documentProjectAuthority: authority,
  } as Parameters<typeof createLocalApiApp>[0]);
  let fail = true;
  const client = createAssetEvidenceClient(async (path, init) => {
    if (fail && path.endsWith("/document-attachments")) {
      fail = false;
      return new Response("connection interrupted", { status: 503 });
    }
    return app.request(path, init);
  });
  const input = {
    title: "外部处理",
    detail: "command recorded only",
    sources: ["original", "cropped"],
    outputs: ["cropped"],
  };
  let failed: unknown;
  try {
    await client.recordTrace("project", input);
  } catch (error) {
    failed = error;
  }
  expect(failed).toMatchObject({
    recordId: expect.any(String),
    document: {
      documentAssetId: expect.any(String),
      revisionId: expect.any(String),
    },
  });
  const recovery = failed as {
    recordId: string;
    document: { documentAssetId: string };
  };
  const saved = await client.recordTrace("project", {
    ...input,
    recordId: recovery.recordId,
  });
  expect(saved.document.documentAssetId).toBe(
    recovery.document.documentAssetId,
  );
  expect(await documents.list("project")).toEqual([
    expect.objectContaining({ id: saved.document.documentAssetId }),
  ]);
});

it("searches native timed transcripts and stops returning an Asset after it is trashed", async () => {
  const { dataDir, authority, documents, projects } = await fixture();
  const body = {
    schemaVersion: 1,
    kind: "clash.asr.timed-transcript",
    timebase: "milliseconds",
    alignment: "word",
    text: "认真负责",
    backendId: "external-asr",
    modelId: "actual-model",
    durationMs: 3000,
    words: [{ id: "word-1", text: "认真负责", startMs: 1000, endMs: 2500 }],
    segments: [
      {
        id: "segment-1",
        text: "认真负责",
        startMs: 1000,
        endMs: 2500,
        wordIds: ["word-1"],
      },
    ],
  };
  await documents.create("project", {
    documentAssetId: "speech",
    revisionId: "speech-r1",
    documentKind: "media.transcript",
    schemaVersion: 1,
    body,
    sourceRefs: [
      { slot: "source", target: { kind: "media", projectAssetId: "original" } },
    ],
  });
  await documents.attach("project", {
    id: "speech-source",
    slot: "transcript",
    target: { kind: "project-asset", projectAssetId: "original" },
    document: {
      kind: "document",
      documentAssetId: "speech",
      revisionId: "speech-r1",
    },
  });
  const app = createLocalApiApp({
    dataDir,
    userId: "user",
    documentProjectAuthority: authority,
  } as Parameters<typeof createLocalApiApp>[0]);
  const search = createAssetSearchClient(async (path, init) =>
    app.request(path, init),
  );
  expect(
    (await search.search("project", { query: "认真负责" })).matches,
  ).toEqual([
    expect.objectContaining({
      documentKind: "media.transcript",
      text: body.segments[0]!.text,
      startMs: body.segments[0]!.startMs,
      endMs: body.segments[0]!.endMs,
    }),
  ]);
  expect(
    (await search.search("project", { query: body.modelId })).matches,
  ).toEqual([]);
  expect(
    trashProjectAsset(projects.get("project")!, {
      id: "original",
      deleteOperationId: "trash",
      deletedAt: "2026-09-22T00:00:00.000Z",
      purgeAfter: "2026-10-22T00:00:00.000Z",
    }).ok,
  ).toBe(true);
  expect(
    (await search.search("project", { query: "认真负责" })).matches,
  ).toEqual([]);
});
