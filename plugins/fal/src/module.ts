import { assemblePluginModule, defineExecutor, type PluginModule } from "@clash/action-sdk/browser";
import { executablePluginSchemaHash } from "@clash/shared-runtime/executable-plugin-schema-hash";
import { validateExecutablePluginPackage } from "@clash/shared-types/executable-plugin";

import { falAdapter } from "./fal-adapter.js";
import manifest from "../manifest.json";
import contract_test_fal_execute from "../contract-tests/fal-execute.json";
import contract_test_fal_submit_requires_key from "../contract-tests/fal-submit-requires-key.json";
import provider_providers_fal from "../providers/fal.json";
import binding_bindings_flux_schnell from "../bindings/flux-schnell.json";
import binding_bindings_flux_dev from "../bindings/flux-dev.json";
import binding_bindings_gpt_image_2 from "../bindings/gpt-image-2.json";
import binding_bindings_nano_banana_2 from "../bindings/nano-banana-2.json";
import binding_bindings_seedream_4_5 from "../bindings/seedream-4.5.json";
import binding_bindings_recraft_v4 from "../bindings/recraft-v4.json";
import binding_bindings_flux_2_pro from "../bindings/flux-2-pro.json";
import binding_bindings_sora_2 from "../bindings/sora-2.json";
import binding_bindings_kling_3 from "../bindings/kling-3.json";
import binding_bindings_flux_3_video from "../bindings/flux-3-video.json";
import binding_bindings_flux_3_video_keyframes from "../bindings/flux-3-video-keyframes.json";
import binding_bindings_flux_3_video_continue from "../bindings/flux-3-video-continue.json";
import binding_bindings_seedance_2_startend from "../bindings/seedance-2-startend.json";
import binding_bindings_seedance_2_ref from "../bindings/seedance-2-ref.json";
import binding_bindings_minimax_tts from "../bindings/minimax-tts.json";
import binding_bindings_minimax_music_3 from "../bindings/minimax-music-3.json";
import binding_bindings_minimax_h3 from "../bindings/minimax-h3.json";
import binding_bindings_minimax_h3_startend from "../bindings/minimax-h3-startend.json";
import binding_bindings_gpt_image_2_5_flare from "../bindings/gpt-image-2.5-flare.json";
import binding_bindings_gpt_image_2_5_sunburst from "../bindings/gpt-image-2.5-sunburst.json";

const CONTRIBUTIONS = {
  "fal-execute": defineExecutor(falAdapter),
};

const PROVIDER_DOCUMENTS: Record<string, unknown> = {
  "providers/fal.json": provider_providers_fal,
};
const MODEL_BINDING_DOCUMENTS: Record<string, unknown> = {
  "bindings/flux-schnell.json": binding_bindings_flux_schnell,
  "bindings/flux-dev.json": binding_bindings_flux_dev,
  "bindings/gpt-image-2.json": binding_bindings_gpt_image_2,
  "bindings/nano-banana-2.json": binding_bindings_nano_banana_2,
  "bindings/seedream-4.5.json": binding_bindings_seedream_4_5,
  "bindings/recraft-v4.json": binding_bindings_recraft_v4,
  "bindings/flux-2-pro.json": binding_bindings_flux_2_pro,
  "bindings/sora-2.json": binding_bindings_sora_2,
  "bindings/kling-3.json": binding_bindings_kling_3,
  "bindings/flux-3-video.json": binding_bindings_flux_3_video,
  "bindings/flux-3-video-keyframes.json": binding_bindings_flux_3_video_keyframes,
  "bindings/flux-3-video-continue.json": binding_bindings_flux_3_video_continue,
  "bindings/seedance-2-startend.json": binding_bindings_seedance_2_startend,
  "bindings/seedance-2-ref.json": binding_bindings_seedance_2_ref,
  "bindings/minimax-tts.json": binding_bindings_minimax_tts,
  "bindings/minimax-music-3.json": binding_bindings_minimax_music_3,
  "bindings/minimax-h3.json": binding_bindings_minimax_h3,
  "bindings/minimax-h3-startend.json": binding_bindings_minimax_h3_startend,
  "bindings/gpt-image-2.5-flare.json": binding_bindings_gpt_image_2_5_flare,
  "bindings/gpt-image-2.5-sunburst.json": binding_bindings_gpt_image_2_5_sunburst,
};

// Same parse and validation the Local loader applies to the package on disk
// (actions-loader readHostedPackage), so both realms hash identical documents.
const validated = validateExecutablePluginPackage(
  manifest,
  {},
  {
    "contract-tests/fal-execute.json": contract_test_fal_execute,
    "contract-tests/fal-submit-requires-key.json": contract_test_fal_submit_requires_key,
  },
  {
  providers: PROVIDER_DOCUMENTS,
  modelBindings: MODEL_BINDING_DOCUMENTS,
});
for (const entry of [
  ...validated.manifest.contributes.providers,
  ...validated.manifest.contributes.modelBindings,
]) {
  if (!(entry.path in PROVIDER_DOCUMENTS) && !(entry.path in MODEL_BINDING_DOCUMENTS)) {
    throw new Error(`clash.fal ./module is missing manifest document ${entry.path}.`);
  }
}

/**
 * Executor entry usable from a Worker or any in-process host.
 *
 * Deliberately does not import `./stdio.ts`, which boots the stdio adapter
 * and reads the manifest from disk. The module shares the same executor and
 * schema hash as the Local stdio package.
 */
export const plugin: PluginModule = assemblePluginModule({
  pluginId: validated.manifest.id,
  functions: validated.manifest.contributes.functions,
  contributes: CONTRIBUTIONS,
});

export const schemaHash = executablePluginSchemaHash(
  validated.manifest,
  validated.cards,
  validated.providers,
  validated.modelBindings,
  validated.generators,
  validated.views,
);

export const manifestDocument = validated.manifest;
