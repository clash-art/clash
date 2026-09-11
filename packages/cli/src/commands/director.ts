import { Command, Option } from "commander";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  applyDirectorStageCommand,
  createDefaultDirectorStageState,
  directorDefaultAttachmentOffset,
  directorStageJsonSchema,
  DirectorStageAuthoringStateSchema,
  directorCodeDocumentBody,
  directorCodeRegistryError,
  type DocumentAssetRevisionRef,
  type DirectorStageState,
  projectDirectorStageReadToken,
  type DirectorStageCameraPatch,
  type DirectorStageCommand,
  type DirectorStageObject,
  type DirectorStageObjectPatch,
  type DirectorStageSchemaContract,
  type ProjectDirectorStage,
} from "@clash/shared-types";
import { isJsonMode, printJson, printTable } from "../lib/output";
import { apiJson } from "../lib/api";
import { createGeneratorClient } from "@clash/shared-runtime/generator-client";
import { readNativeMediaActionRun } from "@clash/shared-runtime/generator-readback";
import { createCliProjectAssetHostClient, resolveCliProjectHostConnection, sendProjectCommand } from "../lib/project-host-client";
import { type ResolvedProjectContext } from "../lib/project-context";
import {
  recordWorktreeObservation,
  requireWorktreeObservation,
} from "../lib/worktree-observations";
import {
  resolveCanvasPresenceOptions,
  resolveCanvasProjectContext,
} from "./canvas";
import {
  directorStageCanonicalJson,
  directorStageHash,
  parseDirectorStageFileForApply,
  resolveDirectorStageFilePath,
} from "../lib/director-stage-projection";
import {
  recoverStaleProjection,
  staleProjectionRecoveryError,
} from "../lib/stale-projection-recovery";

type DirectorStageWorkspaceResult = {
  stages?: ProjectDirectorStage[];
  stage?: ProjectDirectorStage;
  versions?: Record<string, string>;
  version?: string;
  readToken?: string;
  error?: string;
  code?: string;
};

function isAgentDirectorStageClient(): boolean {
  return resolveCanvasPresenceOptions().clientType === "agent";
}

async function recordDirectorStageObservation(
  context: ResolvedProjectContext,
  stageId: string,
  revision: string,
): Promise<void> {
  if (!isAgentDirectorStageClient()) return;
  if (!context.workspaceRoot) {
    throw new Error(
      "Agent reads require a cwd linked through .clash/project.toml.",
    );
  }
  await recordWorktreeObservation({
    workspaceRoot: context.workspaceRoot,
    projectId: context.projectId,
    entityKind: "director-stage",
    entityId: stageId,
    revision,
  });
}

async function requireDirectorStageObservation(
  context: ResolvedProjectContext,
  stageId: string,
): Promise<string | undefined> {
  if (!isAgentDirectorStageClient()) return undefined;
  if (!context.workspaceRoot) {
    throw new Error(
      "READ_REQUIRED: Run from a cwd linked through .clash/project.toml and read the Director Stage first.",
    );
  }
  const observation = await requireWorktreeObservation({
    workspaceRoot: context.workspaceRoot,
    projectId: context.projectId,
    entityKind: "director-stage",
    entityId: stageId,
  });
  if (!observation.ok)
    throw new Error(`${observation.code}: ${observation.error}`);
  return observation.revision;
}

function finiteNumber(value: unknown, option: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    throw new Error(`${option} must be a finite number`);
  return parsed;
}

function positiveInteger(value: unknown, option: string): number {
  const parsed = finiteNumber(value, option);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${option} must be a positive integer`);
  return parsed;
}

function booleanValue(value: unknown, option: string): boolean {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${option} must be true or false`);
}

async function listDirectorStages(context: ResolvedProjectContext): Promise<{
  stages: ProjectDirectorStage[];
  versions: Record<string, string>;
}> {
  const result = await sendProjectCommand<DirectorStageWorkspaceResult>(
    context.projectId,
    {
      action: "list_director_stages",
    },
  );
  if (result.error) throw new Error(result.error);
  return { stages: result.stages ?? [], versions: result.versions ?? {} };
}

async function readDirectorStage(
  context: ResolvedProjectContext,
  stageId: string,
): Promise<ProjectDirectorStage> {
  const listed = await listDirectorStages(context);
  const stage = listed.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new Error(`Director Stage ${stageId} not found`);
  await recordDirectorStageObservation(
    context,
    stage.id,
    listed.versions[stage.id] ?? projectDirectorStageReadToken(stage),
  );
  return stage;
}

async function recoverStaleDirectorStageApply(options: {
  context: ResolvedProjectContext;
  stageId: string;
  editedProjectionPath: string;
}): Promise<never> {
  const listed = await listDirectorStages(options.context);
  const latest = listed.stages.find(
    (candidate) => candidate.id === options.stageId,
  );
  if (!latest) {
    throw new Error(
      `Director Stage ${options.stageId} not found after the stale write was rejected`,
    );
  }
  const currentObservation =
    listed.versions[latest.id] ?? projectDirectorStageReadToken(latest);
  const recovery = await recoverStaleProjection({
    workspaceRoot: options.context.workspaceRoot ?? process.cwd(),
    projectId: options.context.projectId,
    entityKind: "director-stage",
    entityId: latest.id,
    currentRevisionId: latest.revisionId,
    currentObservation,
    editedProjectionPath: options.editedProjectionPath,
    latestContent: directorStageCanonicalJson(latest.state),
  });
  throw staleProjectionRecoveryError("Director Stage", recovery);
}

type DirectorCaptureAspectRatio = "16:9" | "9:16" | "4:3" | "3:4" | "1:1";

type DirectorCaptureRenderResult = {
  renderer: { id: string; contractVersion: number };
  stateSha256: string;
  frames: Array<{
    label: string;
    timeSeconds: number;
    aspectRatio: DirectorCaptureAspectRatio;
    activeCameraId?: string;
    width: number;
    height: number;
    mimeType: "image/png";
    dataBase64: string;
    sha256: string;
  }>;
};

type DirectorCaptureHostResult = {
  submitted: true;
  captured: false;
  stageId: string;
  sourceStageRevisionId: string;
  runs: Array<{ actionRunId: string }>;
};

type DirectorCaptureHostRequest = {
  action: "capture_director_stage";
  stageId: string;
  frames: Array<{
    label: string;
    timeSeconds: number;
    aspectRatio: DirectorCaptureAspectRatio;
  }>;
  longEdge: number;
};

type DirectorCaptureStage = Pick<
  ProjectDirectorStage,
  "id" | "name" | "revisionId" | "state"
>;

export type DirectorCaptureReceipt = {
  captured: true;
  stageId: string;
  sourceStageRevisionId: string;
  verifiedStageRevisionId: string;
  renderer: { id: string; contractVersion: number };
  stateSha256: string;
  frames: Array<{
    artifactId: string;
    projectAssetId: string;
    metadataAttached: boolean;
    timeSeconds: number;
    aspectRatio: DirectorCaptureAspectRatio;
    activeCameraId?: string;
    width: number;
    height: number;
    mimeType: "image/png";
    sha256: string;
    path: string;
  }>;
  receiptPath: string;
};

function captureSha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function captureArtifactId(label: string): string {
  const value = label.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid Director capture label: ${label}`);
  }
  return value;
}

function resolveCaptureOutputDir(
  cwd: string,
  stageId: string,
  outputDir?: string,
): string {
  const root = resolve(cwd);
  const target = outputDir?.trim()
    ? resolve(root, outputDir)
    : join(root, "director-stages", captureArtifactId(stageId), "captures");
  const traversal = relative(root, target);
  if (
    traversal === ".." ||
    traversal.startsWith(`..${sep}`) ||
    isAbsolute(traversal)
  ) {
    throw new Error(
      "Director capture output directory must stay inside the current project cwd",
    );
  }
  return target;
}

function captureAspectRatioAt(
  state: ProjectDirectorStage["state"],
  timeSeconds: number,
  override?: DirectorCaptureAspectRatio,
): DirectorCaptureAspectRatio {
  if (override) return override;
  const duration = state.animation?.durationSeconds;
  const active = [...(state.shotSequence ?? [])]
    .sort(
      (left, right) =>
        left.startTime - right.startTime || left.id.localeCompare(right.id),
    )
    .find(
      (shot) =>
        timeSeconds >= shot.startTime &&
        (timeSeconds < shot.startTime + shot.durationSeconds ||
          (duration !== undefined &&
            Math.abs(timeSeconds - duration) < 1e-6 &&
            Math.abs(shot.startTime + shot.durationSeconds - duration) < 1e-6)),
    );
  return (
    active?.aspectRatio ??
    state.shotSequence?.[0]?.aspectRatio ??
    state.shots[0]?.aspectRatio ??
    "16:9"
  );
}

function defaultCaptureLabels(count: number): string[] {
  if (count === 3) return ["frame-opening", "frame-action", "frame-closing"];
  return Array.from(
    { length: count },
    (_, index) => `frame-${String(index + 1).padStart(3, "0")}`,
  );
}

export async function captureDirectorStageWithReadback(options: {
  cwd: string;
  stageId: string;
  times: number[];
  labels?: string[];
  outputDir?: string;
  aspectRatio?: DirectorCaptureAspectRatio;
  longEdge: number;
  readStage: () => Promise<DirectorCaptureStage>;
  capture: (
    request: DirectorCaptureHostRequest,
  ) => Promise<DirectorCaptureHostResult>;
  readRunMedia: (actionRunId: string) => Promise<{
    projectAssetId: string;
    bytes: Uint8Array;
    metadata?: { contentType?: string; width?: number; height?: number };
  }>;
}): Promise<DirectorCaptureReceipt> {
  if (
    !Array.isArray(options.times) ||
    options.times.length < 1 ||
    options.times.length > 12
  ) {
    throw new Error("Director capture requires between 1 and 12 --time values");
  }
  const times = options.times.map((time) => {
    if (!Number.isFinite(time) || time < 0) {
      throw new Error(
        "Director capture times must be finite non-negative seconds",
      );
    }
    return time;
  });
  const labels = options.labels?.length
    ? options.labels
    : defaultCaptureLabels(times.length);
  if (labels.length !== times.length) {
    throw new Error("Director capture --label count must match --time count");
  }
  const artifactIds = labels.map(captureArtifactId);
  if (new Set(artifactIds).size !== artifactIds.length) {
    throw new Error("Director capture labels must be unique");
  }
  if (
    !Number.isInteger(options.longEdge) ||
    options.longEdge < 256 ||
    options.longEdge > 4096
  ) {
    throw new Error(
      "Director capture --long-edge must be an integer between 256 and 4096",
    );
  }

  const before = await options.readStage();
  if (before.id !== options.stageId)
    throw new Error(`Director Stage ${options.stageId} not found`);
  const request: DirectorCaptureHostRequest = {
    action: "capture_director_stage",
    stageId: options.stageId,
    longEdge: options.longEdge,
    frames: times.map((timeSeconds, index) => ({
      label: artifactIds[index]!,
      timeSeconds,
      aspectRatio: captureAspectRatioAt(
        before.state,
        timeSeconds,
        options.aspectRatio,
      ),
    })),
  };
  const rendered = await options.capture(request);
  if (!rendered.submitted || rendered.captured !== false || rendered.stageId !== options.stageId) {
    throw new Error("Director Host returned a capture submission for the wrong Stage");
  }
  if (rendered.sourceStageRevisionId !== before.revisionId) {
    throw new Error(
      `Director Host captured Stage revision ${rendered.sourceStageRevisionId}; expected ${before.revisionId}`,
    );
  }
  if (rendered.runs.length !== times.length) {
    throw new Error("Director Host returned an incomplete ActionRun set");
  }
  const nativeFrames = await Promise.all(rendered.runs.map((run) => options.readRunMedia(run.actionRunId)));
  const stateSha256 = captureSha256(JSON.stringify(before.state));
  const renderer = { id: "clash-director-viewport-webgl", contractVersion: 1 };
  for (const [index, frame] of nativeFrames.entries()) {
    const expected = request.frames[index]!;
    if (frame.metadata?.contentType !== "image/png") throw new Error(`Director renderer returned a non-PNG frame for ${expected.label}`);
    if (!frame.projectAssetId.trim()) throw new Error(`Director Host did not publish a Project Asset for ${expected.label}`);
    if (!Number.isInteger(frame.metadata?.width) || !Number.isInteger(frame.metadata?.height)) throw new Error(`Director renderer returned invalid dimensions for ${expected.label}`);
    if (!frame.bytes.byteLength || !Buffer.from(frame.bytes).subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error(`Director renderer returned invalid PNG bytes for ${expected.label}`);
  }

  const after = await options.readStage();
  if (after.revisionId !== before.revisionId) {
    throw new Error(
      `Director Stage ${options.stageId} changed during capture (${before.revisionId} -> ${after.revisionId})`,
    );
  }

  const outputDir = resolveCaptureOutputDir(
    options.cwd,
    options.stageId,
    options.outputDir,
  );
  mkdirSync(outputDir, { recursive: true });
  const renderedFrames = nativeFrames.map((frame, index) => {
    const artifactId = artifactIds[index]!;
    const expected = request.frames[index]!;
    const bytes = Buffer.from(frame.bytes);
    const path = join(outputDir, `${artifactId}.png`);
    writeFileSync(path, bytes);
    return {
      artifactId,
      projectAssetId: frame.projectAssetId,
      metadataAttached: false,
      timeSeconds: expected.timeSeconds,
      aspectRatio: expected.aspectRatio,
      ...(before.state.activeCameraId ? { activeCameraId: before.state.activeCameraId } : {}),
      width: frame.metadata!.width!,
      height: frame.metadata!.height!,
      mimeType: "image/png" as const,
      sha256: captureSha256(bytes),
      path,
    };
  });

  const receiptPath = join(outputDir, "capture.json");
  const receipt: DirectorCaptureReceipt = {
    captured: true,
    stageId: options.stageId,
    sourceStageRevisionId: before.revisionId,
    verifiedStageRevisionId: after.revisionId,
    renderer,
    stateSha256,
    frames: renderedFrames,
    receiptPath,
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

export async function registerDirectorComponentSource(options: {
  stage: ProjectDirectorStage;
  componentId: string;
  name: string;
  source: string;
  createDocument: (source: string) => Promise<DocumentAssetRevisionRef>;
  apply: (state: DirectorStageState) => Promise<ProjectDirectorStage>;
}): Promise<ProjectDirectorStage> {
  if (!options.componentId.trim() || !options.name.trim() || !options.source.trim()) {
    throw new Error("Director component ID, name, and source must be non-empty");
  }
  const source = await options.createDocument(options.source);
  const components = [...(options.stage.state.codeComponents ?? [])];
  const component = { id: options.componentId.trim(), name: options.name, source };
  const index = components.findIndex(item => item.id === component.id);
  if (index < 0) components.push(component);
  else components[index] = component;
  const state = DirectorStageAuthoringStateSchema.parse({ ...options.stage.state, codeComponents: components });
  const error = directorCodeRegistryError(state);
  if (error) throw new Error(error);
  return options.apply(state);
}

export const directorCommand = new Command("director").description(
  "Author Project Director Stage scenes through deterministic agent commands and JSON projections",
);

directorCommand.command("components")
  .description("Manage this Generator's reusable single-file TSX components")
  .command("register")
  .requiredOption("--stage <id>", "Director Stage ID")
  .requiredOption("--component <id>", "Component ID within this Stage")
  .requiredOption("--file <path>", "Single TS or TSX source file")
  .option("--name <name>", "Display name (defaults to component ID)")
  .option("--project <id>", "Project ID")
  .option("--json", "Output accepted Stage and pinned source reference")
  .addHelpText("after", `
Source contract: default-export a React function receiving { parameters, timeSeconds }
and returning React Three Fiber JSX. Imports may use react or three only.
Register stores a text.plain Document and pins its revision in this Generator.
Re-registering an ID preserves instances and updates this state's source reference.
Use director pull/apply to edit code objects and their JSON parameters.
Compilation happens during preview/capture; register does not execute source.`)
  .action(async options => {
    if (!/\.tsx?$/i.test(options.file)) throw new Error("Director component source must be a .ts or .tsx file");
    const context = await resolveCanvasProjectContext(options);
    const stage = await readDirectorStage(context, options.stage);
    const observedVersion = (await requireDirectorStageObservation(context, stage.id)) ?? projectDirectorStageReadToken(stage);
    const accepted = await registerDirectorComponentSource({
      stage, componentId: options.component, name: options.name ?? options.component,
      source: readFileSync(resolve(options.file), "utf8"),
      createDocument: async body => {
        const documentAssetId = randomUUID();
        const revisionId = randomUUID();
        const source: DocumentAssetRevisionRef = { kind: "document", documentAssetId, revisionId };
        const result = await apiJson(`/api/v1/projects/${encodeURIComponent(context.projectId)}/documents`, {
          method: "POST",
          headers: { "x-clash-client-type": resolveCanvasPresenceOptions().clientType },
          body: JSON.stringify({ documentAssetId, revisionId, documentKind: "text.plain", schemaVersion: 1, body, sourceRefs: [] }),
        });
        directorCodeDocumentBody(source, result);
        return source;
      },
      apply: async state => {
        const result = await sendProjectCommand<DirectorStageWorkspaceResult>(context.projectId, {
          action: "update_director_stage_state", stageId: stage.id, state,
          actorClientType: resolveCanvasPresenceOptions().clientType,
          observedVersion, ifMatch: observedVersion,
        });
        if (result.error || !result.stage) throw new Error(result.error ?? "Director component registration failed");
        await recordDirectorStageObservation(context, stage.id, result.readToken ?? result.version ?? projectDirectorStageReadToken(result.stage));
        return result.stage;
      },
    });
    if (isJsonMode(options)) printJson(accepted);
    else console.log(`Registered ${options.component} in Director Stage ${accepted.id} (${accepted.revisionId})`);
  });

directorCommand
  .command("schema")
  .description("Return the authoritative Director Stage authoring contract")
  .addOption(
    new Option("--contract <contract>", "Director Stage contract")
      .choices(["state", "object", "camera"])
      .default("state"),
  )
  .option("--json", "Output the schema contract as JSON")
  .action(
    (options: { contract: DirectorStageSchemaContract; json?: boolean }) => {
      const contract = options.contract;
      const payload = {
        schemaVersion: 1,
        contract,
        source: "@clash/shared-types",
        jsonSchema: directorStageJsonSchema(contract),
      };
      if (isJsonMode(options)) printJson(payload);
      else console.log(JSON.stringify(payload, null, 2));
    },
  );

directorCommand
  .command("list")
  .description("List Project Director Stages and their owners")
  .option(
    "--project <id>",
    "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)",
  )
  .option("--json", "Output result as JSON")
  .action(async (options) => {
    const context = await resolveCanvasProjectContext(options);
    const result = await listDirectorStages(context);
    for (const stage of result.stages) {
      await recordDirectorStageObservation(
        context,
        stage.id,
        result.versions[stage.id] ?? projectDirectorStageReadToken(stage),
      );
    }
    if (isJsonMode(options)) return printJson(result.stages);
    printTable(
      result.stages.map((stage) => ({
        id: stage.id,
        name: stage.name,
        owner:
          stage.owner.kind === "project"
            ? "Project"
            : `Canvas ${stage.owner.canvasId}`,
        objects: stage.state.objects.length,
        cameras: stage.state.cameras.length,
      })),
      [
        { key: "id", label: "Director Stage", width: 24 },
        { key: "name", label: "Name", width: 28 },
        { key: "owner", label: "Owner", width: 24 },
        { key: "objects", label: "Objects", width: 10 },
        { key: "cameras", label: "Cameras", width: 10 },
      ],
    );
  });

directorCommand
  .command("create")
  .description("Create a standalone Project Director Stage")
  .requiredOption("--id <id>", "Project-scoped Director Stage ID")
  .requiredOption("--name <name>", "Director Stage name")
  .option(
    "--project <id>",
    "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)",
  )
  .option("--json", "Output result as JSON")
  .action(async (options) => {
    const context = await resolveCanvasProjectContext(options);
    const result = await sendProjectCommand<DirectorStageWorkspaceResult>(
      context.projectId,
      {
        action: "create_director_stage",
        stageId: options.id,
        name: options.name,
        state: createDefaultDirectorStageState(),
      },
    );
    if (result.error || !result.stage)
      throw new Error(result.error ?? "Director Stage create failed");
    await recordDirectorStageObservation(
      context,
      result.stage.id,
      result.readToken ??
        result.version ??
        projectDirectorStageReadToken(result.stage),
    );
    if (isJsonMode(options)) printJson(result.stage);
    else console.log(`Created Director Stage: ${result.stage.id}`);
  });

directorCommand
  .command("attach")
  .description("Attach a standalone Director Stage to one Canvas action node")
  .requiredOption("--stage <id>", "Director Stage ID")
  .requiredOption("--canvas <id>", "Owning Canvas ID")
  .option("--node <id>", "Canvas action node ID")
  .option("--x <number>", "Canvas X position", "0")
  .option("--y <number>", "Canvas Y position", "0")
  .option("--project <id>", "Project ID")
  .option("--json", "Output result as JSON")
  .action(async (options) => {
    const context = await resolveCanvasProjectContext(options);
    const observedVersion = await requireDirectorStageObservation(
      context,
      options.stage,
    );
    const actionNodeId =
      options.node?.trim() || `director-stage-${randomUUID().slice(0, 8)}`;
    const result = await sendProjectCommand<DirectorStageWorkspaceResult>(
      context.projectId,
      {
        action: "attach_director_stage",
        stageId: options.stage,
        canvasId: options.canvas,
        actionNodeId,
        position: {
          x: finiteNumber(options.x, "--x"),
          y: finiteNumber(options.y, "--y"),
        },
        actorClientType: resolveCanvasPresenceOptions().clientType,
        observedVersion,
        ifMatch: observedVersion,
      },
    );
    if (result.error || !result.stage)
      throw new Error(result.error ?? "Director Stage attach failed");
    await recordDirectorStageObservation(
      context,
      result.stage.id,
      result.readToken ??
        result.version ??
        projectDirectorStageReadToken(result.stage),
    );
    if (isJsonMode(options)) printJson(result.stage);
    else
      console.log(
        `Attached Director Stage ${result.stage.id} to Canvas ${options.canvas}`,
      );
  });

directorCommand
  .command("detach")
  .description("Detach a Canvas-owned Director Stage to the Project root")
  .requiredOption("--stage <id>", "Director Stage ID")
  .option("--project <id>", "Project ID")
  .option("--json", "Output result as JSON")
  .action(async (options) => {
    const context = await resolveCanvasProjectContext(options);
    const observedVersion = await requireDirectorStageObservation(
      context,
      options.stage,
    );
    const result = await sendProjectCommand<DirectorStageWorkspaceResult>(
      context.projectId,
      {
        action: "detach_director_stage",
        stageId: options.stage,
        actorClientType: resolveCanvasPresenceOptions().clientType,
        observedVersion,
        ifMatch: observedVersion,
      },
    );
    if (result.error || !result.stage)
      throw new Error(result.error ?? "Director Stage detach failed");
    await recordDirectorStageObservation(
      context,
      result.stage.id,
      result.readToken ??
        result.version ??
        projectDirectorStageReadToken(result.stage),
    );
    if (isJsonMode(options)) printJson(result.stage);
    else console.log(`Detached Director Stage: ${result.stage.id}`);
  });

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

directorCommand
  .command("capture")
  .description(
    "Capture exact-time PNG evidence through the local-api DirectorViewport WebGL renderer",
  )
  .requiredOption("--stage <id>", "Director Stage ID")
  .option(
    "--time <seconds>",
    "Exact Stage time in seconds (repeat for each PNG)",
    collectOption,
    [],
  )
  .option(
    "--label <artifact-id>",
    "Artifact id for each PNG (repeat in --time order)",
    collectOption,
    [],
  )
  .option("--output-dir <path>", "Project-relative output directory")
  .addOption(
    new Option(
      "--aspect-ratio <ratio>",
      "Override the shot aspect ratio",
    ).choices(["16:9", "9:16", "4:3", "3:4", "1:1"]),
  )
  .option("--long-edge <pixels>", "Output long edge in pixels", "1920")
  .option("--project <id>", "Project ID")
  .option("--json", "Output the capture and Stage readback receipt as JSON")
  .action(async (options) => {
    const context = await resolveCanvasProjectContext(options);
    const receipt = await captureDirectorStageWithReadback({
      cwd: context.workspaceRoot ?? process.cwd(),
      stageId: options.stage,
      times: (options.time as string[]).map((value) =>
        finiteNumber(value, "--time"),
      ),
      labels: options.label as string[],
      outputDir: options.outputDir,
      aspectRatio: options.aspectRatio as
        DirectorCaptureAspectRatio | undefined,
      longEdge: positiveInteger(options.longEdge, "--long-edge"),
      readStage: () => readDirectorStage(context, options.stage),
      capture: async (request) => {
        const observedVersion = await requireDirectorStageObservation(
          context,
          options.stage,
        );
        const result = await sendProjectCommand<
          DirectorCaptureHostResult & { error?: string }
        >(context.projectId, {
          ...request,
          actorClientType: resolveCanvasPresenceOptions().clientType,
          observedVersion,
          ifMatch: observedVersion,
        });
        if (result.error) throw new Error(result.error);
        return result;
      },
      readRunMedia: async (actionRunId) => {
        const connection = resolveCliProjectHostConnection();
        const authenticatedFetch = (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => fetch(input, {
          ...init,
          headers: { ...Object.fromEntries(new Headers(init.headers)), ...(connection.token ? { authorization: `Bearer ${connection.token}` } : {}) },
        });
        const generator = createGeneratorClient((path, init) => authenticatedFetch(new URL(path, connection.endpoint), init));
        const assets = createCliProjectAssetHostClient({ fetch: authenticatedFetch });
        const media = await readNativeMediaActionRun({
          generator,
          projectId: context.projectId,
          actionRunId,
          getAsset: async (projectAssetId) => (await assets.get({ projectId: context.projectId, assetId: projectAssetId })).value,
          downloadAsset: async (asset) => {
            if (!asset.url) throw new Error("Project Asset has no public media URL");
            const response = await authenticatedFetch(asset.url);
            if (!response.ok) throw new Error(`Project Asset download failed (${response.status})`);
            return new Uint8Array(await response.arrayBuffer());
          },
        });
        return { projectAssetId: media.projectAssetId, bytes: media.bytes, metadata: media.asset.metadata };
      },
    });
    if (isJsonMode(options)) printJson(receipt);
    else
      process.stderr.write(
        `captured ${receipt.frames.length} Director PNGs to ${dirname(receipt.receiptPath)}\n`,
      );
  });

directorCommand
  .command("pull")
  .description("Export the current Director Stage revision to JSON")
  .requiredOption("--stage <id>", "Director Stage ID")
  .option("--project <id>", "Project ID")
  .option("--file <path>", "Projection path")
  .option("--json", "Output result as JSON")
  .action(async (options) => {
    const context = await resolveCanvasProjectContext(options);
    const stage = await readDirectorStage(context, options.stage);
    const filePath = resolveDirectorStageFilePath({
      cwd: process.cwd(),
      stage: stage.id,
      file: options.file,
    });
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, directorStageCanonicalJson(stage.state), "utf8");
    const payload = {
      pulled: true,
      projectId: context.projectId,
      stageId: stage.id,
      revisionId: stage.revisionId,
      owner: stage.owner,
      filePath,
      stageHash: directorStageHash(stage.state),
    };
    if (isJsonMode(options)) printJson(payload);
    else process.stderr.write(`wrote ${filePath}\n`);
  });

directorCommand
  .command("apply")
  .description(
    "Validate a Director Stage JSON projection and advance its revision",
  )
  .requiredOption("--stage <id>", "Director Stage ID")
  .option("--project <id>", "Project ID")
  .option("--file <path>", "Projection path")
  .option(
    "--base-revision <revision>",
    "Revision the edited projection was based on",
  )
  .option("--json", "Output result as JSON")
  .action(async (options) => {
    const context = await resolveCanvasProjectContext(options);
    const filePath = resolveDirectorStageFilePath({
      cwd: process.cwd(),
      stage: options.stage,
      file: options.file,
    });
    const parsed = parseDirectorStageFileForApply(
      readFileSync(filePath, "utf8"),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    let observedVersion: string | undefined;
    const baseRevisionId =
      typeof options.baseRevision === "string"
        ? options.baseRevision.trim()
        : "";
    if (baseRevisionId) {
      const listed = await listDirectorStages(context);
      const latest = listed.stages.find(
        (candidate) => candidate.id === options.stage,
      );
      if (!latest) throw new Error(`Director Stage ${options.stage} not found`);
      if (latest.revisionId !== baseRevisionId) {
        await recoverStaleDirectorStageApply({
          context,
          stageId: options.stage,
          editedProjectionPath: filePath,
        });
      }
      observedVersion =
        listed.versions[latest.id] ?? projectDirectorStageReadToken(latest);
      await recordDirectorStageObservation(context, latest.id, observedVersion);
    } else {
      observedVersion = await requireDirectorStageObservation(
        context,
        options.stage,
      );
    }
    const result = await sendProjectCommand<DirectorStageWorkspaceResult>(
      context.projectId,
      {
        action: "update_director_stage_state",
        stageId: options.stage,
        state: parsed.state,
        actorClientType: resolveCanvasPresenceOptions().clientType,
        observedVersion,
        ifMatch: observedVersion,
      },
    );
    if (result.error || !result.stage) {
      if (result.code === "STALE_READ") {
        await recoverStaleDirectorStageApply({
          context,
          stageId: options.stage,
          editedProjectionPath: filePath,
        });
      }
      throw new Error(result.error ?? "Director Stage apply failed");
    }
    await recordDirectorStageObservation(
      context,
      result.stage.id,
      result.readToken ??
        result.version ??
        projectDirectorStageReadToken(result.stage),
    );
    const payload = {
      applied: true,
      projectId: context.projectId,
      stageId: result.stage.id,
      revisionId: result.stage.revisionId,
      filePath,
      stageHash: directorStageHash(result.stage.state),
    };
    if (isJsonMode(options)) printJson(payload);
    else
      process.stderr.write(
        `applied ${filePath} to Director Stage ${result.stage.id}\n`,
      );
  });
