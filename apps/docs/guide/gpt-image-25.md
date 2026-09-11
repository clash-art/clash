# GPT Image 2.5 integration

Verified on 2026-09-10. The official model identities are
`gpt-image-2.5-flare` and `gpt-image-2.5-sunburst`. Existing GPT Image 2
cards and saved requests keep their identities.

## Provider contracts

| Provider  | Generation                                                       | Editing                                  |
| --------- | ---------------------------------------------------------------- | ---------------------------------------- |
| OpenAI    | `/v1/images/generations`, model `gpt-image-2.5-{flare,sunburst}` | `/v1/images/edits`, multipart `image[]`  |
| fal       | `openai/gpt-image-2.5/{flare,sunburst}/text-to-image`            | corresponding `/edit` endpoint           |
| Pika      | `openai/gpt-image-2.5-{flare,sunburst}/text-to-image`            | corresponding `/image-to-image` endpoint |
| Replicate | `/v1/models/openai/gpt-image-2.5-{flare,sunburst}/predictions`   | same endpoint with `input_images`        |

OpenAI and Replicate run through the bundled `clash.gpt-image` plugin.
Replicate keeps the prediction id as durable poll state. Account credentials
come from the Host-selected account store. Both the existing `official/openai`
account identity and the OpenAI plugin account declaration have executable routes.

The shared card exposes `auto`, `low`, `medium`, `high`, `xhigh`, and `max`
quality and `auto`, `opaque`, and `transparent` backgrounds. Pika's quality
override excludes `auto`, which its published schema does not accept.
Pika and fal exclude `moderation`, which their schemas do not expose.

The new cards carry exact dimensions, not the legacy GPT Image 2 synthetic K
ladder. The adapter sends concrete dimensions unchanged. An explicit ratio must
match the selected dimensions; `auto` ratio permits any listed dimensions.
With `auto` resolution, an explicit ratio selects a documented native size.
Pika's binding uses its own published `1K`, `2K`, `4K` values and sends them
unchanged. Replicate spells its size field `aspect_ratio`, including when that
field contains an exact `WIDTHxHEIGHT` value.

Each new model run requests one image because the current image Run output
publishes one asset. This avoids charging for additional discarded images.
Native OpenAI/Replicate execution rejects transparent JPEG before submission.
No MiniMax Hub 2.5 route is declared without a verified upstream model identity.

## Sources

- [OpenAI image generation guide](https://developers.openai.com/api/docs/guides/image-generation)
- [OpenAI Flare model](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare)
- [OpenAI Sunburst model](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)
- [fal Flare schema](https://fal.ai/models/openai/gpt-image-2.5/flare/text-to-image/api)
- [fal Sunburst schema](https://fal.ai/models/openai/gpt-image-2.5/sunburst/text-to-image/api)
- [Pika Flare specification](https://dev.pika.art/llms/openai/gpt-image-2.5-flare/text-to-image)
- [Pika Sunburst specification](https://dev.pika.art/llms/openai/gpt-image-2.5-sunburst/text-to-image)
- [Replicate Flare schema](https://replicate.com/openai/gpt-image-2.5-flare/api/schema)
- [Replicate Sunburst schema](https://replicate.com/openai/gpt-image-2.5-sunburst/api/schema)

## Codex ImageGen

The standalone Homebrew Codex CLI was upgraded from 0.153.4 to 0.154.0 during
verification. Its shipped `ImagegenArgs` schema still contains only `prompt`,
`referenced_image_paths`, and `num_last_images_to_include`, matching the built-in
tool schema available in this session. There is no verified model, quality,
resolution, or background argument on this tool. Image API parameters must not
be represented as exact native Codex tool controls.

The Clash Codex ImageGen action exposes image model (auto/Flare/Sunburst),
quality, target dimensions (including custom WIDTHxHEIGHT), and background
alongside aspect ratio. These selections persist in Generator state and the
plugin composes non-auto values into the prompt sent to the signed-in Codex
session. Auto leaves the original prompt unchanged. Target dimensions are
approximate; the selected aspect ratio takes priority and output is not resized.
Model and quality remain prompt preferences rather than verified native switches.
Transparent output can be requested in the prompt per the installed imagegen
skill. Upgrading the standalone CLI does not modify the app-bundled binary or
the running session's tool schema.

## Prompt-control experiment (2026-09-10)

Three live generations used the existing Clash Codex adapter and standalone
Codex CLI 0.154.0. Each saved PNG was byte-identical to the native generated
file; no resize, conversion, or background removal was performed.

| Prompt request                                          | Measured native output                             |
| ------------------------------------------------------- | -------------------------------------------------- |
| Flare + low, transparent, 1536×1024                     | 1536×1024 RGBA; 1,328,550 fully transparent pixels |
| Sunburst + max, transparent, 1536×1024                  | 1536×1024 RGBA; 1,320,607 fully transparent pixels |
| Automatic model/quality, opaque white, exactly 1280×720 | 1672×941 RGB; white background                     |

Background intent worked in these samples; the 1280×720 request produced
an approximately 16:9 composition at a larger native size.
Prompt wording must not be represented as a guaranteed native resolution
parameter. The model names and quality levels above are requests, not observed
execution metadata: neither the returned PNGs nor the available CLI JSONL
identified the actual image model or quality. Appearance and total CLI latency
cannot establish model selection. Raw logs and images remain local under the
ignored `output/imagegen/prompt-control-20260910/` experiment directory.
