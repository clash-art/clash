import { z } from "zod";

/**
 * Strict envelope stored under the Definition-declared
 * `projectionSurface.stateKey`. Everything the legacy Timeline surface needs
 * to reconstruct a `ProjectTimeline` — its name, its ownership, and its DSL —
 * lives here; nothing else is native Generator state.
 */
export const ProjectTimelineEnvelopeSchema = z
  .object({
    name: z.string().trim().min(1),
    owner: z.union([
      z.object({ kind: z.literal("project") }).strict(),
      z
        .object({
          kind: z.literal("canvas-action"),
          canvasId: z.string().min(1),
          actionNodeId: z.string().min(1),
        })
        .strict(),
    ]),
    state: z.record(z.unknown()),
  })
  .strict();

export type ProjectTimelineEnvelope = z.infer<
  typeof ProjectTimelineEnvelopeSchema
>;
