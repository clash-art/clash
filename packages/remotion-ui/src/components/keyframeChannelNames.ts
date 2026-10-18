import type { TimelineKeyframeChannel } from '@clash/shared-types';

/** Chinese names for animatable channels, used in keyframe tooltips. */
export const KEYFRAME_CHANNEL_NAMES_ZH: Readonly<Record<TimelineKeyframeChannel, string>> = Object.freeze({
  position: '位置',
  scale: '缩放',
  rotation: '旋转',
  opacity: '不透明度',
  maskPosition: '蒙版位置',
  maskSize: '蒙版大小',
  maskRotation: '蒙版旋转',
  maskFeather: '蒙版羽化',
});
