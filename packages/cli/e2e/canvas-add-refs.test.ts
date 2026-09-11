/**
 * End-to-end test: `clash canvas add` for *_gen nodes wires references
 * the same way the web UI does — as **canvas edges** from each source
 * node to the new action-badge, with `data.referenceImageOrder`
 * carrying the positional ordering. The asset-id partitioning lives
 * downstream on the pending asset node spawned at execute time
 * (`useSpawnPendingAsset.buildShape`), so we don't expect the
 * action-badge itself to carry `referenceImageAssetIds`.
 *
 * Regression scope: this caught the bug where CLI-created action-badges
 * had `referenceImageAssetIds` in data but no edges, so the web UI's
 * ActionBadge — which derives `refNodeIds` from incoming edges, not
 * from any data field — rendered the inline prompt chips as a generic
 * placeholder `?` and refused to surface the attached references.
 *
 * Uses the built-in `node:test` runner so we don't add a new test
 * framework dependency. Drives the CLI as a subprocess (same code
 * path agents use), then reads back the node + the canvas edge list.
 *
 * Prereqs (test self-skips if any are missing):
 *   - CLASH_API_KEY + CLASH_API_URL exported
 *   - CLASH_TEST_PROJECT_ID points at a project with at least one
 *     existing `image` action-badge node we can reference
 *   - The configured local-api host is running. The CLI is only a protocol
 *     client and never opens its own Loro replica.
 *
 * Run:
 *   pnpm --filter @clash/cli test:e2e
 *   # or directly:
 *   node packages/cli/e2e/canvas-add-refs.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "dist", "index.js");

const PROJECT_ID = process.env.CLASH_TEST_PROJECT_ID;
const HAVE_AUTH = !!(process.env.CLASH_API_KEY && process.env.CLASH_API_URL);

const skipReason =
  !PROJECT_ID
    ? "CLASH_TEST_PROJECT_ID not set"
    : !HAVE_AUTH
      ? "CLASH_API_KEY / CLASH_API_URL not set"
      : false;

/** Run the CLI with --json and return parsed stdout. Throws on non-zero exit. */
function clash(args) {
  const result = spawnSync("node", [CLI, ...args, "--json"], {
    encoding: "utf-8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `clash ${args.join(" ")} exited ${result.status}\nstdout:${result.stdout}\nstderr:${result.stderr}`,
    );
  }
  // Some commands print before the JSON body (e.g., warnings). Pick
  // the *last* JSON-looking line so callers can grep without worry.
  const trimmed = result.stdout.trim();
  return trimmed.startsWith("[") || trimmed.startsWith("{")
    ? JSON.parse(trimmed)
    : trimmed;
}

/** Pick the first image action-badge / image asset node we can find on
 *  the project canvas, returning its id + assetId so we can reference it
 *  from new nodes. Fails the test if none exist — the prereq doc above
 *  says you need at least one. */
function findReferenceableImageNode() {
  const list = clash(["canvas", "list", "--project", PROJECT_ID, "--type", "image"]);
  const node = (list ?? []).find(
    (n) => typeof n?.data?.assetId === "string" && n.data.status !== "pending",
  );
  if (!node) {
    throw new Error(
      "no image node with a populated assetId on the canvas; create one in the UI before running this test",
    );
  }
  return { nodeId: node.id, assetId: node.data.assetId };
}

/** Helper: list edges incoming to a node by walking `canvas list` and
 *  asking the host's data. node:test's CLI subprocess doesn't have a
 *  dedicated `edges` subcommand yet, so we read the node's incoming
 *  references via the host's `list_edges` if present; otherwise fall
 *  back to inferring via `referenceImageOrder` (the positional list).
 *  For verification we want the EDGES — there's also a debug listing in
 *  the host protocol, but going through the CLI keeps this test
 *  parallel to how an agent would interact. */
function getRefNodeIdsFor(targetNodeId) {
  // The local-api host stores `referenceImageOrder` as the positional list of
  // incoming refs (mirror of incoming edges). The list maps 1:1 to
  // edges when refs are added through the canonical writers, which
  // the CLI uses, so this is sufficient for end-to-end verification.
  const node = clash(["canvas", "get", "--project", PROJECT_ID, "--node", targetNodeId]);
  const order = node?.data?.referenceImageOrder;
  return Array.isArray(order) ? order : [];
}

test("canvas add: @-mention in --prompt wires the source as a canvas reference", { skip: skipReason }, () => {
  const ref = findReferenceableImageNode();

  // Create the action-badge with a prompt that contains the source
  // image as an @-mention. The CLI should extract the mention,
  // resolve the node id, write the action-badge with prompt + content
  // + modelParams + referenceImageOrder, then create an edge from the
  // source → the new action-badge so the web UI's `refNodeIds` picks
  // it up.
  const created = clash([
    "canvas", "add",
    "--project", PROJECT_ID,
    "--type", "image_gen",
    "--label", "e2e-refs-prompt-mention",
    "--prompt", `make @[Source](node:${ref.nodeId}) wear sunglasses`,
    "--model", "nano-banana-2",
    "--param", "aspectRatio=16:9",
    "--param", "seed=42",
  ]);

  assert.ok(created.node_id, "add command must return a node_id");

  const node = clash(["canvas", "get", "--project", PROJECT_ID, "--node", created.node_id]);

  // Spec fields that drive both the UI editor + the executor.
  assert.equal(node.data.actionType, "image-gen", "actionType is the dash form");
  assert.equal(node.data.modelId, "nano-banana-2", "modelId persists");
  assert.deepEqual(
    node.data.modelParams,
    { aspectRatio: "16:9", seed: 42 },
    "--param k=v lands under data.modelParams (seed coerced to number; aspect ratio stays string)",
  );

  // CRITICAL: ActionBadge's prompt editor seeds from `data.content`,
  // the executor reads `data.prompt`. The two must match — they
  // silently diverged once already and CLI-created nodes rendered
  // with an empty prompt editor in the UI even though the model was
  // getting the right text.
  const expectedPrompt = `make @[Source](node:${ref.nodeId}) wear sunglasses`;
  assert.equal(node.data.prompt, expectedPrompt, "data.prompt preserves the original markdown");
  assert.equal(node.data.content, expectedPrompt, "data.content mirrors data.prompt so the UI editor shows it");

  // References should NOT be in the action-badge data as
  // `referenceImageAssetIds` — that field belongs on the pending
  // asset child the executor spawns later, after partitioning by
  // model card capability. Keeping it here would silently bypass
  // the partitioning and pin a specific kind regardless of model.
  assert.ok(
    !("referenceImageAssetIds" in node.data),
    "action-badge data must NOT carry referenceImageAssetIds; that lives on the spawned pending child",
  );

  // What the action-badge DOES carry is `referenceImageOrder` — the
  // positional ordering web's UI uses to render inline chips and
  // ActionBadge.refNodeIds is derived from. The web also reads
  // incoming edges and intersects, so both signals must agree.
  assert.deepEqual(
    getRefNodeIdsFor(created.node_id),
    [ref.nodeId],
    "referenceImageOrder must include the @-mentioned source node id",
  );
  assert.deepEqual(
    created.refNodeIds,
    [ref.nodeId],
    "CLI output should also echo the wired refs for agent introspection",
  );

  // Clean up so the canvas doesn't accumulate stale test nodes.
  clash(["canvas", "delete", "--project", PROJECT_ID, "--node", created.node_id]);
});

test("canvas add: --ref accepts both node ids and asset ids", { skip: skipReason }, () => {
  const ref = findReferenceableImageNode();

  // First with a canvas node id (used directly).
  let created = clash([
    "canvas", "add",
    "--project", PROJECT_ID,
    "--type", "image_gen",
    "--label", "e2e-refs-ref-node",
    "--prompt", "a portrait",
    "--model", "nano-banana-2",
    "--ref", ref.nodeId,
  ]);
  assert.deepEqual(getRefNodeIdsFor(created.node_id), [ref.nodeId], "--ref <nodeId> uses the id directly");
  clash(["canvas", "delete", "--project", PROJECT_ID, "--node", created.node_id]);

  // Then with the raw asset id (CLI reverse-resolves it through the
  // canvas: find the node whose data.assetId === ref.assetId, use
  // that node's id as the edge source).
  created = clash([
    "canvas", "add",
    "--project", PROJECT_ID,
    "--type", "image_gen",
    "--label", "e2e-refs-ref-asset",
    "--prompt", "a portrait",
    "--model", "nano-banana-2",
    "--ref", ref.assetId,
  ]);
  assert.deepEqual(
    getRefNodeIdsFor(created.node_id),
    [ref.nodeId],
    "--ref <assetId> reverse-resolves to the source canvas node id",
  );
  clash(["canvas", "delete", "--project", PROJECT_ID, "--node", created.node_id]);
});

test("canvas add: prompt mention + explicit --ref dedupe", { skip: skipReason }, () => {
  const ref = findReferenceableImageNode();

  // The same source appears both as a prompt @-mention and an
  // explicit --ref. The CLI must dedupe before wiring so there's
  // exactly one edge / one entry in referenceImageOrder.
  const created = clash([
    "canvas", "add",
    "--project", PROJECT_ID,
    "--type", "image_gen",
    "--label", "e2e-refs-dedupe",
    "--prompt", `redraw @[X](node:${ref.nodeId})`,
    "--ref", ref.nodeId,
    "--model", "nano-banana-2",
  ]);
  const order = getRefNodeIdsFor(created.node_id);
  assert.equal(order.length, 1, "duplicate ref via prompt + --ref should collapse to one");
  clash(["canvas", "delete", "--project", PROJECT_ID, "--node", created.node_id]);
});
