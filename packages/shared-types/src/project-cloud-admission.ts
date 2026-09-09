import { z } from "zod";
import { ProjectMetadataSchema } from "./project-metadata.js";
import { ResourceIdSchema } from "./assets.js";

/** Project-level cloud state. `local-only` is never sent by the cloud API. */
export const ProjectCloudAdmissionStatusSchema = z.enum([
  "local-only",
  "pending",
  "syncing",
  "ready",
  "failed",
]);
export type ProjectCloudAdmissionStatus = z.infer<
  typeof ProjectCloudAdmissionStatusSchema
>;

export const ProjectCloudCapabilitiesSchema = z
  .object({
    canvas: z.boolean(),
    projectMetadata: z.boolean(),
    resources: z.boolean(),
  })
  .strict();
export type ProjectCloudCapabilities = z.infer<
  typeof ProjectCloudCapabilitiesSchema
>;

export const ProjectCloudAdmissionSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().trim().min(1),
    tenantId: z.string().trim().min(1),
    userId: z.string().trim().min(1),
    localReplicaId: z.string().trim().min(1),
    syncBaseUrl: z.string().url(),
    status: ProjectCloudAdmissionStatusSchema,
    capabilities: ProjectCloudCapabilitiesSchema,
    admittedAt: z.string().datetime({ offset: true }).nullable(),
    updatedAt: z.string().datetime({ offset: true }),
    lastError: z.string().trim().min(1).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "failed" && !value.lastError) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastError"],
        message: "failed admission must include lastError",
      });
    }
  });
export type ProjectCloudAdmission = z.infer<
  typeof ProjectCloudAdmissionSchema
>;

export const ProjectCloudAdmissionRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().trim().min(1),
    localReplicaId: z.string().trim().min(1),
    metadata: ProjectMetadataSchema,
    resourceIds: z.array(ResourceIdSchema).max(100_000),
  })
  .strict();
export type ProjectCloudAdmissionRequest = z.infer<
  typeof ProjectCloudAdmissionRequestSchema
>;

export const ProjectCloudAdmissionResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    admission: ProjectCloudAdmissionSchema,
    syncBaseUrl: z.string().url(),
  })
  .strict();
export type ProjectCloudAdmissionResponse = z.infer<
  typeof ProjectCloudAdmissionResponseSchema
>;
