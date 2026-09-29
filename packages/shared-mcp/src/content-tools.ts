import { z } from "zod/v3";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import {
  AssetRevisionRefSchema,
  ProjectContentQuerySchema,
  createProjectContentClient,
} from "@clash/shared-runtime/project-content-client";
import { resolveProjectHostContext } from "@clash/shared-runtime/project-host-client";
import type { GeneratorRequest } from "@clash/shared-runtime/generator-client";
import type { ClashMcpServer } from "./server.js";
import { describeClashTool } from "./tool-guidance.js";

/** A small browse/find/read surface over existing Project Asset authorities. */
export function registerContentTools(
  server: ClashMcpServer,
  options: { request: GeneratorRequest },
): void {
  const client = createProjectContentClient(options.request);
  const scope = {
    projectId: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
  };
  const project = async (args: Record<string, unknown>) =>
    (
      await resolveProjectHostContext({
        cwd: args.cwd as string | undefined,
        projectId: args.projectId as string | undefined,
      })
    ).projectId;
  const register = (
    name: string,
    title: string,
    useWhen: string,
    effect: string,
    schema: Record<string, unknown>,
    call: (args: Record<string, unknown>) => Promise<unknown>,
  ) =>
    server.registerTool(
      `clash_assets_${name}`,
      {
        title,
        description: describeClashTool({
          useWhen,
          effect,
          returns:
            "project content or its existing-authority body, with exact media or pinned Document refs",
          next: "pass a returned ref to content_read or content_search within; keep its revision unchanged. For more results repeat the same query with cursor=nextCursor until null; stale cursors require restarting without cursor",
        }),
        inputSchema: { ...scope, ...schema } as ZodRawShapeCompat,
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      async (args) => {
        const result = await call(args as Record<string, unknown>);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: { result },
        };
      },
    );
  const { query, kinds, within, limit, cursor } =
    ProjectContentQuerySchema.shape;
  register(
    "content_list",
    "List project content",
    "the available project media and Documents need to be browsed or filtered by name and overview facts",
    "lists bounded project content and exact readable references without reading Document bodies",
    { query, kinds, limit, cursor },
    async (args) => {
      const input = ProjectContentQuerySchema.parse({
        query: args.query,
        kinds: args.kinds,
        limit: args.limit,
        cursor: args.cursor,
      });
      return client.list(await project(args), input);
    },
  );
  register(
    "content_search",
    "Search project content",
    "project media or Documents need to be found by name or literal content, optionally within a returned ref",
    "searches Host content facts and pinned analysis evidence; returns matching text and available source times",
    { query, kinds, within, limit, cursor },
    async (args) => {
      const input = ProjectContentQuerySchema.parse({
        query: args.query,
        kinds: args.kinds,
        within: args.within,
        limit: args.limit,
        cursor: args.cursor,
      });
      return client.search(await project(args), input);
    },
  );
  register(
    "content_read",
    "Read project content",
    "a listed or searched reference should be opened without selecting another revision",
    "reads the referenced media Asset or immutable Document body using the existing authority",
    { ref: AssetRevisionRefSchema },
    async (args) => {
      const ref = AssetRevisionRefSchema.parse(args.ref);
      return client.read(await project(args), ref);
    },
  );
}
