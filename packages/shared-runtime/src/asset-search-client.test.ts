import { expect, it } from "vitest";
import { createAssetSearchClient } from "./asset-search-client.js";

it("adapts generic media evidence without assigning another source's time to the displayed Asset", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const document = {
    kind: "document",
    documentAssetId: "analysis",
    revisionId: "pinned",
  };
  const client = createAssetSearchClient(async (path, init) => {
    calls.push({ path, body: JSON.parse(String(init?.body)) });
    return Response.json({
      items: [
        {
          ref: { kind: "media", projectAssetId: "clip" },
          name: "片段",
          kind: "video",
          info: {},
          matches: [
            {
              field: "content",
              text: "folding",
              document,
              documentKind: "media.observation",
              producer: {
                kind: "actor",
                actor: { kind: "user", id: "local-user" },
              },
              sourceRefs: [],
              attachmentId: "attachment",
              location: {
                asset: { kind: "media", projectAssetId: "another-clip" },
                startMs: 3000,
                endMs: 5000,
              },
            },
          ],
        },
      ],
      countsByKind: { image: 0, video: 1, audio: 0, model: 0, document: 0 },
      truncated: true,
      matchMode: "literal-text",
    });
  });
  const result = await client.search("p", { query: "fold", assetId: "clip" });
  expect(calls).toEqual([
    {
      path: "/api/v1/projects/p/content",
      body: {
        query: "fold",
        within: { kind: "media", projectAssetId: "clip" },
        kinds: ["video", "image", "audio", "model"],
        limit: 200,
      },
    },
  ]);
  expect(result.matches[0]).toMatchObject({
    projectAssetId: "clip",
    document,
    text: "folding",
  });
  expect(result.matches[0].startMs).toBeUndefined();
  expect(result.truncated).toBe(true);
});
