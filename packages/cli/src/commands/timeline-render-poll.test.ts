import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { PROJECT_ASSET_RENDER_CANVAS_ID } from "@clash/shared-types/timeline-contract";
import { timelineCommand } from "./timeline";

const originalApiUrl = process.env.CLASH_API_URL;
const originalApiKey = process.env.CLASH_API_KEY;
const originalUserId = process.env.CLASH_USER_ID;

afterEach(() => {
  if (originalApiUrl === undefined) delete process.env.CLASH_API_URL;
  else process.env.CLASH_API_URL = originalApiUrl;
  if (originalApiKey === undefined) delete process.env.CLASH_API_KEY;
  else process.env.CLASH_API_KEY = originalApiKey;
  if (originalUserId === undefined) delete process.env.CLASH_USER_ID;
  else process.env.CLASH_USER_ID = originalUserId;
  vi.restoreAllMocks();
});

async function readRequestBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

function replyJson(response: ServerResponse, body: unknown): void {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

it("polls a standalone Timeline render through the Host render readback", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const command = await readRequestBody(request);
    requests.push(command);
    if (command.action === "request_timeline_render") {
      replyJson(response, {
        submitted: true,
        timelineId: "rough-cut",
        sourceTimelineRevisionId: "revision-1",
        renderNodeId: "render-1",
        target: { kind: "project-assets" },
      });
      return;
    }
    if (command.action === "list_timeline_renders") {
      replyJson(response, {
        canvasId: PROJECT_ASSET_RENDER_CANVAS_ID,
        status: "all",
        renders: [
          {
            node: {
              id: "render-1",
              canvas_id: PROJECT_ASSET_RENDER_CANVAS_ID,
              type: "video",
              data: { status: "generating" },
            },
          },
        ],
      });
      return;
    }
    if (command.action === "get") {
      replyJson(response, {
        error: `Canvas ${PROJECT_ASSET_RENDER_CANVAS_ID} not found`,
      });
      return;
    }
    replyJson(response, {
      error: `Unexpected action ${String(command.action)}`,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Test server has no TCP address");
    process.env.CLASH_API_URL = `http://127.0.0.1:${address.port}`;
    delete process.env.CLASH_API_KEY;
    process.env.CLASH_USER_ID = "user-test";
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      output.push(String(line ?? ""));
    });

    await timelineCommand
      .exitOverride()
      .parseAsync(
        [
          "render",
          "--timeline",
          "rough-cut",
          "--project",
          "project-1",
          "--no-wait",
          "--json",
        ],
        { from: "user" },
      );

    expect(JSON.parse(output.join("\n"))).toMatchObject({
      completed: false,
      renderNodeId: "render-1",
      status: "pending",
      actionRunId: "render-1",
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({
      action: "list_timeline_renders",
      status: "all",
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

it("polls a Canvas-owned Timeline render through native render readback", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const command = await readRequestBody(request);
    requests.push(command);
    if (command.action === "request_timeline_render") {
      replyJson(response, {
        submitted: true,
        timelineId: "attached-cut",
        sourceTimelineRevisionId: "revision-2",
        renderNodeId: "render-2",
        target: {
          kind: "canvas",
          canvasId: "main",
          actionNodeId: "timeline-action",
        },
      });
      return;
    }
    if (command.action === "list_timeline_renders") {
      replyJson(response, {
        status: "all",
        renders: [
          { node: { id: "render-2", data: { status: "generating" } } },
        ],
      });
      return;
    }
    replyJson(response, {
      error: `Unexpected action ${String(command.action)}`,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Test server has no TCP address");
    process.env.CLASH_API_URL = `http://127.0.0.1:${address.port}`;
    delete process.env.CLASH_API_KEY;
    process.env.CLASH_USER_ID = "user-test";
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      output.push(String(line ?? ""));
    });

    await timelineCommand
      .exitOverride()
      .parseAsync(
        [
          "render",
          "--timeline",
          "attached-cut",
          "--project",
          "project-1",
          "--no-wait",
          "--json",
        ],
        { from: "user" },
      );

    expect(JSON.parse(output.join("\n"))).toMatchObject({
      completed: false,
      renderNodeId: "render-2",
      status: "pending",
      actionRunId: "render-2",
    });
    expect(requests[1]).toEqual({
      action: "list_timeline_renders",
      status: "all",
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
