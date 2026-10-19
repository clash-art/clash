import { lazySchema } from "./lazy-schema.js";
import { z } from 'zod';

export let TextRevisionActorSchema = lazySchema(() => (
z.object({
  actorType: z.enum(['user', 'agent']),
  actorUserId: z.string(),
  actorAgentId: z.string().optional(),
})
), (real) => { TextRevisionActorSchema = real; });
export type TextRevisionActor = z.infer<typeof TextRevisionActorSchema>;

export let TextRevisionContentDescriptorSchema = lazySchema(() => (
z.object({
  kind: z.literal('text-revision-content'),
  stored: z.literal(true).optional(),
  contentHash: z.string(),
  mediaType: z.literal('text/markdown'),
  url: z.string(),
  immutable: z.literal(true),
  storage: z.object({
    kind: z.literal('content-addressed-revision-blob'),
    registry: z.literal('text_revisions'),
    mediaAsset: z.literal(false),
    agentWritable: z.literal(false),
  }),
})
), (real) => { TextRevisionContentDescriptorSchema = real; });
export type TextRevisionContentDescriptor = z.infer<typeof TextRevisionContentDescriptorSchema>;

export let TextAppliedRevisionSchema = lazySchema(() => (
z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('clash.text.revision'),
  textId: z.string(),
  revisionId: z.string(),
  parentRevisionId: z.string().optional(),
  projectId: z.string(),
  nodeId: z.string(),
  createdAt: z.string(),
  contentHash: z.string(),
  hashAlgorithm: z.literal('sha256-64'),
  sourceFilePath: z.string(),
  sourceFileHash: z.string(),
  actor: TextRevisionActorSchema.optional(),
})
), (real) => { TextAppliedRevisionSchema = real; });
export type TextAppliedRevision = z.infer<typeof TextAppliedRevisionSchema>;

export let TextRevisionHistoryEntrySchema = lazySchema(() => (
TextAppliedRevisionSchema.extend({
  content: TextRevisionContentDescriptorSchema.optional(),
})
), (real) => { TextRevisionHistoryEntrySchema = real; });
export type TextRevisionHistoryEntry = z.infer<typeof TextRevisionHistoryEntrySchema>;
