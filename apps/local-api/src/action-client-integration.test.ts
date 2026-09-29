import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import ffprobe from "@ffprobe-installer/ffprobe";
import sharp from "sharp";
import { afterEach, expect, it } from "vitest";
import {
  Canvas,
  listProjectAssets,
  readMediaAssetGeneration,
} from "@clash/shared-types";
import { createActionClient } from "@clash/shared-runtime/action-client";
import { plugin } from "../../../plugins/asset-edit/src/stdio.js";
import { createLocalApiApp } from "./app.js";
import { createLocalWorkflowProcessor } from "./local-processor.js";
import {
  createLocalAssetInspectionService,
  createLocalFfprobeAssetInspector,
} from "./local-asset-inspections.js";
import { createLocalProjectAssetService } from "./local-project-assets.js";
import { createSqliteDurableRunJournal } from "./durable-run-journal.js";
import { LocalLoroRoomHub } from "./sync.js";
import {
  acceptPluginUpload,
  createLocalPluginBrokerServices,
} from "./server.js";
import { createExecutablePluginActionInvoker } from "./plugin-action-runtime.js";
import { ActionsHost } from "./runtime/host/lib/actions-loader.js";
import { createLocalAssetRepresentationService } from "./local-asset-representations.js";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clash-action-integration-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "local-api");
  const hub = new LocalLoroRoomHub(dataDir, undefined, null);
  cleanups.push(() => hub.close());
  const manifest = JSON.parse(
    await readFile(
      new URL("../../../plugins/asset-edit/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const packageDir = join(root, "asset-edit");
  await mkdir(join(packageDir, "generators"), { recursive: true });
  for (const id of ["image-editor", "video-clipper"]) {
    const document = JSON.parse(
      await readFile(
        new URL(
          `../../../plugins/asset-edit/generators/${id}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await writeFile(
      join(packageDir, `generators/${id}.json`),
      JSON.stringify(document),
    );
    if (id === "image-editor") {
      document.spec.definitionId = "portrait-preparation";
      await writeFile(
        join(packageDir, "generators/portrait-preparation.json"),
        JSON.stringify(document),
      );
      manifest.contributes.generators.push({
        id: "portrait-preparation",
        kind: "generator",
        path: "generators/portrait-preparation.json",
      });
    }
  }
  const manifestPath = join(packageDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const replica = {
    inspect: hub.inspectProject.bind(hub),
    mutate: hub.mutateProject.bind(hub),
  };
  let origin = "http://127.0.0.1:0";
  const broker = createLocalPluginBrokerServices({
    dataDir,
    uploadOrigin: () => origin,
    inspectProjectDocument: hub.inspectCheckpointedProject.bind(hub),
  });
  const actions = new ActionsHost({
    actionsRoot: join(root, "actions"),
    pluginBroker: broker,
    trustedBundledPluginModules: [{ id: manifest.id }],
    loadTrustedBundledPluginModule: async () => ({
      id: manifest.id,
      manifestPath,
      entrypointPath: join(packageDir, manifest.runtime.entrypoint),
      plugin,
    }),
  });
  await actions.start();
  cleanups.push(() => actions.stopAll());
  const resolveDefinition = async (pluginId: string, definitionId: string) =>
    actions.resolveGeneratorDefinition(pluginId, definitionId);
  const inspection = createLocalAssetInspectionService({
    dataDir,
    inspectResource: createLocalFfprobeAssetInspector({
      ffprobePath: ffprobe.path,
    }),
  });
  const representations = createLocalAssetRepresentationService({
    dataDir,
    assetInspection: inspection,
  });
  cleanups.push(() => representations.close());
  const assets = createLocalProjectAssetService({
    dataDir,
    projectionOrigin: () => origin,
    replica,
    assetInspection: inspection,
  });
  const processor = createLocalWorkflowProcessor({
    dataDir,
    assetInspection: inspection,
    resolveGeneratorDefinition: resolveDefinition,
    executablePluginAction: createExecutablePluginActionInvoker({
      client: actions,
    }),
  });
  const processWork = async () => {
    for (let pass = 0; pass < 8; pass += 1) {
      const changed = await hub.mutateProjectWithCheckpoint(
        "project",
        (doc, checkpoint) =>
          processor.process({ doc, projectId: "project", checkpoint }),
      );
      if (!changed) break;
    }
  };
  let autoProcess = false;
  const app = createLocalApiApp({
    dataDir,
    assetInspection: inspection,
    assetRepresentations: representations,
    projectAssetReplica: replica,
    acceptPluginUpload,
    projectAssetProjectionOrigin: () => origin,
    listPluginGenerators: async () => actions.listGenerators(),
    resolveGeneratorDefinition: resolveDefinition,
    generatorProjectAuthority: {
      inspect: hub.inspectProject.bind(hub),
      mutate: hub.mutateProjectWithCheckpoint.bind(hub),
    },
    processProjectWork: async () => {
      if (autoProcess) await processWork();
    },
  });
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const listener = serve(
      { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
      () => resolve(listener),
    );
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Host failed to bind loopback");
  origin = `http://127.0.0.1:${address.port}`;
  const connect = () =>
    createActionClient((path, init) => fetch(`${origin}${path}`, init));
  const client = connect();
  const source = async (
    path: string,
    kind: "image" | "video",
    bytes: Uint8Array,
  ) => {
    const form = new FormData();
    form.set(
      "file",
      new Blob([bytes as BlobPart], {
        type: kind === "image" ? "image/png" : "video/mp4",
      }),
      path,
    );
    form.set("kind", kind);
    form.set("projectAssetId", `source:${path}`);
    const response = await fetch(
      `${origin}/api/v1/projects/project/assets/import-file`,
      { method: "POST", body: form },
    );
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  };
  return {
    root,
    hub,
    client,
    connect,
    assets,
    source,
    processWork,
    journal: createSqliteDurableRunJournal(dataDir),
    enableProcessing: () => {
      autoProcess = true;
    },
  };
}

it("invokes a custom registered image Action through the real Host, resumes its Run and preserves one exact output", async () => {
  const f = await fixture();
  const sourceBytes = await sharp({
    create: { width: 8, height: 4, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const source = await f.source("portrait.png", "image", sourceBytes);
  const invocation = {
    action: "portrait-preparation.transform",
    assetId: source,
    parameters: { crop: { x: 1, y: 0, width: 3, height: 2 }, rotation: 90 },
    requestId: "prepare-portrait",
    waitMs: 0,
  };
  const admitted = await f.client.invoke("project", invocation);
  expect(["pending", "running"]).toContain(admitted.status);
  expect(admitted.outputs).toEqual([]);
  const before = await f.hub.inspectProject("project", (doc) =>
    new Canvas(doc, () => {}).listNodes(),
  );
  expect(before).toContainEqual(
    expect.objectContaining({
      data: expect.objectContaining({
        actionRunId: admitted.actionRunId,
        generatorOutputSlot: "output",
        status: "generating",
      }),
    }),
  );
  await f.processWork();
  const completed = await f
    .connect()
    .wait("project", admitted.actionRunId, { waitMs: 0 });
  expect(
    completed.status,
    JSON.stringify(
      await f.journal.load({
        actionRunId: admitted.actionRunId,
        outputSlot: "output",
      }),
    ),
  ).toBe("succeeded");
  const result = completed.outputs[0]!.reference;
  if (result.kind !== "media") throw new Error("Expected image Asset");
  const projection = await f.assets.openProjection(
    "project",
    result.projectAssetId,
  );
  expect(await sharp(projection.path).metadata()).toMatchObject({
    width: 2,
    height: 3,
    format: "png",
  });
  await f.hub.inspectProject("project", (doc) => {
    const canvas = new Canvas(doc, () => {});
    const operation = canvas.readNode(`operation:${admitted.actionRunId}`);
    expect(operation).toMatchObject({
      type: "action-badge",
      data: {
        actionRunId: admitted.actionRunId,
        generatorRevision: completed.run.generatorRevision,
      },
    });
    expect(canvas.listNodes()).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          actionRunId: admitted.actionRunId,
          status: "completed",
          assetId: result.projectAssetId,
        }),
      }),
    );
    const generation = readMediaAssetGeneration(doc, {
      projectAssetId: result.projectAssetId,
      actionRunId: admitted.actionRunId,
    });
    expect(generation?.run.parameters).toEqual(invocation.parameters);
    expect(generation?.run.invocationInputRefs).toEqual([
      { slot: "source", target: { kind: "media", projectAssetId: source } },
    ]);
  });
  const assetsBeforeReplay = await f.hub.inspectProject("project", (doc) =>
    listProjectAssets(doc),
  );
  expect(
    (await f.client.invoke("project", invocation)).outputs[0]?.reference,
  ).toEqual(result);
  expect(
    await f.hub.inspectProject("project", (doc) => listProjectAssets(doc)),
  ).toEqual(assetsBeforeReplay);
  expect(
    await readFile((await f.assets.openProjection("project", source)).path),
  ).toEqual(sourceBytes);
});

it("trims a non-keyframe interval and captures a real video frame with no external provider", async () => {
  const f = await fixture();
  const video = join(f.root, "source.mp4");
  await exec(ffmpeg.path, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=32x16:r=25:d=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-c:v",
    "libx264",
    "-g",
    "50",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    video,
  ]);
  const source = await f.source("source.mp4", "video", await readFile(video));
  f.enableProcessing();
  const result = await f.client.invoke("project", {
    action: "video-clipper.crop",
    assetId: source,
    parameters: { startSec: 0.4, endSec: 1.4 },
    waitMs: 5000,
  });
  expect(
    result.status,
    JSON.stringify(
      await f.journal.load({
        actionRunId: result.actionRunId,
        outputSlot: "output",
      }),
    ),
  ).toBe("succeeded");
  const reference = result.outputs[0]!.reference;
  if (reference.kind !== "media") throw new Error("Expected video Asset");
  const projection = await f.assets.openProjection(
    "project",
    reference.projectAssetId,
  );
  const probe = JSON.parse(
    (
      await exec(ffprobe.path, [
        "-v",
        "error",
        "-count_frames",
        "-show_streams",
        "-of",
        "json",
        projection.path,
      ])
    ).stdout,
  );
  expect(
    probe.streams.find(
      (stream: { codec_type: string }) => stream.codec_type === "video",
    ),
  ).toMatchObject({ nb_read_frames: "25" });
  expect(
    probe.streams.some(
      (stream: { codec_type: string }) => stream.codec_type === "audio",
    ),
  ).toBe(true);
  const frame = await f.client.invoke("project", {
    action: "video-clipper.screenshot",
    assetId: source,
    parameters: { frameTimeSec: 0.8 },
    waitMs: 5000,
  });
  expect(frame.status).toBe("succeeded");
  if (frame.outputs[0]!.reference.kind !== "media")
    throw new Error("Expected frame Asset");
  expect(
    await sharp(
      (
        await f.assets.openProjection(
          "project",
          frame.outputs[0]!.reference.projectAssetId,
        )
      ).path,
    ).metadata(),
  ).toMatchObject({ width: 32, height: 16, format: "png" });
});

it("reports a public, actionable screenshot range failure without exposing private paths or phantom output", async () => {
  const f = await fixture();
  const video = join(f.root, "range-source.mp4");
  await exec(ffmpeg.path, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=16x16:r=25:d=2",
    "-pix_fmt",
    "yuv420p",
    video,
  ]);
  const source = await f.source(
    "range-source.mp4",
    "video",
    await readFile(video),
  );
  const before = await f.hub.inspectProject("project", (doc) =>
    listProjectAssets(doc),
  );
  f.enableProcessing();
  const result = await f.client.invoke("project", {
    action: "video-clipper.screenshot",
    assetId: source,
    parameters: { frameTimeSec: 999 },
    waitMs: 5000,
  });
  expect(result.status).toBe("failed");
  expect(result.outputs).toEqual([]);
  expect(result.diagnostics?.failures[0]).toMatchObject({
    code: "invalid_request",
    retryable: false,
  });
  expect(result.next).toMatch(/frame.*duration/i);
  expect(JSON.stringify(result)).not.toMatch(
    /ENOENT|\/var\/|\/Users\/|output\.png/,
  );
  expect(
    await f.hub.inspectProject("project", (doc) => listProjectAssets(doc)),
  ).toEqual(before);
});
