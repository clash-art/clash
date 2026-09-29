import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { readLocalLogs } from "@clash/shared-runtime/log-reader";
import { createLocalMediaAnalysisService } from "./local-media-analysis.js";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "retains private-safe parse evidence for refinement=%s through the offline log reader",
  async (refinement) => {
    const root = await mkdtemp(join(tmpdir(), "clash-analysis-diagnostic-"));
    try {
      await mkdir(join(root, "local-api"));
      const file = join(root, "local-api", "local-api-analysis.jsonl");
      vi.spyOn(console, "warn").mockImplementation((line) =>
        appendFileSync(file, String(line) + "\n"),
      );
      // A malformed model reply can echo arbitrary prompt text or credentials.
      const text =
        '```json\n{"private":"Bearer unique-secret sk-private-key https://host/?key=private-key", "cut": }\n```' +
        " ".repeat(20000);
      const route = {
        providerId: "provider",
        accountId: "private-account",
        upstreamId: "upstream",
        upstreamModel: "model-endpoint",
        apiShape: "shape",
      };
      let calls = 0;
      const service = createLocalMediaAnalysisService({
        config: {
          get: async () => ({
            videoEnabled: true,
            modelId: "model",
            allowedCategories: null,
            video: {
              fps: 2,
              mediaResolution: "medium",
              boundaryRefinement: {
                enabled: refinement,
                fps: 12,
                safetyMarginSeconds: 0.75,
              },
            },
          }),
          assertRunnable: async () => ({
            id: "model",
            name: "Model",
            provider: "provider",
            route: "shape",
            consumer: { pluginId: "consumer" },
            visibility: "plugin-private",
            underlyingModel: "model-endpoint",
            implementation: route,
            sourceKinds: ["video"],
          }),
        },
        aigc: {
          generateText: async () => {
            calls += 1;
            return {
              text:
                refinement && calls === 1
                  ? '{"scenes":[{"startMs":0,"endMs":2000},{"startMs":2000,"endMs":4000}]}'
                  : text,
            };
          },
        },
      });
      const runId = `analysis-${refinement}`;
      const error = await service
        .analyze({
          projectId: "project",
          invocationId: "invocation",
          taskId: runId,
          reference: {
            slot: "source",
            index: 0,
            asset: {
              assetId: "source",
              uri: "clash-asset://source",
              kind: "video",
              mediaType: "video/mp4",
            },
          },
          modelId: "model",
          route,
          category: refinement ? "scene-shot" : "description",
          prompt: "private prompt",
          promptVersion: "v1",
        })
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      const logs = await readLocalLogs({
        directory: root,
        projectId: "project",
        assetId: "source",
      });
      expect(logs.records).toHaveLength(1);
      const context = logs.records[0]!.context;
      expect(context).toMatchObject({
        actionRunId: runId,
        invocationId: "invocation",
        modelId: "model",
        providerId: "provider",
      });
      expect(context.stage).toBe(
        refinement ? "boundary-refinement" : "initial",
      );
      expect(context.responseEvidence).toMatchObject({
        byteLength: Buffer.byteLength(text),
        sha256: createHash("sha256").update(text).digest("hex"),
      });
      const serialized = JSON.stringify(logs) + inspect(error, { depth: 5 });
      expect(serialized).not.toMatch(
        /unique-secret|sk-private-key|private-account|private prompt|key=private-key/,
      );
      expect(JSON.stringify(context.responseEvidence).length).toBeLessThan(
        4000,
      );
      expect(calls).toBe(refinement ? 2 : 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
