import React from 'react';
import { timelineItemsOverlap } from '@clash/shared-types';
import { FontFamilyPicker } from './FontFamilyPicker';
import { flushSync } from 'react-dom';
import {
  AUDIO_GAIN_DB_MAX,
  AUDIO_GAIN_DB_MIN,
  DEFAULT_AUDIO_DUCKING_SETTINGS,
  findAdjacentTimelineKeyframes,
  getItemResolvedSrc,
  isSubtitleTextItem,
  resolveAudioFadeInFrames,
  resolveAudioFadeOutFrames,
  resolveAudioGainDb,
  removeTimelineKeyframe,
  removeTimelineMaskKeyframes,
  sampleTimelineKeyframes,
  sampleTimelineMaskKeyframes,
  TIMELINE_CAPTION_STYLE_DEFAULTS,
  TIMELINE_SHARED_DEFAULTS,
  upsertTimelineKeyframe,
  useEditorDispatch,
  useEditorPlayback,
  useEditorStaticState,
} from '@clash/remotion-core';
import type {
  AudioItem,
  ClipAnimationType,
  DerivedOverlayItem,
  EffectParamValue,
  Item,
  MediaFit,
  SolidItem,
  StickerItem,
  TextItem,
  TransitionItem,
  TransitionType,
  VideoItem,
} from '@clash/remotion-core';
import {
  builtInEffectRegistry,
  type EffectParamDefinition,
} from '@clash/remotion-effects';
import {
  DEFAULT_TIMELINE_KEYFRAME_INTERPOLATION,
  createDefaultTimelineItemMask,
  TIMELINE_MASK_APPLIES_TO_ITEM_TYPES,
  TIMELINE_MASK_SCALAR_ANIMATION_BINDINGS,
  TIMELINE_MASK_STATIC_CONTROL_BINDINGS,
  TIMELINE_MASK_VECTOR_ANIMATION_BINDINGS,
  TIMELINE_KEYFRAME_INTERPOLATIONS,
  type TimelineMaskNumberInputAnnotation,
  type TimelineMaskScalarAnimationBinding,
  type TimelineMaskStaticControlBinding,
  type TimelineMaskVectorAnimationBinding,
} from '@clash/shared-types';
import {
  RemotionButton,
  RemotionInput,
  RemotionNumberInput,
  RemotionSelect,
  RemotionTextarea,
} from './ui/controls';
import { AspectRatioPicker } from './AspectRatioPicker';
import { getContinuousTransitionBoundaries } from '../library/applyTimelineLibraryItem';

const TRANSITION_TYPES: TransitionType[] = [
  'crossfade',
  'push-left',
  'push-right',
  'slide-up',
  'slide-down',
  'wipe-left',
  'wipe-right',
  'circle-wipe',
  'zoom-in',
];

const CLIP_ANIMATION_OPTIONS: Array<{ value: ClipAnimationType; label: string }> = [
  { value: 'fade', label: 'Fade' },
  { value: 'zoom-in', label: 'Zoom in' },
  { value: 'zoom-out', label: 'Zoom out' },
  { value: 'slide-left', label: 'Slide left' },
  { value: 'slide-right', label: 'Slide right' },
  { value: 'slide-up', label: 'Slide up' },
  { value: 'slide-down', label: 'Slide down' },
];

const editorTypeClassName = {
  caption: 'text-[length:var(--clash-editor-text-caption)] leading-[var(--clash-editor-leading-caption)]',
  control: 'text-[length:var(--clash-editor-text-control)] leading-[var(--clash-editor-leading-control)]',
  item: 'text-[length:var(--clash-editor-text-item)] leading-[var(--clash-editor-leading-item)]',
  heading: 'text-[length:var(--clash-editor-text-heading)] leading-[var(--clash-editor-leading-heading)]',
  metric: 'text-[length:var(--clash-editor-text-metric)] leading-[var(--clash-editor-leading-metric)]',
} as const;
const panelClassName = 'flex h-full flex-col overflow-hidden bg-warm-surface text-slate-900 dark:text-stone-100';
const panelHeaderClassName = 'flex min-h-12 items-center justify-between gap-3 border-b border-warm-border/75 bg-warm-surface px-4 py-2.5';
const panelScrollClassName = 'flex-1 overflow-y-auto overscroll-contain px-4 pb-5';
const inspectorSectionClassName = 'border-t border-warm-border/70 py-4 first:border-t-0';
const sectionTitleClassName = `mb-3 font-semibold tracking-[-0.01em] text-slate-800 dark:text-stone-200 ${editorTypeClassName.item}`;
const labelClassName = `mb-1 block font-medium text-stone-500 dark:text-stone-400 ${editorTypeClassName.caption}`;
const controlRadiusClassName = 'rounded-[var(--clash-workbench-control-radius)]';
const fieldClassName = `h-8 w-full ${controlRadiusClassName} border border-warm-border bg-warm-page/40 px-2.5 text-slate-900 outline-none transition-[border-color,box-shadow,background-color] focus:border-ring/55 focus:bg-warm-surface focus:ring-2 focus:ring-ring/15 dark:text-stone-100 ${editorTypeClassName.item}`;
const readOnlyFieldClassName = `flex min-h-8 w-full items-center ${controlRadiusClassName} border border-warm-border/75 bg-warm-muted/55 px-2.5 text-stone-500 dark:text-stone-400 ${editorTypeClassName.item}`;
const colorFieldClassName = `h-8 w-10 shrink-0 cursor-pointer ${controlRadiusClassName} border border-warm-border bg-warm-page/40 p-1`;

const CANVAS_ASPECT_RATIO_PRESETS = [
  { value: '16:9', label: '16:9', width: 1920, height: 1080 },
  { value: '9:16', label: '9:16', width: 1080, height: 1920 },
  { value: '3:2', label: '3:2', width: 1620, height: 1080 },
  { value: '2:3', label: '2:3', width: 1080, height: 1620 },
  { value: '3:4', label: '3:4', width: 1080, height: 1440 },
  { value: '4:3', label: '4:3', width: 1440, height: 1080 },
  { value: '1:1', label: '1:1', width: 1080, height: 1080 },
  { value: '21:9', label: '21:9', width: 2560, height: 1080 },
  { value: '4:5', label: '4:5', width: 1080, height: 1350 },
];

type CanvasViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => {
    updateCallbackDone?: Promise<unknown>;
    skipTransition?: () => void;
  };
};

const commitCanvasAspectRatio = (update: () => void): void => {
  if (typeof document === 'undefined') {
    update();
    return;
  }

  const startViewTransition = (document as CanvasViewTransitionDocument).startViewTransition;
  if (!startViewTransition) {
    update();
    return;
  }

  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    flushSync(update);
  };

  try {
    const transition = startViewTransition.call(document, commit);
    if (!transition?.skipTransition) return;
    const finishWithoutAnimation = () => {
      try {
        transition.skipTransition?.();
      } catch {
        // The transition may already have finished; the state is committed.
      }
    };
    if (transition.updateCallbackDone) {
      void transition.updateCallbackDone.then(
        finishWithoutAnimation,
        finishWithoutAnimation,
      );
    } else {
      finishWithoutAnimation();
    }
  } catch {
    commit();
  }
};

const MediaFitControl: React.FC<{
  value?: MediaFit;
  fallback: MediaFit;
  onChange: (value: MediaFit) => void;
}> = ({ value, fallback, onChange }) => (
  <div>
    <label className={labelClassName}>Fit</label>
    <RemotionSelect
      ariaLabel="Media fit"
      value={value ?? fallback}
      onValueChange={(nextValue) => onChange(nextValue as MediaFit)}
      options={[
        { value: 'fill', label: 'Fill frame' },
        { value: 'cover', label: 'Cover' },
        { value: 'contain', label: 'Contain' },
      ]}
      className={fieldClassName}
    />
  </div>
);

const InspectorIdentityRow: React.FC<{
  label: string;
  value: React.ReactNode;
}> = ({ label, value }) => (
  <div>
    <label className={labelClassName}>{label}</label>
    <div className={`${readOnlyFieldClassName} min-w-0 break-all`}>{value}</div>
  </div>
);

const effectDisplayName = (effectId: string): string => effectId
  .split('/').pop()!
  .split('-')
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join(' ');

const resolveEffectDefinition = (effectId: string, version: number) => {
  try {
    return builtInEffectRegistry.resolve(effectId, version);
  } catch {
    return null;
  }
};

const resolveEffectParameterValue = (
  value: EffectParamValue | undefined,
  definition: EffectParamDefinition,
): EffectParamValue => {
  if (value !== undefined) return value;
  return definition.type === 'vec2'
    ? [...definition.default] as [number, number]
    : definition.default;
};

const EffectParameterControl: React.FC<{
  effectName: string;
  name: string;
  definition: EffectParamDefinition;
  value: EffectParamValue;
  onChange: (value: EffectParamValue) => void;
}> = ({ effectName, name, definition, value, onChange }) => {
  const ariaLabel = `${effectName} ${name}`;
  if (definition.type === 'boolean') {
    return (
      <label className="flex items-center justify-between gap-3 py-1 text-slate-600 dark:text-stone-300">
        <span className={editorTypeClassName.control}>{name}</span>
        <RemotionInput
          aria-label={ariaLabel}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
          className="h-4 w-4 accent-brand"
        />
      </label>
    );
  }
  if (definition.type === 'enum') {
    return (
      <div>
        <label className={labelClassName}>{name}</label>
        <RemotionSelect
          ariaLabel={ariaLabel}
          value={String(value)}
          onValueChange={onChange}
          options={definition.values.map((option) => ({ value: option, label: option }))}
          className={fieldClassName}
        />
      </div>
    );
  }
  if (definition.type === 'color') {
    return (
      <div>
        <label className={labelClassName}>{name}</label>
        <RemotionInput
          aria-label={ariaLabel}
          type="color"
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          className={`h-9 w-full cursor-pointer ${controlRadiusClassName} border border-warm-border bg-warm-page/45 p-1`}
        />
      </div>
    );
  }
  if (definition.type === 'vec2') {
    const tuple = Array.isArray(value) ? value : definition.default;
    return (
      <div>
        <label className={labelClassName}>{name}</label>
        <div className="grid grid-cols-2 gap-2">
          {[0, 1].map((axis) => (
            <RemotionInput
              key={axis}
              aria-label={`${ariaLabel} ${axis === 0 ? 'x' : 'y'}`}
              type="number"
              min={definition.min}
              max={definition.max}
              value={Number(tuple[axis] ?? 0)}
              onChange={(event) => {
                const next = [...tuple] as [number, number];
                next[axis] = Number(event.target.value);
                onChange(next);
              }}
              className={fieldClassName}
            />
          ))}
        </div>
      </div>
    );
  }
  return (
    <div>
      <label className={labelClassName}>{name}</label>
      <RemotionInput
        aria-label={ariaLabel}
        type="number"
        min={definition.min}
        max={definition.max}
        step={definition.step}
        value={Number(value)}
        onChange={(event) => onChange(Number(event.target.value))}
        className={fieldClassName}
      />
    </div>
  );
};

/**
 * Split button — isolated subscriber for `currentFrame` so the rest of
 * PropertiesPanel doesn't re-render on every scrub or playback frame.
 * Inline button placement still works because React reconciles only
 * this small child when the playhead changes.
 *
 * `canSplit` is a function of (currentFrame, item) — keeping the
 * subscription local means only this small subtree reconciles per
 * frame, not all the Properties form fields below.
 */
const SplitButton: React.FC<{
  itemFrom: number;
  itemEnd: number;
  trackId: string;
  itemId: string;
}> = React.memo(({ itemFrom, itemEnd, trackId, itemId }) => {
  const dispatch = useEditorDispatch();
  const { currentFrame } = useEditorPlayback();
  const canSplit = currentFrame > itemFrom && currentFrame < itemEnd;
  const splitItem = () => {
    if (!canSplit) return;
    dispatch({
      type: 'SPLIT_ITEM',
      payload: { trackId, itemId, splitFrame: currentFrame },
    });
  };
  return (
    <RemotionButton
      onClick={splitItem}
      disabled={!canSplit}
      className={`${controlRadiusClassName} border px-3 py-1.5 font-medium transition-colors ${editorTypeClassName.control} ${
        canSplit
          ? 'cursor-pointer border-brand/35 bg-brand-light text-brand hover:border-brand/55 hover:bg-brand-light/75'
          : 'cursor-not-allowed border-warm-border bg-warm-muted text-content-disabled'
      }`}
      title={canSplit ? `Split at frame ${currentFrame}` : 'Move playhead onto the selected item to split'}
    >
      Split
    </RemotionButton>
  );
});

type KeyframeControlHeaderProps = {
  label: string;
  active: boolean;
  itemFrom: number;
  itemLocalFrame: number;
  canEditKeyframes: boolean;
  currentKey: { interpolation: 'hold' | 'linear' } | undefined;
  previousFrame: number | null;
  nextFrame: number | null;
  onToggle: () => void;
  onInterpolationChange: (interpolation: 'hold' | 'linear') => void;
};

const KeyframeControlHeader: React.FC<KeyframeControlHeaderProps> = ({
  label,
  active,
  itemFrom,
  itemLocalFrame,
  canEditKeyframes,
  currentKey,
  previousFrame,
  nextFrame,
  onToggle,
  onInterpolationChange,
}) => {
  const dispatch = useEditorDispatch();
  const navigate = (frame: number | null) => {
    if (frame === null) return;
    dispatch({ type: 'SET_CURRENT_FRAME', payload: itemFrom + frame });
  };

  return (
    <div className="mb-1 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1">
      <span className={`font-medium text-stone-500 dark:text-stone-400 ${editorTypeClassName.caption}`}>
        {label}
      </span>
      <RemotionButton
        type="button"
        aria-label={`${currentKey ? 'Remove' : 'Add'} ${label} keyframe at current frame`}
        title={canEditKeyframes ? `${currentKey ? 'Remove' : 'Add'} ${label} keyframe at frame ${itemLocalFrame}` : 'Move the playhead onto the selected clip to edit keyframes'}
        disabled={!canEditKeyframes}
        onClick={onToggle}
        className={`flex min-h-7 items-center justify-center gap-1 px-2 text-xs ${controlRadiusClassName} border ${
          currentKey
            ? 'border-brand/60 bg-brand-light text-brand'
            : active
              ? 'border-brand/35 bg-warm-surface text-brand'
              : 'border-warm-border bg-warm-page/40 text-stone-400'
        }`}
      >
        <span aria-hidden="true">{currentKey ? '◆' : '◇'}</span>
        {currentKey ? 'Remove keyframe' : 'Add keyframe'}
      </RemotionButton>
      {!canEditKeyframes ? <span className="col-span-2 text-xs text-stone-500">Move the playhead onto this clip to edit keyframes.</span> : active && <span className="col-span-2 text-xs text-stone-500">{currentKey ? 'On keyframe' : 'Between keyframes'} · clip frame {itemLocalFrame}</span>}
      {active && (
      <div className="col-span-2 flex min-w-0 items-center gap-1">
        <RemotionButton
          type="button"
          aria-label={`Previous ${label} keyframe`}
          title={`Previous ${label} keyframe`}
          disabled={previousFrame === null}
          onClick={() => navigate(previousFrame)}
          className={`flex h-6 min-w-6 items-center justify-center ${controlRadiusClassName} border border-warm-border bg-warm-page/40 px-1 text-stone-500 disabled:cursor-not-allowed disabled:opacity-35`}
        >
          ‹ Previous
        </RemotionButton>
        <RemotionButton
          type="button"
          aria-label={`Next ${label} keyframe`}
          title={`Next ${label} keyframe`}
          disabled={nextFrame === null}
          onClick={() => navigate(nextFrame)}
          className={`flex h-6 min-w-6 items-center justify-center ${controlRadiusClassName} border border-warm-border bg-warm-page/40 px-1 text-stone-500 disabled:cursor-not-allowed disabled:opacity-35`}
        >
          Next ›
        </RemotionButton>
        {currentKey && (
          <RemotionSelect
            ariaLabel={`${label} keyframe interpolation`}
            title={`${label} outgoing interpolation`}
            value={currentKey.interpolation}
            onValueChange={onInterpolationChange}
            options={TIMELINE_KEYFRAME_INTERPOLATIONS.map((interpolation) => ({
              value: interpolation,
              label: interpolation === 'linear' ? 'Linear' : 'Hold',
            }))}
            containerClassName="min-w-0 flex-1"
            className={`h-6 min-w-0 flex-1 ${controlRadiusClassName} border border-warm-border bg-warm-page/40 px-1 text-stone-600 ${editorTypeClassName.caption}`}
          />
        )}
      </div>
      )}
    </div>
  );
};

function useItemKeyframePlayhead(item: Item) {
  const { currentFrame } = useEditorPlayback();
  // Preserve the actual local frame for navigation; clamping makes an outside
  // playhead target a boundary key and skips it when navigating into the clip.
  const itemLocalFrame = currentFrame - item.from;
  return {
    itemLocalFrame,
    canEditKeyframes: itemLocalFrame >= 0 && itemLocalFrame < item.durationInFrames,
  };
}

const PositionKeyframeControl: React.FC<{
  trackId: string;
  item: Item;
}> = React.memo(({ trackId, item }) => {
  const dispatch = useEditorDispatch();
  const { itemLocalFrame, canEditKeyframes } = useItemKeyframePlayhead(item);
  const properties = item.properties ?? TIMELINE_SHARED_DEFAULTS.itemBase.properties;
  const sampled = sampleTimelineKeyframes(item.keyframes, itemLocalFrame, {
    position: [properties.x, properties.y],
    scale: [1, 1],
    rotation: properties.rotation ?? 0,
    opacity: properties.opacity ?? 1,
  });
  const active = (item.keyframes?.position?.length ?? 0) > 0;
  const currentKey = item.keyframes?.position?.find(
    (keyframe) => keyframe.frame === itemLocalFrame,
  );
  const adjacent = findAdjacentTimelineKeyframes(
    item.keyframes,
    'position',
    itemLocalFrame,
  );
  const updateItem = (updates: Partial<Item>) => {
    if (!canEditKeyframes && 'keyframes' in updates) return;
    dispatch({
      type: 'UPDATE_ITEM',
      payload: { trackId, itemId: item.id, updates },
    });
  };
  const toggleCurrentKeyframe = () => {
    updateItem({
      keyframes: currentKey
        ? removeTimelineKeyframe(item.keyframes, 'position', itemLocalFrame)
        : upsertTimelineKeyframe(item.keyframes, 'position', {
            frame: itemLocalFrame,
            value: sampled.position,
            interpolation: DEFAULT_TIMELINE_KEYFRAME_INTERPOLATION,
          }),
    } as Partial<Item>);
  };
  const updateAxis = (axis: 0 | 1, value: number) => {
    if (active) {
      const nextValue = [...sampled.position] as [number, number];
      nextValue[axis] = value;
      updateItem({
        keyframes: upsertTimelineKeyframe(item.keyframes, 'position', {
          frame: itemLocalFrame,
          value: nextValue,
          interpolation: currentKey?.interpolation ?? DEFAULT_TIMELINE_KEYFRAME_INTERPOLATION,
        }),
      } as Partial<Item>);
      return;
    }
    updateItem({
      properties: {
        ...properties,
        x: axis === 0 ? value : properties.x,
        y: axis === 1 ? value : properties.y,
      },
    } as Partial<Item>);
  };
  const updateInterpolation = (interpolation: 'hold' | 'linear') => {
    if (!currentKey) return;
    updateItem({
      keyframes: upsertTimelineKeyframe(item.keyframes, 'position', {
        ...currentKey,
        interpolation,
      }),
    } as Partial<Item>);
  };

  return (
    <div>
      <KeyframeControlHeader
        label="Position"
        active={active}
        itemFrom={item.from}
        itemLocalFrame={itemLocalFrame}
        canEditKeyframes={canEditKeyframes}
        currentKey={currentKey}
        previousFrame={adjacent.previousFrame}
        nextFrame={adjacent.nextFrame}
        onToggle={toggleCurrentKeyframe}
        onInterpolationChange={updateInterpolation}
      />
      <div className="grid grid-cols-2 gap-2">
        {(['X', 'Y'] as const).map((axisLabel, axis) => (
          <label
            key={axisLabel}
            className={`grid grid-cols-[18px_minmax(0,1fr)] items-center ${controlRadiusClassName} border border-warm-border bg-warm-page/40 pl-2 text-stone-400`}
          >
            <span className={editorTypeClassName.caption}>{axisLabel}</span>
            <RemotionNumberInput
              key={`${item.id}:${itemLocalFrame}`}
              aria-label={`${axisLabel} position in pixels`}
              disabled={active && !canEditKeyframes}
              step="1"
              value={sampled.position[axis]}
              onValueChange={(value) => updateAxis(axis as 0 | 1, value)}
              className={`${fieldClassName} border-0 bg-transparent pl-0 focus:ring-0`}
            />
          </label>
        ))}
      </div>
    </div>
  );
});

const ScaleKeyframeControl: React.FC<{
  trackId: string;
  item: Item;
}> = React.memo(({ trackId, item }) => {
  const dispatch = useEditorDispatch();
  const { itemLocalFrame, canEditKeyframes } = useItemKeyframePlayhead(item);
  const properties = {
    x: item.properties?.x ?? TIMELINE_SHARED_DEFAULTS.itemBase.properties.x,
    y: item.properties?.y ?? TIMELINE_SHARED_DEFAULTS.itemBase.properties.y,
    width: item.properties?.width ?? TIMELINE_SHARED_DEFAULTS.itemBase.properties.width,
    height: item.properties?.height ?? TIMELINE_SHARED_DEFAULTS.itemBase.properties.height,
    rotation: item.properties?.rotation ?? TIMELINE_SHARED_DEFAULTS.itemBase.properties.rotation,
    opacity: item.properties?.opacity ?? TIMELINE_SHARED_DEFAULTS.itemBase.properties.opacity,
  };
  const sampled = sampleTimelineKeyframes(item.keyframes, itemLocalFrame, {
    position: [properties.x, properties.y],
    scale: [1, 1],
    rotation: properties.rotation,
    opacity: properties.opacity,
  });
  const active = (item.keyframes?.scale?.length ?? 0) > 0;
  const currentKey = item.keyframes?.scale?.find(
    (keyframe) => keyframe.frame === itemLocalFrame,
  );
  const adjacent = findAdjacentTimelineKeyframes(item.keyframes, 'scale', itemLocalFrame);
  const updateItem = (updates: Partial<Item>) => {
    if (!canEditKeyframes && 'keyframes' in updates) return;
    dispatch({ type: 'UPDATE_ITEM', payload: { trackId, itemId: item.id, updates } });
  };
  const toggleCurrentKeyframe = () => updateItem({
    keyframes: currentKey
      ? removeTimelineKeyframe(item.keyframes, 'scale', itemLocalFrame)
      : upsertTimelineKeyframe(item.keyframes, 'scale', {
          frame: itemLocalFrame,
          value: sampled.scale,
          interpolation: DEFAULT_TIMELINE_KEYFRAME_INTERPOLATION,
        }),
  } as Partial<Item>);
  const updateAxis = (axis: 0 | 1, value: number) => {
    const nextValue = [...sampled.scale] as [number, number];
    nextValue[axis] = Math.max(0, value);
    updateItem({
      keyframes: upsertTimelineKeyframe(item.keyframes, 'scale', {
        frame: itemLocalFrame,
        value: nextValue,
        interpolation: currentKey?.interpolation ?? DEFAULT_TIMELINE_KEYFRAME_INTERPOLATION,
      }),
    } as Partial<Item>);
  };
  const updateInterpolation = (interpolation: 'hold' | 'linear') => {
    if (!currentKey) return;
    updateItem({
      keyframes: upsertTimelineKeyframe(item.keyframes, 'scale', {
        ...currentKey,
        interpolation,
      }),
    } as Partial<Item>);
  };

  return (
    <div>
      <KeyframeControlHeader
        label="Scale"
        active={active}
        itemFrom={item.from}
        itemLocalFrame={itemLocalFrame}
        canEditKeyframes={canEditKeyframes}
        currentKey={currentKey}
        previousFrame={adjacent.previousFrame}
        nextFrame={adjacent.nextFrame}
        onToggle={toggleCurrentKeyframe}
        onInterpolationChange={updateInterpolation}
      />
      <div className="grid grid-cols-2 gap-2">
        {(['X', 'Y'] as const).map((axisLabel, axis) => (
          <label
            key={axisLabel}
            className={`grid grid-cols-[18px_minmax(0,1fr)] items-center ${controlRadiusClassName} border border-warm-border bg-warm-page/40 pl-2 text-stone-400`}
          >
            <span className={editorTypeClassName.caption}>{axisLabel}</span>
            <RemotionNumberInput
              key={`${item.id}:${itemLocalFrame}`}
              aria-label={`${axisLabel} animated scale`}
              step="0.01"
              min="0"
              disabled={!active || !canEditKeyframes}
              value={sampled.scale[axis]}
              onValueChange={(value) => updateAxis(axis as 0 | 1, value)}
              className={`${fieldClassName} border-0 bg-transparent pl-0 focus:ring-0`}
            />
          </label>
        ))}
      </div>
    </div>
  );
});

type ScalarKeyframeControlProps = {
  trackId: string;
  item: Item;
  channel: 'rotation' | 'opacity';
  label: 'Rotation' | 'Opacity';
  ariaLabel: string;
  step: string;
  min?: string;
  max?: string;
};

const ScalarKeyframeControl: React.FC<ScalarKeyframeControlProps> = React.memo(({
  trackId,
  item,
  channel,
  label,
  ariaLabel,
  step,
  min,
  max,
}) => {
  const dispatch = useEditorDispatch();
  const { itemLocalFrame, canEditKeyframes } = useItemKeyframePlayhead(item);
  const properties = {
    x: item.properties?.x ?? TIMELINE_SHARED_DEFAULTS.itemBase.properties.x,
    y: item.properties?.y ?? TIMELINE_SHARED_DEFAULTS.itemBase.properties.y,
    width: item.properties?.width ?? TIMELINE_SHARED_DEFAULTS.itemBase.properties.width,
    height: item.properties?.height ?? TIMELINE_SHARED_DEFAULTS.itemBase.properties.height,
    rotation: item.properties?.rotation ?? TIMELINE_SHARED_DEFAULTS.itemBase.properties.rotation,
    opacity: item.properties?.opacity ?? TIMELINE_SHARED_DEFAULTS.itemBase.properties.opacity,
  };
  const sampled = sampleTimelineKeyframes(item.keyframes, itemLocalFrame, {
    position: [properties.x, properties.y],
    scale: [1, 1],
    rotation: properties.rotation,
    opacity: properties.opacity,
  });
  const channelKeys = item.keyframes?.[channel];
  const active = (channelKeys?.length ?? 0) > 0;
  const currentKey = channelKeys?.find((keyframe) => keyframe.frame === itemLocalFrame);
  const adjacent = findAdjacentTimelineKeyframes(item.keyframes, channel, itemLocalFrame);
  const value = sampled[channel];
  const updateItem = (updates: Partial<Item>) => {
    if (!canEditKeyframes && 'keyframes' in updates) return;
    dispatch({ type: 'UPDATE_ITEM', payload: { trackId, itemId: item.id, updates } });
  };
  const toggleCurrentKeyframe = () => updateItem({
    keyframes: currentKey
      ? removeTimelineKeyframe(item.keyframes, channel, itemLocalFrame)
      : upsertTimelineKeyframe(item.keyframes, channel, {
          frame: itemLocalFrame,
          value,
          interpolation: DEFAULT_TIMELINE_KEYFRAME_INTERPOLATION,
        }),
  } as Partial<Item>);
  const updateValue = (nextValue: number) => {
    if (active) {
      updateItem({
        keyframes: upsertTimelineKeyframe(item.keyframes, channel, {
          frame: itemLocalFrame,
          value: channel === 'opacity' ? Math.max(0, Math.min(1, nextValue)) : nextValue,
          interpolation: currentKey?.interpolation ?? DEFAULT_TIMELINE_KEYFRAME_INTERPOLATION,
        }),
      } as Partial<Item>);
      return;
    }
    updateItem({
      properties: {
        ...properties,
        [channel]: channel === 'opacity' ? Math.max(0, Math.min(1, nextValue)) : nextValue,
      },
    } as Partial<Item>);
  };
  const updateInterpolation = (interpolation: 'hold' | 'linear') => {
    if (!currentKey) return;
    updateItem({
      keyframes: upsertTimelineKeyframe(item.keyframes, channel, {
        ...currentKey,
        interpolation,
      }),
    } as Partial<Item>);
  };

  return (
    <div>
      <KeyframeControlHeader
        label={label}
        active={active}
        itemFrom={item.from}
        itemLocalFrame={itemLocalFrame}
        canEditKeyframes={canEditKeyframes}
        currentKey={currentKey}
        previousFrame={adjacent.previousFrame}
        nextFrame={adjacent.nextFrame}
        onToggle={toggleCurrentKeyframe}
        onInterpolationChange={updateInterpolation}
      />
      <RemotionNumberInput
        key={`${item.id}:${itemLocalFrame}`}
        aria-label={ariaLabel}
        disabled={active && !canEditKeyframes}
        step={step}
        min={min}
        max={max}
        value={value}
        onValueChange={updateValue}
        className={fieldClassName}
      />
    </div>
  );
});

const constrainTimelineMaskNumber = (
  value: number,
  input: TimelineMaskNumberInputAnnotation,
): number => Math.min(
  input.max ?? Number.POSITIVE_INFINITY,
  Math.max(input.min ?? Number.NEGATIVE_INFINITY, value),
);

const MaskVectorKeyframeControl: React.FC<{
  trackId: string;
  item: Item;
  binding: TimelineMaskVectorAnimationBinding;
}> = React.memo(({ trackId, item, binding }) => {
  const dispatch = useEditorDispatch();
  const { itemLocalFrame, canEditKeyframes } = useItemKeyframePlayhead(item);
  if (!item.mask) return null;
  const { channel, field, label, axisLabels, axisAriaLabels, axisInputs } = binding;
  const sampled = sampleTimelineMaskKeyframes(item.keyframes, itemLocalFrame, item.mask);
  const channelKeys = item.keyframes?.[channel];
  const active = (channelKeys?.length ?? 0) > 0;
  const currentKey = channelKeys?.find((keyframe) => keyframe.frame === itemLocalFrame);
  const adjacent = findAdjacentTimelineKeyframes(item.keyframes, channel, itemLocalFrame);
  const value = sampled[field];
  const updateItem = (updates: Partial<Item>) => {
    if (!canEditKeyframes && 'keyframes' in updates) return;
    dispatch({ type: 'UPDATE_ITEM', payload: { trackId, itemId: item.id, updates } });
  };
  const toggleCurrentKeyframe = () => updateItem({
    keyframes: currentKey
      ? removeTimelineKeyframe(item.keyframes, channel, itemLocalFrame)
      : upsertTimelineKeyframe(item.keyframes, channel, {
          frame: itemLocalFrame,
          value,
          interpolation: DEFAULT_TIMELINE_KEYFRAME_INTERPOLATION,
        }),
  } as Partial<Item>);
  const updateAxis = (axis: 0 | 1, nextComponent: number) => {
    const nextValue = [...value] as [number, number];
    nextValue[axis] = constrainTimelineMaskNumber(nextComponent, axisInputs[axis]);
    if (active) {
      updateItem({
        keyframes: upsertTimelineKeyframe(item.keyframes, channel, {
          frame: itemLocalFrame,
          value: nextValue,
          interpolation: currentKey?.interpolation ?? DEFAULT_TIMELINE_KEYFRAME_INTERPOLATION,
        }),
      } as Partial<Item>);
      return;
    }
    updateItem({
      mask: {
        ...item.mask,
        [field]: nextValue,
      },
    } as Partial<Item>);
  };
  const updateInterpolation = (interpolation: 'hold' | 'linear') => {
    if (!currentKey) return;
    updateItem({
      keyframes: upsertTimelineKeyframe(item.keyframes, channel, {
        ...currentKey,
        interpolation,
      }),
    } as Partial<Item>);
  };

  return (
    <div>
      <KeyframeControlHeader
        label={label}
        active={active}
        itemFrom={item.from}
        itemLocalFrame={itemLocalFrame}
        canEditKeyframes={canEditKeyframes}
        currentKey={currentKey}
        previousFrame={adjacent.previousFrame}
        nextFrame={adjacent.nextFrame}
        onToggle={toggleCurrentKeyframe}
        onInterpolationChange={updateInterpolation}
      />
      <div className="grid grid-cols-2 gap-2">
        {axisLabels.map((axisLabel, axis) => (
          <label
            key={axisLabel}
            className={`grid grid-cols-[18px_minmax(0,1fr)] items-center ${controlRadiusClassName} border border-warm-border bg-warm-page/40 pl-2 text-stone-400`}
          >
            <span className={editorTypeClassName.caption}>{axisLabel}</span>
            <RemotionInput
              aria-label={axisAriaLabels[axis]}
              disabled={active && !canEditKeyframes}
              type="number"
              step={axisInputs[axis].step}
              min={axisInputs[axis].min}
              max={axisInputs[axis].max}
              value={value[axis]}
              onChange={(event) => updateAxis(
                axis as 0 | 1,
                Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : 0,
              )}
              className={`${fieldClassName} border-0 bg-transparent pl-0 focus:ring-0`}
            />
          </label>
        ))}
      </div>
    </div>
  );
});

const MaskScalarKeyframeControl: React.FC<{
  trackId: string;
  item: Item;
  binding: TimelineMaskScalarAnimationBinding;
}> = React.memo(({ trackId, item, binding }) => {
  const dispatch = useEditorDispatch();
  const { itemLocalFrame, canEditKeyframes } = useItemKeyframePlayhead(item);
  if (!item.mask) return null;
  const { channel, field, label, ariaLabel, input } = binding;
  const sampled = sampleTimelineMaskKeyframes(item.keyframes, itemLocalFrame, item.mask);
  const channelKeys = item.keyframes?.[channel];
  const active = (channelKeys?.length ?? 0) > 0;
  const currentKey = channelKeys?.find((keyframe) => keyframe.frame === itemLocalFrame);
  const adjacent = findAdjacentTimelineKeyframes(item.keyframes, channel, itemLocalFrame);
  const value = sampled[field];
  const updateItem = (updates: Partial<Item>) => {
    if (!canEditKeyframes && 'keyframes' in updates) return;
    dispatch({ type: 'UPDATE_ITEM', payload: { trackId, itemId: item.id, updates } });
  };
  const toggleCurrentKeyframe = () => updateItem({
    keyframes: currentKey
      ? removeTimelineKeyframe(item.keyframes, channel, itemLocalFrame)
      : upsertTimelineKeyframe(item.keyframes, channel, {
          frame: itemLocalFrame,
          value,
          interpolation: DEFAULT_TIMELINE_KEYFRAME_INTERPOLATION,
        }),
  } as Partial<Item>);
  const updateValue = (nextValue: number) => {
    const constrained = constrainTimelineMaskNumber(nextValue, input);
    if (active) {
      updateItem({
        keyframes: upsertTimelineKeyframe(item.keyframes, channel, {
          frame: itemLocalFrame,
          value: constrained,
          interpolation: currentKey?.interpolation ?? DEFAULT_TIMELINE_KEYFRAME_INTERPOLATION,
        }),
      } as Partial<Item>);
      return;
    }
    updateItem({
      mask: {
        ...item.mask,
        [field]: constrained,
      },
    } as Partial<Item>);
  };
  const updateInterpolation = (interpolation: 'hold' | 'linear') => {
    if (!currentKey) return;
    updateItem({
      keyframes: upsertTimelineKeyframe(item.keyframes, channel, {
        ...currentKey,
        interpolation,
      }),
    } as Partial<Item>);
  };

  return (
    <div>
      <KeyframeControlHeader
        label={label}
        active={active}
        itemFrom={item.from}
        itemLocalFrame={itemLocalFrame}
        canEditKeyframes={canEditKeyframes}
        currentKey={currentKey}
        previousFrame={adjacent.previousFrame}
        nextFrame={adjacent.nextFrame}
        onToggle={toggleCurrentKeyframe}
        onInterpolationChange={updateInterpolation}
      />
      <RemotionInput
        aria-label={ariaLabel}
        disabled={active && !canEditKeyframes}
        type="number"
        step={input.step}
        min={input.min}
        max={input.max}
        value={value}
        onChange={(event) => updateValue(
          Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : 0,
        )}
        className={fieldClassName}
      />
    </div>
  );
});

const MaskStaticFieldControl: React.FC<{
  item: Item & { mask: NonNullable<Item['mask']> };
  binding: TimelineMaskStaticControlBinding;
  onChange: (field: TimelineMaskStaticControlBinding['field'], value: unknown) => void;
}> = React.memo(({ item, binding, onChange }) => {
  const { field, control } = binding;
  switch (control.kind) {
    case 'select':
      return (
        <div>
          <label className={labelClassName}>{control.label}</label>
          <RemotionSelect
            ariaLabel={control.ariaLabel}
            value={String(item.mask[field])}
            onValueChange={(nextValue) => onChange(field, nextValue)}
            options={Object.entries(control.options).map(([value, option]) => ({
              value,
              label: option.label,
            }))}
            className={fieldClassName}
          />
        </div>
      );
    case 'toggle': {
      const active = Boolean(item.mask[field]);
      return (
        <RemotionButton
          type="button"
          aria-label={control.ariaLabel}
          aria-pressed={active}
          onClick={() => onChange(field, !active)}
          className={`${controlRadiusClassName} border px-3 py-1.5 font-medium transition-colors ${editorTypeClassName.control} ${
            active
              ? 'border-brand/50 bg-brand-light text-brand'
              : 'border-warm-border bg-warm-page/40 text-stone-600 dark:text-stone-300'
          }`}
        >
          {control.label}
        </RemotionButton>
      );
    }
    default: {
      const unsupported: never = control;
      throw new Error(`Unsupported Timeline mask control: ${String(unsupported)}`);
    }
  }
});

const MaskControls: React.FC<{
  trackId: string;
  item: Item;
}> = React.memo(({ trackId, item }) => {
  const dispatch = useEditorDispatch();
  const updateItem = (updates: Partial<Item>) => dispatch({
    type: 'UPDATE_ITEM',
    payload: { trackId, itemId: item.id, updates },
  });
  if (!item.mask) {
    return (
      <RemotionButton
        type="button"
        aria-label="Add mask"
        onClick={() => updateItem({
          mask: createDefaultTimelineItemMask(),
        } as Partial<Item>)}
        className={`${controlRadiusClassName} border border-warm-border bg-warm-page/40 px-3 py-1.5 font-medium text-slate-700 transition-colors hover:border-brand/40 hover:bg-brand-light dark:text-stone-200 ${editorTypeClassName.control}`}
      >
        Add mask
      </RemotionButton>
    );
  }

  const maskedItem = item as Item & { mask: NonNullable<Item['mask']> };
  const updateMaskField = (
    field: TimelineMaskStaticControlBinding['field'],
    value: unknown,
  ) => updateItem({
    mask: { ...maskedItem.mask, [field]: value },
  } as Partial<Item>);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <RemotionButton
          type="button"
          aria-label="Remove mask"
          onClick={() => updateItem({
            mask: undefined,
            keyframes: removeTimelineMaskKeyframes(item.keyframes),
          } as Partial<Item>)}
          className={`${controlRadiusClassName} border border-warm-border bg-warm-surface px-2.5 py-1.5 text-stone-500 transition-colors hover:border-red-300 hover:text-red-600 ${editorTypeClassName.control}`}
        >
          Remove
        </RemotionButton>
      </div>
      {TIMELINE_MASK_STATIC_CONTROL_BINDINGS.map((binding) => (
        <MaskStaticFieldControl
          key={binding.field}
          item={maskedItem}
          binding={binding}
          onChange={updateMaskField}
        />
      ))}
      {TIMELINE_MASK_VECTOR_ANIMATION_BINDINGS.map((binding) => (
        <MaskVectorKeyframeControl
          key={binding.channel}
          trackId={trackId}
          item={maskedItem}
          binding={binding}
        />
      ))}
      {TIMELINE_MASK_SCALAR_ANIMATION_BINDINGS.map((binding) => (
        <MaskScalarKeyframeControl
          key={binding.channel}
          trackId={trackId}
          item={maskedItem}
          binding={binding}
        />
      ))}
      <p className={`m-0 text-stone-400 ${editorTypeClassName.caption}`}>
        Mask coordinates are relative to this clip.
      </p>
    </div>
  );
});

type PropertiesPanelProps = {
  showHeader?: boolean;
  title?: string;
  headerAction?: React.ReactNode;
};

export const PropertiesPanel: React.FC<PropertiesPanelProps> = ({
  showHeader = true,
  title = 'Properties',
  headerAction,
}) => {
  const dispatch = useEditorDispatch();
  const textSectionRef = React.useRef<HTMLDivElement>(null);
  const transformSectionRef = React.useRef<HTMLDivElement>(null);
  const {
    tracks,
    assets,
    selectedItemId,
    compositionWidth,
    compositionHeight,
    durationInFrames,
    fps,
  } = useEditorStaticState();

  // Find selected item
  const selectedItem = selectedItemId
    ? tracks
      .flatMap((t) => t.items.map((i) => ({ trackId: t.id, item: i })))
      .find((x) => x.item.id === selectedItemId)
    : null;

  const selectedItemData = selectedItem?.item;
  const itemEnd = selectedItemData ? selectedItemData.from + selectedItemData.durationInFrames : 0;
  const setCompositionSize = React.useCallback((dimensions: { width: number; height: number }) => {
    commitCanvasAspectRatio(() => {
      dispatch({
        type: 'SET_COMPOSITION_SIZE',
        payload: dimensions,
      });
    });
  }, [dispatch]);

  // Format time helper
  const formatTime = (frames: number): string => {
    const totalCentiseconds = Math.floor(((frames * 100) / Math.max(1, fps)) + 1e-6);
    const minutes = Math.floor(totalCentiseconds / 6000);
    const seconds = Math.floor((totalCentiseconds % 6000) / 100);
    const centiseconds = totalCentiseconds % 100;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${centiseconds.toString().padStart(2, '0')}`;
  };

  // Canvas properties when no item is selected
  if (!selectedItem) {
    return (
      <div className={panelClassName}>
        {showHeader && (
        <div className={panelHeaderClassName}>
          <h2 className={`m-0 font-bold text-slate-900 dark:text-stone-100 ${editorTypeClassName.heading}`}>{title}</h2>
          {headerAction}
        </div>
        )}
        <div className={panelScrollClassName}>
          {/* Canvas Section */}
          <div className={inspectorSectionClassName}>
            <h3 className={sectionTitleClassName}>Aspect ratio</h3>

            <AspectRatioPicker
              ariaLabel="Canvas aspect ratio"
              className="mb-1"
              density="compact"
              options={CANVAS_ASPECT_RATIO_PRESETS}
              value={CANVAS_ASPECT_RATIO_PRESETS.find((preset) => (
                preset.width === compositionWidth && preset.height === compositionHeight
              ))?.value ?? 'custom'}
              onValueChange={(nextValue) => {
                const preset = CANVAS_ASPECT_RATIO_PRESETS.find((candidate) => candidate.value === nextValue);
                if (!preset) return;
                setCompositionSize({ width: preset.width, height: preset.height });
              }}
              customDimensions={{
                width: compositionWidth,
                height: compositionHeight,
                onChange: setCompositionSize,
              }}
            />
          </div>

          {/* Duration Section */}
          <div className={inspectorSectionClassName}>
            <h3 className={sectionTitleClassName}>Duration</h3>
            <div className={`mb-4 font-mono font-semibold tracking-tight text-slate-900 tabular-nums dark:text-stone-100 ${editorTypeClassName.metric}`}>
              {formatTime(durationInFrames)}
            </div>
            <div className="mb-3">
              <label className={labelClassName}>Duration (frames)</label>
              <RemotionInput
                type="number"
                value={durationInFrames}
                onChange={(e) => dispatch({
                  type: 'SET_DURATION',
                  payload: parseInt(e.target.value) || 600,
                })}
                className={fieldClassName}
              />
            </div>
            <div className="mb-3">
              <label className={labelClassName}>Frame Rate (FPS)</label>
              <div className={readOnlyFieldClassName}>{fps} fps</div>
            </div>
          </div>

        </div>
      </div>
    );
  }

  const { trackId, item } = selectedItem;
  const selectedTrack = tracks.find((track) => track.id === trackId);
  const transitionBoundary = item.type === 'transition'
    ? tracks
      .flatMap((track) => getContinuousTransitionBoundaries(track))
      .find((boundary) => (
        boundary.fromItem.id === item.fromItemId
        && boundary.toItem.id === item.toItemId
      ))
    : undefined;
  const transitionMaxDuration = transitionBoundary
    ? Math.max(
      1,
      Math.min(
        transitionBoundary.fromItem.durationInFrames,
        transitionBoundary.toItem.durationInFrames,
      ) * 2,
    )
    : Math.max(1, item.durationInFrames);
  const supportsVisualTransform = item.type !== 'transition' && item.type !== 'audio';
  const supportsMask = (TIMELINE_MASK_APPLIES_TO_ITEM_TYPES as readonly string[])
    .includes(item.type);
  const subtitleItem = isSubtitleTextItem(item) ? item : null;
  const resolvedSource = item.type === 'composition'
    ? item.sourcePath
    : getItemResolvedSrc(item, assets);

  const updateItem = (updates: Partial<typeof item>) => {
    dispatch({
      type: 'UPDATE_ITEM',
      payload: { trackId, itemId: item.id, updates },
    });
  };

  const updateTiming = (event: React.ChangeEvent<HTMLInputElement>, field: 'from' | 'durationInFrames') => {
    const input = event.currentTarget;
    input.setCustomValidity('');
    if (!input.value.trim()) return;
    const value = Number(input.value);
    if (!Number.isInteger(value) || value < (field === 'from' ? 0 : 1)) return;
    const candidate = { ...item, [field]: value };
    const conflict = selectedTrack?.items.find(other => other.id !== item.id && timelineItemsOverlap(candidate, other));
    if (conflict) {
      input.setCustomValidity('This range overlaps another clip. Use a free range or move the clip to a separate track.');
      input.reportValidity();
      return;
    }
    updateItem({ [field]: value });
  };

  const updateVideoAnimation = (
    phase: 'entrance' | 'exit',
    updates: { type?: ClipAnimationType | 'none'; durationInFrames?: number },
  ) => {
    if (item.type !== 'video') return;
    const field = phase === 'entrance' ? 'entranceAnimation' : 'exitAnimation';
    const current = (item as VideoItem)[field];
    if (updates.type === 'none') {
      updateItem({ [field]: undefined } as Partial<typeof item>);
      return;
    }
    const nextType = updates.type ?? current?.type;
    if (!nextType) return;
    updateItem({
      [field]: {
        type: nextType,
        durationInFrames: Math.max(
          1,
          Math.min(
            item.durationInFrames,
            updates.durationInFrames ?? current?.durationInFrames ?? Math.min(15, item.durationInFrames),
          ),
        ),
      },
    } as Partial<typeof item>);
  };

  const deleteItem = () => {
    dispatch({
      type: 'REMOVE_ITEM',
      payload: { trackId, itemId: item.id },
    });
  };

  return (
    <div className={panelClassName}>
      {showHeader && (
      <div className={`${panelHeaderClassName} flex-wrap`}>
        <div className="flex w-full min-w-0 items-center justify-between gap-2">
          <h2 className={`m-0 min-w-0 font-bold text-slate-900 dark:text-stone-100 ${editorTypeClassName.heading}`}>{title}</h2>
          {headerAction}
        </div>
        <div className="flex w-full flex-wrap justify-end gap-2">
          {item.type !== 'transition' && (
            <SplitButton
              itemFrom={item.from}
              itemEnd={itemEnd}
              trackId={trackId}
              itemId={item.id}
            />
          )}
          <RemotionButton
            onClick={deleteItem}
            className={`${controlRadiusClassName} border border-red-200 bg-warm-surface px-3 py-1.5 font-medium text-red-600 transition-colors hover:border-red-300 hover:bg-red-50 dark:border-red-900/70 dark:text-red-400 dark:hover:bg-red-950/45 ${editorTypeClassName.control}`}
          >
            Delete
          </RemotionButton>
        </div>
      </div>
      )}

      {(item.type === 'text' || supportsVisualTransform) && (
        <nav aria-label="Properties sections" className="flex shrink-0 gap-2 border-b border-warm-border px-4 py-2">
          {item.type === 'text' && <RemotionButton className="rounded-md border border-warm-border px-3 py-1.5 text-xs hover:bg-warm-hover" onClick={() => textSectionRef.current?.scrollIntoView({ block: 'start' })}>Font & text</RemotionButton>}
          {supportsVisualTransform && <RemotionButton className="rounded-md border border-warm-border px-3 py-1.5 text-xs hover:bg-warm-hover" onClick={() => transformSectionRef.current?.scrollIntoView({ block: 'start' })}>Keyframes</RemotionButton>}
        </nav>
      )}
      <div className={panelScrollClassName}>
        {/* Plain Text items are editable overlays. Timed subtitles remain Text
            in the DSL but expose their cue-backed presentation separately. */}
        {item.type === 'text' && !subtitleItem && (
          <div ref={textSectionRef} className={inspectorSectionClassName}>
            <h3 className={sectionTitleClassName}>Text</h3>
            <div className="mb-3 block">
              <span className={labelClassName}>Font family</span>
              <FontFamilyPicker
                ariaLabel="Text font family"
                value={(item as TextItem).fontFamily || TIMELINE_SHARED_DEFAULTS.text.fontFamily}
                onChange={(fontFamily) => updateItem({ fontFamily })}
                className={fieldClassName}
              />
            </div>
            <div className="mb-3 block">
              <span className={labelClassName}>Font weight</span>
              <RemotionSelect
                ariaLabel="Text font weight"
                value={String((item as TextItem).fontWeight || TIMELINE_SHARED_DEFAULTS.text.fontWeight)}
                onValueChange={(nextValue) => updateItem({ fontWeight: nextValue })}
                options={[
                  { value: 'normal', label: 'Normal' },
                  { value: 'bold', label: 'Bold' },
                  { value: 'lighter', label: 'Lighter' },
                  { value: 'bolder', label: 'Bolder' },
                  ...[...new Set(['100', '200', '300', '400', '500', '600', '700', '800', '900', String((item as TextItem).fontWeight || TIMELINE_SHARED_DEFAULTS.text.fontWeight)])].filter(value => !['normal', 'bold', 'lighter', 'bolder'].includes(value)).map(value => ({ value, label: value })),
                ]}
                className={fieldClassName}
              />
            </div>

            <div className="mb-3">
              <label className={labelClassName}>Content</label>
              <RemotionTextarea
                aria-label="Text content"
                value={(item as TextItem).text}
                onChange={(e) => updateItem({ text: e.target.value })}
                className={`${fieldClassName} min-h-[80px] resize-y`}
              />
            </div>
            <div className="mb-3">
              <label className={labelClassName}>Color</label>
              <div className="flex gap-2 items-center">
                <RemotionInput
                  type="color"
                  value={(item as TextItem).color}
                  onChange={(e) => updateItem({ color: e.target.value })}
                  className={colorFieldClassName}
                />
                <RemotionInput
                  type="text"
                  value={(item as TextItem).color}
                  onChange={(e) => updateItem({ color: e.target.value })}
                  className={`flex-1 ${fieldClassName}`}
                />
              </div>
            </div>
            <div className="mb-3 grid grid-cols-2 gap-2">
              <label>
                <span className={labelClassName}>Font size</span>
                <RemotionInput
                  aria-label="Text font size"
                  type="number"
                  min={1}
                  value={(item as TextItem).fontSize || TIMELINE_SHARED_DEFAULTS.text.fontSize}
                  onChange={(e) =>
                    updateItem({
                      fontSize: Math.max(
                        1,
                        parseInt(e.target.value, 10) || TIMELINE_SHARED_DEFAULTS.text.fontSize,
                      ),
                    })
                  }
                  className={fieldClassName}
                />
              </label>
              <div>
                <span className={labelClassName}>Alignment</span>
                <RemotionSelect
                  ariaLabel="Text alignment"
                  value={(item as TextItem).textAlign ?? TIMELINE_SHARED_DEFAULTS.text.textAlign}
                  onValueChange={(nextValue) => updateItem({
                    textAlign: nextValue as TextItem['textAlign'],
                  })}
                  options={[
                    { value: 'left', label: 'Left' },
                    { value: 'center', label: 'Center' },
                    { value: 'right', label: 'Right' },
                  ]}
                  className={fieldClassName}
                />
              </div>
            </div>
            <div className="mb-3 grid grid-cols-2 gap-2">
              <label>
                <span className={labelClassName}>Letter spacing</span>
                <RemotionInput
                  aria-label="Text letter spacing in pixels"
                  type="number"
                  step={0.1}
                  value={(item as TextItem).letterSpacingPx ?? TIMELINE_SHARED_DEFAULTS.text.letterSpacingPx}
                  onChange={(event) => updateItem({
                    letterSpacingPx: Number(event.target.value)
                      || TIMELINE_SHARED_DEFAULTS.text.letterSpacingPx,
                  })}
                  className={fieldClassName}
                />
              </label>
              <label>
                <span className={labelClassName}>Line height</span>
                <RemotionInput
                  aria-label="Text line height"
                  type="number"
                  min={0.5}
                  step={0.05}
                  value={(item as TextItem).lineHeight ?? TIMELINE_SHARED_DEFAULTS.text.lineHeight}
                  onChange={(event) => updateItem({
                    lineHeight: Math.max(
                      0.5,
                      Number(event.target.value) || TIMELINE_SHARED_DEFAULTS.text.lineHeight,
                    ),
                  })}
                  className={fieldClassName}
                />
              </label>
            </div>

          </div>
        )}

        {/* Transform Properties */}
        {supportsVisualTransform && (
        <div ref={transformSectionRef} className={inspectorSectionClassName}>
          <h3 className={sectionTitleClassName}>Transform</h3>
          <p className={`mb-3 text-stone-500 ${editorTypeClassName.caption}`}>Move the playhead, add a keyframe, then change its value. Move to another time and add another keyframe to animate.</p>
          <div className="space-y-3">
            <PositionKeyframeControl trackId={trackId} item={item} />
            <div>
              <span className={labelClassName}>Base source scale</span>
              <p className={`mb-1 text-stone-400 ${editorTypeClassName.caption}`}>
                Unitless multipliers, not pixels. 1 × 1 uses contain fit.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <label className={`grid grid-cols-[18px_minmax(0,1fr)] items-center ${controlRadiusClassName} border border-warm-border bg-warm-page/40 pl-2 text-stone-400`}>
                  <span className={editorTypeClassName.caption}>W×</span>
                  <RemotionInput
                    aria-label="Width source scale multiplier"
                    type="number"
                    step="0.01"
                    min="0"
                    value={item.properties?.width ?? TIMELINE_SHARED_DEFAULTS.itemBase.properties.width}
                    onChange={(e) => updateItem({
                      properties: {
                        ...item.properties,
                        x: item.properties?.x ?? TIMELINE_SHARED_DEFAULTS.itemBase.properties.x,
                        y: item.properties?.y ?? TIMELINE_SHARED_DEFAULTS.itemBase.properties.y,
                        width: parseFloat(e.target.value) || 0,
                        height: item.properties?.height ?? TIMELINE_SHARED_DEFAULTS.itemBase.properties.height,
                      }
                    })}
                    className={`${fieldClassName} border-0 bg-transparent pl-0 focus:ring-0`}
                  />
                </label>
                <label className={`grid grid-cols-[18px_minmax(0,1fr)] items-center ${controlRadiusClassName} border border-warm-border bg-warm-page/40 pl-2 text-stone-400`}>
                  <span className={editorTypeClassName.caption}>H×</span>
                  <RemotionInput
                    aria-label="Height source scale multiplier"
                    type="number"
                    step="0.01"
                    min="0"
                    value={item.properties?.height ?? TIMELINE_SHARED_DEFAULTS.itemBase.properties.height}
                    onChange={(e) => updateItem({
                      properties: {
                        ...item.properties,
                        x: item.properties?.x ?? TIMELINE_SHARED_DEFAULTS.itemBase.properties.x,
                        y: item.properties?.y ?? TIMELINE_SHARED_DEFAULTS.itemBase.properties.y,
                        width: item.properties?.width ?? TIMELINE_SHARED_DEFAULTS.itemBase.properties.width,
                        height: parseFloat(e.target.value) || 0,
                      }
                    })}
                    className={`${fieldClassName} border-0 bg-transparent pl-0 focus:ring-0`}
                  />
                </label>
              </div>
            </div>
            <ScaleKeyframeControl trackId={trackId} item={item} />
            <div data-testid="scalar-keyframe-controls" className="space-y-3">
              <ScalarKeyframeControl
                trackId={trackId}
                item={item}
                channel="rotation"
                label="Rotation"
                ariaLabel="Rotation in degrees"
                step="1"
              />
              <ScalarKeyframeControl
                trackId={trackId}
                item={item}
                channel="opacity"
                label="Opacity"
                ariaLabel="Opacity"
                step="0.1"
                min="0"
                max="1"
              />
            </div>
            <p className={`m-0 text-stone-400 ${editorTypeClassName.caption}`}>
              Layer order follows the track stack.
            </p>
          </div>
        </div>
        )}

        {supportsMask && (
        <div className={inspectorSectionClassName}>
          <h3 className={sectionTitleClassName}>Mask</h3>
          <MaskControls trackId={trackId} item={item} />
        </div>
        )}

        {/* Common Properties */}
        <div className={inspectorSectionClassName}>
          <h3 className={sectionTitleClassName}>Timing</h3>
          {item.type === 'transition' ? (
            <>
              <div className="mb-3">
                <label className={labelClassName}>Range</label>
                <div className={readOnlyFieldClassName}>
                  {formatTime(item.from)}–{formatTime(item.from + item.durationInFrames)}
                </div>
              </div>
              <div className="mb-3">
                <label className={labelClassName}>Duration (frames)</label>
                <RemotionInput
                  aria-label="Transition duration in frames"
                  type="number"
                  min={1}
                  max={transitionMaxDuration}
                  value={item.durationInFrames}
                  onChange={(e) => {
                    const requestedDuration = parseInt(e.target.value, 10) || 1;
                    const nextDuration = Math.max(
                      1,
                      Math.min(transitionMaxDuration, requestedDuration),
                    );
                    updateItem({
                      durationInFrames: nextDuration,
                      from: transitionBoundary
                        ? transitionBoundary.frame - Math.floor(nextDuration / 2)
                        : item.from,
                    });
                  }}
                  className={fieldClassName}
                />
              </div>
              <div className="mb-3">
                <label className={labelClassName}>Duration</label>
                <div className={readOnlyFieldClassName}>
                  {(item.durationInFrames / Math.max(1, fps)).toFixed(2)} seconds
                </div>
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <label>
                  <span className={labelClassName}>Start</span>
                  <RemotionInput
                    aria-label="Start frame"
                    type="number"
                    value={item.from}
                    min={0}
                    onChange={(e) => updateTiming(e, 'from')}
                    className={fieldClassName}
                  />
                </label>
                <label>
                  <span className={labelClassName}>Duration</span>
                  <RemotionInput
                    aria-label="Duration in frames"
                    type="number"
                    min={1}
                    value={item.durationInFrames}
                    onChange={(e) => updateTiming(e, 'durationInFrames')}
                    className={fieldClassName}
                  />
                </label>
              </div>
              {(item.type === 'video' || item.type === 'audio') && (
                <label>
                  <span className={labelClassName}>Source in-point</span>
                  <RemotionInput
                    aria-label="Source start frame"
                    type="number"
                    min={0}
                    step={1}
                    value={item.sourceStartInFrames ?? TIMELINE_SHARED_DEFAULTS[item.type].sourceStartInFrames}
                    onChange={(event) => updateItem({
                      sourceStartInFrames: Math.max(
                        0,
                        parseInt(event.target.value, 10)
                          || TIMELINE_SHARED_DEFAULTS[item.type].sourceStartInFrames,
                      ),
                    } as Partial<typeof item>)}
                    className={fieldClassName}
                  />
                </label>
              )}
            </div>
          )}
        </div>

        {(item.type === 'video'
          || item.type === 'image'
          || item.type === 'sticker'
          || item.type === 'derived-overlay') && (
          <div className={inspectorSectionClassName}>
            <h3 className={sectionTitleClassName}>Layout</h3>
            <MediaFitControl
              value={item.mediaFit}
              fallback={TIMELINE_SHARED_DEFAULTS[item.type].mediaFit}
              onChange={(mediaFit) => updateItem({ mediaFit } as Partial<typeof item>)}
            />
          </div>
        )}

        {item.type === 'video' && (
          <div className={inspectorSectionClassName}>
            <h3 className={sectionTitleClassName}>Animation</h3>
            <div className="space-y-2">
              {(['entrance', 'exit'] as const).map((phase) => {
                const field = phase === 'entrance' ? 'entranceAnimation' : 'exitAnimation';
                const animation = item[field];
                const phaseLabel = phase === 'entrance' ? 'Entrance' : 'Exit';
                return (
                  <div
                    key={phase}
                    className={`${controlRadiusClassName} border border-warm-border/75 bg-warm-page/35 p-2.5`}
                  >
                    <p className={`mb-2 mt-0 font-semibold text-slate-700 dark:text-stone-300 ${editorTypeClassName.control}`}>
                      {phaseLabel}
                    </p>
                    <div className="grid grid-cols-[minmax(0,1fr)_5rem] gap-2">
                      <div>
                        <span className={labelClassName}>Motion</span>
                        <RemotionSelect
                          ariaLabel={`${phaseLabel} animation type`}
                          value={animation?.type ?? 'none'}
                          onValueChange={(nextValue) => updateVideoAnimation(phase, {
                            type: nextValue as ClipAnimationType | 'none',
                          })}
                          options={[
                            { value: 'none', label: 'None' },
                            ...CLIP_ANIMATION_OPTIONS,
                          ]}
                          className={fieldClassName}
                        />
                      </div>
                      <label>
                        <span className={labelClassName}>Frames</span>
                        <RemotionInput
                          aria-label={`${phaseLabel} animation duration in frames`}
                          type="number"
                          min={1}
                          max={item.durationInFrames}
                          step={1}
                          disabled={!animation}
                          value={animation?.durationInFrames ?? Math.min(15, item.durationInFrames)}
                          onChange={(event) => updateVideoAnimation(phase, {
                            durationInFrames: parseInt(event.target.value, 10) || 1,
                          })}
                          className={`${fieldClassName} disabled:cursor-not-allowed disabled:bg-warm-muted/55 disabled:text-stone-400`}
                        />
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className={`mb-0 mt-2 text-stone-400 ${editorTypeClassName.caption}`}>
              Entrance and exit belong to this clip. Transitions stay between continuous clips.
            </p>
          </div>
        )}

        {/* Ordered, version-pinned clip effect stack */}
        {item.effects && item.effects.length > 0 && (
          <div className={inspectorSectionClassName}>
            <h3 className={sectionTitleClassName}>Effects</h3>
            <div className="space-y-2">
              {item.effects.map((effect, effectIndex) => {
                const definition = resolveEffectDefinition(effect.effectId, effect.effectVersion);
                const displayName = effectDisplayName(effect.effectId);
                return (
                  <div key={`${effect.effectId}:${effect.effectVersion}:${effectIndex}`} className="rounded-lg bg-warm-page/70 p-2.5 ring-1 ring-warm-border/70">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className={`m-0 truncate font-semibold text-slate-900 dark:text-stone-100 ${editorTypeClassName.item}`}>{displayName}</p>
                        <p className={`m-0 text-stone-400 ${editorTypeClassName.caption}`}>v{effect.effectVersion}</p>
                      </div>
                      <div className="flex items-center">
                        {([
                          { direction: -1, label: 'up', path: 'M5 12.5 10 7.5l5 5' },
                          { direction: 1, label: 'down', path: 'M5 7.5 10 12.5l5-5' },
                        ] as const).map(({ direction, label, path }) => {
                          const targetIndex = effectIndex + direction;
                          const canMove = targetIndex >= 0 && targetIndex < (item.effects?.length ?? 0);
                          return (
                            <RemotionButton
                              key={label}
                              type="button"
                              aria-label={`Move ${displayName} ${label}`}
                              title={`Move ${displayName} ${label}`}
                              disabled={!canMove}
                              onClick={() => {
                                if (!canMove || !item.effects) return;
                                const effects = [...item.effects];
                                [effects[effectIndex], effects[targetIndex]] = [
                                  effects[targetIndex]!,
                                  effects[effectIndex]!,
                                ];
                                updateItem({ effects });
                              }}
                              className={`flex h-7 w-7 items-center justify-center ${controlRadiusClassName} text-stone-400 transition-colors hover:bg-warm-muted hover:text-slate-700 disabled:opacity-25 dark:hover:text-stone-200`}
                            >
                              <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true">
                                <path d={path} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </RemotionButton>
                          );
                        })}
                        <RemotionButton
                          type="button"
                          aria-label={`Remove ${displayName}`}
                          title={`Remove ${displayName}`}
                          onClick={() => updateItem({
                            effects: item.effects?.filter((_, index) => index !== effectIndex) ?? [],
                          })}
                          className={`flex h-7 w-7 items-center justify-center ${controlRadiusClassName} text-stone-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/45 dark:hover:text-red-400`}
                        >
                          <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true">
                            <path d="M4 10h12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                          </svg>
                        </RemotionButton>
                      </div>
                    </div>
                    {definition ? (
                      <div className="space-y-2">
                        {Object.entries(definition.params).map(([name, parameter]) => (
                          <EffectParameterControl
                            key={name}
                            effectName={displayName}
                            name={name}
                            definition={parameter}
                            value={resolveEffectParameterValue(effect.params?.[name], parameter)}
                            onChange={(value) => updateItem({
                              effects: item.effects?.map((candidate, index) => index === effectIndex
                                ? { ...candidate, params: { ...(candidate.params ?? {}), [name]: value } }
                                : candidate),
                            })}
                          />
                        ))}
                      </div>
                    ) : (
                      <p className={`m-0 text-stone-500 ${editorTypeClassName.control}`}>
                        Effect package unavailable. The pinned reference is preserved.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Transition Item Properties */}
        {item.type === 'transition' && (
          <div className={inspectorSectionClassName}>
            <h3 className={sectionTitleClassName}>Transition</h3>
            <div className="mb-3">
              <label className={labelClassName}>Type</label>
              <RemotionSelect
                ariaLabel="Transition type"
                value={(item as TransitionItem).transitionType}
                onValueChange={(nextValue) =>
                  updateItem({ transitionType: nextValue as TransitionType } as Partial<typeof item>)
                }
                options={TRANSITION_TYPES.map((transitionType) => ({
                  value: transitionType,
                  label: transitionType,
                }))}
                className={fieldClassName}
              />
            </div>
            <div className="mb-3 grid grid-cols-2 gap-2">
              <div>
                <label className={labelClassName}>From item ID</label>
                <div className={readOnlyFieldClassName}>
                  {(item as TransitionItem).fromItemId ?? 'Missing'}
                </div>
              </div>
              <div>
                <label className={labelClassName}>To item ID</label>
                <div className={readOnlyFieldClassName}>
                  {(item as TransitionItem).toItemId ?? 'Missing'}
                </div>
              </div>
            </div>
            <p className={`m-0 text-slate-500 ${editorTypeClassName.item}`}>
              {transitionBoundary
                ? 'Pinned to the continuous edit point. Drag either edge on the Timeline or edit the duration here.'
                : 'This transition is detached because the referenced clips are no longer continuous.'}
            </p>
          </div>
        )}

        {/* Clip gain is independent from fade duration in both the DSL and UI. */}
        {(item.type === 'video' || item.type === 'audio') && (
          <div className={inspectorSectionClassName}>
            <h3 className={sectionTitleClassName}>Audio</h3>
            <div>
              <label className={labelClassName}>Gain</label>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <RemotionInput
                  aria-label="Audio gain in decibels"
                  type="number"
                  min={AUDIO_GAIN_DB_MIN}
                  max={AUDIO_GAIN_DB_MAX}
                  step={0.1}
                  value={Math.round(resolveAudioGainDb(item) * 10) / 10}
                  onChange={(e) =>
                    updateItem({
                      audioGainDb: Math.max(
                        AUDIO_GAIN_DB_MIN,
                        Math.min(AUDIO_GAIN_DB_MAX, Number(e.target.value)),
                      ),
                      volume: undefined,
                    } as Partial<typeof item>)
                  }
                  className={fieldClassName}
                />
                <span className={`w-6 text-right text-stone-400 ${editorTypeClassName.caption}`}>dB</span>
              </div>
            </div>
            {item.type === 'audio' && selectedTrack?.role === 'music' && (
              <div className="mt-4 border-t border-warm-border/60 pt-3">
                <label className="flex items-center justify-between gap-3 text-slate-600 dark:text-stone-300">
                  <span className={`font-medium ${editorTypeClassName.control}`}>Duck under speech</span>
                  <RemotionInput
                    aria-label="Automatic audio ducking"
                    type="checkbox"
                    checked={Boolean(item.audioDucking)}
                    onChange={(event) => updateItem({
                      audioDucking: event.target.checked
                        ? { ...DEFAULT_AUDIO_DUCKING_SETTINGS }
                        : undefined,
                    } as Partial<typeof item>)}
                    className="h-4 w-4 accent-brand"
                  />
                </label>
                {item.audioDucking && (
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <div>
                      <label className={labelClassName}>Amount</label>
                      <RemotionInput
                        aria-label="Ducking amount in decibels"
                        type="number"
                        min={AUDIO_GAIN_DB_MIN}
                        max={0}
                        step={0.1}
                        value={item.audioDucking.amountDb}
                        onChange={(event) => updateItem({
                          audioDucking: {
                            ...item.audioDucking,
                            amountDb: Math.max(
                              AUDIO_GAIN_DB_MIN,
                              Math.min(0, Number(event.target.value)),
                            ),
                          },
                        } as Partial<AudioItem>)}
                        className={fieldClassName}
                      />
                    </div>
                    <div>
                      <label className={labelClassName}>Attack</label>
                      <RemotionInput
                        aria-label="Ducking attack frames"
                        type="number"
                        min={0}
                        step={1}
                        value={item.audioDucking.attackFrames}
                        onChange={(event) => updateItem({
                          audioDucking: {
                            ...item.audioDucking,
                            attackFrames: Math.max(0, parseInt(event.target.value, 10) || 0),
                          },
                        } as Partial<AudioItem>)}
                        className={fieldClassName}
                      />
                    </div>
                    <div>
                      <label className={labelClassName}>Release</label>
                      <RemotionInput
                        aria-label="Ducking release frames"
                        type="number"
                        min={0}
                        step={1}
                        value={item.audioDucking.releaseFrames}
                        onChange={(event) => updateItem({
                          audioDucking: {
                            ...item.audioDucking,
                            releaseFrames: Math.max(0, parseInt(event.target.value, 10) || 0),
                          },
                        } as Partial<AudioItem>)}
                        className={fieldClassName}
                      />
                    </div>
                  </div>
                )}
                <p className={`mb-0 mt-2 text-stone-400 ${editorTypeClassName.caption}`}>
                  Narration, dialogue, and primary video audio trigger the reduction.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Audio fade stays separate from dB gain. Visual video motion lives
            in Animation above; transitions remain bound to clip seams. */}
        {(item.type === 'audio' || item.type === 'image') && (
          <div className={inspectorSectionClassName}>
            <h3 className={sectionTitleClassName}>Fades</h3>

            {item.type === 'audio' && (
              <div className="mb-3 grid grid-cols-2 gap-2">
                  <div>
                    <label className={labelClassName}>Fade in</label>
                    <RemotionInput
                      aria-label="Audio fade in frames"
                      type="number"
                      min={0}
                      step={1}
                      value={resolveAudioFadeInFrames(item)}
                      onChange={(e) =>
                        updateItem({
                          audioFadeInFrames: Math.max(0, parseInt(e.target.value, 10) || 0),
                          audioFadeIn: undefined,
                        } as Partial<typeof item>)
                      }
                      className={fieldClassName}
                    />
                  </div>
                  <div>
                    <label className={labelClassName}>Fade out</label>
                    <RemotionInput
                      aria-label="Audio fade out frames"
                      type="number"
                      min={0}
                      step={1}
                      value={resolveAudioFadeOutFrames(item)}
                      onChange={(e) =>
                        updateItem({
                          audioFadeOutFrames: Math.max(0, parseInt(e.target.value, 10) || 0),
                          audioFadeOut: undefined,
                        } as Partial<typeof item>)
                      }
                      className={fieldClassName}
                    />
                  </div>
              </div>
            )}

            {item.type === 'image' && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className={labelClassName}>Fade in</label>
                    <RemotionInput
                      aria-label="Image fade in frames"
                      type="number"
                      min={0}
                      value={item.imageFadeIn ?? TIMELINE_SHARED_DEFAULTS.image.imageFadeIn}
                      onChange={(e) =>
                        updateItem({
                          imageFadeIn: Math.max(
                            0,
                            parseInt(e.target.value, 10)
                              || TIMELINE_SHARED_DEFAULTS.image.imageFadeIn,
                          ),
                        } as Partial<typeof item>)
                      }
                      className={fieldClassName}
                    />
                  </div>
                  <div>
                    <label className={labelClassName}>Fade out</label>
                    <RemotionInput
                      aria-label="Image fade out frames"
                      type="number"
                      min={0}
                      value={item.imageFadeOut ?? TIMELINE_SHARED_DEFAULTS.image.imageFadeOut}
                      onChange={(e) =>
                        updateItem({
                          imageFadeOut: Math.max(
                            0,
                            parseInt(e.target.value, 10)
                              || TIMELINE_SHARED_DEFAULTS.image.imageFadeOut,
                          ),
                        } as Partial<typeof item>)
                      }
                      className={fieldClassName}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label>
                    <span className={labelClassName}>Fade-in color</span>
                    <RemotionInput
                      aria-label="Image fade in color"
                      type="text"
                      placeholder="transparent"
                      value={item.imageFadeInColor ?? ''}
                      onChange={(event) => updateItem({
                        imageFadeInColor: event.target.value || undefined,
                      } as Partial<typeof item>)}
                      className={fieldClassName}
                    />
                  </label>
                  <label>
                    <span className={labelClassName}>Fade-out color</span>
                    <RemotionInput
                      aria-label="Image fade out color"
                      type="text"
                      placeholder="transparent"
                      value={item.imageFadeOutColor ?? ''}
                      onChange={(event) => updateItem({
                        imageFadeOutColor: event.target.value || undefined,
                      } as Partial<typeof item>)}
                      className={fieldClassName}
                    />
                  </label>
                </div>
              </div>
            )}
          </div>
        )}

        {subtitleItem && (
          <div ref={textSectionRef} className={inspectorSectionClassName}>
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h3 className="m-0 font-semibold tracking-[-0.01em] text-slate-800 dark:text-stone-200">
                Captions
              </h3>
              <span className={`text-stone-400 ${editorTypeClassName.caption}`}>
                {subtitleItem.cues.length} {subtitleItem.cues.length === 1 ? 'cue' : 'cues'}
              </span>
            </div>
            <p className={`mb-3 mt-0 text-stone-500 ${editorTypeClassName.control}`}>
              Cue text is edited in the Captions workspace. These controls style the timed Text item.
            </p>
            <div className="mb-3 grid grid-cols-2 gap-2">
              <div>
                <span className={labelClassName}>Position</span>
                <RemotionSelect
                  ariaLabel="Caption position"
                  value={subtitleItem.style?.position ?? TIMELINE_CAPTION_STYLE_DEFAULTS.position}
                  onValueChange={(nextValue) => updateItem({
                    style: {
                      ...subtitleItem.style,
                      position: nextValue as NonNullable<TextItem['style']>['position'],
                    },
                  })}
                  options={[
                    { value: 'top', label: 'Top' },
                    { value: 'center', label: 'Center' },
                    { value: 'bottom', label: 'Bottom' },
                  ]}
                  className={fieldClassName}
                />
              </div>
              <label>
                <span className={labelClassName}>Font size</span>
                <RemotionInput
                  aria-label="Caption font size"
                  type="number"
                  min={1}
                  value={subtitleItem.style?.fontSize ?? TIMELINE_CAPTION_STYLE_DEFAULTS.fontSize}
                  onChange={(event) => updateItem({
                    style: {
                      ...subtitleItem.style,
                      fontSize: Math.max(
                        1,
                        parseInt(event.target.value, 10) || TIMELINE_CAPTION_STYLE_DEFAULTS.fontSize,
                      ),
                    },
                  })}
                  className={fieldClassName}
                />
              </label>
            </div>
            <div className="mb-3 grid grid-cols-2 gap-2">
              <label>
                <span className={labelClassName}>Text color</span>
                <RemotionInput
                  aria-label="Caption text color"
                  type="text"
                  value={subtitleItem.style?.color ?? TIMELINE_CAPTION_STYLE_DEFAULTS.color}
                  onChange={(event) => updateItem({
                    style: { ...subtitleItem.style, color: event.target.value },
                  })}
                  className={fieldClassName}
                />
              </label>
              <label>
                <span className={labelClassName}>Background</span>
                <RemotionInput
                  aria-label="Caption background color"
                  type="text"
                  value={subtitleItem.style?.backgroundColor ?? TIMELINE_CAPTION_STYLE_DEFAULTS.backgroundColor}
                  onChange={(event) => updateItem({
                    style: { ...subtitleItem.style, backgroundColor: event.target.value },
                  })}
                  className={fieldClassName}
                />
              </label>
            </div>
            <label className="block">
              <span className={labelClassName}>Font family</span>
              <FontFamilyPicker
                ariaLabel="Caption font family"
                value={subtitleItem.style?.fontFamily ?? TIMELINE_CAPTION_STYLE_DEFAULTS.fontFamily}
                onChange={(fontFamily) => updateItem({
                  style: { ...subtitleItem.style, fontFamily },
                })}
                className={fieldClassName}
              />
            </label>
            <div className="mt-3 block">
              <span className={labelClassName}>Font weight</span>
              <RemotionSelect
                ariaLabel="Caption font weight"
                value={String(subtitleItem.style?.fontWeight ?? TIMELINE_CAPTION_STYLE_DEFAULTS.fontWeight)}
                onValueChange={(nextValue) => updateItem({
                  style: {
                    ...subtitleItem.style,
                    fontWeight: parseInt(nextValue, 10),
                  },
                })}
                options={[
                  { value: '400', label: 'Regular' },
                  { value: '500', label: 'Medium' },
                  { value: '600', label: 'Semibold' },
                  { value: '700', label: 'Bold' },
                  { value: '800', label: 'Extra bold' },
                  { value: '900', label: 'Black' },
                  ...(!['400', '500', '600', '700', '800', '900'].includes(String(subtitleItem.style?.fontWeight ?? TIMELINE_CAPTION_STYLE_DEFAULTS.fontWeight))
                    ? [{ value: String(subtitleItem.style?.fontWeight ?? TIMELINE_CAPTION_STYLE_DEFAULTS.fontWeight), label: String(subtitleItem.style?.fontWeight ?? TIMELINE_CAPTION_STYLE_DEFAULTS.fontWeight) }]
                    : []),
                ]}
                className={fieldClassName}
              />
            </div>
          </div>
        )}

        {/* Solid Item Properties */}
        {item.type === 'solid' && (
          <div className={inspectorSectionClassName}>
            <h3 className={sectionTitleClassName}>Color</h3>
            <div className="mb-3">
              <label className={labelClassName}>Background Color</label>
              <div className="flex gap-2 items-center">
                <RemotionInput
                  type="color"
                  value={(item as SolidItem).color}
                  onChange={(e) => updateItem({ color: e.target.value })}
                  className={colorFieldClassName}
                />
                <RemotionInput
                  type="text"
                  value={(item as SolidItem).color}
                  onChange={(e) => updateItem({ color: e.target.value })}
                  className={`flex-1 ${fieldClassName}`}
                />
              </div>
            </div>
          </div>
        )}

        {item.type === 'composition' && (
          <div className={inspectorSectionClassName}>
            <h3 className={sectionTitleClassName}>
              {item.runtime === 'remotion' ? 'Remotion Component' : 'Composition'}
            </h3>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <InspectorIdentityRow label="Runtime" value={item.runtime} />
                <InspectorIdentityRow label="Composition" value={item.compositionId} />
              </div>
              {item.sourceNodeId && (
                <InspectorIdentityRow label="Canvas node" value={item.sourceNodeId} />
              )}
              <p className={`m-0 text-stone-500 ${editorTypeClassName.control}`}>
                {item.runtime === 'remotion'
                  ? 'Edit this component on its linked Canvas node. Timeline preview and render resolve that node\'s latest source.'
                  : 'This legacy composition is rendered by its declared runtime or rendered asset fallback.'}
              </p>
            </div>
          </div>
        )}
        {item.type === 'derived-overlay' && (
          <div className={inspectorSectionClassName}>
            <h3 className={sectionTitleClassName}>Derived Media</h3>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <InspectorIdentityRow
                  label="Source asset"
                  value={(item as DerivedOverlayItem).sourceAssetId}
                />
                <InspectorIdentityRow
                  label="Derived asset"
                  value={(item as DerivedOverlayItem).derivedAssetId}
                />
              </div>
              <InspectorIdentityRow
                label="Derivation"
                value={(item as DerivedOverlayItem).derivation.kind}
              />
              {(item as DerivedOverlayItem).derivation.description && (
                <p className={`m-0 text-stone-500 ${editorTypeClassName.control}`}>
                  {(item as DerivedOverlayItem).derivation.description}
                </p>
              )}
            </div>
          </div>
        )}

        {item.type === 'sticker' && (
          <div className={inspectorSectionClassName}>
            <h3 className={sectionTitleClassName}>Sticker</h3>
            <InspectorIdentityRow
              label="Source"
              value={(item as StickerItem).src}
            />
          </div>
        )}

        {/* Source identity is deliberately read-only; trimming and fit are real
            edit operations above, while replacing an asset goes through Media. */}
        {(item.type === 'video'
          || item.type === 'image'
          || item.type === 'audio'
          || item.type === 'derived-overlay'
          || item.type === 'composition') && (
          <div className={inspectorSectionClassName}>
            <h3 className={sectionTitleClassName}>Source</h3>
            <InspectorIdentityRow
              label="File path"
              value={resolvedSource || 'Source unavailable'}
            />
          </div>
        )}
      </div>
    </div>
  );
};
