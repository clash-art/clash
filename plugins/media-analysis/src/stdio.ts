import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assemblePluginModule,
  defineActionExecutor,
  servePluginStdio,
  type ExecutorContext,
  type ExecutorStep,
} from "@clash/action-sdk";
import {
  ExecutableMediaAnalysisReferenceSchema,
  ExecutableMediaAnalysisResultSchema,
  ExecutablePluginInvocationSchema,
  GeneratorDefinitionSpecSchema,
  MEDIA_ANALYSIS_DOCUMENT_KIND_BY_CATEGORY,
  MediaAnalysisCategorySchema,
  MediaAnalysisDocumentSchemas,
  type ExecutableMediaAnalysisReference,
  type ExecutablePluginInvocation,
  type ExecutablePluginJsonValue,
  type MediaAnalysisCategory,
} from "@clash/shared-types/executable-plugin";

export const MEDIA_ANALYSIS_ACTION_ID = "analyze";
const manifestDir = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const definitionDocument = JSON.parse(
  readFileSync(join(manifestDir, "generators/media-analysis.json"), "utf8"),
) as { spec: unknown };
export const MEDIA_ANALYSIS_DEFINITION = GeneratorDefinitionSpecSchema.parse(
  definitionDocument.spec,
);
const action = MEDIA_ANALYSIS_DEFINITION.actions.find(
  (candidate) => candidate.id === MEDIA_ANALYSIS_ACTION_ID,
)!;
const outputsBySlot = new Map(action.outputs.map((output) => [output.slot, output]));

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function sourceReference(
  invocation: ExecutablePluginInvocation,
): ExecutableMediaAnalysisReference {
  if (invocation.input.references.length !== 1) {
    throw new Error("Media analysis requires exactly one frozen media source reference.");
  }
  const parsed = ExecutableMediaAnalysisReferenceSchema.safeParse(
    invocation.input.references[0],
  );
  if (!parsed.success || parsed.data.slot !== "source") {
    throw new Error("Media analysis requires exactly one frozen media source reference.");
  }
  return parsed.data;
}

function requiredString(values: Record<string, ExecutablePluginJsonValue>, key: string): string {
  const value = values[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Media analysis requires ${key}.`);
  }
  return value.trim();
}

function selectedCategories(
  values: Record<string, ExecutablePluginJsonValue>,
  sourceKind: "image" | "video" | "audio",
): MediaAnalysisCategory[] {
  const parsed = MediaAnalysisCategorySchema.array().min(1).safeParse(values.categories);
  if (!parsed.success) throw new Error("Media analysis requires declared categories.");
  if (new Set(parsed.data).size !== parsed.data.length) {
    throw new Error("Media analysis categories must be unique.");
  }
  for (const category of parsed.data) {
    const declared = outputsBySlot.get(category);
    if (!declared?.sourceMediaKinds?.includes(sourceKind)) {
      throw new Error(`Media analysis category ${category} is not applicable to ${sourceKind}.`);
    }
  }
  return parsed.data;
}

async function analyzeStep(
  input: unknown,
  context: ExecutorContext,
): Promise<ExecutorStep> {
  const invocation = ExecutablePluginInvocationSchema.parse(input);
  const reference = sourceReference(invocation);
  const values = invocation.input.values;
  const customPrompt = values.prompt === undefined ? undefined : requiredString(values, "prompt");
  const categories = selectedCategories(
    customPrompt ? { ...values, categories: ["description"] } : values,
    reference.asset.kind,
  );
  const source = values.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Media analysis requires frozen source identity.");
  }
  if (
    source.projectAssetId !== reference.asset.assetId ||
    source.kind !== reference.asset.kind ||
    typeof source.resourceHash !== "string"
  ) {
    throw new Error("Media analysis source identity does not match its frozen reference.");
  }
  const modelId = requiredString(values, "modelId");
  const generatorRevisionId = requiredString(values, "generatorRevisionId");
  const actionRunId = requiredString(values, "actionRunId");
  const documents = [];

  for (const category of categories) {
    const declared = outputsBySlot.get(category)!;
    const prompt = customPrompt ?? declared.prompt!;
    const promptVersion = declared.promptVersion!;
    const analyzed = ExecutableMediaAnalysisResultSchema.parse(
      await context.hostTools.mediaAnalyze({
        reference,
        modelId,
        category,
        prompt,
        promptVersion,
        ...(customPrompt ? { responseFormat: "text" as const } : {}),
      }),
    );
    if (analyzed.status !== "completed") {
      throw new Error("Media analysis Host route must complete synchronously.");
    }
    const resultHash = digest(analyzed.result);
    const withoutBodyHash = {
      schemaVersion: 1 as const,
      source,
      modelId,
      provider: analyzed.provider,
      route: analyzed.route,
      underlyingModel: analyzed.underlyingModel,
      category,
      promptVersion,
      generatorRevisionId,
      actionRunId,
      resultHash,
      result: analyzed.result,
    };
    const body = {
      ...withoutBodyHash,
      bodyHash: digest(withoutBodyHash),
    };
    MediaAnalysisDocumentSchemas[category].parse(body);
    documents.push(
      await context.document({
        slot: category,
        documentKind: MEDIA_ANALYSIS_DOCUMENT_KIND_BY_CATEGORY[category],
        schemaVersion: 1,
        body: body as ExecutablePluginJsonValue,
      }),
    );
  }
  return { status: "completed", outputs: documents };
}

export const CONTRIBUTIONS = {
  [MEDIA_ANALYSIS_ACTION_ID]: defineActionExecutor({ submit: analyzeStep }),
};

export const plugin = assemblePluginModule({
  manifestDir,
  contributes: CONTRIBUTIONS,
});

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  void servePluginStdio(plugin).done;
}
