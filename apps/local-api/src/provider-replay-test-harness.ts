import {
  access,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Canvas } from "@clash/shared-types";

import { FileReplicaStore } from "./loro/file-replica-store.js";
import type { PublicAssetStorageService } from "./public-asset-storage.js";
import {
  createJsonlProviderTestRecorder,
  createProviderConformanceStubs,
  createProviderTestRecordingFetch,
  createProviderTestReplayFetchFromPath,
  type ProviderConformanceStub,
  type ProviderTestRecorder,
} from "./provider-test-recorder.js";
import {
  createConfiguredLocalAcpAdapter,
  prepareDevelopmentBundledPlugins,
  startLocalApiServer,
} from "./server.js";

type ProviderE2EMode = "replay" | "live";

export interface ProviderTestAccount {
  id: string;
  providerId: string;
  upstreamId?: string;
  region?: string;
  credentials: Record<string, string>;
}

export interface ProviderTestReference {
  id?: string;
  kind: "image" | "video" | "audio" | "model";
  bytes: Uint8Array;
  mediaType: string;
  originalName?: string;
}

export type ProviderTestExpectation =
  | {
      kind: "text";
      text?: string;
      /** ASR-only tolerance for presentation differences; authored text remains exact by default. */
      textMatch?: "exact" | "normalized";
    }
  | { kind: "image" | "video" | "audio" | "model"; mediaType?: string };

export interface ProviderReplayTestCase {
  id: string;
  type: "text_gen" | "image_gen" | "video_gen" | "audio_gen" | "model_gen";
  modelId: string;
  prompt: string;
  label?: string;
  params?: Record<string, string | number | boolean>;
  refs?: readonly ProviderTestReference[];
  /**
   * Earlier, already-completed case ids whose graded output asset becomes an
   * additional Canvas reference for this case (e.g. a mesh-generation case
   * feeding an auto-rig case). Every id must name a case that appears
   * strictly earlier in the same `cases` array and produce a storable
   * (non-text) asset -- `validateProviderReplayCaseChain` enforces the
   * ordering before any server or network work starts.
   */
  refCaseIds?: readonly string[];
  expect: ProviderTestExpectation;
}

export type ProviderReplayTestCaseResult =
  | {
      id: string;
      kind: "text";
      text: string;
      revisionId: string;
    }
  | {
      id: string;
      kind: "image" | "video" | "audio" | "model";
      assetId: string;
      mediaType: string;
      byteLength: number;
    };

/**
 * Fail fast, before any temp directory or server is created, when a case's
 * `refCaseIds` names itself or a case that is not strictly earlier in the
 * array. This is the ordering `runProviderTestHarness` relies on to resolve
 * each chained reference to an already-graded output asset id.
 */
export function validateProviderReplayCaseChain(
  cases: readonly Pick<ProviderReplayTestCase, "id" | "refCaseIds">[],
): void {
  const seen = new Set<string>();
  for (const graderCase of cases) {
    for (const refCaseId of graderCase.refCaseIds ?? []) {
      if (refCaseId === graderCase.id) {
        throw new Error(
          `Provider replay case ${graderCase.id} cannot reference itself via refCaseIds`,
        );
      }
      if (!seen.has(refCaseId)) {
        throw new Error(
          `Provider replay case ${graderCase.id} refCaseIds names ${refCaseId}, which is not an earlier case`,
        );
      }
    }
    seen.add(graderCase.id);
  }
}

/**
 * Resolve one case's `refCaseIds` to the graded Canvas output **node** ids
 * (`host-command add`'s `refs` resolves Canvas node ids, not Project Asset
 * ids -- see `resolveCanvasReferenceNodeIds` in project-command-host.ts).
 * Pulled out as a pure function so a unit test can prove the values threaded
 * into `refs` are node ids and would fail if an asset id ever slipped back
 * in here.
 */
export function resolveProviderReplayChainRefs(
  graderCase: Pick<ProviderReplayTestCase, "id" | "refCaseIds">,
  outputNodeIdByCaseId: ReadonlyMap<string, string>,
): string[] {
  return (graderCase.refCaseIds ?? []).map((refCaseId) => {
    const nodeId = outputNodeIdByCaseId.get(refCaseId);
    if (!nodeId) {
      throw new Error(
        `${graderCase.id} refCaseIds names ${refCaseId}, which has not produced a storable asset yet`,
      );
    }
    return nodeId;
  });
}

/**
 * Kept in lockstep with `assertProviderMediaFormat`'s registered validators.
 * Accepting a spelling here that has no byte-level check below would let a
 * case pass MIME matching and then always fail format assertion -- so this
 * set names only formats this file actually knows how to verify.
 */
const MODEL_MEDIA_TYPES = new Set(["model/gltf-binary", "model/gltf+json"]);

/**
 * Match a graded asset's MIME against the expected asset kind.
 *
 * `image` / `video` / `audio` MIME types are provider-published and share
 * one namespace with their kind (`image/png`, `video/mp4`, ...), so a
 * `${kind}/` prefix check is a correct membership test there. 3D output is
 * not: `model/gltf-binary`, `model/gltf+json`, and friends are a menu of
 * concrete published container types, not a namespace clash detector, so
 * treating any `model/*` spelling as a pass would let an unregistered or
 * mistyped subtype through unnoticed. `model` kind is matched against the
 * explicit registered set instead.
 */
export function mediaTypeMatchesExpectedAssetKind(
  expectedKind: "image" | "video" | "audio" | "model",
  mediaType: string,
): boolean {
  if (expectedKind === "model") return MODEL_MEDIA_TYPES.has(mediaType);
  return mediaType.startsWith(`${expectedKind}/`);
}

export interface ProviderReplayTestResult {
  /** The isolated directory used for the run. It has been removed when this function resolves. */
  dataDir: string;
  projectId: string;
  cases: ProviderReplayTestCaseResult[];
}

export interface ProviderTestPluginContext {
  actionsRoot: string;
  dataDir: string;
}

export interface ProviderTestPluginPreparation {
  watchRoots?: Readonly<Record<string, readonly string[]>>;
}

interface ProviderTestHarnessCommonOptions {
  account: ProviderTestAccount;
  cases: readonly ProviderReplayTestCase[];
  /** Test-only source plugins to activate; inferred for bundled Google/MiniMax suites. */
  bundledPluginIds?: readonly string[];
  /** Test-owned public projection service for URL-only Provider inputs. */
  publicAssetStorage?: PublicAssetStorageService;
  providerAssetFetch?: typeof fetch;
  timeoutMs?: number;
  preparePlugins?: (
    context: ProviderTestPluginContext,
  ) => Promise<ProviderTestPluginPreparation | void>;
}

export interface ProviderReplayTestHarnessOptions extends ProviderTestHarnessCommonOptions {
  fixturePath: string;
}

export interface ProviderLiveTestHarnessOptions extends ProviderTestHarnessCommonOptions {
  recordingPath: string;
}

type JsonObject = Record<string, unknown>;

interface PreparedProviderReferenceNode {
  nodeId: string;
  assetId: string;
  kind: ProviderTestReference["kind"];
  mediaType: string;
  label: string;
}

export function normalizeProviderReplayText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{White_Space}\p{Punctuation}]/gu, "");
}

/** Run a Vitest Project/Canvas backend case against committed JSONL traffic. */
export async function runProviderReplayTestHarness(
  options: ProviderReplayTestHarnessOptions,
): Promise<ProviderReplayTestResult> {
  await access(options.fixturePath);
  return runProviderTestHarness({
    ...options,
    traffic: { mode: "replay", path: resolve(options.fixturePath) },
  });
}

/**
 * Run the same test harness against a real provider and append the redacted upstream
 * traffic to `recordingPath`. Callers must gate this with
 * the live-only Vitest configuration gate.
 */
export async function runProviderLiveTestHarness(
  options: ProviderLiveTestHarnessOptions,
): Promise<ProviderReplayTestResult> {
  const recordingPath = resolve(options.recordingPath);
  await mkdir(dirname(recordingPath), { recursive: true });
  return runProviderTestHarness({
    ...options,
    traffic: { mode: "live", path: recordingPath },
  });
}

async function runProviderTestHarness(
  options: ProviderTestHarnessCommonOptions & {
    traffic: { mode: ProviderE2EMode; path: string };
  },
): Promise<ProviderReplayTestResult> {
  if (options.cases.length === 0) {
    throw new Error("Provider replay test harness requires at least one case");
  }
  validateProviderReplayCaseChain(options.cases);
  const root = await mkdtemp(join(tmpdir(), "clash-provider-replay-harness-"));
  const dataDir = join(root, "local-api");
  const actionsRoot = join(root, "actions");
  const activeStubPath = join(root, "active-provider-stub.json");
  let server: Awaited<ReturnType<typeof startLocalApiServer>> | undefined;
  let projectId = "";
  let activeLiveStub: ProviderConformanceStub | undefined;

  try {
    await prepareDevelopmentBundledPlugins({
      actionsRoot,
      pluginIds: options.bundledPluginIds,
    });
    await options.preparePlugins?.({ actionsRoot, dataDir });

    let liveRecorder: ProviderTestRecorder | undefined;
    const liveRecordingFetch =
      options.traffic.mode === "live"
        ? async (
            baseFetch: typeof fetch,
            input: RequestInfo | URL,
            init?: RequestInit,
          ) => {
            if (!activeLiveStub) {
              throw new Error(
                "Provider live test harness received traffic before a case was active",
              );
            }
            liveRecorder ??= await createJsonlProviderTestRecorder(
              options.traffic.path,
            );
            return createProviderTestRecordingFetch({
              fetch: baseFetch,
              recorder: liveRecorder,
              stub: activeLiveStub,
            })(input, init);
          }
        : undefined;
    const providerAssetFetch: typeof fetch =
      options.traffic.mode === "replay"
        ? (options.providerAssetFetch ??
          createProviderTestReplayFetchFromPath(options.traffic.path))
        : (input, init) =>
            liveRecordingFetch!(
              options.providerAssetFetch ?? fetch,
              input,
              init,
            );
    server = await startLocalApiServer({
      port: 0,
      dataDir,
      remotePersistence: null,
      providerHttpInstrumentation: {
        mode: options.traffic.mode === "live" ? "record" : "replay",
        trafficPath: options.traffic.path,
        ...(options.traffic.mode === "live" ? { activeStubPath } : {}),
        modulePath: fileURLToPath(
          new URL("./provider-http-instrumentation.ts", import.meta.url),
        ),
        loaderPath: createRequire(import.meta.url).resolve("tsx"),
      },
      providerAssetFetch,
      ...(options.publicAssetStorage
        ? { publicAssetStorage: options.publicAssetStorage }
        : {}),
      ...(options.traffic.mode === "replay"
        ? { providerPollDelayCapMs: 1 }
        : {}),
      localAcp: createConfiguredLocalAcpAdapter(
        { CLASH_E2E_STUB_ACP: "1" },
        { dataDir },
      ),
      discovery: { enabled: false },
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error(
        "Provider replay test harness local-api did not bind a TCP port",
      );
    }
    const origin = `http://127.0.0.1:${address.port}`;

    const post = async <T extends JsonObject>(
      path: string,
      body: JsonObject,
    ): Promise<T> =>
      jsonResponse<T>(
        await fetch(`${origin}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const command = <T extends JsonObject>(body: JsonObject) =>
      post<T>(`/api/v1/projects/${projectId}/host-command`, body);

    const project = await post<{ id: string }>("/api/v1/projects", {
      name: `Provider replay test: ${options.account.providerId}`,
    });
    projectId = requiredString(project.id, "project id");

    // Seed authored Canvas references before the first Project-room operation opens the live
    // replica. Asset imports below then publish through that same room, so generation add can
    // resolve every reference without an out-of-band snapshot refresh.
    const referencesByCase = new Map<string, string[]>();
    const preparedReferenceNodes = options.cases.flatMap((graderCase) => {
      const prepared = prepareReferenceNodes({
        caseId: graderCase.id,
        refs: graderCase.refs ?? [],
      });
      referencesByCase.set(
        graderCase.id,
        prepared.map(({ nodeId }) => nodeId),
      );
      return prepared;
    });
    await createReferenceNodes({
      dataDir,
      projectId,
      references: preparedReferenceNodes,
    });

    await command({ action: "create_canvas", canvasId: "main", name: "Main" });
    await configureProviderAccount(origin, options.account);

    // Publish every authored Asset before any run can leave a polling timer behind.
    for (const graderCase of options.cases) {
      await importReferenceNodes({
        origin,
        projectId,
        caseId: graderCase.id,
        refs: graderCase.refs ?? [],
      });
    }

    const results: ProviderReplayTestCaseResult[] = [];
    const outputNodeIdByCaseId = new Map<string, string>();
    for (const graderCase of options.cases) {
      if (options.traffic.mode === "live") {
        activeLiveStub = providerConformanceStubForCase(
          options.account,
          graderCase,
        );
        await writeActiveProviderStub(activeStubPath, activeLiveStub);
      }
      const chainRefs = resolveProviderReplayChainRefs(
        graderCase,
        outputNodeIdByCaseId,
      );
      const refs = [
        ...(referencesByCase.get(graderCase.id) ?? []),
        ...chainRefs,
      ];
      const added = await command<{ node_id: string }>({
        action: "add",
        canvasId: "main",
        type: graderCase.type,
        label: graderCase.label ?? graderCase.id,
        prompt: graderCase.prompt,
        modelId: graderCase.modelId,
        ...(graderCase.params ? { params: graderCase.params } : {}),
        ...(refs.length ? { refs } : {}),
      });
      const executed = await command<{ childNodeId: string }>({
        action: "execute",
        canvasId: "main",
        nodeId: providerTestAddedNodeId(graderCase.id, added),
        providerAccountId: options.account.id,
      });
      const nodeId = providerTestExecutedNodeId(graderCase.id, executed);
      const node = await waitForCompletedNode({
        origin,
        projectId,
        nodeId,
        caseId: graderCase.id,
        timeoutMs: options.timeoutMs ?? 30 * 60_000,
      });
      const graded = await gradeCompletedNode({
        origin,
        dataDir,
        projectId,
        nodeId,
        graderCase,
        node,
      });
      if (graded.kind !== "text") outputNodeIdByCaseId.set(graderCase.id, nodeId);
      results.push(graded);
    }

    return { dataDir, projectId, cases: results };
  } finally {
    if (server) {
      await new Promise<void>((resolveClose) => {
        server!.close(() => resolveClose());
      });
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function writeActiveProviderStub(
  path: string,
  stub: ProviderConformanceStub,
): Promise<void> {
  const pendingPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(pendingPath, `${JSON.stringify(stub)}\n`, "utf8");
  await rename(pendingPath, path);
}

async function configureProviderAccount(
  origin: string,
  account: ProviderTestAccount,
): Promise<void> {
  const listed = await jsonResponse<{ readToken: string }>(
    await fetch(`${origin}/api/v1/model-providers`),
  );
  await jsonResponse(
    await fetch(`${origin}/api/v1/model-providers`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        readToken: requiredString(
          listed.readToken,
          "provider account read token",
        ),
        providers: [
          {
            id: account.id,
            providerId: account.providerId,
            ...(account.upstreamId ? { upstreamId: account.upstreamId } : {}),
            ...(account.region ? { region: account.region } : {}),
            enabled: true,
            credentials: account.credentials,
          },
        ],
      }),
    }),
  );
}

async function importReferenceNodes(options: {
  origin: string;
  projectId: string;
  caseId: string;
  refs: readonly ProviderTestReference[];
}): Promise<PreparedProviderReferenceNode[]> {
  const references = prepareReferenceNodes(options);
  for (const [index, ref] of options.refs.entries()) {
    const reference = references[index]!;
    const originalName =
      ref.originalName ?? `reference-${index}${extensionForReference(ref)}`;
    const form = new FormData();
    form.set(
      "file",
      new File([Uint8Array.from(ref.bytes).buffer], originalName, {
        type: ref.mediaType,
      }),
    );
    form.set("kind", ref.kind);
    form.set("projectAssetId", reference.assetId);
    const asset = await jsonResponse<{ id: string }>(
      await fetch(
        `${options.origin}/api/v1/projects/${encodeURIComponent(options.projectId)}/assets/import-file`,
        {
          method: "POST",
          body: form,
        },
      ),
    );
    const assetId = requiredString(
      asset.id,
      `${reference.nodeId} reference asset id`,
    );
    if (assetId !== reference.assetId) {
      throw new Error(
        `${reference.nodeId} imported as unexpected Project Asset ${assetId}`,
      );
    }
  }
  return references;
}

function prepareReferenceNodes(options: {
  caseId: string;
  refs: readonly ProviderTestReference[];
}): PreparedProviderReferenceNode[] {
  return options.refs.map((ref, index) => ({
    nodeId: ref.id ?? `${safeSegment(options.caseId)}-ref-${index}`,
    assetId: providerTestReferenceAssetId(options.caseId, index),
    kind: ref.kind,
    mediaType: ref.mediaType,
    label: `Reference ${index + 1}`,
  }));
}

async function createReferenceNodes(options: {
  dataDir: string;
  projectId: string;
  references: readonly PreparedProviderReferenceNode[];
}): Promise<void> {
  if (options.references.length === 0) return;
  const replicaStore = new FileReplicaStore(join(options.dataDir, "projects"));
  await replicaStore.updateSnapshotAtomic(options.projectId, (doc) => {
    const canvas = new Canvas(doc, () => {}, "main");
    for (const reference of options.references) {
      const created = canvas.createNode(
        reference.nodeId,
        reference.kind,
        {
          label: reference.label,
          status: "completed",
          mediaType: reference.mediaType,
        },
        null,
        null,
        reference.assetId,
      );
      if (created.error) throw new Error(created.error);
    }
    return { value: undefined };
  });
}

async function waitForCompletedNode(options: {
  origin: string;
  projectId: string;
  nodeId: string;
  caseId: string;
  timeoutMs: number;
}): Promise<JsonObject> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const result = await jsonResponse<{ node: JsonObject }>(
      await fetch(
        `${options.origin}/api/v1/projects/${options.projectId}/canvas/nodes/${options.nodeId}`,
      ),
    );
    const node = requiredObject(result.node, `${options.nodeId} node`);
    const data = requiredObject(node.data, `${options.nodeId} node data`);
    if (data.status === "completed") return node;
    if (data.status === "failed") {
      // The node carries only the public failure summary; the Host keeps the
      // cause on the Action Run, which is what a failing replay needs to show.
      const diagnostics =
        typeof data.actionRunId === "string"
          ? await fetch(
              `${options.origin}/api/v1/projects/${options.projectId}/generator-runs/${encodeURIComponent(data.actionRunId)}`,
            )
              .then((response) => response.json())
              .then((run) => (run as JsonObject).diagnostics)
              .catch(() => undefined)
          : undefined;
      throw new Error(
        `${options.caseId} (${options.nodeId}) failed: ${String(data.error ?? "unknown provider error")}${diagnostics ? ` ${JSON.stringify(diagnostics)}` : ""}`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    `Timed out waiting for provider replay case ${options.caseId} node ${options.nodeId}`,
  );
}

/**
 * A Generator output is authoritative through the Output Commit of its Action
 * Run. Node data is only a projection of that fact, so the grader resolves the
 * commit through the same read routes a client uses.
 */
async function readCommittedOutput(options: {
  origin: string;
  projectId: string;
  caseId: string;
  data: JsonObject;
}): Promise<{ actionRunId: string; asset: JsonObject }> {
  const actionRunId = requiredString(
    options.data.actionRunId,
    `${options.caseId} Action Run id`,
  );
  const runUrl = `${options.origin}/api/v1/projects/${encodeURIComponent(options.projectId)}/generator-runs/${encodeURIComponent(actionRunId)}`;
  const run = requiredObject(
    (await jsonResponse(await fetch(runUrl))).run,
    `${options.caseId} Action Run`,
  );
  if (run.status !== "succeeded") {
    throw new Error(
      `${options.caseId} Action Run is ${String(run.status)}, not succeeded`,
    );
  }
  const outputs = Array.isArray(run.outputContract) ? run.outputContract : [];
  if (outputs.length !== 1) {
    throw new Error(
      `${options.caseId} expected one Action Run output, got ${outputs.length}`,
    );
  }
  const outputSlot = requiredString(
    requiredObject(outputs[0], `${options.caseId} output contract`).slot,
    `${options.caseId} output slot`,
  );
  const commit = requiredObject(
    (
      await jsonResponse(
        await fetch(`${runUrl}/outputs/${encodeURIComponent(outputSlot)}`),
      )
    ).commit,
    `${options.caseId} Output Commit`,
  );
  return {
    actionRunId,
    asset: requiredObject(commit.asset, `${options.caseId} committed Asset`),
  };
}

async function gradeCompletedNode(options: {
  origin: string;
  dataDir: string;
  projectId: string;
  nodeId: string;
  graderCase: ProviderReplayTestCase;
  node: JsonObject;
}): Promise<ProviderReplayTestCaseResult> {
  const data = requiredObject(
    options.node.data,
    `${options.graderCase.id} completed node data`,
  );
  const committed = await readCommittedOutput({
    origin: options.origin,
    projectId: options.projectId,
    caseId: options.graderCase.id,
    data,
  });
  if (options.graderCase.expect.kind === "text") {
    if (options.node.type !== "text") {
      throw new Error(
        `${options.graderCase.id} expected a text node, got ${String(options.node.type)}`,
      );
    }
    const projected = requiredObject(
      data.documentRevision,
      `${options.graderCase.id} node Document revision`,
    );
    if (
      committed.asset.kind !== "document" ||
      committed.asset.documentAssetId !== projected.documentAssetId ||
      committed.asset.revisionId !== projected.revisionId
    ) {
      throw new Error(
        `${options.graderCase.id} node does not project the Document revision its Action Run committed`,
      );
    }
    const documentAssetId = requiredString(
      projected.documentAssetId,
      `${options.graderCase.id} Document Asset id`,
    );
    const revisionId = requiredString(
      projected.revisionId,
      `${options.graderCase.id} Document revision id`,
    );
    const document = await jsonResponse<JsonObject>(
      await fetch(
        `${options.origin}/api/v1/projects/${encodeURIComponent(options.projectId)}/documents/${encodeURIComponent(documentAssetId)}/revisions/${encodeURIComponent(revisionId)}`,
      ),
    );
    const text = requiredString(
      document.body,
      `${options.graderCase.id} canonical text content`,
    );
    if (
      options.graderCase.expect.text !== undefined &&
      (options.graderCase.expect.textMatch === "normalized"
        ? normalizeProviderReplayText(text) !==
          normalizeProviderReplayText(options.graderCase.expect.text)
        : text !== options.graderCase.expect.text)
    ) {
      throw new Error(
        `${options.graderCase.id} text did not match the recorded acceptance`,
      );
    }
    const producer = requiredObject(
      requiredObject(
        document.revision,
        `${options.graderCase.id} Document revision`,
      ).producer,
      `${options.graderCase.id} Document revision producer`,
    );
    if (
      producer.kind !== "action-run" ||
      producer.actionRunId !== committed.actionRunId
    ) {
      throw new Error(
        `${options.graderCase.id} Document revision was not produced by its Action Run`,
      );
    }
    return {
      id: options.graderCase.id,
      kind: "text",
      text,
      revisionId,
    };
  }

  const expectedKind = options.graderCase.expect.kind;
  if (options.node.type !== expectedKind) {
    throw new Error(
      `${options.graderCase.id} expected a ${expectedKind} node, got ${String(options.node.type)}`,
    );
  }
  const assetId = requiredString(
    data.assetId,
    `${options.graderCase.id} asset id`,
  );
  const asset = await jsonResponse<JsonObject>(
    await fetch(
      `${options.origin}/api/v1/projects/${encodeURIComponent(options.projectId)}/assets/${encodeURIComponent(assetId)}`,
    ),
  );
  if (asset.kind !== expectedKind) {
    throw new Error(
      `${options.graderCase.id} expected a ${expectedKind} asset, got ${String(asset.kind)}`,
    );
  }
  const metadata = requiredObject(
    asset.metadata,
    `${options.graderCase.id} asset metadata`,
  );
  const mediaType = requiredString(
    metadata.contentType,
    `${options.graderCase.id} asset MIME type`,
  );
  if (!mediaTypeMatchesExpectedAssetKind(expectedKind, mediaType)) {
    throw new Error(
      `${options.graderCase.id} asset MIME ${mediaType} is not ${expectedKind}`,
    );
  }
  if (
    options.graderCase.expect.mediaType !== undefined &&
    mediaType !== options.graderCase.expect.mediaType
  ) {
    throw new Error(
      `${options.graderCase.id} expected MIME ${options.graderCase.expect.mediaType}, got ${mediaType}`,
    );
  }
  const mediaUrl = requiredString(
    asset.url,
    `${options.graderCase.id} asset media URL`,
  );
  const mediaResponse = await fetch(mediaUrl);
  if (!mediaResponse.ok) {
    throw new Error(
      `${options.graderCase.id} media projection returned ${mediaResponse.status}`,
    );
  }
  const bytes = new Uint8Array(await mediaResponse.arrayBuffer());
  if (bytes.byteLength <= 0) {
    throw new Error(
      `${options.graderCase.id} did not persist non-empty asset bytes`,
    );
  }
  assertProviderMediaFormat(mediaType, bytes);
  if (
    committed.asset.kind !== "media" ||
    committed.asset.projectAssetId !== assetId
  ) {
    throw new Error(
      `${options.graderCase.id} asset is not the output its Action Run committed in the graded Project`,
    );
  }
  return {
    id: options.graderCase.id,
    kind: expectedKind,
    assetId,
    mediaType,
    byteLength: bytes.byteLength,
  };
}

function startsWithBytes(
  bytes: Uint8Array,
  signature: readonly number[],
): boolean {
  return (
    bytes.byteLength >= signature.length &&
    signature.every((byte, index) => bytes[index] === byte)
  );
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  return (
    bytes.byteLength >= offset + text.length &&
    [...text].every(
      (character, index) => bytes[offset + index] === character.charCodeAt(0),
    )
  );
}

/**
 * Prove a replayed asset is the format its provider metadata claims.
 *
 * MIME plus non-empty bytes lets an HTML quota page or JSON error pass as an image/video/audio
 * result. Container signatures are external format facts, so this grader catches that boundary
 * failure without trying to judge the generated content itself.
 */
export function assertProviderMediaFormat(
  mediaTypeInput: string,
  bytes: Uint8Array,
): void {
  const mediaType = mediaTypeInput.split(";", 1)[0]!.trim().toLowerCase();
  const fail = (message: string): never => {
    const prefix = Buffer.from(bytes.subarray(0, 16)).toString("hex");
    throw new Error(
      `Provider asset declares ${mediaTypeInput} but ${message} (first bytes: ${prefix || "empty"}).`,
    );
  };

  if (mediaType === "image/png") {
    if (
      !startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
      fail("does not contain PNG bytes");
    return;
  }
  if (mediaType === "image/jpeg") {
    if (
      !startsWithBytes(bytes, [0xff, 0xd8, 0xff]) ||
      bytes.at(-2) !== 0xff ||
      bytes.at(-1) !== 0xd9
    )
      fail("does not contain JPEG bytes");
    return;
  }
  if (mediaType === "image/webp") {
    if (!asciiAt(bytes, 0, "RIFF") || !asciiAt(bytes, 8, "WEBP"))
      fail("does not contain WebP bytes");
    return;
  }
  if (mediaType === "image/gif") {
    if (!asciiAt(bytes, 0, "GIF87a") && !asciiAt(bytes, 0, "GIF89a"))
      fail("does not contain GIF bytes");
    return;
  }
  if (
    mediaType === "video/mp4" ||
    mediaType === "video/quicktime" ||
    mediaType === "audio/mp4"
  ) {
    if (!asciiAt(bytes, 4, "ftyp"))
      fail("does not contain an MP4 file type box");
    return;
  }
  if (mediaType === "video/webm") {
    if (!startsWithBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3]))
      fail("does not contain a WebM EBML header");
    return;
  }
  if (mediaType === "audio/wav" || mediaType === "audio/x-wav") {
    if (!asciiAt(bytes, 0, "RIFF") || !asciiAt(bytes, 8, "WAVE"))
      fail("does not contain WAV bytes");
    return;
  }
  if (mediaType === "audio/mpeg" || mediaType === "audio/mp3") {
    const id3 = asciiAt(bytes, 0, "ID3");
    const frame =
      bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
    if (!id3 && !frame) fail("does not contain MP3 bytes");
    return;
  }
  if (mediaType === "audio/ogg") {
    if (!asciiAt(bytes, 0, "OggS")) fail("does not contain Ogg bytes");
    return;
  }
  if (mediaType === "audio/flac") {
    if (!asciiAt(bytes, 0, "fLaC")) fail("does not contain FLAC bytes");
    return;
  }
  if (mediaType === "audio/l16" || mediaType === "audio/pcm") {
    if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0)
      fail("does not contain whole 16-bit PCM samples");
    return;
  }
  if (mediaType === "model/gltf-binary") {
    if (!asciiAt(bytes, 0, "glTF"))
      fail("does not contain a glTF binary magic header");
    return;
  }
  if (mediaType === "model/gltf+json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      fail("does not contain glTF JSON content");
    }
    if (!isObject(parsed) || !("asset" in parsed))
      fail("does not contain glTF JSON content");
    return;
  }
  fail("has no registered replay format validator");
}

async function jsonResponse<T extends JsonObject = JsonObject>(
  response: Response,
): Promise<T> {
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  }
  return requiredObject(body, "local-api response") as T;
}

function requiredObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new Error(`${label} is missing`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is missing`);
  }
  return value;
}

export function providerTestExecutedNodeId(
  caseId: string,
  response: JsonObject,
): string {
  if (typeof response.error === "string" && response.error.length > 0) {
    throw new Error(`${caseId} execute failed: ${response.error}`);
  }
  return requiredString(response.childNodeId, `${caseId} output node id`);
}

export function providerTestAddedNodeId(
  caseId: string,
  response: JsonObject,
): string {
  if (typeof response.error === "string" && response.error.length > 0) {
    throw new Error(`${caseId} add failed: ${response.error}`);
  }
  return requiredString(response.node_id, `${caseId} action node id`);
}

export function createProviderReplayOfflineFetch(
  nativeFetch: typeof fetch,
): typeof fetch {
  return (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" ||
        url.hostname === "localhost" ||
        url.hostname === "::1")
    ) {
      return nativeFetch(input, init);
    }
    throw new Error(`Offline provider replay blocked network fetch: ${rawUrl}`);
  }) as typeof fetch;
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

/** Stable producer identity for one authored reference across replay attempts. */
export function providerTestReferenceAssetId(
  caseId: string,
  referenceIndex: number,
): string {
  return `asset:provider-test:${safeSegment(caseId)}:reference:${referenceIndex}`;
}

function extensionForReference(ref: ProviderTestReference): string {
  if (ref.originalName) {
    const extension = extname(ref.originalName);
    if (extension) return extension;
  }
  if (ref.mediaType === "image/jpeg") return ".jpg";
  if (ref.mediaType === "image/webp") return ".webp";
  if (ref.mediaType === "video/mp4") return ".mp4";
  if (ref.mediaType === "audio/wav") return ".wav";
  if (ref.mediaType === "audio/mpeg") return ".mp3";
  if (ref.mediaType === "model/gltf-binary") return ".glb";
  if (ref.mediaType === "model/gltf+json") return ".gltf";
  return ref.kind === "image"
    ? ".png"
    : ref.kind === "video"
      ? ".mp4"
      : ref.kind === "model"
        ? ".glb"
        : ".mp3";
}

function providerConformanceStubForCase(
  account: ProviderTestAccount,
  graderCase: ProviderReplayTestCase,
): ProviderConformanceStub {
  const matches = createProviderConformanceStubs().filter(
    (stub) =>
      stub.providerId === account.providerId &&
      (!account.upstreamId || stub.upstreamId === account.upstreamId) &&
      (stub.region ?? "") === (account.region ?? "") &&
      stub.modelId === graderCase.modelId,
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(
      `Provider replay test model ${graderCase.modelId} has ambiguous conformance stubs`,
    );
  }
  const shape = graderCase.expect.kind;
  return {
    id: [
      account.providerId,
      account.upstreamId ?? account.providerId,
      account.region ?? "",
      graderCase.modelId,
    ].join(":"),
    providerId: account.providerId,
    upstreamId: account.upstreamId ?? account.providerId,
    ...(account.region ? { region: account.region } : {}),
    modelId: graderCase.modelId,
    modelName: graderCase.modelId,
    shape,
    apiShape: account.upstreamId ?? account.providerId,
    requiredCredentials: [],
    requiredOAuth: [],
    input: {
      shape,
      model: graderCase.modelId,
      prompt: graderCase.prompt,
    },
  };
}
