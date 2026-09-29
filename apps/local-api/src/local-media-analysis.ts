import type {
  ActionRunModelRoute,
  ExecutableMediaAnalysisReference,
  ExecutableMediaAnalysisResult,
} from "@clash/shared-types";
import { createHash } from "node:crypto";
import { createStructuredLogger } from "@clash/shared-runtime/logging";

import type { ExternalAigcService } from "./local-aigc.js";
import type { LocalMediaAnalysisConfigStore } from "./media-analysis-config.js";

export interface LocalMediaAnalysisInput {
  projectId: string;
  invocationId: string;
  taskId: string;
  reference: ExecutableMediaAnalysisReference;
  modelId: string;
  /** Exact Provider implementation frozen with the Run authority at selection time. */
  route: ActionRunModelRoute;
  category: string;
  prompt: string;
  promptVersion: string;
  responseFormat?: "json" | "text";
  /** Absolute Host attempt deadline, shared by the initial analysis and every refinement. */
  deadlineAt?: number;
}

const analysisLog = createStructuredLogger({ component: "local-api", module: "media-analysis" });

function parseJsonResult(
  value: string,
  input: LocalMediaAnalysisInput,
  boundaryIndex?: number,
): unknown {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)?.[1];
  const source = fenced ?? trimmed;
  try {
    return JSON.parse(source);
  } catch (error) {
    // SyntaxError messages may quote the model's output. Retain useful syntax
    // evidence in the existing local log, never arbitrary prose, secrets or a
    // raw cause that could cross the plugin/Project boundary.
    const match = error instanceof Error ? /\bposition (\d+)\b/.exec(error.message) : null;
    const position = match ? Number(match[1]) : undefined;
    const syntax = (text: string) => text.replace(/[^\s{}[\]:,"\\`]/gu, "•");
    analysisLog.warn("media-analysis.invalid-json", {
      projectId: input.projectId,
      actionRunId: input.taskId,
      invocationId: input.invocationId,
      assetId: input.reference.asset.assetId,
      modelId: input.modelId,
      providerId: input.route.providerId,
      upstreamId: input.route.upstreamId,
      upstreamModel: input.route.upstreamModel,
      category: input.category,
      stage: boundaryIndex === undefined ? "initial" : "boundary-refinement",
      ...(boundaryIndex === undefined ? {} : { boundaryIndex }),
      responseEvidence: {
        byteLength: Buffer.byteLength(value, "utf8"),
        sha256: createHash("sha256").update(value).digest("hex"),
        parsedCharacterLength: source.length,
        fenced: fenced !== undefined,
        syntaxPrefix: syntax(source.slice(0, 512)),
        ...(position === undefined ? {} : {
          // Position is relative to the trimmed, unfenced JSON input.
          position,
          syntaxNearError: syntax(source.slice(Math.max(0, position - 64), position + 64)),
        }),
      },
    });
    throw new Error("Media analysis model did not return valid JSON.");
  }
}

type SceneBoundary = {
  description: string;
  shotType?: string;
  startMs?: number;
  endMs?: number;
};

function sceneBoundaries(value: unknown): SceneBoundary[] | null {
  if (!value || typeof value !== "object") return null;
  const scenes = (value as { scenes?: unknown }).scenes;
  if (!Array.isArray(scenes)) return null;
  return scenes.every((scene) => scene && typeof scene === "object")
    ? scenes as SceneBoundary[]
    : null;
}

function parsedBoundaryMs(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const boundaryMs = (value as { boundaryMs?: unknown }).boundaryMs;
  return typeof boundaryMs === "number" && Number.isFinite(boundaryMs)
    ? Math.round(boundaryMs)
    : null;
}

/**
 * Product-neutral execution: Settings selects a Card id, the Host freezes one
 * of its runnable implementations at Run submission, and ExternalAigcService
 * executes exactly that pinned route. Provider-specific wire adaptation stays
 * inside that implementation's plugin.
 */
export function createLocalMediaAnalysisService(options: {
  config: Pick<LocalMediaAnalysisConfigStore, "get" | "assertRunnable">;
  aigc: Pick<ExternalAigcService, "generateText">;
}) {
  return {
    async analyze(input: LocalMediaAnalysisInput): Promise<ExecutableMediaAnalysisResult> {
      const option = await options.config.assertRunnable({
        sourceKind: input.reference.asset.kind,
        modelId: input.modelId,
        category: input.category,
      });
      const config = await options.config.get();
      // The Action's source port is provenance. Model Providers receive the
      // modality port from their existing reference protocol, retaining the
      // immutable handle that the Host froze for this Run.
      const modelReference = { ...input.reference, slot: input.reference.asset.kind };
      const result = await options.aigc.generateText({
        taskId: input.taskId,
        projectId: input.projectId,
        actorType: "agent",
        prompt: input.prompt,
        model: input.modelId,
        modelConsumer: option.consumer,
        providerRoute: input.route,
        deadlineAt: input.deadlineAt,
        references: [modelReference],
        ...(input.reference.asset.kind === "video"
          ? {
              mediaAnalysisVideo: {
                // The Provider chooses whether its upstream supports adaptive analysis.
                processing: "auto",
                fps: config.video.fps,
                mediaResolution: config.video.mediaResolution,
              },
            }
          : {}),
      });
      let parsed = input.responseFormat === "text"
        ? { text: result.text }
        : parseJsonResult(result.text, input);
      const refinement = config.video.boundaryRefinement;
      const scenes = sceneBoundaries(parsed);
      if (
        input.reference.asset.kind === "video" &&
        input.category === "scene-shot" &&
        refinement.enabled &&
        scenes &&
        scenes.length > 1
      ) {
        const radiusSeconds = (1 / config.video.fps) + refinement.safetyMarginSeconds;
        const refinedScenes = scenes.map((scene) => ({ ...scene }));
        for (let index = 1; index < refinedScenes.length; index += 1) {
          const current = refinedScenes[index]!;
          const previous = refinedScenes[index - 1]!;
          const candidateMs =
            typeof current.startMs === "number"
              ? current.startMs
              : typeof previous.endMs === "number"
                ? previous.endMs
                : null;
          if (candidateMs === null) continue;
          const startSeconds = Math.max(0, (candidateMs / 1000) - radiusSeconds);
          const endSeconds = (candidateMs / 1000) + radiusSeconds;
          const review = await options.aigc.generateText({
            taskId: `${input.taskId}:boundary:${index}`,
            projectId: input.projectId,
            actorType: "agent",
            prompt:
              `Review the single candidate shot boundary near ${candidateMs}ms. ` +
              `Return JSON only as {"boundaryMs": number}, using the source video's absolute timeline.`,
            model: input.modelId,
            modelConsumer: option.consumer,
            providerRoute: input.route,
            deadlineAt: input.deadlineAt,
            references: [modelReference],
            mediaAnalysisVideo: {
              processing: "static",
              fps: refinement.fps,
              mediaResolution: config.video.mediaResolution,
              startSeconds,
              endSeconds,
            },
          });
          const boundaryMs = parsedBoundaryMs(parseJsonResult(review.text, input, index));
          if (
            boundaryMs === null ||
            boundaryMs < Math.round(startSeconds * 1000) ||
            boundaryMs > Math.round(endSeconds * 1000)
          ) {
            continue;
          }
          previous.endMs = boundaryMs;
          current.startMs = boundaryMs;
        }
        parsed = { ...(parsed as Record<string, unknown>), scenes: refinedScenes };
      }
      return {
        status: "completed",
        provider: result.provider ?? input.route.providerId ?? input.route.upstreamId,
        route: input.route.apiShape,
        underlyingModel: result.modelEndpoint ?? input.route.upstreamModel,
        result: parsed as never,
      };
    },
  };
}

export type LocalMediaAnalysisService = ReturnType<typeof createLocalMediaAnalysisService>;
