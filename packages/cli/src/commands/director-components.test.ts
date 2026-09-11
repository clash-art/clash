import test from "node:test";
import assert from "node:assert/strict";
import * as director from "./director";

test("registering new source keeps prior state and instances unchanged and returns the accepted revision", async () => {
  const register = (director as any).registerDirectorComponentSource;
  assert.equal(typeof register, "function");
  const original = {
    id: "stage",
    name: "Scene",
    owner: { kind: "project" },
    revisionId: "before",
    state: {
      schemaVersion: 1,
      scene: {
        backgroundColor: "#000000",
        grid: { visible: false, snap: false, size: 1 },
      },
      objects: [],
      cameras: [],
      shots: [],
    },
  };
  const source = "export default () => <group />";
  const expected = {
    kind: "document",
    documentAssetId: "body",
    revisionId: "body-revision",
  };
  const result = await register({
    stage: original,
    componentId: "light",
    name: "Light",
    source,
    createDocument: async (body: string) => {
      assert.equal(body, source);
      return expected;
    },
    apply: async (state: any) => ({
      ...original,
      revisionId: "accepted",
      state,
    }),
  });
  assert.equal(result.revisionId, "accepted");
  assert.deepEqual(result.state.codeComponents[0].source, expected);
  assert.equal((original.state as any).codeComponents, undefined);
  assert.deepEqual(result.state.objects, original.state.objects);
  await assert.rejects(
    register({
      stage: original,
      componentId: "light",
      name: "Light",
      source,
      createDocument: async () => expected,
      apply: async () => {
        throw new Error("stale target");
      },
    }),
    /stale target/,
  );
});
