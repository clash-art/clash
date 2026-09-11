import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  listDeclaredAssetMetadataKinds,
  parseDeclaredAssetMetadata,
} from "@clash/shared-types";

import { loadWorkspaceMetadataKinds } from "../lib/workspace-metadata-kinds";

let sequence = 0;

async function workspaceWithDeclaration(declaration: unknown) {
  const cwd = await mkdtemp(join(tmpdir(), "clash-custom-kind-"));
  const dataDir = await mkdtemp(join(tmpdir(), "clash-custom-kind-data-"));
  await mkdir(join(cwd, ".clash", "metadata-kinds"), { recursive: true });
  await writeFile(
    join(cwd, ".clash", "project.toml"),
    'schema_version = 1\nproject_id = "project-custom-metadata"\n',
    "utf8",
  );
  await writeFile(
    join(cwd, ".clash", "metadata-kinds", "declaration.json"),
    JSON.stringify(declaration, null, 2),
    "utf8",
  );
  const assetsPath = join(cwd, "assets", "manifest.json");
  await mkdir(join(cwd, "assets"), { recursive: true });
  await writeFile(
    assetsPath,
    JSON.stringify({
      assets: [{ id: "asset-clip", type: "video", metadata: {} }],
    }),
    "utf8",
  );
  return { cwd, dataDir, assetsPath };
}

function shotNotesDeclaration(kind: string) {
  return {
    kind,
    schema: {
      type: "object",
      required: ["kind", "schemaVersion", "mood"],
      additionalProperties: false,
      properties: {
        kind: { const: kind },
        schemaVersion: { const: 1 },
        mood: { enum: ["calm", "tense", "playful"] },
        bodyHash: { type: "string" },
      },
    },
  };
}

test("legacy workspace declarations remain available to validate existing metadata without writing", async () => {
  const kind = `team.shot-notes-${++sequence}`;
  const { cwd, assetsPath } = await workspaceWithDeclaration(
    shotNotesDeclaration(kind),
  );
  const before = await readFile(assetsPath, "utf8");
  await loadWorkspaceMetadataKinds(cwd);
  assert.ok(listDeclaredAssetMetadataKinds().includes(kind));
  const valid = { kind, schemaVersion: 1, mood: "tense" };
  assert.deepEqual(parseDeclaredAssetMetadata(kind, valid), valid);
  assert.throws(
    () => parseDeclaredAssetMetadata(kind, { ...valid, mood: "furious" }),
    /mood/,
  );
  assert.equal(await readFile(assetsPath, "utf8"), before);
});

test("refuses to redeclare a product-declared kind from a workspace", async () => {
  const { cwd } = await workspaceWithDeclaration({
    kind: "media.transcript",
    schema: {
      type: "object",
      required: ["kind", "schemaVersion"],
      properties: {
        kind: { const: "media.transcript" },
        schemaVersion: { const: 1 },
      },
    },
  });

  await assert.rejects(loadWorkspaceMetadataKinds(cwd), /already declared/);
});

test("refuses a declaration whose schema does not pin kind and schemaVersion", async () => {
  const kind = `team.unpinned-${++sequence}`;
  const { cwd } = await workspaceWithDeclaration({
    kind,
    schema: { type: "object", properties: { anything: { type: "string" } } },
  });

  await assert.rejects(loadWorkspaceMetadataKinds(cwd), /must pin "kind"/);
});
