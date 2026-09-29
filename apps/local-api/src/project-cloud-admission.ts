import { cloudOrigin } from "./cloud-accounts.js";
import {
  ProjectCloudAdmissionRequestSchema,
  ProjectCloudAdmissionResponseSchema,
  type ProjectCloudAdmissionRequest,
  type ProjectCloudAdmissionResponse,
} from "@clash/shared-types";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface LocalCloudAdmissionClient {
  admit(
    request: ProjectCloudAdmissionRequest,
  ): Promise<ProjectCloudAdmissionResponse>;
}

export interface HttpCloudAdmissionClientOptions {
  baseUrl: string;
  token?: string | (() => string | undefined | Promise<string | undefined>);
  fetch?: FetchLike;
}

async function resolveToken(
  token: HttpCloudAdmissionClientOptions["token"],
): Promise<string | undefined> {
  if (typeof token === "function") return token();
  return token;
}

export function createHttpCloudAdmissionClient(
  options: HttpCloudAdmissionClientOptions,
): LocalCloudAdmissionClient {
  const fetchImpl = options.fetch ?? fetch;
  return {
    async admit(request) {
      const parsed = ProjectCloudAdmissionRequestSchema.parse(request);
      const token = await resolveToken(options.token);
      const headers = new Headers({ "content-type": "application/json" });
      if (token) headers.set("authorization", `Bearer ${token}`);
      const response = await fetchImpl(
        `${options.baseUrl.replace(/\/+$/u, "")}/api/v1/projects/${encodeURIComponent(parsed.projectId)}/cloud-admission`,
        {
          method: "POST",
          redirect: "error",
          headers,
          body: JSON.stringify(parsed),
        },
      );
      if (!response.ok) {
        throw new Error(`Cloud admission failed with HTTP ${response.status}`);
      }
      const result = ProjectCloudAdmissionResponseSchema.parse(
        await response.json(),
      );
      const origin = cloudOrigin(options.baseUrl);
      if (
        cloudOrigin(result.syncBaseUrl) !== origin ||
        cloudOrigin(result.admission.syncBaseUrl) !== origin
      ) {
        throw new Error("Cloud admission returned a different service origin");
      }
      return result;
    },
  };
}
