import type { ProjectHostCommand } from "@clash/shared-types";

export type ProjectHostResponse = Record<string, unknown> & { error?: string };
export type ProjectHostHttpRequest = (path: string, init?: RequestInit) => Promise<Response>;

export class ProjectHostHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    const record =
      body !== null && typeof body === "object"
        ? (body as Record<string, unknown>)
        : undefined;
    const code = cleanErrorField(record?.code);
    const detail = cleanErrorField(record?.error);
    const reason = [code, detail].filter(Boolean).join(": ");
    super(
      reason
        ? `${reason} (Project host HTTP ${status})`
        : `Project host request failed with HTTP ${status}`,
    );
    this.name = "ProjectHostHttpError";
  }
}

function cleanErrorField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function projectHostCommandUrl(
  endpoint: string,
  projectId: string,
): string {
  return `${endpoint.replace(/\/+$/, "")}/api/v1/projects/${encodeURIComponent(projectId)}/host-command`;
}

/** Shared transport: browsers supply their runtime request; CLI supplies its discovered endpoint. */
export async function sendProjectHostCommand<T extends ProjectHostResponse = ProjectHostResponse>(options: {
  endpoint?: string;
  projectId: string;
  command: ProjectHostCommand;
  token?: string;
  fetch?: typeof globalThis.fetch;
  request?: ProjectHostHttpRequest;
}): Promise<T> {
  const response = await (options.request ?? options.fetch ?? globalThis.fetch)(
    projectHostCommandUrl(options.endpoint ?? "", options.projectId),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify(options.command),
    },
  );
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* Preserve gateway diagnostics. */ }
  if (!response.ok || !body || typeof body !== "object" || Array.isArray(body)) {
    throw new ProjectHostHttpError(response.status, body);
  }
  return body as T;
}
