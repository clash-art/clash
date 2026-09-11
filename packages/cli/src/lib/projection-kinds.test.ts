import test from "node:test";
import assert from "node:assert/strict";

import {
  getProjectionKind,
  listProjectionKinds,
  projectionFilePath,
  projectionKindForPath,
} from "./projection-kinds";

/**
 * The registry is the single source of truth for projectable entities. These
 * tests lock the properties that make it a registry rather than a fourth place
 * to hardcode per-entity paths.
 */

test("every declared kind pins its own id and a distinct projection path", () => {
  const kinds = listProjectionKinds();
  assert.ok(kinds.length >= 4);

  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const kind of kinds) {
    assert.equal(
      getProjectionKind(kind.kind),
      kind,
      `${kind.kind} must resolve to itself`,
    );
    assert.equal(ids.has(kind.kind), false, `duplicate kind ${kind.kind}`);
    ids.add(kind.kind);

    const path = projectionFilePath({
      cwd: "/w",
      kind: kind.kind,
      entityId: "entity-1",
    });
    assert.equal(
      paths.has(path),
      false,
      `${kind.kind} collides with another kind's path`,
    );
    paths.add(path);
    assert.ok(
      path.endsWith(kind.suffix),
      `${kind.kind} must use its declared suffix`,
    );
  }
});

test("an undeclared kind is refused with the declared set named", () => {
  assert.throws(
    () => getProjectionKind("storyboard-prompt-pack"),
    /Unknown projection kind: storyboard-prompt-pack.*timeline, stage, text, component/s,
  );
});

test("the historical paths of the three existing channels are preserved", () => {
  // Changing these silently orphans every projection already in a working tree.
  assert.equal(
    projectionFilePath({ cwd: "/w", kind: "timeline", entityId: "episode-1" }),
    "/w/timelines/episode-1.timeline.yaml",
  );
  assert.equal(
    projectionFilePath({ cwd: "/w", kind: "stage", entityId: "stage-1" }),
    "/w/director-stages/stage-1.director-stage.json",
  );
  assert.equal(
    projectionFilePath({ cwd: "/w", kind: "text", entityId: "text-1" }),
    "/w/projections/text/text-1.md",
  );
});

test("remotion component source is projectable like every other entity", () => {
  // The product calls agent-authored Remotion TSX an available capability, so it
  // cannot be the one editable entity without a projection channel.
  const component = getProjectionKind("component");
  assert.equal(component.suffix, ".tsx");
  assert.equal(component.idKind, "canvas-node");
  assert.equal(
    projectionFilePath({ cwd: "/w", kind: "component", entityId: "node-9" }),
    "/w/projections/components/node-9.tsx",
  );
});

test("every kind tells an agent how to learn its DSL", () => {
  for (const kind of listProjectionKinds()) {
    if (kind.dsl.source === "contract") {
      assert.match(
        kind.dsl.command,
        /^clash /,
        `${kind.kind} must name a real schema command`,
      );
    } else {
      assert.ok(
        kind.dsl.format.length > 0,
        `${kind.kind} must name its file format`,
      );
    }
  }
});

test("a projection path resolves back to the kind that owns it", () => {
  assert.equal(
    projectionKindForPath("timelines/episode-1.timeline.yaml")?.kind,
    "timeline",
  );
  assert.equal(
    projectionKindForPath("director-stages/stage-1.director-stage.json")?.kind,
    "stage",
  );
  assert.equal(
    projectionKindForPath("projections/text/text-1.md")?.kind,
    "text",
  );
  assert.equal(
    projectionKindForPath("projections/components/node-9.tsx")?.kind,
    "component",
  );
  assert.equal(projectionKindForPath("assets/manifest.json"), undefined);
});

test("entity ids never escape their projection directory", () => {
  for (const hostile of ["../outside", "a/../../b", "/etc/passwd"]) {
    const path = projectionFilePath({
      cwd: "/w",
      kind: "text",
      entityId: hostile,
    });
    assert.ok(
      path.startsWith("/w/projections/text/"),
      `${hostile} escaped to ${path}`,
    );
  }
});

test("a projection declares where its content comes from, not just where the file goes", () => {
  // Binding is the part a plugin cannot invent: the host owns how an entity is
  // read and written. A declaration picks an existing source shape.
  const sources = new Set(
    listProjectionKinds().map((kind) => kind.source.from),
  );
  assert.deepEqual([...sources].sort(), ["canvas-node", "host-entity"]);

  const component = getProjectionKind("component");
  assert.deepEqual(component.source, {
    from: "canvas-node",
    nodeType: "remotion-component",
    field: "content",
  });
  assert.deepEqual(getProjectionKind("stage").source, {
    from: "host-entity",
    entity: "director-stage",
  });
});

test("legacy metadata projections point to delivered Document commands", () => {
  assert.throws(
    () => getProjectionKind("metadata:media.transcript"),
    /METADATA_WRITE_RETIRED.*assets documents/,
  );
});
