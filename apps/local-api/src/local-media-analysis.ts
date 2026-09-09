import type {
  ActionRunModelRoute,
  ExecutableMediaAnalysisReference,
  ExecutableMediaAnalysisResult,
} from "@clash/shared-types";

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
}

function parseJsonResult(value: string): unknown {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)?.[1];
  try {
    return JSON.parse(fenced ?? trimmed);
  } catch (error) {
    throw new Error("Media analysis model did not return valid JSON.", { cause: error });
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
      const result = await options.aigc.generateText({
        taskId: input.taskId,
        projectId: input.projectId,
        actorType: "agent",
        prompt: input.prompt,
        model: input.modelId,
        modelConsumer: option.consumer,
        providerRoute: input.route,
        references: [input.reference],
        ...(input.reference.asset.kind === "video"
          ? {
              modelParams: {
                // The Provider chooses whether its upstream supports adaptive analysis.
                video_processing: "auto",
                video_fps: config.video.fps,
                video_media_resolution: config.video.mediaResolution,
              },
            }
          : {}),
      });
      let parsed = input.responseFormat === "text"
        ? { text: result.text }
        : parseJsonResult(result.text);
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
            references: [input.reference],
            modelParams: {
              video_processing: "static",
              video_fps: refinement.fps,
              video_media_resolution: config.video.mediaResolution,
              video_start_seconds: startSeconds,
              video_end_seconds: endSeconds,
            },
          });
          const boundaryMs = parsedBoundaryMs(parseJsonResult(review.text));
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
