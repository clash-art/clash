import React from 'react';
import type { TextItem } from '@clash/remotion-core';
import type { ItemRenderProps } from '../registry';
import { colors, typography } from '../../styles';

export const TextRenderer: React.FC<ItemRenderProps> = ({ item, width, height }) => {
  const text = item as TextItem;
  return (
    <div
      style={{
        position: 'relative',
        width,
        height,
        boxSizing: 'border-box',
        background: 'transparent',
        color: colors.itemText.text,
        display: 'flex',
        alignItems: 'center',
        padding: '4px 8px',
        // This is an editor label, not text rendered in composition pixels.
        fontFamily: typography.fontFamily.sans,
        fontSize: typography.fontSize.sm,
        lineHeight: 1.2,
        overflow: 'hidden',
      }}
      title={text.text}
    >
      <span style={{ minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
        {text.text}
      </span>
    </div>
  );
};
