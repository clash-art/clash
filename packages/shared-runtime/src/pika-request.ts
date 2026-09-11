export interface PikaMediaRequestInput {
  modelId: string;
  kind: string;
  upstreamModel: string;
  prompt: string;
  aspectRatio?: string;
  duration?: number | string;
  modelParams?: Record<string, unknown>;
  startFrameUrl?: string;
  endFrameUrl?: string;
  referenceImageUrls?: string[];
  referenceVideoUrls?: string[];
  referenceAudioUrls?: string[];
}

export interface PikaMediaRequest {
  operation: string;
  body: Record<string, unknown>;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function operation(input: PikaMediaRequestInput): string {
  const images = input.referenceImageUrls ?? [];
  if (input.modelId === "pika-2.5") {
    return input.startFrameUrl || images.length
      ? "pika/pika-2.5/image-to-video"
      : "pika/pika-2.5/text-to-video";
  }
  if (input.modelId === "flux-3-video") {
    return input.startFrameUrl || images.length
      ? "black-forest-labs/flux-3-video/image-to-video"
      : "black-forest-labs/flux-3-video/text-to-video";
  }
  if (input.modelId === "kling-3") {
    return input.startFrameUrl || images.length
      ? "kling/kling-3.0/image-to-video"
      : "kling/kling-3.0/text-to-video";
  }
  if (input.kind === "image" && images.length) {
    return input.upstreamModel.replace(/\/text-to-image$/, "/image-to-image");
  }
  if (
    input.modelId === "minimax-h3" &&
    !images.length &&
    !(input.referenceVideoUrls ?? []).length &&
    !(input.referenceAudioUrls ?? []).length
  ) {
    return "minimax/h3/text-to-video";
  }
  return input.upstreamModel;
}

function requestBody(
  input: PikaMediaRequestInput,
  selectedOperation: string,
): Record<string, unknown> {
  const params = input.modelParams ?? {};
  const images = input.referenceImageUrls ?? [];
  const videos = input.referenceVideoUrls ?? [];
  const audios = input.referenceAudioUrls ?? [];
  if (input.modelId === "nano-banana-2") {
    return compact({
      prompt: input.prompt,
      num_images: params.count ?? 1,
      aspect_ratio: input.aspectRatio ?? params.aspect_ratio ?? "1:1",
      output_format: params.output_format ?? "png",
      resolution: params.resolution ?? "1K",
      image_urls: images.length ? images : undefined,
    });
  }
  if (
    ["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"].includes(
      input.modelId,
    )
  ) {
    return compact({
      prompt: input.prompt,
      num_images: params.count ?? 1,
      aspect_ratio: input.aspectRatio,
      output_format: params.output_format ?? "png",
      resolution: params.resolution,
      quality: params.quality,
      background: params.background,
      size: params.size === "auto" ? undefined : params.size,
      image_urls: images.length ? images : undefined,
    });
  }
  if (input.modelId === "seedream-5-pro") {
    return compact({
      prompt: input.prompt,
      num_images: params.count ?? 1,
      size: params.size,
      image_urls: images.length ? images : undefined,
    });
  }
  if (input.modelId === "recraft-v4") {
    return compact({
      prompt: input.prompt,
      num_images: params.count ?? 1,
      size: params.size ?? input.aspectRatio,
    });
  }
  if (input.modelId === "grok-imagine-quality") {
    return compact({
      prompt: input.prompt,
      num_images: params.count ?? 1,
      resolution: params.resolution ?? "1K",
      aspect_ratio: input.aspectRatio ?? "1:1",
      image_urls: images.length ? images : undefined,
    });
  }
  if (input.modelId === "pika-2.5") {
    const requestedDuration = input.duration ?? params.duration ?? 5;
    if (
      selectedOperation.endsWith("/text-to-video") &&
      Number(requestedDuration) !== 5
    ) {
      throw new Error("10-second Pika 2.5 generation requires a source image.");
    }
    return compact({
      prompt: input.prompt,
      resolution: params.resolution ?? "1080p",
      // Pika 2.5 text-to-video is fixed at five seconds. Image-to-video additionally supports 10s.
      duration_s: selectedOperation.endsWith("/text-to-video")
        ? 5
        : requestedDuration,
      negative_prompt: params.negative_prompt,
      seed: params.seed,
      image: input.startFrameUrl ?? images[0],
    });
  }
  if (input.modelId === "flux-3-video") {
    const startFrame = input.startFrameUrl ?? images[0];
    return compact({
      prompt: input.prompt,
      duration: input.duration ?? params.duration ?? "auto",
      resolution: params.resolution ?? "720p",
      aspect_ratio: input.aspectRatio ?? params.aspect_ratio ?? "auto",
      draft: params.mode === "draft",
      generate_audio: params.generate_audio ?? true,
      keyframes: startFrame ? [{ image_url: startFrame }] : undefined,
    });
  }
  if (input.modelId === "kling-3") {
    return compact({
      prompt: input.prompt,
      duration: Number(input.duration ?? params.duration ?? 5),
      resolution: params.resolution ?? "720p",
      aspect_ratio: input.aspectRatio ?? "16:9",
      audio: params.generate_audio === false ? "off" : "native",
      image_url: input.startFrameUrl ?? images[0],
      last_frame_url: input.endFrameUrl,
    });
  }
  if (input.modelId === "grok-imagine-video-1.5") {
    return compact({
      prompt: input.prompt,
      duration: input.duration ?? params.duration ?? 6,
      image_url: input.startFrameUrl ?? images[0],
      aspect_ratio: input.aspectRatio,
      resolution: params.resolution ?? "720p",
    });
  }
  if (input.modelId === "seedance-2-startend") {
    return compact({
      prompt: input.prompt,
      duration: input.duration ?? params.duration ?? "auto",
      ratio: input.aspectRatio ?? params.aspect_ratio,
      generate_audio: params.generate_audio,
      watermark: false,
      image_url: input.startFrameUrl ?? images[0],
      end_image_url: input.endFrameUrl,
      resolution: params.resolution ?? "720p",
    });
  }
  if (input.modelId === "seedance-2-ref") {
    return compact({
      prompt: input.prompt,
      duration: input.duration ?? params.duration ?? "auto",
      ratio: input.aspectRatio ?? params.aspect_ratio,
      generate_audio: params.generate_audio,
      watermark: false,
      image_urls: images.length ? images : undefined,
      video_urls: videos.length ? videos : undefined,
      audio_urls: audios.length ? audios : undefined,
      resolution: params.resolution ?? "720p",
    });
  }
  if (
    input.modelId === "minimax-h3" ||
    input.modelId === "minimax-h3-startend"
  ) {
    return compact({
      prompt: input.prompt,
      duration: input.duration ?? params.duration ?? 5,
      resolution: params.resolution ?? "2K",
      seed: params.seed,
      aigc_watermark: params.aigc_watermark,
      ratio:
        selectedOperation.endsWith("text-to-video") ||
        selectedOperation.endsWith("reference-to-video")
          ? (input.aspectRatio ??
            params.aspect_ratio ??
            (selectedOperation.endsWith("reference-to-video")
              ? "adaptive"
              : "16:9"))
          : undefined,
      first_frame_image: input.startFrameUrl,
      last_frame_image: input.endFrameUrl,
      image_urls: images.length ? images : undefined,
      video_urls: videos.length ? videos : undefined,
      audio_urls: audios.length ? audios : undefined,
    });
  }
  if (input.modelId === "minimax-music-3") {
    return compact({
      prompt: input.prompt,
      lyrics: params.lyrics,
      lyrics_optimizer: params.lyrics_optimizer ?? false,
      is_instrumental: params.is_instrumental ?? false,
      audio_setting: compact({
        sample_rate: params.sample_rate,
        bitrate: params.bitrate,
        format: params.format,
      }),
    });
  }
  if (input.modelId === "lyria-3-pro") return { prompt: input.prompt };
  if (input.modelId === "minimax-speech-2.8-hd") {
    if (typeof params.voice_id !== "string") {
      throw new Error("Pika MiniMax Speech voice_id is required.");
    }
    return compact({
      text: input.prompt,
      voice_id: params.voice_id,
      speed: params.speed,
      vol: params.vol,
      pitch: params.pitch,
      emotion: params.emotion,
      sample_rate: params.sample_rate,
      bitrate: params.bitrate,
      format: params.format,
      channel: params.channel,
      language_boost: params.language_boost,
    });
  }
  throw new Error(`Pika API Club does not implement ${input.modelId}`);
}

export function buildPikaMediaRequest(
  input: PikaMediaRequestInput,
): PikaMediaRequest {
  const selectedOperation = operation(input);
  return {
    operation: selectedOperation,
    body: requestBody(input, selectedOperation),
  };
}
