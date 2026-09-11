import { LoroMap, type LoroDoc } from "loro-crdt";

import { agentReadToken } from "./agent-read-proof.js";
import {
  ActionRunOutcomeSchema,
  ActionRunRequestSchema,
  GeneratorRevisionRefSchema,
  GeneratorRevisionSchema,
  OutputCommitSchema,
  ProjectActionRunSchema,
  ProjectGeneratorHeadSchema,
  ProjectGeneratorSchema,
  type ActionRunOutcome,
  type ActionRunRequest,
  type GeneratorRevision,
  type GeneratorRevisionRef,
  type OutputCommit,
  type ProjectActionRun,
  type ProjectGenerator,
  type ProjectGeneratorHead,
} from "./generator-v2.js";
import type { OutputCommitAssetTypeResolver } from "./project-output-assets.js";

/**
 * Host-owned Project Loro authority for Generator identity, immutable
 * revisions, and Action Run facts. Synced peers may read and replicate these
 * containers, but mutation entry points must be serialized by the local Host;
 * raw peer writes cannot provide the insert-or-compare guarantees below.
 */

export const GENERATOR_SCHEMA_CONTAINER = "generatorSchema";
export const PROJECT_GENERATORS_CONTAINER = "projectGenerators";
export const GENERATOR_REVISIONS_CONTAINER = "generatorRevisions";
export const GENERATOR_ACTION_RUNS_CONTAINER = "generatorActionRuns";
export const GENERATOR_OUTPUT_COMMITS_CONTAINER = "generatorOutputCommits";
export const GENERATOR_AUTHORITY_VERSION = 1;

const AUTHORITY_VERSIONS_KEY = "authorityVersions";

export type GeneratorAuthorityResult =
  | { ok: true; version: typeof GENERATOR_AUTHORITY_VERSION }
  | {
      ok: false;
      error: {
        code: "UNSUPPORTED_GENERATOR_AUTHORITY";
        message: string;
      };
    };

export type ProjectGeneratorMutationErrorCode =
  | "INVALID_PROJECT_GENERATOR"
  | "PROJECT_GENERATOR_EXISTS"
  | "PROJECT_GENERATOR_DELETED"
  | "PROJECT_GENERATOR_NOT_FOUND"
  | "GENERATOR_REVISION_ID_COLLISION"
  | "GENERATOR_FORK_SOURCE_NOT_FOUND"
  | "GENERATOR_FORK_FAMILY_MISMATCH"
  | "GENERATOR_FORK_REQUIRED"
  | "INVALID_ACTION_RUN_REQUEST"
  | "ACTION_RUN_EXECUTOR_MISMATCH"
  | "ACTION_RUN_NOT_FOUND"
  | "GENERATOR_REVISION_NOT_FOUND"
  | "ACTION_RUN_REQUEST_COLLISION"
  | "ACTION_RUN_OUTCOME_COLLISION"
  | "ACTION_RUN_TERMINAL"
  | "REQUIRED_OUTPUT_NOT_COMMITTED"
  | "INVALID_OUTPUT_COMMIT"
  | "OUTPUT_COMMIT_ID_COLLISION"
  | "STALE_GENERATOR_HEAD"
  | "UNSUPPORTED_GENERATOR_AUTHORITY";

export interface ProjectGeneratorMutationError {
  code: ProjectGeneratorMutationErrorCode;
  message: string;
  generatorId?: string;
  generatorRevisionId?: string;
  actionRunId?: string;
  outputSlot?: string;
}

export type CreateProjectGeneratorResult =
  | {
      ok: true;
      generator: ProjectGenerator;
      revision: GeneratorRevision;
      changed: boolean;
    }
  | { ok: false; error: ProjectGeneratorMutationError };

export type AdvanceProjectGeneratorHeadResult = CreateProjectGeneratorResult;

export interface ProjectGeneratorTombstone {
  state: "deleted";
  operationId: string;
  headRevisionId: string;
}

export type DeleteProjectGeneratorResult =
  | {
      ok: true;
      tombstone: ProjectGeneratorTombstone;
      changed: boolean;
    }
  | { ok: false; error: ProjectGeneratorMutationError };

export type ActionRunMutationResult =
  | { ok: true; run: ProjectActionRun; changed: boolean }
  | { ok: false; error: ProjectGeneratorMutationError };

export type OutputCommitMutationResult =
  | { ok: true; commit: OutputCommit; changed: boolean }
  | { ok: false; error: ProjectGeneratorMutationError };

function isLoroMap(value: unknown): value is LoroMap {
  return (
    value instanceof LoroMap ||
    Boolean(
      value &&
      typeof value === "object" &&
      typeof (value as { entries?: unknown }).entries === "function" &&
      typeof (value as { set?: unknown }).set === "function",
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function projectGeneratorTombstone(
  value: unknown,
): ProjectGeneratorTombstone | null {
  if (
    !isRecord(value) ||
    value.state !== "deleted" ||
    typeof value.operationId !== "string" ||
    !value.operationId.trim() ||
    typeof value.headRevisionId !== "string" ||
    !value.headRevisionId.trim() ||
    Object.keys(value).some(
      (key) => !["state", "operationId", "headRevisionId"].includes(key),
    )
  ) {
    return null;
  }
  return {
    state: "deleted",
    operationId: value.operationId,
    headRevisionId: value.headRevisionId,
  };
}

function sameImmutableFact(left: unknown, right: unknown): boolean {
  return (
    agentReadToken({ namespace: "generator-fact", subject: left }) ===
    agentReadToken({ namespace: "generator-fact", subject: right })
  );
}

function rawGeneratorAuthorityVersion(doc: LoroDoc): unknown {
  const facts = doc
    .getMap(GENERATOR_SCHEMA_CONTAINER)
    .get(AUTHORITY_VERSIONS_KEY);
  if (facts === undefined) return undefined;
  if (!isLoroMap(facts)) return facts;

  const versions: number[] = [];
  for (const [key, value] of facts.entries()) {
    const version = Number(key);
    if (
      value !== true ||
      !Number.isInteger(version) ||
      version < 1 ||
      String(version) !== key
    ) {
      return `invalid authority version fact ${key}`;
    }
    versions.push(version);
  }
  return versions.length === 0 ? undefined : Math.max(...versions);
}

export function generatorAuthorityVersion(doc: LoroDoc): number | undefined {
  const version = rawGeneratorAuthorityVersion(doc);
  return typeof version === "number" && Number.isInteger(version)
    ? version
    : undefined;
}

function mutationAuthorityError(
  doc: LoroDoc,
): ProjectGeneratorMutationError | undefined {
  const version = rawGeneratorAuthorityVersion(doc);
  if (version === undefined || version === GENERATOR_AUTHORITY_VERSION) {
    return undefined;
  }
  return {
    code: "UNSUPPORTED_GENERATOR_AUTHORITY",
    message: `Unsupported Generator authority version: ${String(version)}`,
  };
}

export function markGeneratorAuthority(doc: LoroDoc): GeneratorAuthorityResult {
  const current = rawGeneratorAuthorityVersion(doc);
  if (current !== undefined && current !== GENERATOR_AUTHORITY_VERSION) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_GENERATOR_AUTHORITY",
        message: `Unsupported Generator authority version: ${String(current)}`,
      },
    };
  }
  doc
    .getMap(GENERATOR_SCHEMA_CONTAINER)
    .ensureMergeableMap(AUTHORITY_VERSIONS_KEY)
    .set(String(GENERATOR_AUTHORITY_VERSION), true);
  return { ok: true, version: GENERATOR_AUTHORITY_VERSION };
}

export function readGeneratorRevision(
  doc: LoroDoc,
  input: GeneratorRevisionRef,
): GeneratorRevision | null {
  const parsedRef = GeneratorRevisionRefSchema.safeParse(input);
  if (!parsedRef.success) return null;
  const revisions = doc
    .getMap(GENERATOR_REVISIONS_CONTAINER)
    .get(parsedRef.data.generatorId);
  if (!isLoroMap(revisions)) return null;
  const parsed = GeneratorRevisionSchema.safeParse(
    revisions.get(parsedRef.data.generatorRevisionId),
  );
  if (
    !parsed.success ||
    parsed.data.generatorId !== parsedRef.data.generatorId
  ) {
    return null;
  }
  return parsed.data;
}

export function readProjectGenerator(
  doc: LoroDoc,
  generatorIdInput: string,
): ProjectGenerator | null {
  const generatorId = generatorIdInput.trim();
  if (!generatorId) return null;
  const raw = doc.getMap(PROJECT_GENERATORS_CONTAINER).get(generatorId);
  if (!isLoroMap(raw)) return null;
  if (raw.get("terminal") !== undefined) return null;
  const headValue = raw.get("head");
  if (!isRecord(headValue)) return null;
  const head = ProjectGeneratorHeadSchema.safeParse({
    id: generatorId,
    headRevisionId: headValue.revisionId,
  });
  if (!head.success) return null;
  const revision = readGeneratorRevision(doc, {
    generatorId,
    generatorRevisionId: head.data.headRevisionId,
  });
  if (!revision) return null;
  return ProjectGeneratorSchema.parse({
    ...head.data,
    definitionRef: revision.definitionRef,
  });
}

export function deleteProjectGenerator(
  doc: LoroDoc,
  input: {
    generatorId: string;
    expectedHeadRevisionId: string;
    operationId: string;
  },
): DeleteProjectGeneratorResult {
  const unsupported = mutationAuthorityError(doc);
  if (unsupported) return { ok: false, error: unsupported };
  const generatorId = input.generatorId.trim();
  const expectedHeadRevisionId = input.expectedHeadRevisionId.trim();
  const operationId = input.operationId.trim();
  if (!generatorId || !expectedHeadRevisionId || !operationId) {
    return {
      ok: false,
      error: {
        code: "INVALID_PROJECT_GENERATOR",
        message:
          "Generator deletion requires non-empty Generator, expected-head, and operation ids.",
        generatorId: generatorId || undefined,
      },
    };
  }
  const raw = doc.getMap(PROJECT_GENERATORS_CONTAINER).get(generatorId);
  if (!isLoroMap(raw)) {
    return {
      ok: false,
      error: {
        code: "PROJECT_GENERATOR_NOT_FOUND",
        message: `Project Generator ${generatorId} not found.`,
        generatorId,
      },
    };
  }
  const existingTerminalValue = raw.get("terminal");
  if (existingTerminalValue !== undefined) {
    const existingTerminal = projectGeneratorTombstone(existingTerminalValue);
    if (
      existingTerminal &&
      existingTerminal.operationId === operationId &&
      existingTerminal.headRevisionId === expectedHeadRevisionId
    ) {
      return { ok: true, tombstone: existingTerminal, changed: false };
    }
    return {
      ok: false,
      error: {
        code: "PROJECT_GENERATOR_DELETED",
        message: `Project Generator ${generatorId} is already deleted.`,
        generatorId,
      },
    };
  }
  const headValue = raw.get("head");
  if (
    !isRecord(headValue) ||
    typeof headValue.revisionId !== "string" ||
    headValue.revisionId !== expectedHeadRevisionId
  ) {
    return {
      ok: false,
      error: {
        code: "STALE_GENERATOR_HEAD",
        message: `Project Generator ${generatorId} changed after it was read.`,
        generatorId,
      },
    };
  }
  const tombstone: ProjectGeneratorTombstone = {
    state: "deleted",
    operationId,
    headRevisionId: expectedHeadRevisionId,
  };
  raw.set("terminal", tombstone);
  return { ok: true, tombstone, changed: true };
}

function actionRunFields(doc: LoroDoc, actionRunId: string): LoroMap | null {
  const value = doc.getMap(GENERATOR_ACTION_RUNS_CONTAINER).get(actionRunId);
  return isLoroMap(value) ? value : null;
}

export function readProjectActionRun(
  doc: LoroDoc,
  actionRunIdInput: string,
): ProjectActionRun | null {
  const actionRunId = actionRunIdInput.trim();
  if (!actionRunId) return null;
  const fields = actionRunFields(doc, actionRunId);
  if (!fields) return null;
  const request = ActionRunRequestSchema.safeParse(fields.get("request"));
  if (!request.success || request.data.actionRunId !== actionRunId) return null;
  const started = fields.get("started");
  if (started !== undefined && started !== true) return null;
  const rawOutcome = fields.get("outcome");
  const outcome =
    rawOutcome === undefined
      ? undefined
      : ActionRunOutcomeSchema.safeParse(rawOutcome);
  if (
    outcome !== undefined &&
    (!outcome.success || outcome.data.actionRunId !== actionRunId)
  ) {
    return null;
  }
  return ProjectActionRunSchema.parse({
    ...request.data,
    status: outcome?.data.status ?? (started === true ? "running" : "pending"),
  });
}

export function ensureActionRunRequest(
  doc: LoroDoc,
  requestInput: ActionRunRequest,
): ActionRunMutationResult {
  const unsupported = mutationAuthorityError(doc);
  if (unsupported) return { ok: false, error: unsupported };
  const request = ActionRunRequestSchema.safeParse(requestInput);
  if (!request.success) {
    return {
      ok: false,
      error: {
        code: "INVALID_ACTION_RUN_REQUEST",
        message:
          request.error.issues[0]?.message ?? "Invalid Action Run request.",
      },
    };
  }
  const generatorRevision = readGeneratorRevision(
    doc,
    request.data.generatorRevision,
  );
  if (!generatorRevision) {
    return {
      ok: false,
      error: {
        code: "GENERATOR_REVISION_NOT_FOUND",
        message: `Generator revision ${request.data.generatorRevision.generatorId}/${request.data.generatorRevision.generatorRevisionId} not found.`,
        generatorId: request.data.generatorRevision.generatorId,
        generatorRevisionId: request.data.generatorRevision.generatorRevisionId,
        actionRunId: request.data.actionRunId,
      },
    };
  }
  const selectedModelExecutor = request.data.modelSelection?.route.executorBinding;
  const usesSelectedModelExecutor = selectedModelExecutor !== undefined &&
    sameImmutableFact(request.data.executor, selectedModelExecutor);
  if (!usesSelectedModelExecutor && (
    request.data.executor.pluginId !==
      generatorRevision.definitionRef.pluginId ||
    request.data.executor.version !== generatorRevision.definitionRef.version ||
    request.data.executor.schemaHash !==
      generatorRevision.definitionRef.schemaHash
  )) {
    return {
      ok: false,
      error: {
        code: "ACTION_RUN_EXECUTOR_MISMATCH",
        message: `Action Run ${request.data.actionRunId} executor provenance does not match Generator revision ${generatorRevision.generatorId}/${generatorRevision.id}.`,
        generatorId: generatorRevision.generatorId,
        generatorRevisionId: generatorRevision.id,
        actionRunId: request.data.actionRunId,
      },
    };
  }
  const existingValue = doc
    .getMap(GENERATOR_ACTION_RUNS_CONTAINER)
    .get(request.data.actionRunId);
  if (existingValue !== undefined) {
    const fields = isLoroMap(existingValue) ? existingValue : null;
    const existingRequest = fields
      ? ActionRunRequestSchema.safeParse(fields.get("request"))
      : null;
    if (
      existingRequest?.success &&
      sameImmutableFact(existingRequest.data, request.data)
    ) {
      const run = readProjectActionRun(doc, request.data.actionRunId);
      if (run) return { ok: true, run, changed: false };
    }
    return {
      ok: false,
      error: {
        code: "ACTION_RUN_REQUEST_COLLISION",
        message: `Action Run ${request.data.actionRunId} already identifies a different immutable request.`,
        actionRunId: request.data.actionRunId,
      },
    };
  }
  doc
    .getMap(GENERATOR_ACTION_RUNS_CONTAINER)
    .ensureMergeableMap(request.data.actionRunId)
    .set("request", request.data);
  return {
    ok: true,
    run: ProjectActionRunSchema.parse({ ...request.data, status: "pending" }),
    changed: true,
  };
}

export function markActionRunStarted(
  doc: LoroDoc,
  actionRunIdInput: string,
): ActionRunMutationResult {
  const unsupported = mutationAuthorityError(doc);
  if (unsupported) return { ok: false, error: unsupported };
  const actionRunId = actionRunIdInput.trim();
  const fields = actionRunFields(doc, actionRunId);
  const run = readProjectActionRun(doc, actionRunId);
  if (!fields || !run) {
    return {
      ok: false,
      error: {
        code: "ACTION_RUN_NOT_FOUND",
        message: `Action Run ${actionRunId} not found.`,
        actionRunId,
      },
    };
  }
  if (run.status === "succeeded" || run.status === "failed") {
    return { ok: true, run, changed: false };
  }
  if (fields.get("started") === true) {
    return { ok: true, run, changed: false };
  }
  fields.set("started", true);
  return {
    ok: true,
    run: ProjectActionRunSchema.parse({ ...run, status: "running" }),
    changed: true,
  };
}

function outputCommitKey(outputSlot: string, itemKey?: string): string {
  return itemKey === undefined ? outputSlot : `${outputSlot}\u0000${itemKey}`;
}

export function readOutputCommit(
  doc: LoroDoc,
  input: { actionRunId: string; outputSlot: string; itemKey?: string },
): OutputCommit | null {
  const commits = doc
    .getMap(GENERATOR_OUTPUT_COMMITS_CONTAINER)
    .get(input.actionRunId);
  if (!isLoroMap(commits)) return null;
  const commit = OutputCommitSchema.safeParse(
    commits.get(outputCommitKey(input.outputSlot, input.itemKey)),
  );
  if (
    !commit.success ||
    commit.data.actionRunId !== input.actionRunId ||
    commit.data.outputSlot !== input.outputSlot ||
    commit.data.itemKey !== input.itemKey
  ) {
    return null;
  }
  return commit.data;
}

/**
 * Single-owner boundary: only the Host coordinator that owns an Action Run may
 * insert its output facts. Peers submit immutable commits through that owner;
 * they must not write these LWW slots directly. This preserves at-least-once
 * replay as insert-or-compare instead of distributed last-writer-wins.
 */
export function ensureOutputCommit(
  doc: LoroDoc,
  commitInput: OutputCommit,
  resolveAssetType: OutputCommitAssetTypeResolver,
): OutputCommitMutationResult {
  const unsupported = mutationAuthorityError(doc);
  if (unsupported) return { ok: false, error: unsupported };
  const commit = OutputCommitSchema.safeParse(commitInput);
  if (!commit.success) {
    return {
      ok: false,
      error: {
        code: "INVALID_OUTPUT_COMMIT",
        message: commit.error.issues[0]?.message ?? "Invalid output commit.",
      },
    };
  }
  const fields = actionRunFields(doc, commit.data.actionRunId);
  const run = readProjectActionRun(doc, commit.data.actionRunId);
  if (!fields || !run) {
    return {
      ok: false,
      error: {
        code: "ACTION_RUN_NOT_FOUND",
        message: `Action Run ${commit.data.actionRunId} not found.`,
        actionRunId: commit.data.actionRunId,
      },
    };
  }
  const port = run.outputContract.find(
    (candidate) => candidate.slot === commit.data.outputSlot,
  );
  if (
    !port ||
    commit.data.itemKey !== undefined ||
    port.assetType.kind !== commit.data.asset.kind
  ) {
    return {
      ok: false,
      error: {
        code: "INVALID_OUTPUT_COMMIT",
        message: `Output ${commit.data.outputSlot} does not match the Action Run contract.`,
        actionRunId: commit.data.actionRunId,
        outputSlot: commit.data.outputSlot,
      },
    };
  }
  const existing = readOutputCommit(doc, commit.data);
  if (existing) {
    if (sameImmutableFact(existing, commit.data)) {
      return { ok: true, commit: existing, changed: false };
    }
    return {
      ok: false,
      error: {
        code: "OUTPUT_COMMIT_ID_COLLISION",
        message: `Output ${commit.data.outputSlot} for Action Run ${commit.data.actionRunId} already identifies a different immutable Asset.`,
        actionRunId: commit.data.actionRunId,
        outputSlot: commit.data.outputSlot,
      },
    };
  }
  if (run.status === "succeeded" || run.status === "failed") {
    return {
      ok: false,
      error: {
        code: "ACTION_RUN_TERMINAL",
        message: `Action Run ${commit.data.actionRunId} is terminal.`,
        actionRunId: commit.data.actionRunId,
      },
    };
  }
  const resolvedAssetType = resolveAssetType(doc, commit.data.asset);
  if (
    !resolvedAssetType ||
    !sameImmutableFact(resolvedAssetType, port.assetType)
  ) {
    return {
      ok: false,
      error: {
        code: "INVALID_OUTPUT_COMMIT",
        message: `Output ${commit.data.outputSlot} does not resolve to the Asset type declared by the Action Run.`,
        actionRunId: commit.data.actionRunId,
        outputSlot: commit.data.outputSlot,
      },
    };
  }
  doc
    .getMap(GENERATOR_OUTPUT_COMMITS_CONTAINER)
    .ensureMergeableMap(commit.data.actionRunId)
    .set(
      outputCommitKey(commit.data.outputSlot, commit.data.itemKey),
      commit.data,
    );
  return { ok: true, commit: commit.data, changed: true };
}

export function commitActionRunOutcome(
  doc: LoroDoc,
  outcomeInput: ActionRunOutcome,
): ActionRunMutationResult {
  const unsupported = mutationAuthorityError(doc);
  if (unsupported) return { ok: false, error: unsupported };
  const outcome = ActionRunOutcomeSchema.safeParse(outcomeInput);
  if (!outcome.success) {
    return {
      ok: false,
      error: {
        code: "INVALID_ACTION_RUN_REQUEST",
        message:
          outcome.error.issues[0]?.message ?? "Invalid Action Run outcome.",
      },
    };
  }
  const fields = actionRunFields(doc, outcome.data.actionRunId);
  const run = readProjectActionRun(doc, outcome.data.actionRunId);
  if (!fields || !run) {
    return {
      ok: false,
      error: {
        code: "ACTION_RUN_NOT_FOUND",
        message: `Action Run ${outcome.data.actionRunId} not found.`,
        actionRunId: outcome.data.actionRunId,
      },
    };
  }
  const rawExisting = fields.get("outcome");
  if (rawExisting !== undefined) {
    const existing = ActionRunOutcomeSchema.safeParse(rawExisting);
    if (existing.success && sameImmutableFact(existing.data, outcome.data)) {
      return { ok: true, run, changed: false };
    }
    return {
      ok: false,
      error: {
        code: "ACTION_RUN_OUTCOME_COLLISION",
        message: `Action Run ${outcome.data.actionRunId} already has a different terminal outcome.`,
        actionRunId: outcome.data.actionRunId,
      },
    };
  }
  if (
    outcome.data.status === "succeeded" &&
    run.outputContract.some(
      (port) =>
        port.cardinality.minItems > 0 &&
        readOutputCommit(doc, {
          actionRunId: outcome.data.actionRunId,
          outputSlot: port.slot,
        }) === null,
    )
  ) {
    return {
      ok: false,
      error: {
        code: "REQUIRED_OUTPUT_NOT_COMMITTED",
        message: `Action Run ${outcome.data.actionRunId} is missing a required output commit.`,
        actionRunId: outcome.data.actionRunId,
      },
    };
  }
  fields.set("outcome", outcome.data);
  return {
    ok: true,
    run: ProjectActionRunSchema.parse({ ...run, status: outcome.data.status }),
    changed: true,
  };
}

export function isGeneratorRevisionMaterialized(
  doc: LoroDoc,
  input: GeneratorRevisionRef,
): boolean {
  const ref = GeneratorRevisionRefSchema.safeParse(input);
  if (!ref.success) return false;
  for (const rawRevisions of doc
    .getMap(GENERATOR_REVISIONS_CONTAINER)
    .values()) {
    if (!isLoroMap(rawRevisions)) continue;
    for (const rawRevision of rawRevisions.values()) {
      const revision = GeneratorRevisionSchema.safeParse(rawRevision);
      if (!revision.success) continue;
      if (
        revision.data.persistentInputRefs.some((candidate) => {
          const target = candidate.target;
          return (
            "generatorId" in target &&
            target.generatorId === ref.data.generatorId &&
            target.generatorRevisionId === ref.data.generatorRevisionId
          );
        })
      ) {
        return true;
      }
    }
  }
  for (const rawRun of doc.getMap(GENERATOR_ACTION_RUNS_CONTAINER).values()) {
    if (!isLoroMap(rawRun)) continue;
    const request = ActionRunRequestSchema.safeParse(rawRun.get("request"));
    if (!request.success) continue;
    if (
      (request.data.generatorRevision.generatorId === ref.data.generatorId &&
        request.data.generatorRevision.generatorRevisionId ===
          ref.data.generatorRevisionId) ||
      request.data.invocationInputRefs.some((candidate) => {
        const target = candidate.target;
        return (
          "generatorId" in target &&
          target.generatorId === ref.data.generatorId &&
          target.generatorRevisionId === ref.data.generatorRevisionId
        );
      })
    ) {
      return true;
    }
  }
  return false;
}

export function createProjectGenerator(
  doc: LoroDoc,
  input: { head: ProjectGeneratorHead; revision: GeneratorRevision },
): CreateProjectGeneratorResult {
  const unsupported = mutationAuthorityError(doc);
  if (unsupported) return { ok: false, error: unsupported };
  const head = ProjectGeneratorHeadSchema.safeParse(input.head);
  const revision = GeneratorRevisionSchema.safeParse(input.revision);
  if (
    !head.success ||
    !revision.success ||
    revision.data.generatorId !== head.data.id ||
    revision.data.id !== head.data.headRevisionId ||
    revision.data.parentRevisionId !== undefined
  ) {
    return {
      ok: false,
      error: {
        code: "INVALID_PROJECT_GENERATOR",
        message:
          head.error?.issues[0]?.message ??
          revision.error?.issues[0]?.message ??
          "The initial Generator revision must match its head and have no parent.",
      },
    };
  }
  const forkSource = revision.data.forkedFrom
    ? readGeneratorRevision(doc, revision.data.forkedFrom)
    : undefined;
  if (revision.data.forkedFrom && !forkSource) {
    return {
      ok: false,
      error: {
        code: "GENERATOR_FORK_SOURCE_NOT_FOUND",
        message: `Generator fork source ${revision.data.forkedFrom.generatorId}/${revision.data.forkedFrom.generatorRevisionId} not found.`,
        generatorId: head.data.id,
        generatorRevisionId: revision.data.id,
      },
    };
  }
  if (
    forkSource &&
    (forkSource.definitionRef.pluginId !==
      revision.data.definitionRef.pluginId ||
      forkSource.definitionRef.definitionId !==
        revision.data.definitionRef.definitionId)
  ) {
    return {
      ok: false,
      error: {
        code: "GENERATOR_FORK_FAMILY_MISMATCH",
        message: `Generator fork source ${forkSource.generatorId}/${forkSource.id} belongs to a different definition family.`,
        generatorId: head.data.id,
        generatorRevisionId: revision.data.id,
      },
    };
  }
  const rawRevisionMap = doc
    .getMap(GENERATOR_REVISIONS_CONTAINER)
    .get(head.data.id);
  const rawExistingRevision = isLoroMap(rawRevisionMap)
    ? rawRevisionMap.get(revision.data.id)
    : undefined;
  if (rawExistingRevision !== undefined) {
    const existingRevision =
      GeneratorRevisionSchema.safeParse(rawExistingRevision);
    if (
      !existingRevision.success ||
      !sameImmutableFact(existingRevision.data, revision.data)
    ) {
      return {
        ok: false,
        error: {
          code: "GENERATOR_REVISION_ID_COLLISION",
          message: `Generator revision ${revision.data.id} already identifies different immutable state.`,
          generatorId: head.data.id,
          generatorRevisionId: revision.data.id,
        },
      };
    }
  }
  const existingProject = doc
    .getMap(PROJECT_GENERATORS_CONTAINER)
    .get(head.data.id);
  if (
    isLoroMap(existingProject) &&
    existingProject.get("terminal") !== undefined
  ) {
    return {
      ok: false,
      error: {
        code: "PROJECT_GENERATOR_DELETED",
        message: `Project Generator ${head.data.id} is deleted.`,
        generatorId: head.data.id,
      },
    };
  }
  if (existingProject !== undefined) {
    const existing = readProjectGenerator(doc, head.data.id);
    const existingRevision = readGeneratorRevision(doc, {
      generatorId: head.data.id,
      generatorRevisionId: head.data.headRevisionId,
    });
    if (
      existing &&
      existing.headRevisionId === head.data.headRevisionId &&
      existingRevision &&
      sameImmutableFact(existingRevision, revision.data)
    ) {
      return {
        ok: true,
        generator: existing,
        revision: existingRevision,
        changed: false,
      };
    }
    if (
      existingRevision &&
      !sameImmutableFact(existingRevision, revision.data)
    ) {
      return {
        ok: false,
        error: {
          code: "GENERATOR_REVISION_ID_COLLISION",
          message: `Generator revision ${revision.data.id} already identifies different immutable state.`,
          generatorId: head.data.id,
          generatorRevisionId: revision.data.id,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "PROJECT_GENERATOR_EXISTS",
        message: `Project Generator ${head.data.id} already exists.`,
        generatorId: head.data.id,
      },
    };
  }

  if (rawExistingRevision === undefined) {
    doc
      .getMap(GENERATOR_REVISIONS_CONTAINER)
      .ensureMergeableMap(head.data.id)
      .set(revision.data.id, revision.data);
  }
  doc
    .getMap(PROJECT_GENERATORS_CONTAINER)
    .ensureMergeableMap(head.data.id)
    .set("head", { revisionId: head.data.headRevisionId });
  return {
    ok: true,
    generator: ProjectGeneratorSchema.parse({
      ...head.data,
      definitionRef: revision.data.definitionRef,
    }),
    revision: revision.data,
    changed: true,
  };
}

export function advanceProjectGeneratorHead(
  doc: LoroDoc,
  input: {
    generatorId: string;
    expectedHeadRevisionId: string;
    revision: GeneratorRevision;
    editPolicy: "advance-head" | "fork-when-materialized";
  },
): AdvanceProjectGeneratorHeadResult {
  const unsupported = mutationAuthorityError(doc);
  if (unsupported) return { ok: false, error: unsupported };
  const parsedRevision = GeneratorRevisionSchema.safeParse(input.revision);
  if (
    !parsedRevision.success ||
    parsedRevision.data.generatorId !== input.generatorId ||
    parsedRevision.data.parentRevisionId !== input.expectedHeadRevisionId
  ) {
    return {
      ok: false,
      error: {
        code: "INVALID_PROJECT_GENERATOR",
        message:
          parsedRevision.error?.issues[0]?.message ??
          "The next Generator revision must belong to the Generator and name the expected head as its parent.",
        generatorId: input.generatorId,
      },
    };
  }
  const rawProject = doc
    .getMap(PROJECT_GENERATORS_CONTAINER)
    .get(input.generatorId);
  if (isLoroMap(rawProject) && rawProject.get("terminal") !== undefined) {
    return {
      ok: false,
      error: {
        code: "PROJECT_GENERATOR_DELETED",
        message: `Project Generator ${input.generatorId} is deleted.`,
        generatorId: input.generatorId,
      },
    };
  }
  const current = readProjectGenerator(doc, input.generatorId);
  if (!current) {
    return {
      ok: false,
      error: {
        code: "PROJECT_GENERATOR_NOT_FOUND",
        message: `Project Generator ${input.generatorId} not found.`,
        generatorId: input.generatorId,
      },
    };
  }
  if (current.headRevisionId === parsedRevision.data.id) {
    const applied = readGeneratorRevision(doc, {
      generatorId: input.generatorId,
      generatorRevisionId: parsedRevision.data.id,
    });
    if (applied && sameImmutableFact(applied, parsedRevision.data)) {
      return {
        ok: true,
        generator: current,
        revision: applied,
        changed: false,
      };
    }
  }
  if (current.headRevisionId !== input.expectedHeadRevisionId) {
    return {
      ok: false,
      error: {
        code: "STALE_GENERATOR_HEAD",
        message: `Project Generator ${input.generatorId} changed after it was read.`,
        generatorId: input.generatorId,
      },
    };
  }
  if (
    input.editPolicy === "fork-when-materialized" &&
    isGeneratorRevisionMaterialized(doc, {
      generatorId: input.generatorId,
      generatorRevisionId: current.headRevisionId,
    })
  ) {
    return {
      ok: false,
      error: {
        code: "GENERATOR_FORK_REQUIRED",
        message: `Project Generator ${input.generatorId} must be forked because its head is materialized.`,
        generatorId: input.generatorId,
        generatorRevisionId: current.headRevisionId,
      },
    };
  }
  const existingRevision = readGeneratorRevision(doc, {
    generatorId: input.generatorId,
    generatorRevisionId: parsedRevision.data.id,
  });
  if (
    existingRevision &&
    !sameImmutableFact(existingRevision, parsedRevision.data)
  ) {
    return {
      ok: false,
      error: {
        code: "GENERATOR_REVISION_ID_COLLISION",
        message: `Generator revision ${parsedRevision.data.id} already identifies different immutable state.`,
        generatorId: input.generatorId,
        generatorRevisionId: parsedRevision.data.id,
      },
    };
  }
  if (!existingRevision) {
    doc
      .getMap(GENERATOR_REVISIONS_CONTAINER)
      .ensureMergeableMap(input.generatorId)
      .set(parsedRevision.data.id, parsedRevision.data);
  }
  const fields = doc
    .getMap(PROJECT_GENERATORS_CONTAINER)
    .get(input.generatorId);
  if (!isLoroMap(fields)) {
    return {
      ok: false,
      error: {
        code: "PROJECT_GENERATOR_NOT_FOUND",
        message: `Project Generator ${input.generatorId} not found.`,
        generatorId: input.generatorId,
      },
    };
  }
  fields.set("head", { revisionId: parsedRevision.data.id });
  return {
    ok: true,
    generator: ProjectGeneratorSchema.parse({
      id: input.generatorId,
      headRevisionId: parsedRevision.data.id,
      definitionRef: parsedRevision.data.definitionRef,
    }),
    revision: parsedRevision.data,
    changed: true,
  };
}
