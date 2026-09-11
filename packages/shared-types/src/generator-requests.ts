import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { ExecutablePluginJsonValueSchema } from "./plugin-json-value.js";
import {
  AssetRevisionRefSchema,
  GeneratorInputRefSchema,
  GeneratorRevisionRefSchema,
} from "./generator-v2.js";

/** Shared native Generator HTTP request contracts, also disclosed through MCP. */
export const CreateProjectGeneratorRequestSchema = z
  .object({
    generatorId: z.string().trim().min(1),
    generatorRevisionId: z.string().trim().min(1),
    pluginId: z.string().trim().min(1),
    definitionId: z.string().trim().min(1),
    state: z.record(ExecutablePluginJsonValueSchema),
    persistentInputRefs: z.array(GeneratorInputRefSchema).default([]),
    forkedFrom: GeneratorRevisionRefSchema.optional(),
    /** Optional Canvas placement, committed atomically with the draft. */
    placement: z
      .object({
        canvasId: z.string().trim().min(1),
        nodeId: z.string().trim().min(1),
        /** Installed Action Card projecting this Definition; omitted for built-in Model cards. */
        actionCardId: z.string().trim().min(1).optional(),
        /** Explicit Canvas origin for copy lineage and retained Asset connections. */
        sourceNodeId: z.string().trim().min(1).optional(),
        label: z.string().optional(),
        parentId: z.string().trim().min(1).optional(),
        position: z
          .object({ x: z.number().finite(), y: z.number().finite() })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CreateProjectGeneratorRequest = z.infer<
  typeof CreateProjectGeneratorRequestSchema
>;

export const SubmitGeneratorActionRequestSchema = z
  .object({
    actionRunId: z.string().trim().min(1),
    generatorRevisionId: z.string().trim().min(1),
    /** Host-local routing preference; never part of the Project Run or Revision. */
    providerAccountId: z.string().trim().min(1).optional(),
    parameters: z.record(ExecutablePluginJsonValueSchema).default({}),
    invocationInputRefs: z.array(GeneratorInputRefSchema).default([]),
  })
  .strict();
export type SubmitGeneratorActionRequest = z.infer<
  typeof SubmitGeneratorActionRequestSchema
>;

export const AdvanceProjectGeneratorRequestSchema = z
  .object({
    expectedHeadRevisionId: z.string().trim().min(1),
    generatorRevisionId: z.string().trim().min(1),
    state: z.record(ExecutablePluginJsonValueSchema),
    persistentInputRefs: z.array(GeneratorInputRefSchema).default([]),
    /** Optional Canvas projections committed with the new native inputs. */
    canvasInputConnections: z
      .array(
        z
          .object({
            canvasId: z.string().trim().min(1),
            sourceNodeId: z.string().trim().min(1),
            targetNodeId: z.string().trim().min(1),
            asset: AssetRevisionRefSchema,
            disconnect: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type AdvanceProjectGeneratorRequest = z.infer<
  typeof AdvanceProjectGeneratorRequestSchema
>;

/** Derive CLI disclosure from the same request validators used by Host and MCP. */
export function projectGeneratorRequestContract(operation: string) {
  switch (operation) {
    case "create":
      return {
        operation,
        inputSchema: zodToJsonSchema(CreateProjectGeneratorRequestSchema),
      };
    case "advance":
      return {
        operation,
        inputSchema: zodToJsonSchema(AdvanceProjectGeneratorRequestSchema),
      };
    case "submit":
      return {
        operation,
        inputSchema: zodToJsonSchema(SubmitGeneratorActionRequestSchema),
      };
    default:
      throw new Error(
        `Unknown Generator input contract: ${operation}. Use create, advance, or submit.`,
      );
  }
}
