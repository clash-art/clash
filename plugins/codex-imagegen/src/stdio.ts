import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assemblePlugin,
  defineAction,
  type ExecutorContext,
} from "@clash/action-sdk";
import {
  ExecutablePluginAssetHandleSchema,
  ExecutablePluginInvocationSchema,
  ExecutablePluginResultSchema,
  aspectRatioLabel,
  parseAspectRatio,
  type ExecutablePluginInvocation,
  type ExecutablePluginResult,
} from "@clash/shared-types/executable-plugin";

export const CODEX_IMAGEGEN_ACTION_ID = "codex-imagegen";

export interface CodexImageGenServices {
  hostTools: Pick<ExecutorContext["hostTools"], "codexImagegen">;
}

function promptValue(invocation: ExecutablePluginInvocation): string {
  const value = invocation.input.values.prompt;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Codex ImageGen requires a non-empty prompt.");
  }
  const preferences: string[] = [];
  const labels: Record<string, string> = {
    image_model: "Requested image model (not the Codex text model)",
    quality: "Requested image rendering quality",
    resolution: "Target native image dimensions",
    background: "Requested background",
  };
  for (const [key, label] of Object.entries(labels)) {
    const selection = invocation.input.values[key];
    if (
      typeof selection === "string" &&
      selection.trim() &&
      selection !== "auto"
    ) {
      preferences.push(`${label}: ${selection.trim()}.`);
    }
  }
  if (!preferences.length) return value.trim();
  if (invocation.input.values.background === "transparent") {
    preferences.push(
      "Generate a truly transparent background with an alpha channel, not a checkerboard illustration.",
    );
  }
  if (
    invocation.input.values.resolution &&
    invocation.input.values.resolution !== "auto"
  ) {
    preferences.push(
      "Prioritize the requested aspect ratio if it differs from the target dimensions. Approximate native dimensions are acceptable; preserve the generated image without resizing.",
    );
  }
  return [
    value.trim(),
    "",
    "Apply these image generation preferences through the image_gen prompt:",
    ...preferences,
  ].join("\n");
}

function aspectRatioValue(invocation: ExecutablePluginInvocation) {
  const value = invocation.input.values.aspect_ratio;
  const parsed =
    typeof value === "string" ? parseAspectRatio(value) : undefined;
  if (!parsed) {
    throw new Error("Codex ImageGen requires a positive W:H aspect ratio.");
  }
  return aspectRatioLabel(parsed);
}

export async function runCodexImageGeneration(
  input: unknown,
  services: CodexImageGenServices,
): Promise<Extract<ExecutablePluginResult, { status: "completed" }>> {
  const invocation = ExecutablePluginInvocationSchema.parse(input);
  const references = invocation.input.references
    .filter(
      (reference) => "asset" in reference && reference.asset.kind === "image",
    )
    .sort((left, right) => left.index - right.index)
    .map((reference) => {
      if (!("asset" in reference))
        throw new Error("Expected an image asset reference.");
      return { ...reference.asset, kind: "image" as const };
    });

  const asset = ExecutablePluginAssetHandleSchema.parse(
    await services.hostTools.codexImagegen.generate({
      prompt: promptValue(invocation),
      aspectRatio: aspectRatioValue(invocation),
      slot: "image",
      references,
    }),
  );

  const result = ExecutablePluginResultSchema.parse({
    protocol: "clash.plugin.result/v1",
    invocationId: invocation.invocationId,
    status: "completed",
    outputs: [{ slot: "image", kind: "asset", asset }],
  });
  if (result.status !== "completed") {
    throw new Error("Codex ImageGen returned an unexpected result state.");
  }
  return result;
}

export const CONTRIBUTIONS = {
  "generate-image": defineAction({
    run: async (invocation, context) => {
      const result = await runCodexImageGeneration(invocation, context);
      return { status: "completed", outputs: result.outputs };
    },
  }),
};

export const plugin = assemblePlugin({
  manifestDir: join(fileURLToPath(new URL(".", import.meta.url)), ".."),
  contributes: CONTRIBUTIONS,
});

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  void plugin.start();
}
