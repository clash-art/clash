import { z } from 'zod';

import { AigcActionKindSchema, type AigcActionKind } from "./actions.js";
import { AssetKindSchema } from "./assets.js";
import { parseAspectRatio as parseWrittenAspectRatio } from "./aspect-ratio.js";

import { GPT_IMAGE_ASPECT_RATIOS, GPT_IMAGE_RESOLUTION_TIERS } from './gpt-image-size.js';
import { CANONICAL_RESOLUTION_TIERS, type CanonicalResolutionTier } from './resolution-tiers.js';

/**
 * What a model card produces, which is the AIGC action it performs.
 *
 * This is `AigcActionKindSchema` rather than an enum of its own. The two lists were the same five
 * words plus `asr`, and a parallel enum is a list that can drift: `asr` is how a model works, not
 * what it makes, and the five cards under it all produced text. They are `text` now.
 *
 * A `task` field used to sit beside this one, holding `speech-to-text`, `text-to-speech` or
 * `music-generation`, on 8 of 50 cards. It claimed to be the user-facing job while `kind` was the
 * media contract, but producing one class of output is one action and the rest is parameters --
 * a music model is one that declares `musicInput`, and a transcription model is one whose only
 * prompt modality is audio. Both of those are declarations a card already makes, so the field was
 * asserting something the card said twice and could contradict.
 */
export const ModelKindSchema = AigcActionKindSchema;
export type ModelKind = AigcActionKind;

/**
 * Nano Banana 2 aspect ratios (fal.ai)
 */
export const NANO_BANANA_ASPECT_RATIOS = [
  { label: '1:1', value: '1:1' },
  { label: '2:3', value: '2:3' },
  { label: '3:2', value: '3:2' },
  { label: '3:4', value: '3:4' },
  { label: '4:3', value: '4:3' },
  { label: '4:5', value: '4:5' },
  { label: '5:4', value: '5:4' },
  { label: '9:16', value: '9:16' },
  { label: '16:9', value: '16:9' },
  { label: '21:9', value: '21:9' },
] as const;

/**
 * Gemini 3.1 Flash-Lite Image (Nano Banana 2 Lite) aspect ratios.
 */
export const NANO_BANANA_LITE_ASPECT_RATIOS = [
  { label: '1:1', value: '1:1' },
  { label: '1:4', value: '1:4' },
  { label: '4:1', value: '4:1' },
  { label: '1:8', value: '1:8' },
  { label: '8:1', value: '8:1' },
  { label: '2:3', value: '2:3' },
  { label: '3:2', value: '3:2' },
  { label: '3:4', value: '3:4' },
  { label: '4:3', value: '4:3' },
  { label: '4:5', value: '4:5' },
  { label: '5:4', value: '5:4' },
  { label: '9:16', value: '9:16' },
  { label: '16:9', value: '16:9' },
  { label: '21:9', value: '21:9' },
] as const;

/**
 * Nano Banana 2 resolutions (fal.ai) — this model names the K tiers itself.
 */
export const NANO_BANANA_RESOLUTIONS = CANONICAL_RESOLUTION_TIERS;

/**
 * Sora 2 aspect ratios (fal.ai)
 */
export const SORA_ASPECT_RATIOS = [
  { label: '16:9', value: '16:9' },
  { label: '9:16', value: '9:16' },
] as const;

/**
 * The canonical aspect ratios most image models offer.
 *
 * Cards speak ratios; provider spellings such as fal's `landscape_16_9` are the
 * transport's business. Keeping provider values in the cards meant the same ratio
 * was written several ways, a card's own `defaultAspectRatio` was not selectable in
 * its own options, and resolution tiers leaked in as duplicate "ratios"
 * (`1:1 HD` sitting next to `1:1`).
 */
export const CANONICAL_IMAGE_ASPECT_RATIOS = [
  { label: '1:1', value: '1:1' },
  { label: '4:3', value: '4:3' },
  { label: '16:9', value: '16:9' },
  { label: '3:4', value: '3:4' },
  { label: '9:16', value: '9:16' },
] as const;

/**
 * Builders for the parameters that several kinds share.
 *
 * `aspect_ratio` spans image and video, `duration` spans video and audio, and
 * `resolution` spans both. Declaring them by hand let the same concept drift: one
 * card labelled the ratio "Aspect ratio" while twenty used "Aspect Ratio", and one
 * card's durations were strings while the rest were numbers, so a consumer
 * comparing `value === 5` silently missed. Prefer these builders for new cards;
 * they are the shape `model-parameter-shape.test.ts` guards.
 */
export function aspectRatioParameter(spec: {
  ratios: readonly string[];
  defaultValue: string;
  /** Include the canonical `auto` sentinel. Provider spellings stay in the adapter. */
  auto?: { label: string };
  description?: string;
  required?: boolean;
}) {
  return {
    id: 'aspect_ratio',
    label: 'Aspect Ratio',
    type: 'select' as const,
    ...(spec.description ? { description: spec.description } : {}),
    ...(spec.required === undefined ? {} : { required: spec.required }),
    options: [
      ...(spec.auto ? [{ label: spec.auto.label, value: "auto" }] : []),
      ...spec.ratios.map((value) => ({ label: value, value })),
    ],
    defaultValue: spec.defaultValue,
  };
}

/** Seconds are always numbers, so `value === 5` means the same thing everywhere. */
export function durationParameter(spec: {
  seconds: readonly number[];
  defaultValue: number | 'auto';
  auto?: { label: string };
}) {
  return {
    id: 'duration',
    label: 'Duration',
    type: 'select' as const,
    options: [
      ...(spec.auto
        ? [{ label: spec.auto.label, value: "auto" as const }]
        : []),
      ...spec.seconds.map((value) => ({ label: `${value}s`, value })),
    ],
    defaultValue: spec.defaultValue,
  };
}

/**
 * A resolution control listing exactly what the provider accepts.
 *
 * Unlike aspect ratio, resolution is not one quantity with several spellings. A
 * provider's options are a menu of concrete outputs, and the names are already exact:
 * `720p` is 1280x720, `fhd` is 1920x1080. Mapping those onto a shared tier ladder
 * would assert equalities that are false -- a 1K budget is 1048576 pixels while 720p
 * is 921600 -- and would lose the exact dimensions to gain nothing. So cards carry
 * the provider's own values, and no translation happens on the way out.
 */
export function resolutionParameter(spec: {
  tiers: readonly { label: string; value: string }[];
  defaultValue: string;
}) {
  return {
    id: "resolution",
    label: "Resolution",
    type: "select" as const,
    options: spec.tiers.map((tier) => ({
      label: tier.label,
      value: tier.value,
    })),
    defaultValue: spec.defaultValue,
  };
}

/**
 * Kling aspect ratios (fal.ai)
 */
export const KLING_ASPECT_RATIOS = [
  { label: '16:9', value: '16:9' },
  { label: '9:16', value: '9:16' },
  { label: '1:1', value: '1:1' },
] as const;

/**
 * Veo 3 aspect ratios (fal.ai)
 */
export const VEO3_ASPECT_RATIOS = [
  { label: '16:9', value: '16:9' },
  { label: '9:16', value: '9:16' },
] as const;

const VEO3_DURATION_PARAMETER = {
  id: "duration",
  label: "Duration",
  type: "select",
  options: [4, 6, 8].map((value) => ({ label: `${value}s`, value })),
  defaultValue: 4,
} as const;

/**
 * Imagen 4 aspect ratios (Google native)
 */
export const IMAGEN_ASPECT_RATIOS = [
  { label: '16:9', value: '16:9' },
  { label: '9:16', value: '9:16' },
  { label: '1:1', value: '1:1' },
  { label: '4:3', value: '4:3' },
  { label: '3:4', value: '3:4' },
] as const;

export const FLUX3_VIDEO_ASPECT_RATIOS = [
  { label: 'Auto', value: 'auto' },
  { label: '21:9', value: '21:9' },
  { label: '2:1', value: '2:1' },
  { label: '16:9', value: '16:9' },
  { label: '4:3', value: '4:3' },
  { label: '1:1', value: '1:1' },
  { label: '3:4', value: '3:4' },
  { label: '9:16', value: '9:16' },
] as const;

function flux3VideoParameters(options: { allowAutoDuration?: boolean } = {}) {
  const allowAutoDuration = options.allowAutoDuration ?? true;
  return [
    {
      id: 'duration',
      label: 'Duration',
      type: 'select' as const,
      options: [
        ...(allowAutoDuration ? [{ label: 'Auto', value: 'auto' }] : []),
        ...Array.from({ length: 16 }, (_, index) => ({ label: `${index + 5}s`, value: index + 5 })),
      ],
      defaultValue: allowAutoDuration ? 'auto' : 5,
    },
    {
      id: 'aspect_ratio',
      label: 'Aspect Ratio',
      type: 'select' as const,
      options: FLUX3_VIDEO_ASPECT_RATIOS.map(({ label, value }) => ({ label, value })),
      defaultValue: 'auto',
    },
    {
      id: 'resolution',
      label: 'Resolution',
      type: 'select' as const,
      options: [
        { label: '720p', value: '720p' },
        { label: '1080p', value: '1080p' },
      ],
      defaultValue: '720p',
    },
    {
      id: 'generate_audio',
      label: 'Native audio',
      type: 'boolean' as const,
      defaultValue: true,
    },
    {
      id: 'safety_tolerance',
      label: 'Safety tolerance',
      type: 'select' as const,
      options: Array.from({ length: 5 }, (_, value) => ({ label: String(value), value })),
      defaultValue: 2,
    },
  ];
}

const FLUX3_VIDEO_DEFAULT_PARAMS = {
  duration: 'auto',
  aspect_ratio: 'auto',
  resolution: '720p',
  generate_audio: true,
  safety_tolerance: 2,
} as const;

const FLUX3_KEYFRAME_VIDEO_DEFAULT_PARAMS = {
  ...FLUX3_VIDEO_DEFAULT_PARAMS,
  duration: 5,
} as const;

/**
 * Seedance 2.0 aspect ratios — passed directly (no mapping needed).
 */
export const SEEDANCE_ASPECT_RATIOS = [
  { label: 'Auto', value: 'auto' },
  { label: '21:9', value: '21:9' },
  { label: '16:9', value: '16:9' },
  { label: '4:3', value: '4:3' },
  { label: '1:1', value: '1:1' },
  { label: '3:4', value: '3:4' },
  { label: '9:16', value: '9:16' },
] as const;

export const GEMINI_TTS_VOICES = [
  { label: 'Zephyr - Bright', value: 'Zephyr' },
  { label: 'Puck - Upbeat', value: 'Puck' },
  { label: 'Charon - Informative', value: 'Charon' },
  { label: 'Kore - Firm', value: 'Kore' },
  { label: 'Fenrir - Excitable', value: 'Fenrir' },
  { label: 'Leda - Youthful', value: 'Leda' },
  { label: 'Orus - Firm', value: 'Orus' },
  { label: 'Aoede - Breezy', value: 'Aoede' },
  { label: 'Callirrhoe - Easy-going', value: 'Callirrhoe' },
  { label: 'Autonoe - Bright', value: 'Autonoe' },
  { label: 'Enceladus - Breathy', value: 'Enceladus' },
  { label: 'Iapetus - Clear', value: 'Iapetus' },
  { label: 'Umbriel - Easy-going', value: 'Umbriel' },
  { label: 'Algieba - Smooth', value: 'Algieba' },
  { label: 'Despina - Smooth', value: 'Despina' },
  { label: 'Erinome - Clear', value: 'Erinome' },
  { label: 'Algenib - Gravelly', value: 'Algenib' },
  { label: 'Rasalgethi - Informative', value: 'Rasalgethi' },
  { label: 'Laomedeia - Upbeat', value: 'Laomedeia' },
  { label: 'Achernar - Soft', value: 'Achernar' },
  { label: 'Alnilam - Firm', value: 'Alnilam' },
  { label: 'Schedar - Even', value: 'Schedar' },
  { label: 'Gacrux - Mature', value: 'Gacrux' },
  { label: 'Pulcherrima - Forward', value: 'Pulcherrima' },
  { label: 'Achird - Friendly', value: 'Achird' },
  { label: 'Zubenelgenubi - Casual', value: 'Zubenelgenubi' },
  { label: 'Vindemiatrix - Gentle', value: 'Vindemiatrix' },
  { label: 'Sadachbia - Lively', value: 'Sadachbia' },
  { label: 'Sadaltager - Knowledgeable', value: 'Sadaltager' },
  { label: 'Sulafat - Warm', value: 'Sulafat' },
] as const;

export const ModelParameterTypeSchema = z.enum(['select', 'slider', 'number', 'text', 'boolean']);
export type ModelParameterType = z.infer<typeof ModelParameterTypeSchema>;

/**
 * Provider configuration for models
 */
export const BuiltinProviderSchema = z.enum(['local', 'official', 'fal', 'pika', 'replicate', 'kling', 'minimax', 'volcengine-modelark', 'elevenlabs', 'suno', 'mock', 'custom']);
export const ProviderSchema = z.string().trim().regex(
  /^[a-z0-9][a-z0-9._-]*$/,
  'Provider ids must be lowercase plugin-safe identifiers.',
);
export type Provider = z.infer<typeof ProviderSchema>;

export const ReferenceBindingSchema = z.discriminatedUnion('type', [
  z.object({
    /** Provider receives the prompt and reference collections as separate fields. */
    type: z.literal('grouped-references'),
  }),
  z.object({
    /** Preserve text/reference order as native provider content parts. */
    type: z.literal('ordered-content-parts'),
    /** Provider content parts require an explicit semantic role per asset. */
    usesRoles: z.boolean().default(false),
    /** Image/video/audio references are numbered independently when named in text. */
    modalityScopedIndexes: z.boolean().default(false),
  }),
  z.object({
    /** References stay in provider arrays/content, while text addresses them by numbered tokens. */
    type: z.literal('positional-tokens'),
    modalityScopedIndexes: z.boolean().default(true),
    /** Provider-specific token dialect. `{n}` is replaced with the one-based modality index. */
    tokens: z.object({
      image: z.string().min(1).optional(),
      video: z.string().min(1).optional(),
      audio: z.string().min(1).optional(),
    }).optional(),
  }),
]);
export type ReferenceBinding = z.infer<typeof ReferenceBindingSchema>;

export const ModelProviderConfigSchema = z.object({
  model_id: z.string(),
  provider: ProviderSchema,
  default: z.boolean().default(false),
});
export type ModelProviderConfig = z.infer<typeof ModelProviderConfigSchema>;

export const ModelParameterSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: ModelParameterTypeSchema,
  description: z.string().optional(),
  /** Provider-fixed output characteristic. It remains visible in the common
   * parameter surface, but UI and external payloads cannot override it. */
  readOnly: z.boolean().optional(),
  /** Select controls may accept values beyond their preset menu. Aspect-ratio
   * custom values remain positive integer W:H pairs. */
  allowCustom: z.boolean().optional(),
  required: z.boolean().default(false),
  options: z
    .array(
      z.object({
        label: z.string(),
        value: z.union([z.string(), z.number()]),
      }),
    )
    .optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  placeholder: z.string().optional(),
  defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type ModelParameter = z.infer<typeof ModelParameterSchema>;

export function acceptsCustomModelParameterValue(
  parameter: Pick<ModelParameter, "allowCustom" | "id" | "type">,
  value: unknown,
): boolean {
  if (parameter.type !== "select" || !parameter.allowCustom) return false;
  if (parameter.id === "aspect_ratio") {
    return (
      typeof value === "string" && parseWrittenAspectRatio(value) !== undefined
    );
  }
  return typeof value === "string" || typeof value === "number";
}

/**
 * Input shape a model accepts. Each declared field is an independent input
 * "modality" with its own UI render unit + provider adapter mapping.
 * Adding a new modality is three places: schema field here, a strip component,
 * and a provider mapping. No discriminated union, no exhaustive switches.
 *
 * Examples:
 *   text-to-X                      {}
 *   single image required          { images: { max: 1, min: 1 } }
 *   multi image (Nano Banana)      { images: { max: 8 } }
 *   first/last frame (Kling 2.5)   { startEnd: {} }
 *   Seedance ref-to-video          { images:{max:9}, videos:{max:3}, audios:{max:3} }
 *   future audio-driven video      { images:{max:1, min:1}, audios:{max:1, min:1} }
 *   model-to-model (auto-rig)      { models: { max: 1, min: 1 } }
 *
 * `startEnd` always means the standard convention: first frame required,
 * last frame optional. No real-world model breaks that pattern; if one
 * shows up, add a config field on the {} then.
 */
const ReferenceMediaConstraintsSchema = z.object({
  mimeTypes: z.array(z.string().min(1)).optional(),
  fileExtensions: z.array(z.string().min(1)).optional(),
  maxBytes: z.number().int().positive().optional(),
  minWidth: z.number().int().positive().optional(),
  maxWidth: z.number().int().positive().optional(),
  minHeight: z.number().int().positive().optional(),
  maxHeight: z.number().int().positive().optional(),
  /** Total decoded pixel area (width × height). Use this when the upstream
   * publishes an area floor rather than independent edge floors. */
  minPixels: z.number().int().positive().optional(),
  maxPixels: z.number().int().positive().optional(),
  minAspectRatio: z.number().positive().optional(),
  maxAspectRatio: z.number().positive().optional(),
  minDurationMs: z.number().int().nonnegative().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  minFrameRate: z.number().positive().optional(),
  maxFrameRate: z.number().positive().optional(),
  videoCodecs: z.array(z.string().min(1)).optional(),
  audioCodecs: z.array(z.string().min(1)).optional(),
});

const ReferenceMediaConditionSchema = z.object({
  field: z
    .string()
    .regex(
      /^modelParams\.[A-Za-z0-9_.-]+$/,
      "Reference media conditions must target modelParams.<id>.",
    ),
  equals: z.union([z.string(), z.number(), z.boolean()]),
});

const ConditionalRefSpecSchema = z
  .object({
    when: z.array(ReferenceMediaConditionSchema).min(1),
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().positive().optional(),
    constraints: ReferenceMediaConstraintsSchema.optional(),
  })
  .superRefine((conditional, ctx) => {
    if (
      conditional.min === undefined &&
      conditional.max === undefined &&
      conditional.constraints === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "A conditional reference rule must override bounds or media constraints.",
      });
    }
  });

const RefSpecSchema = z.object({
  max: z.number().int().positive(),
  min: z.number().int().nonnegative().optional(),
  /** When this modality is present, at least one of these companion
   * modalities must also be present. */
  requiresAnyOf: z.array(z.enum(['image', 'video', 'audio', 'model'])).min(1).optional(),
  constraints: ReferenceMediaConstraintsSchema.optional(),
  maxTotalDurationMs: z.number().int().positive().optional(),
  /** Parameter-conditioned refinements for one input mode (for example,
   * Seedance edit mode tightens the video count, duration, and pixel floor). */
  conditional: z.array(ConditionalRefSpecSchema).optional(),
});

export const ModelInputModeSchema = z.object({
  images: RefSpecSchema.optional(),
  videos: RefSpecSchema.optional(),
  audios: RefSpecSchema.optional(),
  /** Reference to another Model output -- e.g. a static mesh bound into a rigging model. Declared
   * the same way as images/videos/audios, so a model-to-model workflow (auto-rig, retarget) is
   * expressed through the same generic input contract rather than a provider-specific field. */
  models: RefSpecSchema.optional(),
  /** At least one reference from these modalities must be attached. */
  requiresAnyOf: z.array(z.enum(['image', 'video', 'audio', 'model'])).min(1).optional(),
  /** Maximum total references across image, video, audio, and model buckets. */
  maxTotalReferences: z.number().int().positive().optional(),
  /** Maximum JSON request body when local media is represented as Base64 Data URIs. */
  maxEmbeddedRequestBytes: z.number().int().positive().optional(),
  /** First / last frame reference pair. Start frame is required, end frame optional. */
  startEnd: z.object({ constraints: ReferenceMediaConstraintsSchema.optional() }).optional(),
});
export type ModelInputMode = z.infer<typeof ModelInputModeSchema>;

/** Optional Canvas presentation for model-specific input semantics. The
 * presentation belongs to this Model Card; it does not group cards or create
 * a second workflow-selection layer. */
export const ModelInputPresentationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('keyframes'),
    /** Provider frame positions are explicit; the Canvas may seed evenly
     * spaced defaults, but users can edit every intermediate anchor. */
    timing: z.literal('explicit'),
    frameRate: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('video-continuation'),
  }),
]);
export type ModelInputPresentation = z.infer<typeof ModelInputPresentationSchema>;

export const ModelInputRuleSchema = z.object({
  requiresPrompt: z.boolean().default(true),
  inputMode: ModelInputModeSchema.default({}),
  /** Modalities that can be @-mentioned inline in the prompt editor.
   *  Does NOT affect form-field inputs (start/end frames, etc.) */
  promptModalities: z.array(z.enum(['text', 'image', 'video', 'audio', 'model'])).default(['text']),
  /** How inline prompt references are represented on the provider wire. */
  referenceBinding: ReferenceBindingSchema.optional(),
  /** Specialized input surface owned by this Model Card. */
  presentation: ModelInputPresentationSchema.optional(),
});
export type ModelInputRule = z.infer<typeof ModelInputRuleSchema>;

/** Declarative translation for music models whose provider APIs disagree on
 * whether lyrics live in `prompt` or in a dedicated model parameter. */
export const MusicInputMappingSchema = z.object({
  lyricsTarget: z.enum(['prompt', 'modelParam']),
  lyricsParam: z.string().min(1).optional(),
  descriptionParam: z.string().min(1).optional(),
  titleParam: z.string().min(1).optional(),
  maxLyricsCharacters: z.number().int().positive().optional(),
  maxPromptCharacters: z.number().int().positive().optional(),
}).superRefine((mapping, ctx) => {
  if (mapping.lyricsTarget === 'modelParam' && !mapping.lyricsParam) {
    ctx.addIssue({
      code: 'custom',
      path: ['lyricsParam'],
      message: 'lyricsParam is required when lyricsTarget is modelParam.',
    });
  }
});
export type MusicInputMapping = z.infer<typeof MusicInputMappingSchema>;

const ModelConstraintValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const ModelConstraintFieldSchema = z.string().refine(
  (field) => field === 'prompt' || field === 'lyrics' || field.startsWith('modelParams.'),
  'Constraint fields must be prompt, lyrics, or modelParams.<id>.',
);

export const ModelConstraintRuleSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('required'),
    field: ModelConstraintFieldSchema,
    when: z.array(z.object({
      field: ModelConstraintFieldSchema,
      equals: ModelConstraintValueSchema,
    })).default([]),
    message: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('max-length'),
    field: ModelConstraintFieldSchema,
    max: z.number().int().positive(),
    message: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('mutually-exclusive'),
    fields: z.array(ModelConstraintFieldSchema).min(2),
    activeValue: ModelConstraintValueSchema,
    inactiveValue: ModelConstraintValueSchema,
    message: z.string().min(1).optional(),
  }),
]);
export type ModelConstraintRule = z.infer<typeof ModelConstraintRuleSchema>;

export const ProviderCredentialRequirementsSchema = z.object({
  /** Every entry is an all-of credential set; satisfying any one set enables the route. */
  anyOf: z.array(z.array(z.string().min(1)).min(1)).min(1),
  /** When true, one account must not configure more than one alternative set. */
  exclusive: z.boolean().optional(),
});
export type ProviderCredentialRequirements = z.infer<typeof ProviderCredentialRequirementsSchema>;

/** Provider-wire spelling changes applied only after a concrete implementation
 * route has been selected. These do not change the shared product contract or
 * transcode the referenced bytes. */
export const ProviderInputAdaptationSchema = z.object({
  audio: z
    .object({
      mimeAliases: z.record(z.string().min(1), z.string().min(1)),
    })
    .optional(),
});
export type ProviderInputAdaptation = z.infer<typeof ProviderInputAdaptationSchema>;

/** How an exact Provider binding or Action executor can receive one Asset input from the Host. */
export const ProviderAssetRepresentationSchema = z.enum(['provider-url', 'executor-url', 'bytes']);
export type ProviderAssetRepresentation = z.infer<typeof ProviderAssetRepresentationSchema>;

export const ProviderAssetInputSchema = z.object({
  match: z.object({
    kinds: z.array(AssetKindSchema).min(1).optional(),
    slots: z.array(z.string().trim().min(1)).min(1).optional(),
  }).strict().superRefine((match, ctx) => {
    if (!match.kinds?.length && !match.slots?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Asset input match must declare at least one kind or slot.',
      });
    }
  }),
  representations: z.array(ProviderAssetRepresentationSchema).min(1),
  mediaTypes: z.array(z.string().trim().min(1)).min(1).optional(),
}).strict();
export type ProviderAssetInput = z.infer<typeof ProviderAssetInputSchema>;

export const ModelCardConsumerSchema = z
  .object({
    pluginId: z.string().trim().min(1),
    definitionId: z.string().trim().min(1).optional(),
    actionId: z.string().trim().min(1).optional(),
  })
  .strict();
export type ModelCardConsumer = z.infer<typeof ModelCardConsumerSchema>;

export const ModelCardVisibilitySchema = z.discriminatedUnion('scope', [
    z.object({ scope: z.literal('public') }).strict(),
    z
      .object({
        scope: z.literal('plugin-private'),
        consumers: z.array(ModelCardConsumerSchema).min(1),
      })
      .strict(),
  ]).optional();
export type ModelCardVisibility = z.infer<typeof ModelCardVisibilitySchema>;

export const ModelProviderImplementationSchema = z
  .object({
    providerId: ProviderSchema,
    accountId: z.string().optional(),
    upstreamId: z.string(),
    region: z.string().optional(),
    upstreamModel: z.string(),
    apiShape: z.string(),
    /** Function export in the owning Executable Plugin that translates the
     * canonical Card invocation to this provider's wire shape. Legacy built-in
     * routes may omit it until migrated. */
    projectorExportId: z.string().min(1).optional(),
    /** Plugin that owns projectorExportId. The resolver selects an installed
     * exact version and persists it on the Canvas node. */
    projectorPluginId: z.string().min(1).optional(),
    /** Function export that owns the full submit/poll/result lifecycle for a
     * plugin-defined provider. Built-in adapters may omit it. */
    executorExportId: z.string().min(1).optional(),
    /** Plugin that owns executorExportId. Package composition fills this from
     * immutable plugin provenance when omitted in a binding document. */
    executorPluginId: z.string().min(1).optional(),
    priority: z.number().optional(),
    weight: z.number().optional(),
    requiredCredentials: z.array(z.string()).optional(),
    credentialRequirements: ProviderCredentialRequirementsSchema.optional(),
    requiredOAuth: z.array(z.string()).optional(),
    /** Provider-specific override for how inline references bind to prompt text. */
    referenceBinding: ReferenceBindingSchema.optional(),
    /** Provider-specific wire spellings applied after this route is selected. */
    inputAdaptation: ProviderInputAdaptationSchema.optional(),
    /** Asset delivery forms accepted by this exact Provider/model binding. */
    assetInputs: z.array(ProviderAssetInputSchema).optional(),
    /** Full replacements for parameters whose candidates or ranges differ on this provider.
     * Parameters absent from this list are reused from the base model card. */
    parameterOverrides: z.array(ModelParameterSchema).optional(),
    /** Provider-specific defaults paired with parameterOverrides. */
    defaultParamOverrides: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    /** Parameters implemented only by other providers. They are removed from
     * the effective Card instead of being rendered and silently discarded. */
    excludedParameterIds: z.array(z.string().min(1)).optional(),
  })
  .superRefine((implementation, ctx) => {
    // A Card shipped inside the owning plugin may omit projectorPluginId; the
    // package validator binds the export to manifest.id. An explicit external
    // plugin id, however, is meaningless without its export id.
    if (implementation.projectorPluginId && !implementation.projectorExportId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['projectorExportId'],
        message: 'projectorExportId is required when projectorPluginId is configured.',
      });
    }
    if (implementation.executorPluginId && !implementation.executorExportId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['executorExportId'],
        message: 'executorExportId is required when executorPluginId is configured.',
      });
    }
  });
export type ModelProviderImplementation = z.infer<typeof ModelProviderImplementationSchema>;

export const ModelCardSchema = z
  .object({
    id: z.string(),
    aliases: z.array(z.string()).default([]),
    name: z.string(),
    provider: z.string(),
    kind: ModelKindSchema,
    /** Provider-independent consumption contract. Provider wire shapes remain on implementations. */
    semanticShape: z.string().trim().regex(/^[a-z][a-z0-9_]*$/).optional(),
    /** Catalog scope evaluated from explicit consumer context, never contributor ids. */
    visibility: ModelCardVisibilitySchema,
    custom: z.boolean().optional(),
    description: z.string().optional(),
    promptGuidance: z.string().optional(),
    parameters: z.array(ModelParameterSchema),
    defaultParams: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
    /**
     * Canonical default aspect ratio in our format ("4:3", "16:9", etc.).
     * Required for image and video models. Audio models use "1:1" as placeholder.
     * This is OUR representation — provider-specific values live in parameters/defaultParams.
     */
    defaultAspectRatio: z.string().default('16:9'),
    input: ModelInputRuleSchema.default({
      requiresPrompt: true,
      inputMode: {},
      promptModalities: ['text'],
    }),
    musicInput: MusicInputMappingSchema.optional(),
    /** Shared UI/runtime constraints. Providers may still translate the final
     * valid configuration into different wire shapes. */
    constraints: z.array(ModelConstraintRuleSchema).optional(),
    availableProviders: z.array(ProviderSchema).optional(),
    defaultProvider: ProviderSchema.optional(),
    providerImplementations: z.array(ModelProviderImplementationSchema).optional(),
    /**
     * Upper bound (ms) for a healthy run. NodeProcessor marks a workflow Failed if
     * engine status is still "running" past this point (orphan from miniflare
     * hot-reload, hung provider, etc). Set generously above the 99th-percentile
     * run so legitimately slow jobs never get misclassified.
     */
    maxRuntimeMs: z.number().int().positive().optional(),
  })
  .superRefine((model, ctx) => {
    const parameterIds = new Set<string>();
    const parametersById = new Map<string, ModelParameter>();
    const sameCandidate = (left: unknown, right: unknown) => left === right;
    const validateProviderParameterValue = (
      parameter: ModelParameter,
      value: string | number | boolean | undefined,
      path: Array<string | number>,
      source: string,
    ) => {
      if (value === undefined) return;
      if (parameter.type === "select") {
        const optionValues =
          parameter.options?.map((option) => option.value) ?? [];
        if (
          !optionValues.some((candidate) => sameCandidate(candidate, value)) &&
          !acceptsCustomModelParameterValue(parameter, value)
        ) {
          ctx.addIssue({
            code: 'custom',
            path,
            message: `${parameter.label} ${source} must be one of its provider candidates.`,
          });
        }
        return;
      }
      if (parameter.type === 'number' || parameter.type === 'slider') {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          ctx.addIssue({
            code: 'custom',
            path,
            message: `${parameter.label} ${source} must be a finite number.`,
          });
        } else if ((parameter.min !== undefined && value < parameter.min)
          || (parameter.max !== undefined && value > parameter.max)) {
          ctx.addIssue({
            code: 'custom',
            path,
            message: `${parameter.label} ${source} must stay within its provider range.`,
          });
        }
        return;
      }
      if (parameter.type === 'boolean' && typeof value !== 'boolean') {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `${parameter.label} ${source} must be a boolean.`,
        });
      }
      if (parameter.type === 'text' && typeof value !== 'string') {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `${parameter.label} ${source} must be text.`,
        });
      }
    };
    for (const [index, parameter] of model.parameters.entries()) {
      if (parameterIds.has(parameter.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['parameters', index, 'id'],
          message: 'Model parameter ids must be unique.',
        });
      }
      parameterIds.add(parameter.id);
      parametersById.set(parameter.id, parameter);

      if (parameter.allowCustom && parameter.type !== "select") {
        ctx.addIssue({
          code: "custom",
          path: ["parameters", index, "allowCustom"],
          message: "Only select parameters may allow custom values.",
        });
      }

      if (parameter.type === "select") {
        if (!parameter.options?.length) {
          ctx.addIssue({
            code: 'custom',
            path: ['parameters', index, 'options'],
            message: 'Select parameters require at least one candidate.',
          });
        }
        const optionValues =
          parameter.options?.map((option) => option.value) ?? [];
        if (
          new Set(
            optionValues.map((value) => `${typeof value}:${String(value)}`),
          ).size !== optionValues.length
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['parameters', index, 'options'],
            message: 'Select parameter candidate values must be unique.',
          });
        }
        for (const [source, value] of [
          ['defaultValue', parameter.defaultValue],
          ['defaultParams', model.defaultParams[parameter.id]],
        ] as const) {
          if (
            value !== undefined &&
            !optionValues.some((candidate) => sameCandidate(candidate, value))
          ) {
            ctx.addIssue({
              code: 'custom',
              path: source === 'defaultValue' ? ['parameters', index, 'defaultValue'] : ['defaultParams', parameter.id],
              message: `${parameter.label} ${source} must be one of its configured candidates.`,
            });
          }
        }
      }

      const defaultValue = model.defaultParams[parameter.id] ?? parameter.defaultValue;
      if (parameter.readOnly && defaultValue === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['parameters', index, 'defaultValue'],
          message: `${parameter.label} is read-only and requires a fixed default.`,
        });
      }
      if ((parameter.type === 'number' || parameter.type === 'slider') && defaultValue !== undefined) {
        if (typeof defaultValue !== 'number' || !Number.isFinite(defaultValue)) {
          ctx.addIssue({
            code: 'custom',
            path: ['defaultParams', parameter.id],
            message: `${parameter.label} default must be a finite number.`,
          });
        } else if ((parameter.min !== undefined && defaultValue < parameter.min) || (parameter.max !== undefined && defaultValue > parameter.max)) {
          ctx.addIssue({
            code: 'custom',
            path: ['defaultParams', parameter.id],
            message: `${parameter.label} default must stay within its configured range.`,
          });
        }
      }
      if (parameter.type === 'boolean' && defaultValue !== undefined && typeof defaultValue !== 'boolean') {
        ctx.addIssue({
          code: 'custom',
          path: ['defaultParams', parameter.id],
          message: `${parameter.label} default must be a boolean.`,
        });
      }
    }

    const validateConstraintField = (field: string, path: Array<string | number>) => {
      if (!field.startsWith('modelParams.')) return;
      if (parameterIds.has(field.slice('modelParams.'.length))) return;
      ctx.addIssue({
        code: 'custom',
        path,
        message: `Model constraint ${field} must reference a declared parameter.`,
      });
    };
    for (const [index, rule] of (model.constraints ?? []).entries()) {
      if (rule.type === 'mutually-exclusive') {
        rule.fields.forEach((field, fieldIndex) => validateConstraintField(field, ['constraints', index, 'fields', fieldIndex]));
        continue;
      }
      validateConstraintField(rule.field, ["constraints", index, "field"]);
      if (rule.type === "required") {
        rule.when.forEach((condition, conditionIndex) =>
          validateConstraintField(condition.field, [
            "constraints",
            index,
            "when",
            conditionIndex,
            "field",
          ]),
        );
      }
    }

    for (const [bucket, spec] of [
      ["images", model.input.inputMode.images],
      ["videos", model.input.inputMode.videos],
      ["audios", model.input.inputMode.audios],
    ] as const) {
      for (const [ruleIndex, rule] of (spec?.conditional ?? []).entries()) {
        rule.when.forEach((condition, conditionIndex) =>
          validateConstraintField(condition.field, [
            "input",
            "inputMode",
            bucket,
            "conditional",
            ruleIndex,
            "when",
            conditionIndex,
            "field",
          ]),
        );
      }
    }

    for (const [implementationIndex, implementation] of (model.providerImplementations ?? []).entries()) {
      const overrideIds = new Set<string>();
      const overridesById = new Map<string, ModelParameter>();
      for (const [overrideIndex, parameter] of (implementation.parameterOverrides ?? []).entries()) {
        if (overrideIds.has(parameter.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['providerImplementations', implementationIndex, 'parameterOverrides', overrideIndex, 'id'],
            message: 'Provider parameter override ids must be unique.',
          });
        }
        overrideIds.add(parameter.id);
        overridesById.set(parameter.id, parameter);
        if (!parameterIds.has(parameter.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['providerImplementations', implementationIndex, 'parameterOverrides', overrideIndex, 'id'],
            message: `Provider parameter override ${parameter.id} must reference a declared parameter on the canonical Model Card.`,
          });
        }
        if (parameter.type === 'select' && !parameter.options?.length) {
          ctx.addIssue({
            code: 'custom',
            path: ['providerImplementations', implementationIndex, 'parameterOverrides', overrideIndex, 'options'],
            message: 'Provider select parameter overrides require at least one candidate.',
          });
        }
        validateProviderParameterValue(
          parameter,
          parameter.defaultValue,
          ['providerImplementations', implementationIndex, 'parameterOverrides', overrideIndex, 'defaultValue'],
          'defaultValue',
        );
      }

      const excludedIds = new Set<string>();
      for (const [excludedIndex, parameterId] of (implementation.excludedParameterIds ?? []).entries()) {
        const path = ['providerImplementations', implementationIndex, 'excludedParameterIds', excludedIndex];
        if (excludedIds.has(parameterId)) {
          ctx.addIssue({
            code: 'custom',
            path,
            message: 'Provider excluded parameter ids must be unique.',
          });
        }
        excludedIds.add(parameterId);
        if (!parameterIds.has(parameterId)) {
          ctx.addIssue({
            code: 'custom',
            path,
            message: `Provider exclusion ${parameterId} must reference a declared parameter on the canonical Model Card.`,
          });
        }
        if (overrideIds.has(parameterId)) {
          ctx.addIssue({
            code: 'custom',
            path,
            message: `Provider cannot both override and exclude parameter ${parameterId}.`,
          });
        }
      }

      for (const [parameterId, value] of Object.entries(implementation.defaultParamOverrides ?? {})) {
        const path = ['providerImplementations', implementationIndex, 'defaultParamOverrides', parameterId];
        if (!parameterIds.has(parameterId)) {
          ctx.addIssue({
            code: 'custom',
            path,
            message: `Provider default override ${parameterId} must reference a declared parameter on the canonical Model Card.`,
          });
        }
        if (excludedIds.has(parameterId)) {
          ctx.addIssue({
            code: 'custom',
            path,
            message: `Provider cannot set a default for excluded parameter ${parameterId}.`,
          });
        }
        const effectiveParameter = overridesById.get(parameterId) ?? parametersById.get(parameterId);
        if (effectiveParameter) {
          validateProviderParameterValue(effectiveParameter, value, path, 'default override');
        }
      }
    }

    const providers = model.availableProviders ?? [];
    if (providers.length === 0) return;
    if (!model.defaultProvider) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultProvider'],
        message: 'defaultProvider is required when availableProviders is set.',
      });
      return;
    }
    if (!providers.includes(model.defaultProvider)) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultProvider'],
        message: 'defaultProvider must be one of availableProviders.',
      });
    }
  });
export type ModelCard = z.infer<typeof ModelCardSchema>;

const EMBEDDED_ASPECT_RATIO_PATTERN = /(\d+)\s*[:x×]\s*(\d+)/i;

/**
 * Resolve the geometric ratio represented by one aspect-ratio parameter value.
 *
 * Parameter values remain provider-facing (for example `landscape_16_9`), while
 * labels may contain presentation copy such as `Landscape (16:9)`. Consumers
 * that size a Canvas node need the ratio itself, never either of those aliases.
 */
export function resolveAspectRatioParameter(
  parameter: Pick<ModelParameter, "defaultValue" | "options"> | undefined,
  value: string | number | boolean | undefined,
  fallback?: string,
): string | undefined {
  if (!parameter) return fallback;
  const effectiveValue = value ?? parameter.defaultValue;
  if (effectiveValue === undefined) return fallback;

  const option = parameter.options?.find(
    (candidate) => String(candidate.value) === String(effectiveValue),
  );
  for (const candidate of [effectiveValue, option?.label, option?.value]) {
    if (candidate === undefined) continue;
    const match = String(candidate).match(EMBEDDED_ASPECT_RATIO_PATTERN);
    if (!match) continue;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width > 0 && height > 0) return `${width}:${height}`;
  }

  if (effectiveValue === "auto" || effectiveValue === "adaptive") {
    return effectiveValue;
  }
  return fallback;
}

/**
 * Resolve the canonical aspect ratio from model-specific params.
 * Uses the model's parameter options to reverse-map provider values to our format.
 *
 * e.g. FLUX:        image_size="landscape_4_3" → "4:3"
 *      Nano Banana:  aspect_ratio="16:9"       → "16:9"
 */
export function resolveAspectRatio(
  modelId: string,
  modelParams: Record<string, string | number | boolean>,
): string {
  const card = MODEL_CARDS.find((c) => c.id === modelId);
  if (!card) return "16:9";

  // Every card names the ratio parameter `aspect_ratio`; provider spellings are the
  // adapter's business.
  const paramId = "aspect_ratio";
  const arParam = card.parameters.find((p) => p.id === paramId);
  if (!arParam) return card.defaultAspectRatio;
  return (
    resolveAspectRatioParameter(
      arParam,
      modelParams[paramId],
      card.defaultAspectRatio,
    ) ?? card.defaultAspectRatio
  );
}

/**
 * Snap raw width/height to the closest aspect-ratio option the given model card
 * exposes. Returns the provider-facing option `value` (what goes into modelParams)
 * or null when the card has no aspect-ratio selector or no usable options.
 *
 * Used to default a generation node's ratio from its start reference frame —
 * Kling / Seedance i2v all derive output ratio from the source image, so letting
 * the UI preselect the nearest match keeps the pending-node placeholder honest.
 */
export function snapAspectRatio(
  modelId: string,
  width: number,
  height: number,
): { paramId: string; value: string | number; canonical: string } | null {
  if (!width || !height) return null;
  const card = MODEL_CARDS.find((c) => c.id === modelId);
  if (!card) return null;
  const paramId = "aspect_ratio";
  const arParam = card.parameters.find((p) => p.id === paramId);
  if (!arParam?.options?.length) return null;

  const ratio = width / height;
  let best: {
    option: (typeof arParam.options)[number];
    canonical: string;
  } | null = null;
  let bestDiff = Infinity;
  for (const opt of arParam.options) {
    // Parse canonical ratio from the option's label (preferred) or value.
    const candidates = [opt.label, typeof opt.value === 'string' ? opt.value : ''];
    let canonical: string | null = null;
    for (const s of candidates) {
      const m = /^(\d+):(\d+)$/.exec(s);
      if (m) { canonical = `${m[1]}:${m[2]}`; break; }
    }
    if (!canonical) continue;
    const [a, b] = canonical.split(':').map(Number);
    const diff = Math.abs(Math.log(ratio / (a / b)));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = { option: opt, canonical };
    }
  }
  return best ? { paramId, value: best.option.value, canonical: best.canonical } : null;
}

const GEMINI_TTS_PARAMETERS: ModelParameter[] = [
  {
    id: 'voice_name',
    label: 'Voice',
    type: 'select',
    options: [...GEMINI_TTS_VOICES],
    required: false,
    defaultValue: 'Kore',
    description: 'Google Gemini TTS prebuilt voice.',
  },
];

const MINIMAX_H3_IMAGE_CONSTRAINTS = {
  mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
  fileExtensions: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'],
  maxBytes: 30 * 1024 * 1024,
  minWidth: 256,
  maxWidth: 5760,
  minHeight: 256,
  maxHeight: 5760,
  minAspectRatio: 0.4,
  maxAspectRatio: 2.5,
} as const;

const MINIMAX_H3_VIDEO_CONSTRAINTS = {
  mimeTypes: ['video/mp4', 'video/quicktime'],
  fileExtensions: ['mp4', 'mov'],
  maxBytes: 50 * 1024 * 1024,
  minWidth: 256,
  maxWidth: 5760,
  minHeight: 256,
  maxHeight: 5760,
  minAspectRatio: 0.4,
  maxAspectRatio: 2.5,
  minDurationMs: 2_000,
  maxDurationMs: 15_000,
  minFrameRate: 23.976,
  maxFrameRate: 60,
  videoCodecs: ['h264', 'avc', 'h265', 'hevc'],
  audioCodecs: ['aac', 'mp3'],
} as const;

const MINIMAX_H3_AUDIO_CONSTRAINTS = {
  // The model accepts WAV and MP3, so `audio/mpeg` belongs here: it is MP3's registered
  // media type and rejecting it would refuse a file the model can read. MiniMax derives a
  // filename from the mime and will not take the `.mpeg` that `audio/mpeg` yields, so the
  // transport spells it `audio/mp3` on the wire -- a provider dialect, like `adaptive`.
  mimeTypes: ['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3'],
  fileExtensions: ['wav', 'mp3'],
  maxBytes: 15 * 1024 * 1024,
  minDurationMs: 2_000,
  maxDurationMs: 15_000,
} as const;

const MINIMAX_H3_MAX_EMBEDDED_REQUEST_BYTES = 64 * 1024 * 1024;

const SEEDANCE_IMAGE_CONSTRAINTS = {
  mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/tiff', 'image/gif', 'image/heic', 'image/heif'],
  fileExtensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'gif', 'heic', 'heif'],
  maxBytes: 30 * 1024 * 1024,
  minWidth: 300,
  maxWidth: 6_000,
  minHeight: 300,
  maxHeight: 6_000,
  minAspectRatio: 0.4,
  maxAspectRatio: 2.5,
} as const;

const SEEDANCE_VIDEO_CONSTRAINTS = {
  mimeTypes: ['video/mp4', 'video/quicktime'],
  fileExtensions: ['mp4', 'mov'],
  maxBytes: 200 * 1024 * 1024,
  minDurationMs: 2_000,
  minFrameRate: 24,
  maxFrameRate: 60,
} as const;

const SEEDANCE_AUDIO_CONSTRAINTS = {
  mimeTypes: ['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3'],
  fileExtensions: ['wav', 'mp3'],
  maxBytes: 15 * 1024 * 1024,
  minDurationMs: 2_000,
} as const;

const SEEDANCE_MAX_EMBEDDED_REQUEST_BYTES = 64 * 1024 * 1024;

const SEED_AUDIO_IMAGE_CONSTRAINTS = {
  mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  fileExtensions: ['jpg', 'jpeg', 'png', 'webp'],
  maxBytes: 10 * 1024 * 1024,
} as const;

const SEED_AUDIO_AUDIO_CONSTRAINTS = {
  mimeTypes: ['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/pcm', 'audio/ogg', 'audio/opus'],
  fileExtensions: ['wav', 'mp3', 'pcm', 'ogg', 'opus'],
  maxBytes: 10 * 1024 * 1024,
  maxDurationMs: 30_000,
} as const;

const GROUPED_REFERENCE_BINDING = {
  type: 'grouped-references',
} as const;

const ORDERED_REFERENCE_BINDING = {
  type: 'ordered-content-parts',
  usesRoles: false,
  modalityScopedIndexes: false,
} as const;

const POSITIONAL_REFERENCE_BINDING = {
  type: 'positional-tokens',
  modalityScopedIndexes: true,
} as const;

const PIKA_2026_TEXT_MODEL_CARDS = (
  [
    ["gpt-5.6-sol", "GPT-5.6 Sol", "OpenAI"],
    ["claude-sonnet-5", "Claude Sonnet 5", "Anthropic"],
    ["gemini-3.6-flash", "Gemini 3.6 Flash", "Google"],
    ["deepseek-v4-pro", "DeepSeek V4 Pro", "DeepSeek"],
    ["kimi-k3", "Kimi K3", "Moonshot AI"],
    ["glm-5.2", "GLM-5.2", "Z.ai"],
  ] as const
).map(([id, name, provider]): z.input<typeof ModelCardSchema> => ({
  id,
  name,
  provider,
  availableProviders: ['pika'],
  defaultProvider: 'pika',
  kind: 'text',
  defaultAspectRatio: '1:1',
  description: `${name} through Pika API Club's current 2026 catalog.`,
  parameters: [{
    id: 'system_prompt',
    label: 'System prompt',
    type: 'text',
    defaultValue: '',
  }],
  defaultParams: { system_prompt: '' },
  input: { requiresPrompt: true, inputMode: {}, promptModalities: ['text'] },
  maxRuntimeMs: 5 * 60 * 1000,
}));

// Sources and provider differences: apps/docs/guide/gpt-image-25.md.
const GPT_IMAGE_25_CARDS = ["flare", "sunburst"].map((variant) => ({
  constraints: [],
  id: `gpt-image-2.5-${variant}`,
  name: `GPT Image 2.5 ${variant === "flare" ? "Flare" : "Sunburst"}`,
  provider: "OpenAI",
  kind: "image",
  availableProviders: ["openai", "official", "pika", "replicate"],
  defaultProvider: "official",
  defaultAspectRatio: "1:1",
  description:
    variant === "flare"
      ? "Fast, high-quality everyday image generation and editing."
      : "Precision image generation and editing for intricate detail.",
  parameters: [
    {
      id: "aspect_ratio",
      label: "Aspect Ratio",
      type: "select",
      options: ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"].map(
        (value) => ({ label: value, value }),
      ),
      defaultValue: "auto",
    },
    {
      id: "resolution",
      label: "Resolution",
      type: "select",
      description:
        "Exact output dimensions. Select Auto aspect ratio or a ratio matching these dimensions.",
      options: [
        "auto",
        "1024x1024",
        "1536x1024",
        "1024x1536",
        "1536x1152",
        "1152x1536",
        "2048x2048",
        "2048x1152",
        "1152x2048",
        "3840x2160",
        "2160x3840",
      ].map((value) => ({ label: value, value })),
      defaultValue: "auto",
    },
    {
      id: "quality",
      label: "Quality",
      type: "select",
      options: ["auto", "low", "medium", "high", "xhigh", "max"].map(
        (value) => ({ label: value, value }),
      ),
      defaultValue: "auto",
    },
    {
      id: "background",
      label: "Background",
      type: "select",
      options: ["auto", "opaque", "transparent"].map((value) => ({
        label: value,
        value,
      })),
      defaultValue: "auto",
    },
    {
      id: "output_format",
      label: "Format",
      type: "select",
      options: ["png", "jpeg", "webp"].map((value) => ({
        label: value,
        value,
      })),
      defaultValue: "png",
    },
    {
      id: "moderation",
      label: "Moderation",
      type: "select",
      options: ["auto", "low"].map((value) => ({ label: value, value })),
      defaultValue: "auto",
    },
    {
      id: "count",
      label: "Count",
      type: "number",
      min: 1,
      max: 1,
      step: 1,
      defaultValue: 1,
    },
  ],
  defaultParams: {
    aspect_ratio: "auto",
    resolution: "auto",
    quality: "auto",
    background: "auto",
    output_format: "png",
    moderation: "auto",
    count: 1,
  },
  input: {
    requiresPrompt: true,
    inputMode: { images: { max: 16 } },
    promptModalities: ["text", "image"],
    referenceBinding: GROUPED_REFERENCE_BINDING,
  },
  maxRuntimeMs: 10 * 60 * 1000,
}));

const MODEL_CARD_DEFINITIONS = [
  ...GPT_IMAGE_25_CARDS,
  ...PIKA_2026_TEXT_MODEL_CARDS,
  {
    id: 'seedream-5-pro',
    name: 'Seedream 5.0 Pro',
    provider: 'ByteDance',
    availableProviders: ['pika'],
    defaultProvider: 'pika',
    kind: 'image',
    defaultAspectRatio: '16:9',
    description: 'Seedream 5.0 Pro image generation and editing from the current Pika catalog.',
    parameters: [
      {
        id: "size",
        label: "Size",
        type: "select",
        options: ["1K", "2K"].map((value) => ({ label: value, value })),
        defaultValue: "2K",
      },
      {
        id: "count",
        label: "Count",
        type: "number",
        min: 1,
        max: 6,
        step: 1,
        defaultValue: 1,
      },
    ],
    defaultParams: { size: "2K", count: 1 },
    input: {
      requiresPrompt: true,
      inputMode: { images: { max: 10 } },
      promptModalities: ["text", "image"],
      referenceBinding: GROUPED_REFERENCE_BINDING,
    },
  },
  {
    id: "grok-imagine-quality",
    name: "Grok Imagine Image Quality",
    provider: "xAI",
    availableProviders: ["pika"],
    defaultProvider: "pika",
    kind: "image",
    defaultAspectRatio: "16:9",
    description: "High-quality Grok Imagine image generation and editing.",
    parameters: [
      {
        id: "resolution",
        label: "Resolution",
        type: "select",
        options: ["1K", "2K"].map((value) => ({ label: value, value })),
        defaultValue: "1K",
      },
      {
        id: "count",
        label: "Count",
        type: "number",
        min: 1,
        max: 10,
        step: 1,
        defaultValue: 1,
      },
    ],
    defaultParams: { resolution: "1K", count: 1 },
    input: {
      requiresPrompt: true,
      inputMode: { images: { max: 3 } },
      promptModalities: ["text", "image"],
      referenceBinding: GROUPED_REFERENCE_BINDING,
    },
  },
  {
    id: "grok-imagine-video-1.5",
    name: "Grok Imagine Video 1.5",
    provider: "xAI",
    availableProviders: ["pika"],
    defaultProvider: "pika",
    kind: "video",
    defaultAspectRatio: "16:9",
    description:
      "Grok Imagine 1.5 image-to-video from the current Pika catalog.",
    parameters: [
      {
        id: "duration",
        label: "Duration",
        type: "number",
        min: 1,
        max: 15,
        step: 1,
        defaultValue: 6,
      },
      {
        id: 'resolution',
        label: 'Resolution',
        type: 'select',
        options: [
          { label: '480p', value: '480p' },
          { label: '720p', value: '720p' },
        ],
        defaultValue: "720p",
      },
    ],
    defaultParams: { duration: 6, resolution: "720p" },
    input: {
      requiresPrompt: true,
      inputMode: { images: { min: 1, max: 1 } },
      promptModalities: ["text", "image"],
      referenceBinding: GROUPED_REFERENCE_BINDING,
    },
  },
  {
    id: "lyria-3-pro",
    name: "Lyria 3 Pro",
    provider: "Google",
    availableProviders: ["pika"],
    defaultProvider: "pika",
    kind: "audio",
    defaultAspectRatio: "1:1",
    description:
      "Google Lyria 3 Pro music generation from the current Pika catalog.",
    parameters: [],
    defaultParams: {},
    input: { requiresPrompt: true, inputMode: {} },
  },
  {
    id: 'minimax-speech-2.8-hd',
    name: 'MiniMax Speech 2.8 HD',
    provider: 'MiniMax',
    availableProviders: ['pika'],
    defaultProvider: 'pika',
    kind: 'audio',
    defaultAspectRatio: '1:1',
    description: 'MiniMax Speech 2.8 HD text-to-speech from the current Pika catalog.',
    parameters: [
      {
        id: "voice_id",
        label: "Voice ID",
        type: "text",
        required: true,
      },
    ],
    defaultParams: {},
    input: { requiresPrompt: true, inputMode: {} },
  },
  // ─── Image: Nano Banana 2 (fal.ai) ──────────────────────────
  {
    id: "nano-banana-2",
    name: "Nano Banana 2",
    aliases: ["gemini-3.1-flash-image"],
    provider: "Google",
    availableProviders: ["official", "pika", "replicate"],
    defaultProvider: "official",
    kind: "image",
    defaultAspectRatio: "16:9",
    description: "State-of-the-art fast image generation and editing.",
    parameters: [
      {
        id: "aspect_ratio",
        label: "Aspect Ratio",
        type: "select",
        options: NANO_BANANA_ASPECT_RATIOS.map((r) => ({
          label: r.label,
          value: r.value,
        })),
        defaultValue: '16:9',
      },
      {
        id: "resolution",
        label: "Resolution",
        type: "select",
        options: NANO_BANANA_RESOLUTIONS.map((s) => ({
          label: s.label,
          value: s.value,
        })),
        defaultValue: '1K',
      },
      {
        id: 'count',
        label: 'Count',
        type: 'number',
        min: 1,
        max: 4,
        step: 1,
        defaultValue: 1,
        description: 'How many images to generate.',
      },
    ],
    defaultParams: {
      aspect_ratio: '16:9',
      resolution: '1K',
      count: 1,
    },
    input: {
      requiresPrompt: true,
      inputMode: { images: { max: 8 } },
      promptModalities: ['text', 'image'],
      referenceBinding: GROUPED_REFERENCE_BINDING,
    },
  },
  // ─── Image: Nano Banana 2 Lite (Google) ────────────────────
  {
    id: 'nano-banana-2-lite',
    name: 'Nano Banana 2 Lite',
    aliases: ['gemini-3.1-flash-lite-image'],
    provider: 'Google',
    availableProviders: ['official'],
    defaultProvider: 'official',
    kind: 'image',
    defaultAspectRatio: '16:9',
    description: 'Fast Gemini 3.1 Flash-Lite image generation.',
    parameters: [
      {
        id: "aspect_ratio",
        label: "Aspect Ratio",
        type: "select",
        options: NANO_BANANA_LITE_ASPECT_RATIOS.map((r) => ({
          label: r.label,
          value: r.value,
        })),
        defaultValue: "16:9",
      },
    ],
    defaultParams: {
      aspect_ratio: "16:9",
    },
    input: {
      requiresPrompt: true,
      inputMode: { images: { max: 14 } },
      promptModalities: ["text", "image"],
      referenceBinding: GROUPED_REFERENCE_BINDING,
    },
  },
  // ─── Image: GPT Image 2 (OpenAI) ────────────────────────────
  {
    id: "gpt-image-2",
    name: "GPT Image 2",
    provider: "OpenAI",
    availableProviders: ["official", "pika", "replicate"],
    defaultProvider: "official",
    kind: "image",
    defaultAspectRatio: "1:1",
    description:
      "OpenAI GPT Image 2 — high-quality image generation and editing.",
    parameters: [
      {
        id: "aspect_ratio",
        label: "Aspect Ratio",
        type: "select",
        options: GPT_IMAGE_ASPECT_RATIOS.map((r) => ({
          label: r.label,
          value: r.value,
        })),
        defaultValue: '1:1',
      },
      {
        id: "resolution",
        label: "Resolution",
        type: "select",
        options: GPT_IMAGE_RESOLUTION_TIERS.map((t) => ({
          label: t.label,
          value: t.value,
        })),
        defaultValue: '2K',
      },
      {
        id: 'quality',
        label: 'Quality',
        type: 'select',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: 'Low', value: 'low' },
          { label: 'Medium', value: 'medium' },
          { label: 'High', value: 'high' },
        ],
        defaultValue: 'auto',
      },
      {
        id: 'output_format',
        label: 'Format',
        type: 'select',
        options: [
          { label: 'PNG', value: 'png' },
          { label: 'JPEG', value: 'jpeg' },
          { label: 'WebP', value: 'webp' },
        ],
        defaultValue: 'png',
      },
      {
        // gpt-image-2 does not support transparent backgrounds.
        id: 'background',
        label: 'Background',
        type: 'select',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: 'Opaque', value: 'opaque' },
        ],
        defaultValue: 'auto',
      },
      {
        id: 'moderation',
        label: 'Moderation',
        type: 'select',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: 'Low', value: 'low' },
        ],
        defaultValue: 'auto',
      },
      {
        id: 'count',
        label: 'Count',
        type: 'number',
        min: 1,
        max: 4,
        step: 1,
        defaultValue: 1,
      },
    ],
    defaultParams: {
      size: 'auto',
      quality: 'auto',
      output_format: 'png',
      background: 'auto',
      moderation: 'auto',
      count: 1,
    },
    input: {
      requiresPrompt: true,
      inputMode: { images: { max: 16 } },
      promptModalities: ['text', 'image'],
      referenceBinding: GROUPED_REFERENCE_BINDING,
    },
    maxRuntimeMs: 3 * 60 * 1000,
  },
  // ─── Image: Seedream 4.5 (fal.ai) ───────────────────────────
  {
    id: "seedream-4.5",
    name: "Seedream 4.5",
    provider: "ByteDance",
    kind: "image",
    defaultAspectRatio: "1:1",
    description:
      "ByteDance Seedream 4.5 image generation and editing through fal.ai.",
    parameters: [
      aspectRatioParameter({
        ratios: CANONICAL_IMAGE_ASPECT_RATIOS.map((r) => r.value),
        defaultValue: "auto",
        auto: { label: "Auto" },
      }),
      {
        // Seedream's own tier, kept separate from the ratio the way minimax-h3
        // already separates them. Folding both into one `image_size` enum made
        // "Auto 2K" look like an aspect ratio.
        id: 'resolution',
        label: 'Resolution',
        type: 'select',
        options: [
          { label: '2K', value: '2K' },
          { label: '4K', value: '4K' },
        ],
        defaultValue: '2K',
      },
      {
        id: 'count',
        label: 'Count',
        type: 'number',
        min: 1,
        max: 4,
        step: 1,
        defaultValue: 1,
      },
      {
        id: 'max_images',
        label: 'Images per generation',
        type: 'number',
        min: 1,
        max: 4,
        step: 1,
        defaultValue: 1,
      },
    ],
    defaultParams: {
      image_size: 'auto_2K',
      count: 1,
      max_images: 1,
    },
    input: { requiresPrompt: true, inputMode: { images: { max: 10 } }, promptModalities: ['text', 'image'], referenceBinding: GROUPED_REFERENCE_BINDING },
    maxRuntimeMs: 4 * 60 * 1000,
  },
  // ─── Image: FLUX Schnell (fal.ai) ────────────────────────────
  {
    id: "flux-schnell",
    name: "FLUX Schnell",
    provider: "fal.ai",
    availableProviders: ["replicate"],
    defaultProvider: "replicate",
    kind: "image",
    defaultAspectRatio: "16:9",
    description: "Ultra-fast image generation, ~1s per image.",
    parameters: [
      aspectRatioParameter({
        ratios: CANONICAL_IMAGE_ASPECT_RATIOS.map((r) => r.value),
        defaultValue: "16:9",
      }),
      {
        id: 'num_inference_steps',
        label: 'Steps',
        type: 'number',
        min: 1,
        max: 12,
        step: 1,
        defaultValue: 4,
        description: 'More steps = higher quality but slower.',
      },
      {
        id: 'count',
        label: 'Count',
        type: 'number',
        min: 1,
        max: 4,
        step: 1,
        defaultValue: 1,
      },
    ],
    defaultParams: {
      image_size: 'landscape_16_9',
      num_inference_steps: 4,
      count: 1,
    },
    input: { requiresPrompt: true, inputMode: {} },
  },
  // ─── Image: FLUX Dev (fal.ai) ────────────────────────────────
  {
    id: "flux-dev",
    name: "FLUX Dev",
    provider: "fal.ai",
    kind: "image",
    defaultAspectRatio: "16:9",
    description: "High-quality image generation with great prompt following.",
    parameters: [
      aspectRatioParameter({
        ratios: CANONICAL_IMAGE_ASPECT_RATIOS.map((r) => r.value),
        defaultValue: "16:9",
      }),
      {
        id: 'num_inference_steps',
        label: 'Steps',
        type: 'number',
        min: 1,
        max: 50,
        step: 1,
        defaultValue: 28,
        description: 'More steps = higher quality but slower.',
      },
      {
        id: 'guidance_scale',
        label: 'Guidance Scale',
        type: 'slider',
        min: 1,
        max: 20,
        step: 0.5,
        defaultValue: 3.5,
        description: 'How closely to follow the prompt.',
      },
      {
        id: 'count',
        label: 'Count',
        type: 'number',
        min: 1,
        max: 4,
        step: 1,
        defaultValue: 1,
      },
    ],
    defaultParams: {
      image_size: 'landscape_16_9',
      num_inference_steps: 28,
      guidance_scale: 3.5,
      count: 1,
    },
    input: { requiresPrompt: true, inputMode: {} },
  },
  // ─── Video: Pika 2.5 (Pika API Club) ───────────────────────
  {
    id: 'pika-2.5',
    name: 'Pika 2.5',
    provider: 'Pika',
    availableProviders: ['pika'],
    defaultProvider: 'pika',
    kind: 'video',
    defaultAspectRatio: '1:1',
    description: 'Pika 2.5 text-to-video and image-to-video through the Pika API Club.',
    parameters: [
      {
        id: 'duration',
        label: 'Duration',
        type: 'select',
        options: [
          { label: "5s", value: 5 },
          { label: "10s (requires image)", value: 10 },
        ],
        defaultValue: 5,
        description:
          "Text-to-video supports 5s; image-to-video supports 5s or 10s.",
      },
      {
        id: 'resolution',
        label: 'Resolution',
        type: 'select',
        options: [
          { label: "720p", value: "720p" },
          { label: "1080p", value: "1080p" },
        ],
        defaultValue: "1080p",
      },
      {
        id: 'negative_prompt',
        label: 'Negative prompt',
        type: 'text',
        required: false,
      },
      {
        id: 'seed',
        label: 'Seed',
        type: 'number',
        required: false,
      },
    ],
    defaultParams: {
      duration: 5,
      resolution: "1080p",
    },
    input: { requiresPrompt: true, inputMode: { images: { max: 1 } } },
  },
  // ─── Video: Sora 2 (fal.ai) ─────────────────────────────────
  {
    // Single card — provider auto-routes to /text-to-video or /image-to-video.
    id: "sora-2",
    name: "Sora 2",
    provider: "fal.ai",
    kind: "video",
    defaultAspectRatio: "16:9",
    description: "OpenAI Sora 2 — text-to-video or animate a still image.",
    parameters: [
      {
        id: 'duration',
        label: 'Duration',
        type: 'select',
        options: [
          { label: '4s', value: 4 },
          { label: '8s', value: 8 },
          { label: '12s', value: 12 },
          { label: '16s', value: 16 },
          { label: '20s', value: 20 },
        ],
        defaultValue: 4,
      },
      {
        id: "aspect_ratio",
        label: "Aspect Ratio",
        type: "select",
        options: SORA_ASPECT_RATIOS.map((r) => ({
          label: r.label,
          value: r.value,
        })),
        defaultValue: "16:9",
      },
      {
        id: 'resolution',
        label: 'Resolution',
        type: 'select',
        options: [{ label: '720p', value: '720p' }, { label: '1080p', value: '1080p' }],
        defaultValue: '720p',
      },
    ],
    defaultParams: {
      duration: 4,
      aspect_ratio: '16:9',
      resolution: '720p',
    },
    input: { requiresPrompt: true, inputMode: { images: { max: 1 } } },
  },
  // ─── Video: Seedance 2.0 image-to-video ────────────────────
  // Start frame required, end frame optional — the native shape of
  // bytedance/seedance-2.0/image-to-video (a single image is just the start
  // slot; optional end slot constrains the final frame).
  {
    id: "seedance-2-startend",
    name: "Seedance 2.0 (Start/End)",
    provider: "fal.ai",
    availableProviders: ["volcengine-modelark", "pika", "replicate"],
    defaultProvider: "volcengine-modelark",
    kind: "video",
    defaultAspectRatio: "16:9",
    description:
      "Seedance 2.0 — animate from a start frame, optionally constrained to a target end frame.",
    parameters: [
      {
        id: 'duration',
        label: 'Duration',
        type: 'select',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: '4s', value: 4 },
          { label: '6s', value: 6 },
          { label: '8s', value: 8 },
          { label: '10s', value: 10 },
          { label: '15s', value: 15 },
        ],
        defaultValue: 'auto',
      },
      {
        id: 'resolution',
        label: 'Resolution',
        type: 'select',
        options: [
          { label: '480p', value: '480p' },
          { label: '720p', value: '720p' },
        ],
        defaultValue: '720p',
      },
      {
        id: 'generate_audio',
        label: 'Native audio',
        type: 'boolean',
        defaultValue: true,
      },
      {
        id: 'seed',
        label: 'Seed',
        type: 'number',
        required: false,
        description: 'Optional deterministic seed. The same seed may still produce minor variations.',
      },
    ],
    defaultParams: {
      duration: 'auto',
      resolution: '720p',
      generate_audio: true,
    },
    input: {
      requiresPrompt: true,
      inputMode: {
        startEnd: { constraints: SEEDANCE_IMAGE_CONSTRAINTS },
        maxEmbeddedRequestBytes: SEEDANCE_MAX_EMBEDDED_REQUEST_BYTES,
      },
    },
  },
  // ─── Video: Seedance 2.0 reference-to-video ────────────────
  // Separate endpoint with multi-modal refs. Up to 15 total files across
  // images (≤9), videos (≤3), audios (≤3). Positional prompt references
  // (@Image1, @Video2, @Audio1).
  {
    id: "seedance-2-ref",
    aliases: ["seedance-2-text"],
    name: "Seedance 2.0 (全能参考)",
    provider: "ByteDance",
    availableProviders: ["volcengine-modelark", "pika", "replicate"],
    defaultProvider: "volcengine-modelark",
    kind: "video",
    defaultAspectRatio: "16:9",
    description:
      "Seedance 2.0 all-purpose generation with optional image, video, and audio references.",
    parameters: [
      {
        id: 'duration',
        label: 'Duration',
        type: 'select',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: '4s', value: 4 },
          { label: '6s', value: 6 },
          { label: '8s', value: 8 },
          { label: '10s', value: 10 },
          { label: '15s', value: 15 },
        ],
        defaultValue: 'auto',
      },
      {
        id: "aspect_ratio",
        label: "Aspect Ratio",
        type: "select",
        options: SEEDANCE_ASPECT_RATIOS.map((r) => ({
          label: r.label,
          value: r.value,
        })),
        defaultValue: 'auto',
      },
      {
        id: 'resolution',
        label: 'Resolution',
        type: 'select',
        options: [
          { label: '480p', value: '480p' },
          { label: '720p', value: '720p' },
        ],
        defaultValue: '720p',
      },
      {
        id: 'generate_audio',
        label: 'Native audio',
        type: 'boolean',
        defaultValue: true,
      },
      {
        id: 'seed',
        label: 'Seed',
        type: 'number',
        required: false,
        description: 'Optional deterministic seed. The same seed may still produce minor variations.',
      },
      {
        id: 'edit_mode',
        label: 'Edit referenced video',
        type: 'boolean',
        required: false,
        description: 'Edit the attached video instead of generating a new clip from references.',
        defaultValue: false,
      },
    ],
    defaultParams: {
      duration: 'auto',
      aspect_ratio: 'auto',
      resolution: '720p',
      generate_audio: true,
      edit_mode: false,
    },
    input: {
      requiresPrompt: true,
      referenceBinding: POSITIONAL_REFERENCE_BINDING,
      inputMode: {
        images: { max: 9, constraints: SEEDANCE_IMAGE_CONSTRAINTS },
        videos: {
          max: 3,
          constraints: { ...SEEDANCE_VIDEO_CONSTRAINTS, maxDurationMs: 15_000 },
          maxTotalDurationMs: 15_000,
        },
        audios: {
          max: 3,
          requiresAnyOf: ['image', 'video'],
          constraints: { ...SEEDANCE_AUDIO_CONSTRAINTS, maxDurationMs: 15_000 },
          maxTotalDurationMs: 15_000,
        },
        maxTotalReferences: 15,
        maxEmbeddedRequestBytes: SEEDANCE_MAX_EMBEDDED_REQUEST_BYTES,
      },
      promptModalities: ['text', 'image', 'video', 'audio'],
    },
  },
  // ─── Video: Seedance 2.0 continuation ─────────────────────
  {
    id: 'seedance-2-extend',
    name: 'Seedance 2.0 (Video Extension)',
    provider: 'ByteDance',
    availableProviders: ['volcengine-modelark'],
    defaultProvider: 'volcengine-modelark',
    kind: 'video',
    defaultAspectRatio: '16:9',
    description: 'Continue one to three ordered source videos with Seedance 2.0.',
    parameters: [
      {
        id: 'duration',
        label: 'Duration',
        type: 'select',
        options: [
          { label: 'Auto', value: 'auto' },
          ...Array.from({ length: 12 }, (_, index) => ({
            label: `${index + 4}s`,
            value: index + 4,
          })),
        ],
        defaultValue: 'auto',
      },
      {
        id: "resolution",
        label: "Resolution",
        type: "select",
        options: ["480p", "720p", "1080p", "4k"].map((value) => ({
          label: value,
          value,
        })),
        defaultValue: '720p',
      },
      {
        id: 'generate_audio',
        label: 'Native audio',
        type: 'boolean',
        defaultValue: true,
      },
    ],
    defaultParams: { duration: 'auto', resolution: '720p', generate_audio: true },
    input: {
      requiresPrompt: true,
      inputMode: {
        videos: {
          min: 1,
          max: 3,
          constraints: { ...SEEDANCE_VIDEO_CONSTRAINTS, maxDurationMs: 15_000 },
          maxTotalDurationMs: 15_000,
        },
        maxTotalReferences: 3,
        maxEmbeddedRequestBytes: SEEDANCE_MAX_EMBEDDED_REQUEST_BYTES,
      },
      promptModalities: ['text', 'video'],
      referenceBinding: POSITIONAL_REFERENCE_BINDING,
      presentation: { type: 'video-continuation' },
    },
    maxRuntimeMs: 30 * 60 * 1000,
  },
  // ─── Video: Seedance 2.5 all-purpose reference ─────────────
  {
    id: 'seedance-2.5-ref',
    aliases: ['seedance-2.5-text'],
    name: 'Seedance 2.5 (全能参考)',
    provider: 'ByteDance',
    availableProviders: ['volcengine-modelark'],
    defaultProvider: 'volcengine-modelark',
    kind: 'video',
    defaultAspectRatio: '16:9',
    description: 'Seedance 2.5 all-purpose generation with optional image, video, and audio references.',
    parameters: [
      {
        id: 'duration',
        label: 'Duration',
        type: 'select',
        options: [
          { label: 'Auto', value: 'auto' },
          ...Array.from({ length: 27 }, (_, index) => ({
            label: `${index + 4}s`,
            value: index + 4,
          })),
        ],
        defaultValue: 5,
      },
      {
        id: "aspect_ratio",
        label: "Aspect Ratio",
        type: "select",
        options: ["auto", "1:1", "3:4", "16:9", "4:3", "9:16", "21:9"].map(
          (value) => ({
            label: value === "auto" ? "Auto" : value,
            value,
          }),
        ),
        defaultValue: "16:9",
      },
      {
        id: 'resolution',
        label: 'Resolution',
        type: 'select',
        options: [
          { label: '480p', value: '480p' },
          { label: '720p', value: '720p' },
        ],
        defaultValue: '720p',
      },
      {
        id: 'generate_audio',
        label: 'Native audio',
        type: 'boolean',
        defaultValue: true,
      },
      {
        id: 'edit_mode',
        label: 'Edit referenced video',
        type: 'boolean',
        required: false,
        description: 'Edit the attached video instead of generating a new clip from references.',
        defaultValue: false,
      },
    ],
    defaultParams: {
      duration: 5,
      aspect_ratio: '16:9',
      resolution: '720p',
      generate_audio: true,
      edit_mode: false,
    },
    input: {
      requiresPrompt: true,
      referenceBinding: POSITIONAL_REFERENCE_BINDING,
      inputMode: {
        images: { max: 30, constraints: SEEDANCE_IMAGE_CONSTRAINTS },
        videos: {
          max: 10,
          constraints: { ...SEEDANCE_VIDEO_CONSTRAINTS, maxDurationMs: 30_000 },
          maxTotalDurationMs: 30_000,
          conditional: [
            {
              when: [{ field: "modelParams.edit_mode", equals: true }],
              min: 1,
              max: 1,
              constraints: {
                minPixels: 407_696,
                minDurationMs: 4_000,
                maxDurationMs: 30_000,
              },
            },
          ],
        },
        audios: {
          max: 10,
          constraints: { ...SEEDANCE_AUDIO_CONSTRAINTS, maxDurationMs: 30_000 },
          maxTotalDurationMs: 30_000,
        },
        maxTotalReferences: 50,
        maxEmbeddedRequestBytes: SEEDANCE_MAX_EMBEDDED_REQUEST_BYTES,
      },
      promptModalities: ['text', 'image', 'video', 'audio'],
    },
    maxRuntimeMs: 30 * 60 * 1000,
  },
  // ─── Video: Seedance 2.5 first / last frame ────────────────
  {
    id: 'seedance-2.5-startend',
    name: 'Seedance 2.5 (Start / End Frame)',
    provider: 'ByteDance',
    availableProviders: ['volcengine-modelark'],
    defaultProvider: 'volcengine-modelark',
    kind: 'video',
    defaultAspectRatio: '16:9',
    description: 'Animate from a required start frame toward an optional end frame with Seedance 2.5.',
    parameters: [
      {
        id: 'duration',
        label: 'Duration',
        type: 'select',
        options: [
          { label: 'Auto', value: 'auto' },
          ...Array.from({ length: 27 }, (_, index) => ({
            label: `${index + 4}s`,
            value: index + 4,
          })),
        ],
        defaultValue: 5,
      },
      {
        id: 'resolution',
        label: 'Resolution',
        type: 'select',
        options: [
          { label: '480p', value: '480p' },
          { label: '720p', value: '720p' },
        ],
        defaultValue: '720p',
      },
      {
        id: 'generate_audio',
        label: 'Native audio',
        type: 'boolean',
        defaultValue: true,
      },
    ],
    defaultParams: { duration: 5, resolution: '720p', generate_audio: true },
    input: {
      requiresPrompt: true,
      inputMode: {
        startEnd: { constraints: SEEDANCE_IMAGE_CONSTRAINTS },
        maxEmbeddedRequestBytes: SEEDANCE_MAX_EMBEDDED_REQUEST_BYTES,
      },
      promptModalities: ['text'],
    },
    maxRuntimeMs: 30 * 60 * 1000,
  },
  // ─── Video: Seedance 2.5 continuation ─────────────────────
  {
    id: 'seedance-2.5-extend',
    name: 'Seedance 2.5 (Video Extension)',
    provider: 'ByteDance',
    availableProviders: ['volcengine-modelark'],
    defaultProvider: 'volcengine-modelark',
    kind: 'video',
    defaultAspectRatio: '16:9',
    description: 'Continue one to ten ordered source videos with Seedance 2.5.',
    parameters: [
      {
        id: 'duration',
        label: 'Duration',
        type: 'select',
        options: [
          { label: 'Auto', value: 'auto' },
          ...Array.from({ length: 27 }, (_, index) => ({
            label: `${index + 4}s`,
            value: index + 4,
          })),
        ],
        defaultValue: 'auto',
      },
      {
        id: "resolution",
        label: "Resolution",
        type: "select",
        options: ["480p", "720p"].map((value) => ({ label: value, value })),
        defaultValue: "720p",
      },
      {
        id: 'generate_audio',
        label: 'Native audio',
        type: 'boolean',
        defaultValue: true,
      },
    ],
    defaultParams: {
      duration: 'auto',
      resolution: '720p',
      generate_audio: true,
    },
    input: {
      requiresPrompt: true,
      inputMode: {
        videos: {
          min: 1,
          max: 10,
          constraints: { ...SEEDANCE_VIDEO_CONSTRAINTS, maxDurationMs: 30_000 },
          maxTotalDurationMs: 30_000,
        },
        maxTotalReferences: 10,
        maxEmbeddedRequestBytes: SEEDANCE_MAX_EMBEDDED_REQUEST_BYTES,
      },
      promptModalities: ['text', 'video'],
      referenceBinding: POSITIONAL_REFERENCE_BINDING,
      presentation: { type: 'video-continuation' },
    },
    maxRuntimeMs: 30 * 60 * 1000,
  },
  // ─── Video: MiniMax H3 all-purpose reference ───────────────
  {
    id: "minimax-h3",
    name: "MiniMax H3 (全能参考)",
    aliases: [
      "MiniMax-H3",
      "hailuo-3",
      "minimax-hailuo-3",
      "minimax-h3-ref",
      "minimax-h3-reference",
    ],
    provider: "MiniMax",
    availableProviders: ["minimax", "pika"],
    defaultProvider: "minimax",
    kind: "video",
    defaultAspectRatio: "16:9",
    description:
      "MiniMax H3 all-purpose generation with optional ordered image, video, and audio references.",
    parameters: [
      {
        id: 'duration',
        label: 'Duration',
        type: 'select',
        options: Array.from({ length: 12 }, (_, index) => ({
          label: `${index + 4}s`,
          value: index + 4,
        })),
        defaultValue: 5,
      },
      {
        id: 'aspect_ratio',
        label: 'Aspect Ratio',
        type: 'select',
        options: [
          { label: "Auto", value: "adaptive" },
          ...["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].map((value) => ({
            label: value,
            value,
          })),
        ],
        defaultValue: 'adaptive',
      },
      {
        id: 'resolution',
        label: 'Resolution',
        type: 'select',
        options: [{ label: '768P', value: '768P' }, { label: '2K', value: '2K' }],
        defaultValue: '2K',
      },
    ],
    defaultParams: {
      duration: 5,
      aspect_ratio: 'adaptive',
      resolution: '2K',
    },
    input: {
      requiresPrompt: true,
      referenceBinding: {
        type: 'ordered-content-parts',
        usesRoles: true,
        modalityScopedIndexes: true,
      },
      inputMode: {
        images: { max: 9, constraints: MINIMAX_H3_IMAGE_CONSTRAINTS },
        videos: { max: 3, constraints: MINIMAX_H3_VIDEO_CONSTRAINTS, maxTotalDurationMs: 15_000 },
        audios: { max: 3, requiresAnyOf: ['image', 'video'], constraints: MINIMAX_H3_AUDIO_CONSTRAINTS, maxTotalDurationMs: 15_000 },
        maxTotalReferences: 12,
        maxEmbeddedRequestBytes: MINIMAX_H3_MAX_EMBEDDED_REQUEST_BYTES,
      },
      promptModalities: ['text', 'image', 'video', 'audio'],
    },
    maxRuntimeMs: 15 * 60 * 1000,
  },
  // ─── Video: MiniMax H3 first / last frame ──────────────────
  {
    id: "minimax-h3-startend",
    name: "MiniMax H3 (Start / End Frame)",
    aliases: ["minimax-h3-start-end"],
    provider: "MiniMax",
    availableProviders: ["minimax", "pika"],
    defaultProvider: "minimax",
    kind: "video",
    defaultAspectRatio: "16:9",
    description:
      "Animate from a required start frame toward an optional end frame with MiniMax H3.",
    promptGuidance:
      "Use start and end frames with matching aspect ratios. The output ratio follows the input frames.",
    parameters: [
      {
        id: 'duration',
        label: 'Duration',
        type: 'select',
        options: Array.from({ length: 12 }, (_, index) => ({
          label: `${index + 4}s`,
          value: index + 4,
        })),
        defaultValue: 5,
      },
      {
        id: 'resolution',
        label: 'Resolution',
        type: 'select',
        options: [{ label: '768P', value: '768P' }, { label: '2K', value: '2K' }],
        defaultValue: '2K',
      },
    ],
    defaultParams: {
      duration: 5,
      resolution: '2K',
    },
    input: {
      requiresPrompt: true,
      inputMode: {
        startEnd: { constraints: MINIMAX_H3_IMAGE_CONSTRAINTS },
        maxEmbeddedRequestBytes: MINIMAX_H3_MAX_EMBEDDED_REQUEST_BYTES,
      },
      promptModalities: ['text'],
    },
    maxRuntimeMs: 15 * 60 * 1000,
  },
  // ─── Video: Kling 3 Pro (fal.ai) — first frame + optional end frame ────
  {
    id: "kling-3",
    name: "Kling 3 Pro",
    provider: "fal.ai",
    availableProviders: ["kling", "pika"],
    defaultProvider: "kling",
    kind: "video",
    defaultAspectRatio: "16:9",
    description: "Kling 3 Pro — first + optional end frame, with native audio.",
    parameters: [
      durationParameter({
        seconds: Array.from({ length: 13 }, (_, index) => index + 3),
        defaultValue: 5,
      }),
      {
        id: 'generate_audio',
        label: 'Native audio',
        type: 'boolean',
        defaultValue: true,
      },
    ],
    defaultParams: {
      duration: 5,
      generate_audio: true,
    },
    input: { requiresPrompt: true, inputMode: { startEnd: {} } },
  },
  // ─── Video: FLUX 3 (BFL official + fal.ai) ─────────────────
  {
    id: "flux-3-video",
    aliases: ["flux3-video", "flux-3"],
    name: "FLUX 3 Video",
    provider: "Black Forest Labs",
    availableProviders: ["official", "pika"],
    defaultProvider: "official",
    kind: "video",
    defaultAspectRatio: "16:9",
    description:
      "FLUX 3 text-to-video with synchronized audio and clips up to 20 seconds.",
    parameters: flux3VideoParameters(),
    defaultParams: FLUX3_VIDEO_DEFAULT_PARAMS,
    input: { requiresPrompt: true, inputMode: {}, promptModalities: ['text'] },
    maxRuntimeMs: 30 * 60 * 1000,
  },
  {
    id: "flux-3-video-keyframes",
    aliases: ["flux3-keyframes", "flux-3-image-to-video"],
    name: "FLUX 3 Video (Keyframes)",
    provider: "Black Forest Labs",
    availableProviders: ["official"],
    defaultProvider: "official",
    kind: "video",
    defaultAspectRatio: "16:9",
    description:
      "Animate one image or connect up to ten ordered keyframes with FLUX 3.",
    parameters: flux3VideoParameters({ allowAutoDuration: false }),
    defaultParams: FLUX3_KEYFRAME_VIDEO_DEFAULT_PARAMS,
    input: {
      requiresPrompt: true,
      inputMode: { images: { min: 1, max: 10 }, maxTotalReferences: 10 },
      promptModalities: ['text', 'image'],
      referenceBinding: { type: 'grouped-references' },
      presentation: { type: 'keyframes', timing: 'explicit', frameRate: 24 },
    },
    maxRuntimeMs: 30 * 60 * 1000,
  },
  {
    id: "flux-3-video-continue",
    aliases: ["flux3-continue", "flux-3-extend-video"],
    name: "FLUX 3 Video (Continue)",
    provider: "Black Forest Labs",
    availableProviders: ["official"],
    defaultProvider: "official",
    kind: "video",
    defaultAspectRatio: "16:9",
    description:
      "Continue one existing MP4 clip from its final frames with synchronized audio.",
    parameters: flux3VideoParameters(),
    defaultParams: FLUX3_VIDEO_DEFAULT_PARAMS,
    input: {
      requiresPrompt: true,
      inputMode: {
        videos: {
          min: 1,
          max: 1,
          constraints: {
            mimeTypes: ['video/mp4'],
            fileExtensions: ['mp4'],
            maxBytes: 50 * 1024 * 1024,
            maxDurationMs: 15_000,
          },
        },
        maxTotalReferences: 1,
      },
      promptModalities: ['text', 'video'],
      referenceBinding: { type: 'grouped-references' },
      presentation: { type: 'video-continuation' },
    },
    maxRuntimeMs: 30 * 60 * 1000,
  },
  // ─── Image: Recraft V4 Pro (fal.ai) ──────────────────────────
  {
    id: "recraft-v4",
    name: "Recraft V4",
    provider: "fal.ai",
    availableProviders: ["pika"],
    defaultProvider: "pika",
    kind: "image",
    defaultAspectRatio: "16:9",
    description:
      "Designer-grade image generation with color control and text rendering.",
    parameters: [
      aspectRatioParameter({
        ratios: CANONICAL_IMAGE_ASPECT_RATIOS.map((r) => r.value),
        defaultValue: "16:9",
      }),
    ],
    defaultParams: {
      image_size: 'square_hd',
    },
    input: { requiresPrompt: true, inputMode: {} },
  },
  // ─── Image: FLUX 2 Pro (fal.ai) ──────────────────────────────
  {
    id: "flux-2-pro",
    name: "FLUX 2 Pro",
    provider: "fal.ai",
    kind: "image",
    defaultAspectRatio: "4:3",
    description: "Latest FLUX flagship — high-quality image generation.",
    parameters: [
      aspectRatioParameter({
        ratios: CANONICAL_IMAGE_ASPECT_RATIOS.map((r) => r.value),
        defaultValue: "16:9",
      }),
      {
        id: 'safety_tolerance',
        label: 'Safety Tolerance',
        type: 'select',
        options: [
          { label: 'Strict (1)', value: '1' },
          { label: 'Moderate (2)', value: '2' },
          { label: 'Balanced (3)', value: '3' },
          { label: 'Relaxed (4)', value: '4' },
          { label: 'Permissive (5)', value: '5' },
        ],
        defaultValue: '2',
      },
    ],
    defaultParams: {
      image_size: 'landscape_4_3',
      safety_tolerance: '2',
    },
    input: {
      requiresPrompt: true,
      inputMode: { images: { max: 8 } },
      promptModalities: ['text', 'image'],
      referenceBinding: GROUPED_REFERENCE_BINDING,
    },
  },
  // ─── Image: Nano Banana Pro (Google) ────────────────────────
  {
    id: 'nano-banana-pro',
    name: 'Nano Banana Pro',
    aliases: ['gemini-3-pro-image'],
    provider: 'Google',
    availableProviders: ['official'],
    defaultProvider: 'official',
    kind: 'image',
    defaultAspectRatio: '16:9',
    description: 'Highest quality Google image generation and editing.',
    parameters: [
      {
        id: "aspect_ratio",
        label: "Aspect Ratio",
        type: "select",
        options: IMAGEN_ASPECT_RATIOS.map((r) => ({
          label: r.label,
          value: r.value,
        })),
        defaultValue: "16:9",
      },
    ],
    defaultParams: {
      aspect_ratio: "16:9",
    },
    input: {
      requiresPrompt: true,
      inputMode: { images: { max: 8 } },
      promptModalities: ["text", "image"],
      referenceBinding: GROUPED_REFERENCE_BINDING,
    },
  },
  // ─── Video: Veo 3.1 (Google native via Vercel AI SDK) ──────
  //
  // Veo 3.1 Vertex pricing is identical across input modes (only variant +
  // audio on/off differ), so we only split cards where the input *contract*
  // conflicts. Specifically:
  //   - text-only + reference-image workflows share one card, since the
  //     reference-image rule (`images.max: 3`) already covers "zero refs" as
  //     the text-only case.
  //   - startEnd (first frame required, last optional) is a separate card
  //     because the `startEnd` contract has a required slot that can't
  //     coexist with optional ref images in the same UI.
  //
  // Text-only video variants are intentionally not published as product
  // cards. A video card must expose at least one meaningful reference input.

  {
    id: 'veo-3.1',
    name: 'Veo 3.1',
    provider: 'Google',
    availableProviders: ['official'],
    defaultProvider: 'official',
    kind: 'video',
    defaultAspectRatio: '16:9',
    description: 'Google Veo 3.1 — text-to-video, optionally with 1–3 reference subject images.',
    parameters: [
      VEO3_DURATION_PARAMETER,
      {
        id: "aspect_ratio",
        label: "Aspect Ratio",
        type: "select",
        options: VEO3_ASPECT_RATIOS.map((r) => ({
          label: r.label,
          value: r.value,
        })),
        defaultValue: "16:9",
      },
      {
        id: 'generate_audio',
        label: 'Generate Audio',
        type: 'boolean',
        defaultValue: true,
        description: 'Include natively generated audio.',
      },
    ],
    defaultParams: {
      duration: 4,
      aspect_ratio: '16:9',
      generate_audio: true,
    },
    input: { requiresPrompt: true, inputMode: { images: { max: 3 } } },
  },
  {
    id: 'veo-3.1-startend',
    name: 'Veo 3.1 (Start/End)',
    provider: 'Google',
    availableProviders: ['official'],
    defaultProvider: 'official',
    kind: 'video',
    defaultAspectRatio: '16:9',
    description: 'Google Veo 3.1 — first-and-last-frame interpolation between two key frames.',
    parameters: [
      VEO3_DURATION_PARAMETER,
      {
        id: "aspect_ratio",
        label: "Aspect Ratio",
        type: "select",
        options: VEO3_ASPECT_RATIOS.map((r) => ({
          label: r.label,
          value: r.value,
        })),
        defaultValue: "16:9",
      },
      {
        id: 'generate_audio',
        label: 'Generate Audio',
        type: 'boolean',
        defaultValue: true,
        description: 'Include natively generated audio.',
      },
    ],
    defaultParams: {
      duration: 4,
      aspect_ratio: '16:9',
      generate_audio: true,
    },
    input: { requiresPrompt: true, inputMode: { startEnd: {} } },
  },
  {
    id: 'veo-3.1-fast',
    name: 'Veo 3.1 Fast',
    provider: 'Google',
    availableProviders: ['official'],
    defaultProvider: 'official',
    kind: 'video',
    defaultAspectRatio: '16:9',
    description: 'Google Veo 3.1 Fast — text-to-video, optionally with 1–3 reference subject images.',
    parameters: [
      VEO3_DURATION_PARAMETER,
      {
        id: "aspect_ratio",
        label: "Aspect Ratio",
        type: "select",
        options: VEO3_ASPECT_RATIOS.map((r) => ({
          label: r.label,
          value: r.value,
        })),
        defaultValue: "16:9",
      },
      {
        id: 'generate_audio',
        label: 'Generate Audio',
        type: 'boolean',
        defaultValue: true,
        description: 'Include natively generated audio.',
      },
    ],
    defaultParams: {
      duration: 4,
      aspect_ratio: '16:9',
      generate_audio: true,
    },
    input: { requiresPrompt: true, inputMode: { images: { max: 3 } } },
  },
  {
    id: 'veo-3.1-fast-startend',
    name: 'Veo 3.1 Fast (Start/End)',
    provider: 'Google',
    availableProviders: ['official'],
    defaultProvider: 'official',
    kind: 'video',
    defaultAspectRatio: '16:9',
    description: 'Google Veo 3.1 Fast — first-and-last-frame interpolation between two key frames.',
    parameters: [
      VEO3_DURATION_PARAMETER,
      {
        id: "aspect_ratio",
        label: "Aspect Ratio",
        type: "select",
        options: VEO3_ASPECT_RATIOS.map((r) => ({
          label: r.label,
          value: r.value,
        })),
        defaultValue: "16:9",
      },
      {
        id: 'generate_audio',
        label: 'Generate Audio',
        type: 'boolean',
        defaultValue: true,
        description: 'Include natively generated audio.',
      },
    ],
    defaultParams: {
      duration: 4,
      aspect_ratio: '16:9',
      generate_audio: true,
    },
    input: { requiresPrompt: true, inputMode: { startEnd: {} } },
  },
  {
    id: 'gemini-omni-flash',
    name: 'Gemini Omni Flash',
    aliases: ['gemini-omni-flash-preview'],
    provider: 'Google',
    availableProviders: ['official'],
    defaultProvider: 'official',
    kind: 'video',
    defaultAspectRatio: '16:9',
    description: 'Google Gemini Omni Flash preview — text-to-video generation with native audio output.',
    promptGuidance: 'Describe scene, motion, camera, lighting, timing, and desired audio.',
    parameters: [
      {
        id: 'duration',
        label: 'Duration',
        type: 'select',
        options: Array.from({ length: 8 }, (_, index) => ({
          label: `${index + 3}s`,
          value: index + 3,
        })),
        defaultValue: 5,
      },
      {
        id: 'aspect_ratio',
        label: 'Aspect Ratio',
        type: 'select',
        options: [
          { label: '16:9', value: '16:9' },
          { label: '9:16', value: '9:16' },
        ],
        defaultValue: '16:9',
      },
      {
        id: 'resolution',
        label: 'Resolution',
        type: 'select',
        readOnly: true,
        options: [{ label: '720p', value: '720p' }],
        defaultValue: '720p',
      },
      {
        id: 'frame_rate',
        label: 'Frame Rate',
        type: 'select',
        readOnly: true,
        options: [{ label: '24 fps', value: 24 }],
        defaultValue: 24,
      },
      {
        id: 'native_audio',
        label: 'Native Audio',
        type: 'boolean',
        readOnly: true,
        defaultValue: true,
        description: 'Gemini Omni Flash always returns generated audio with the video.',
      },
    ],
    defaultParams: {
      duration: 5,
      aspect_ratio: '16:9',
      resolution: '720p',
      frame_rate: 24,
      native_audio: true,
    },
    // The captured Interactions request is text-only. Do not advertise reference media until a
    // real accepted request establishes the wire shape; the Provider adapter fails closed too.
    input: { requiresPrompt: true, inputMode: {}, promptModalities: ['text'] },
    maxRuntimeMs: 15 * 60 * 1000,
  },
  // ─── Text ────────────────────────────────────────────────────
  {
    id: 'minimax-m3',
    aliases: ['MiniMax-M3'],
    name: 'MiniMax M3',
    provider: 'MiniMax',
    availableProviders: ['minimax'],
    defaultProvider: 'minimax',
    kind: 'text',
    defaultAspectRatio: '1:1',
    description: 'General-purpose text generation with MiniMax M3.',
    parameters: [
      {
        id: 'system_prompt',
        label: 'System prompt',
        type: 'text',
        placeholder: 'Optional instructions for tone, format, or role',
        defaultValue: '',
      },
    ],
    defaultParams: { system_prompt: '' },
    input: {
      requiresPrompt: true,
      inputMode: {},
      promptModalities: ['text'],
    },
    maxRuntimeMs: 5 * 60 * 1000,
  },
  // ─── Text ────────────────────────────────────────────────────
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4 Text',
    provider: 'OpenAI',
    availableProviders: ['official'],
    defaultProvider: 'official',
    kind: 'text',
    defaultAspectRatio: '1:1',
    description: 'General-purpose text generation. Accepts image context alongside the prompt (vision).',
    parameters: [
      {
        id: 'system_prompt',
        label: 'System prompt',
        type: 'text',
        placeholder: 'Optional instructions for tone, format, or role',
        defaultValue: '',
      },
    ],
    defaultParams: {
      system_prompt: '',
    },
    input: {
      requiresPrompt: true,
      inputMode: { images: { max: 10 } },
      referenceBinding: ORDERED_REFERENCE_BINDING,
      promptModalities: ['text', 'image'],
    },
    maxRuntimeMs: 5 * 60 * 1000,
  },
  {
    id: 'openai-compatible-text',
    name: 'OpenAI-compatible',
    provider: 'OpenAI-compatible',
    availableProviders: ['official'],
    defaultProvider: 'official',
    kind: 'text',
    defaultAspectRatio: '1:1',
    description: 'Use any OpenAI-compatible chat endpoint.',
    parameters: [
      {
        id: 'model_name',
        label: 'Model',
        type: 'text',
        placeholder: 'gpt-5.4 or provider/model',
        defaultValue: 'gpt-5.4',
      },
      {
        id: 'system_prompt',
        label: 'System prompt',
        type: 'text',
        placeholder: 'Optional instructions for tone, format, or role',
        defaultValue: '',
      },
    ],
    defaultParams: {
      model_name: 'gpt-5.4',
      system_prompt: '',
    },
    input: {
      requiresPrompt: true,
      inputMode: { images: { max: 10 } },
      referenceBinding: ORDERED_REFERENCE_BINDING,
      promptModalities: ['text', 'image'],
    },
    maxRuntimeMs: 5 * 60 * 1000,
  },
  {
    id: 'gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
    provider: 'Google',
    availableProviders: ['official'],
    defaultProvider: 'official',
    kind: 'text',
    semanticShape: 'media_analysis',
    defaultAspectRatio: '1:1',
    description: 'Google Gemini 3.5 Flash — near-Pro agentic capability at Flash-tier speed and cost.',
    parameters: [
      {
        id: 'system_prompt',
        label: 'System prompt',
        type: 'text',
        placeholder: 'Optional instructions for tone, format, or role',
        defaultValue: '',
      },
    ],
    defaultParams: {
      system_prompt: '',
    },
    input: {
      requiresPrompt: true,
      inputMode: { images: { max: 16 }, videos: { max: 1 }, audios: { max: 1 } },
      referenceBinding: ORDERED_REFERENCE_BINDING,
      promptModalities: ['text', 'image', 'video', 'audio'],
    },
    maxRuntimeMs: 5 * 60 * 1000,
  },
  {
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro',
    provider: 'Google',
    availableProviders: ['official'],
    defaultProvider: 'official',
    kind: 'text',
    semanticShape: 'media_analysis',
    defaultAspectRatio: '1:1',
    description: 'Google Gemini 3.1 Pro — flagship multimodal reasoning across text, image, video, and audio inputs.',
    parameters: [
      {
        id: 'system_prompt',
        label: 'System prompt',
        type: 'text',
        placeholder: 'Optional instructions for tone, format, or role',
        defaultValue: '',
      },
    ],
    defaultParams: {
      system_prompt: '',
    },
    input: {
      requiresPrompt: true,
      inputMode: { images: { max: 16 }, videos: { max: 1 }, audios: { max: 1 } },
      referenceBinding: ORDERED_REFERENCE_BINDING,
      promptModalities: ['text', 'image', 'video', 'audio'],
    },
    maxRuntimeMs: 5 * 60 * 1000,
  },
  {
    id: 'gemini-3-flash',
    name: 'Gemini 3 Flash',
    provider: 'Google',
    availableProviders: ['official'],
    defaultProvider: 'official',
    kind: 'text',
    semanticShape: 'media_analysis',
    defaultAspectRatio: '1:1',
    description: 'Faster, cheaper Gemini 3 Flash — multimodal across text, image, video, and audio inputs.',
    parameters: [
      {
        id: 'system_prompt',
        label: 'System prompt',
        type: 'text',
        placeholder: 'Optional instructions for tone, format, or role',
        defaultValue: '',
      },
    ],
    defaultParams: {
      system_prompt: '',
    },
    input: {
      requiresPrompt: true,
      inputMode: { images: { max: 16 }, videos: { max: 1 }, audios: { max: 1 } },
      referenceBinding: ORDERED_REFERENCE_BINDING,
      promptModalities: ['text', 'image', 'video', 'audio'],
    },
    maxRuntimeMs: 5 * 60 * 1000,
  },
  {
    id: 'gemini-3.1-flash-lite',
    name: 'Gemini 3.1 Flash-Lite',
    provider: 'Google',
    availableProviders: ['official'],
    defaultProvider: 'official',
    kind: 'text',
    semanticShape: 'media_analysis',
    defaultAspectRatio: '1:1',
    description: 'Google Gemini 3.1 Flash-Lite — low-latency, high-volume text generation with multimodal inputs.',
    parameters: [
      {
        id: 'system_prompt',
        label: 'System prompt',
        type: 'text',
        placeholder: 'Optional instructions for tone, format, or role',
        defaultValue: '',
      },
    ],
    defaultParams: {
      system_prompt: '',
    },
    input: {
      requiresPrompt: true,
      inputMode: { images: { max: 16 }, videos: { max: 1 }, audios: { max: 1 } },
      referenceBinding: ORDERED_REFERENCE_BINDING,
      promptModalities: ['text', 'image', 'video', 'audio'],
    },
    maxRuntimeMs: 5 * 60 * 1000,
  },
  {
    id: 'claude-sonnet-4',
    name: 'Claude Sonnet 4',
    provider: 'Anthropic',
    availableProviders: ['official'],
    defaultProvider: 'official',
    kind: 'text',
    defaultAspectRatio: '1:1',
    description: 'Anthropic Claude Sonnet 4 text generation. Accepts image context alongside the prompt.',
    parameters: [
      {
        id: 'system_prompt',
        label: 'System prompt',
        type: 'text',
        placeholder: 'Optional instructions for tone, format, or role',
        defaultValue: '',
      },
    ],
    defaultParams: {
      system_prompt: '',
    },
    input: {
      requiresPrompt: true,
      inputMode: { images: { max: 20 } },
      referenceBinding: ORDERED_REFERENCE_BINDING,
      promptModalities: ['text', 'image'],
    },
    maxRuntimeMs: 5 * 60 * 1000,
  },
  {
    id: 'anthropic-compatible-text',
    name: 'Anthropic-compatible',
    provider: 'Anthropic-compatible',
    availableProviders: ['official'],
    defaultProvider: 'official',
    kind: 'text',
    defaultAspectRatio: '1:1',
    description: 'Use any Anthropic-compatible messages endpoint.',
    parameters: [
      {
        id: 'model_name',
        label: 'Model',
        type: 'text',
        placeholder: 'claude-sonnet-4-20250514',
        defaultValue: 'claude-sonnet-4-20250514',
      },
      {
        id: 'system_prompt',
        label: 'System prompt',
        type: 'text',
        placeholder: 'Optional instructions for tone, format, or role',
        defaultValue: '',
      },
    ],
    defaultParams: {
      model_name: 'claude-sonnet-4-20250514',
      system_prompt: '',
    },
    input: {
      requiresPrompt: true,
      inputMode: { images: { max: 20 } },
      referenceBinding: ORDERED_REFERENCE_BINDING,
      promptModalities: ['text', 'image'],
    },
    maxRuntimeMs: 5 * 60 * 1000,
  },
  // ─── Transcription: audio in, text out ───────────────────────
  {
    id: 'sensevoice-small-asr',
    name: 'SenseVoice Small',
    provider: 'Local',
    kind: 'text',
    defaultAspectRatio: '1:1',
    description: 'Fast local transcription optimized for Mandarin and Chinese-English speech, with Cantonese, Japanese, and Korean support.',
    promptGuidance: 'Recommended for Chinese voice input and mixed Chinese-English recordings. Use Whisper Large v3 Turbo when broader multilingual coverage matters more.',
    parameters: [],
    defaultParams: {
      asr_model: 'iic/SenseVoiceSmall',
    },
    input: {
      requiresPrompt: false,
      inputMode: { audios: { max: 1, min: 1 } },
      promptModalities: ['audio'],
    },
    maxRuntimeMs: 2 * 60 * 1000,
  },
  {
    id: 'whisper-large-v3-turbo-asr',
    name: 'Whisper Large v3 Turbo',
    provider: 'OpenAI',
    kind: 'text',
    defaultAspectRatio: '1:1',
    description: 'High-accuracy multilingual transcription optimized for Apple Silicon with MLX and word-level timestamps.',
    promptGuidance: 'Best for multilingual interviews, dialogue, and production audio where accurate word timing matters.',
    parameters: [],
    defaultParams: {
      asr_model: 'mlx-community/whisper-large-v3-turbo',
    },
    input: {
      requiresPrompt: false,
      inputMode: { audios: { max: 1, min: 1 } },
      promptModalities: ['audio'],
    },
    maxRuntimeMs: 10 * 60 * 1000,
  },
  {
    id: 'whisper-small-asr',
    name: 'Whisper Small',
    provider: 'OpenAI',
    kind: 'text',
    defaultAspectRatio: '1:1',
    description: 'A lighter multilingual Whisper model for lower-memory Macs, with real word-level timestamps.',
    promptGuidance: 'Choose this on 8 GB Macs or for faster drafts; use Whisper Large v3 Turbo when accuracy matters more.',
    parameters: [],
    defaultParams: {
      asr_model: 'mlx-community/whisper-small-mlx',
    },
    input: {
      requiresPrompt: false,
      inputMode: { audios: { max: 1, min: 1 } },
      promptModalities: ['audio'],
    },
    maxRuntimeMs: 10 * 60 * 1000,
  },
  {
    id: 'parakeet-tdt-0.6b-v3-asr',
    name: 'Parakeet TDT 0.6B v3',
    provider: 'NVIDIA',
    kind: 'text',
    defaultAspectRatio: '1:1',
    description: 'Fast local transcription for 25 European languages with real word-level timestamps. Approx. 2.5 GB download; does not support Chinese.',
    promptGuidance: 'Use for supported European-language audio on Apple Silicon. It does not support Chinese; choose SenseVoice or Whisper for Chinese recordings.',
    parameters: [],
    defaultParams: {
      asr_model: 'mlx-community/parakeet-tdt-0.6b-v3',
    },
    input: {
      requiresPrompt: false,
      inputMode: { audios: { max: 1, min: 1 } },
      promptModalities: ['audio'],
    },
    maxRuntimeMs: 20 * 60 * 1000,
  },
  {
    id: 'vibevoice-asr',
    name: 'VibeVoice ASR',
    provider: 'Microsoft',
    kind: 'text',
    defaultAspectRatio: '1:1',
    description: 'Advanced long-form transcription with speaker diarization, segment timestamps, and Whisper word alignment.',
    promptGuidance: 'Use for meetings, podcasts, and long multi-speaker recordings. This is a large download and also requires Whisper Small for word alignment.',
    parameters: [],
    defaultParams: {
      asr_model: 'mlx-community/VibeVoice-ASR-4bit',
      alignment_model: 'mlx-community/whisper-small-mlx',
    },
    input: {
      requiresPrompt: false,
      inputMode: { audios: { max: 1, min: 1 } },
      promptModalities: ['audio'],
    },
    maxRuntimeMs: 60 * 60 * 1000,
  },
  // ─── Audio ───────────────────────────────────────────────────
  {
    id: 'gemini-3.1-flash-tts',
    name: 'Gemini 3.1 Flash TTS',
    provider: 'Google',
    availableProviders: ['official'],
    defaultProvider: 'official',
    kind: 'audio',
    defaultAspectRatio: '1:1',
    description: 'Google Gemini TTS preview for low-latency controllable single-speaker audio.',
    parameters: GEMINI_TTS_PARAMETERS,
    defaultParams: {
      voice_name: 'Kore',
    },
    input: { requiresPrompt: true, inputMode: {}, promptModalities: ['text'] },
    maxRuntimeMs: 5 * 60 * 1000,
  },
  {
    id: 'kokoro-82m-tts',
    name: 'Kokoro 82M',
    provider: 'Hexgrad',
    kind: 'audio',
    defaultAspectRatio: '1:1',
    description: 'High-quality lightweight local speech with multilingual voices, accelerated by MLX on Apple Silicon.',
    promptGuidance: 'Choose a voice whose language prefix matches the script: a/b for English, z for Mandarin, and j for Japanese.',
    parameters: [
      {
        id: 'voice_name',
        label: 'Voice',
        type: 'select',
        options: [
          { label: 'Heart · US English', value: 'af_heart' },
          { label: 'Bella · US English', value: 'af_bella' },
          { label: 'Adam · US English', value: 'am_adam' },
          { label: 'Emma · British English', value: 'bf_emma' },
          { label: 'Xiaobei · Mandarin', value: 'zf_xiaobei' },
          { label: 'Yunxi · Mandarin', value: 'zm_yunxi' },
          { label: 'Alpha · Japanese', value: 'jf_alpha' },
        ],
        defaultValue: 'af_heart',
      },
      {
        id: 'speed',
        label: 'Speed',
        type: 'slider',
        min: 0.6,
        max: 1.6,
        step: 0.05,
        defaultValue: 1,
      },
    ],
    defaultParams: {
      tts_model: 'mlx-community/Kokoro-82M-4bit',
      voice_name: 'af_heart',
      speed: 1,
    },
    input: { requiresPrompt: true, inputMode: {}, promptModalities: ['text'] },
    maxRuntimeMs: 10 * 60 * 1000,
  },
  {
    id: 'piper-huayan-tts',
    name: 'Piper Huayan',
    provider: 'Local',
    kind: 'audio',
    defaultAspectRatio: '1:1',
    description: 'Downloadable Mandarin voice running fully on-device with Piper ONNX.',
    parameters: [
      {
        id: 'speed',
        label: 'Speed',
        type: 'slider',
        min: 0.6,
        max: 1.6,
        step: 0.05,
        defaultValue: 1,
      },
    ],
    defaultParams: {
      tts_model: 'zh_CN-huayan-medium',
      voice_name: 'huayan',
      speed: 1,
    },
    input: { requiresPrompt: true, inputMode: {}, promptModalities: ['text'] },
    maxRuntimeMs: 2 * 60 * 1000,
  },
  {
    id: 'piper-lessac-tts',
    name: 'Piper Lessac',
    provider: 'Local',
    kind: 'audio',
    defaultAspectRatio: '1:1',
    description: 'Downloadable English voice running fully on-device with Piper ONNX.',
    parameters: [
      {
        id: 'speed',
        label: 'Speed',
        type: 'slider',
        min: 0.6,
        max: 1.6,
        step: 0.05,
        defaultValue: 1,
      },
    ],
    defaultParams: {
      tts_model: 'en_US-lessac-medium',
      voice_name: 'lessac',
      speed: 1,
    },
    input: { requiresPrompt: true, inputMode: {}, promptModalities: ['text'] },
    maxRuntimeMs: 2 * 60 * 1000,
  },
  {
    id: 'gemini-2.5-pro-tts',
    name: 'Gemini 2.5 Pro TTS',
    provider: 'Google',
    availableProviders: ['official'],
    defaultProvider: 'official',
    kind: 'audio',
    defaultAspectRatio: '1:1',
    description: 'Google Gemini TTS with higher control for scripts, narration, and structured speech.',
    parameters: GEMINI_TTS_PARAMETERS,
    defaultParams: {
      voice_name: 'Kore',
    },
    input: { requiresPrompt: true, inputMode: {}, promptModalities: ['text'] },
    maxRuntimeMs: 5 * 60 * 1000,
  },
  {
    id: "minimax-tts",
    name: "MiniMax TTS",
    provider: "MiniMax",
    availableProviders: ["minimax"],
    defaultProvider: "minimax",
    kind: "audio",
    defaultAspectRatio: "1:1",
    description: "High-quality Chinese and English text-to-speech.",
    parameters: [
      {
        id: 'voice_id',
        label: 'Voice',
        type: 'select',
        options: [
          { label: 'Female - Warm', value: 'female-warm' },
          { label: 'Female - Energetic', value: 'female-energetic' },
          { label: 'Male - Calm', value: 'male-calm' },
          { label: 'Male - Storyteller', value: 'male-storyteller' },
        ],
        defaultValue: 'female-warm',
      },
      {
        id: 'speed',
        label: 'Speed',
        type: 'slider',
        min: 0.5,
        max: 2.0,
        step: 0.1,
        defaultValue: 1.0,
        description: 'Speech speed multiplier',
      },
      {
        id: 'pitch',
        label: 'Pitch',
        type: 'slider',
        min: -12,
        max: 12,
        step: 1,
        defaultValue: 0,
        description: 'Voice pitch adjustment (semitones)',
      },
    ],
    defaultParams: {
      voice_id: 'female-warm',
      speed: 1.0,
      pitch: 0,
    },
    input: { requiresPrompt: true, inputMode: {} },
  },
  {
    id: "minimax-music-3",
    name: "MiniMax Music 3.0",
    aliases: ["music-3.0", "minimax-music-3.0"],
    provider: "MiniMax",
    availableProviders: ["minimax", "pika"],
    defaultProvider: "minimax",
    kind: "audio",
    defaultAspectRatio: "1:1",
    description:
      "Generate complete songs or instrumentals with MiniMax Music 3.0.",
    promptGuidance:
      "Describe the music in Prompt. Enter lyrics directly in Lyrics, or leave it empty to use automatic lyrics or instrumental mode.",
    parameters: [
      {
        id: 'lyrics_optimizer',
        label: 'Automatic lyrics',
        type: 'boolean',
        defaultValue: false,
        description: 'Generate lyrics automatically from the prompt when no lyrics are provided.',
      },
      {
        id: 'is_instrumental',
        label: 'Instrumental',
        type: 'boolean',
        defaultValue: false,
      },
      {
        id: "sample_rate",
        label: "Sample Rate",
        type: "select",
        options: [16000, 24000, 32000, 44100].map((value) => ({
          label: value === 44100 ? "44.1 kHz" : `${value / 1000} kHz`,
          value,
        })),
        defaultValue: 44100,
      },
      {
        id: "bitrate",
        label: "Bitrate",
        type: "select",
        options: [32000, 64000, 128000, 256000].map((value) => ({
          label: `${value / 1000} kbps`,
          value,
        })),
        defaultValue: 256000,
      },
      {
        id: 'format',
        label: 'Audio Format',
        type: 'select',
        options: [
          { label: 'MP3', value: 'mp3' },
          { label: 'WAV', value: 'wav' },
          { label: 'PCM', value: 'pcm' },
        ],
        defaultValue: 'mp3',
      },
      {
        id: 'aigc_watermark',
        label: 'Audible Watermark',
        type: 'boolean',
        defaultValue: false,
        description: 'Append the provider AIGC watermark to the end of the generated audio.',
      },
    ],
    defaultParams: {
      lyrics_optimizer: false,
      is_instrumental: false,
      sample_rate: 44100,
      bitrate: 256000,
      format: 'mp3',
      aigc_watermark: false,
    },
    input: { requiresPrompt: false, inputMode: {}, promptModalities: ['text'] },
    musicInput: {
      lyricsTarget: 'modelParam',
      lyricsParam: 'lyrics',
      maxLyricsCharacters: 3500,
      maxPromptCharacters: 2000,
    },
    constraints: [
      {
        type: 'mutually-exclusive',
        fields: ['modelParams.lyrics_optimizer', 'modelParams.is_instrumental'],
        activeValue: true,
        inactiveValue: false,
        message: 'Automatic lyrics and Instrumental cannot be enabled together.',
      },
      {
        type: 'required',
        field: 'lyrics',
        when: [
          { field: 'modelParams.lyrics_optimizer', equals: false },
          { field: 'modelParams.is_instrumental', equals: false },
        ],
        message: 'Lyrics are required unless Automatic lyrics or Instrumental is enabled.',
      },
      {
        type: 'required',
        field: 'prompt',
        when: [{ field: 'modelParams.is_instrumental', equals: true }],
        message: 'Prompt is required for instrumental music.',
      },
      {
        type: 'max-length',
        field: 'prompt',
        max: 2000,
        message: 'Prompt accepts at most 2000 characters.',
      },
      {
        type: 'max-length',
        field: 'lyrics',
        max: 3500,
        message: 'Lyrics accept at most 3500 characters.',
      },
    ],
    maxRuntimeMs: 10 * 60 * 1000,
  },
  {
    id: 'suno-v5.5',
    name: 'Suno V5.5',
    provider: 'Suno API',
    availableProviders: ['suno'],
    defaultProvider: 'suno',
    kind: 'audio',
    defaultAspectRatio: '1:1',
    description: 'Generate complete songs with Suno V5.5 through SunoAPI.org.',
    promptGuidance: 'Describe the musical style in Prompt. Enter lyrics directly in Lyrics; the action label is used as the song title.',
    parameters: [
      {
        id: 'instrumental',
        label: 'Instrumental',
        type: 'boolean',
        defaultValue: false,
      },
      {
        id: 'style',
        label: 'Style',
        type: 'text',
        placeholder: 'Optional genre, mood, instrumentation, or vocal style',
        defaultValue: '',
      },
      {
        id: 'title',
        label: 'Title',
        type: 'text',
        placeholder: 'Optional song title',
        defaultValue: '',
      },
    ],
    defaultParams: {
      instrumental: false,
      style: '',
      title: '',
    },
    input: { requiresPrompt: true, inputMode: {}, promptModalities: ['text'] },
    musicInput: {
      lyricsTarget: 'prompt',
      descriptionParam: 'style',
      titleParam: 'title',
    },
    maxRuntimeMs: 10 * 60 * 1000,
  },
  {
    id: 'elevenlabs-tts',
    name: 'ElevenLabs TTS',
    provider: 'ElevenLabs',
    availableProviders: ['elevenlabs'],
    defaultProvider: 'elevenlabs',
    kind: 'audio',
    defaultAspectRatio: '1:1',
    description: 'Ultra-realistic voice synthesis with emotional range.',
    parameters: [
      {
        id: 'voice_id',
        label: 'Voice',
        type: 'select',
        options: [
          { label: 'Rachel - Calm', value: 'rachel' },
          { label: 'Drew - Professional', value: 'drew' },
          { label: 'Clyde - Warm', value: 'clyde' },
          { label: 'Paul - Narrator', value: 'paul' },
        ],
        defaultValue: 'rachel',
      },
      {
        id: 'model_id',
        label: 'Model',
        type: 'select',
        options: [
          { label: 'Eleven v3', value: 'eleven_v3' },
          { label: 'Multilingual v2', value: 'eleven_multilingual_v2' },
          { label: 'Flash v2.5', value: 'eleven_flash_v2_5' },
        ],
        defaultValue: 'eleven_v3',
      },
      {
        id: 'stability',
        label: 'Stability',
        type: 'slider',
        min: 0,
        max: 1,
        step: 0.05,
        defaultValue: 0.5,
        description: 'Voice consistency (0=variable, 1=stable)',
      },
      {
        id: 'similarity_boost',
        label: 'Similarity',
        type: 'slider',
        min: 0,
        max: 1,
        step: 0.05,
        defaultValue: 0.75,
        description: 'How closely to match the original voice',
      },
    ],
    defaultParams: {
      voice_id: 'rachel',
      model_id: 'eleven_v3',
      stability: 0.5,
      similarity_boost: 0.75,
    },
    input: { requiresPrompt: true, inputMode: {} },
  },
  // ─── Image: Kling Omni ─────────────────────────────────────
  // Kling's omni image models take a prompt plus up to ten reference images and
  // render at a named resolution tier rather than explicit dimensions.
  {
    id: 'kling-image-o1',
    name: 'Kling Image O1',
    provider: 'Kuaishou',
    availableProviders: ['kling'],
    defaultProvider: 'kling',
    kind: 'image',
    defaultAspectRatio: '1:1',
    description: 'Kling O1 image generation with optional reference images.',
    parameters: [
      aspectRatioParameter({
        ratios: ['21:9', '16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16'],
        defaultValue: 'auto',
        auto: { label: 'Auto' },
      }),
      resolutionParameter({
        tiers: [{ label: '1K', value: '1K' }, { label: '2K', value: '2K' }],
        defaultValue: '1K',
      }),
    ],
    defaultParams: { aspect_ratio: 'auto', resolution: '1K' },
    input: {
      requiresPrompt: true,
      referenceBinding: { type: 'grouped-references' },
      inputMode: { images: { max: 10 } },
      promptModalities: ['text', 'image'],
    },
  },
  {
    id: 'kling-image-o3',
    name: 'Kling Image O3',
    provider: 'Kuaishou',
    availableProviders: ['kling'],
    defaultProvider: 'kling',
    kind: 'image',
    defaultAspectRatio: '1:1',
    description: 'Kling O3 omni image generation with optional reference images.',
    parameters: [
      aspectRatioParameter({
        ratios: ['21:9', '16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16'],
        defaultValue: 'auto',
        auto: { label: 'Auto' },
      }),
      resolutionParameter({
        tiers: [{ label: '1K', value: '1K' }, { label: '2K', value: '2K' }],
        defaultValue: '1K',
      }),
    ],
    defaultParams: { aspect_ratio: 'auto', resolution: '1K' },
    input: {
      requiresPrompt: true,
      referenceBinding: { type: 'grouped-references' },
      inputMode: { images: { max: 10 } },
      promptModalities: ['text', 'image'],
    },
  },
  // ─── Image: Midjourney ─────────────────────────────────────
  // Midjourney is prompt-driven: aspect ratio and the styling knobs below are
  // expressed as `--ar`, `--stylize`, `--chaos`, and `--weird` flags appended to the
  // prompt, so the Card declares them as parameters and the transport renders the
  // flags. `stylize` spans 0-1000 and `chaos`/`weird` 0-100 in Midjourney's own docs.
  {
    id: 'midjourney-7',
    name: 'Midjourney 7',
    provider: 'Midjourney',
    kind: 'image',
    defaultAspectRatio: '1:1',
    description: 'Midjourney v7 image generation with optional image prompts.',
    parameters: [
      aspectRatioParameter({
        ratios: ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'],
        defaultValue: '1:1',
      }),
      {
        id: 'stylize',
        label: 'Stylize',
        type: 'number',
        min: 0,
        max: 1000,
        step: 1,
        defaultValue: 100,
      },
      {
        id: 'chaos',
        label: 'Chaos',
        type: 'number',
        min: 0,
        max: 100,
        step: 1,
        defaultValue: 0,
      },
      {
        id: 'weird',
        label: 'Weird',
        type: 'number',
        min: 0,
        max: 100,
        step: 1,
        defaultValue: 0,
      },
    ],
    defaultParams: { aspect_ratio: '1:1', stylize: 100, chaos: 0, weird: 0 },
    input: {
      requiresPrompt: true,
      referenceBinding: { type: 'grouped-references' },
      inputMode: { images: { max: 5 } },
      promptModalities: ['text', 'image'],
    },
  },
  {
    id: 'midjourney-8.1',
    name: 'Midjourney 8.1',
    provider: 'Midjourney',
    kind: 'image',
    defaultAspectRatio: '1:1',
    description: 'Midjourney v8.1 image generation with optional image prompts.',
    parameters: [
      aspectRatioParameter({
        ratios: ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'],
        defaultValue: '1:1',
      }),
      {
        id: 'stylize',
        label: 'Stylize',
        type: 'number',
        min: 0,
        max: 1000,
        step: 1,
        defaultValue: 100,
      },
      {
        id: 'chaos',
        label: 'Chaos',
        type: 'number',
        min: 0,
        max: 100,
        step: 1,
        defaultValue: 0,
      },
      {
        id: 'weird',
        label: 'Weird',
        type: 'number',
        min: 0,
        max: 100,
        step: 1,
        defaultValue: 0,
      },
    ],
    defaultParams: { aspect_ratio: '1:1', stylize: 100, chaos: 0, weird: 0 },
    input: {
      requiresPrompt: true,
      referenceBinding: { type: 'grouped-references' },
      inputMode: { images: { max: 5 } },
      promptModalities: ['text', 'image'],
    },
  },
  {
    id: 'midjourney-niji-7',
    name: 'Midjourney Niji 7',
    provider: 'Midjourney',
    kind: 'image',
    defaultAspectRatio: '1:1',
    description: 'Midjourney Niji 7, the anime-oriented model, with optional image prompts.',
    parameters: [
      aspectRatioParameter({
        ratios: ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'],
        defaultValue: '1:1',
      }),
      {
        id: 'stylize',
        label: 'Stylize',
        type: 'number',
        min: 0,
        max: 1000,
        step: 1,
        defaultValue: 100,
      },
      {
        id: 'chaos',
        label: 'Chaos',
        type: 'number',
        min: 0,
        max: 100,
        step: 1,
        defaultValue: 0,
      },
      {
        id: 'weird',
        label: 'Weird',
        type: 'number',
        min: 0,
        max: 100,
        step: 1,
        defaultValue: 0,
      },
    ],
    defaultParams: { aspect_ratio: '1:1', stylize: 100, chaos: 0, weird: 0 },
    input: {
      requiresPrompt: true,
      referenceBinding: { type: 'grouped-references' },
      inputMode: { images: { max: 5 } },
      promptModalities: ['text', 'image'],
    },
  },
  // ─── Video: Seedance 2.0 speed tiers ───────────────────────
  // Fast and mini are the same generation contract as Seedance 2.0 at lower cost, so
  // they mirror its parameters and reference limits.
  {
    id: 'seedance-2-fast-ref',
    name: 'Seedance 2.0 Fast (全能参考)',
    provider: 'ByteDance',
    availableProviders: ['volcengine-modelark'],
    defaultProvider: 'volcengine-modelark',
    kind: 'video',
    defaultAspectRatio: '16:9',
    description: 'Seedance 2.0 Fast all-purpose generation with optional image, video, and audio references.',
    parameters: [
      durationParameter({
        seconds: [4, 6, 8, 10, 15],
        defaultValue: 'auto',
        auto: { label: 'Auto' },
      }),
      {
        id: "aspect_ratio",
        label: "Aspect Ratio",
        type: "select",
        options: SEEDANCE_ASPECT_RATIOS.map((r) => ({
          label: r.label,
          value: r.value,
        })),
        defaultValue: 'auto',
      },
      resolutionParameter({
        tiers: [
          { label: '480p', value: '480p' },
          { label: '720p', value: '720p' },
        ],
        defaultValue: '720p',
      }),
      {
        id: 'generate_audio',
        label: 'Native audio',
        type: 'boolean',
        defaultValue: false,
      },
    ],
    defaultParams: {
      duration: 'auto',
      aspect_ratio: 'auto',
      resolution: '720p',
      generate_audio: false,
    },
    input: {
      requiresPrompt: true,
      referenceBinding: POSITIONAL_REFERENCE_BINDING,
      inputMode: {
        images: { max: 9 },
        videos: { max: 3 },
        audios: { max: 3 },
        maxTotalReferences: 12,
      },
      promptModalities: ['text', 'image', 'video', 'audio'],
    },
  },
  {
    id: 'seedance-2-fast-startend',
    name: 'Seedance 2.0 Fast (首尾帧)',
    provider: 'ByteDance',
    availableProviders: ['volcengine-modelark'],
    defaultProvider: 'volcengine-modelark',
    kind: 'video',
    defaultAspectRatio: '16:9',
    description: 'Seedance 2.0 Fast animation between a first and an optional last frame.',
    parameters: [
      durationParameter({
        seconds: [4, 6, 8, 10, 15],
        defaultValue: 'auto',
        auto: { label: 'Auto' },
      }),
      {
        id: "aspect_ratio",
        label: "Aspect Ratio",
        type: "select",
        options: SEEDANCE_ASPECT_RATIOS.map((r) => ({
          label: r.label,
          value: r.value,
        })),
        defaultValue: 'auto',
      },
      resolutionParameter({
        tiers: [
          { label: '480p', value: '480p' },
          { label: '720p', value: '720p' },
        ],
        defaultValue: '720p',
      }),
      {
        id: 'generate_audio',
        label: 'Native audio',
        type: 'boolean',
        defaultValue: false,
      },
    ],
    defaultParams: {
      duration: 'auto',
      aspect_ratio: 'auto',
      resolution: '720p',
      generate_audio: false,
    },
    input: { requiresPrompt: true, inputMode: { startEnd: {} } },
  },
  {
    id: 'seedance-2-mini-ref',
    name: 'Seedance 2.0 Mini (全能参考)',
    provider: 'ByteDance',
    availableProviders: ['volcengine-modelark'],
    defaultProvider: 'volcengine-modelark',
    kind: 'video',
    defaultAspectRatio: '16:9',
    description: 'Seedance 2.0 Mini all-purpose generation with optional image, video, and audio references.',
    parameters: [
      durationParameter({
        seconds: [4, 6, 8, 10, 15],
        defaultValue: 'auto',
        auto: { label: 'Auto' },
      }),
      {
        id: "aspect_ratio",
        label: "Aspect Ratio",
        type: "select",
        options: SEEDANCE_ASPECT_RATIOS.map((r) => ({
          label: r.label,
          value: r.value,
        })),
        defaultValue: 'auto',
      },
      resolutionParameter({
        tiers: [
          { label: '480p', value: '480p' },
          { label: '720p', value: '720p' },
        ],
        defaultValue: '720p',
      }),
      {
        id: 'generate_audio',
        label: 'Native audio',
        type: 'boolean',
        defaultValue: false,
      },
    ],
    defaultParams: {
      duration: 'auto',
      aspect_ratio: 'auto',
      resolution: '720p',
      generate_audio: false,
    },
    input: {
      requiresPrompt: true,
      referenceBinding: POSITIONAL_REFERENCE_BINDING,
      inputMode: {
        images: { max: 9 },
        videos: { max: 3 },
        audios: { max: 3 },
        maxTotalReferences: 12,
      },
      promptModalities: ['text', 'image', 'video', 'audio'],
    },
  },
  {
    id: 'seedance-2-mini-startend',
    name: 'Seedance 2.0 Mini (首尾帧)',
    provider: 'ByteDance',
    availableProviders: ['volcengine-modelark'],
    defaultProvider: 'volcengine-modelark',
    kind: 'video',
    defaultAspectRatio: '16:9',
    description: 'Seedance 2.0 Mini animation between a first and an optional last frame.',
    parameters: [
      durationParameter({
        seconds: [4, 6, 8, 10, 15],
        defaultValue: 'auto',
        auto: { label: 'Auto' },
      }),
      {
        id: "aspect_ratio",
        label: "Aspect Ratio",
        type: "select",
        options: SEEDANCE_ASPECT_RATIOS.map((r) => ({
          label: r.label,
          value: r.value,
        })),
        defaultValue: 'auto',
      },
      resolutionParameter({
        tiers: [
          { label: '480p', value: '480p' },
          { label: '720p', value: '720p' },
        ],
        defaultValue: '720p',
      }),
      {
        id: 'generate_audio',
        label: 'Native audio',
        type: 'boolean',
        defaultValue: false,
      },
    ],
    defaultParams: {
      duration: 'auto',
      aspect_ratio: 'auto',
      resolution: '720p',
      generate_audio: false,
    },
    input: { requiresPrompt: true, inputMode: { startEnd: {} } },
  },
  // ─── Video: Kling Omni ─────────────────────────────────────
  // Kling's omni video models accept image and video references, render in a `std` or
  // `pro` mode, and can stitch several shots from one prompt.
  {
    id: 'kling-video-o1',
    name: 'Kling Video O1',
    provider: 'Kuaishou',
    availableProviders: ['kling'],
    defaultProvider: 'kling',
    kind: 'video',
    defaultAspectRatio: '16:9',
    description: 'Kling O1 video generation with optional image and video references.',
    parameters: [
      durationParameter({ seconds: [5, 10], defaultValue: 5 }),
      {
        id: "aspect_ratio",
        label: "Aspect Ratio",
        type: "select",
        options: KLING_ASPECT_RATIOS.map((r) => ({
          label: r.label,
          value: r.value,
        })),
        defaultValue: "16:9",
      },
      {
        id: "mode",
        label: "Mode",
        type: "select",
        options: [
          { label: "Standard", value: "std" },
          { label: "Pro", value: "pro" },
        ],
        defaultValue: "pro",
      },
      {
        id: "multi_shot",
        label: "Multi-shot",
        type: "boolean",
        defaultValue: false,
      },
    ],
    defaultParams: { duration: 5, aspect_ratio: '16:9', mode: 'pro', multi_shot: false },
    input: {
      requiresPrompt: true,
      referenceBinding: { type: 'grouped-references' },
      inputMode: { images: { max: 4 }, videos: { max: 1 } },
      promptModalities: ['text', 'image', 'video'],
    },
  },
  {
    id: 'kling-video-o3',
    name: 'Kling Video O3',
    provider: 'Kuaishou',
    availableProviders: ['kling'],
    defaultProvider: 'kling',
    kind: 'video',
    defaultAspectRatio: '16:9',
    description: 'Kling O3 omni video generation with optional image and video references and native audio.',
    parameters: [
      durationParameter({ seconds: [5, 10], defaultValue: 5 }),
      {
        id: "aspect_ratio",
        label: "Aspect Ratio",
        type: "select",
        options: KLING_ASPECT_RATIOS.map((r) => ({
          label: r.label,
          value: r.value,
        })),
        defaultValue: "16:9",
      },
      {
        id: "mode",
        label: "Mode",
        type: "select",
        options: [
          { label: "Standard", value: "std" },
          { label: "Pro", value: "pro" },
        ],
        defaultValue: "pro",
      },
      {
        id: "generate_audio",
        label: "Native audio",
        type: "boolean",
        defaultValue: false,
      },
      {
        id: "multi_shot",
        label: "Multi-shot",
        type: "boolean",
        defaultValue: false,
      },
    ],
    defaultParams: { duration: 5, aspect_ratio: '16:9', mode: 'pro', generate_audio: false, multi_shot: false },
    input: {
      requiresPrompt: true,
      referenceBinding: { type: 'grouped-references' },
      inputMode: { images: { max: 4 }, videos: { max: 1 } },
      promptModalities: ['text', 'image', 'video'],
    },
  },
  // ─── Video: driven performance ─────────────────────────────
  // These take a subject and a driver rather than a prompt alone: Avatar animates one
  // portrait from a speech clip, and the motion-control models transfer the motion of
  // a source video onto a still.
  {
    id: 'kling-avatar',
    name: 'Kling Avatar',
    provider: 'Kuaishou',
    availableProviders: ['kling'],
    defaultProvider: 'kling',
    kind: 'video',
    defaultAspectRatio: '9:16',
    description: 'Animate one portrait image so it speaks a supplied audio clip.',
    parameters: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'select',
        options: [{ label: 'Standard', value: 'std' }, { label: 'Pro', value: 'pro' }],
        defaultValue: 'std',
      },
    ],
    defaultParams: { mode: 'std' },
    input: {
      requiresPrompt: false,
      referenceBinding: { type: 'grouped-references' },
      inputMode: { images: { max: 1 }, audios: { max: 1 } },
      promptModalities: ['text', 'image', 'audio'],
    },
  },
  {
    id: 'kling-motion-control',
    name: 'Kling Motion Control',
    provider: 'Kuaishou',
    availableProviders: ['kling'],
    defaultProvider: 'kling',
    kind: 'video',
    defaultAspectRatio: '16:9',
    description: 'Transfer the motion of a source video onto a still character image.',
    parameters: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'select',
        options: [{ label: 'Standard', value: 'std' }, { label: 'Pro', value: 'pro' }],
        defaultValue: 'std',
      },
      {
        id: 'keep_original_sound',
        label: 'Keep original sound',
        type: 'select',
        options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }],
        defaultValue: 'yes',
      },
      {
        id: 'character_orientation',
        label: 'Character orientation',
        type: 'select',
        options: [
          { label: 'Follow video', value: 'video' },
          { label: 'Follow image', value: 'image' },
        ],
        defaultValue: 'video',
      },
    ],
    defaultParams: { mode: 'std', keep_original_sound: 'yes', character_orientation: 'video' },
    input: {
      requiresPrompt: false,
      referenceBinding: { type: 'grouped-references' },
      inputMode: { images: { max: 1 }, videos: { max: 1 } },
      promptModalities: ['text', 'image', 'video'],
    },
  },
  {
    id: 'jimeng-motion-control-2',
    name: 'Jimeng Motion Control 2.0',
    provider: 'ByteDance',
    kind: 'video',
    defaultAspectRatio: '16:9',
    description: 'Transfer the motion of a source video onto a still image with Jimeng 2.0.',
    parameters: [],
    defaultParams: {},
    input: {
      requiresPrompt: false,
      referenceBinding: { type: 'grouped-references' },
      inputMode: { images: { max: 1 }, videos: { max: 1 } },
      promptModalities: ['text', 'image', 'video'],
    },
  },
  // ─── Audio: Seed Audio ─────────────────────────────────────
  // Seed Audio accepts pure text, one image, or up to three audio references. Image and
  // audio references are mutually exclusive; the executable Provider enforces that rule.
  {
    id: 'seed-audio-1',
    name: 'Seed Audio 1.0',
    provider: 'ByteDance',
    availableProviders: ['volcengine-speech'],
    defaultProvider: 'volcengine-speech',
    kind: 'audio',
    defaultAspectRatio: '1:1',
    description: 'Generate expressive speech, sound effects, and complete audio scenes from text and optional references.',
    promptGuidance: 'Refer to audio inputs as @音频1, @音频2, and @音频3. A Voice ID counts as an audio reference. A request may use audio references or one image, but not both.',
    parameters: [
      {
        id: 'voice_id',
        label: 'Voice ID',
        type: 'text',
        defaultValue: '',
        description: 'Optional Doubao TTS or voice-clone speaker ID.',
      },
      {
        id: "speed",
        label: "Speed",
        type: "slider",
        min: 0.5,
        max: 2,
        step: 0.05,
        defaultValue: 1,
      },
      {
        id: "volume",
        label: "Volume",
        type: "slider",
        min: 0.5,
        max: 2,
        step: 0.05,
        defaultValue: 1,
      },
      {
        id: "pitch",
        label: "Pitch",
        type: "slider",
        min: -12,
        max: 12,
        step: 1,
        defaultValue: 0,
      },
      {
        id: "sample_rate",
        label: "Sample Rate",
        type: "select",
        options: [8000, 16000, 24000, 32000, 44100, 48000].map((value) => ({
          label: value === 44100 ? "44.1 kHz" : `${value / 1000} kHz`,
          value,
        })),
      },
      {
        id: 'format',
        label: 'Audio Format',
        type: 'select',
        options: [
          { label: 'WAV', value: 'wav' },
          { label: 'MP3', value: 'mp3' },
          { label: 'PCM', value: 'pcm' },
          { label: 'Ogg Opus', value: 'ogg_opus' },
        ],
        defaultValue: 'wav',
      },
    ],
    defaultParams: { voice_id: '', speed: 1, volume: 1, pitch: 0, format: 'wav' },
    input: {
      requiresPrompt: true,
      referenceBinding: {
        type: 'positional-tokens',
        modalityScopedIndexes: true,
        tokens: { audio: '@音频{n}' },
      },
      inputMode: {
        audios: { max: 3, constraints: SEED_AUDIO_AUDIO_CONSTRAINTS },
        images: { max: 1, constraints: SEED_AUDIO_IMAGE_CONSTRAINTS },
        maxTotalReferences: 3,
      },
      promptModalities: ['text', 'audio', 'image'],
    },
    constraints: [
      {
        type: 'max-length',
        field: 'prompt',
        max: 3000,
        message: 'Seed Audio prompts support at most 3000 characters.',
      },
    ],
  },
  // ─── Audio: music ──────────────────────────────────────────
  // Music generation is length-driven rather than duration-per-shot: the request names
  // how long the finished track should be.
  {
    id: 'elevenlabs-music-v2',
    name: 'ElevenLabs Music v2',
    provider: 'ElevenLabs',
    availableProviders: ['elevenlabs'],
    defaultProvider: 'elevenlabs',
    kind: 'audio',
    defaultAspectRatio: '1:1',
    description: 'Generate a music track from a text description, optionally instrumental.',
    parameters: [
      durationParameter({ seconds: [30, 60, 90, 120, 180, 240, 300], defaultValue: 60 }),
      { id: 'is_instrumental', label: 'Instrumental only', type: 'boolean', defaultValue: false },
    ],
    defaultParams: { duration: 60, is_instrumental: false },
    input: { requiresPrompt: true, inputMode: {}, promptModalities: ['text'] },
  },
  {
    id: 'music-cover',
    name: 'Music Cover',
    provider: 'MiniMax',
    availableProviders: ['minimax'],
    defaultProvider: 'minimax',
    kind: 'audio',
    defaultAspectRatio: '1:1',
    description: 'Re-perform a supplied track, optionally with new lyrics.',
    parameters: [
      { id: 'lyrics', label: 'Lyrics', type: 'text', defaultValue: '' },
    ],
    defaultParams: { lyrics: '' },
    input: {
      requiresPrompt: true,
      referenceBinding: { type: 'grouped-references' },
      inputMode: { audios: { max: 1 } },
      promptModalities: ['text', 'audio'],
    },
  },
  // ─── Model: Meshy ──────────────────────────────────────────
  // Meshy 6 and Meshy 7 are two distinct AI model tiers behind the same Text-to-3D /
  // Image-to-3D routes (docs.meshy.ai): a prompt alone drives Text-to-3D, an attached
  // image drives Image-to-3D, and both stay under one Card per model tier rather than a
  // split text/image pair -- the executable Provider (plugins/meshy) picks the route by
  // reference presence, not by a card-level mode switch. Parameters are limited to what
  // `meshy-executor.ts` implements and tests against the documented wire shapes:
  // `PBR` is the exact wire-compatible key the executable Provider adapter reads
  // (`booleanParam(values, "PBR")` in `meshy-adapter.ts`); `textureResolution` is Meshy's own
  // 2k/4k/8k menu; `poseMode` is a-pose/t-pose or the documented empty-string "no pose" value;
  // `targetPolycount` only takes effect on the remesh path and is bounded 100-300,000 exactly as
  // `MIN_TARGET_POLYCOUNT`/`MAX_TARGET_POLYCOUNT` in `meshy-executor.ts`. None of these four has a
  // proven upstream default, so no `defaultValue` or `defaultParams` entry is invented for them.
  {
    id: 'meshy-6',
    name: 'Meshy 6',
    provider: 'Meshy',
    kind: 'model',
    defaultAspectRatio: '1:1',
    description: 'Meshy 6 text-to-3D and image-to-3D generation, producing a textured GLB mesh.',
    parameters: [
      { id: 'PBR', label: 'PBR Textures', type: 'boolean' },
      {
        id: 'textureResolution',
        label: 'Texture Resolution',
        type: 'select',
        options: [
          { label: '2K', value: '2k' },
          { label: '4K', value: '4k' },
          { label: '8K', value: '8k' },
        ],
      },
      {
        id: 'poseMode',
        label: 'Pose',
        type: 'select',
        options: [
          { label: 'None', value: '' },
          { label: 'A-Pose', value: 'a-pose' },
          { label: 'T-Pose', value: 't-pose' },
        ],
      },
      {
        id: 'targetPolycount',
        label: 'Target Polycount',
        type: 'number',
        min: 100,
        max: 300_000,
        step: 1,
      },
    ],
    defaultParams: {},
    input: {
      requiresPrompt: true,
      referenceBinding: { type: 'grouped-references' },
      inputMode: { images: { max: 1 } },
      promptModalities: ['text', 'image'],
    },
  },
  {
    id: 'meshy-7',
    name: 'Meshy 7',
    provider: 'Meshy',
    kind: 'model',
    defaultAspectRatio: '1:1',
    description: 'Meshy 7 text-to-3D and image-to-3D generation, producing a textured GLB mesh.',
    parameters: [
      { id: 'PBR', label: 'PBR Textures', type: 'boolean' },
      {
        id: 'textureResolution',
        label: 'Texture Resolution',
        type: 'select',
        options: [
          { label: '2K', value: '2k' },
          { label: '4K', value: '4k' },
          { label: '8K', value: '8k' },
        ],
      },
      {
        id: 'poseMode',
        label: 'Pose',
        type: 'select',
        options: [
          { label: 'None', value: '' },
          { label: 'A-Pose', value: 'a-pose' },
          { label: 'T-Pose', value: 't-pose' },
        ],
      },
      {
        id: 'targetPolycount',
        label: 'Target Polycount',
        type: 'number',
        min: 100,
        max: 300_000,
        step: 1,
      },
    ],
    defaultParams: {},
    input: {
      requiresPrompt: true,
      referenceBinding: { type: 'grouped-references' },
      inputMode: { images: { max: 1 } },
      promptModalities: ['text', 'image'],
    },
  },
  // Meshy auto-rig is model-to-model: it always resolves a required `model` reference through
  // `POST /v1/rigging` (plugins/meshy/src/meshy-executor.ts buildRiggingBody) and never reads a
  // prompt. `heightMeters` is the one optional parameter the executor forwards, and it must be
  // positive when present -- there is no documented default height, so none is set here. This
  // stays `kind: 'model'`: a rigged mesh is still a `model` Asset, never a separate `rig` kind
  // (packages/shared-types/src/assets.ts `flexibility` documents the same rule).
  {
    id: 'meshy-auto-rig',
    name: 'Meshy Auto-Rig',
    provider: 'Meshy',
    kind: 'model',
    defaultAspectRatio: '1:1',
    description: 'Automatically rig a static 3D model with a biped skeleton.',
    parameters: [
      { id: 'heightMeters', label: 'Character Height (m)', type: 'number' },
    ],
    defaultParams: {},
    input: {
      requiresPrompt: false,
      referenceBinding: { type: 'grouped-references' },
      inputMode: { models: { min: 1, max: 1 } },
      promptModalities: ['model'],
    },
  },
  // ─── Model: Tripo ──────────────────────────────────────────
  // Tripo H3.1 is one Card covering both text-to-3D and image-to-3D: the executable Provider
  // (plugins/tripo) picks `POST /generation/text-to-model` or `POST /generation/image-to-model`
  // by reference presence, exactly like Meshy above, so it is not split into two Cards. Parameter
  // ids and menus are exactly what `tripo-client.ts`'s `buildTripoTextToModelBody` implements and
  // tests: `pbr`, `textureQuality` (standard/detailed/extreme), `geometryQuality`
  // (standard/detailed), `faceLimit` (1 to Tripo's documented v3.1 standard-mode ceiling of
  // 1,500,000), and `autoSize`. None has a documented default, so none is invented here.
  {
    id: 'tripo-h3.1',
    name: 'Tripo H3.1',
    provider: 'Tripo3D',
    kind: 'model',
    defaultAspectRatio: '1:1',
    description: 'Tripo H3.1 text-to-3D and image-to-3D generation, producing a textured GLB mesh.',
    parameters: [
      { id: 'pbr', label: 'PBR Textures', type: 'boolean' },
      {
        id: 'textureQuality',
        label: 'Texture Quality',
        type: 'select',
        options: [
          { label: 'Standard', value: 'standard' },
          { label: 'Detailed', value: 'detailed' },
          { label: 'Extreme', value: 'extreme' },
        ],
      },
      {
        id: 'geometryQuality',
        label: 'Geometry Quality',
        type: 'select',
        options: [
          { label: 'Standard', value: 'standard' },
          { label: 'Detailed', value: 'detailed' },
        ],
      },
      {
        id: 'faceLimit',
        label: 'Face Limit',
        type: 'number',
        min: 1,
        max: 1_500_000,
        step: 1,
      },
      { id: 'autoSize', label: 'Auto Size', type: 'boolean' },
    ],
    defaultParams: {},
    input: {
      requiresPrompt: true,
      referenceBinding: { type: 'grouped-references' },
      inputMode: { images: { max: 1 } },
      promptModalities: ['text', 'image'],
    },
  },
  // Tripo auto-rig is model-to-model: it always resolves a required `model` reference through
  // `POST /animations/rig` and always requests biped/mixamo/glb regardless of caller input
  // (plugins/tripo/src/tripo-client.ts buildTripoRigBody, tested in tripo-client.test.ts "always
  // requests biped, mixamo, glb regardless of caller input"). There is nothing left to configure,
  // so this Card declares no parameters at all rather than an unused knob.
  {
    id: 'tripo-auto-rig',
    name: 'Tripo Auto-Rig',
    provider: 'Tripo3D',
    kind: 'model',
    defaultAspectRatio: '1:1',
    description: 'Automatically rig a static 3D model with a biped skeleton.',
    parameters: [],
    defaultParams: {},
    input: {
      requiresPrompt: false,
      referenceBinding: { type: 'grouped-references' },
      inputMode: { models: { min: 1, max: 1 } },
      promptModalities: ['model'],
    },
  },
  // Move AI s2 is provider-neutral: no providerImplementations row exists yet, so it has no
  // routable executor. It is video-to-motion, not video-to-video: a single reference video is
  // the only input, there is no prompt, and the produced Asset is an animated rigged GLB, so
  // `kind` stays `model` even though the required *input* modality is video (see move-ai-s2
  // model card test for the input/output modality distinction). `mimeTypes`/`fileExtensions`
  // are Move AI's documented accepted upload formats; no duration/byte/codec ceiling is
  // published, so none is invented here.
  {
    id: 'move-ai-s2',
    name: 'Move AI s2',
    provider: 'Move AI',
    kind: 'model',
    defaultAspectRatio: '1:1',
    description:
      'Single-camera video-to-motion capture, producing an animated rigged GLB model from one reference video.',
    parameters: [
      {
        id: 'trackFingers',
        label: 'Track Fingers',
        type: 'boolean',
        defaultValue: true,
      },
      {
        id: 'floorPlane',
        label: 'Floor Plane',
        type: 'boolean',
        defaultValue: true,
      },
      {
        id: 'trackBall',
        label: 'Track Ball',
        type: 'boolean',
      },
    ],
    defaultParams: { trackFingers: true, floorPlane: true },
    input: {
      requiresPrompt: false,
      referenceBinding: { type: 'grouped-references' },
      inputMode: {
        videos: {
          min: 1,
          max: 1,
          constraints: {
            mimeTypes: ['video/mp4', 'video/quicktime', 'video/x-msvideo'],
            fileExtensions: ['mp4', 'mov', 'avi'],
          },
        },
      },
      promptModalities: ['video'],
    },
  },
];

type ModelProviderImplementationRow = readonly [
  modelId: string,
  providerId: Provider,
  upstreamId: string,
  apiShape: string,
  upstreamModel: string,
  priority: number,
  options?: {
    region?: string;
    credentials?: string[];
    credentialRequirements?: ProviderCredentialRequirements;
    oauth?: string[];
    referenceBinding?: ReferenceBinding;
    inputAdaptation?: ProviderInputAdaptation;
    assetInputs?: ProviderAssetInput[];
    parameterOverrides?: ModelParameter[];
    defaultParamOverrides?: Record<string, string | number | boolean>;
    excludedParameterIds?: string[];
    projectorExportId?: string;
    projectorPluginId?: string;
    executorExportId?: string;
    executorPluginId?: string;
  },
];

const PIKA_EXECUTOR_OPTIONS = {
  executorPluginId: "clash.pika",
  executorExportId: "pika-execute",
  assetInputs: [
    {
      match: { kinds: ["image", "video", "audio"] },
      representations: ["provider-url", "bytes"],
    },
  ] as ProviderAssetInput[],
} as const;

// A Provider route must state which canonical Host delivery forms its executor accepts. These
// declarations describe the existing first-party adapters. A route accepting both forms reuses an
// existing Provider URL and otherwise consumes bytes; only an URL-only route authorises the Host to
// publish a new public projection. Kind-specific lists keep a route from gaining access to media
// its model card cannot accept.
const IMAGE_PROVIDER_ASSET_INPUTS: ProviderAssetInput[] = [
  {
    match: { kinds: ["image"] },
    representations: ["provider-url", "bytes"],
  },
];
const VIDEO_PROVIDER_URL_ONLY_ASSET_INPUTS: ProviderAssetInput[] = [
  {
    match: { kinds: ["video"] },
    representations: ["provider-url"],
  },
];
const IMAGE_AUDIO_PROVIDER_ASSET_INPUTS: ProviderAssetInput[] = [
  {
    match: { kinds: ["image", "audio"] },
    representations: ["bytes"],
  },
];
const MEDIA_PROVIDER_ASSET_INPUTS: ProviderAssetInput[] = [
  {
    match: { kinds: ["image", "video", "audio"] },
    representations: ["provider-url", "bytes"],
  },
];
const IMAGE_BYTES_PROVIDER_ASSET_INPUTS: ProviderAssetInput[] = [
  {
    match: { kinds: ["image"] },
    representations: ["bytes"],
  },
];
const VOLCENGINE_MEDIA_PROVIDER_ASSET_INPUTS: ProviderAssetInput[] = [
  ...VIDEO_PROVIDER_URL_ONLY_ASSET_INPUTS,
  ...IMAGE_AUDIO_PROVIDER_ASSET_INPUTS,
];

const PIKA_NANO_BANANA_PARAMETER_OVERRIDES: ModelParameter[] = [
  {
    id: "aspect_ratio",
    label: "Aspect Ratio",
    type: "select",
    required: false,
    options: [
      ...NANO_BANANA_ASPECT_RATIOS.map(({ label, value }) => ({
        label,
        value,
      })),
      { label: "Auto", value: "auto" },
    ],
    defaultValue: "16:9",
  },
  {
    id: 'resolution',
    label: 'Resolution',
    type: 'select',
    required: false,
    options: ["512", "1K", "2K", "4K"].map((value) => ({
      label: value,
      value,
    })),
    defaultValue: "1K",
  },
  {
    id: "count",
    label: "Count",
    type: "number",
    required: false,
    min: 1,
    max: 1,
    step: 1,
    defaultValue: 1,
  },
];

const PIKA_GPT_IMAGE_PARAMETER_OVERRIDES: ModelParameter[] = [
  {
    id: "aspect_ratio",
    label: "Aspect Ratio",
    type: "select",
    required: false,
    options: [
      "1:1",
      "2:3",
      "3:2",
      "3:4",
      "4:3",
      "4:5",
      "5:4",
      "9:16",
      "16:9",
      "21:9",
    ].map((value) => ({ label: value, value })),
    defaultValue: "1:1",
  },
  {
    id: 'resolution',
    label: 'Resolution',
    type: 'select',
    required: false,
    options: ["1K", "2K", "4K"].map((value) => ({ label: value, value })),
    defaultValue: "1K",
  },
  {
    id: "quality",
    label: "Quality",
    type: "select",
    required: false,
    options: [
      { label: "Auto", value: "auto" },
      { label: "Low", value: "low" },
      { label: "Medium", value: "medium" },
      { label: "High", value: "high" },
    ],
    defaultValue: "medium",
  },
  {
    id: "background",
    label: "Background",
    type: "select",
    required: false,
    options: [
      { label: "Auto", value: "auto" },
      { label: "Opaque", value: "opaque" },
      { label: "Transparent", value: "transparent" },
    ],
    defaultValue: "auto",
  },
  {
    id: "count",
    label: "Count",
    type: "number",
    required: false,
    min: 1,
    max: 10,
    step: 1,
    defaultValue: 1,
  },
];

const PIKA_SEEDANCE_PARAMETER_OVERRIDES: ModelParameter[] = [
  {
    id: "duration",
    label: "Duration",
    type: "select",
    required: false,
    options: [
      { label: 'Auto', value: 'auto' },
      ...Array.from({ length: 12 }, (_, index) => ({
        label: `${index + 4}s`,
        value: index + 4,
      })),
    ],
    defaultValue: 'auto',
  },
  {
    id: 'resolution',
    label: 'Resolution',
    type: 'select',
    required: false,
    options: ["480p", "720p", "1080p", "4k"].map((value) => ({
      label: value,
      value,
    })),
    defaultValue: '720p',
  },
];

const PIKA_SEEDANCE_REFERENCE_PARAMETER_OVERRIDES: ModelParameter[] = [
  ...PIKA_SEEDANCE_PARAMETER_OVERRIDES,
  {
    id: "aspect_ratio",
    label: "Aspect Ratio",
    type: "select",
    required: false,
    options: [
      { label: "Adaptive", value: "adaptive" },
      ...["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].map((value) => ({
        label: value,
        value,
      })),
    ],
    defaultValue: "adaptive",
  },
];

const SEEDANCE_2_VOLCENGINE_PARAMETER_OVERRIDES: ModelParameter[] = [
  {
    id: 'duration',
    label: 'Duration',
    type: 'select',
    required: false,
    options: [
      { label: 'Auto', value: 'auto' },
      ...Array.from({ length: 12 }, (_, index) => ({
        label: `${index + 4}s`,
        value: index + 4,
      })),
    ],
    defaultValue: 'auto',
  },
  {
    id: 'resolution',
    label: 'Resolution',
    type: 'select',
    required: false,
    options: ["480p", "720p", "1080p", "4k"].map((value) => ({
      label: value,
      value,
    })),
    defaultValue: '720p',
  },
];

const SEEDANCE_VOLCENGINE_ASPECT_RATIO_PARAMETER: ModelParameter = {
  id: 'aspect_ratio',
  label: 'Aspect Ratio',
  type: 'select',
  required: false,
  options: [
    ...["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].map((value) => ({
      label: value,
      value,
    })),
    { label: 'Auto', value: 'auto' },
  ],
  defaultValue: 'auto',
};

const SEEDANCE_2_5_VOLCENGINE_COMMON_PARAMETER_OVERRIDES: ModelParameter[] = [
  {
    id: 'duration',
    label: 'Duration',
    type: 'select',
    required: false,
    options: [
      { label: 'Auto', value: 'auto' },
      ...Array.from({ length: 27 }, (_, index) => ({
        label: `${index + 4}s`,
        value: index + 4,
      })),
    ],
    defaultValue: 'auto',
  },
  {
    id: 'resolution',
    label: 'Resolution',
    type: 'select',
    required: false,
    options: ["480p", "720p"].map((value) => ({ label: value, value })),
    defaultValue: "720p",
  },
];

const MODEL_PROVIDER_IMPLEMENTATION_ROWS: ModelProviderImplementationRow[] = [
  [
    "gpt-image-2.5-flare",
    "openai",
    "openai",
    "openai-images",
    "gpt-image-2.5-flare",
    10,
    {
      region: "global",
      credentials: ["apiKey"],
      executorPluginId: "clash.gpt-image",
      executorExportId: "openai-execute",
      assetInputs: IMAGE_PROVIDER_ASSET_INPUTS,
    },
  ],
  [
    "gpt-image-2.5-sunburst",
    "openai",
    "openai",
    "openai-images",
    "gpt-image-2.5-sunburst",
    10,
    {
      region: "global",
      credentials: ["apiKey"],
      executorPluginId: "clash.gpt-image",
      executorExportId: "openai-execute",
      assetInputs: IMAGE_PROVIDER_ASSET_INPUTS,
    },
  ],
  [
    "gpt-image-2.5-flare",
    "official",
    "openai",
    "openai-images",
    "gpt-image-2.5-flare",
    10,
    {
      region: "global",
      credentials: ["apiKey"],
      executorPluginId: "clash.gpt-image",
      executorExportId: "openai-execute",
      assetInputs: IMAGE_PROVIDER_ASSET_INPUTS,
    },
  ],
  [
    "gpt-image-2.5-flare",
    "replicate",
    "replicate",
    "replicate",
    "openai/gpt-image-2.5-flare",
    25,
    {
      credentials: ["apiKey"],
      executorPluginId: "clash.gpt-image",
      executorExportId: "replicate-execute",
      assetInputs: IMAGE_PROVIDER_ASSET_INPUTS,
    },
  ],
  [
    "gpt-image-2.5-flare",
    "pika",
    "pika",
    "pika",
    "openai/gpt-image-2.5-flare/text-to-image",
    18,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
      parameterOverrides: PIKA_GPT_IMAGE_PARAMETER_OVERRIDES.filter(
        (parameter) => parameter.id !== "quality" && parameter.id !== "count",
      ).concat([
        {
          id: "quality",
          label: "Quality",
          type: "select",
          required: false,
          options: ["low", "medium", "high", "xhigh", "max"].map((value) => ({
            label: value,
            value,
          })),
          defaultValue: "medium",
        },
      ]),
      defaultParamOverrides: {
        aspect_ratio: "1:1",
        resolution: "1K",
        quality: "medium",
        count: 1,
      },
      excludedParameterIds: ["moderation"],
    },
  ],

  [
    "gpt-image-2.5-sunburst",
    "official",
    "openai",
    "openai-images",
    "gpt-image-2.5-sunburst",
    10,
    {
      region: "global",
      credentials: ["apiKey"],
      executorPluginId: "clash.gpt-image",
      executorExportId: "openai-execute",
      assetInputs: IMAGE_PROVIDER_ASSET_INPUTS,
    },
  ],
  [
    "gpt-image-2.5-sunburst",
    "replicate",
    "replicate",
    "replicate",
    "openai/gpt-image-2.5-sunburst",
    25,
    {
      credentials: ["apiKey"],
      executorPluginId: "clash.gpt-image",
      executorExportId: "replicate-execute",
      assetInputs: IMAGE_PROVIDER_ASSET_INPUTS,
    },
  ],
  [
    "gpt-image-2.5-sunburst",
    "pika",
    "pika",
    "pika",
    "openai/gpt-image-2.5-sunburst/text-to-image",
    18,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
      parameterOverrides: PIKA_GPT_IMAGE_PARAMETER_OVERRIDES.filter(
        (parameter) => parameter.id !== "quality" && parameter.id !== "count",
      ).concat([
        {
          id: "quality",
          label: "Quality",
          type: "select",
          required: false,
          options: ["low", "medium", "high", "xhigh", "max"].map((value) => ({
            label: value,
            value,
          })),
          defaultValue: "medium",
        },
      ]),
      defaultParamOverrides: {
        aspect_ratio: "1:1",
        resolution: "1K",
        quality: "medium",
        count: 1,
      },
      excludedParameterIds: ["moderation"],
    },
  ],
  [
    "sensevoice-small-asr",
    "local",
    "local",
    "local-asr",
    "iic/SenseVoiceSmall",
    1,
  ],
  [
    "whisper-large-v3-turbo-asr",
    "local",
    "local",
    "local-asr",
    "mlx-community/whisper-large-v3-turbo",
    1,
  ],
  [
    "whisper-small-asr",
    "local",
    "local",
    "local-asr",
    "mlx-community/whisper-small-mlx",
    1,
  ],
  [
    "parakeet-tdt-0.6b-v3-asr",
    "local",
    "local",
    "local-asr",
    "mlx-community/parakeet-tdt-0.6b-v3",
    1,
  ],
  [
    "vibevoice-asr",
    "local",
    "local",
    "local-asr",
    "mlx-community/VibeVoice-ASR-4bit",
    1,
  ],
  [
    "kokoro-82m-tts",
    "local",
    "local",
    "local-tts",
    "mlx-community/Kokoro-82M-4bit",
    1,
  ],
  ["piper-huayan-tts", "local", "local", "local-tts", "zh_CN-huayan-medium", 1],
  ["piper-lessac-tts", "local", "local", "local-tts", "en_US-lessac-medium", 1],
  [
    "pika-2.5",
    "pika",
    "pika",
    "pika",
    "pika/pika-2.5/image-to-video",
    18,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
    },
  ],
  [
    "nano-banana-2",
    "pika",
    "pika",
    "pika",
    "google/gemini-3.1-flash-image/text-to-image",
    18,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
      parameterOverrides: PIKA_NANO_BANANA_PARAMETER_OVERRIDES,
      defaultParamOverrides: {
        aspect_ratio: "16:9",
        resolution: "1K",
        count: 1,
      },
    },
  ],
  [
    "gpt-image-2",
    "pika",
    "pika",
    "pika",
    "openai/gpt-image-2/text-to-image",
    18,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
      parameterOverrides: PIKA_GPT_IMAGE_PARAMETER_OVERRIDES,
      defaultParamOverrides: {
        aspect_ratio: "1:1",
        resolution: "1K",
        quality: "medium",
        background: "auto",
        count: 1,
      },
      excludedParameterIds: ["moderation"],
    },
  ],
  [
    "seedance-2-startend",
    "pika",
    "pika",
    "pika",
    "bytedance/seedance-2.0/image-to-video",
    18,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
      parameterOverrides: PIKA_SEEDANCE_PARAMETER_OVERRIDES,
      defaultParamOverrides: { duration: "auto", resolution: "720p" },
      excludedParameterIds: ["seed"],
    },
  ],
  [
    "seedance-2-ref",
    "pika",
    "pika",
    "pika",
    "bytedance/seedance-2.0/reference-to-video",
    18,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
      parameterOverrides: PIKA_SEEDANCE_REFERENCE_PARAMETER_OVERRIDES,
      defaultParamOverrides: {
        duration: "auto",
        aspect_ratio: "adaptive",
        resolution: "720p",
      },
      excludedParameterIds: ["seed", "edit_mode"],
      referenceBinding: {
        type: 'positional-tokens',
        modalityScopedIndexes: true,
        tokens: { image: "@Image{n}", video: "@Video{n}", audio: "@Audio{n}" },
      },
    },
  ],
  [
    "minimax-h3",
    "pika",
    "pika",
    "pika",
    "minimax/h3/reference-to-video",
    18,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
      referenceBinding: {
        type: 'positional-tokens',
        modalityScopedIndexes: true,
        tokens: { image: "@Image{n}", video: "@Video{n}", audio: "@Audio{n}" },
      },
    },
  ],
  [
    "minimax-h3-startend",
    "pika",
    "pika",
    "pika",
    "minimax/h3/image-to-video",
    18,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
    },
  ],
  [
    "minimax-music-3",
    "pika",
    "pika",
    "pika",
    "minimax/minimax-music-3.0/text-to-audio",
    18,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
      excludedParameterIds: ["aigc_watermark"],
    },
  ],
  [
    "gpt-5.6-sol",
    "pika",
    "pika",
    "pika-chat",
    "openai/gpt-5.6-sol",
    18,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
    },
  ],
  [
    "claude-sonnet-5",
    "pika",
    "pika",
    "pika-chat",
    "anthropic/claude-sonnet-5",
    18,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
    },
  ],
  [
    "gemini-3.6-flash",
    "pika",
    "pika",
    "pika-chat",
    "google/gemini-3.6-flash",
    18,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
    },
  ],
  [
    "deepseek-v4-pro",
    "pika",
    "pika",
    "pika-chat",
    "deepseek/deepseek-v4-pro",
    18,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
    },
  ],
  [
    "kimi-k3",
    "pika",
    "pika",
    "pika-chat",
    "moonshotai/kimi-k3",
    18,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
    },
  ],
  [
    "glm-5.2",
    "pika",
    "pika",
    "pika-chat",
    "z-ai/glm-5.2",
    18,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
    },
  ],
  [
    "seedream-5-pro",
    "pika",
    "pika",
    "pika",
    "bytedance/seedream-5.0-pro/text-to-image",
    18,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
    },
  ],
  [
    "grok-imagine-quality",
    "pika",
    "pika",
    "pika",
    "x-ai/grok-imagine-image-quality/text-to-image",
    18,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
    },
  ],
  [
    "grok-imagine-video-1.5",
    "pika",
    "pika",
    "pika",
    "x-ai/grok-imagine-video-1.5/image-to-video",
    18,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
    },
  ],
  [
    "flux-3-video",
    "pika",
    "pika",
    "pika",
    "black-forest-labs/flux-3-video/text-to-video",
    18,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
      excludedParameterIds: ["safety_tolerance"],
    },
  ],
  [
    "kling-3",
    "pika",
    "pika",
    "pika",
    "kling/kling-3.0/text-to-video",
    18,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
      defaultParamOverrides: { generate_audio: false },
    },
  ],
  [
    "recraft-v4",
    "pika",
    "pika",
    "pika",
    "recraft/recraft-4.1/text-to-image",
    22,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
    },
  ],
  [
    "lyria-3-pro",
    "pika",
    "pika",
    "pika",
    "google/lyria-3-pro/text-to-audio",
    18,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
    },
  ],
  [
    "minimax-speech-2.8-hd",
    "pika",
    "pika",
    "pika",
    "minimax/minimax-speech-2.8-hd/text-to-speech",
    18,
    {
      credentials: ["apiKey"],
      ...PIKA_EXECUTOR_OPTIONS,
    },
  ],
  [
    "nano-banana-2",
    "replicate",
    "replicate",
    "replicate",
    "google/nano-banana-2",
    25,
    { credentials: ["apiKey"] },
  ],
  [
    "gpt-image-2",
    "replicate",
    "replicate",
    "replicate",
    "openai/gpt-image-2",
    25,
    { credentials: ["apiKey"] },
  ],
  [
    "flux-schnell",
    "replicate",
    "replicate",
    "replicate",
    "black-forest-labs/flux-schnell",
    25,
    { credentials: ["apiKey"] },
  ],
  [
    "seedance-2-startend",
    "replicate",
    "replicate",
    "replicate",
    "bytedance/seedance-2.0",
    25,
    {
      credentials: ["apiKey"],
      excludedParameterIds: ["seed"],
    },
  ],
  [
    "seedance-2-ref",
    "replicate",
    "replicate",
    "replicate",
    "bytedance/seedance-2.0",
    25,
    {
      credentials: ["apiKey"],
      excludedParameterIds: ["seed", "edit_mode"],
      referenceBinding: {
        type: 'positional-tokens',
        modalityScopedIndexes: true,
        tokens: { image: "@Image{n}", video: "@Video{n}", audio: "@Audio{n}" },
      },
    },
  ],
  // `anyOf`, because Google accepts either credential and an account holds one or the other. A plain
  // `credentials` list means all of them, and duplicating the route per credential makes one model
  // match two conformance targets -- the ambiguity check is right to refuse that.
  //
  // The eleven `google-agent-platform` routes this replaces expressed the same thing by inventing a
  // second upstream, and carried no executor: a request that matched one found nothing to run, our
  // own gate demanded a service account, found none, and hilo-hub answered instead. The asset looked
  // exactly like a successful Google generation.
  [
    'nano-banana-2',
    'official',
    'google-ai-studio',
    'google-ai-studio',
    'gemini-3.1-flash-image',
    12,
    {
      executorPluginId: "clash.google",
      executorExportId: "google-execute",
      assetInputs: IMAGE_PROVIDER_ASSET_INPUTS,
      region: "global",
      credentialRequirements: { anyOf: [["apiKey"], ["serviceAccountKey"]] },
    },
  ],
  [
    "flux-3-video",
    "official",
    "bfl",
    "bfl",
    "flux-3-video",
    10,
    { region: "global", credentials: ["apiKey"] },
  ],
  [
    "flux-3-video-keyframes",
    "official",
    "bfl",
    "bfl",
    "flux-3-video",
    10,
    { region: "global", credentials: ["apiKey"] },
  ],
  [
    "flux-3-video-continue",
    "official",
    "bfl",
    "bfl",
    "flux-3-video",
    10,
    { region: "global", credentials: ["apiKey"] },
  ],
  [
    "nano-banana-pro",
    "official",
    "google-ai-studio",
    "google-ai-studio",
    "gemini-3-pro-image",
    12,
    {
      executorPluginId: "clash.google",
      executorExportId: "google-execute",
      assetInputs: IMAGE_PROVIDER_ASSET_INPUTS,
      region: "global",
      credentialRequirements: { anyOf: [["apiKey"], ["serviceAccountKey"]] },
    },
  ],
  [
    'gemini-3.1-flash-tts',
    'official',
    'google-ai-studio',
    'google-ai-studio',
    'gemini-3.1-flash-tts-preview',
    10,
    {
      executorPluginId: 'clash.google',
      executorExportId: 'google-execute',
      region: 'global',
      credentialRequirements: { anyOf: [['apiKey'], ['serviceAccountKey']] },
    },
  ],
  [
    'gemini-2.5-pro-tts',
    'official',
    'google-ai-studio',
    'google-ai-studio',
    'gemini-2.5-pro-tts',
    10,
    {
      executorPluginId: 'clash.google',
      executorExportId: 'google-execute',
      region: 'global',
      credentialRequirements: { anyOf: [['apiKey'], ['serviceAccountKey']] },
    },
  ],
  [
    'nano-banana-2-lite',
    'official',
    'google-ai-studio',
    'google-ai-studio',
    'gemini-3.1-flash-lite-image',
    10,
    {
      executorPluginId: "clash.google",
      executorExportId: "google-execute",
      assetInputs: IMAGE_PROVIDER_ASSET_INPUTS,
      region: "global",
      credentialRequirements: { anyOf: [["apiKey"], ["serviceAccountKey"]] },
    },
  ],
  [
    'veo-3.1',
    'official',
    'google-ai-studio',
    'google-ai-studio',
    'veo-3.1-generate-001',
    10,
    {
      executorPluginId: "clash.google",
      executorExportId: "google-execute",
      assetInputs: IMAGE_PROVIDER_ASSET_INPUTS,
      region: "global",
      credentialRequirements: { anyOf: [["apiKey"], ["serviceAccountKey"]] },
    },
  ],
  [
    'veo-3.1-startend',
    'official',
    'google-ai-studio',
    'google-ai-studio',
    'veo-3.1-generate-001',
    10,
    {
      executorPluginId: "clash.google",
      executorExportId: "google-execute",
      assetInputs: IMAGE_PROVIDER_ASSET_INPUTS,
      region: "global",
      credentialRequirements: { anyOf: [["apiKey"], ["serviceAccountKey"]] },
    },
  ],
  [
    'veo-3.1-fast',
    'official',
    'google-ai-studio',
    'google-ai-studio',
    'veo-3.1-fast-generate-001',
    10,
    {
      executorPluginId: "clash.google",
      executorExportId: "google-execute",
      assetInputs: IMAGE_PROVIDER_ASSET_INPUTS,
      region: "global",
      credentialRequirements: { anyOf: [["apiKey"], ["serviceAccountKey"]] },
    },
  ],
  [
    'veo-3.1-fast-startend',
    'official',
    'google-ai-studio',
    'google-ai-studio',
    'veo-3.1-fast-generate-001',
    10,
    {
      executorPluginId: "clash.google",
      executorExportId: "google-execute",
      assetInputs: IMAGE_PROVIDER_ASSET_INPUTS,
      region: "global",
      credentialRequirements: { anyOf: [["apiKey"], ["serviceAccountKey"]] },
    },
  ],
  // Two surfaces serve this model and they take different credentials, both measured:
  //   aiplatform  /v1beta1/projects/{p}/locations/global/interactions -> 401, wants a Bearer token
  //   generativelanguage /v1beta/interactions                         -> 403, routed, wants the
  //                                                                      project's Gemini API on
  // A service account is the unattended way to hold a token; the Developer API takes a key directly.
  // generateContent refuses the model on either host: 400 "only supported in the Interactions API".
  [
    'gemini-omni-flash',
    'official',
    'google-ai-studio',
    'google-ai-studio-interactions',
    'gemini-omni-flash-preview',
    10,
    {
      region: 'global',
      executorPluginId: 'clash.google',
      executorExportId: 'google-execute',
      credentialRequirements: {
        anyOf: [['serviceAccountKey'], ['apiKey'], ['baseUrl']],
        exclusive: true,
      },
    },
  ],
  [
    'gemini-3.5-flash',
    'official',
    'google-ai-studio',
    'google-ai-studio',
    'gemini-3.5-flash',
    10,
    {
      executorPluginId: "clash.google",
      executorExportId: "google-execute",
      assetInputs: MEDIA_PROVIDER_ASSET_INPUTS,
      region: "global",
      credentialRequirements: { anyOf: [["apiKey"], ["serviceAccountKey"]] },
    },
  ],
  [
    'gemini-3.1-pro',
    'official',
    'google-ai-studio',
    'google-ai-studio',
    'gemini-3.1-pro-preview',
    10,
    {
      executorPluginId: "clash.google",
      executorExportId: "google-execute",
      assetInputs: MEDIA_PROVIDER_ASSET_INPUTS,
      region: "global",
      credentialRequirements: { anyOf: [["apiKey"], ["serviceAccountKey"]] },
    },
  ],
  [
    'gemini-3-flash',
    'official',
    'google-ai-studio',
    'google-ai-studio',
    'gemini-3-flash-preview',
    10,
    {
      executorPluginId: "clash.google",
      executorExportId: "google-execute",
      assetInputs: MEDIA_PROVIDER_ASSET_INPUTS,
      region: "global",
      credentialRequirements: { anyOf: [["apiKey"], ["serviceAccountKey"]] },
    },
  ],
  // The eleven `google-agent-platform` routes that followed are gone. Google is one Provider:
  // the same key, the same SDK, and a surface the account picks with its `service` field. They
  // also carried no executor binding, so the split was not merely redundant -- a request that
  // matched one found no executor, our own gate demanded a service account, and hilo-hub answered
  // instead. The asset looked exactly like a successful Google generation.
  [
    'gemini-3.1-flash-lite',
    'official',
    'google-ai-studio',
    'google-ai-studio',
    'gemini-3.1-flash-lite',
    10,
    {
      executorPluginId: "clash.google",
      executorExportId: "google-execute",
      assetInputs: MEDIA_PROVIDER_ASSET_INPUTS,
      region: "global",
      credentialRequirements: { anyOf: [["apiKey"], ["serviceAccountKey"]] },
    },
  ],
  [
    "gpt-image-2",
    "official",
    "openai",
    "openai-images",
    "gpt-image-2",
    10,
    { region: "global", credentials: ["apiKey"] },
  ],
  [
    "gpt-5.4",
    "official",
    "openai",
    "openai-compatible",
    "gpt-5.4",
    10,
    { region: "global", credentials: ["apiKey"] },
  ],
  [
    "openai-compatible-text",
    "official",
    "openai",
    "openai-compatible",
    "gpt-5.4",
    15,
    { region: "global", credentials: ["apiKey"] },
  ],
  [
    "claude-sonnet-4",
    "official",
    "anthropic",
    "anthropic-compatible",
    "claude-sonnet-4-20250514",
    10,
    { region: "global", credentials: ["apiKey"] },
  ],
  [
    "anthropic-compatible-text",
    "official",
    "anthropic",
    "anthropic-compatible",
    "claude-sonnet-4-20250514",
    15,
    { region: "global", credentials: ["apiKey"] },
  ],
  [
    "kling-3",
    "kling",
    "kling",
    "kling",
    "kling-v3",
    8,
    { credentials: ["accessKey", "secretKey"] },
  ],
  [
    "seed-audio-1",
    "volcengine-speech",
    "volcengine-speech",
    "volcengine-speech",
    "seed-audio-1.0",
    9,
    {
      credentials: ["apiKey"],
      executorPluginId: "clash.volcengine",
      executorExportId: "volcengine-speech-execute",
      assetInputs: IMAGE_AUDIO_PROVIDER_ASSET_INPUTS,
    },
  ],
  [
    'seedance-2-startend',
    'volcengine-modelark',
    'volcengine-modelark',
    'modelark',
    'doubao-seedance-2-0-260128',
    9,
    {
      credentials: ["apiKey"],
      executorPluginId: "clash.volcengine",
      executorExportId: "volcengine-execute",
      assetInputs: IMAGE_BYTES_PROVIDER_ASSET_INPUTS,
      parameterOverrides: SEEDANCE_2_VOLCENGINE_PARAMETER_OVERRIDES,
      defaultParamOverrides: { duration: 'auto', resolution: '720p' },
      excludedParameterIds: ['seed'],
    },
  ],
  [
    'seedance-2-ref',
    'volcengine-modelark',
    'volcengine-modelark',
    'modelark',
    'doubao-seedance-2-0-260128',
    9,
    {
      credentials: ["apiKey"],
      executorPluginId: "clash.volcengine",
      executorExportId: "volcengine-execute",
      assetInputs: VOLCENGINE_MEDIA_PROVIDER_ASSET_INPUTS,
      parameterOverrides: [
        ...SEEDANCE_2_VOLCENGINE_PARAMETER_OVERRIDES,
        SEEDANCE_VOLCENGINE_ASPECT_RATIO_PARAMETER,
      ],
      defaultParamOverrides: {
        duration: 'auto',
        aspect_ratio: 'auto',
        resolution: '720p',
      },
      excludedParameterIds: ['seed'],
      referenceBinding: {
        type: 'positional-tokens',
        modalityScopedIndexes: true,
        tokens: { image: '@图像{n}', video: '@视频{n}', audio: '@音频{n}' },
      },
    },
  ],
  [
    'seedance-2-extend',
    'volcengine-modelark',
    'volcengine-modelark',
    'modelark',
    'doubao-seedance-2-0-260128',
    9,
    {
      credentials: ["apiKey"],
      executorPluginId: "clash.volcengine",
      executorExportId: "volcengine-execute",
      assetInputs: VIDEO_PROVIDER_URL_ONLY_ASSET_INPUTS,
      referenceBinding: {
        type: 'positional-tokens',
        modalityScopedIndexes: true,
        tokens: { image: '@图像{n}', video: '@视频{n}', audio: '@音频{n}' },
      },
    },
  ],
  [
    'seedance-2.5-ref',
    'volcengine-modelark',
    'volcengine-modelark',
    'modelark',
    'doubao-seedance-2-5-260628',
    9,
    {
      credentials: ["apiKey"],
      executorPluginId: "clash.volcengine",
      executorExportId: "volcengine-execute",
      assetInputs: VOLCENGINE_MEDIA_PROVIDER_ASSET_INPUTS,
      parameterOverrides: [
        ...SEEDANCE_2_5_VOLCENGINE_COMMON_PARAMETER_OVERRIDES,
        SEEDANCE_VOLCENGINE_ASPECT_RATIO_PARAMETER,
      ],
      defaultParamOverrides: {
        duration: 'auto',
        aspect_ratio: 'auto',
        resolution: '720p',
      },
      referenceBinding: {
        type: 'positional-tokens',
        modalityScopedIndexes: true,
        tokens: { image: '@图像{n}', video: '@视频{n}', audio: '@音频{n}' },
      },
    },
  ],
  [
    'seedance-2.5-startend',
    'volcengine-modelark',
    'volcengine-modelark',
    'modelark',
    'doubao-seedance-2-5-260628',
    9,
    {
      credentials: ["apiKey"],
      executorPluginId: "clash.volcengine",
      executorExportId: "volcengine-execute",
      assetInputs: IMAGE_BYTES_PROVIDER_ASSET_INPUTS,
      parameterOverrides: SEEDANCE_2_5_VOLCENGINE_COMMON_PARAMETER_OVERRIDES,
      defaultParamOverrides: {
        duration: 'auto',
        resolution: '720p',
      },
    },
  ],
  [
    'seedance-2.5-extend',
    'volcengine-modelark',
    'volcengine-modelark',
    'modelark',
    'doubao-seedance-2-5-260628',
    9,
    {
      credentials: ["apiKey"],
      executorPluginId: "clash.volcengine",
      executorExportId: "volcengine-execute",
      assetInputs: VIDEO_PROVIDER_URL_ONLY_ASSET_INPUTS,
      referenceBinding: {
        type: 'positional-tokens',
        modalityScopedIndexes: true,
        tokens: { image: '@图像{n}', video: '@视频{n}', audio: '@音频{n}' },
      },
    },
  ],
  [
    'minimax-m3',
    'minimax',
    'minimax',
    'minimax',
    'MiniMax-M3',
    8,
    {
      credentials: ['apiKey'],
      executorPluginId: 'clash.minimax',
      executorExportId: 'minimax-execute',
    },
  ],
  [
    'minimax-tts',
    'minimax',
    'minimax',
    'minimax',
    'speech-02-hd',
    8,
    {
      credentials: ['apiKey'],
      executorPluginId: 'clash.minimax',
      executorExportId: 'minimax-execute',
    },
  ],
  [
    'minimax-music-3',
    'minimax',
    'minimax',
    'minimax',
    'music-3.0',
    8,
    {
      credentials: ['apiKey'],
      executorPluginId: 'clash.minimax',
      executorExportId: 'minimax-execute',
    },
  ],
  [
    'minimax-h3',
    'minimax',
    'minimax',
    'minimax',
    'MiniMax-H3',
    8,
    {
      credentials: ["apiKey"],
      executorPluginId: "clash.minimax",
      executorExportId: "minimax-execute",
      assetInputs: MEDIA_PROVIDER_ASSET_INPUTS,
    },
  ],
  [
    'minimax-h3-startend',
    'minimax',
    'minimax',
    'minimax',
    'MiniMax-H3',
    8,
    {
      credentials: ["apiKey"],
      executorPluginId: "clash.minimax",
      executorExportId: "minimax-execute",
      assetInputs: IMAGE_PROVIDER_ASSET_INPUTS,
    },
  ],
  [
    "suno-v5.5",
    "suno",
    "suno",
    "suno",
    "V5_5",
    8,
    { credentials: ["apiKey", "callbackUrl"] },
  ],
  [
    "elevenlabs-tts",
    "elevenlabs",
    "elevenlabs",
    "elevenlabs",
    "eleven_v3",
    8,
    { credentials: ["apiKey"] },
  ],
];

function implementationFromRow(row: ModelProviderImplementationRow): ModelProviderImplementation {
  const [, providerId, upstreamId, apiShape, upstreamModel, priority, options] = row;
  return {
    providerId,
    upstreamId,
    ...(options?.region ? { region: options.region } : {}),
    upstreamModel,
    apiShape,
    priority,
    ...(options?.credentials?.length ? { requiredCredentials: [...options.credentials] } : {}),
    ...(options?.credentialRequirements
      ? {
          credentialRequirements: {
            ...options.credentialRequirements,
            anyOf: options.credentialRequirements.anyOf.map((credentials) => [
              ...credentials,
            ]),
          },
        }
      : {}),
    ...(options?.oauth?.length ? { requiredOAuth: [...options.oauth] } : {}),
    ...(options?.referenceBinding ? { referenceBinding: options.referenceBinding } : {}),
    ...(options?.inputAdaptation
      ? {
          inputAdaptation: {
            ...(options.inputAdaptation.audio
              ? {
                  audio: {
                    mimeAliases: {
                      ...options.inputAdaptation.audio.mimeAliases,
                    },
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(options?.assetInputs?.length
      ? {
          assetInputs: options.assetInputs.map((input) => ({
            match: {
              ...(input.match.kinds ? { kinds: [...input.match.kinds] } : {}),
              ...(input.match.slots ? { slots: [...input.match.slots] } : {}),
            },
            representations: [...input.representations],
            ...(input.mediaTypes ? { mediaTypes: [...input.mediaTypes] } : {}),
          })),
        }
      : {}),
    // Which plugin executor owns this route's submit/poll lifecycle. Without this the executors are
    // built, tested and unreachable, and the host answers from its own path instead.
    ...(options?.executorExportId ? { executorExportId: options.executorExportId } : {}),
    ...(options?.executorPluginId ? { executorPluginId: options.executorPluginId } : {}),
    ...(options?.parameterOverrides?.length ? { parameterOverrides: options.parameterOverrides } : {}),
    ...(options?.defaultParamOverrides ? { defaultParamOverrides: options.defaultParamOverrides } : {}),
    ...(options?.excludedParameterIds?.length ? { excludedParameterIds: [...options.excludedParameterIds] } : {}),
    ...(options?.projectorExportId ? { projectorExportId: options.projectorExportId } : {}),
    ...(options?.projectorPluginId ? { projectorPluginId: options.projectorPluginId } : {}),
  };
}

function modelProviderImplementationsById(rows: readonly ModelProviderImplementationRow[]): Record<string, ModelProviderImplementation[]> {
  const byId: Record<string, ModelProviderImplementation[]> = {};
  for (const row of rows) {
    const [modelId] = row;
    byId[modelId] = [...(byId[modelId] ?? []), implementationFromRow(row)];
  }
  return byId;
}

const MODEL_PROVIDER_IMPLEMENTATIONS_BY_ID = modelProviderImplementationsById(MODEL_PROVIDER_IMPLEMENTATION_ROWS);

const MODEL_CARD_DEFINITIONS_WITH_PROVIDER_IMPLEMENTATIONS = MODEL_CARD_DEFINITIONS.map((model) => ({
  ...model,
  constraints: "constraints" in model ? model.constraints ?? [] : [],
  ...(MODEL_PROVIDER_IMPLEMENTATIONS_BY_ID[model.id]
    ? { providerImplementations: MODEL_PROVIDER_IMPLEMENTATIONS_BY_ID[model.id] }
    : {}),
}));

export const MODEL_CARDS: ModelCard[] = z.array(ModelCardSchema).parse(MODEL_CARD_DEFINITIONS_WITH_PROVIDER_IMPLEMENTATIONS);

const MODEL_IDS = new Set(MODEL_CARDS.map((model) => model.id));
const MODEL_ALIAS_TO_ID = new Map<string, string>();
for (const model of MODEL_CARDS) {
  for (const alias of model.aliases) {
    MODEL_ALIAS_TO_ID.set(alias, model.id);
  }
}

export function normalizeModelId(modelId: string | null | undefined): string | null {
  const trimmed = typeof modelId === 'string' ? modelId.trim() : '';
  if (!trimmed) return null;
  if (MODEL_IDS.has(trimmed)) return trimmed;
  return MODEL_ALIAS_TO_ID.get(trimmed) ?? null;
}

export const MOCK_MODEL_CARDS: ModelCard[] = z.array(ModelCardSchema).parse([
  {
    id: 'mock-image-model',
    name: 'Mock Image Model',
    provider: 'Clash Mock',
    availableProviders: ['mock'],
    defaultProvider: 'mock',
    kind: 'image',
    defaultAspectRatio: '1:1',
    description: 'Deterministic image model used by provider routing tests.',
    parameters: [],
    defaultParams: {},
    input: { requiresPrompt: true, inputMode: {}, promptModalities: ['text'] },
    providerImplementations: [
      {
        providerId: 'mock',
        upstreamId: 'mock',
        upstreamModel: 'fal-ai/mock-image',
        apiShape: 'fal',
        priority: 1,
      },
    ],
  },
  {
    id: 'mock-text-model',
    name: 'Mock Text Model',
    provider: 'Clash Mock',
    availableProviders: ['mock'],
    defaultProvider: 'mock',
    kind: 'text',
    defaultAspectRatio: '1:1',
    description: 'Deterministic text model used by provider routing tests.',
    parameters: [],
    defaultParams: {},
    input: { requiresPrompt: true, inputMode: {}, promptModalities: ['text'] },
    providerImplementations: [
      {
        providerId: 'mock',
        upstreamId: 'mock',
        upstreamModel: 'mock/text-completion',
        apiShape: 'openai-compatible',
        priority: 1,
      },
    ],
  },
]);
