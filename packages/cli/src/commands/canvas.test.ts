import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  canvasCommand,
  downloadAssetById,
  LocalResourceUnavailableError,
  resolveAssetDownloadUrl,
  resolveAssetFile,
  resolveCanvasActor,
  resolveCanvasPresenceOptions,
  resolveCanvasProjectId,
} from "./canvas";
import { initProject } from "./projects";

test("marks spawned agent canvas sync as agent presence", () => {
  assert.deepEqual(resolveCanvasPresenceOptions({
    CLASH_AGENT_MEMBER_ID: "local-clash",
  }), {
    clientType: "agent",
    agentName: "local-clash",
  });
});

test("keeps human CLI canvas sync as cli presence", () => {
  assert.deepEqual(resolveCanvasPresenceOptions({}), {
    clientType: "cli",
  });
});

test("uses runtime-injected actor identity without a network lookup", async () => {
  await assert.doesNotReject(async () => {
    assert.deepEqual(await resolveCanvasActor({
      CLASH_USER_ID: "local-user",
      CLASH_AGENT_MEMBER_ID: "local-agent",
    }), {
      actorType: "agent",
      actorUserId: "local-user",
      actorAgentId: "local-agent",
    });
  });
});

test("canvas add leaves trusted custom-action resolution to local-api", () => {
  const source = readFileSync(new URL("./canvas.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /\/api\/v1\/plugin-actions|registerInstalledPluginAction/);
  assert.match(source, /action: "add",[\s\S]*actionId: options\.action/);
});

test("canvas commands are thin local-api clients without direct replica connections", () => {
  const source = readFileSync(new URL("./canvas.ts", import.meta.url), "utf8");

  assert.match(source, /sendProjectCommand/);
  assert.doesNotMatch(source, /LoroSyncClient|WebSocket|ProjectRoom|connectToProject|\.command\("connect"\)|\.command\("disconnect"\)/);
});

test("canvas direct writes use implicit cwd observations for agents", () => {
  const source = readFileSync(new URL("./canvas.ts", import.meta.url), "utf8");

  assert.match(source, /recordWorktreeObservation/);
  assert.match(source, /requireWorktreeObservation/);
  assert.match(source, /observedVersion/);
  assert.doesNotMatch(source, /\.option\("--if-match <readToken>"/);
  assert.match(source, /actorClientType: agentClientType\(\)/);
});

test("canvas records edge graph observations without exposing tokens", () => {
  const source = readFileSync(new URL("./canvas.ts", import.meta.url), "utf8");

  assert.match(source, /\.command\("edges"\)/);
  assert.match(source, /action: "edges"/);
  assert.match(source, /entityKind: "canvas-edges"/);
  assert.match(source, /printJson\(edges\)/);
  assert.doesNotMatch(source, /Graph read token/);
});

test("canvas node commands accept and propagate a concrete Canvas scope", () => {
  const source = readFileSync(new URL("./canvas.ts", import.meta.url), "utf8");

  assert.match(source, /--canvas <id>/);
  assert.match(source, /canvasId: activeCanvasId/);
  assert.doesNotMatch(source, /client\.selectCanvas/);
});

test("CLI exposes Project Canvas registry management with implicit observations", () => {
  const commandUrl = new URL("./canvases.ts", import.meta.url);
  assert.equal(existsSync(commandUrl), true);
  const source = readFileSync(commandUrl, "utf8");
  const programSource = readFileSync(new URL("../program.ts", import.meta.url), "utf8");

  assert.match(programSource, /canvasesCommand/);
  assert.match(source, /new Command\("canvases"\)/);
  assert.match(source, /\.command\("list"\)/);
  assert.match(source, /\.command\("create"\)/);
  assert.match(source, /\.command\("rename"\)/);
  assert.match(source, /\.command\("delete"\)/);
  assert.match(source, /recordWorktreeObservation/);
  assert.match(source, /requireWorktreeObservation/);
  assert.doesNotMatch(source, /--if-match/);
  assert.doesNotMatch(source, /--force/);
});

test("canvas get exposes whole-node immutability", () => {
  const source = readFileSync(new URL("./canvas.ts", import.meta.url), "utf8");
  const hostSource = readFileSync(new URL("../../../../apps/local-api/src/project-command-host.ts", import.meta.url), "utf8");

  assert.match(source, /immutable: immutable === true/);
  assert.match(source, /Immutable:/);
  assert.match(hostSource, /immutable: isCanvasNodeImmutable/);
});

test("canvas exposes graph-aware batch delete read and apply commands", () => {
  const source = readFileSync(new URL("./canvas.ts", import.meta.url), "utf8");
  const hostSource = readFileSync(new URL("../../../../apps/local-api/src/project-command-host.ts", import.meta.url), "utf8");

  assert.match(source, /\.command\("delete-plan"\)/);
  assert.match(source, /\.command\("delete-batch"\)/);
  assert.match(source, /action: "batch_delete_plan"/);
  assert.match(source, /action: "delete_batch"/);
  assert.match(hostSource, /case "batch_delete_plan"/);
  assert.match(hostSource, /case "delete_batch"/);
});

test("canvas exposes explicit media asset copy-on-write replacement", () => {
  const source = readFileSync(new URL("./canvas.ts", import.meta.url), "utf8");
  const hostSource = readFileSync(new URL("../../../../apps/local-api/src/project-command-host.ts", import.meta.url), "utf8");
  const mediaReplacementSource = readFileSync(new URL("../../../shared-types/src/media-asset-replacement.ts", import.meta.url), "utf8");

  assert.match(source, /\.command\("replace-asset"\)/);
  assert.match(source, /action: "asset_cow_replace"/);
  assert.doesNotMatch(source, /--if-match <readToken>/);
  assert.match(source, /observedVersion/);
  assert.match(source, /copy-on-write media node/);
  assert.match(hostSource, /case "asset_cow_replace"/);
  assert.match(mediaReplacementSource, /copyOnWriteKind: "media-asset-replacement"/);
});

test("canvas exposes one generic copy command for immutable nodes", () => {
  const source = readFileSync(new URL("./canvas.ts", import.meta.url), "utf8");
  const hostSource = readFileSync(new URL("../../../../apps/local-api/src/project-command-host.ts", import.meta.url), "utf8");

  assert.match(source, /\.command\("copy"\)/);
  assert.match(source, /action: "copy_node"/);
  assert.match(source, /requireCanvasObservation/);
  assert.match(hostSource, /case "copy_node"/);
});

test("canvas exposes the same persisted spatial move used by MCP Canvas App", () => {
  const source = readFileSync(new URL("./canvas.ts", import.meta.url), "utf8");
  const hostSource = readFileSync(new URL("../../../../apps/local-api/src/project-command-host.ts", import.meta.url), "utf8");

  assert.match(source, /\.command\("move"\)/);
  assert.match(source, /\.requiredOption\("--x <number>"/);
  assert.match(source, /\.requiredOption\("--y <number>"/);
  assert.match(source, /action: "move"/);
  assert.match(source, /action: "move",[\s\S]*observedVersion,[\s\S]*ifMatch: observedVersion/);
  assert.match(source, /action: "move",[\s\S]*recordCanvasObservation/);
  assert.match(hostSource, /case "move"/);
  assert.match(hostSource, /client\.canvas\.moveNode/);
});

test("canvas add exposes the distinct Remotion component node type", () => {
  const source = readFileSync(new URL("./canvas.ts", import.meta.url), "utf8");
  const canvasContractSource = readFileSync(
    new URL("../../../shared-types/src/canvas.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /Node type:.*remotion/);
  assert.match(source, /Node type:.*html_motion/);
  assert.match(source, /Body content.*Remotion TSX/);
  assert.match(source, /action: "add",[\s\S]*type: options\.type/);
  assert.match(canvasContractSource, /remotion:\s*\{ rfType: RF_NODE_TYPE\.RemotionComponent \}/);
});

test("canvas add and update expose exact workspace file content ingestion", () => {
  for (const commandName of ["add", "update"]) {
    const command = canvasCommand.commands.find((candidate) => candidate.name() === commandName);
    assert.ok(command, `missing canvas ${commandName} command`);
    const contentFile = command.options.find((option) => option.long === "--content-file");
    assert.ok(contentFile, `canvas ${commandName} must accept --content-file`);
    assert.match(contentFile.description, /workspace.*UTF-8.*not.*persist/i);
  }
});

test("asset downloader accepts absolute and relative signed URLs", () => {
  assert.equal(
    resolveAssetDownloadUrl("https://assets.example.com/file.png", "http://localhost:8788"),
    "https://assets.example.com/file.png",
  );
  assert.equal(
    resolveAssetDownloadUrl("/assets/projects/p1/file.png", "http://localhost:8788/"),
    "http://localhost:8788/assets/projects/p1/file.png",
  );
});

test("asset downloader reads the project-scoped ResolvedAsset projection", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "clash-asset-cache-"));
  const requests: Array<{ projectId?: string; assetId: string }> = [];
  const downloads: string[] = [];

  const path = await downloadAssetById("asset/one", "project one", {
    cacheDir,
    client: {
      get: async (input) => {
        requests.push(input);
        return {
          projectId: "project one",
          value: {
            id: "asset/one",
            kind: "image",
            name: "hero.png",
            metadata: { bytes: 11, contentType: "image/png" },
            lifecycle: { state: "active" },
            status: "ready",
            url: "http://127.0.0.1:49152/api/v1/projects/project%20one/assets/asset%2Fone/media",
          },
          receipt: "asset:receipt",
        };
      },
    },
    localFile: async () => null,
    fetch: async (input) => {
      downloads.push(String(input));
      return new Response("asset-bytes", { status: 200 });
    },
  });

  assert.deepEqual(requests, [{ projectId: "project one", assetId: "asset/one" }]);
  assert.deepEqual(downloads, [
    "http://127.0.0.1:49152/api/v1/projects/project%20one/assets/asset%2Fone/media",
  ]);
  assert.equal(path, join(cacheDir, "project one--asset_one.png"));
  assert.equal(readFileSync(path!, "utf8"), "asset-bytes");
  assert.equal(statSync(path!).mode & 0o777, 0o444);
});

function readyAssetClient(assetId: string) {
  return {
    get: async () => ({
      projectId: "project-1",
      value: {
        id: assetId,
        kind: "video" as const,
        name: "clip.mp4",
        metadata: { contentType: "video/mp4" },
        lifecycle: { state: "active" as const },
        status: "ready" as const,
        url: `http://127.0.0.1:49152/api/v1/projects/project-1/assets/${assetId}/media`,
      },
      receipt: "asset:receipt",
    }),
  };
}

test("asset resolver uses a same-machine Host store file without downloading", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "clash-asset-cache-"));
  const storeFile = join(await mkdtemp(join(tmpdir(), "clash-store-")), "9f2c");
  await writeFile(storeFile, "store-bytes");
  await chmod(storeFile, 0o444);
  const lookups: string[] = [];
  let downloads = 0;

  const file = await resolveAssetFile("asset-1", "project-1", {
    cacheDir,
    client: readyAssetClient("asset-1"),
    localFile: async (assetId, projectId) => {
      lookups.push(`${projectId}/${assetId}`);
      return { path: storeFile, byteLength: 11 };
    },
    fetch: async () => {
      downloads += 1;
      return new Response("store-bytes");
    },
  });

  assert.deepEqual(lookups, ["project-1/asset-1"]);
  // The store file itself is the result, under the Asset's own name.
  assert.deepEqual(file, { path: storeFile, name: "project-1--asset-1.mp4" });
  assert.equal(downloads, 0);
  assert.deepEqual(readdirSync(cacheDir), []);
});

for (const [reason, localFile] of [
  ["is not on this machine", async () => ({ path: "/nonexistent/clash/store/9f2c", byteLength: 11 })],
  ["has a different length", async (dir: string) => {
    const path = join(dir, "9f2c");
    await writeFile(path, "truncated");
    return { path, byteLength: 11 };
  }],
  ["is a relative path", async () => ({ path: "store/9f2c", byteLength: 11 })],
  ["cannot be looked up", async () => { throw new Error("connection refused"); }],
] as const) {
  test(`asset resolver downloads when the Host store file ${reason}`, async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "clash-asset-cache-"));
    const scratch = await mkdtemp(join(tmpdir(), "clash-store-"));

    const file = await resolveAssetFile("asset-1", "project-1", {
      cacheDir,
      client: readyAssetClient("asset-1"),
      localFile: () => localFile(scratch),
      fetch: async () => new Response("asset-bytes"),
    });

    assert.deepEqual(file, {
      path: join(cacheDir, "project-1--asset-1.mp4"),
      name: "project-1--asset-1.mp4",
    });
    assert.equal(readFileSync(file!.path, "utf8"), "asset-bytes");
  });
}

test("asset resolver surfaces the Host's coded reason when it cannot serve the bytes", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "clash-asset-cache-"));
  await assert.rejects(
    resolveAssetFile("asset-1", "project-1", {
      cacheDir,
      client: {
        get: async () => ({
          projectId: "project-1",
          value: {
            id: "asset-1",
            kind: "video" as const,
            metadata: {},
            lifecycle: { state: "active" as const },
            status: "failed" as const,
            error: "LOCAL_RESOURCE_MISSING: Local Resource sha256:x has no immutable bytes on this Host.",
            errorCode: "LOCAL_RESOURCE_MISSING" as const,
          },
          receipt: "asset:receipt",
        }),
      },
      localFile: async () => null,
    }),
    (error: unknown) =>
      error instanceof LocalResourceUnavailableError &&
      error.code === "LOCAL_RESOURCE_MISSING" &&
      error.message.startsWith("LOCAL_RESOURCE_MISSING: "),
  );

  // The bytes went missing after the read: the media route says why.
  await assert.rejects(
    resolveAssetFile("asset-1", "project-1", {
      cacheDir,
      client: readyAssetClient("asset-1"),
      localFile: async () => null,
      fetch: async () =>
        Response.json(
          {
            error: "LOCAL_RESOURCE_UNREADABLE: Local Resource sha256:x bytes cannot be read (EACCES).",
            code: "LOCAL_RESOURCE_UNREADABLE",
          },
          { status: 503 },
        ),
    }),
    (error: unknown) =>
      error instanceof LocalResourceUnavailableError &&
      error.code === "LOCAL_RESOURCE_UNREADABLE",
  );
  assert.deepEqual(readdirSync(cacheDir), []);
});

test("asset downloader streams the body to disk instead of buffering it", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "clash-asset-cache-"));
  const chunk = new Uint8Array(64 * 1024).fill(7);
  const chunkCount = 32;
  let pulled = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled === chunkCount) controller.close();
        else {
          pulled += 1;
          controller.enqueue(chunk);
        }
      },
    }),
  );
  // A buffering reader would be the only way to get the body out of this.
  response.arrayBuffer = async () => {
    throw new Error("asset download must not buffer the whole body");
  };

  const path = await downloadAssetById("asset-1", "project-1", {
    cacheDir,
    client: readyAssetClient("asset-1"),
    localFile: async () => null,
    fetch: async () => response,
  });

  assert.equal(path, join(cacheDir, "project-1--asset-1.mp4"));
  assert.equal(statSync(path!).size, chunk.byteLength * chunkCount);
  assert.equal(statSync(path!).mode & 0o777, 0o444);
});

test("an interrupted asset download leaves nothing the cache would serve", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "clash-asset-cache-"));
  let sent = false;
  const interrupted = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) controller.error(new Error("connection reset"));
          else {
            sent = true;
            controller.enqueue(new TextEncoder().encode("partial"));
          }
        },
      }),
    );

  const options = {
    cacheDir,
    client: readyAssetClient("asset-1"),
    localFile: async () => null,
  };
  assert.equal(
    await downloadAssetById("asset-1", "project-1", {
      ...options,
      fetch: async () => interrupted(),
    }),
    null,
  );
  assert.deepEqual(readdirSync(cacheDir), []);

  const retried = await downloadAssetById("asset-1", "project-1", {
    ...options,
    fetch: async () => new Response("asset-bytes"),
  });
  assert.equal(readFileSync(retried!, "utf8"), "asset-bytes");
});

test("asset downloader re-marks a cached file read-only", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "clash-asset-cache-"));
  const cached = join(cacheDir, "project-1--asset-1.mp4");
  await writeFile(cached, "cached-bytes", { mode: 0o644 });

  const path = await downloadAssetById("asset-1", "project-1", {
    cacheDir,
    client: { get: async () => { throw new Error("cache hit must not ask the Host"); } },
    localFile: async () => { throw new Error("cache hit must not ask the Host"); },
  });

  assert.equal(path, cached);
  assert.equal(statSync(cached).mode & 0o777, 0o444);
});

test("resolves canvas project from clash init marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "clash-canvas-project-"));
  const { projectId } = await initProject({ cwd: root, projectId: "proj_marker_canvas" });

  assert.equal(await resolveCanvasProjectId({ cwd: root, env: {} }), projectId);
});
