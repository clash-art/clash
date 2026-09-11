import { Command } from "commander";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  directorStageJsonSchema,
  projectTimelineReadToken,
  timelineDslToYaml,
  TIMELINE_DSL_DEFINITION,
} from "@clash/shared-types";

import { isJsonMode, printJson } from "../lib/output";
import type { ResolvedProjectContext } from "../lib/project-context";
import { normalizeTimelineDslForYaml } from "../lib/timeline-projection";
import { applyTimelineProjection, listTimelineEntities } from "./timeline";
import { resolveCanvasActor, resolveCanvasProjectContext } from "./canvas";
import {
  applyTextContent,
  publicTextMutationResult,
  readNode,
  registerTextRevisionIndex,
} from "./text";
import {
  recordWorktreeObservation,
  requireWorktreeObservation,
} from "../lib/worktree-observations";
import {
  createTextAppliedRevision,
  textContentFromNode,
  textHash,
  textReadToken,
} from "../lib/text-projection";
import {
  getProjectionKind,
  listProjectionKinds,
  projectionFilePath,
  projectionObservationEntityKind,
  type ProjectionKind,
} from "../lib/projection-kinds";

/**
 * One surface for every agent-editable entity.
 *
 * An agent does three things with projected state: learn the DSL, pull the file,
 * apply it back. `--kind` is a parameter, so declaring a projectable entity adds
 * no command.
 */

export const projectionCommand = new Command("projection")
  .alias("projections")
  .description(
    `Agent-editable entity projections: learn the DSL, pull the file, apply it back.

Workflow:
  clash projection kinds --json
  clash projection schema --kind stage --json
  clash projection pull --kind component --id <node-id>
  # edit the file with normal file tools
  clash projection apply --kind component --id <node-id>

CAS is implicit: pull records what it read and apply refuses a stale write.
There is no token to carry and no force flag; re-pull, reconcile, apply again.`,
  );

projectionCommand
  .command("kinds")
  .description("List every projectable entity kind this build declares")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const payload = listProjectionKinds().map((kind) => ({
      kind: kind.kind,
      description: kind.description,
      path: `${kind.directory.join("/")}/<id>${kind.suffix}`,
      idKind: kind.idKind,
      source: kind.source,
      ...(kind.nodeType ? { nodeType: kind.nodeType } : {}),
      dsl: kind.dsl,
    }));
    if (isJsonMode(options)) {
      printJson(payload as unknown as Record<string, unknown>);
      return;
    }
    for (const entry of payload) {
      console.log(
        `${entry.kind.padEnd(11)} ${entry.path.padEnd(42)} ${entry.description}`,
      );
    }
  });

projectionCommand
  .command("schema")
  .description("Return the machine-readable contract for one projection kind")
  .requiredOption("--kind <kind>", "Declared projection kind")
  .option("--json", "Output as JSON")
  .action((options) => {
    try {
      const declared = getProjectionKind(options.kind);
      const contract =
        declared.kind === "stage"
          ? directorStageJsonSchema("state")
          : declared.kind === "timeline"
            ? (TIMELINE_DSL_DEFINITION as unknown as Record<string, unknown>)
            : undefined;
      const payload = {
        kind: declared.kind,
        path: `${declared.directory.join("/")}/<id>${declared.suffix}`,
        dsl: declared.dsl,
        ...(contract ? { contract } : {}),
      };
      if (isJsonMode(options)) {
        printJson(payload);
        return;
      }
      if (contract) {
        console.log(JSON.stringify(contract, null, 2));
      } else if (declared.dsl.source === "format") {
        console.log(
          `${declared.kind} is a plain ${declared.dsl.format} file at ${payload.path}; it has no separate schema.`,
        );
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

/**
 * Reads one projectable entity into the text that goes in the file, plus the revision the write
 * back will be checked against.
 *
 * Every kind reaches the file the same way; only the entity's own read differs. Keeping that
 * difference here, dispatched on the declared `source`, is what lets one pair of commands serve
 * canvas nodes and host entities alike -- and why `source` is a closed set: the host owns the read,
 * the write, and the CAS rule, and a plugin picks a shape rather than supplying its own.
 */
async function readProjection(
  declared: ProjectionKind,
  context: ResolvedProjectContext,
  entityId: string,
): Promise<{ content: string; revision: string; immutable: boolean }> {
  if (declared.source.from === "host-entity") {
    if (declared.source.entity === "timeline") {
      const listed = await listTimelineEntities(context);
      const timeline = listed.timelines.find(
        (candidate) => candidate.id === entityId,
      );
      if (!timeline) throw new Error(`Timeline ${entityId} not found`);
      return {
        content: timelineDslToYaml(normalizeTimelineDslForYaml(timeline.state)),
        revision:
          listed.versions[timeline.id] ?? projectTimelineReadToken(timeline),
        immutable: false,
      };
    }
    throw new Error(`Projection kind ${declared.kind} has no host reader.`);
  }

  const node = await readNode(context.projectId, entityId);
  if (!node) throw new Error(`Node not found: ${entityId}`);
  if (declared.nodeType && node.type !== declared.nodeType) {
    throw new Error(
      `Node ${entityId} has type "${node.type}", but kind ${declared.kind} projects "${declared.nodeType}".`,
    );
  }
  const content = textContentFromNode(node);
  return {
    content,
    revision:
      node.readToken ??
      textReadToken({
        projectId: context.projectId,
        nodeId: entityId,
        content,
      }),
    immutable: node.immutable ?? false,
  };
}

/**
 * Writes an edited projection back to the entity it came from, under the revision the pull saw.
 *
 * Symmetric with {@link readProjection}: the CAS check above is identical for every kind, and only
 * the entity's own write differs. Keeping both halves dispatched on the same declared `source` is
 * what makes one pair of commands enough -- otherwise every new projectable entity needs its own
 * pull and apply, which is how `timeline` and `director` each ended up with a command pair that
 * does what this one does.
 */
async function writeProjection(
  declared: ProjectionKind,
  context: ResolvedProjectContext,
  entityId: string,
  content: string,
  observedVersion: string,
  filePath: string,
): Promise<{
  version: string;
  textRevision?: Parameters<typeof registerTextRevisionIndex>[0];
  mutation?: Record<string, unknown>;
}> {
  if (declared.source.from === "host-entity") {
    if (declared.source.entity === "timeline") {
      const applied = await applyTimelineProjection({
        context,
        timelineId: entityId,
        content,
        observedVersion,
        filePath,
      });
      return { version: applied.version };
    }
    throw new Error(`Projection kind ${declared.kind} has no host writer.`);
  }

  const actor = await resolveCanvasActor();
  const result = await applyTextContent(context.projectId, entityId, content, {
    observedVersion,
    filePath,
    cwd: process.cwd(),
    actor,
  });
  const applied =
    result.textRevision ??
    createTextAppliedRevision({
      projectId: context.projectId,
      nodeId: entityId,
      cwd: process.cwd(),
      filePath,
      content,
      actor,
    });
  return {
    version:
      result.readToken ??
      result.version ??
      textReadToken({
        projectId: context.projectId,
        nodeId: entityId,
        content,
      }),
    textRevision: applied,
    mutation: result as unknown as Record<string, unknown>,
  };
}

/**
 * Observations are concurrency evidence, not permissions -- so they are recorded
 * and required for every client, not only agent-tagged ones. That is what lets
 * the projection loop close without exposing a read token.
 */
async function recordProjectionObservation(
  context: { workspaceRoot?: string; projectId: string },
  kind: string,
  entityId: string,
  revision: string,
): Promise<void> {
  if (!context.workspaceRoot) {
    throw new Error(
      "Projection reads require a cwd linked through .clash/project.toml.",
    );
  }
  await recordWorktreeObservation({
    workspaceRoot: context.workspaceRoot,
    projectId: context.projectId,
    entityKind: projectionObservationEntityKind(kind),
    entityId,
    revision,
  });
}

async function requireProjectionObservation(
  context: { workspaceRoot?: string; projectId: string },
  kind: string,
  entityId: string,
): Promise<string> {
  if (!context.workspaceRoot) {
    throw new Error(
      "READ_REQUIRED: Run this from a cwd linked through .clash/project.toml and pull first.",
    );
  }
  const observation = await requireWorktreeObservation({
    workspaceRoot: context.workspaceRoot,
    projectId: context.projectId,
    entityKind: projectionObservationEntityKind(kind),
    entityId,
  });
  if (!observation.ok)
    throw new Error(`${observation.code}: ${observation.error}`);
  return observation.revision;
}

function requireProjectionKind(kind: string) {
  return getProjectionKind(kind);
}

projectionCommand
  .command("pull")
  .description(
    "Write a projectable entity to an editable file and record the read",
  )
  .requiredOption("--kind <kind>", "Declared projection kind")
  .requiredOption("--id <id>", "Entity id")
  .option(
    "--project <id>",
    "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)",
  )
  .option("--file <path>", "Override the declared projection path")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    try {
      const declared = requireProjectionKind(options.kind);
      const context = await resolveCanvasProjectContext(options);
      const projectId = context.projectId;
      const filePath =
        options.file ??
        projectionFilePath({
          cwd: process.cwd(),
          kind: declared.kind,
          entityId: options.id,
        });

      const {
        content,
        revision: version,
        immutable,
      } = await readProjection(declared, context, options.id);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, "utf8");
      await recordProjectionObservation(
        context,
        declared.kind,
        options.id,
        version,
      );

      const payload = {
        pulled: true,
        kind: declared.kind,
        projectId,
        entityId: options.id,
        filePath,
        version,
        contentHash: textHash(content),
        immutable,
      };
      if (isJsonMode(options)) printJson(payload);
      else process.stderr.write(`wrote ${filePath}\n`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

projectionCommand
  .command("apply")
  .description(
    "Apply an edited projection back to the entity under implicit CAS",
  )
  .requiredOption("--kind <kind>", "Declared projection kind")
  .requiredOption("--id <id>", "Entity id")
  .option(
    "--project <id>",
    "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)",
  )
  .option("--file <path>", "Override the declared projection path")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    try {
      const declared = requireProjectionKind(options.kind);
      const context = await resolveCanvasProjectContext(options);
      const projectId = context.projectId;
      const filePath =
        options.file ??
        projectionFilePath({
          cwd: process.cwd(),
          kind: declared.kind,
          entityId: options.id,
        });
      // Implicit CAS with no agent-visible token: the pull recorded what was
      // read, and this write must still match it.
      const expectedVersion = await requireProjectionObservation(
        context,
        declared.kind,
        options.id,
      );
      const content = readFileSync(filePath, "utf8");
      const written = await writeProjection(
        declared,
        context,
        options.id,
        content,
        expectedVersion,
        filePath,
      );
      await recordProjectionObservation(
        context,
        declared.kind,
        options.id,
        written.version,
      );
      const revisionIndex = written.textRevision
        ? await registerTextRevisionIndex(written.textRevision, content)
        : undefined;

      const payload = {
        ...(written.mutation
          ? publicTextMutationResult(written.mutation)
          : { applied: true as const }),
        kind: declared.kind,
        projectId,
        entityId: options.id,
        filePath,
        revision: written.version,
        ...(revisionIndex ? { revisionIndex } : {}),
        contentHash: textHash(content),
      };
      if (isJsonMode(options)) printJson(payload);
      else process.stderr.write(`applied ${filePath} to ${options.id}\n`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
