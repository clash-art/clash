import type { ProjectCloudAdmission } from "@clash/shared-types";
import { createCloudAccounts, cloudOrigin } from "./cloud-accounts.js";
export async function projectCloudJourney(
  dataDir: string,
  admission: ProjectCloudAdmission | null,
) {
  const accounts = createCloudAccounts(dataDir);
  const bound =
    admission &&
    admission.tenantId !== "pending" &&
    admission.status !== "local-only"
      ? admission
      : null;
  const connection = await accounts.status(bound?.syncBaseUrl);
  const authenticated = !!(await accounts.resolveToken(connection.serviceUrl, {
    expectedUserId: bound?.userId,
    env: process.env,
  }));
  const ready =
    bound?.status === "ready" &&
    bound.capabilities.canvas &&
    bound.capabilities.resources &&
    bound.capabilities.projectMetadata &&
    authenticated;
  return {
    ...connection,
    admission,
    authenticated,
    accountMismatch: !!(
      bound &&
      connection.user &&
      bound.userId !== connection.user.id
    ),
    webUrl: ready
      ? `${cloudOrigin(bound.syncBaseUrl)}/projects/${encodeURIComponent(bound.projectId)}`
      : null,
  };
}
