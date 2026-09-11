import { isDeepStrictEqual } from "node:util";

import type { LoroDoc } from "loro-crdt";

import {
  commitActionRunOutcome,
  createProjectDocumentAsset,
  ensureActionRunRequest,
  ensureDocumentAttachment,
  ensureOutputCommit,
  markActionRunStarted,
  readOutputCommit,
  readDocumentAssetRevision,
  readProjectAsset,
  readProjectActionRun,
  readProjectDocumentAsset,
  resolveOutputCommitAssetType,
  type ActionRunRequest,
  type DocumentAssetRevision,
  type OutputCommit,
  type ProjectAssetEntry,
  type ProjectActionRun,
  type ProjectDocumentAsset,
  type ProjectGeneratorMutationError,
} from "@clash/shared-types";

import {
  createLocalDurableRun,
  type LocalDurableRunCreateCommand,
} from "./durable-run-coordinator.js";
import type { SqliteDurableRunJournal } from "./durable-run-journal.js";
import { publishLocalProjectAssetWithBindings } from "./local-project-assets.js";

export interface LocalGeneratorMediaPublication {
  entry: ProjectAssetEntry;
  commit: OutputCommit;
  run: ProjectActionRun;
  changed: boolean;
}

export interface LocalGeneratorFailurePublication {
  run: ProjectActionRun;
  changed: boolean;
  winnerPreserved: boolean;
}

export interface LocalGeneratorDocumentPublication {
  asset: ProjectDocumentAsset;
  revision: DocumentAssetRevision;
  commit: OutputCommit;
  run: ProjectActionRun;
  changed: boolean;
}

export interface LocalGeneratorRunBridge {
  enqueue(input: {
    doc: LoroDoc;
    request: ActionRunRequest;
    command: LocalDurableRunCreateCommand;
    checkpoint: () => Promise<void>;
  }): Promise<ProjectActionRun>;
  enqueueBatch(input: {
    doc: LoroDoc;
    entries: readonly {
      request: ActionRunRequest;
      command: LocalDurableRunCreateCommand;
    }[];
    checkpoint: () => Promise<void>;
  }): Promise<ProjectActionRun[]>;
  projectRunning(input: {
    doc: LoroDoc;
    identity: { actionRunId: string; outputSlot: string };
    checkpoint: () => Promise<void>;
  }): Promise<ProjectActionRun>;
  publishMediaSuccess(input: {
    doc: LoroDoc;
    actionRunId: string;
    outputSlot: string;
    entry: ProjectAssetEntry;
    checkpoint: () => Promise<void>;
  }): Promise<LocalGeneratorMediaPublication>;
  publishDocumentSuccess(input: {
    doc: LoroDoc;
    actionRunId: string;
    outputSlot: string;
    revision: DocumentAssetRevision;
    checkpoint: () => Promise<void>;
  }): Promise<LocalGeneratorDocumentPublication>;
  publishDocumentBatchSuccess(input: {
    doc: LoroDoc;
    actionRunId: string;
    outputs: readonly {
      outputSlot: string;
      revision: DocumentAssetRevision;
    }[];
    checkpoint: () => Promise<void>;
  }): Promise<{
    publications: LocalGeneratorDocumentPublication[];
    run: ProjectActionRun;
    changed: boolean;
  }>;
  publishFailure(input: {
    doc: LoroDoc;
    actionRunId: string;
    checkpoint: () => Promise<void>;
  }): Promise<LocalGeneratorFailurePublication>;
  finalizeSuccess(input: {
    doc: LoroDoc;
    actionRunId: string;
    checkpoint: () => Promise<void>;
  }): Promise<{ run: ProjectActionRun; changed: boolean }>;
}

function generatorMutationFailure(error: ProjectGeneratorMutationError): never {
  throw new Error(`${error.code}: ${error.message}`);
}

function completeSingleOutputRun(
  doc: LoroDoc,
  run: ProjectActionRun,
): { run: ProjectActionRun; changed: boolean } {
  if (run.outputContract.length !== 1) return { run, changed: false };
  const outcome = commitActionRunOutcome(doc, {
    actionRunId: run.actionRunId,
    status: "succeeded",
  });
  if (!outcome.ok) generatorMutationFailure(outcome.error);
  return { run: outcome.run, changed: outcome.changed };
}

function applyMediaSuccess(
  doc: LoroDoc,
  input: {
    actionRunId: string;
    outputSlot: string;
    entry: ProjectAssetEntry;
  },
): LocalGeneratorMediaPublication {
  const run = readProjectActionRun(doc, input.actionRunId);
  const port = run?.outputContract.find(
    (candidate) => candidate.slot === input.outputSlot,
  );
  if (
    !run ||
    !port ||
    port.assetType.kind !== "media" ||
    port.assetType.mediaKind !== input.entry.kind
  ) {
    throw new Error(
      "The published media Asset does not match the Generator Action Run output contract.",
    );
  }
  const existingCommit = readOutputCommit(doc, {
    actionRunId: input.actionRunId,
    outputSlot: input.outputSlot,
  });
  if (existingCommit) {
    if (existingCommit.asset.kind !== "media") {
      throw new Error(
        "The existing Generator output winner is not a media Asset.",
      );
    }
    const existingProjectAssetId = existingCommit.asset.projectAssetId;
    const existingEntry = readProjectAsset(doc, existingProjectAssetId);
    if (!existingEntry) {
      throw new Error(
        "The existing Generator output winner is missing its Project Asset.",
      );
    }
    const completed = completeSingleOutputRun(doc, run);
    return {
      entry: existingEntry,
      commit: existingCommit,
      run: completed.run,
      changed: completed.changed,
    };
  }

  const publication = publishLocalProjectAssetWithBindings(doc, input.entry, []);
  const output = ensureOutputCommit(
    doc,
    {
      actionRunId: input.actionRunId,
      outputSlot: input.outputSlot,
      asset: { kind: "media", projectAssetId: input.entry.id },
    },
    resolveOutputCommitAssetType,
  );
  if (!output.ok) generatorMutationFailure(output.error);
  const completed = completeSingleOutputRun(doc, run);
  return {
    entry: publication.entry,
    commit: output.commit,
    run: completed.run,
    changed: publication.changed || output.changed || completed.changed,
  };
}

function applyFailure(
  doc: LoroDoc,
  actionRunId: string,
): LocalGeneratorFailurePublication {
  const run = readProjectActionRun(doc, actionRunId);
  if (!run) {
    throw new Error(
      `ACTION_RUN_NOT_FOUND: Action Run ${actionRunId} not found.`,
    );
  }
  const hasWinner = run.outputContract.some(
    (output) =>
      readOutputCommit(doc, {
        actionRunId,
        outputSlot: output.slot,
      }) !== null,
  );
  const status =
    hasWinner || run.status === "succeeded" ? "succeeded" : "failed";
  const outcome = commitActionRunOutcome(doc, { actionRunId, status });
  if (!outcome.ok) generatorMutationFailure(outcome.error);
  return {
    run: outcome.run,
    changed: outcome.changed,
    winnerPreserved: status === "succeeded",
  };
}

function applyDocumentSuccess(
  doc: LoroDoc,
  input: {
    actionRunId: string;
    outputSlot: string;
    revision: DocumentAssetRevision;
  },
): LocalGeneratorDocumentPublication {
  const run = readProjectActionRun(doc, input.actionRunId);
  const port = run?.outputContract.find(
    (candidate) => candidate.slot === input.outputSlot,
  );
  if (
    !run ||
    !port ||
    port.assetType.kind !== "document" ||
    port.assetType.documentKind !== input.revision.documentKind ||
    port.assetType.schemaVersion !== input.revision.schemaVersion ||
    input.revision.producer.kind !== "action-run" ||
    input.revision.producer.actionRunId !== input.actionRunId
  ) {
    throw new Error(
      "The published Document revision does not match the Generator Action Run output contract and producer.",
    );
  }

  const existingCommit = readOutputCommit(doc, {
    actionRunId: input.actionRunId,
    outputSlot: input.outputSlot,
  });
  if (existingCommit) {
    if (existingCommit.asset.kind !== "document") {
      throw new Error(
        "The existing Generator output winner is not a Document Asset.",
      );
    }
    const asset = readProjectDocumentAsset(
      doc,
      existingCommit.asset.documentAssetId,
    );
    const revision = readDocumentAssetRevision(doc, existingCommit.asset);
    if (!asset || !revision) {
      throw new Error(
        "The existing Generator Document output winner is missing its immutable revision.",
      );
    }
    const completed = completeSingleOutputRun(doc, run);
    return {
      asset,
      revision,
      commit: existingCommit,
      run: completed.run,
      changed: completed.changed,
    };
  }

  const document = createProjectDocumentAsset(doc, input.revision);
  if (!document.ok) {
    throw new Error(`${document.error.code}: ${document.error.message}`);
  }
  const output = ensureOutputCommit(
    doc,
    {
      actionRunId: input.actionRunId,
      outputSlot: input.outputSlot,
      asset: {
        kind: "document",
        documentAssetId: input.revision.documentAssetId,
        revisionId: input.revision.id,
      },
    },
    resolveOutputCommitAssetType,
  );
  if (!output.ok) generatorMutationFailure(output.error);
  let attachmentChanged = false;
  for (const ref of input.revision.sourceRefs) {
    if (!("kind" in ref.target) || ref.target.kind !== "media") continue;
    const attachment = ensureDocumentAttachment(doc, {
      id: `attachment:${input.revision.id}:${ref.target.projectAssetId}`,
      target: {
        kind: "project-asset",
        projectAssetId: ref.target.projectAssetId,
      },
      slot: input.outputSlot,
      document: {
        kind: "document",
        documentAssetId: input.revision.documentAssetId,
        revisionId: input.revision.id,
      },
    });
    if (!attachment.ok) {
      throw new Error(`${attachment.error.code}: ${attachment.error.message}`);
    }
    attachmentChanged ||= attachment.changed;
  }
  const completed = completeSingleOutputRun(doc, run);
  return {
    asset: document.asset,
    revision: document.revision,
    commit: output.commit,
    run: completed.run,
    changed:
      document.changed || output.changed || attachmentChanged || completed.changed,
  };
}

export function createLocalGeneratorRunBridge(options: {
  now?: () => number;
  ownerId: string;
  journal: SqliteDurableRunJournal;
}): LocalGeneratorRunBridge {
  function validatePair(request: ActionRunRequest, command: LocalDurableRunCreateCommand): void {
    if (command.actionRunId !== request.actionRunId || !request.outputContract.some((output) => output.slot === command.outputSlot))
      throw new Error("A Generator Action Run request and its private durable task must have the same Run and output identity.");
    if (command.executor.targetKind !== "generator-action" || command.executor.actionId !== request.actionId || !isDeepStrictEqual(command.executor.generatorOutputContract, request.outputContract))
      throw new Error("A Generator v2 Run requires a generator-action task frozen from its exact Action id and output contract.");
    if (!isDeepStrictEqual(command.executor.binding, request.executor))
      throw new Error("A Generator v2 Run requires a private task frozen from its exact public executor.");
    if (command.executor.publicOwner?.actionId !== request.generatorRevision.generatorId || command.executor.publicOwner.actionRevisionId !== request.generatorRevision.generatorRevisionId)
      throw new Error("A Generator v2 task public owner must identify the exact Generator revision.");
  }

  return {
    async enqueue(input) {
      const [run] = await this.enqueueBatch({
        doc: input.doc,
        entries: [{ request: input.request, command: input.command }],
        checkpoint: input.checkpoint,
      });
      return run!;
    },
    async enqueueBatch(input) {
      if (input.entries.length === 0) return [];

      // The fork validates the complete public write set, including duplicate
      // identities within this batch, before either durable authority changes.
      const validationDoc = input.doc.fork();
      for (const entry of input.entries) {
        validatePair(entry.request, entry.command);
        const requested = ensureActionRunRequest(validationDoc, entry.request);
        if (!requested.ok) generatorMutationFailure(requested.error);
        if (requested.run.status === "succeeded" || requested.run.status === "failed") continue;
        const existing = await options.journal.load({ actionRunId: entry.command.actionRunId, outputSlot: entry.command.outputSlot });
        if (existing) {
          // This path performs the coordinator's canonical frozen-input
          // compatibility check; because the identity exists it cannot write.
          await createLocalDurableRun({ ownerId: options.ownerId, journal: options.journal, ...(options.now ? { clock: { now: options.now } } : {}), command: entry.command });
        }
      }

      let publicChanged = false;
      const admitted: Array<{ request: ActionRunRequest; command: LocalDurableRunCreateCommand }> = [];
      for (const entry of input.entries) {
        const requested = ensureActionRunRequest(input.doc, entry.request);
        if (!requested.ok) generatorMutationFailure(requested.error);
        publicChanged ||= requested.changed;
        if (requested.run.status !== "succeeded" && requested.run.status !== "failed") admitted.push(entry);
      }
      if (publicChanged) await input.checkpoint();

      // Do not project any Run as running until every private task is durable.
      // A retry reuses compatible tasks and repairs only the missing suffix.
      for (const entry of admitted) {
        await createLocalDurableRun({ ownerId: options.ownerId, journal: options.journal, ...(options.now ? { clock: { now: options.now } } : {}), command: entry.command });
      }
      let runningChanged = false;
      for (const entry of admitted) {
        const before = readProjectActionRun(input.doc, entry.request.actionRunId);
        const started = markActionRunStarted(input.doc, entry.request.actionRunId);
        if (!started.ok) generatorMutationFailure(started.error);
        runningChanged ||= before?.status !== started.run.status;
      }
      if (runningChanged) await input.checkpoint();
      return input.entries.map((entry) => readProjectActionRun(input.doc, entry.request.actionRunId)!);
    },
    async projectRunning(input) {
      const task = await options.journal.load(input.identity);
      const executorInput = task?.executorInput;
      if (
        !task ||
        task.owner.realm !== "local" ||
        task.owner.id !== options.ownerId ||
        !executorInput ||
        typeof executorInput !== "object" ||
        Array.isArray(executorInput) ||
        executorInput.targetKind !== "generator-action"
      ) {
        throw new Error(
          `Generator Action Run ${input.identity.actionRunId}/${input.identity.outputSlot} has no owner-private task on this Host.`,
        );
      }
      const started = markActionRunStarted(
        input.doc,
        input.identity.actionRunId,
      );
      if (!started.ok) generatorMutationFailure(started.error);
      await input.checkpoint();
      return started.run;
    },
    async publishMediaSuccess(input) {
      // Validate the complete write set on an isolated replica. The live Host
      // remains the only writer, so applying the same set below is one Project
      // mutation and cannot strand a prefix on a contract conflict.
      applyMediaSuccess(input.doc.fork(), input);
      const published = applyMediaSuccess(input.doc, input);
      await input.checkpoint();
      return published;
    },
    async publishDocumentBatchSuccess(input) {
      const apply = (doc: LoroDoc) => {
        const publications = input.outputs.map((output) =>
          applyDocumentSuccess(doc, {
            actionRunId: input.actionRunId,
            outputSlot: output.outputSlot,
            revision: output.revision,
          }),
        );
        const outcome = commitActionRunOutcome(doc, {
          actionRunId: input.actionRunId,
          status: "succeeded",
        });
        if (!outcome.ok) generatorMutationFailure(outcome.error);
        return {
          publications,
          run: outcome.run,
          changed:
            publications.some((publication) => publication.changed) ||
            outcome.changed,
        };
      };
      apply(input.doc.fork());
      const published = apply(input.doc);
      if (published.changed) await input.checkpoint();
      return published;
    },
    async publishDocumentSuccess(input) {
      applyDocumentSuccess(input.doc.fork(), input);
      const published = applyDocumentSuccess(input.doc, input);
      await input.checkpoint();
      return published;
    },
    async finalizeSuccess(input) {
      const apply = (doc: LoroDoc) => {
        const outcome = commitActionRunOutcome(doc, {
          actionRunId: input.actionRunId,
          status: "succeeded",
        });
        if (!outcome.ok) generatorMutationFailure(outcome.error);
        return { run: outcome.run, changed: outcome.changed };
      };
      apply(input.doc.fork());
      const finalized = apply(input.doc);
      if (finalized.changed) await input.checkpoint();
      return finalized;
    },
    async publishFailure(input) {
      applyFailure(input.doc.fork(), input.actionRunId);
      const published = applyFailure(input.doc, input.actionRunId);
      await input.checkpoint();
      return published;
    },
  };
}
