import { z } from 'zod';

export const TIMELINE_LIBRARY_CATEGORIES = [
  'text',
  'stickers',
  'sound-effects',
  'transitions',
  'fx',
  'zoom',
  'luts',
  'audio-fx',
  'captions',
  'filters',
  'adjustments',
] as const;

export type TimelineLibraryCategory = (typeof TIMELINE_LIBRARY_CATEGORIES)[number];

export const TIMELINE_LIBRARY_GROUPS = [
  { id: 'recommended', label: 'Recommended', categories: [] },
  { id: 'text', label: 'Text & Captions', categories: ['text', 'captions'] },
  { id: 'graphics', label: 'Graphics', categories: ['stickers'] },
  { id: 'transitions', label: 'Transitions', categories: ['transitions'] },
  { id: 'visual-effects', label: 'Visual Effects', categories: ['fx', 'zoom'] },
  { id: 'color-looks', label: 'Color Looks', categories: ['filters', 'luts', 'adjustments'] },
  { id: 'audio', label: 'Audio', categories: ['sound-effects', 'audio-fx'] },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  categories: readonly TimelineLibraryCategory[];
}>;

export type TimelineLibraryGroup = (typeof TIMELINE_LIBRARY_GROUPS)[number];

const TimelineLibraryGroupIdSchema = z.enum([
  'recommended',
  'text',
  'graphics',
  'transitions',
  'visual-effects',
  'color-looks',
  'audio',
]);

export type TimelineLibraryCategoryContract = {
  domain: 'composition' | 'asset' | 'visual-processor' | 'audio-processor' | 'preset';
  target:
    | 'text-track'
    | 'visual-track'
    | 'caption-item'
    | 'video-track'
    | 'audio-track'
    | 'clip-boundary'
    | 'visual-item-or-range'
    | 'visual-track-range'
    | 'visual-item'
    | 'audio-item-or-track';
  applyKind:
    | 'insert-text-item'
    | 'insert-sticker-item'
    | 'update-caption-style'
    | 'insert-composition-item'
    | 'insert-audio-item'
    | 'attach-transition'
    | 'attach-visual-effect'
    | 'attach-color-look'
    | 'attach-audio-effect';
  catalogFirst: true;
};

export const TIMELINE_LIBRARY_CATEGORY_CONTRACTS = {
  text: {
    domain: 'preset',
    target: 'text-track',
    applyKind: 'insert-text-item',
    catalogFirst: true,
  },
  stickers: {
    domain: 'asset',
    target: 'visual-track',
    applyKind: 'insert-sticker-item',
    catalogFirst: true,
  },
  'sound-effects': {
    domain: 'asset',
    target: 'audio-track',
    applyKind: 'insert-audio-item',
    catalogFirst: true,
  },
  transitions: {
    domain: 'visual-processor',
    target: 'clip-boundary',
    applyKind: 'attach-transition',
    catalogFirst: true,
  },
  fx: {
    domain: 'visual-processor',
    target: 'visual-item-or-range',
    applyKind: 'attach-visual-effect',
    catalogFirst: true,
  },
  zoom: {
    domain: 'visual-processor',
    target: 'visual-track-range',
    applyKind: 'attach-visual-effect',
    catalogFirst: true,
  },
  luts: {
    domain: 'visual-processor',
    target: 'visual-item',
    applyKind: 'attach-color-look',
    catalogFirst: true,
  },
  'audio-fx': {
    domain: 'audio-processor',
    target: 'audio-item-or-track',
    applyKind: 'attach-audio-effect',
    catalogFirst: true,
  },
  captions: {
    domain: 'preset',
    target: 'caption-item',
    applyKind: 'update-caption-style',
    catalogFirst: true,
  },
  filters: {
    domain: 'visual-processor',
    target: 'visual-item',
    applyKind: 'attach-color-look',
    catalogFirst: true,
  },
  adjustments: {
    domain: 'visual-processor',
    target: 'visual-item',
    applyKind: 'attach-visual-effect',
    catalogFirst: true,
  },
} as const satisfies Record<TimelineLibraryCategory, TimelineLibraryCategoryContract>;

export function getTimelineLibraryCategoryContract(
  category: TimelineLibraryCategory,
): TimelineLibraryCategoryContract {
  return TIMELINE_LIBRARY_CATEGORY_CONTRACTS[category];
}

const StableCatalogIdSchema = z.string().regex(
  /^[a-z0-9][a-z0-9._:/-]*$/,
  'Catalog ids must be stable lower-case identifiers.',
);

const VersionSchema = z.number().int().positive();

const TimelineLibraryCollectionQuerySchema = z.object({
  categories: z.array(z.enum(TIMELINE_LIBRARY_CATEGORIES)).min(1).optional(),
  tags: z.array(z.string().min(1)).min(1).optional(),
  favoriteOnly: z.literal(true).optional(),
}).strict().refine(
  (query) => Boolean(query.favoriteOnly || query.categories?.length || query.tags?.length),
  'A collection query must select a category, tag, or favorites.',
);

export const TimelineLibraryCollectionSchema = z.object({
  id: StableCatalogIdSchema,
  label: z.string().min(1),
  groupId: TimelineLibraryGroupIdSchema,
  parentId: StableCatalogIdSchema.optional(),
  query: TimelineLibraryCollectionQuerySchema,
}).strict();

const TimelineLibraryDeliverySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('bundled') }).strict(),
  z.object({ state: z.literal('remote') }).strict(),
  z.object({
    state: z.literal('downloading'),
    progress: z.number().min(0).max(1),
  }).strict(),
  z.object({ state: z.literal('installed') }).strict(),
  z.object({
    state: z.literal('failed'),
    message: z.string().min(1),
  }).strict(),
]);

export const TimelineLibraryItemViewStateSchema = z.object({
  itemId: StableCatalogIdSchema,
  favorite: z.boolean(),
  access: z.enum(['free', 'entitled', 'requires-upgrade']),
  delivery: TimelineLibraryDeliverySchema,
}).strict();

export type TimelineLibraryCollection = z.infer<typeof TimelineLibraryCollectionSchema>;
export type TimelineLibraryItemViewState = z.infer<typeof TimelineLibraryItemViewStateSchema>;

export const TimelineLibraryProvenanceSchema = z.object({
  provider: z.string().min(1),
  upstreamId: z.string().min(1).optional(),
  sourceUrl: z.string().url().optional(),
  license: z.string().min(1).optional(),
  adapted: z.boolean().optional(),
}).strict();

const TimelineLibraryBaseShape = {
  id: StableCatalogIdSchema,
  version: VersionSchema,
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)),
  thumbnail: z.object({
    kind: z.enum(['image', 'video']),
    src: z.string().min(1),
  }).strict().optional(),
  provenance: TimelineLibraryProvenanceSchema.optional(),
  agent: z.object({
    description: z.string().min(1),
    searchTerms: z.array(z.string().min(1)),
    catalogFirst: z.literal(true),
  }).strict().optional(),
};

const EffectRefSchema = z.object({
  kind: z.literal('effect-ref'),
  effectId: StableCatalogIdSchema,
  effectVersion: VersionSchema,
  params: z.record(z.string(), z.unknown()).optional(),
}).strict();

const CaptionStyleSchema = z.object({
  fontFamily: z.string().min(1).optional(),
  fontSize: z.number().positive().optional(),
  fontWeight: z.union([z.string().min(1), z.number().positive()]).optional(),
  color: z.string().min(1).optional(),
  backgroundColor: z.string().min(1).optional(),
  position: z.enum(['bottom', 'top', 'center']).optional(),
}).strict();

const TextLibraryItemSchema = z.object({
  ...TimelineLibraryBaseShape,
  category: z.literal('text'),
  artifact: z.object({
    kind: z.literal('text-preset'),
    text: z.string().min(1),
    color: z.string().min(1),
    fontSize: z.number().positive().optional(),
    fontFamily: z.string().min(1).optional(),
    fontWeight: z.string().min(1).optional(),
  }).strict(),
  apply: z.object({ kind: z.literal('insert-text-item') }).strict(),
}).strict();

const StickerLibraryItemSchema = z.object({
  ...TimelineLibraryBaseShape,
  category: z.literal('stickers'),
  artifact: z.object({
    kind: z.literal('sticker-asset'),
    src: z.string().min(1),
    assetId: StableCatalogIdSchema.optional(),
  }).strict(),
  apply: z.object({ kind: z.literal('insert-sticker-item') }).strict(),
}).strict();

const SoundEffectLibraryItemSchema = z.object({
  ...TimelineLibraryBaseShape,
  category: z.literal('sound-effects'),
  artifact: z.object({
    kind: z.literal('audio-asset'),
    assetId: StableCatalogIdSchema,
  }).strict(),
  apply: z.object({
    kind: z.literal('insert-audio-item'),
  }).strict(),
}).strict();

const TransitionLibraryItemSchema = z.object({
  ...TimelineLibraryBaseShape,
  category: z.literal('transitions'),
  artifact: EffectRefSchema,
  apply: z.object({
    kind: z.literal('attach-transition'),
    binding: z.literal('between-items'),
  }).strict(),
}).strict();

const VisualEffectLibraryItemSchema = z.object({
  ...TimelineLibraryBaseShape,
  category: z.literal('fx'),
  artifact: EffectRefSchema,
  apply: z.object({
    kind: z.literal('attach-visual-effect'),
    binding: z.literal('item-or-range'),
  }).strict(),
}).strict();

const ZoomLibraryItemSchema = z.object({
  ...TimelineLibraryBaseShape,
  category: z.literal('zoom'),
  artifact: EffectRefSchema,
  apply: z.object({
    kind: z.literal('attach-visual-effect'),
    binding: z.literal('track-range'),
  }).strict(),
}).strict();

const LutLibraryItemSchema = z.object({
  ...TimelineLibraryBaseShape,
  category: z.literal('luts'),
  artifact: z.discriminatedUnion('kind', [
    EffectRefSchema,
    z.object({
      kind: z.literal('lut-asset'),
      assetId: StableCatalogIdSchema,
    }).strict(),
  ]),
  apply: z.object({
    kind: z.literal('attach-color-look'),
    binding: z.literal('item'),
  }).strict(),
}).strict();

const AudioEffectLibraryItemSchema = z.object({
  ...TimelineLibraryBaseShape,
  category: z.literal('audio-fx'),
  artifact: z.object({
    kind: z.literal('audio-processor-ref'),
    processorId: StableCatalogIdSchema,
    processorVersion: VersionSchema,
    params: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  apply: z.object({
    kind: z.literal('attach-audio-effect'),
    binding: z.literal('audio-item-or-track'),
  }).strict(),
}).strict();

const CaptionLibraryItemSchema = z.object({
  ...TimelineLibraryBaseShape,
  category: z.literal('captions'),
  artifact: z.object({
    kind: z.literal('caption-style'),
    style: CaptionStyleSchema,
  }).strict(),
  apply: z.object({ kind: z.literal('update-caption-style') }).strict(),
}).strict();

const FilterLibraryItemSchema = z.object({
  ...TimelineLibraryBaseShape,
  category: z.literal('filters'),
  artifact: EffectRefSchema,
  apply: z.object({
    kind: z.literal('attach-color-look'),
    binding: z.literal('item'),
  }).strict(),
}).strict();

const AdjustmentLibraryItemSchema = z.object({
  ...TimelineLibraryBaseShape,
  category: z.literal('adjustments'),
  artifact: EffectRefSchema,
  apply: z.object({
    kind: z.literal('attach-visual-effect'),
    binding: z.literal('item'),
  }).strict(),
}).strict();

export const TimelineLibraryItemSchema = z.discriminatedUnion('category', [
  TextLibraryItemSchema,
  StickerLibraryItemSchema,
  SoundEffectLibraryItemSchema,
  TransitionLibraryItemSchema,
  VisualEffectLibraryItemSchema,
  ZoomLibraryItemSchema,
  LutLibraryItemSchema,
  AudioEffectLibraryItemSchema,
  CaptionLibraryItemSchema,
  FilterLibraryItemSchema,
  AdjustmentLibraryItemSchema,
]);

export type TimelineLibraryItem = z.infer<typeof TimelineLibraryItemSchema>;

export function parseTimelineLibraryItem(value: unknown): TimelineLibraryItem {
  return TimelineLibraryItemSchema.parse(value);
}
