import { expect, it } from "vitest";
import { ProjectActionRunSchema } from "@clash/shared-types";
import { createDurableRunRecord } from "@clash/shared-runtime";
import { readLocalGeneratorRunDiagnostics } from "./local-generator-run-diagnostics.js";

it("explains the observed media-analysis JSON parse failure without exposing model output", async () => {
  const binding = {
    pluginId: "clash.media-analysis",
    version: "0.1.0",
    exportId: "analyze",
    schemaHash: `sha256:${"a".repeat(64)}`,
  };
  const outputContract = [
    {
      slot: "actions-events",
      assetType: {
        kind: "document",
        documentKind: "media.analysis.actions-events",
        schemaVersion: 1,
      },
      cardinality: { minItems: 1, maxItems: 1 },
    },
  ];
  const run = ProjectActionRunSchema.parse({
    actionRunId: "analysis",
    generatorRevision: {
      generatorId: "analysis-generator",
      generatorRevisionId: "revision",
    },
    actionId: "analyze",
    executor: binding,
    invocationFingerprint: `sha256:${"b".repeat(64)}`,
    parameters: {},
    invocationInputRefs: [],
    outputContract,
    status: "failed",
  });
  const task = createDurableRunRecord({
    actionRunId: run.actionRunId,
    outputSlot: "actions-events",
    owner: { realm: "local", id: "local-api" },
    createdAt: 1,
    deadlineAt: 2,
    executorInput: {
      schemaVersion: 1,
      targetKind: "generator-action",
      binding,
      actionId: "analyze",
      actor: { kind: "system" },
      generatorOutputContract: outputContract,
      kind: "text",
      projectId: "project",
      input: { values: {}, references: [] },
    },
  });
  task.phase = "failed";
  // Captured from acceptance-native-analysis-3; no claim about the unretained response text.
  task.failure = {
    code: "execution_failed",
    message: "Media analysis model did not return valid JSON.",
    retryable: false,
    requestState: "unknown",
  };
  const diagnostics = await readLocalGeneratorRunDiagnostics({
    projectId: "project",
    ownerId: "local-api",
    run,
    journal: { load: async () => task },
  });
  expect(diagnostics.failures[0]).toMatchObject({
    code: "execution_failed",
    phase: "failed",
    retryable: false,
  });
  expect(diagnostics.failures[0]?.message).toMatch(/requires JSON/);
  expect(diagnostics.failures[0]?.message).toMatch(
    /custom prompt.*free-form description/,
  );
  task.failure.message += " secret-token model-response";
  const unrelated = await readLocalGeneratorRunDiagnostics({
    projectId: "project",
    ownerId: "local-api",
    run,
    journal: { load: async () => task },
  });
  expect(JSON.stringify(unrelated)).not.toMatch(/secret-token|model-response/);
});
