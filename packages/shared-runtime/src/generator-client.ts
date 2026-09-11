export {
  CreateProjectGeneratorRequestSchema,
  SubmitGeneratorActionRequestSchema,
  AdvanceProjectGeneratorRequestSchema,
} from "@clash/shared-types";

export type GeneratorRequest = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

export class GeneratorHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(
      `Generator API error ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`,
    );
    this.name = "GeneratorHttpError";
  }
}

function segment(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return encodeURIComponent(normalized);
}

async function json(
  request: GeneratorRequest,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await request(path, init);
  const text = await response.text();
  let body: unknown = text;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      /* preserve non-JSON error bodies */
    }
  }
  if (!response.ok) throw new GeneratorHttpError(response.status, body);
  return body;
}

export function createGeneratorClient(request: GeneratorRequest) {
  const projectPath = (projectId: string) =>
    `/api/v1/projects/${segment(projectId, "project id")}`;
  const post = (path: string, body: unknown) =>
    json(request, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    listDefinitions: () => json(request, "/api/v1/generator-definitions"),
    getDefinition: (pluginId: string, definitionId: string) =>
      json(
        request,
        `/api/v1/generator-definitions/${segment(pluginId, "plugin id")}/${segment(definitionId, "definition id")}`,
      ),
    createGenerator: (projectId: string, body: unknown) =>
      post(`${projectPath(projectId)}/generators`, body),
    getGenerator: (projectId: string, generatorId: string) =>
      json(
        request,
        `${projectPath(projectId)}/generators/${segment(generatorId, "generator id")}`,
      ),
    advanceGenerator: (projectId: string, generatorId: string, body: unknown) =>
      post(
        `${projectPath(projectId)}/generators/${segment(generatorId, "generator id")}/revisions`,
        body,
      ),
    submitActionRun: (
      projectId: string,
      generatorId: string,
      actionId: string,
      body: unknown,
    ) =>
      post(
        `${projectPath(projectId)}/generators/${segment(generatorId, "generator id")}/actions/${segment(actionId, "action id")}/runs`,
        body,
      ),
    getActionRun: (projectId: string, actionRunId: string) =>
      json(
        request,
        `${projectPath(projectId)}/generator-runs/${segment(actionRunId, "action run id")}`,
      ),
    getOutputCommit: (
      projectId: string,
      actionRunId: string,
      outputSlot: string,
    ) =>
      json(
        request,
        `${projectPath(projectId)}/generator-runs/${segment(actionRunId, "action run id")}/outputs/${segment(outputSlot, "output slot")}`,
      ),
  };
}

export type GeneratorClient = ReturnType<typeof createGeneratorClient>;
