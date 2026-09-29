import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { plugin } from "./stdio.js";

const execFileAsync = promisify(execFile);

describe("Asset Edit bundled PluginModule", () => {
  it("executes a native image-editor Generator invocation through the shared module", async () => {
    const source = new Uint8Array(
      await sharp({
        create: {
          width: 4,
          height: 2,
          channels: 4,
          background: { r: 255, g: 0, b: 0, alpha: 1 },
        },
      })
        .png()
        .toBuffer(),
    );
    let uploaded: Uint8Array | undefined;
    const upload = vi.fn(async (request: { bytes?: Uint8Array }) => {
      uploaded = request.bytes;
      return {
        slot: "output",
        kind: "asset" as const,
        asset: {
          assetId: "asset:edited",
          uri: "clash-asset://asset:edited",
          kind: "image" as const,
          mediaType: "image/png",
        },
      };
    });

    const result = await plugin.invoke(
      {
        protocol: "clash.plugin.invoke/v1",
        invocationId: "invocation-1",
        taskId: "run-1",
        projectId: "project-1",
        target: {
          pluginId: "clash.asset-edit",
          version: "1.0.0",
          exportId: "image-editor",
          schemaHash: `sha256:${"c".repeat(64)}`,
          kind: "action",
        },
        operation: "submit",
        input: {
          values: {
            __generatorActionId: "transform",
            crop: { x: 0, y: 0, width: 2, height: 1 },
            rotation: 90,
          },
          references: [
            {
              slot: "source",
              index: 0,
              asset: {
                assetId: "asset:source",
                uri: "clash-asset://asset:source",
                kind: "image",
                mediaType: "image/png",
              },
            },
          ],
        },
        assetInputs: [],
        actor: { kind: "agent", id: "agent-1" },
      },
      {
        reference: async () => ({
          form: "bytes",
          bytes: source,
          kind: "image",
          mediaType: "image/png",
        }),
        upload,
      },
    );

    expect(result).toMatchObject({
      status: "completed",
      outputs: [{ asset: { assetId: "asset:edited" } }],
    });
    expect(upload).toHaveBeenCalledOnce();
    expect(await sharp(uploaded).metadata()).toMatchObject({
      width: 1,
      height: 2,
      format: "png",
    });
  });

  it.each([false, true])(
    "crops the requested range accurately (audio: %s)",
    async (withAudio) => {
      const directory = await mkdtemp(join(tmpdir(), "clash-edit-test-"));
      const sourcePath = join(directory, "source.mp4");
      try {
        await execFileAsync(ffmpegInstaller.path, [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=blue:s=16x16:r=25:d=2",
          ...(withAudio
            ? ["-f", "lavfi", "-i", "sine=frequency=440:duration=2"]
            : []),
          "-pix_fmt",
          "yuv420p",
          sourcePath,
        ]);
        const source = new Uint8Array(await readFile(sourcePath));
        let uploaded: Uint8Array | undefined;

        const result = await plugin.invoke(
          {
            protocol: "clash.plugin.invoke/v1",
            invocationId: "invocation-crop",
            taskId: "run-crop",
            projectId: "project-1",
            target: {
              pluginId: "clash.asset-edit",
              version: "1.0.0",
              exportId: "video-clipper",
              schemaHash: `sha256:${"d".repeat(64)}`,
              kind: "action",
            },
            operation: "submit",
            input: {
              values: {
                __generatorActionId: "crop",
                startSec: 0.4,
                endSec: 1.4,
              },
              references: [
                {
                  slot: "source",
                  index: 0,
                  asset: {
                    assetId: "asset:source-video",
                    uri: "clash-asset://asset:source-video",
                    kind: "video",
                    mediaType: "video/mp4",
                  },
                },
              ],
            },
            assetInputs: [],
            actor: { kind: "agent", id: "agent-1" },
          },
          {
            reference: async () => ({
              form: "bytes",
              bytes: source,
              kind: "video",
              mediaType: "video/mp4",
            }),
            upload: async (request) => {
              uploaded = request.bytes;
              return {
                slot: "output",
                kind: "asset",
                asset: {
                  assetId: "asset:cropped",
                  uri: "clash-asset://asset:cropped",
                  kind: "video",
                  mediaType: "video/mp4",
                },
              };
            },
          },
        );

        expect(result).toMatchObject({
          status: "completed",
          outputs: [{ asset: { assetId: "asset:cropped", kind: "video" } }],
        });
        expect(uploaded?.byteLength).toBeGreaterThan(0);
        expect(
          Buffer.from(uploaded ?? [])
            .subarray(4, 8)
            .toString("ascii"),
        ).toBe("ftyp");
        const outputPath = join(directory, "cropped.mp4");
        await writeFile(outputPath, uploaded!);
        const decoded = await execFileAsync(
          ffmpegInstaller.path,
          [
            "-i",
            outputPath,
            "-map",
            "0:v:0",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
          ],
          { encoding: "buffer" },
        );
        // The fixture has 25 frames/second; a one-second crop must decode to 25 frames.
        expect(decoded.stdout.byteLength / (16 * 16 * 3)).toBe(25);
        const metadata = decoded.stderr.toString();
        const duration = Number(
          metadata.match(/Duration: 00:00:(\d+\.\d+)/)?.[1],
        );
        expect(Math.abs(duration - 1)).toBeLessThan(1 / 25);
        expect(metadata.includes("Audio:")).toBe(withAudio);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
