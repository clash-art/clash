import { Command } from "commander";
import {
  AssetRevisionRefSchema,
  ProjectContentQuerySchema,
  createProjectContentClient,
} from "@clash/shared-runtime/project-content-client";
import type { GeneratorRequest } from "@clash/shared-runtime/generator-client";
import { apiFetch } from "../lib/api";
import { printJson } from "../lib/output";
import { resolveProjectContext } from "../lib/project-context";

function reference(value: string, option: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${option} must be the JSON ref returned by ls or search`);
  }
  return AssetRevisionRefSchema.parse(parsed);
}

type ContentOptions = {
  match?: string;
  kind?: string;
  limit?: number;
  cursor?: string;
  within?: ReturnType<typeof reference>;
  project?: string;
};

function filters(options: ContentOptions) {
  return ProjectContentQuerySchema.parse({
    ...(options.kind ? { kinds: [options.kind] } : {}),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  });
}

export function registerContentCommands(
  program: Command,
  deps: { request?: GeneratorRequest; output?: (value: unknown) => void } = {},
) {
  const client = createProjectContentClient(deps.request ?? apiFetch);
  const output = deps.output ?? printJson;
  const project = async (options: ContentOptions) =>
    (await resolveProjectContext({ project: options.project })).projectId;
  const scoped = (command: Command) =>
    command
      .option("--project <id>", "Project from cwd by default")
      .option("--json", "Structured output (always enabled)");
  const filtered = (command: Command) =>
    scoped(command)
      .option(
        "--kind <kind>",
        "image, video, audio, model or document",
        (kind) => {
          const parsed = ProjectContentQuerySchema.shape.kinds.safeParse([
            kind,
          ]);
          if (!parsed.success)
            throw new Error(
              parsed.error.issues[0]?.message ?? "Invalid content kind.",
            );
          return parsed.data![0];
        },
      )
      .option(
        "--cursor <value>",
        "Continue with the returned nextCursor and the same filters",
        (cursor) => ProjectContentQuerySchema.shape.cursor.parse(cursor),
      )
      .option("--limit <count>", "Maximum returned items (1–200)", (limit) =>
        ProjectContentQuerySchema.shape.limit.parse(Number(limit)),
      );

  filtered(
    program
      .command("ls")
      .summary("List project content; filter names, overview facts and kinds")
      .description(
        "List project media and Documents with exact refs; filter names and overview facts without reading bodies",
      )
      .addHelpText(
        "after",
        `
Examples:
  clash ls --kind video --match interview
  clash ls --kind document --limit 100

Returns items[].ref/name/kind/info, countsByKind, truncated and nextCursor. Counts describe
all matching kinds before --kind and --limit. Use search for analysis contents;
use read '<items[].ref JSON>' to inspect an exact result. No analysis is triggered.
For another page, repeat the command with --cursor '<nextCursor>'. Keep filters
unchanged. A stale cursor means content changed: restart without --cursor.`,
      )
      .option(
        "--match <text>",
        "Filter names and overview facts by literal text",
        (query) => ProjectContentQuerySchema.shape.query.parse(query),
      ),
  ).action(async (options: ContentOptions) => {
    const query = {
      ...filters(options),
      ...(options.match === undefined ? {} : { query: options.match }),
    };
    output(await client.list(await project(options), query));
  });

  filtered(
    program
      .command("search")
      .summary("Find text in names and existing analysis, with source evidence")
      .argument("<query>", "Literal text to match", (query) =>
        ProjectContentQuerySchema.shape.query.parse(query),
      )
      .description(
        "Find project content by literal text; returns matching evidence and available source times",
      ),
  )
    .option(
      "--within <refJSON>",
      "Restrict to an exact ref returned by ls or search",
      (value) => reference(value, "within"),
    )
    .addHelpText(
      "after",
      `
Examples:
  clash search "sleeve" --kind video
  clash search "sleeve" --within '{"kind":"media","projectAssetId":"<id>"}'

Returns items[].ref and items[].matches. A content match includes the exact
document ref and, when known, location.asset/startMs/endMs in source milliseconds.
Use read '<document-ref-JSON>' for the full evidence. No match means no matching
stored text: try a shorter phrase, or ls to check names and info.hasEvidence.
This is literal matching, not semantic search or automatic media analysis.
Repeat the same query and filters with --cursor '<nextCursor>' until nextCursor
is null. If content changed, restart without --cursor.`,
    )
    .action(async (query: string, options: ContentOptions) => {
      const input = ProjectContentQuerySchema.parse({
        ...filters(options),
        query,
        ...(options.within === undefined ? {} : { within: options.within }),
      });
      output(await client.search(await project(options), input));
    });

  scoped(
    program
      .command("read")
      .summary("Read a returned media or exact Document reference")
      .argument("<refJSON>", "Exact returned content reference", (value) =>
        reference(value, "ref"),
      )
      .description(
        "Read a returned media or pinned Document ref through its existing authority",
      )
      .addHelpText(
        "after",
        `
Pass an items[].ref or items[].matches[].document object from ls/search verbatim,
quoted as one JSON argument. Media returns its descriptor and delivery details;
a Document returns its pinned body and provenance, even if its head has advanced.`,
      ),
  ).action(
    async (ref: ReturnType<typeof reference>, options: ContentOptions) => {
      output(await client.read(await project(options), ref));
    },
  );
}
