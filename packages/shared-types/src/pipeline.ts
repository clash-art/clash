import { lazySchema } from "./lazy-schema.js";
/**
 * Pipeline Types - Declarative Pregel Model
 * 
 * Pipeline = 状态转换，声明式定义
 * Superstep = 同一批次的任务，全部完成后进入下一步
 * 所有任务都是异步的，都需要 poll
 */

import { z } from 'zod';

// =============================================================================
// Asset Status (节点顶层状态)
// =============================================================================

export let AssetStatusSchema = lazySchema(() => (
z.enum([
  'uploading',   // 上传中
  'generating',  // 生成中 → 触发 GenPipeline
  'completed',   // 资源就绪 → 触发 DescribePipeline
  'fin',         // 全部完成
  'failed',      // 失败
])
), (real) => { AssetStatusSchema = real; });
export type AssetStatus = z.infer<typeof AssetStatusSchema>;

// =============================================================================
// Task State (单个任务的状态)
// =============================================================================

export let TaskStateSchema = lazySchema(() => (
z.enum([
  'pending',     // 等待提交
  'submitted',   // 已提交，等待 poll
  'completed',   // 完成
  'failed',      // 失败
])
), (real) => { TaskStateSchema = real; });
export type TaskState = z.infer<typeof TaskStateSchema>;

// =============================================================================
// Pipeline Task Definition (声明式任务定义)
// =============================================================================

export let PipelineTaskDefSchema = lazySchema(() => (
z.object({
  id: z.string(),             // 任务 ID (在 pipeline 内唯一)
  taskType: z.string(),       // Python API task_type
  // params 从 node data 和 previous task results 构建
  // 用 {{xxx}} 模板语法引用
  paramsTemplate: z.record(z.string(), z.string()).optional(),
})
), (real) => { PipelineTaskDefSchema = real; });
export type PipelineTaskDef = z.infer<typeof PipelineTaskDefSchema>;

// =============================================================================
// Superstep Definition (一批并行任务)
// =============================================================================

export let SuperstepDefSchema = lazySchema(() => (
z.object({
  id: z.string(),             // superstep ID
  tasks: z.array(PipelineTaskDefSchema),
})
), (real) => { SuperstepDefSchema = real; });
export type SuperstepDef = z.infer<typeof SuperstepDefSchema>;

// =============================================================================
// Pipeline Definition (声明式 pipeline)
// =============================================================================

export let PipelineDefSchema = lazySchema(() => (
z.object({
  id: z.string(),             // pipeline ID (e.g., 'image_gen', 'describe')
  nodeType: z.string(),       // 适用的节点类型 (e.g., 'image', 'video')
  fromStatus: AssetStatusSchema, // 入口状态
  toStatus: AssetStatusSchema,   // 出口状态
  supersteps: z.array(SuperstepDefSchema),
})
), (real) => { PipelineDefSchema = real; });
export type PipelineDef = z.infer<typeof PipelineDefSchema>;

// =============================================================================
// Runtime State (运行时状态，保存在 node.data.pipelineState)
// =============================================================================

export let TaskRuntimeStateSchema = lazySchema(() => (
z.object({
  id: z.string(),
  state: TaskStateSchema,
  externalTaskId: z.string().optional(),
  result: z.record(z.string(), z.any()).optional(),
  error: z.string().optional(),
  submittedAt: z.number().optional(),
  completedAt: z.number().optional(),
})
), (real) => { TaskRuntimeStateSchema = real; });
export type TaskRuntimeState = z.infer<typeof TaskRuntimeStateSchema>;

export let PipelineRuntimeStateSchema = lazySchema(() => (
z.object({
  pipelineId: z.string(),
  currentSuperstep: z.number(),
  tasks: z.record(z.string(), TaskRuntimeStateSchema), // taskId → state
  startedAt: z.number(),
  completedAt: z.number().optional(),
})
), (real) => { PipelineRuntimeStateSchema = real; });
export type PipelineRuntimeState = z.infer<typeof PipelineRuntimeStateSchema>;
