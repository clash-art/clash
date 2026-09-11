import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assemblePluginModule, defineAction, servePluginStdio, type ExecutorContext } from "@clash/action-sdk";
import { ExecutablePluginInvocationSchema } from "@clash/shared-types/executable-plugin";
import { DIRECTOR_CODE_INPUT_SLOT, DirectorCodeComponentRegistrySchema } from "@clash/shared-types/director-code";

import { retargetHumanoid } from "./humanoid-retarget.js";

export const CAPTURE_ACTION_ID = "capture-frame";
export const RETARGET_HUMANOID_ACTION_ID = "retarget-humanoid";

async function capture(input: unknown, context: ExecutorContext) {
  const invocation = ExecutablePluginInvocationSchema.parse(input);
  const values = invocation.input.values;
  const envelope = values.stage;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("Director capture requires the strict Stage envelope.");
  const stage = envelope as Record<string, unknown>;
  if (typeof stage.name !== "string" || !stage.owner || Object.keys(stage).sort().join(",") !== "name,owner,state") throw new Error("Director capture requires the strict Stage envelope.");
  const state = stage.state;
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Director capture requires Stage state.");
  const codeSources: Record<string, string> = Object.create(null);
  // Legacy captures without components retain their original envelope contract.
  if ("codeComponents" in state) {
    const components = DirectorCodeComponentRegistrySchema.parse(state.codeComponents);
    for (const component of components) {
      const reference = invocation.input.references.find(item => item.slot === `${DIRECTOR_CODE_INPUT_SLOT}:${component.id}`
        && "document" in item && item.document.documentAssetId === component.source.documentAssetId
        && item.document.revisionId === component.source.revisionId
        && item.document.documentKind === "text.plain" && item.document.schemaVersion === 1);
      if (!reference) throw new Error(`Missing pinned Director source ${component.source.documentAssetId}/${component.source.revisionId}`);
      const resolved = await context.reference(reference);
      if (resolved.form !== "document" || resolved.documentKind !== "text.plain" || resolved.schemaVersion !== 1
        || typeof resolved.body !== "string" || !resolved.body.trim()) throw new Error(`Invalid Director source ${component.id}`);
      codeSources[component.id] = resolved.body;
    }
  }
  const label = values.label;
  const timeSeconds = values.timeSeconds;
  const aspectRatio = values.aspectRatio;
  const longEdge = values.longEdge;
  if (typeof label !== "string" || !label.trim() || typeof timeSeconds !== "number" || typeof aspectRatio !== "string" || typeof longEdge !== "number" || !Number.isInteger(longEdge)) throw new Error("Director capture requires pinned label, timeSeconds, aspectRatio, and longEdge parameters.");
  const rendered = await context.hostTools.directorStageCaptureFrame({
    ...(Object.keys(codeSources).length ? { codeSources } : {}),
    stage: { name: stage.name, owner: stage.owner as never, state: state as never },
    label: label.trim(), timeSeconds, aspectRatio: aspectRatio as never, longEdge,
  });
  return { status: "completed" as const, media: { frame: { base64: rendered.bytesBase64, kind: "image" as const, mediaType: rendered.mediaType } } };
}

export const plugin = assemblePluginModule({
  manifestDir: join(fileURLToPath(new URL(".", import.meta.url)), ".."),
  contributes: {
    [CAPTURE_ACTION_ID]: defineAction({ run: capture }),
    [RETARGET_HUMANOID_ACTION_ID]: defineAction({ run: retargetHumanoid }),
  },
});

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) void servePluginStdio(plugin).done;
