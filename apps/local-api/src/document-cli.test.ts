import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { serve } from "@hono/node-server";
import { afterEach, expect, it, vi } from "vitest";
import { createAssetDocumentsCommand } from "../../../packages/cli/src/commands/asset-documents";
import { writeProjectMarker } from "../../../packages/cli/src/lib/project-context";
import { createLocalApiApp } from "./app";
import { agentReadToken, createProjectAsset } from "@clash/shared-types";
import { apiFetch } from "../../../packages/cli/src/lib/api";
import { publicDocumentValue } from "@clash/shared-runtime/document-client";
import { LocalLoroRoomHub } from "./sync";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
  vi.unstubAllEnvs();
});
async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), "clash-document-cli-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  await writeProjectMarker(cwd, { schemaVersion: 1, projectId: "project" });
  const dataDir = join(cwd, "host-data");
  let rooms = new LocalLoroRoomHub(dataDir);
  cleanup.push(() => rooms.close());
  const app = createLocalApiApp({
    dataDir,
    userId: "local-user",
    documentProjectAuthority: {
      inspect: (id, read) => rooms.inspectProject(id, read),
      mutate: (id, mutate) => rooms.mutateProjectWithCheckpoint(id, mutate),
    },
  } as Parameters<typeof createLocalApiApp>[0]);
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) =>
    server.listening ? resolve() : server.once("listening", resolve),
  );
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Host did not listen");
  vi.stubEnv("CLASH_API_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("CLASH_HOME", join(cwd, "profile"));
  async function run(args: string[], commandCwd = cwd) {
    let output: any;
    const command = createAssetDocumentsCommand({
      cwd: commandCwd,
      output: (value: unknown) => {
        output = value;
      },
    } as any).exitOverride();
    for (const child of command.commands) child.exitOverride();
    await command.parseAsync(["node", "documents", ...args]);
    return output;
  }
  return {
    cwd,
    run,
    rooms,
    app,
    restart: async () => {
      await rooms.close();
      rooms = new LocalLoroRoomHub(dataDir);
    },
  };
}
it("creates, pulls, edits and applies through the default HTTP client into the persistent Host replica", async () => {
  const { cwd, run, rooms, restart } = await setup();
  const file = join(cwd, "description.json");
  const body = {
    kind: "media.description",
    schemaVersion: 1,
    text: "Original",
    sourceHash: `sha256:${"a".repeat(64)}`,
  };
  await writeFile(file, JSON.stringify(body));
  const created = await run(["create", "--kind", body.kind, "--file", file]);
  const draft = join(cwd, "draft.json");
  await run(["pull", created.asset.id, "--file", draft]);
  await writeFile(draft, JSON.stringify({ ...body, text: "Native edit" }));
  const advanced = await run(["apply", created.asset.id, "--file", draft]);
  expect(created.revision.producer).toEqual({
    kind: "actor",
    actor: { kind: "agent" },
  });
  expect(advanced.revision.parentRevisionId).toBe(created.revision.id);
  expect(
    (await run(["get", created.asset.id, "--revision", created.revision.id]))
      .body.text,
  ).toBe("Original");
  expect((await run(["get", created.asset.id])).body.text).toBe("Native edit");
  expect(
    JSON.parse(await readFile(join(cwd, ".clash", "observed.json"), "utf8"))
      .projectId,
  ).toBe("project");
  expect(
    await rooms.inspectProject("project", (doc) => doc.toJSON()),
  ).not.toEqual({});
  await restart();
  expect((await run(["get", created.asset.id])).body.text).toBe("Native edit");
});

async function descriptionFixture(
  cwd: string,
  run: (args: string[]) => Promise<any>,
  sourceRefs?: unknown[],
) {
  const body = {
    kind: "media.description",
    schemaVersion: 1,
    text: "Source",
    sourceHash: `sha256:${"b".repeat(64)}`,
  };
  const file = join(cwd, "source.json");
  await writeFile(file, JSON.stringify(body));
  const refs = join(cwd, "sources.json");
  if (sourceRefs) await writeFile(refs, JSON.stringify(sourceRefs));
  return {
    body,
    created: await run([
      "create",
      "--kind",
      body.kind,
      "--file",
      file,
      ...(sourceRefs ? ["--source-refs", refs] : []),
    ]),
  };
}
it("keeps each draft baseline after another draft applies and a subsequent get refreshes entity observation", async () => {
  const { cwd, run } = await setup();
  const { body, created } = await descriptionFixture(cwd, run);
  const first = join(cwd, "first.json"),
    second = join(cwd, "second.json");
  await expect(
    run(["apply", created.asset.id, "--file", first]),
  ).rejects.toThrow("READ_REQUIRED");
  await run(["pull", created.asset.id, "--file", first]);
  await run(["pull", created.asset.id, "--file", second]);
  await writeFile(first, JSON.stringify({ ...body, text: "First editor" }));
  await run(["apply", created.asset.id, "--file", first]);
  const head = await run(["get", created.asset.id]);
  expect(JSON.stringify(head)).not.toContain("readToken");
  await writeFile(
    second,
    JSON.stringify({ ...body, text: "Concurrent editor" }),
  );
  await expect(
    run(["apply", created.asset.id, "--file", second]),
  ).rejects.toThrow(/STALE/);
  await expect(
    run(["pull", created.asset.id, "--file", second]),
  ).rejects.toThrow("DIRTY_PROJECTION");
  expect((await run(["get", created.asset.id])).body.text).toBe("First editor");
});
it("copies a previously read exact revision without advancing or mutating its source", async () => {
  const { cwd, run } = await setup();
  const { created } = await descriptionFixture(cwd, run);
  const copy = await run([
    "copy",
    created.asset.id,
    "--revision",
    created.revision.id,
  ]);
  expect(copy.revision.forkedFrom).toEqual({
    kind: "document",
    documentAssetId: created.asset.id,
    revisionId: created.revision.id,
  });
  expect(copy.asset.id).not.toBe(created.asset.id);
  expect((await run(["get", created.asset.id])).revision.id).toBe(
    created.revision.id,
  );
});
it("uses native text and refuses to edit a noneditable kind", async () => {
  const { cwd, run } = await setup();
  const { kinds } = await run(["kinds"]);
  const textKind = kinds.find(
    (kind: any) =>
      kind.projection.format === "text" && kind.projection.editable,
  );
  const file = join(cwd, "script.txt"),
    draft = join(cwd, "draft.txt");
  await writeFile(file, "Native text\n");
  const created = await run([
    "create",
    "--kind",
    textKind.kind,
    "--file",
    file,
  ]);
  await run(["pull", created.asset.id, "--file", draft]);
  expect(await readFile(draft, "utf8")).toBe("Native text\n");
  await writeFile(draft, "Edited text\n");
  expect((await run(["apply", created.asset.id, "--file", draft])).body).toBe(
    "Edited text\n",
  );
  const readOnly = kinds.find(
    (kind: any) => kind.kind === "media.render-lineage",
  );
  const lineage = {
    kind: readOnly.kind,
    schemaVersion: readOnly.schemaVersion,
    sourceEntityKind: "timeline",
    sourceEntityId: "timeline",
    sourceRevisionId: "revision",
    sourceHash: `sha256:${"c".repeat(64)}`,
  };
  await writeFile(file, JSON.stringify(lineage));
  const immutable = await run([
    "create",
    "--kind",
    readOnly.kind,
    "--file",
    file,
  ]);
  const lineageDraft = join(cwd, "lineage.json");
  await run(["pull", immutable.asset.id, "--file", lineageDraft]);
  await expect(
    run(["apply", immutable.asset.id, "--file", lineageDraft]),
  ).rejects.toThrow("READ_ONLY_DOCUMENT");
  const copy = await run(["copy", immutable.asset.id]);
  expect(copy.body).toEqual(lineage);
  expect(copy.revision.forkedFrom.revisionId).toBe(immutable.revision.id);
});
it("fails clearly when Host is offline without changing the draft observation or a legacy manifest", async () => {
  const { cwd, run } = await setup();
  const { created } = await descriptionFixture(cwd, run);
  const draft = join(cwd, "draft.json");
  await run(["pull", created.asset.id, "--file", draft]);
  const observed = await readFile(join(cwd, ".clash", "observed.json"), "utf8");
  const manifest = join(cwd, "manifest.json");
  await writeFile(manifest, "legacy data");
  vi.stubEnv("CLASH_API_URL", "http://127.0.0.1:1");
  await expect(
    run(["apply", created.asset.id, "--file", draft]),
  ).rejects.toThrow();
  expect(await readFile(join(cwd, ".clash", "observed.json"), "utf8")).toBe(
    observed,
  );
  expect(await readFile(manifest, "utf8")).toBe("legacy data");
});

it("uses the invoking subdirectory consistently and preserves body fields named like internal protocol fields", async () => {
  const { cwd, run } = await setup();
  const sub = join(cwd, "sub");
  await mkdir(sub);
  const { created } = await descriptionFixture(sub, (args) => run(args, sub));
  await run(["pull", created.asset.id, "--file", "draft.json"], sub);
  expect(JSON.parse(await readFile(join(sub, "draft.json"), "utf8")).text).toBe(
    "Source",
  );
  await run(["apply", created.asset.id, "--file", "draft.json"], sub);
  const body = {
    readToken: "user-authored-field",
    nested: { readToken: "another-field" },
  };
  expect(publicDocumentValue({ readToken: "private", body })).toEqual({ body });
});
it("requires genuine Host receipts for HTTP agent mutations", async () => {
  const { cwd, run } = await setup();
  const { body, created } = await descriptionFixture(cwd, run);
  const path = `/api/v1/projects/project/documents/${created.asset.id}/revisions`;
  const forged = agentReadToken({
    namespace: "document",
    subject: {
      projectId: "project",
      documentAssetId: created.asset.id,
      revisionId: created.revision.id,
    },
  });
  for (const token of [undefined, "fabricated", forged]) {
    const response = await apiFetch(path, {
      method: "POST",
      headers: new Headers({
        "x-clash-client-type": "agent",
        ...(token ? { "x-clash-if-match": token } : {}),
      }),
      body: JSON.stringify({
        expectedHeadRevisionId: created.revision.id,
        revisionId: "rejected",
        body,
      }),
    });
    expect(response.status).toBe(409);
  }
  expect(
    (await run(["history", created.asset.id])).revisions.map(
      (revision: any) => revision.id,
    ),
  ).toEqual([created.revision.id]);
});
it("pins an attachment until an explicit observed attachment advance and preserves it across Document copy", async () => {
  const { cwd, run, rooms } = await setup();
  await rooms.mutateProjectWithCheckpoint(
    "project",
    async (doc, checkpoint) => {
      createProjectAsset(doc, {
        id: "image",
        kind: "image",
        source: { kind: "owned", resourceId: "image-bytes" },
        lifecycle: { state: "active" },
        metadata: { width: 1, height: 1, contentType: "image/png" },
      });
      await checkpoint();
    },
  );
  const sourceRefs = [
    { slot: "source", target: { kind: "media", projectAssetId: "image" } },
  ];
  const { created } = await descriptionFixture(cwd, run, sourceRefs);
  const target = join(cwd, "target.json");
  await writeFile(
    target,
    JSON.stringify({ kind: "project-asset", projectAssetId: "image" }),
  );
  const attached = await run([
    "attach",
    created.asset.id,
    "--revision",
    created.revision.id,
    "--target",
    target,
    "--slot",
    "description",
  ]);
  const copy = await run(["copy", created.asset.id]);
  expect(
    (await run(["attachment", attached.attachment.id])).attachment.document
      .documentAssetId,
  ).toBe(created.asset.id);
  const draft = join(cwd, "attachment-draft.json");
  await run(["pull", created.asset.id, "--file", draft]);
  const next = await run(["apply", created.asset.id, "--file", draft]);
  const other = join(cwd, "other-worktree");
  await mkdir(other);
  await writeProjectMarker(other, { schemaVersion: 1, projectId: "project" });
  await run(["attachment", attached.attachment.id], other);
  await run(["get", created.asset.id], other);
  const advanced = await run([
    "advance-attachment",
    attached.attachment.id,
    "--revision",
    next.revision.id,
  ]);
  await expect(
    run(
      [
        "advance-attachment",
        attached.attachment.id,
        "--revision",
        next.revision.id,
      ],
      other,
    ),
  ).rejects.toThrow("STALE_READ");
  expect(next.revision.sourceRefs).toEqual(sourceRefs);
  expect(copy.revision.sourceRefs).toEqual(sourceRefs);
  expect(advanced.attachment.document.revisionId).toBe(next.revision.id);
  expect(copy.revision.forkedFrom.revisionId).toBe(created.revision.id);
  expect(JSON.stringify(advanced)).not.toContain("readToken");
});

it("dispatches the shipped CLI entrypoint through the default Host HTTP transport", async () => {
  const { cwd, run } = await setup();
  const { created } = await descriptionFixture(cwd, run);
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      fileURLToPath(
        new URL("../../../packages/cli/src/index.ts", import.meta.url),
      ),
      "assets",
      "documents",
      "get",
      created.asset.id,
      "--json",
    ],
    {
      cwd,
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: fileURLToPath(
          new URL("../../../packages/cli/tsconfig.dev.json", import.meta.url),
        ),
      },
    },
  );
  const result = JSON.parse(stdout);
  expect(result.revision.id).toBe(created.revision.id);
  expect(result.body).toEqual(created.body);
  expect(result).not.toHaveProperty("readToken");
});
