import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { projectGeneratorRequestContract, CreateProjectGeneratorRequestSchema, AdvanceProjectGeneratorRequestSchema, SubmitGeneratorActionRequestSchema } from "./generator-requests.js";

describe("Generator request disclosure", () => {
  const state = { modelId: "model", prompt: "Scene", params: { nested: [null, { enabled: true, strength: 0.5 }] } };
  const media = { slot: "image", itemKey: "subject", target: { kind: "media", projectAssetId: "asset" } };
  const document = { slot: "text", itemKey: "script", target: { kind: "document", documentAssetId: "script", revisionId: "saved" } };
  it.each([
    { operation: "create", validator: CreateProjectGeneratorRequestSchema, input: { generatorId: "g", generatorRevisionId: "r", pluginId: "plugin", definitionId: "video", state, persistentInputRefs: [media], placement: { canvasId: "main", nodeId: "copy", sourceNodeId: "source" } } },
    { operation: "advance", validator: AdvanceProjectGeneratorRequestSchema, input: { expectedHeadRevisionId: "r", generatorRevisionId: "r2", state, persistentInputRefs: [media], canvasInputConnections: [{ canvasId: "main", sourceNodeId: "source", targetNodeId: "target", asset: { kind: "media" as const, projectAssetId: "asset" } }] } },
    { operation: "advance", validator: AdvanceProjectGeneratorRequestSchema, input: { expectedHeadRevisionId: "r", generatorRevisionId: "r2", state, persistentInputRefs: [document], canvasInputConnections: [{ canvasId: "main", sourceNodeId: "source", targetNodeId: "target", asset: document.target }] } },
    { operation: "submit", validator: SubmitGeneratorActionRequestSchema, input: { actionRunId: "run", generatorRevisionId: "r", providerAccountId: "account", parameters: { nested: [null, { enabled: true }] }, invocationInputRefs: [media] } },
  ])("$operation contract accepts valid nested requests and rejects missing revision identity", ({ operation, validator, input }) => {
    const validate = new Ajv({ strict: false }).compile(projectGeneratorRequestContract(operation).inputSchema);
    expect(validator.safeParse(input).success).toBe(true);
    expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
    const invalid = { ...input, generatorRevisionId: undefined };
    expect(validator.safeParse(invalid).success).toBe(false);
    expect(validate(invalid)).toBe(false);
    const extra = { ...input, unauthorizedField: true };
    expect(validator.safeParse(extra).success).toBe(false);
    expect(validate(extra)).toBe(false);
  });
});
