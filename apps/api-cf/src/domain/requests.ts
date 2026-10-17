import { z } from "zod";

/** Default model names — single source of truth for request schemas & response metadata. */
export const DEFAULT_IMAGE_MODEL = "nano-banana-2";
export const DEFAULT_VIDEO_MODEL = "kling-v1";

export const GenerateImageRequestSchema = z.object({
  prompt: z.string(),
  project_id: z.string().describe("Project ID for R2 storage path"),
  asset_id: z.string().describe("Pre-allocated asset ID"),
  asset_name: z.string().describe("Asset name for the record"),
  system_prompt: z.string().default(""),
  aspect_ratio: z.string().default("16:9"),
  base64_images: z.array(z.string()).default([]),
  reference_image_urls: z.array(z.string()).default([]),
  model_name: z.string().nullish().default(DEFAULT_IMAGE_MODEL),
});
export type GenerateImageRequest = z.infer<typeof GenerateImageRequestSchema>;

export const GenerateVideoRequestSchema = z.object({
  prompt: z.string(),
  project_id: z.string().describe("Project ID for R2 storage path"),
  asset_id: z.string().describe("Pre-allocated asset ID"),
  asset_name: z.string().describe("Asset name for the record"),
  image_url: z.string().nullish(),
  base64_images: z.array(z.string()).default([]),
  reference_image_urls: z.array(z.string()).default([]),
  duration: z.number().default(5),
  cfg_scale: z.number().default(0.5),
  model: z.string().default(DEFAULT_VIDEO_MODEL),
});
export type GenerateVideoRequest = z.infer<typeof GenerateVideoRequestSchema>;

export const GenerateDescriptionRequestSchema = z.object({
  url: z.string(),
  task_id: z.string(),
});
export type GenerateDescriptionRequest = z.infer<typeof GenerateDescriptionRequestSchema>;

export const GenerateSemanticIDRequestSchema = z.object({
  project_id: z.string(),
  count: z.number().min(1).max(100).default(1),
});
export type GenerateSemanticIDRequest = z.infer<typeof GenerateSemanticIDRequestSchema>;

export const TaskSubmitRequestSchema = z.object({
  task_type: z.enum(["image_gen", "video_gen", "audio_gen", "text_gen", "image_desc", "video_desc", "video_thumbnail"]),
  project_id: z.string(),
  node_id: z.string(),
  params: z.record(z.string(), z.any()),
});
export type TaskSubmitRequest = z.infer<typeof TaskSubmitRequestSchema>;
