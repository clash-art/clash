import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, it } from "vitest";
import {
  createActionAssetBinding,
  listActionAssetBindings,
  listActionAssetReferences,
  listProjectAssets,
  readProjectAsset,
} from "@clash/shared-types";

import { managedLocalApiApps } from "./local-api-app.test-fixtures.js";
import {
  createLocalAssetInspectionService,
  type LocalAssetInspector,
} from "./local-asset-inspections.js";
import { createSqliteDurableRunJournal } from "./durable-run-journal.js";
import {
  createLocalProjectAssetService,
  type LocalProjectAssetReplica,
} from "./local-project-assets.js";
import { FileReplicaStore } from "./loro/file-replica-store.js";
import { LocalLoroRoomHub } from "./sync.js";

const temporaryDirectories: string[] = [];
const { createApp: createLocalApiApp, close: closeApps } = managedLocalApiApps();
const PROJECT_ASSET_RECEIPT_RE =
  /^project-asset-v1:[a-f0-9]{16}:receipt:[A-Za-z0-9._~-]+$/;

const inspectFixtureAsset: LocalAssetInspector = async ({ resource }) =>
  resource.kind === "image"
    ? {
        width: 1,
        height: 1,
        rotationDegrees: 0,
        contentType: resource.contentType ?? "image/png",
      }
    : resource.kind === "video"
      ? {
          width: 1,
          height: 1,
          rotationDegrees: 0,
          durationMs: 2_000,
          frameRate: 24,
          videoCodec: "h264",
          hasAudio: false,
          contentType: resource.contentType ?? "video/mp4",
        }
      : {
          durationMs: 2_000,
          hasAudio: true,
          audioCodec: "mp3",
          sampleRate: 48_000,
          channelCount: 2,
          channelLayout: "stereo",
          contentType: resource.contentType ?? "audio/mpeg",
        };

function projectTrashRequest(
  deleteOperationId: string,
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method: "DELETE",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ deleteOperationId }),
  };
}

async function fixture() {
  const clashRoot = await mkdtemp(
    join(tmpdir(), "clash-project-asset-routes-"),
  );
  temporaryDirectories.push(clashRoot);
  const dataDir = join(clashRoot, "local-api");
  const service = createLocalProjectAssetService({
    dataDir,
    clashRoot,
    projectionOrigin: "http://seed.invalid",
    assetInspection: createLocalAssetInspectionService({
      dataDir,
      clashRoot,
      inspectResource: inspectFixtureAsset,
    }),
  });
  const asset = await service.installOwned({
    projectId: "project-a",
    projectAssetId: "result:one",
    kind: "audio",
    bytes: new TextEncoder().encode("0123456789"),
    contentType: "audio/mpeg",
    name: "result.unusual",
    metadata: { durationMs: 2_000 },
    provenance: { kind: "generation", actionRunId: "run-1" },
  });
  const appOptions = {
    dataDir,
    clashRoot,
    userId: "local-user",
    projectAssetProjectionOrigin: () => "http://127.0.0.1:49152",
    inspectAssetResource: inspectFixtureAsset,
  };
  return {
    app: createLocalApiApp(appOptions),
    asset,
    service,
    clashRoot,
    dataDir,
  };
}

function editBindingCollisionReplica(input: {
  doc: LoroDoc;
  actionId: "image-editor" | "video-clipper";
  sourceAssetId: string;
}): {
  replica: LocalProjectAssetReplica;
  arm(): void;
  actionRunId(): string | null;
} {
  let armed = false;
  let collisionRunId: string | null = null;
  return {
    replica: {
      inspect: async (_id, read) => read(input.doc),
      mutate: async (_id, mutation) => {
        if (armed && collisionRunId === null) {
          const probe = input.doc.fork();
          await mutation(probe);
          const editOutput = listProjectAssets(probe).find(
            (entry) =>
              entry.provenance?.kind === "edit" &&
              !readProjectAsset(input.doc, entry.id),
          );
          const actionRunId = editOutput?.provenance?.actionRunId;
          if (actionRunId) {
            collisionRunId = actionRunId;
            const collision = createActionAssetBinding(input.doc, {
              id: `action-asset:${actionRunId}:output`,
              owner: {
                kind: "run",
                actionId: input.actionId,
                actionRevisionId: "collision-revision",
                actionRunId,
              },
              direction: "output",
              slot: "already-claimed",
              projectAssetId: input.sourceAssetId,
              role: "primary",
            });
            expect(collision).toMatchObject({ ok: true });
          }
        }
        return (await mutation(input.doc)).value;
      },
    },
    arm() {
      armed = true;
    },
    actionRunId() {
      return collisionRunId;
    },
  };
}

afterEach(async () => {
  await closeApps();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Project-scoped ResolvedAsset routes", () => {
  it("commits HTTP Asset lifecycle writes through the open Project room", async () => {
    const clashRoot = await mkdtemp(
      join(tmpdir(), "clash-project-asset-live-room-"),
    );
    temporaryDirectories.push(clashRoot);
    const dataDir = join(clashRoot, "local-api");
    const projectId = "live-project";
    const hub = new LocalLoroRoomHub(dataDir, undefined, null);
    const room = await hub.room(projectId);
    const peer = new LoroDoc();
    room.addPeer((update) => peer.import(update));

    const replica: LocalProjectAssetReplica = {
      inspect: (id, read) => hub.inspectProject(id, read),
      mutate: (id, mutation) => hub.mutateProject(id, mutation),
    };
    const app = createLocalApiApp({
      dataDir,
      clashRoot,
      userId: "local-user",
      projectAssetProjectionOrigin: "http://127.0.0.1:49152",
      projectAssetReplica: replica,
      inspectAssetResource: async ({ resource }) => ({
        width: 1,
        height: 1,
        rotationDegrees: 0,
        contentType: resource.contentType ?? "image/png",
      }),
    });

    const bytes = new TextEncoder().encode("live room image");
    const collectionUrl = `http://127.0.0.1:49152/api/v1/projects/${projectId}/assets`;
    const assetUrl = `${collectionUrl}/live%3Aasset`;

    const form = new FormData();
    form.set("file", new File([bytes], "live.png", { type: "image/png" }));
    form.set("kind", "image");
    form.set("projectAssetId", "live:asset");

    const imported = await app.request(`${collectionUrl}/import-file`, {
      method: "POST",
      body: form,
    });
    expect(imported.status, await imported.clone().text()).toBe(201);
    expect(readProjectAsset(peer, "live:asset")?.lifecycle).toEqual({
      state: "active",
    });

    const trashed = await app.request(
      assetUrl,
      projectTrashRequest("delete:live-room"),
    );
    expect(trashed.status, await trashed.clone().text()).toBe(200);
    expect(readProjectAsset(peer, "live:asset")?.lifecycle.state).toBe(
      "trashed",
    );

    const restored = await app.request(`${assetUrl}/restore`, {
      method: "POST",
    });
    expect(restored.status).toBe(200);
    expect(readProjectAsset(peer, "live:asset")?.lifecycle).toEqual({
      state: "active",
    });
  });

  it("lists and reads the same storage-free ResolvedAsset shape at the configured Host origin", async () => {
    const { app, asset } = await fixture();
    const baseUrl = "http://127.0.0.1:49152/api/v1/projects/project-a/assets";
    const mediaUrl = `${baseUrl}/${encodeURIComponent(asset.id)}/media`;
    const expected = {
      id: "result:one",
      kind: "audio",
      name: "result.unusual",
      metadata: {
        durationMs: 2_000,
        hasAudio: true,
        audioCodec: "mp3",
        sampleRate: 48_000,
        channelCount: 2,
        channelLayout: "stereo",
        bytes: 10,
        contentType: "audio/mpeg",
        originalName: "result.unusual",
      },
      provenance: { kind: "generation", actionRunId: "run-1" },
      lifecycle: { state: "active" },
      status: "ready",
      url: mediaUrl,
    };

    const listed = await app.request(
      "http://localhost:49152/api/v1/projects/project-a/assets",
    );
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody).toMatchObject({ assets: [expected] });
    expect(listedBody.assets[0].createdAt).toEqual(expect.any(Number));

    const read = await app.request(
      `${baseUrl}/${encodeURIComponent(asset.id)}`,
    );
    expect(read.status).toBe(200);
    expect(read.headers.get("x-clash-read-receipt")).toMatch(
      PROJECT_ASSET_RECEIPT_RE,
    );
    expect(await read.json()).toEqual(listedBody.assets[0]);
  });

  it("serves the immutable projection with Resource content type and byte ranges", async () => {
    const { app, asset } = await fixture();
    const mediaUrl = `http://127.0.0.1:49152/api/v1/projects/project-a/assets/${encodeURIComponent(asset.id)}/media`;

    const full = await app.request(mediaUrl);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("audio/mpeg");
    expect(full.headers.get("content-length")).toBe("10");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    await expect(full.text()).resolves.toBe("0123456789");

    const partial = await app.request(mediaUrl, {
      headers: { range: "bytes=2-5" },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-type")).toBe("audio/mpeg");
    expect(partial.headers.get("content-length")).toBe("4");
    expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");
    await expect(partial.text()).resolves.toBe("2345");

    const unsatisfiable = await app.request(mediaUrl, {
      headers: { range: "bytes=99-100" },
    });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe("bytes */10");
  });

  it("batch reads only requested Asset entries from the selected Project", async () => {
    const { app, asset } = await fixture();
    const baseUrl = "http://127.0.0.1:49152/api/v1/projects/project-a/assets";

    const response = await app.request(`${baseUrl}/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["missing", asset.id, asset.id] }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      assets: [
        expect.objectContaining({
          id: "result:one",
          kind: "audio",
          status: "ready",
          url: `${baseUrl}/${encodeURIComponent(asset.id)}/media`,
        }),
      ],
    });
  });

  it("imports multipart bytes idempotently under an explicit Project Asset id and rejects conflicting bytes", async () => {
    const { app } = await fixture();
    const url =
      "http://127.0.0.1:49152/api/v1/projects/project-a/assets/import-file";
    const request = (value: string) => {
      const form = new FormData();
      form.set("file", new File([value], "hero.png", { type: "image/png" }));
      form.set("kind", "image");
      form.set("projectAssetId", "imported:multipart");
      return app.request(url, { method: "POST", body: form });
    };

    const first = await request("multipart image");
    const second = await request("multipart image");
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const expected = {
      id: "imported:multipart",
      kind: "image",
      name: "hero.png",
      metadata: {
        width: 1,
        height: 1,
        bytes: 15,
        contentType: "image/png",
        rotationDegrees: 0,
        originalName: "hero.png",
      },
      provenance: { kind: "import" },
      lifecycle: { state: "active" },
      status: "ready",
      url: "http://127.0.0.1:49152/api/v1/projects/project-a/assets/imported%3Amultipart/media",
      thumbnailUrl:
        "http://127.0.0.1:49152/api/v1/projects/project-a/assets/imported%3Amultipart/media",
    };
    const imported = await first.json();
    expect(imported).toMatchObject(expected);
    expect(imported.createdAt).toEqual(expect.any(Number));
    await expect(second.json()).resolves.toEqual(imported);
    expect(JSON.stringify(imported)).not.toMatch(
      /storageKey|localBlobKey|signedUrl|\/Users\//,
    );

    const conflicting = await request("different immutable bytes");
    expect(conflicting.status, await conflicting.clone().text()).toBe(409);
    await expect(conflicting.json()).resolves.toMatchObject({
      code: "PROJECT_ASSET_ID_COLLISION",
    });
  });

  it("publishes edit outputs as ResolvedAsset and records Action input/output bindings", async () => {
    const { app, dataDir } = await fixture();
    const importForm = new FormData();
    importForm.set(
      "file",
      new File(["source image"], "source.png", { type: "image/png" }),
    );
    importForm.set("kind", "image");
    importForm.set("projectAssetId", "source:image");
    const imported = await app.request(
      "http://127.0.0.1:49152/api/v1/projects/project-a/assets/import-file",
      { method: "POST", body: importForm },
    );
    expect(imported.status).toBe(201);

    const invocation = {
      actionId: "image-editor",
      projectId: "project-a",
      source: { assetId: "source:image", kind: "image" },
      params: { rotation: 90 },
      surface: "asset-preview",
      mode: "implicit",
    };
    const editForm = new FormData();
    editForm.set(
      "file",
      new File(["edited image"], "edited.png", { type: "image/png" }),
    );
    editForm.set("projectId", "project-a");
    editForm.set("sourceAssetId", "source:image");
    editForm.set("editKind", "image-editor");
    editForm.set("outputKind", "image");
    editForm.set("editParams", JSON.stringify(invocation.params));
    editForm.set("origin", "asset-preview");
    editForm.set("invocation", JSON.stringify(invocation));
    editForm.set("actionRunId", "edit:route-replay-1");

    const first = await app.request("/api/v1/edits", {
      method: "POST",
      body: editForm,
    });
    const replay = await app.request("/api/v1/edits", {
      method: "POST",
      body: editForm,
    });
    expect(first.status, await first.clone().text()).toBe(200);
    expect(replay.status, await replay.clone().text()).toBe(200);
    const output = (await first.json()) as { id: string };
    await expect(replay.json()).resolves.toEqual(output);
    expect(output).toMatchObject({
      id: expect.stringMatching(/^asset:edit:/),
      kind: "image",
      name: "edited.png",
      provenance: {
        kind: "edit",
        actionRunId: "edit:route-replay-1",
        model: "implicit:image-editor",
      },
      status: "ready",
      url: expect.stringContaining("/api/v1/projects/project-a/assets/"),
    });
    expect(JSON.stringify(output)).not.toMatch(
      /srcR2Key|storageKey|signedUrl|coverR2Key/,
    );

    const doc = await new FileReplicaStore(join(dataDir, "projects")).recover(
      "project-a",
    );
    expect(listActionAssetReferences(doc, "source:image")).toMatchObject([
      {
        direction: "input",
        slot: "source",
        projectAssetId: "source:image",
        role: "source",
      },
    ]);
    expect(listActionAssetReferences(doc, output.id)).toMatchObject([
      {
        direction: "output",
        slot: "output",
        projectAssetId: output.id,
        role: "primary",
      },
    ]);
    expect(
      listProjectAssets(doc).filter(
        (entry) => entry.provenance?.actionRunId === "edit:route-replay-1",
      ),
    ).toHaveLength(1);
    expect(
      listActionAssetBindings(doc).filter(
        (binding) =>
          binding.owner.kind === "run" &&
          binding.owner.actionRunId === "edit:route-replay-1",
      ),
    ).toHaveLength(2);
  });

  it("rejects reuse of an edit actionRunId for different immutable output bytes", async () => {
    const { app, dataDir } = await fixture();
    const sourceForm = new FormData();
    sourceForm.set(
      "file",
      new File(["source image"], "source.png", { type: "image/png" }),
    );
    sourceForm.set("kind", "image");
    sourceForm.set("projectAssetId", "source:image");
    const imported = await app.request(
      "http://127.0.0.1:49152/api/v1/projects/project-a/assets/import-file",
      { method: "POST", body: sourceForm },
    );
    expect(imported.status, await imported.clone().text()).toBe(201);

    const invocation = {
      actionId: "image-editor",
      projectId: "project-a",
      source: { assetId: "source:image", kind: "image" },
      params: { rotation: 90 },
      surface: "asset-preview",
      mode: "implicit",
    };
    const request = (bytes: string) => {
      const form = new FormData();
      form.set("file", new File([bytes], "edited.png", { type: "image/png" }));
      form.set("projectId", "project-a");
      form.set("sourceAssetId", "source:image");
      form.set("editKind", "image-editor");
      form.set("outputKind", "image");
      form.set("editParams", JSON.stringify(invocation.params));
      form.set("origin", "asset-preview");
      form.set("invocation", JSON.stringify(invocation));
      form.set("actionRunId", "edit:bytes-conflict-1");
      return app.request("/api/v1/edits", { method: "POST", body: form });
    };

    const first = await request("first edited image");
    const conflict = await request("different edited image");

    expect(first.status, await first.clone().text()).toBe(200);
    expect(conflict.status, await conflict.clone().text()).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: "PROJECT_ASSET_ID_COLLISION",
    });
    const doc = await new FileReplicaStore(join(dataDir, "projects")).recover(
      "project-a",
    );
    expect(
      listProjectAssets(doc).filter(
        (entry) => entry.provenance?.actionRunId === "edit:bytes-conflict-1",
      ),
    ).toHaveLength(1);
    expect(
      listActionAssetBindings(doc).filter(
        (binding) =>
          binding.owner.kind === "run" &&
          binding.owner.actionRunId === "edit:bytes-conflict-1",
      ),
    ).toHaveLength(2);
  });

  it("rejects reuse of an edit actionRunId for a different frozen invocation", async () => {
    const { app, dataDir } = await fixture();
    const sourceForm = new FormData();
    sourceForm.set(
      "file",
      new File(["source image"], "source.png", { type: "image/png" }),
    );
    sourceForm.set("kind", "image");
    sourceForm.set("projectAssetId", "source:image");
    const imported = await app.request(
      "http://127.0.0.1:49152/api/v1/projects/project-a/assets/import-file",
      { method: "POST", body: sourceForm },
    );
    expect(imported.status, await imported.clone().text()).toBe(201);

    const request = (rotation: 90 | 180) => {
      const invocation = {
        actionId: "image-editor",
        projectId: "project-a",
        source: { assetId: "source:image", kind: "image" },
        params: { rotation },
        surface: "asset-preview",
        mode: "implicit",
      };
      const form = new FormData();
      form.set(
        "file",
        new File(["same edited bytes"], "edited.png", {
          type: "image/png",
        }),
      );
      form.set("projectId", "project-a");
      form.set("sourceAssetId", "source:image");
      form.set("editKind", "image-editor");
      form.set("outputKind", "image");
      form.set("editParams", JSON.stringify(invocation.params));
      form.set("origin", "asset-preview");
      form.set("invocation", JSON.stringify(invocation));
      form.set("actionRunId", "edit:invocation-conflict-1");
      return app.request("/api/v1/edits", { method: "POST", body: form });
    };

    const first = await request(90);
    const conflict = await request(180);

    expect(first.status, await first.clone().text()).toBe(200);
    expect(conflict.status, await conflict.clone().text()).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: "ACTION_ASSET_BINDING_ID_COLLISION",
    });
    const doc = await new FileReplicaStore(join(dataDir, "projects")).recover(
      "project-a",
    );
    expect(
      listProjectAssets(doc).filter(
        (entry) =>
          entry.provenance?.actionRunId === "edit:invocation-conflict-1",
      ),
    ).toHaveLength(1);
    expect(
      listActionAssetBindings(doc).filter(
        (binding) =>
          binding.owner.kind === "run" &&
          binding.owner.actionRunId === "edit:invocation-conflict-1",
      ),
    ).toHaveLength(2);
  });

  it("converges repeated video-crop computation onto one output and one binding set", async () => {
    const { app, clashRoot, dataDir } = await fixture();
    const sourceForm = new FormData();
    sourceForm.set(
      "file",
      new File(["source video"], "source.mp4", { type: "video/mp4" }),
    );
    sourceForm.set("kind", "video");
    sourceForm.set("projectAssetId", "source:video");
    const imported = await app.request(
      "http://127.0.0.1:49152/api/v1/projects/project-a/assets/import-file",
      { method: "POST", body: sourceForm },
    );
    expect(imported.status, await imported.clone().text()).toBe(201);

    const fakeFfmpeg = join(clashRoot, "fake-replay-ffmpeg");
    await writeFile(
      fakeFfmpeg,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "const args = process.argv.slice(2);",
        'const input = args[args.indexOf("-i") + 1];',
        "const output = args[args.length - 1];",
        'const start = args[args.indexOf("-ss") + 1];',
        'const duration = args[args.indexOf("-t") + 1];',
        "fs.writeFileSync(output, Buffer.concat([fs.readFileSync(input), Buffer.from(` crop:${start}:${duration}`)]));",
      ].join("\n"),
    );
    await chmod(fakeFfmpeg, 0o755);
    const priorFfmpegPath = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = fakeFfmpeg;
    const params = { mode: "crop" as const, startSec: 0, endSec: 1 };
    const body = {
      actionRunId: "edit:crop-replay-1",
      projectId: "project-a",
      sourceAssetId: "source:video",
      params,
      origin: "asset-preview",
      invocation: {
        actionId: "video-clipper",
        projectId: "project-a",
        source: { assetId: "source:video", kind: "video" },
        params,
        surface: "asset-preview",
        mode: "implicit",
      },
    };
    const request = () =>
      app.request("/api/v1/edits/video-crop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    let first: Response;
    let replay: Response;
    let conflict: Response;
    try {
      first = await request();
      replay = await request();
      conflict = await app.request("/api/v1/edits/video-crop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...body,
          params: { mode: "crop", startSec: 0, endSec: 1.5 },
          invocation: {
            ...body.invocation,
            params: { mode: "crop", startSec: 0, endSec: 1.5 },
          },
        }),
      });
    } finally {
      if (priorFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = priorFfmpegPath;
    }

    expect(first.status, await first.clone().text()).toBe(200);
    expect(replay.status, await replay.clone().text()).toBe(200);
    const output = (await first.json()) as { id: string };
    await expect(replay.json()).resolves.toEqual(output);
    expect(conflict.status, await conflict.clone().text()).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: "PROJECT_ASSET_ID_COLLISION",
    });
    const doc = await new FileReplicaStore(join(dataDir, "projects")).recover(
      "project-a",
    );
    expect(
      listProjectAssets(doc).filter(
        (entry) => entry.provenance?.actionRunId === "edit:crop-replay-1",
      ),
    ).toHaveLength(1);
    expect(
      listActionAssetBindings(doc).filter(
        (binding) =>
          binding.owner.kind === "run" &&
          binding.owner.actionRunId === "edit:crop-replay-1",
      ),
    ).toHaveLength(2);
  });

  it("edits an admitted linked source by publishing a new owned entry without changing the source", async () => {
    const { app, dataDir } = await fixture();
    const globalAssetId = "global:linked-edit-source";
    const globalForm = new FormData();
    globalForm.set(
      "file",
      new File(["linked source image"], "linked-source.png", {
        type: "image/png",
      }),
    );
    globalForm.set("kind", "image");
    globalForm.set("globalAssetId", globalAssetId);
    const imported = await app.request(
      "http://127.0.0.1:49152/api/v1/libraries/personal/assets/import-file",
      { method: "POST", body: globalForm },
    );
    expect(imported.status, await imported.clone().text()).toBe(201);

    const admittedResponse = await app.request(
      "http://127.0.0.1:49152/api/v1/projects/project-a/assets/admit",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ globalAssetId }),
      },
    );
    expect(admittedResponse.status, await admittedResponse.clone().text()).toBe(
      201,
    );
    const admitted = (await admittedResponse.json()) as { id: string };
    const replicas = new FileReplicaStore(join(dataDir, "projects"));
    const sourceBefore = readProjectAsset(
      await replicas.recover("project-a"),
      admitted.id,
    );
    expect(sourceBefore).toMatchObject({
      id: admitted.id,
      source: {
        kind: "linked",
        origin: {
          scope: "global",
          libraryId: "personal",
          entryId: globalAssetId,
        },
      },
      lifecycle: { state: "active" },
    });

    const invocation = {
      actionId: "image-editor",
      projectId: "project-a",
      source: { assetId: admitted.id, kind: "image" },
      params: { rotation: 90 },
      surface: "asset-preview",
      mode: "implicit",
    };
    const editForm = new FormData();
    editForm.set(
      "file",
      new File(["edited linked image"], "edited-linked.png", {
        type: "image/png",
      }),
    );
    editForm.set("projectId", "project-a");
    editForm.set("sourceAssetId", admitted.id);
    editForm.set("editKind", "image-editor");
    editForm.set("outputKind", "image");
    editForm.set("editParams", JSON.stringify(invocation.params));
    editForm.set("origin", "asset-preview");
    editForm.set("invocation", JSON.stringify(invocation));
    editForm.set("actionRunId", "edit:linked-source-1");

    const editedResponse = await app.request("/api/v1/edits", {
      method: "POST",
      body: editForm,
    });
    expect(editedResponse.status, await editedResponse.clone().text()).toBe(
      200,
    );
    const edited = (await editedResponse.json()) as { id: string };
    expect(edited.id).not.toBe(admitted.id);

    const after = await replicas.recover("project-a");
    expect(readProjectAsset(after, admitted.id)).toEqual(sourceBefore);
    expect(readProjectAsset(after, edited.id)).toMatchObject({
      id: edited.id,
      source: { kind: "owned" },
      lifecycle: { state: "active" },
      provenance: { kind: "edit" },
    });
  });

  it("keeps only staged bytes when an edit output binding identity collides", async () => {
    const clashRoot = await mkdtemp(
      join(tmpdir(), "clash-project-asset-edit-collision-"),
    );
    temporaryDirectories.push(clashRoot);
    const dataDir = join(clashRoot, "local-api");
    const projectId = "edit-collision-project";
    const doc = new LoroDoc();
    const collision = editBindingCollisionReplica({
      doc,
      actionId: "image-editor",
      sourceAssetId: "source:image",
    });
    const service = createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: "http://127.0.0.1:49152",
      replica: collision.replica,
      assetInspection: createLocalAssetInspectionService({
        dataDir,
        clashRoot,
        inspectResource: inspectFixtureAsset,
      }),
    });
    await service.installOwned({
      projectId,
      projectAssetId: "source:image",
      kind: "image",
      bytes: new TextEncoder().encode("source image"),
      contentType: "image/png",
      name: "source.png",
      metadata: {},
    });
    collision.arm();
    const app = createLocalApiApp({
      dataDir,
      clashRoot,
      userId: "local-user",
      projectAssetProjectionOrigin: "http://127.0.0.1:49152",
      projectAssetReplica: collision.replica,
      inspectAssetResource: inspectFixtureAsset,
    });
    const invocation = {
      actionId: "image-editor",
      projectId,
      source: { assetId: "source:image", kind: "image" },
      params: { rotation: 90 },
      surface: "asset-preview",
      mode: "implicit",
    };
    const editForm = new FormData();
    editForm.set(
      "file",
      new File(["edited image"], "edited.png", { type: "image/png" }),
    );
    editForm.set("projectId", projectId);
    editForm.set("sourceAssetId", "source:image");
    editForm.set("editKind", "image-editor");
    editForm.set("outputKind", "image");
    editForm.set("editParams", JSON.stringify(invocation.params));
    editForm.set("origin", "asset-preview");
    editForm.set("invocation", JSON.stringify(invocation));
    editForm.set("actionRunId", "edit:binding-collision-1");

    const response = await app.request("/api/v1/edits", {
      method: "POST",
      body: editForm,
    });

    expect(response.status, await response.clone().text()).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "ACTION_ASSET_BINDING_ID_COLLISION",
    });
    const collisionRunId = collision.actionRunId();
    expect(collisionRunId).toMatch(/^edit:/);
    expect(
      listProjectAssets(doc).filter(
        (entry) => entry.provenance?.actionRunId === collisionRunId,
      ),
    ).toEqual([]);
    expect(
      listActionAssetBindings(doc).filter(
        (binding) =>
          binding.owner.kind === "run" &&
          binding.owner.actionRunId === collisionRunId,
      ),
    ).toEqual([
      expect.objectContaining({
        id: `action-asset:${collisionRunId}:output`,
        slot: "already-claimed",
        projectAssetId: "source:image",
      }),
    ]);
    const digest = createHash("sha256")
      .update(new TextEncoder().encode("edited image"))
      .digest("hex");
    await expect(
      service.resolveStagedOwned(`sha256:${digest}`),
    ).resolves.toMatchObject({ resourceId: `sha256:${digest}` });
  });

  it("publishes no video-crop Project facts when its output binding identity collides", async () => {
    const clashRoot = await mkdtemp(
      join(tmpdir(), "clash-project-asset-crop-collision-"),
    );
    temporaryDirectories.push(clashRoot);
    const dataDir = join(clashRoot, "local-api");
    const projectId = "crop-collision-project";
    const doc = new LoroDoc();
    const collision = editBindingCollisionReplica({
      doc,
      actionId: "video-clipper",
      sourceAssetId: "source:video",
    });
    const service = createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: "http://127.0.0.1:49152",
      replica: collision.replica,
      assetInspection: createLocalAssetInspectionService({
        dataDir,
        clashRoot,
        inspectResource: inspectFixtureAsset,
      }),
    });
    await service.installOwned({
      projectId,
      projectAssetId: "source:video",
      kind: "video",
      bytes: new TextEncoder().encode("source video"),
      contentType: "video/mp4",
      name: "source.mp4",
      metadata: { durationMs: 2_000 },
    });
    collision.arm();
    const fakeFfmpeg = join(clashRoot, "fake-ffmpeg");
    await writeFile(
      fakeFfmpeg,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "const args = process.argv.slice(2);",
        'const input = args[args.indexOf("-i") + 1];',
        "const output = args[args.length - 1];",
        'fs.writeFileSync(output, Buffer.concat([fs.readFileSync(input), Buffer.from(" cropped")]));',
      ].join("\n"),
    );
    await chmod(fakeFfmpeg, 0o755);
    const priorFfmpegPath = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = fakeFfmpeg;
    const app = createLocalApiApp({
      dataDir,
      clashRoot,
      userId: "local-user",
      projectAssetProjectionOrigin: "http://127.0.0.1:49152",
      projectAssetReplica: collision.replica,
      inspectAssetResource: inspectFixtureAsset,
    });
    const params = { mode: "crop", startSec: 0, endSec: 1 };
    const invocation = {
      actionId: "video-clipper",
      projectId,
      source: { assetId: "source:video", kind: "video" },
      params,
      surface: "asset-preview",
      mode: "implicit",
    };
    let response: Response;
    try {
      response = await app.request("/api/v1/edits/video-crop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actionRunId: "edit:crop-binding-collision-1",
          projectId,
          sourceAssetId: "source:video",
          params,
          origin: "asset-preview",
          invocation,
        }),
      });
    } finally {
      if (priorFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = priorFfmpegPath;
    }

    expect(response.status, await response.clone().text()).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "ACTION_ASSET_BINDING_ID_COLLISION",
    });
    const collisionRunId = collision.actionRunId();
    expect(collisionRunId).toMatch(/^edit:/);
    expect(
      listProjectAssets(doc).filter(
        (entry) => entry.provenance?.actionRunId === collisionRunId,
      ),
    ).toEqual([]);
    expect(
      listActionAssetBindings(doc).filter(
        (binding) =>
          binding.owner.kind === "run" &&
          binding.owner.actionRunId === collisionRunId,
      ),
    ).toEqual([
      expect.objectContaining({
        id: `action-asset:${collisionRunId}:output`,
        slot: "already-claimed",
        projectAssetId: "source:video",
      }),
    ]);
    const digest = createHash("sha256")
      .update(new TextEncoder().encode("source video cropped"))
      .digest("hex");
    await expect(
      service.resolveStagedOwned(`sha256:${digest}`),
    ).resolves.toMatchObject({ resourceId: `sha256:${digest}` });
  });

  it("enqueues Director generation through the shared durable Provider journal", async () => {
    const clashRoot = await mkdtemp(
      join(tmpdir(), "clash-director-project-asset-"),
    );
    temporaryDirectories.push(clashRoot);
    const dataDir = join(clashRoot, "local-api");
    let wakes = 0;
    const binding = {
      pluginId: "clash.fal",
      version: "0.1.0",
      exportId: "fal-execute",
      schemaHash: `sha256:${"a".repeat(64)}`,
    } as const;
    const app = createLocalApiApp({
      dataDir,
      userId: "local-user",
      resolvePluginBinding: async () => binding,
      processProjectWork: async () => {
        wakes += 1;
      },
      projectAssetProjectionOrigin: "http://127.0.0.1:49152",
    });
    const createdProject = await app.request("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Generated Director models" }),
    });
    const { id: projectId } = (await createdProject.json()) as { id: string };
    await app.request("/api/v1/model-providers", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providers: [
          {
            id: "fal-director",
            providerId: "fal",
            upstreamId: "fal",
            enabled: true,
            priority: 1,
            credentials: { apiKey: "fal-director-secret" },
          },
        ],
      }),
    });

    const response = await app.request("/api/v1/director-model-generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actionRunId: "director:request-1",
        projectId,
        prompt: "A chestnut horse",
        quality: "low-poly",
      }),
    });
    expect(response.status, await response.clone().text()).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "queued",
      actionRunId: "director:request-1",
      requestId: "director:request-1",
      statusUrl: expect.stringContaining("director%3Arequest-1"),
    });
    const journal = createSqliteDurableRunJournal(dataDir);
    const run = await journal.load({
      actionRunId: "director:request-1",
      outputSlot: "media",
    });
    expect(run).toMatchObject({
      phase: "queued",
      owner: { realm: "local", id: "local-api" },
      executorInput: {
        binding,
        accountId: "fal-director",
        kind: "model",
        projectId,
        delivery: {
          kind: "project-asset",
          actionId: "director:model-generation",
          name: "generated-model.glb",
          prompt: "A chestnut horse",
        },
      },
    });
    expect(JSON.stringify(run?.executorInput)).not.toMatch(
      /apiKey|fal-director-secret|credentials/,
    );

    const status = await app.request(
      `/api/v1/director-model-generations/director%3Arequest-1?projectId=${encodeURIComponent(projectId)}`,
    );
    expect(status.status).toBe(202);
    expect(wakes).toBeGreaterThanOrEqual(1);

    const conflict = await app.request("/api/v1/director-model-generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actionRunId: "director:request-1",
        projectId,
        prompt: "A different model",
      }),
    });
    expect(conflict.status).toBe(409);
  });

  it("rejects a multipart import without a stable Project Asset id before publishing an Asset", async () => {
    const { app } = await fixture();
    const url =
      "http://127.0.0.1:49152/api/v1/projects/project-a/assets/import-file";
    const form = new FormData();
    form.set(
      "file",
      new File(["same immutable bytes"], "same.png", {
        type: "image/png",
      }),
    );
    form.set("kind", "image");

    const response = await app.request(url, { method: "POST", body: form });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Project Asset import requires file, kind, and projectAssetId",
      code: "INVALID_PROJECT_ASSET_IMPORT",
    });
    const listed = await app.request(url.replace("/import-file", ""));
    await expect(listed.json()).resolves.toEqual({
      assets: [expect.objectContaining({ id: "result:one" })],
    });
  });

  it("rejects empty, mismatched, and invalidly identified multipart imports", async () => {
    const { app } = await fixture();
    const url =
      "http://127.0.0.1:49152/api/v1/projects/project-a/assets/import-file";
    const requests: FormData[] = [];

    const empty = new FormData();
    empty.set("file", new File([], "empty.png", { type: "image/png" }));
    empty.set("kind", "image");
    requests.push(empty);

    const mismatched = new FormData();
    mismatched.set(
      "file",
      new File(["not a video"], "still.png", { type: "image/png" }),
    );
    mismatched.set("kind", "video");
    requests.push(mismatched);

    const invalidId = new FormData();
    invalidId.set(
      "file",
      new File(["image"], "still.png", { type: "image/png" }),
    );
    invalidId.set("kind", "image");
    invalidId.set("projectAssetId", " ");
    requests.push(invalidId);

    for (const form of requests) {
      const response = await app.request(url, { method: "POST", body: form });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "INVALID_PROJECT_ASSET_IMPORT",
      });
    }
  });

  it("lists Action references and rejects logical deletion while the Asset is in use", async () => {
    const { app, asset, dataDir } = await fixture();
    const replicas = new FileReplicaStore(join(dataDir, "projects"));
    await replicas.updateSnapshotAtomic("project-a", (doc) => {
      const result = createActionAssetBinding(doc, {
        id: "binding:timeline:primary",
        owner: {
          kind: "revision",
          actionId: "timeline:main",
          actionRevisionId: "timeline-revision:1",
        },
        direction: "input",
        slot: "track:video:0",
        projectAssetId: asset.id,
        role: "primary",
      });
      if (!result.ok) throw new Error(result.error.code);
      return { value: undefined };
    });

    const baseUrl = `http://127.0.0.1:49152/api/v1/projects/project-a/assets/${encodeURIComponent(asset.id)}`;
    const references = await app.request(`${baseUrl}/references`);
    expect(references.status).toBe(200);
    expect(references.headers.get("x-clash-read-receipt")).toMatch(
      PROJECT_ASSET_RECEIPT_RE,
    );
    const expectedReference = {
      id: "binding:timeline:primary",
      owner: {
        kind: "revision",
        actionId: "timeline:main",
        actionRevisionId: "timeline-revision:1",
      },
      direction: "input",
      slot: "track:video:0",
      projectAssetId: "result:one",
      role: "primary",
    };
    await expect(references.json()).resolves.toEqual({
      projectAssetId: "result:one",
      references: [expectedReference],
    });

    const removed = await app.request(
      baseUrl,
      projectTrashRequest("delete:referenced-asset"),
    );
    expect(removed.status, await removed.clone().text()).toBe(409);
    await expect(removed.json()).resolves.toEqual({
      error: "Project Asset result:one is still referenced.",
      code: "ASSET_IN_USE",
      projectAssetId: "result:one",
      references: [expectedReference],
    });
    expect(
      readProjectAsset(await replicas.recover("project-a"), asset.id)
        ?.lifecycle,
    ).toEqual({ state: "active" });
  });

  it("logically trashes and restores an unreferenced Asset without deleting its bytes", async () => {
    const { app, asset, dataDir, service } = await fixture();
    const baseUrl = `http://127.0.0.1:49152/api/v1/projects/project-a/assets/${encodeURIComponent(asset.id)}`;
    const resourcePath = (await service.openProjection("project-a", asset.id))
      .path;

    const removed = await app.request(
      baseUrl,
      projectTrashRequest("delete:logical-trash"),
    );
    expect(removed.status, await removed.clone().text()).toBe(200);
    await expect(removed.json()).resolves.toMatchObject({
      id: "result:one",
      kind: "audio",
      name: "result.unusual",
      metadata: {
        durationMs: 2_000,
        bytes: 10,
        contentType: "audio/mpeg",
        originalName: "result.unusual",
      },
      provenance: { kind: "generation", actionRunId: "run-1" },
      lifecycle: {
        state: "trashed",
        deleteOperationId: expect.any(String),
        deletedAt: expect.any(String),
        purgeAfter: expect.any(String),
      },
      status: "unavailable",
    });
    expect(await readFile(resourcePath, "utf8")).toBe("0123456789");
    const trashed = readProjectAsset(
      await new FileReplicaStore(join(dataDir, "projects")).recover(
        "project-a",
      ),
      asset.id,
    );
    expect(trashed?.lifecycle).toMatchObject({
      state: "trashed",
      deleteOperationId: expect.any(String),
      deletedAt: expect.any(String),
      purgeAfter: expect.any(String),
    });

    const restored = await app.request(`${baseUrl}/restore`, {
      method: "POST",
    });
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({
      id: "result:one",
      lifecycle: { state: "active" },
      status: "ready",
      url: `${baseUrl}/media`,
    });
    expect(
      readProjectAsset(
        await new FileReplicaStore(join(dataDir, "projects")).recover(
          "project-a",
        ),
        asset.id,
      )?.lifecycle,
    ).toEqual({ state: "active" });
    expect(await readFile(resourcePath, "utf8")).toBe("0123456789");
  });

  it("requires a stable delete operation id from the Project Asset producer", async () => {
    const { app, asset } = await fixture();
    const baseUrl = `http://127.0.0.1:49152/api/v1/projects/project-a/assets/${encodeURIComponent(asset.id)}`;

    const response = await app.request(baseUrl, { method: "DELETE" });

    expect(response.status, await response.clone().text()).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "deleteOperationId is required",
      code: "INVALID_PROJECT_ASSET_TRASH",
    });
  });

  it("returns the committed delete for an at-least-once retry but CAS-rejects another operation", async () => {
    const { app, asset } = await fixture();
    const baseUrl = `http://127.0.0.1:49152/api/v1/projects/project-a/assets/${encodeURIComponent(asset.id)}`;
    const read = await app.request(baseUrl);
    const activeReceipt = read.headers.get("x-clash-read-receipt")!;
    const remove = (deleteOperationId: string) =>
      app.request(baseUrl, {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "x-clash-client-type": "agent",
          "x-clash-if-match": activeReceipt,
        },
        body: JSON.stringify({ deleteOperationId }),
      });

    const first = await remove("delete:at-least-once");
    const retried = await remove("delete:at-least-once");

    expect(first.status, await first.clone().text()).toBe(200);
    expect(retried.status, await retried.clone().text()).toBe(200);
    const firstResult = await first.json();
    await expect(retried.json()).resolves.toEqual(firstResult);

    const competing = await remove("delete:competing-operation");
    expect(competing.status, await competing.clone().text()).toBe(409);
    await expect(competing.json()).resolves.toMatchObject({
      code: "STALE_READ",
    });
  });

  it("requires and rotates a Host receipt for agent delete and restore", async () => {
    const { app, asset } = await fixture();
    const baseUrl = `http://127.0.0.1:49152/api/v1/projects/project-a/assets/${encodeURIComponent(asset.id)}`;

    const missing = await app.request(
      baseUrl,
      projectTrashRequest("delete:missing-read", {
        "x-clash-client-type": "agent",
      }),
    );
    expect(missing.status).toBe(409);
    await expect(missing.json()).resolves.toMatchObject({
      code: "READ_REQUIRED",
    });

    const read = await app.request(baseUrl);
    const activeReceipt = read.headers.get("x-clash-read-receipt");
    expect(activeReceipt).toMatch(PROJECT_ASSET_RECEIPT_RE);
    expect(JSON.stringify(await read.json())).not.toContain("readToken");

    const removed = await app.request(
      baseUrl,
      projectTrashRequest("delete:agent-receipt", {
        "x-clash-client-type": "agent",
        "x-clash-if-match": activeReceipt!,
      }),
    );
    expect(removed.status, await removed.clone().text()).toBe(200);
    const trashedReceipt = removed.headers.get("x-clash-read-receipt");
    expect(trashedReceipt).toMatch(PROJECT_ASSET_RECEIPT_RE);
    expect(trashedReceipt).not.toBe(activeReceipt);
    expect(JSON.stringify(await removed.json())).not.toContain("readToken");

    const restored = await app.request(`${baseUrl}/restore`, {
      method: "POST",
      headers: {
        "x-clash-client-type": "agent",
        "x-clash-if-match": trashedReceipt!,
      },
    });
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect(restored.headers.get("x-clash-read-receipt")).toMatch(
      PROJECT_ASSET_RECEIPT_RE,
    );
    expect(JSON.stringify(await restored.json())).not.toContain("readToken");
  });

  it("rejects tampered and stale Project Asset receipts inside the mutation", async () => {
    const tamperedFixture = await fixture();
    const tamperedUrl = `http://127.0.0.1:49152/api/v1/projects/project-a/assets/${encodeURIComponent(tamperedFixture.asset.id)}`;
    const initialRead = await tamperedFixture.app.request(tamperedUrl);
    const receipt = initialRead.headers.get("x-clash-read-receipt")!;
    const tampered = `${receipt.slice(0, -1)}${receipt.endsWith("A") ? "B" : "A"}`;
    const rejectedTampered = await tamperedFixture.app.request(
      tamperedUrl,
      projectTrashRequest("delete:tampered-receipt", {
        "x-clash-client-type": "agent",
        "x-clash-if-match": tampered,
      }),
    );
    expect(rejectedTampered.status).toBe(409);
    await expect(rejectedTampered.json()).resolves.toMatchObject({
      code: "INVALID_READ_PROOF",
    });

    const staleFixture = await fixture();
    const staleUrl = `http://127.0.0.1:49152/api/v1/projects/project-a/assets/${encodeURIComponent(staleFixture.asset.id)}`;
    const staleRead = await staleFixture.app.request(staleUrl);
    const staleReceipt = staleRead.headers.get("x-clash-read-receipt")!;
    const replicas = new FileReplicaStore(
      join(staleFixture.dataDir, "projects"),
    );
    await replicas.updateSnapshotAtomic("project-a", (doc) => {
      const result = createActionAssetBinding(doc, {
        id: "binding:concurrent-input",
        owner: { kind: "draft", actionId: "action:concurrent" },
        direction: "input",
        slot: "image:0",
        projectAssetId: staleFixture.asset.id,
        role: "reference",
      });
      if (!result.ok) throw new Error(result.error.code);
      return { value: undefined };
    });

    const rejectedStale = await staleFixture.app.request(
      staleUrl,
      projectTrashRequest("delete:stale-receipt", {
        "x-clash-client-type": "agent",
        "x-clash-if-match": staleReceipt,
      }),
    );
    expect(rejectedStale.status).toBe(409);
    await expect(rejectedStale.json()).resolves.toMatchObject({
      code: "STALE_READ",
    });
    expect(
      readProjectAsset(
        await replicas.recover("project-a"),
        staleFixture.asset.id,
      )?.lifecycle.state,
    ).toBe("active");
  });

  it("does not resolve a Project Asset through another Project", async () => {
    const { app, asset } = await fixture();
    const otherProjectUrl = `http://127.0.0.1:49152/api/v1/projects/project-b/assets/${encodeURIComponent(asset.id)}`;

    const read = await app.request(otherProjectUrl);
    expect(read.status).toBe(404);
    await expect(read.json()).resolves.toEqual({
      error: "Project Asset not found",
      code: "PROJECT_ASSET_NOT_FOUND",
    });

    const media = await app.request(`${otherProjectUrl}/media`);
    expect(media.status).toBe(404);
    await expect(media.json()).resolves.toEqual({
      error: "Project Asset not found",
      code: "PROJECT_ASSET_NOT_FOUND",
    });
  });
});
