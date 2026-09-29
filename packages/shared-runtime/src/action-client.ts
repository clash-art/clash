import {
  AssetRevisionRefSchema,
  GeneratorDefinitionSchema,
  type AssetRevisionRef,
  type ExecutablePluginJsonValue,
  type GeneratorDefinition,
  type GeneratorInputPort,
  type GeneratorInputRef,
  type ProjectActionRun,
  GeneratorRunDiagnosticsSchema,
  type GeneratorRunDiagnostics,
} from "@clash/shared-types";
import Ajv from "ajv";
import {
  createDocumentClient,
  publicDocumentValue,
} from "./document-client.js";
import {
  createGeneratorClient,
  GeneratorHttpError,
  type GeneratorRequest,
} from "./generator-client.js";

type Values = Record<string, ExecutablePluginJsonValue>;
const ajv = new Ajv({ allErrors: true, strict: false });

function validateWait(value = 30_000): number {
  if (!Number.isFinite(value) || value < 0 || value > 60_000)
    throw new Error(
      "waitMs must be between 0 and 60000; continue waiting on the returned Run",
    );
  return value;
}

function validateValues(schema: object, value: Values, label: string): void {
  const validate = ajv.compile(schema);
  if (!validate(value))
    throw new Error(
      `Invalid Action ${label}: ${ajv.errorsText(validate.errors)}`,
    );
}
export type ActionInvocation = {
  /** Fully qualified plugin/definition/action, or an unambiguous definition.action. */
  action: string;
  assetId?: string;
  inputs?: Record<
    string,
    string | AssetRevisionRef | Array<string | AssetRevisionRef>
  >;
  state?: Values;
  parameters?: Values;
  requestId?: string;
  canvasId?: string;
  label?: string;
  providerAccountId?: string;
  waitMs?: number;
};
export type ActionResult = {
  actionRunId: string;
  status: ProjectActionRun["status"];
  run: ProjectActionRun;
  outputs: Array<{ slot: string; reference: AssetRevisionRef; value: unknown }>;
  next?: string;
  diagnostics?: GeneratorRunDiagnostics;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Action API returned an invalid object");
  return value as Record<string, unknown>;
}

function inputRefs(
  ports: GeneratorInputPort[],
  inputs: NonNullable<ActionInvocation["inputs"]>,
): GeneratorInputRef[] {
  return ports.flatMap((port) => {
    const value = inputs[port.slot];
    const values =
      value === undefined ? [] : Array.isArray(value) ? value : [value];
    if (
      values.length < port.cardinality.minItems ||
      (port.cardinality.maxItems !== null &&
        values.length > port.cardinality.maxItems)
    ) {
      throw new Error(
        `Input ${port.slot} needs ${port.cardinality.minItems}..${port.cardinality.maxItems ?? "many"} references`,
      );
    }
    return values.map((item, index) => ({
      slot: port.slot,
      ...(values.length > 1 ? { itemKey: String(index) } : {}),
      target: AssetRevisionRefSchema.parse(
        typeof item === "string"
          ? { kind: "media", projectAssetId: item }
          : item,
      ),
    }));
  });
}

/** Convenience only: every write still goes through the native Host authority. */
export function createActionClient(request: GeneratorRequest) {
  const generators = createGeneratorClient(request);
  const documents = createDocumentClient(request);
  const projectPath = (projectId: string) =>
    `/api/v1/projects/${encodeURIComponent(projectId)}`;
  async function get(path: string): Promise<unknown> {
    const response = await request(path);
    const body: unknown = await response.json();
    if (!response.ok) throw new GeneratorHttpError(response.status, body);
    return body;
  }
  async function definitions(
    projectId: string,
  ): Promise<GeneratorDefinition[]> {
    const response = object(
      await get(
        `/api/v1/generator-definitions?projectId=${encodeURIComponent(projectId)}`,
      ),
    );
    if (!Array.isArray(response.definitions))
      throw new Error("The Host did not return installed Action definitions");
    return response.definitions.map((item) =>
      GeneratorDefinitionSchema.parse(item),
    );
  }
  function candidates(definitions: GeneratorDefinition[]) {
    return definitions.flatMap((definition) =>
      definition.actions.map((action) => ({
        key: `${definition.pluginId}/${definition.definitionId}/${action.id}`,
        shortName: `${definition.definitionId}.${action.id}`,
        definition,
        action,
      })),
    );
  }
  async function list(projectId: string, options: { query?: string } = {}) {
    const query = options.query?.trim().toLocaleLowerCase();
    return {
      actions: candidates(await definitions(projectId))
        .filter(
          (item) =>
            !query ||
            `${item.key} ${JSON.stringify(item.action.parametersSchema)}`
              .toLocaleLowerCase()
              .includes(query),
        )
        .map(({ key, shortName, definition, action }) => ({
          key,
          shortName,
          stateSchema: definition.stateSchema,
          parametersSchema: action.parametersSchema,
          persistentInputs: definition.persistentInputs,
          inputs: action.invocationInputs,
          outputs: action.outputs,
        })),
    };
  }
  async function wait(
    projectId: string,
    actionRunId: string,
    options: { waitMs?: number } = {},
  ): Promise<ActionResult> {
    const waitMs = validateWait(options.waitMs);
    const deadline = Date.now() + waitMs;
    for (;;) {
      const response = object(
        await generators.getActionRun(projectId, actionRunId),
      );
      const run = object(response.run) as ProjectActionRun;
      if (!["pending", "running", "succeeded", "failed"].includes(run.status))
        throw new Error("Action Run has an invalid status");
      const diagnostics =
        response.diagnostics === undefined
          ? undefined
          : GeneratorRunDiagnosticsSchema.parse(response.diagnostics);
      const result: ActionResult = {
        actionRunId,
        status: run.status,
        run,
        outputs: [],
        ...(diagnostics ? { diagnostics } : {}),
      };
      if (run.status === "succeeded") {
        result.outputs = await Promise.all(
          run.outputContract.map(async (port) => {
            const output = object(
              await generators.getOutputCommit(
                projectId,
                actionRunId,
                port.slot,
              ),
            );
            const reference = AssetRevisionRefSchema.parse(
              object(output.commit).asset,
            );
            const value =
              reference.kind === "media"
                ? await get(
                    `${projectPath(projectId)}/assets/${encodeURIComponent(reference.projectAssetId)}`,
                  )
                : publicDocumentValue(
                    await documents.getRevision(
                      projectId,
                      reference.documentAssetId,
                      reference.revisionId,
                    ),
                  );
            return { slot: port.slot, reference, value };
          }),
        );
        return result;
      }
      if (run.status === "failed")
        return {
          ...result,
          next:
            diagnostics?.failures.map((failure) => failure.message).join(" ") ||
            "Inspect this Run's failure before submitting new work.",
        };
      if (Date.now() >= deadline)
        return {
          ...result,
          next: `Continue waiting on Action Run ${actionRunId}; do not resubmit.`,
        };
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now()))),
      );
    }
  }
  async function invoke(
    projectId: string,
    input: ActionInvocation,
  ): Promise<ActionResult> {
    validateWait(input.waitMs);
    const matches = candidates(await definitions(projectId)).filter(
      (item) => item.key === input.action || item.shortName === input.action,
    );
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? `Action is ambiguous; use one of: ${matches.map((m) => m.key).join(", ")}`
          : `Action ${input.action} not found in this project; list its installed Actions first.`,
      );
    const { definition, action } = matches[0]!;
    validateValues(definition.stateSchema, input.state ?? {}, "state");
    validateValues(
      action.parametersSchema,
      input.parameters ?? {},
      "parameters",
    );
    const inputs = { ...input.inputs };
    const ports = [...definition.persistentInputs, ...action.invocationInputs];
    if (input.assetId) {
      if (ports.length !== 1 || inputs[ports[0]!.slot] !== undefined)
        throw new Error(
          "Use named inputs when the Action has multiple input slots or already specifies its source.",
        );
      inputs[ports[0]!.slot] = input.assetId;
    }
    for (const slot of Object.keys(inputs))
      if (!ports.some((port) => port.slot === slot))
        throw new Error(`Unknown input slot ${slot}`);
    const persistentInputRefs = inputRefs(definition.persistentInputs, inputs);
    const invocationInputRefs = inputRefs(action.invocationInputs, inputs);
    const actionRunId = input.requestId ?? crypto.randomUUID();
    const generatorId = `operation:${actionRunId}`;
    const generatorRevisionId = `${generatorId}:r1`;
    try {
      await generators.createGenerator(projectId, {
        generatorId,
        generatorRevisionId,
        pluginId: definition.pluginId,
        definitionId: definition.definitionId,
        state: input.state ?? {},
        persistentInputRefs,
      });
      await generators.submitActionRun(projectId, generatorId, action.id, {
        actionRunId,
        generatorRevisionId,
        parameters: input.parameters ?? {},
        invocationInputRefs,
        ...(input.providerAccountId
          ? { providerAccountId: input.providerAccountId }
          : {}),
        canvasPlacement: {
          canvasId: input.canvasId ?? "main",
          nodeId: `operation:${actionRunId}`,
          label: input.label ?? `${definition.definitionId}.${action.id}`,
        },
      });
      return await wait(projectId, actionRunId, { waitMs: input.waitMs });
    } catch (error) {
      // A timed-out HTTP response is not proof that admission failed. Keep its
      // stable identity so callers can inspect or replay this exact request.
      if (error instanceof Error) {
        const recovery = `Inspect ${actionRunId}; replay with requestId=${actionRunId} only if admission is incomplete.`;
        Object.assign(error, { actionRunId, recovery });
        error.message = `${error.message} ${recovery}`;
      }
      throw error;
    }
  }
  return { list, invoke, wait };
}
