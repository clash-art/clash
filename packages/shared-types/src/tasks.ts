/**
 * Task Types - Zod schemas for AIGC task management
 *
 * Atomic tasks are executed via Cloudflare Workflows.
 * Orchestration (retry, sequencing) is handled by the Workflow engine.
 */

import { z } from 'zod';

// =============================================================================
// Atomic Task Types
// =============================================================================

export const AtomicTaskTypeSchema = z.enum([
  'image_gen',   // Generate image
  'video_gen',   // Generate video
  'audio_gen',   // Generate audio
  'text_gen',    // Generate text
  'description', // Generate description for asset
  'understand',  // Comprehensive understanding (ASR + visual analysis)
]);
export type AtomicTaskType = z.infer<typeof AtomicTaskTypeSchema>;

// === Image Generation Params ===
export const ImageGenParamsSchema = z.object({
  prompt: z.string(),
  model: z.string().default('nano-banana-pro'),
  model_params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  reference_images: z.array(z.string()).optional(),
  aspect_ratio: z.string().optional(),
});
export type ImageGenParams = z.infer<typeof ImageGenParamsSchema>;

// === Video Generation Params ===
export const VideoGenParamsSchema = z.object({
  prompt: z.string(),
  image_r2_key: z.string().optional(),
  duration: z.union([z.number(), z.string()]).default(5),
  model: z.string().default('kling-image2video'),
  model_params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  reference_images: z.array(z.string()).optional(),
  reference_mode: z.string().optional(),
  aspect_ratio: z.string().optional(),
  resolution: z.string().optional(),
  negative_prompt: z.string().optional(),
  cfg_scale: z.number().optional(),
});
export type VideoGenParams = z.infer<typeof VideoGenParamsSchema>;

// === Audio Generation Params ===
export const AudioGenParamsSchema = z.object({
  prompt: z.string(),
  model: z.string().default('gemini-3.1-flash-tts'),
  model_params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type AudioGenParams = z.infer<typeof AudioGenParamsSchema>;

// === Text Generation Params ===
export const TextGenParamsSchema = z.object({
  prompt: z.string(),
  model: z.string().default('gpt-5.4'),
  model_params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type TextGenParams = z.infer<typeof TextGenParamsSchema>;

// === Description Generation Params ===
export const DescriptionParamsSchema = z.object({
  r2_key: z.string(),
  mime_type: z.string(),
});
export type DescriptionParams = z.infer<typeof DescriptionParamsSchema>;

// === Understanding Params ===
export const UnderstandParamsSchema = z.object({
  r2_key: z.string(),
  mime_type: z.string(),
  language: z.string().optional(),
});
export type UnderstandParams = z.infer<typeof UnderstandParamsSchema>;

// === Discriminated Union for Atomic Task Request ===
export const AtomicTaskRequestSchema = z.discriminatedUnion('task_type', [
  z.object({ task_type: z.literal('image_gen'), params: ImageGenParamsSchema }),
  z.object({ task_type: z.literal('video_gen'), params: VideoGenParamsSchema }),
  z.object({ task_type: z.literal('audio_gen'), params: AudioGenParamsSchema }),
  z.object({ task_type: z.literal('text_gen'), params: TextGenParamsSchema }),
  z.object({ task_type: z.literal('description'), params: DescriptionParamsSchema }),
  z.object({ task_type: z.literal('understand'), params: UnderstandParamsSchema }),
]);
export type AtomicTaskRequest = z.infer<typeof AtomicTaskRequestSchema>;

// === Atomic Task Result ===
export const AtomicTaskResultSchema = z.object({
  success: z.boolean(),
  r2_key: z.string().optional(),
  external_task_id: z.string().optional(),
  data: z.record(z.string(), z.any()).optional(),
  error: z.string().optional(),
});
export type AtomicTaskResult = z.infer<typeof AtomicTaskResultSchema>;

// =============================================================================
// Workflow State Types
// =============================================================================

export const DOStepStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
]);
export type DOStepStatus = z.infer<typeof DOStepStatusSchema>;

export const DOStateSchema = z.object({
  task_id: z.string(),
  project_id: z.string(),
  node_id: z.string(),
  current_step: z.string(),
  step_status: DOStepStatusSchema,
  retry_count: z.number().default(0),
  max_retries: z.number().default(3),
  results: z.record(z.string(), z.any()).default({}),
  error: z.string().optional(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type DOState = z.infer<typeof DOStateSchema>;
