/**
 * Shared Project Host contract: one Vitest suite every server adapter
 * (local-api, api-node, api-cf) runs against its real HTTP app.
 *
 * Cases go through HTTP with the clients the UI uses -- the asset-sdk
 * `ProjectAssetHttpClient`, `createTimelineClient`/`sendProjectHostCommand` --
 * and the plugin catalog endpoints. A `supported` capability must keep its
 * semantics; an `unavailable` one must say so (501, or absence from the
 * catalog). A 404 never counts as an answer: that is how a missing adapter
 * route hid the hosted editor regression.
 *
 * Test-only entry (`@clash/shared-runtime/project-host-contract`); it imports
 * Vitest and is not exported from the package root.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createProjectAssetHttpClient,
  ProjectAssetHttpError,
  type ProjectAssetHttpClient,
} from "@clash/asset-sdk";
import {
  DEFAULT_CANVAS_ID,
  projectTimelineRenderActionRunId,
  type ProjectHostCommand,
  type ResolvedAsset,
} from "@clash/shared-types";
import {
  ProjectHostHttpError,
  projectHostCommandUrl,
} from "../project-host-http.js";
import { textRevisionContentHash } from "../cloud-project-host/text-revisions.js";
import {
  createTimelineClient,
  type ObservedProjectTimeline,
} from "../timeline-client.js";
import {
  EDITOR_REQUIRED_CAPABILITIES,
  PROJECT_HOST_CAPABILITIES,
  type CapabilityId,
  type ContractCapabilities,
} from "./capabilities.js";

export {
  EDITOR_REQUIRED_CAPABILITIES,
  PROJECT_HOST_CAPABILITIES,
  type CapabilityId,
  type ContractCapabilities,
} from "./capabilities.js";

/** File name of the checked-in sample video under `./fixtures/`. */
export const CONTRACT_SAMPLE_VIDEO_FILE = "sample-64x64-1s.mp4";

export interface ProjectHostContractHarness {
  /** Authenticated fetch into the adapter; must also serve projected media URLs. */
  fetch: typeof fetch;
  /** Origin the UI would use as its runtime API URL. */
  endpoint: string;
  /** An existing Project the authenticated user owns. */
  projectId: string;
  capabilities: ContractCapabilities;
  /**
   * How a `request_timeline_render` answer names its run. Cloud adapters
   * journal the shared pending render node under
   * `projectTimelineRenderActionRunId(renderNodeId)`; the local Host plans a
   * Generator Action run and names the render node after it.
   */
  timelineRenderRunId: "derived-from-render-node" | "names-render-node";
  /** Declared capabilities that do not meet the contract yet; their cases must fail. */
  knownGaps?: CapabilityId[];
  sampleVideo: { bytes: Uint8Array; fileName: string; contentType: string };
  close?: () => Promise<void>;
}

const READ_RECEIPT_PATTERN = /\S/;

export function describeProjectHostContract(
  name: string,
  setup: () => Promise<ProjectHostContractHarness>,
): void {
  describe(`Project Host contract: ${name}`, () => {
    let harness: ProjectHostContractHarness;
    let assets: ProjectAssetHttpClient;
    let timelines: ReturnType<typeof createTimelineClient>;
    let sequence = 0;
    // Ids only need to be unique within the adapter's fresh Project; the suite
    // takes no clock or randomness of its own (shared modules are port-only).
    const unique = (prefix: string) => `${prefix}-contract-${(sequence += 1)}`;

    beforeAll(async () => {
      harness = await setup();
      const url = (path: string) =>
        /^[a-z]+:/i.test(path) ? path : `${harness.endpoint}${path}`;
      assets = createProjectAssetHttpClient({
        endpoint: harness.endpoint,
        fetch: (input, init) => harness.fetch(input, init),
      });
      timelines = createTimelineClient({
        projectId: harness.projectId,
        request: (path, init) => harness.fetch(url(path), init),
      });
    }, 120_000);
    afterAll(async () => {
      await harness?.close?.();
    });

    const get = (path: string) => harness.fetch(`${harness.endpoint}${path}`);
    const command = (body: ProjectHostCommand) =>
      harness.fetch(projectHostCommandUrl(harness.endpoint, harness.projectId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const json = async (response: Response) =>
      (await response.json().catch(() => null)) as Record<string, any> | null;
    /** An unavailable command or route answers 501 COMMAND_UNAVAILABLE. */
    const expectUnavailable = async (response: Response) => {
      expect(response.status, "unavailable must answer 501, never 404").toBe(501);
      expect(await json(response)).toMatchObject({ code: "COMMAND_UNAVAILABLE" });
    };
    const statusOf = (error: unknown) =>
      error instanceof ProjectHostHttpError ||
      error instanceof ProjectAssetHttpError
        ? error.status
        : undefined;

    /**
     * Declare one capability's cases. The harness (and so its declarations)
     * exists only after `beforeAll`, so each case selects its variant at run
     * time; the other variant is skipped. A known gap works like `it.fails` at
     * capability granularity: its case failures are recorded and annotated,
     * and the gap's last test requires at least one of them, so it turns red
     * once the adapter meets the whole capability.
     */
    const capability = (
      id: CapabilityId,
      cases: {
        supported: Array<[string, () => Promise<void>]>;
        unavailable: () => Promise<void>;
      },
    ) => {
      describe(id, () => {
        type Variant = [
          "supported" | "unavailable",
          string,
          () => Promise<void>,
        ];
        const variants: Variant[] = [
          ...cases.supported.map(
            ([title, run]): Variant => ["supported", title, run],
          ),
          ["unavailable", "answers 501 or stays out of the catalog", cases.unavailable],
        ];
        const gap = () => harness.knownGaps?.includes(id) ?? false;
        const failures: string[] = [];
        for (const [variant, title, run] of variants)
          it(`${variant}: ${title}`, async (context) => {
            if (harness.capabilities[id] !== variant) return context.skip();
            if (!gap()) return run();
            try {
              await run();
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              failures.push(`${title}: ${reason}`);
              await context.annotate(`known gap ${id}: ${reason}`);
            }
          });
        it("known gap: still fails", async (context) => {
          if (!gap()) return context.skip();
          expect(
            failures,
            `${id} is listed in knownGaps but now meets the contract: remove it`,
          ).not.toEqual([]);
        });
      });
    };

    it("declares every editor-required capability supported", () => {
      for (const id of EDITOR_REQUIRED_CAPABILITIES)
        expect(harness.capabilities[id], id).toBe("supported");
      for (const id of harness.knownGaps ?? [])
        expect(PROJECT_HOST_CAPABILITIES).toContain(id);
    });

    // ─── Plugin catalog ──────────────────────────────────────────────
    const query = () => `?projectId=${encodeURIComponent(harness.projectId)}`;
    capability("catalog.generators", {
      supported: [
        [
          "lists and resolves the clash.timeline Generator Definition",
          async () => {
            const response = await get(`/api/v1/generator-definitions${query()}`);
            expect(response.status).toBe(200);
            const definitions = (await json(response))?.definitions;
            expect(Array.isArray(definitions)).toBe(true);
            const timeline = definitions.find(
              (definition: any) =>
                definition.projectionSurface?.id === "clash.timeline",
            );
            expect(timeline).toBeDefined();
            const resolved = await get(
              `/api/v1/generator-definitions/${encodeURIComponent(timeline.pluginId)}/${encodeURIComponent(timeline.definitionId)}${query()}`,
            );
            expect(resolved.status).toBe(200);
            expect((await json(resolved))?.definition).toEqual(timeline);
          },
        ],
      ],
      async unavailable() {
        const response = await get(`/api/v1/generator-definitions${query()}`);
        if (response.status === 501) return expectUnavailable(response);
        expect(response.status).toBe(200);
        expect((await json(response))?.definitions).toEqual([]);
      },
    });
    for (const [id, path, key] of [
      ["catalog.views", "/api/v1/plugin-views", "views"],
      ["catalog.actions", "/api/v1/plugin-actions", "actions"],
    ] as const)
      capability(id, {
        supported: [
          [
            `serves the ${key} catalog`,
            async () => {
              const response = await get(`${path}${query()}`);
              expect(response.status).toBe(200);
              const entries = (await json(response))?.[key];
              expect(Array.isArray(entries)).toBe(true);
              for (const entry of entries)
                expect(entry).toMatchObject(
                  key === "views"
                    ? { pluginId: expect.any(String), version: expect.any(String) }
                    : { id: expect.any(String) },
                );
            },
          ],
        ],
        async unavailable() {
          const response = await get(`${path}${query()}`);
          if (response.status === 501) return expectUnavailable(response);
          expect(response.status).toBe(200);
          expect((await json(response))?.[key]).toEqual([]);
        },
      });

    // ─── Timeline Host commands ─────────────────────────────────────
    const createTimeline = () => {
      const id = unique("contract-timeline");
      return timelines.create({ id, name: `Contract ${id}`, state: { tracks: [] } });
    };
    const attach = (observed: ObservedProjectTimeline) =>
      timelines.attach(observed, {
        canvasId: DEFAULT_CANVAS_ID,
        actionNodeId: unique("contract-action"),
      });
    const unavailableTimelineCommand = (body: ProjectHostCommand) => async () =>
      expectUnavailable(await command(body));

    capability("timeline.list", {
      supported: [
        [
          "lists Timelines with an observation for each",
          async () => {
            const listed = await timelines.list();
            for (const observed of listed)
              expect(observed.readToken).toEqual(expect.any(String));
          },
        ],
      ],
      unavailable: unavailableTimelineCommand({ action: "list_timelines" }),
    });
    capability("timeline.create", {
      supported: [
        [
          "creates a Timeline that the list then shows",
          async () => {
            const created = await createTimeline();
            expect(created.timeline.owner).toEqual({ kind: "project" });
            expect(created.timeline.state).toEqual({ tracks: [] });
            if (harness.capabilities["timeline.list"] === "supported")
              expect(
                (await timelines.list()).map((observed) => observed.timeline),
              ).toContainEqual(created.timeline);
          },
        ],
      ],
      unavailable: unavailableTimelineCommand({
        action: "create_timeline",
        timelineId: unique("contract-timeline"),
        name: "Contract",
        state: { tracks: [] },
      }),
    });
    capability("timeline.update", {
      supported: [
        [
          "applies a state with the observed readToken",
          async () => {
            const created = await createTimeline();
            const observed =
              harness.capabilities["timeline.list"] === "supported"
                ? (await timelines.list()).find(
                    (entry) => entry.timeline.id === created.timeline.id,
                  )!
                : created;
            const applied = await timelines.apply(observed, {
              tracks: [],
              fps: 24,
            });
            expect(applied.timeline.state).toEqual({ tracks: [], fps: 24 });
            expect(applied.timeline.revisionId).not.toBe(
              created.timeline.revisionId,
            );
          },
        ],
        [
          "rejects a stale readToken with 409",
          async () => {
            const created = await createTimeline();
            await timelines.apply(created, { tracks: [], fps: 30 });
            const stale = await timelines
              .apply(created, { tracks: [], fps: 25 })
              .then(
                () => undefined,
                (error: unknown) => error,
              );
            expect(stale, "a stale write must be rejected").toBeInstanceOf(Error);
            expect(statusOf(stale), String(stale)).toBe(409);
          },
        ],
      ],
      unavailable: unavailableTimelineCommand({
        action: "update_timeline_state",
        timelineId: unique("contract-timeline"),
        state: { tracks: [] },
      }),
    });
    capability("timeline.attach", {
      supported: [
        [
          "places a Timeline on a Canvas",
          async () => {
            const attached = await attach(await createTimeline());
            expect(attached.timeline.owner).toMatchObject({
              kind: "canvas-action",
              canvasId: DEFAULT_CANVAS_ID,
            });
          },
        ],
      ],
      unavailable: unavailableTimelineCommand({
        action: "attach_timeline",
        timelineId: unique("contract-timeline"),
        canvasId: DEFAULT_CANVAS_ID,
      }),
    });
    capability("timeline.detach", {
      supported: [
        [
          "returns a placed Timeline to the Project",
          async () => {
            const detached = await timelines.detach(
              await attach(await createTimeline()),
            );
            expect(detached.timeline.owner).toEqual({ kind: "project" });
          },
        ],
      ],
      unavailable: unavailableTimelineCommand({
        action: "detach_timeline",
        timelineId: unique("contract-timeline"),
      }),
    });
    capability("timeline.delete", {
      supported: [
        [
          "deletes a Timeline",
          async () => {
            const created = await createTimeline();
            await timelines.remove(created);
            if (harness.capabilities["timeline.list"] === "supported")
              expect(
                (await timelines.list()).map((observed) => observed.timeline.id),
              ).not.toContain(created.timeline.id);
          },
        ],
      ],
      unavailable: unavailableTimelineCommand({
        action: "delete_timeline",
        timelineId: unique("contract-timeline"),
      }),
    });
    capability("timeline.render", {
      supported: [
        [
          "submits a render of the observed revision",
          async () => {
            const id = unique("contract-render-timeline");
            const created = await timelines.create({
              id,
              name: `Render ${id}`,
              state: {
                tracks: [
                  {
                    id: "track",
                    items: [
                      {
                        id: "title",
                        type: "text",
                        text: "Contract",
                        from: 0,
                        durationInFrames: 30,
                      },
                    ],
                  },
                ],
              },
            });
            const submitted = await timelines.render(created);
            expect(submitted.renderNodeId).toEqual(expect.any(String));
            expect(submitted.actionRunId).toBe(
              harness.timelineRenderRunId === "derived-from-render-node"
                ? projectTimelineRenderActionRunId(submitted.renderNodeId)
                : submitted.renderNodeId,
            );
          },
        ],
      ],
      async unavailable() {
        const created =
          harness.capabilities["timeline.create"] === "supported"
            ? await createTimeline()
            : undefined;
        await expectUnavailable(
          await command({
            action: "request_timeline_render",
            timelineId: created?.timeline.id ?? unique("contract-timeline"),
            actorClientType: "browser",
            ...(created ? { ifMatch: created.readToken } : {}),
          }),
        );
      },
    });

    // ─── Project Assets ─────────────────────────────────────────────
    const importVideo = async (): Promise<ResolvedAsset> =>
      assets.importFile({
        projectId: harness.projectId,
        projectAssetId: unique("asset:contract"),
        kind: "video",
        file: new File([harness.sampleVideo.bytes as Uint8Array<ArrayBuffer>], harness.sampleVideo.fileName, {
          type: harness.sampleVideo.contentType,
        }),
      });
    const expectPlayable = (asset: ResolvedAsset | undefined) => {
      expect(asset).toMatchObject({ kind: "video", status: "ready" });
      expect(asset?.url).toEqual(expect.any(String));
    };
    const assetPath = (suffix = "") =>
      `/api/v1/projects/${encodeURIComponent(harness.projectId)}/assets${suffix}`;

    capability("assets.import", {
      supported: [
        [
          "imports a video as a ready Asset",
          async () => {
            const imported = await importVideo();
            expectPlayable(imported);
            expect(imported.lifecycle).toEqual({ state: "active" });
          },
        ],
      ],
      async unavailable() {
        const response = await harness.fetch(
          `${harness.endpoint}${assetPath("/import-file")}?kind=video&projectAssetId=${encodeURIComponent(unique("asset:contract"))}&fileName=${encodeURIComponent(harness.sampleVideo.fileName)}`,
          {
            method: "POST",
            headers: { "content-type": harness.sampleVideo.contentType },
            body: harness.sampleVideo.bytes as Uint8Array<ArrayBuffer>,
          },
        );
        await expectUnavailable(response);
      },
    });
    capability("assets.import.chunked", {
      supported: [
        [
          "imports a file above the single-shot cap through a session",
          async () => {
            // A small client-side cap exercises the session path without a
            // 64 MiB fixture; the server cap itself is unchanged.
            const chunked = createProjectAssetHttpClient({
              endpoint: harness.endpoint,
              fetch: (input, init) => harness.fetch(input, init),
              singleShotMaxBytes: 1024,
            });
            expect(harness.sampleVideo.bytes.byteLength).toBeGreaterThan(1024);
            const imported = await chunked.importFile({
              projectId: harness.projectId,
              projectAssetId: unique("asset:chunked"),
              kind: "video",
              file: new File(
                [
                  harness.sampleVideo.bytes as Uint8Array<ArrayBuffer>,
                ],
                harness.sampleVideo.fileName,
                { type: harness.sampleVideo.contentType },
              ),
            });
            expectPlayable(imported);
          },
        ],
      ],
      async unavailable() {
        await expectUnavailable(
          await harness.fetch(
            `${harness.endpoint}${assetPath("/import-sessions")}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                kind: "video",
                projectAssetId: unique("asset:chunked"),
                fileName: harness.sampleVideo.fileName,
                byteLength: harness.sampleVideo.bytes.byteLength,
                contentType: harness.sampleVideo.contentType,
              }),
            },
          ),
        );
      },
    });
    capability("assets.list", {      supported: [
        [
          "lists an imported Asset as ready with a URL",
          async () => {
            const imported = await importVideo();
            const listed = await assets.list({ projectId: harness.projectId });
            expectPlayable(listed.find((asset) => asset.id === imported.id));
          },
        ],
      ],
      unavailable: async () => expectUnavailable(await get(assetPath())),
    });
    capability("assets.batch", {
      supported: [
        [
          "returns requested Assets and skips unknown ids",
          async () => {
            const imported = await importVideo();
            const batch = await assets.batch({
              projectId: harness.projectId,
              assetIds: [imported.id, unique("asset:missing")],
            });
            expect(batch.map((asset) => asset.id)).toEqual([imported.id]);
            expectPlayable(batch[0]);
          },
        ],
      ],
      async unavailable() {
        await expectUnavailable(
          await harness.fetch(`${harness.endpoint}${assetPath("/batch")}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ids: ["asset:missing"] }),
          }),
        );
      },
    });
    capability("assets.get", {
      supported: [
        [
          "reads one Asset with a read receipt",
          async () => {
            const imported = await importVideo();
            const observed = await assets.get({
              projectId: harness.projectId,
              assetId: imported.id,
            });
            expectPlayable(observed.value);
            expect(observed.receipt).toMatch(READ_RECEIPT_PATTERN);
          },
        ],
      ],
      unavailable: async () =>
        expectUnavailable(await get(assetPath(`/${encodeURIComponent("asset:missing")}`))),
    });
    capability("assets.references", {
      supported: [
        [
          "lists an Asset's references with a read receipt",
          async () => {
            const imported = await importVideo();
            const observed = await assets.references({
              projectId: harness.projectId,
              assetId: imported.id,
            });
            expect(observed.value).toEqual([]);
            expect(observed.receipt).toMatch(READ_RECEIPT_PATTERN);
          },
        ],
      ],
      unavailable: async () =>
        expectUnavailable(
          await get(assetPath(`/${encodeURIComponent("asset:missing")}/references`)),
        ),
    });
    capability("assets.media", {
      supported: [
        [
          "serves byte ranges of the projected URL",
          async () => {
            const imported = await importVideo();
            const response = await harness.fetch(imported.url!, {
              headers: { Range: "bytes=0-15" },
            });
            expect(response.status).toBe(206);
            const bytes = new Uint8Array(await response.arrayBuffer());
            expect(bytes.byteLength).toBe(16);
            expect([...bytes]).toEqual([
              ...harness.sampleVideo.bytes.subarray(0, 16),
            ]);
          },
        ],
      ],
      // Media is reached through projected URLs; without them nothing is listed.
      async unavailable() {
        if (harness.capabilities["assets.list"] !== "supported") return;
        for (const asset of await assets.list({ projectId: harness.projectId }))
          expect(asset.url).toBeUndefined();
      },
    });
    const trashed = async (deleteOperationId = unique("delete")) => {
      const imported = await importVideo();
      const observed = await assets.get({
        projectId: harness.projectId,
        assetId: imported.id,
      });
      const result = await assets.trash({
        projectId: harness.projectId,
        assetId: imported.id,
        deleteOperationId,
        actorClientType: "browser",
        receipt: observed.receipt,
      });
      return { ...result, observed, deleteOperationId };
    };
    const lifecycleOf = async (assetId: string) =>
      (await assets.list({ projectId: harness.projectId })).find(
        (asset) => asset.id === assetId,
      )?.lifecycle;
    capability("assets.trash", {
      supported: [
        [
          "moves an observed Asset to the trash and lists it there",
          async () => {
            const result = await trashed();
            expect(result.value.lifecycle).toMatchObject({
              state: "trashed",
              deleteOperationId: result.deleteOperationId,
            });
            expect(result.receipt).toMatch(READ_RECEIPT_PATTERN);
            expect(await lifecycleOf(result.value.id)).toMatchObject({
              state: "trashed",
            });
          },
        ],
        [
          "retries the same delete operation idempotently",
          async () => {
            const first = await trashed();
            const again = await assets.trash({
              projectId: harness.projectId,
              assetId: first.value.id,
              deleteOperationId: first.deleteOperationId,
              actorClientType: "browser",
              receipt: first.observed.receipt,
            });
            expect(again.value.lifecycle).toEqual(first.value.lifecycle);
          },
        ],
        [
          "rejects a delete based on a stale read with 409",
          async () => {
            const first = await trashed();
            const response = await harness.fetch(
              `${harness.endpoint}${assetPath(`/${encodeURIComponent(first.value.id)}`)}`,
              {
                method: "DELETE",
                headers: {
                  "content-type": "application/json",
                  "x-clash-client-type": "browser",
                  "x-clash-if-match": first.observed.receipt!,
                },
                body: JSON.stringify({ deleteOperationId: unique("delete") }),
              },
            );
            expect(response.status).toBe(409);
          },
        ],
        [
          "answers 404 for an unknown Asset",
          async () => {
            const response = await harness.fetch(
              `${harness.endpoint}${assetPath(`/${encodeURIComponent("asset:missing")}`)}`,
              {
                method: "DELETE",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ deleteOperationId: unique("delete") }),
              },
            );
            expect(response.status).toBe(404);
          },
        ],
      ],
      async unavailable() {
        await expectUnavailable(
          await harness.fetch(
            `${harness.endpoint}${assetPath(`/${encodeURIComponent("asset:missing")}`)}`,
            {
              method: "DELETE",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ deleteOperationId: unique("delete") }),
            },
          ),
        );
      },
    });
    capability("assets.restore", {
      supported: [
        [
          "restores a trashed Asset",
          async () => {
            const result = await trashed();
            const restored = await assets.restore({
              projectId: harness.projectId,
              assetId: result.value.id,
              actorClientType: "browser",
              receipt: result.receipt,
            });
            expect(restored.value.lifecycle).toEqual({ state: "active" });
            expect(await lifecycleOf(result.value.id)).toEqual({
              state: "active",
            });
            // The restored Asset still plays.
            const media = await harness.fetch(restored.value.url!, {
              headers: { Range: "bytes=0-15" },
            });
            expect(media.status).toBe(206);
          },
        ],
      ],
      async unavailable() {
        await expectUnavailable(
          await harness.fetch(
            `${harness.endpoint}${assetPath(`/${encodeURIComponent("asset:missing")}/restore`)}`,
            { method: "POST" },
          ),
        );
      },
    });

    // Version history for `clash text apply`: immutable revision metadata plus
    // a content-addressed Markdown body, read back for diff/restore.
    const textRevision = (content: string, revisionId: string, extra = {}) => {
      const hash = textRevisionContentHash(content);
      return {
        schemaVersion: 1,
        kind: "clash.text.revision",
        textId: "contract-text",
        revisionId,
        projectId: harness.projectId,
        nodeId: "contract-text-node",
        createdAt: new Date(Date.UTC(2026, 0, 1) + sequence * 1000).toISOString(),
        contentHash: hash,
        hashAlgorithm: "sha256-64",
        sourceFilePath: "texts/contract.md",
        sourceFileHash: hash,
        ...extra,
      };
    };
    const indexRevision = (body: unknown) =>
      harness.fetch(`${harness.endpoint}/api/v1/text-revisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const revisionsPath = () =>
      `/api/v1/projects/${encodeURIComponent(harness.projectId)}/text-revisions`;
    capability("text.revisions", {
      supported: [
        [
          "indexes a revision, lists it with stored content and serves the verified body",
          async () => {
            const first = textRevision("# Draft\n", unique("rev"));
            const second = textRevision("# Draft\n\nMore.\n", unique("rev"), {
              parentRevisionId: first.revisionId,
            });
            for (const [revision, content] of [
              [first, "# Draft\n"],
              [second, "# Draft\n\nMore.\n"],
            ] as const) {
              const response = await indexRevision({ revision, content });
              expect(response.status).toBe(200);
              expect((await json(response))?.content).toMatchObject({
                stored: true,
                contentHash: revision.contentHash,
              });
            }
            const listed = await get(
              `${revisionsPath()}?nodeId=contract-text-node&limit=200`,
            );
            expect(listed.status).toBe(200);
            const entries = (await json(listed))?.revisions as any[];
            const ids = entries.map((entry) => entry.revisionId);
            expect(ids).toContain(first.revisionId);
            expect(ids.indexOf(second.revisionId)).toBeLessThan(
              ids.indexOf(first.revisionId),
            );
            const entry = entries.find((e) => e.revisionId === second.revisionId);
            expect(entry.content).toMatchObject({ stored: true });
            const body = await harness.fetch(
              /^[a-z]+:/i.test(entry.content.url)
                ? entry.content.url
                : `${harness.endpoint}${entry.content.url}`,
            );
            expect(body.status).toBe(200);
            expect(body.headers.get("x-clash-content-hash")).toBe(
              second.contentHash,
            );
            expect(await body.text()).toBe("# Draft\n\nMore.\n");
          },
        ],
        [
          "is idempotent for the same revision and 409s on conflicting metadata",
          async () => {
            const revision = textRevision("same\n", unique("rev"));
            expect((await indexRevision({ revision, content: "same\n" })).status).toBe(200);
            expect((await indexRevision({ revision, content: "same\n" })).status).toBe(200);
            expect(
              (await indexRevision({ revision: { ...revision, textId: "other" } }))
                .status,
            ).toBe(409);
          },
        ],
        [
          "rejects a content hash mismatch and answers 404 for unknown revisions",
          async () => {
            const revision = textRevision("a\n", unique("rev"));
            expect(
              (await indexRevision({ revision, content: "not a\n" })).status,
            ).toBe(400);
            expect(
              (await get(`${revisionsPath()}/${unique("missing")}/content`)).status,
            ).toBe(404);
          },
        ],
      ],
      async unavailable() {
        await expectUnavailable(await get(revisionsPath()));
        await expectUnavailable(
          await indexRevision({ revision: textRevision("x", unique("rev")) }),
        );
      },
    });
  });
}
