import React from 'react';
import type { CompositionItem } from '@clash/remotion-core';
import type { ItemRenderProps } from '../registry';

export const CompositionRenderer: React.FC<ItemRenderProps> = ({ item, width, height }) => {
  const composition = item as CompositionItem;
  const badge =
    composition.runtime === 'remotion' ? 'R' : composition.runtime === 'html' ? 'H' : 'Comp';

  return (
    <div
      data-timeline-item-type="composition"
      style={{
        width,
        height,
        borderRadius: 2,
        backgroundImage:
          'repeating-linear-gradient(90deg, rgba(79, 70, 229, 0.92) 0 12px, rgba(14, 165, 233, 0.92) 12px 24px)',
        color: '#ffffff',
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr) auto',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px',
        overflow: 'hidden',
        fontSize: 11,
        fontWeight: 650,
        lineHeight: 1.1,
        textShadow: '0 1px 1px rgba(0,0,0,0.35)',
      }}
      title={`Composition: ${composition.compositionId} (${composition.runtime}, ${composition.compositionKind}) from ${composition.sourcePath}`}
    >
      <span>{badge}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {composition.compositionId}
      </span>
      {width >= 96 && <span style={{ opacity: 0.9 }}>{composition.runtime}</span>}
    </div>
  );
};
