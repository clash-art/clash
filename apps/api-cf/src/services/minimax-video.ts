import { minimaxSubmit, minimaxPoll } from "@clash/shared-runtime/minimax-executor";
import { minimaxBaseUrl, type OrderedPromptContentPart } from "@clash/shared-types";
import { buildMiniMaxH3Content } from "@clash/shared-runtime";

export interface MiniMaxVideoParams {
  apiKey: string;
  model: string;
  prompt: string;
  duration: number;
  resolution: "768P" | "2K";
  ratio: "adaptive" | "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
  startFrame?: string;
  endFrame?: string;
  referenceImages?: string[];
  referenceVideos?: string[];
  referenceAudios?: string[];
  orderedContentParts?: OrderedPromptContentPart[];
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface MiniMaxVideoResult {
  taskId: string;
  url: string;
  model: string;
  duration?: number;
  resolution?: string;
  ratio?: string;
}

function normalizeBaseUrl(baseUrl: string | undefined, region?: string): string {
  return minimaxBaseUrl(region, baseUrl);
}

export async function submitMiniMaxVideo(params: MiniMaxVideoParams): Promise<{ taskId: string; model: string }> {
  const apiKey = params.apiKey.trim();
  if (!apiKey) throw new Error("MiniMax provider account is missing apiKey.");
  const orderedContentParts = params.orderedContentParts ?? [];
  const orderedPrompt = orderedContentParts
    .filter((part): part is Extract<OrderedPromptContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
  const prompt = (params.prompt.trim() ? params.prompt : orderedPrompt).trim();
  if (!prompt) throw new Error("Prompt is required for MiniMax H3 generation.");
  const referenceImages = params.referenceImages ?? [];
  const referenceVideos = params.referenceVideos ?? [];
  const referenceAudios = params.referenceAudios ?? [];
  const orderedMediaTypes = new Set(
    orderedContentParts
      .filter((part) => part.type !== "text")
      .map((part) => part.type),
  );
  if (params.endFrame && !params.startFrame) {
    throw new Error("MiniMax H3 end frame requires a start frame.");
  }
  if (params.startFrame && (
    referenceImages.length || referenceVideos.length || referenceAudios.length || orderedMediaTypes.size
  )) {
    throw new Error("MiniMax H3 start/end frames cannot be mixed with omni references.");
  }
  const hasReferenceAudio = referenceAudios.length > 0 || orderedMediaTypes.has("audio");
  const hasReferenceVisual = referenceImages.length > 0 || referenceVideos.length > 0 ||
    orderedMediaTypes.has("image") || orderedMediaTypes.has("video");
  if (hasReferenceAudio && !hasReferenceVisual) {
    throw new Error("MiniMax H3 reference audio requires at least one reference image or video.");
  }

  const fetchImpl = params.fetch ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const content = buildMiniMaxH3Content({
    prompt,
    orderedContentParts,
    startFrame: params.startFrame,
    endFrame: params.endFrame,
    referenceImages,
    referenceVideos,
    referenceAudios,
  });
  const created = await minimaxSubmit({
    kind: "video", apiKey, baseUrl, fetch: fetchImpl,
    body: { model: params.model, content, resolution: params.resolution, duration: params.duration, ratio: params.startFrame ? "adaptive" : params.ratio },
  });
  const taskId = created.pollState.taskId;
  return { taskId, model: params.model };
}

export async function pollMiniMaxVideoOnce(
  params: Pick<MiniMaxVideoParams, "apiKey" | "baseUrl" | "fetch">,
  token: { taskId: string; model: string },
): Promise<MiniMaxVideoResult | null> {
  const { taskId } = token;
  const result = await minimaxPoll({ state: { taskId }, apiKey: params.apiKey, baseUrl: params.baseUrl, fetch: params.fetch ?? fetch });
  if (result.status === "accepted") return null;
  return { taskId, url: result.media.url, model: token.model, ...(result.media.durationMs === undefined ? {} : { duration: result.media.durationMs / 1000 }) };
}
