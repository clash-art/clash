import { lazySchema } from "./lazy-schema.js";
import { z } from 'zod';

/**
 * Everything a plugin can do to an entity, as a closed set.
 *
 * Two first-party plugins each grew one command per verb -- `timeline create/attach/detach/render`
 * and `director create/attach/detach/capture` -- and inspecting them shows only three distinct
 * shapes. `pull` and `apply` are the projection loop, identical for every editable entity and
 * already generic. `render` and `capture` are the same operation under two names: an entity plus
 * parameters produces an asset. What is left is lifecycle, which reads the same whatever the entity
 * is.
 *
 * Producing is absent on purpose. The canvas already has one mechanism for it: a node carries
 * parameters and, when executed, spawns a pending asset child. An action badge does this with a
 * Model Card's parameters; a `video-editor` node does it with `data.timelineId`, and executing one
 * spawns a pending `render-video` child. `timeline render` is that same path reached through a
 * second command, which is why it has its own receipt, its own waiting, and its own flags.
 *
 * So an entity does not declare that it produces. It declares the canvas node it appears as, and
 * producing is `canvas execute` on that node -- inheriting the pending-node lifecycle, the provider
 * accounting, and the CAS treatment that generations already have.
 *
 * Closed rather than free-form for the same reason a projection `source` is closed: the host owns
 * what each operation means, who may run it, and how its result enters the CAS. A plugin naming its
 * own verb would be declaring behaviour the host cannot reason about. `clash production` is the
 * cautionary case: forty-four subcommands, each a verb, all eventually deleted.
 */
export const ENTITY_OPERATIONS = ['create', 'attach', 'detach'] as const;

export let EntityOperationSchema = lazySchema(() => (
z.enum(ENTITY_OPERATIONS)
), (real) => { EntityOperationSchema = real; });
export type EntityOperation = z.infer<typeof EntityOperationSchema>;

export let ExecutablePluginEntityExportSchema = lazySchema(() => (
z.object({
  /** Stable entity name, unique within the plugin. */
  entity: z.string().trim().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().trim().min(1),
  operations: z.array(EntityOperationSchema).default([]),
  /**
   * The canvas node type this entity appears as once attached.
   *
   * Required by `attach`, which has nothing to place without it, and this is also how the entity
   * becomes executable: `canvas execute` on that node spawns the pending asset child. Declaring a
   * node type is therefore the whole of "this entity can produce something".
   */
  canvasNodeType: z.string().trim().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
}).strict().superRefine((entity, ctx) => {
  if (entity.operations.includes('attach') && !entity.canvasNodeType) {
    ctx.addIssue({
      code: "custom",
      path: ['canvasNodeType'],
      message: 'An entity that can be attached must declare the canvas node type it appears as.',
    });
  }
  if (!entity.operations.includes('attach') && entity.canvasNodeType) {
    ctx.addIssue({
      code: "custom",
      path: ['canvasNodeType'],
      message: 'canvasNodeType applies to an entity that declares the attach operation.',
    });
  }
})
), (real) => { ExecutablePluginEntityExportSchema = real; });

export type ExecutablePluginEntityExport = z.infer<typeof ExecutablePluginEntityExportSchema>;
