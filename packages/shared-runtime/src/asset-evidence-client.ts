import {
  createDocumentClient,
  type DocumentRequest,
} from "./document-client.js";
import {
  MediaObservationSchema,
  MediaOperationTraceSchema,
  type DocumentAttachment,
  type DocumentAssetRevisionRef,
  type DocumentRevisionSourceRef,
  type MediaObservation,
} from "@clash/shared-types";

export interface RecordMediaOperationInput {
  title: string;
  detail: string;
  sources: string[];
  outputs: string[];
  recordId?: string;
}
export interface RecordMediaObservationInput {
  assetId: string;
  body: MediaObservation;
  recordId?: string;
}
export interface RecordedAssetEvidence {
  recordId: string;
  document: DocumentAssetRevisionRef;
  attachments: DocumentAttachment[];
}
export class AssetEvidenceRecordingError extends Error {
  override name = "AssetEvidenceRecordingError";
  constructor(
    readonly recordId: string,
    readonly document: DocumentAssetRevisionRef,
    cause: unknown,
  ) {
    super(
      `Could not finish saving external evidence. Retry with recordId ${JSON.stringify(recordId)}. ${cause instanceof Error ? cause.message : "The Host request failed."}`,
      { cause },
    );
  }
}
function identity(value: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("Evidence requires nonempty asset and record identities.");
  return value.trim();
}

/** Records external work using the existing Document authority. It never runs detail text. */
export function createAssetEvidenceClient(request: DocumentRequest) {
  const documents = createDocumentClient(request);
  async function record(
    projectId: string,
    input: {
      kind: string;
      body: unknown;
      recordId?: string;
      sourceRefs: DocumentRevisionSourceRef[];
      targets: string[];
    },
  ): Promise<RecordedAssetEvidence> {
    const recordId = identity(input.recordId ?? crypto.randomUUID());
    const document: DocumentAssetRevisionRef = {
      kind: "document",
      documentAssetId: `${input.kind}:${recordId}`,
      revisionId: `${input.kind}:${recordId}:r1`,
    };
    // Deterministic identities allow replay after an attachment request failed.
    // The Host compares existing immutable content and refuses changed retries.
    try {
      await documents.create(projectId, {
        documentAssetId: document.documentAssetId,
        revisionId: document.revisionId,
        documentKind: input.kind,
        schemaVersion: 1,
        body: input.body,
        sourceRefs: input.sourceRefs,
      });
      const observed = await documents.getRevision(
        projectId,
        document.documentAssetId,
        document.revisionId,
      );
      const attachments: DocumentAttachment[] = [];
      for (const target of input.targets) {
        const result = await documents.attach(
          projectId,
          {
            id: `${document.revisionId}:asset:${target}`,
            slot: input.kind,
            target: { kind: "project-asset", projectAssetId: target },
            document,
          },
          observed.readToken,
        );
        attachments.push(result.attachment);
      }
      return { recordId, document, attachments };
    } catch (cause) {
      throw new AssetEvidenceRecordingError(recordId, document, cause);
    }
  }
  return {
    async recordTrace(
      projectId: string,
      input: RecordMediaOperationInput,
    ): Promise<RecordedAssetEvidence> {
      const sources = [...new Set(input.sources.map(identity))];
      const outputs = [...new Set(input.outputs.map(identity))];
      if (!sources.length || !outputs.length)
        throw new Error(
          "An external operation record requires source and output Assets.",
        );
      return record(projectId, {
        kind: "media.operation-trace",
        body: MediaOperationTraceSchema.parse({
          title: input.title,
          detail: input.detail,
        }),
        recordId: input.recordId,
        sourceRefs: [
          ...sources.map((projectAssetId) => ({
            slot: "source",
            target: { kind: "media" as const, projectAssetId },
          })),
          ...outputs.map((projectAssetId) => ({
            slot: "output",
            target: { kind: "media" as const, projectAssetId },
          })),
        ],
        targets: outputs,
      });
    },
    async recordObservation(
      projectId: string,
      input: RecordMediaObservationInput,
    ): Promise<RecordedAssetEvidence> {
      const assetId = identity(input.assetId);
      return record(projectId, {
        kind: "media.observation",
        body: MediaObservationSchema.parse(input.body),
        recordId: input.recordId,
        sourceRefs: [
          {
            slot: "source",
            target: { kind: "media", projectAssetId: assetId },
          },
        ],
        targets: [assetId],
      });
    },
  };
}
