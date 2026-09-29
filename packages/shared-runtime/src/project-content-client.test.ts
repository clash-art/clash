import { expect, it } from "vitest";
import { createProjectContentClient } from "./project-content-client.js";

it("lists briefly, searches with exact evidence and reads the returned pinned Document", async () => {
  const reference = {
    kind: "document" as const,
    documentAssetId: "analysis/one",
    revisionId: "revision:old",
  };
  const calls: { path: string; init?: RequestInit }[] = [];
  const client = createProjectContentClient(async (path, init) => {
    calls.push({ path, init });
    if (path.includes("/revisions/"))
      return Response.json({
        revision: { body: { text: "pinned" } },
        readToken: "private-observation",
      });
    return Response.json({
      items: [
        {
          ref: reference,
          name: "分析",
          kind: "document",
          info: { documentKind: "text.plain" },
          matches: [],
        },
      ],
      truncated: false,
      countsByKind: { image: 0, video: 0, audio: 0, model: 0, document: 1 },
      matchMode: init?.method === "POST" ? "literal-text" : null,
    });
  });
  const listed = await client.list("school/a", {
    query: "分析",
    kinds: ["document"],
    limit: 12,
  });
  expect(calls[0].path).toContain("/api/v1/projects/school%2Fa/content?");
  expect(new URL("http://host" + calls[0].path).searchParams.get("kinds")).toBe(
    "document",
  );
  expect(new URL("http://host" + calls[0].path).searchParams.get("query")).toBe(
    "分析",
  );
  const found = await client.search("school/a", {
    query: "左袖",
    within: listed.items[0].ref,
  });
  expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({
    query: "左袖",
    within: reference,
  });
  const read = await client.read("school/a", found.items[0].ref);
  expect(calls[2].path).toContain("analysis%2Fone/revisions/revision%3Aold");
  expect(JSON.stringify(read)).not.toContain("private-observation");
});

it("does not hide invalid query or Host failure as empty search results", async () => {
  const client = createProjectContentClient(
    async () => new Response("Host temporarily unavailable", { status: 503 }),
  );
  await expect(
    client.search("p", { query: "袖子", limit: 0 }),
  ).rejects.toThrow();
  await expect(client.list("p")).rejects.toThrow(/503/);
});
