import { z } from "zod";
/** Same-origin discovery; credentials and authorization codes never follow redirects. */
export const CloudServiceSchema = z.object({
  protocol: z.literal("clash-cloud-v1"),
  auth: z.object({
    clientId: z.literal("clash-cli"),
    authorizationPath: z.literal("/auth/cli"),
    tokenPath: z.literal("/api/v1/cli-auth/token"),
  }),
});
export const CloudAccountSchema = z.object({
  user: z.object({
    id: z.string().min(1),
    email: z.string(),
    name: z.string(),
  }),
});
export type CloudService = z.infer<typeof CloudServiceSchema>;

export const OFFICIAL_CLOUD_URL = "https://clash.art";
export const CloudConnectionStatusSchema = z.object({
  serviceUrl: z.string().url(),
  official: z.boolean(),
  user: CloudAccountSchema.shape.user.nullable(),
});
export type CloudConnectionStatus = z.infer<typeof CloudConnectionStatusSchema>;
import { ProjectCloudAdmissionSchema } from "./project-cloud-admission";
export const ProjectCloudJourneySchema = CloudConnectionStatusSchema.extend({
  admission: ProjectCloudAdmissionSchema.nullable(),
  authenticated: z.boolean(),
  accountMismatch: z.boolean(),
  webUrl: z.string().url().nullable(),
});
export type ProjectCloudJourney = z.infer<typeof ProjectCloudJourneySchema>;
