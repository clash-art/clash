import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assemblePluginModule,
  defineAction,
  servePluginStdio,
  type ExecutorContext,
  type PluginModule,
} from "@clash/action-sdk";
import {
  ExecutablePluginInvocationSchema,
  type ExecutablePluginInvocation,
  type ExecutablePluginReference,
} from "@clash/shared-types/executable-plugin";
import { ProjectTimelineEnvelopeSchema } from "@clash/shared-types/timeline-envelope";
import {
  renderMedia as remotionRenderMedia,
  selectComposition as remotionSelectComposition,
} from "@remotion/renderer";

export const REMOTION_RENDER_ACTION_ID = "render-timeline";
// Declared by this plugin's shipped generators/timeline.json output contract.
const REMOTION_RENDER_OUTPUT_SLOT = "render:output";

type RendererApi = {
  selectComposition(options: Record<string, unknown>): Promise<unknown>;
  renderMedia(options: Record<string, unknown>): Promise<unknown>;
};

export type RemotionPluginServices = {
  browserBundlePath: string;
  renderer: RendererApi;
};

type TimelineRenderInput = {
  tracks?: unknown;
  compositionWidth?: unknown;
  compositionHeight?: unknown;
  fps?: unknown;
  durationInFrames?: unknown;
  [key: string]: unknown;
};

function positiveNumber(
  value: unknown,
  fallback: number,
  label: string,
): number {
  const candidate = value === undefined ? fallback : value;
  if (
    typeof candidate !== "number" ||
    !Number.isFinite(candidate) ||
    candidate <= 0
  ) {
    throw new Error(`Timeline render requires a positive ${label}`);
  }
  return candidate;
}

function frozenTimelineValue(invocation: ExecutablePluginInvocation) {
  const parsed = ProjectTimelineEnvelopeSchema.safeParse(
    invocation.input.values.timeline,
  );
  if (!parsed.success) {
    throw new Error(
      `Remotion render requires a valid shared frozen Timeline envelope: ${parsed.error.message}`,
    );
  }
  const envelope = parsed.data;
  const timeline = structuredClone(envelope.state) as TimelineRenderInput;
  if (!Array.isArray(timeline.tracks)) {
    throw new Error("Remotion render requires a Timeline tracks array.");
  }
  return {
    ...timeline,
    tracks: timeline.tracks,
    compositionWidth: positiveNumber(
      timeline.compositionWidth,
      1920,
      "composition width",
    ),
    compositionHeight: positiveNumber(
      timeline.compositionHeight,
      1080,
      "composition height",
    ),
    fps: positiveNumber(timeline.fps, 30, "fps"),
    durationInFrames: positiveNumber(
      timeline.durationInFrames,
      300,
      "duration",
    ),
  } as Record<string, any>;
}

function referencesBySlot(
  references: readonly ExecutablePluginReference[],
): Map<string, ExecutablePluginReference> {
  const result = new Map<string, ExecutablePluginReference>();
  for (const reference of references) {
    if (!("asset" in reference)) continue;
    if (result.has(reference.slot)) {
      throw new Error(`Remotion render received duplicate ${reference.slot}.`);
    }
    result.set(reference.slot, reference);
  }
  return result;
}

async function injectExecutorUrls(
  timeline: Record<string, any>,
  invocation: ExecutablePluginInvocation,
  context: ExecutorContext,
): Promise<void> {
  const references = referencesBySlot(invocation.input.references);
  for (const track of timeline.tracks) {
    for (const item of track?.items ?? []) {
      if (
        item?.type !== "image" &&
        item?.type !== "video" &&
        item?.type !== "audio"
      ) {
        continue;
      }
      const itemId = typeof item.id === "string" ? item.id.trim() : "";
      if (!itemId) {
        throw new Error("Remotion Timeline media items require a stable id.");
      }
      const slot = `timeline:item:${itemId}`;
      const reference = references.get(slot);
      if (!reference || !("asset" in reference) || reference.index !== 0) {
        throw new Error(`Remotion render is missing frozen reference ${slot}.`);
      }
      if (reference.asset.kind !== item.type) {
        throw new Error(
          `Remotion render reference ${slot} is ${reference.asset.kind}, not ${item.type}.`,
        );
      }
      const resolved = await context.reference(reference);
      if (resolved.form !== "executor-url") {
        throw new Error(
          `Remotion render requires executor-url delivery for ${slot}; received ${resolved.form}.`,
        );
      }
      item.src = resolved.executorUrl;
    }
  }
}

function safeTaskSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-") || "timeline";
}

async function renderTimeline(
  input: unknown,
  context: ExecutorContext,
  services: RemotionPluginServices,
) {
  const invocation = ExecutablePluginInvocationSchema.parse(input);
  const timeline = frozenTimelineValue(invocation);
  await injectExecutorUrls(timeline, invocation, context);
  const directory = await mkdtemp(join(tmpdir(), "clash-remotion-plugin-"));
  const outputPath = join(
    directory,
    `${safeTaskSegment(invocation.taskId)}.mp4`,
  );
  try {
    const composition = await services.renderer.selectComposition({
      serveUrl: services.browserBundlePath,
      id: "VideoComposition",
      inputProps: timeline,
    });
    await services.renderer.renderMedia({
      composition,
      serveUrl: services.browserBundlePath,
      codec: "h264",
      outputLocation: outputPath,
      inputProps: timeline,
    });
    return {
      status: "completed" as const,
      media: {
        [REMOTION_RENDER_OUTPUT_SLOT]: {
          bytes: await readFile(outputPath),
          mediaType: "video/mp4",
          kind: "video" as const,
        },
      },
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const manifestDirectory = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
);

const defaultServices: RemotionPluginServices = {
  browserBundlePath: fileURLToPath(
    new URL("./browser-bundle/", import.meta.url),
  ),
  renderer: {
    selectComposition: (options) =>
      remotionSelectComposition(
        options as Parameters<typeof remotionSelectComposition>[0],
      ),
    renderMedia: (options) =>
      remotionRenderMedia(options as Parameters<typeof remotionRenderMedia>[0]),
  },
};

export function createRemotionPlugin(
  services: RemotionPluginServices = defaultServices,
): PluginModule {
  return assemblePluginModule({
    manifestDir: manifestDirectory,
    contributes: {
      [REMOTION_RENDER_ACTION_ID]: defineAction({
        run: (invocation, context) =>
          renderTimeline(invocation, context, services),
      }),
    },
  });
}

export const plugin = createRemotionPlugin();

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  void servePluginStdio(plugin).done;
}
