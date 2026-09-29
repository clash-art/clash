import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  TIMELINE_DSL_DEFINITION,
  TIMELINE_OPERATION_CATALOG,
  TimelineDiscoveryViewSchema,
  projectTimelineReadToken,
  summarizeProjectTimeline,
  timelineDslDiscovery,
  timelineDslToYaml,
  type TimelineAgentOperationId,
  type ProjectTimeline,
  type ProjectHostCommand,
  type ResolvedTimelineDsl,
} from "@clash/shared-types";
import { isJsonMode, printJson, printTable } from "../lib/output";
import { sendProjectCommand } from "../lib/project-host-client";
import { type ResolvedProjectContext } from "../lib/project-context";
import {
  recordWorktreeObservation,
  requireWorktreeObservation,
} from "../lib/worktree-observations";
import {
  resolveCanvasPresenceOptions,
  resolveCanvasActor,
  resolveCanvasProjectContext,
} from "./canvas";
import { fetchAssetRecord, type AssetRecordResult } from "./assets";
import {
  normalizeTimelineDslForYaml,
  parseTimelineFileForApply,
  resolveTimelineFilePath,
  timelineHash,
} from "../lib/timeline-projection";
import { writeTimelineTranscriptProjection } from "../lib/timeline-transcript-projection";
import {
  recoverStaleProjection,
  staleProjectionRecoveryError,
} from "../lib/stale-projection-recovery";

function isAgentTimelineClient(): boolean {
  return resolveCanvasPresenceOptions().clientType === "agent";
}

async function recordTimelineObservation(
  context: ResolvedProjectContext,
  nodeId: string,
  revision: string,
): Promise<void> {
  if (!isAgentTimelineClient()) return;
  if (!context.workspaceRoot) {
    throw new Error("Agent reads require a cwd linked through .clash/project.toml.");
  }
  await recordWorktreeObservation({
    workspaceRoot: context.workspaceRoot,
    projectId: context.projectId,
    entityKind: "timeline",
    entityId: nodeId,
    revision,
  });
}

async function requireTimelineObservation(
  context: ResolvedProjectContext,
  nodeId: string,
): Promise<string | undefined> {
  if (!isAgentTimelineClient()) return undefined;
  if (!context.workspaceRoot) {
    throw new Error("READ_REQUIRED: Run the command from a cwd linked through .clash/project.toml and pull the timeline first.");
  }
  const observation = await requireWorktreeObservation({
    workspaceRoot: context.workspaceRoot,
    projectId: context.projectId,
    entityKind: "timeline",
    entityId: nodeId,
  });
  if (!observation.ok) throw new Error(`${observation.code}: ${observation.error}`);
  return observation.revision;
}

export const timelineCommand = new Command("timeline")
  .summary("Edit and render timelines through local YAML files")
  .description("Manage Project Timeline entities through agent-editable YAML projections.")
  .addHelpText("after",
    `

Workflow:
  clash timeline list --json                         # reuse an existing cut
  clash timeline create --id episode-1 --name "Episode 1"
  clash timeline pull --timeline episode-1 --json    # returns filePath and revision
  # edit the returned YAML file with normal file tools
  clash timeline apply --timeline episode-1 --json   # validates and commits
  clash timeline pull --timeline episode-1 --json    # verify committed state

Keep the pulled root fields. A minimal track for a two-second, 30 fps video is:
  tracks:
    - id: main
      category: primary
      items:
        - id: shot
          type: video
          assetId: <returned-projectAssetId>
          from: 0
          durationInFrames: 60

Set root fps, compositionWidth, compositionHeight and durationInFrames for the
actual cut. Item from/durationInFrames use composition frames, not milliseconds.
An Action-cropped video is a new Asset: reference its ID and start at its beginning.
Search evidence times use milliseconds; video-clipper parameters use seconds.

For additional item fields: clash timeline schema (fields.itemTypes, examples.basic).
Use --view full only for the complete JSON Schema. Apply validates automatically;
timeline validate --file <path> is an optional local check. A successful apply is
saved timeline state, not a rendered video; use clash timeline render --help to export.

Project comes from cwd; --project <id> overrides it. Read-before-write is automatic.
If apply reports a stale write, inspect its recovery file, pull, merge and apply again.`,
  );

type TimelineWorkspaceResult = {
  timelines?: ProjectTimeline[];
  timeline?: ProjectTimeline;
  versions?: Record<string, string>;
  version?: string;
  readToken?: string;
  sourceVersion?: string;
  error?: string;
  code?: string;
};

export type TimelineRenderReceipt = {
  submitted: true;
  completed: boolean;
  timelineId: string;
  sourceTimelineRevisionId: string;
  renderNodeId: string;
  /** Native render identity accepted by the shared Action wait/read surface. */
  actionRunId: string;
  target: { kind: "project-assets" } | {
    kind: "canvas";
    canvasId: string;
    actionNodeId: string;
  };
  status: "pending" | "completed" | "failed";
  asset?: AssetRecordResult;
  error?: string;
  next?: string;
};

export type TimelineHostTransport = {
  isRunning(projectId: string): boolean;
  send(projectId: string, command: ProjectHostCommand): Promise<object>;
};

const defaultTimelineHostTransport: TimelineHostTransport = {
  isRunning: () => true,
  send: sendProjectCommand,
};

timelineCommand
  .command("schema")
  .description(TIMELINE_OPERATION_CATALOG.agent["timeline.schema"].description)
  .option(
    "--view <view>",
    "Discovery view: authoring or full",
    "authoring",
  )
  .option("--json", "Output the schema contract as JSON")
  .action((options) => {
    const view = TimelineDiscoveryViewSchema.safeParse(options.view);
    if (!view.success) {
      throw new Error("--view must be authoring or full");
    }
    const payload = timelineDslDiscovery(view.data);
    if (isJsonMode(options)) printJson(payload);
    else console.log(JSON.stringify(payload, null, 2));
  });

timelineCommand
  .command("validate")
  .description(TIMELINE_OPERATION_CATALOG.agent["timeline.validate"].description)
  .requiredOption("--file <path>", "Timeline YAML or JSON projection to validate")
  .option("--json", "Output the validation result as JSON")
  .action((options) => {
    const filePath = String(options.file);
    const parsed = parseTimelineFileForApply(readFileSync(filePath, "utf8"));
    if (!parsed.ok) throw new Error(`TIMELINE_DSL_INVALID: ${parsed.error}`);
    const result = {
      ok: true,
      contractFingerprint: TIMELINE_DSL_DEFINITION.contractFingerprint,
      sources: parsed.sources,
    };
    if (isJsonMode(options)) printJson(result);
    else console.log(`Timeline DSL is valid (${result.contractFingerprint})`);
  });

function timelinePosition(value: unknown, option: string): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) throw new Error(`${option} must be a finite number`);
  return parsed;
}

/**
 * Applies an edited Timeline projection under an already-established observation.
 *
 * Extracted so the generic `projection apply` can write a Timeline the same way this command does.
 * The observation is passed in rather than recorded here: the CAS rule is the projection loop's,
 * identical for every kind, and duplicating it per entity is what produced two commands doing one
 * job.
 */
export async function applyTimelineProjection(options: {
  context: ResolvedProjectContext;
  timelineId: string;
  content: string;
  observedVersion: string;
  filePath: string;
}): Promise<{ version: string }> {
  const parsed = parseTimelineFileForApply(options.content);
  if (!parsed.ok) throw new Error(parsed.error);
  const result = await sendProjectCommand<TimelineWorkspaceResult>(options.context.projectId, {
    action: "update_timeline_state",
    timelineId: options.timelineId,
    state: parsed.dsl,
    sourceNodeIds: parsed.sources,
    actorClientType: resolveCanvasPresenceOptions().clientType,
    observedVersion: options.observedVersion,
    ifMatch: options.observedVersion,
  });
  if (result.error) throw new Error(result.error);
  return { version: result.version ?? "" };
}

export async function listTimelineEntities(
  context: ResolvedProjectContext,
  transport: TimelineHostTransport = defaultTimelineHostTransport,
): Promise<{ timelines: ProjectTimeline[]; versions: Record<string, string> }> {
  const result = await transport.send(context.projectId, {
    action: "list_timelines",
  }) as TimelineWorkspaceResult;
  if (result.error) throw new Error(result.error);
  return { timelines: result.timelines ?? [], versions: result.versions ?? {} };
}

export async function readTimelineEntityForProjection(
  context: ResolvedProjectContext,
  timelineId: string,
): Promise<ProjectTimeline> {
  const result = await listTimelineEntities(context);
  const timeline = result.timelines.find((candidate) => candidate.id === timelineId);
  if (!timeline) throw new Error(`Timeline ${timelineId} not found`);
  await recordTimelineObservation(
    context,
    timeline.id,
    result.versions[timeline.id] ?? projectTimelineReadToken(timeline),
  );
  return timeline;
}

/**
 * Publish a generated, schema-valid Timeline state through the authoritative
 * Project Timeline entity. The local-api host path performs its own fresh list read
 * and sends the returned host receipt back as the mutation CAS proof, so a
 * one-shot production command cannot silently overwrite a concurrently edited
 * Timeline.
 */
export async function publishTimelineState(
  context: ResolvedProjectContext,
  timelineId: string,
  state: ResolvedTimelineDsl,
  transport: TimelineHostTransport = defaultTimelineHostTransport,
): Promise<ProjectTimeline> {
  const listed = await listTimelineEntities(context, transport);
  const current = listed.timelines.find((candidate) => candidate.id === timelineId);
  if (!current) throw new Error(`Timeline ${timelineId} not found`);
  const readProof = listed.versions[timelineId] ?? projectTimelineReadToken(current);
  await recordTimelineObservation(context, timelineId, readProof);

  const result = await transport.send(context.projectId, {
    action: "update_timeline_state",
    timelineId,
    state,
    actorClientType: resolveCanvasPresenceOptions().clientType,
    ifMatch: readProof,
  }) as TimelineWorkspaceResult;
  if (result.error || !result.timeline) {
    throw new Error(result.error ?? "Timeline production publish failed");
  }
  await recordTimelineObservation(
    context,
    timelineId,
    result.readToken ?? result.version ?? projectTimelineReadToken(result.timeline),
  );
  return result.timeline;
}

async function recordTimelineVersions(
  context: ResolvedProjectContext,
  versions: Record<string, string>,
): Promise<void> {
  for (const [timelineId, revision] of Object.entries(versions)) {
    await recordTimelineObservation(context, timelineId, revision);
  }
}

async function recoverStaleTimelineApply(options: {
  context: ResolvedProjectContext;
  timelineId: string;
  editedProjectionPath: string;
  transport?: TimelineHostTransport;
}): Promise<never> {
  const listed = await listTimelineEntities(
    options.context,
    options.transport ?? defaultTimelineHostTransport,
  );
  const latest = listed.timelines.find((candidate) => candidate.id === options.timelineId);
  if (!latest) throw new Error(`Timeline ${options.timelineId} not found after the stale write was rejected`);
  const currentObservation = listed.versions[latest.id] ?? projectTimelineReadToken(latest);
  const recovery = await recoverStaleProjection({
    workspaceRoot: options.context.workspaceRoot ?? process.cwd(),
    projectId: options.context.projectId,
    entityKind: "timeline",
    entityId: latest.id,
    currentRevisionId: latest.revisionId,
    currentObservation,
    editedProjectionPath: options.editedProjectionPath,
    latestContent: timelineDslToYaml(normalizeTimelineDslForYaml(latest.state)),
  });
  throw staleProjectionRecoveryError("Timeline", recovery);
}

export async function prepareTimelineApplyObservation(options: {
  context: ResolvedProjectContext;
  timelineId: string;
  editedProjectionPath: string;
  baseRevisionId?: string;
  transport?: TimelineHostTransport;
}): Promise<string | undefined> {
  const baseRevisionId = options.baseRevisionId?.trim() ?? "";
  if (!baseRevisionId) {
    return requireTimelineObservation(options.context, options.timelineId);
  }
  const transport = options.transport ?? defaultTimelineHostTransport;
  const listed = await listTimelineEntities(options.context, transport);
  const latest = listed.timelines.find((candidate) => candidate.id === options.timelineId);
  if (!latest) throw new Error(`Timeline ${options.timelineId} not found`);
  if (latest.revisionId !== baseRevisionId) {
    await recoverStaleTimelineApply({
      context: options.context,
      timelineId: options.timelineId,
      editedProjectionPath: options.editedProjectionPath,
      transport,
    });
  }
  const observedVersion = listed.versions[latest.id] ?? projectTimelineReadToken(latest);
  await recordTimelineObservation(options.context, latest.id, observedVersion);
  return observedVersion;
}

timelineCommand
  .command("list")
  .description(TIMELINE_OPERATION_CATALOG.agent["timeline.list"].description)
  .option("--project <id>", "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)")
  .option("--standalone", "Show only standalone Project Timelines")
  .option("--full", "Include complete Timeline state (default: identity, dimensions and item counts)")
  .option("--json", "Output result as JSON")
  .action(async (options) => {
    const context = await resolveCanvasProjectContext(options);
    const result = await listTimelineEntities(context);
    await recordTimelineVersions(context, result.versions);
    const timelines = options.standalone
      ? result.timelines.filter((timeline) => timeline.owner.kind === "project")
      : result.timelines;
    if (isJsonMode(options)) {
      printJson(options.full ? timelines : timelines.map(summarizeProjectTimeline));
      return;
    }
    printTable(timelines.map((timeline) => ({
      id: timeline.id,
      name: timeline.name,
      owner: timeline.owner.kind === "project"
        ? "Project"
        : `Canvas ${timeline.owner.canvasId}`,
      node: timeline.owner.kind === "canvas-action" ? timeline.owner.actionNodeId : "",
    })), [
      { key: "id", label: "Timeline", width: 24 },
      { key: "name", label: "Name", width: 28 },
      { key: "owner", label: "Owner", width: 24 },
      { key: "node", label: "Action Node", width: 24 },
    ]);
  });

timelineCommand
  .command("create")
  .description(TIMELINE_OPERATION_CATALOG.agent["timeline.create"].description)
  .requiredOption("--id <id>", "Project-scoped Timeline ID")
  .requiredOption("--name <name>", "Timeline name")
  .option("--project <id>", "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)")
  .option("--json", "Output result as JSON")
  .action(async (options) => {
    const context = await resolveCanvasProjectContext(options);
    const result = await sendProjectCommand<TimelineWorkspaceResult>(context.projectId, {
      action: "create_timeline",
      timelineId: options.id,
      name: options.name,
      state: { tracks: [] },
    });
    if (result.error || !result.timeline) throw new Error(result.error ?? "Timeline create failed");
    await recordTimelineObservation(
      context,
      result.timeline.id,
      result.readToken ?? result.version ?? projectTimelineReadToken(result.timeline),
    );
    if (isJsonMode(options)) printJson(result.timeline);
    else console.log(`Created Timeline: ${result.timeline.id}`);
  });

timelineCommand
  .command("attach")
  .description(TIMELINE_OPERATION_CATALOG.agent["timeline.attach"].description)
  .requiredOption("--timeline <id>", "Standalone Timeline ID")
  .requiredOption("--canvas <id>", "Owning Canvas ID")
  .option("--node <id>", "Timeline Action node ID (defaults to a generated ID)")
  .option("--x <number>", "Canvas X position", "0")
  .option("--y <number>", "Canvas Y position", "0")
  .option("--project <id>", "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)")
  .option("--json", "Output result as JSON")
  .action(async (options) => {
    const context = await resolveCanvasProjectContext(options);
    const timelineId = String(options.timeline);
    const observedVersion = await requireTimelineObservation(context, timelineId);
    const actionNodeId = options.node?.trim() || randomUUID().slice(0, 8);
    const result = await sendProjectCommand<TimelineWorkspaceResult>(context.projectId, {
      action: "attach_timeline",
      timelineId,
      canvasId: options.canvas,
      actionNodeId,
      position: {
        x: timelinePosition(options.x, "--x"),
        y: timelinePosition(options.y, "--y"),
      },
      actorClientType: resolveCanvasPresenceOptions().clientType,
      observedVersion,
      ifMatch: observedVersion,
    });
    if (result.error || !result.timeline) throw new Error(result.error ?? "Timeline attach failed");
    await recordTimelineObservation(
      context,
      timelineId,
      result.readToken ?? result.version ?? projectTimelineReadToken(result.timeline),
    );
    if (isJsonMode(options)) printJson(result.timeline);
    else console.log(`Attached Timeline ${timelineId} to Canvas ${options.canvas} as ${actionNodeId}`);
  });

timelineCommand
  .command("detach")
  .description(TIMELINE_OPERATION_CATALOG.agent["timeline.detach"].description)
  .requiredOption("--timeline <id>", "Canvas-owned Timeline ID")
  .option("--project <id>", "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)")
  .option("--json", "Output result as JSON")
  .action(async (options) => {
    const context = await resolveCanvasProjectContext(options);
    const timelineId = String(options.timeline);
    const observedVersion = await requireTimelineObservation(context, timelineId);
    const result = await sendProjectCommand<TimelineWorkspaceResult>(context.projectId, {
      action: "detach_timeline",
      timelineId,
      actorClientType: resolveCanvasPresenceOptions().clientType,
      observedVersion,
      ifMatch: observedVersion,
    });
    if (result.error || !result.timeline) throw new Error(result.error ?? "Timeline detach failed");
    await recordTimelineObservation(
      context,
      timelineId,
      result.readToken ?? result.version ?? projectTimelineReadToken(result.timeline),
    );
    if (isJsonMode(options)) printJson(result.timeline);
    else console.log(`Detached Timeline: ${timelineId}`);
  });

timelineCommand
  .command("copy")
  .description(TIMELINE_OPERATION_CATALOG.agent["timeline.copy"].description)
  .requiredOption("--timeline <id>", "Source Timeline ID")
  .requiredOption("--canvas <id>", "Target Canvas ID")
  .option("--new-timeline <id>", "New Timeline ID (defaults to a generated ID)")
  .option("--new-node <id>", "New Timeline Action node ID (defaults to a generated ID)")
  .option("--x <number>", "Target Canvas X position", "0")
  .option("--y <number>", "Target Canvas Y position", "0")
  .option("--project <id>", "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)")
  .option("--json", "Output result as JSON")
  .action(async (options) => {
    const context = await resolveCanvasProjectContext(options);
    const timelineId = String(options.timeline);
    const observedVersion = await requireTimelineObservation(context, timelineId);
    const newTimelineId = options.newTimeline?.trim() || randomUUID().slice(0, 8);
    const newActionNodeId = options.newNode?.trim() || randomUUID().slice(0, 8);
    const result = await sendProjectCommand<TimelineWorkspaceResult>(context.projectId, {
      action: "copy_timeline_action",
      sourceTimelineId: timelineId,
      targetCanvasId: options.canvas,
      newTimelineId,
      newActionNodeId,
      position: {
        x: timelinePosition(options.x, "--x"),
        y: timelinePosition(options.y, "--y"),
      },
      actorClientType: resolveCanvasPresenceOptions().clientType,
      observedVersion,
      ifMatch: observedVersion,
    });
    if (result.error || !result.timeline) throw new Error(result.error ?? "Timeline copy failed");
    await recordTimelineObservation(
      context,
      newTimelineId,
      result.readToken ?? result.version ?? projectTimelineReadToken(result.timeline),
    );
    if (isJsonMode(options)) printJson(result.timeline);
    else console.log(`Copied Timeline ${timelineId} to ${newTimelineId} on Canvas ${options.canvas}`);
  });

timelineCommand
  .command("render")
  .description(TIMELINE_OPERATION_CATALOG.agent["timeline.render"].description)
  .requiredOption("--timeline <id>", "Timeline ID")
  .option("--project <id>", "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)")
  .option("--no-wait", "Return the durable render-node receipt without waiting for completion")
  .option("--timeout-ms <milliseconds>", "Maximum completion wait in milliseconds", "1800000")
  .option("--json", "Output the render receipt as JSON")
  .addHelpText("after", "\nTo resume a pending render, use clash actions wait <actionRunId> --json.\nThis reads the existing Run; do not submit timeline render again just to poll.\n")
  .action(async (options) => {
    const context = await resolveCanvasProjectContext(options);
    const timelineId = String(options.timeline);
    const timeoutMs = Number(options.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
      throw new Error("--timeout-ms must be an integer of at least 1000");
    }
    const actor = await resolveCanvasActor();
    const submitted = await sendProjectCommand<{
      submitted?: boolean;
      timelineId?: string;
      sourceTimelineRevisionId?: string;
      renderNodeId?: string;
      target?: TimelineRenderReceipt["target"];
      error?: string;
    }>(context.projectId, {
      action: "request_timeline_render",
      timelineId,
      actorUserId: actor.actorUserId,
      ...(actor.actorAgentId ? { actorAgentId: actor.actorAgentId } : {}),
    });
    if (submitted.error || !submitted.renderNodeId || !submitted.sourceTimelineRevisionId || !submitted.target) {
      throw new Error(submitted.error ?? "Timeline render request failed");
    }
    const base = {
      submitted: true as const,
      timelineId,
      sourceTimelineRevisionId: submitted.sourceTimelineRevisionId,
      renderNodeId: submitted.renderNodeId,
      actionRunId: submitted.renderNodeId,
      target: submitted.target,
    };
    const deadline = Date.now() + timeoutMs;
    let receipt: TimelineRenderReceipt = { ...base, completed: false, status: "pending" };
    while (true) {
      const result = await sendProjectCommand<{
        renders?: Array<{
          node?: { id?: string; data?: Record<string, unknown> };
        }>;
        error?: string;
      }>(context.projectId, {
        action: "list_timeline_renders",
        status: "all",
      });
      if (result.error) throw new Error(result.error);
      const renderNode = result.renders
        ?.map((entry) => entry.node)
        .find((node) => node?.id === submitted.renderNodeId);
      if (!renderNode) {
        throw new Error(
          `Timeline native render ${submitted.renderNodeId} was not returned by Host readback`,
        );
      }
      const data = renderNode.data ?? {};
      if (data.status === "completed") {
        if (typeof data.assetId !== "string" || !data.assetId.trim()) {
          receipt = { ...base, completed: false, status: "failed", error: "Timeline render completed without an immutable Asset id" };
        } else {
          receipt = {
            ...base,
            completed: true,
            status: "completed",
            asset: await fetchAssetRecord({
              assetId: data.assetId.trim(),
              projectId: context.projectId,
            }),
          };
        }
        break;
      }
      if (data.status === "failed") {
        receipt = {
          ...base,
          completed: false,
          status: "failed",
          ...(typeof data.error === "string" ? { error: data.error } : {}),
        };
        break;
      }
      if (options.wait === false || Date.now() >= deadline) break;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    if (!receipt.completed) {
      receipt.next = `Read the existing render with clash actions wait ${JSON.stringify(receipt.actionRunId)} --project ${JSON.stringify(context.projectId)} --json; do not resubmit to poll.`;
    }
    await recordTimelineObservation(context, timelineId, receipt.sourceTimelineRevisionId);
    if (isJsonMode(options)) printJson(receipt);
    else console.log(
      receipt.completed
        ? `Rendered Timeline ${timelineId}: ${receipt.asset?.id ?? receipt.renderNodeId}`
        : `Timeline render ${receipt.renderNodeId}: ${receipt.status}\n${receipt.next}`,
    );
  });

timelineCommand
  .command("pull")
  .description(TIMELINE_OPERATION_CATALOG.agent["timeline.pull"].description)
  .requiredOption("--timeline <id>", "Timeline ID")
  .option("--project <id>", "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)")
  .option("--file <path>", "Timeline YAML path (default: timelines/<timeline-id>.timeline.yaml)")
  .option("--json", "Output result as JSON")
  .action(async (options) => {
    const context = await resolveCanvasProjectContext(options);
    const filePath = resolveTimelineFilePath({
      cwd: process.cwd(),
      file: options.file,
      timeline: options.timeline,
    });
    const listed = await listTimelineEntities(context);
    const timeline = listed.timelines.find((candidate) => candidate.id === options.timeline);
    if (!timeline) throw new Error(`Timeline ${options.timeline} not found`);
    const currentDsl = normalizeTimelineDslForYaml(timeline.state);
    const yaml = timelineDslToYaml(currentDsl);
    const version = listed.versions[timeline.id] ?? projectTimelineReadToken(timeline);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, yaml, "utf8");
    const transcriptProjection = await writeTimelineTranscriptProjection({
      cwd: process.cwd(),
      timelineFilePath: filePath,
      timelineId: timeline.id,
      timelineRevision: timeline.revisionId,
      state: timeline.state,
    });
    await recordTimelineObservation(context, timeline.id, version);

    const payload = {
      pulled: true,
      projectId: context.projectId,
      timelineId: timeline.id,
      revisionId: timeline.revisionId,
      owner: timeline.owner,
      filePath,
      timelineHash: timelineHash(currentDsl),
      ...(transcriptProjection ? {
        transcriptFilePath: transcriptProjection.filePath,
        transcriptWordCount: transcriptProjection.wordCount,
        transcriptSourceCount: transcriptProjection.sourceCount,
      } : {}),
    };
    if (isJsonMode(options)) printJson(payload);
    else {
      process.stderr.write(`wrote ${filePath}\n`);
      if (transcriptProjection) {
        process.stderr.write(`wrote ${transcriptProjection.filePath}\n`);
      }
    }
  });

timelineCommand
  .command("apply")
  .description(TIMELINE_OPERATION_CATALOG.agent["timeline.apply"].description)
  .requiredOption("--timeline <id>", "Timeline ID")
  .option("--project <id>", "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)")
  .option("--file <path>", "Timeline YAML path (default: timelines/<timeline-id>.timeline.yaml)")
  .option("--base-revision <revision>", "Revision the edited projection was based on")
  .option("--json", "Output result as JSON")
  .action(async (options) => {
    const context = await resolveCanvasProjectContext(options);
    const filePath = resolveTimelineFilePath({
      cwd: process.cwd(),
      file: options.file,
      timeline: options.timeline,
    });
    const content = readFileSync(filePath, "utf8");
    const parsed = parseTimelineFileForApply(content);
    if (!parsed.ok) {
      console.error(`error: ${parsed.error}`);
      process.exit(1);
    }

    const timelineId = String(options.timeline);
    const baseRevisionId = typeof options.baseRevision === "string"
      ? options.baseRevision.trim()
      : "";
    const observedVersion = await prepareTimelineApplyObservation({
      context,
      timelineId,
      editedProjectionPath: filePath,
      ...(baseRevisionId ? { baseRevisionId } : {}),
    });
    const result = await sendProjectCommand<TimelineWorkspaceResult>(context.projectId, {
      action: "update_timeline_state",
      timelineId,
      state: parsed.dsl,
      sourceNodeIds: parsed.sources,
      actorClientType: resolveCanvasPresenceOptions().clientType,
      observedVersion,
      ifMatch: observedVersion,
    });
    if (result.error || !result.timeline) {
      if (result.code === "STALE_READ") {
        await recoverStaleTimelineApply({
          context,
          timelineId,
          editedProjectionPath: filePath,
        });
      }
      throw new Error(result.error ?? "Timeline apply failed");
    }
    await recordTimelineObservation(
      context,
      timelineId,
      result.readToken ?? result.version ?? projectTimelineReadToken(result.timeline),
    );

    const payload = {
      applied: true,
      projectId: context.projectId,
      timelineId,
      revisionId: result.timeline.revisionId,
      owner: result.timeline.owner,
      filePath,
      sources: parsed.sources,
      timelineHash: timelineHash(normalizeTimelineDslForYaml(parsed.dsl)),
    };
    if (isJsonMode(options)) printJson(payload);
    else process.stderr.write(`applied ${filePath} to Timeline ${timelineId}\n`);
  });

type TimelineCliOperationExecutor = Readonly<{
  binding: `cli:timeline ${string}`;
  command: Command;
}>;

function registeredTimelineCommand(commandName: string): Command {
  const command = timelineCommand.commands.find(
    (candidate) => candidate.name() === commandName,
  );
  if (!command) {
    throw new Error(`Timeline CLI executor is not registered: ${commandName}`);
  }
  return command;
}

/**
 * Transport adapter from the canonical Timeline operation id to the concrete
 * Commander command which owns its action handler.
 *
 * Keep this literal explicit: the contract test compares its keys and bindings
 * against every `cli:timeline` binding in TIMELINE_OPERATION_REGISTRY, so a new
 * public CLI annotation cannot silently ship without a real executor.
 */
export const TIMELINE_CLI_OPERATION_EXECUTORS = Object.freeze({
  "timeline.schema": {
    binding: "cli:timeline schema",
    command: registeredTimelineCommand("schema"),
  },
  "timeline.validate": {
    binding: "cli:timeline validate",
    command: registeredTimelineCommand("validate"),
  },
  "timeline.list": {
    binding: "cli:timeline list",
    command: registeredTimelineCommand("list"),
  },
  "timeline.create": {
    binding: "cli:timeline create",
    command: registeredTimelineCommand("create"),
  },
  "timeline.attach": {
    binding: "cli:timeline attach",
    command: registeredTimelineCommand("attach"),
  },
  "timeline.detach": {
    binding: "cli:timeline detach",
    command: registeredTimelineCommand("detach"),
  },
  "timeline.copy": {
    binding: "cli:timeline copy",
    command: registeredTimelineCommand("copy"),
  },
  "timeline.render": {
    binding: "cli:timeline render",
    command: registeredTimelineCommand("render"),
  },
  "timeline.pull": {
    binding: "cli:timeline pull",
    command: registeredTimelineCommand("pull"),
  },
  "timeline.apply": {
    binding: "cli:timeline apply",
    command: registeredTimelineCommand("apply"),
  },
} satisfies Partial<Record<TimelineAgentOperationId, TimelineCliOperationExecutor>>);

async function runCommand(projectId: string, cmd: ProjectHostCommand): Promise<any> {
  return sendProjectCommand(projectId, cmd);
}
