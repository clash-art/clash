import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { directorStageJsonSchema } from "@clash/shared-types";

const emptyState = {
  schemaVersion: 1 as const,
  scene: {
    backgroundColor: "#171816",
    grid: { visible: true, snap: false, size: 1 },
  },
  objects: [],
  cameras: [],
  shots: [],
};

async function captureDirectorSchema(args: string[]): Promise<unknown> {
  const { directorCommand } = await import("./director");
  const schema = directorCommand.commands.find(
    (command) => command.name() === "schema",
  );
  assert.ok(schema, "director schema must be registered");

  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const lines: string[] = [];
  globalThis.fetch = (async () => {
    throw new Error("director schema must not contact the Host");
  }) as typeof fetch;
  console.log = (...values: unknown[]) =>
    lines.push(values.map(String).join(" "));

  try {
    await schema.parseAsync(args, { from: "user" });
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }

  return JSON.parse(lines.join("\n"));
}

test("registers an agent-first Director Stage command surface", async () => {
  const module = await import("./director").catch(() => ({})) as Record<string, unknown>;
  assert.equal(typeof module.directorCommand, "object");
  const command = module.directorCommand as {
    commands: Array<{
      name(): string;
      commands: Array<{
        name(): string;
        options?: Array<{ long?: string; argChoices?: string[] }>;
      }>;
    }>;
  };
  // Stage content is authored through the projection loop, so the per-concept
  // mutation commands are retired: the JSON expresses strictly more than they
  // could (it accepts `creature`, which `object add --kind` never did).
  const registered = new Set(command.commands.map((candidate) => candidate.name()));
  for (const required of [
    "schema",
    "list",
    "create",
    "attach",
    "detach",
    "capture",
    "pull",
    "apply",
  ]) {
    assert.ok(registered.has(required), `Director must expose ${required}`);
  }
  // Every retired group must stay absent.
  for (const retired of ["object", "camera", "scene", "keyframe", "action"]) {
    assert.equal(
      command.commands.find((candidate) => candidate.name() === retired),
      undefined,
      `${retired} must stay retired in favour of the projection loop`,
    );
  }
});

test("Director schema returns the canonical authoring contract without a Host", async () => {
  assert.deepEqual(await captureDirectorSchema(["--json"]), {
    schemaVersion: 1,
    contract: "state",
    source: "@clash/shared-types",
    jsonSchema: directorStageJsonSchema("state"),
  });
});

for (const contract of ["object", "camera"] as const) {
  test(`Director schema selects the canonical ${contract} contract`, async () => {
    const { directorCommand } = await import("./director");
    const schema = directorCommand.commands.find(
      (command) => command.name() === "schema",
    );
    assert.ok(schema);
    assert.ok(
      schema.options.some((option) => option.long === "--contract"),
      "director schema must expose contract selection",
    );
    assert.deepEqual(
      await captureDirectorSchema(["--contract", contract, "--json"]),
      {
        schemaVersion: 1,
        contract,
        source: "@clash/shared-types",
        jsonSchema: directorStageJsonSchema(contract),
      },
    );
  });
}

test("Director Stage mutations use the shared command reducer and implicit read proof", async () => {
  const sourceUrl = new URL("./director.ts", import.meta.url);
  assert.equal(existsSync(fileURLToPath(sourceUrl)), true, "director.ts must exist");
  const source = readFileSync(sourceUrl, "utf8");

  assert.match(source, /applyDirectorStageCommand/);
  assert.match(source, /projectDirectorStageReadToken/);
  assert.match(source, /recordDirectorStageObservation/);
  assert.match(source, /requireDirectorStageObservation/);
  assert.match(source, /action: "list_director_stages"/);
  assert.match(source, /action: "create_director_stage"/);
  assert.match(source, /action: "update_director_stage_state"/);
  assert.match(source, /action: "attach_director_stage"/);
  assert.match(source, /action: "detach_director_stage"/);
  // The kind-specific flag families are retired with the mutation commands;
  // an agent learns the object union from `clash projection schema --kind stage`.
  assert.doesNotMatch(source, /--body-shape|--prop-type|--set-type|--vehicle-type|--light-type/);
  assert.doesNotMatch(source, /add-horse|add-rider-horse/);
  assert.doesNotMatch(source, /--if-match|--force|--lock/);
});

test("Director apply auto-pulls a stale latest projection without replaying the local edit", async () => {
  const module = await import("./director") as unknown as { directorCommand: {
    commands: readonly { name(): string; options: readonly { long?: string }[] }[];
  } };
  const source = readFileSync(new URL("./director.ts", import.meta.url), "utf8");
  const apply = module.directorCommand.commands.find((command) => command.name() === "apply");

  assert.ok(apply);
  assert.equal(apply.options.some((option) => option.long === "--base-revision"), true);
  assert.match(source, /recoverStaleProjection/);
  assert.match(source, /result\.code === "STALE_READ"/);
  assert.match(source, /directorStageCanonicalJson\(latest\.state\)/);
  assert.match(source, /staleProjectionRecoveryError\("Director Stage"/);
  assert.doesNotMatch(source, /retry.*update_director_stage_state/is);
});

test("resolves and validates Director Stage JSON projections inside cwd", async () => {
  const projection = await import("../lib/director-stage-projection").catch(() => ({})) as Record<string, unknown>;
  assert.equal(typeof projection.resolveDirectorStageFilePath, "function");
  assert.equal(typeof projection.parseDirectorStageFileForApply, "function");
  assert.equal(typeof projection.directorStageCanonicalJson, "function");

  const cwd = await mkdtemp(join(tmpdir(), "clash-director-stage-path-"));
  const resolvePath = projection.resolveDirectorStageFilePath as (input: {
    cwd: string;
    stage?: string;
    file?: string;
  }) => string;
  assert.equal(
    resolvePath({ cwd, stage: "courtyard" }),
    join(cwd, "director-stages", "courtyard.director-stage.json"),
  );
  assert.throws(
    () => resolvePath({ cwd, file: join(tmpdir(), "outside.director-stage.json") }),
    /must stay inside the current project cwd/,
  );

  const canonical = (projection.directorStageCanonicalJson as (state: unknown) => string)(emptyState);
  const parsed = (projection.parseDirectorStageFileForApply as (raw: string) => {
    ok: boolean;
    state?: unknown;
  })(canonical);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.state, emptyState);

  const legacyOutputState = {
    ...emptyState,
    cameras: [{
      id: "camera-a",
      name: "Camera A",
      position: [0, 1.6, 6],
      rotation: [0, 0, 0],
      fov: 42,
    }],
    shots: [{
      id: "legacy-capture",
      name: "Legacy capture",
      cameraId: "camera-a",
      assetId: "asset-capture",
      aspectRatio: "16:9",
      stageRevisionId: "legacy-revision",
      createdAt: "2026-08-15T00:00:00.000Z",
    }],
  };
  const migrated = JSON.parse(
    (projection.directorStageCanonicalJson as (state: unknown) => string)(
      legacyOutputState,
    ),
  );
  assert.deepEqual(migrated.shots, []);

  const rejected = (projection.parseDirectorStageFileForApply as (raw: string) => {
    ok: boolean;
    error?: string;
  })(JSON.stringify(legacyOutputState));
  assert.equal(rejected.ok, false);
  assert.match(
    rejected.error ?? "",
    /cannot contain capture outputs.*capture receipts.*Project Asset references/i,
  );
});
