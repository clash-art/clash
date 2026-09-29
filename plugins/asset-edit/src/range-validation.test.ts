import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import type { ExecutablePluginJsonValue } from "@clash/shared-types/executable-plugin";
import { plugin } from "./stdio.js";

function invoke(
  kind: "image" | "video",
  values: Record<string, ExecutablePluginJsonValue>,
  bytes: Uint8Array,
) {
  const upload = vi.fn(async () => {
    throw new Error("Out-of-range edits must not publish an output");
  });
  const result = plugin.invoke(
    {
      protocol: "clash.plugin.invoke/v1",
      invocationId: "range-test",
      taskId: "range-test",
      projectId: "project",
      target: {
        pluginId: "clash.asset-edit",
        version: "1.0.0",
        exportId: kind === "image" ? "image-editor" : "video-clipper",
        schemaHash: `sha256:${"a".repeat(64)}`,
        kind: "action",
      },
      operation: "submit",
      actor: { kind: "agent", id: "test" },
      assetInputs: [],
      input: {
        values,
        references: [
          {
            slot: "source",
            index: 0,
            asset: { assetId: "source", uri: "clash-asset://source", kind },
          },
        ],
      },
    },
    { reference: async () => ({ form: "bytes", bytes, kind }), upload },
  );
  return { result, upload };
}

it("rejects image crops extending past the real source before publishing output", async () => {
  const bytes = await sharp({
    create: { width: 8, height: 4, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const { result, upload } = invoke(
    "image",
    {
      __generatorActionId: "transform",
      crop: { x: 7, y: 0, width: 2, height: 2 },
    },
    bytes,
  );
  await expect(result).rejects.toMatchObject({
    failure: {
      code: "invalid_request",
      retryable: false,
      requestState: "rejected",
      message: expect.stringMatching(/crop.*source|source.*crop/i),
    },
  });
  expect(upload).not.toHaveBeenCalled();
});

it("rejects screenshot and trim times outside the source video with an actionable range error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clash-edit-range-"));
  try {
    const path = join(dir, "source.mp4");
    await promisify(execFile)(ffmpeg.path, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=16x16:r=25:d=2",
      "-pix_fmt",
      "yuv420p",
      path,
    ]);
    const bytes = await readFile(path);
    const requests: Array<Record<string, ExecutablePluginJsonValue>> = [
      { __generatorActionId: "screenshot", frameTimeSec: 2 },
      { __generatorActionId: "screenshot", frameTimeSec: 999 },
      { __generatorActionId: "crop", startSec: 0.4, endSec: 2.5 },
      { __generatorActionId: "crop", startSec: 2, endSec: 3 },
    ];
    for (const values of requests) {
      const { result, upload } = invoke("video", values, bytes);
      await expect(result).rejects.toMatchObject({
        failure: {
          code: "invalid_request",
          retryable: false,
          requestState: "rejected",
          message: expect.stringMatching(/duration|range/i),
        },
      });
      expect(upload).not.toHaveBeenCalled();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
