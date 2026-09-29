import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { registerContentCommands } from "./content";

const pinned = {
  kind: "document" as const,
  documentAssetId: "analysis/one",
  revisionId: "revision:old",
};

test("ls and search return references that read resolves without selecting a newer revision", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const outputs: unknown[] = [];
  const request = async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (path.includes("/revisions/"))
      return Response.json({
        revision: { id: pinned.revisionId },
        body: "Fold the left sleeve",
      });
    return Response.json({
      items: [
        {
          ref: pinned,
          name: "Sleeve observations",
          kind: "document",
          info: { documentKind: "media.observation" },
          matches: [],
        },
      ],
      truncated: false,
      matchMode: init?.method === "POST" ? "literal-text" : null,
      countsByKind: { image: 0, video: 0, audio: 0, model: 0, document: 1 },
    });
  };
  const run = async (...args: string[]) => {
    const program = new Command();
    registerContentCommands(program, {
      request,
      output: (value) => outputs.push(value),
    });
    await program.parseAsync([
      "node",
      "clash",
      ...args,
      "--project",
      "p/a",
      "--json",
    ]);
  };
  await run(
    "ls",
    "--kind",
    "document",
    "--limit",
    "8",
    "--match",
    "sleeve",
    "--cursor",
    "page-token",
  );
  const listed = outputs[0] as { items: Array<{ ref: typeof pinned }> };
  assert.deepEqual(listed.items[0].ref, pinned);
  const listingUrl = new URL(calls[0].path, "http://host");
  assert.equal(listingUrl.pathname, "/api/v1/projects/p%2Fa/content");
  assert.equal(listingUrl.searchParams.get("kinds"), "document");
  assert.equal(listingUrl.searchParams.get("limit"), "8");
  assert.equal(listingUrl.searchParams.get("query"), "sleeve");
  assert.equal(listingUrl.searchParams.get("cursor"), "page-token");

  await run(
    "search",
    "left sleeve",
    "--cursor",
    "search-token",
    "--within",
    JSON.stringify(listed.items[0].ref),
  );
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
    query: "left sleeve",
    cursor: "search-token",
    within: pinned,
  });
  const found = outputs[1] as { items: Array<{ ref: typeof pinned }> };
  await run("read", JSON.stringify(found.items[0].ref));
  assert.equal(
    calls[2].path,
    "/api/v1/projects/p%2Fa/documents/analysis%2Fone/revisions/revision%3Aold",
  );
  assert.equal((outputs[2] as { body: string }).body, "Fold the left sleeve");
});

test("malformed references and invalid search bounds fail before any Host request", async () => {
  for (const args of [
    ["read", "{"],
    ["read", JSON.stringify({ kind: "document", documentAssetId: "analysis" })],
    [
      "search",
      "sleeve",
      "--within",
      JSON.stringify({
        kind: "media",
        projectAssetId: "video",
        path: "pretend/file",
      }),
    ],
    ["ls", "--limit", "0"],
    ["ls", "--kind", "folder"],
  ]) {
    const calls: string[] = [];
    const program = new Command();
    program.hook("preAction", () => {
      calls.push("bootstrap");
    });
    registerContentCommands(program, {
      request: async (path) => {
        calls.push(path);
        return Response.json({});
      },
      output: () => undefined,
    });
    await assert.rejects(
      program.parseAsync(["node", "clash", ...args, "--project", "p"]),
    );
    assert.deepEqual(calls, []);
  }
});

test("read resolves media references through the existing Asset authority", async () => {
  const paths: string[] = [];
  const outputs: unknown[] = [];
  const program = new Command();
  registerContentCommands(program, {
    request: async (path) => {
      paths.push(path);
      return Response.json({
        id: "source/video",
        kind: "video",
        status: "ready",
      });
    },
    output: (value) => outputs.push(value),
  });
  await program.parseAsync([
    "node",
    "clash",
    "read",
    JSON.stringify({ kind: "media", projectAssetId: "source/video" }),
    "--project",
    "p",
  ]);
  assert.deepEqual(paths, ["/api/v1/projects/p/assets/source%2Fvideo"]);
  assert.equal((outputs[0] as { id: string }).id, "source/video");
});

test("misspelled kinds suggest a candidate before bootstrap without rewriting the request", async () => {
  for (const command of [["ls"], ["search", "sleeve"]]) {
    const calls: string[] = [];
    const program = new Command();
    program.hook("preAction", () => {
      calls.push("bootstrap");
    });
    registerContentCommands(program, {
      request: async (path) => {
        calls.push(path);
        return Response.json({});
      },
      output: () => undefined,
    });
    await assert.rejects(
      program.parseAsync([
        "node",
        "clash",
        ...command,
        "--kind",
        "vedio",
        "--project",
        "p",
      ]),
      (error: Error) => {
        assert.match(error.message, /Invalid content kind.*vedio/);
        assert.match(error.message, /Did you mean.*video/);
        assert.match(error.message, /image, video, audio, model, document/);
        assert.doesNotMatch(error.message, /invalid_enum_value|"options"|\n/);
        return true;
      },
    );
    assert.deepEqual(calls, []);
  }
});

test("valid kinds with no matches retain their requested scope", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const outputs: unknown[] = [];
  const program = new Command();
  registerContentCommands(program, {
    request: async (path, init) => {
      calls.push({ path, init });
      return Response.json({
        items: [],
        truncated: false,
        matchMode: "literal-text",
        countsByKind: { image: 0, video: 0, audio: 0, model: 0, document: 0 },
      });
    },
    output: (value) => outputs.push(value),
  });
  await program.parseAsync([
    "node",
    "clash",
    "search",
    "no-match",
    "--kind",
    "video",
    "--project",
    "p",
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    query: "no-match",
    kinds: ["video"],
  });
  assert.deepEqual(outputs, [
    {
      items: [],
      truncated: false,
      matchMode: "literal-text",
      countsByKind: { image: 0, video: 0, audio: 0, model: 0, document: 0 },
    },
  ]);
});
