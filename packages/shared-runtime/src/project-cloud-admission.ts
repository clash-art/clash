import {
  ProjectCloudAdmissionRequestSchema,
  ProjectCloudAdmissionResponseSchema,
  ProjectCloudAdmissionSchema,
  type ProjectCloudAdmission,
  type ProjectCloudAdmissionRequest,
  type ProjectCloudAdmissionResponse,
} from "@clash/shared-types";

export interface CloudProjectAdmissionStore {
  admit(input: {
    userId: string;
    request: ProjectCloudAdmissionRequest;
    syncBaseUrl: string;
  }): Promise<ProjectCloudAdmissionResponse>;
  read(input: {
    userId: string;
    projectId: string;
    localReplicaId: string;
  }): Promise<ProjectCloudAdmission | null>;
}

export type AdmissionWrite = Parameters<
  CloudProjectAdmissionStore["admit"]
>[0] & {
  tenantId: string;
  capabilities: ProjectCloudAdmission["capabilities"];
};

/** Atomically claim/check the active project and persist admission. Reject with Forbidden
 * if ownership or tenant does not match. Existing endpoint/readiness must be preserved.
 * Reads must check current project ownership, tenant and deletion, not just admission identity. */
export interface CloudProjectAdmissionPersistence {
  persist(input: AdmissionWrite): Promise<ProjectCloudAdmission>;
  read: CloudProjectAdmissionStore["read"];
}

export function createCloudProjectAdmissionStore(
  persistence: CloudProjectAdmissionPersistence,
): CloudProjectAdmissionStore {
  return {
    async admit(input) {
      const request = ProjectCloudAdmissionRequestSchema.parse(input.request);
      if (
        request.metadata.projectId !== request.projectId ||
        request.metadata.deletedAt !== null
      ) {
        throw new Error("Forbidden");
      }
      const syncBaseUrl = new URL(input.syncBaseUrl).href.replace(/\/+$/u, "");
      const admission = ProjectCloudAdmissionSchema.parse(
        await persistence.persist({
          ...input,
          request,
          syncBaseUrl,
          tenantId: `personal:${input.userId}`,
          capabilities: {
            canvas: true,
            projectMetadata: true,
            resources: true,
          },
        }),
      );
      return ProjectCloudAdmissionResponseSchema.parse({
        schemaVersion: 1,
        admission,
        syncBaseUrl: admission.syncBaseUrl,
      });
    },
    read: (input) => persistence.read(input),
  };
}
