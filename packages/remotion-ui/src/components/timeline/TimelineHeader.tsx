import React from 'react';
import { TimelineIconButton } from '../ui/controls';
import { colors, timeline } from './styles';
import { ZoomControl, SnapButton } from './TimelineControls';

interface TimelineHeaderProps {
  zoom: number;
  snapEnabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canEditSelected?: boolean;
  hasSelectedItem?: boolean;
  autoFitEnabled?: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSplitSelected?: () => void;
  onTrimLeftSelected?: () => void;
  onTrimRightSelected?: () => void;
  onDeleteSelected?: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomToFit?: () => void;
  onZoomReset?: () => void;
  onToggleSnap: () => void;
  onToggleAutoFit?: () => void;
  onZoomChange: (zoom: number) => void;
  zoomLimits?: { min: number; max: number };
}

export const TimelineHeader: React.FC<TimelineHeaderProps> = ({
  zoom,
  snapEnabled,
  canUndo,
  canRedo,
  canEditSelected = false,
  hasSelectedItem = false,
  autoFitEnabled: _autoFitEnabled = false,
  onUndo,
  onRedo,
  onSplitSelected,
  onTrimLeftSelected,
  onTrimRightSelected,
  onDeleteSelected,
  onZoomIn,
  onZoomOut,
  onZoomToFit,
  onZoomReset,
  onToggleSnap,
  onToggleAutoFit: _onToggleAutoFit,
  onZoomChange,
  zoomLimits,
}) => {
  const limits = zoomLimits || { min: timeline.zoomMin, max: timeline.zoomMax };
  const editToolStyle = (enabled: boolean): React.CSSProperties => ({
    width: 28,
    height: 28,
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    border: 0,
    borderRadius: 6,
    color: colors.text.secondary,
    cursor: enabled ? 'pointer' : 'default',
    opacity: enabled ? 1 : 0.3,
  });

  return (
    <div
      data-timeline-header=""
      style={{
        height: timeline.headerHeight,
        backgroundColor: colors.bg.primary,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 12px',
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}
    >
      {/* Timeline document history stays with the document surface. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <TimelineIconButton
            aria-label="Undo"
            title="Undo (⌘/Ctrl+Z)"
            disabled={!canUndo}
            onClick={onUndo}
            style={{
              width: 28,
              height: 28,
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'transparent',
              border: 0,
              borderRadius: 6,
              color: colors.text.secondary,
              cursor: canUndo ? 'pointer' : 'default',
              opacity: canUndo ? 1 : 0.3,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 7 4 12l5 5" />
              <path d="M5 12h8a6 6 0 0 1 6 6" />
            </svg>
          </TimelineIconButton>
          <TimelineIconButton
            aria-label="Redo"
            title="Redo (⌘/Ctrl+Shift+Z)"
            disabled={!canRedo}
            onClick={onRedo}
            style={{
              width: 28,
              height: 28,
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'transparent',
              border: 0,
              borderRadius: 6,
              color: colors.text.secondary,
              cursor: canRedo ? 'pointer' : 'default',
              opacity: canRedo ? 1 : 0.3,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m15 7 5 5-5 5" />
              <path d="M19 12h-8a6 6 0 0 0-6 6" />
            </svg>
          </TimelineIconButton>
        </div>
        <div
          role="toolbar"
          aria-label="Selected item edit tools"
          style={{
            alignItems: 'center',
            borderLeft: `1px solid ${colors.border.subtle}`,
            display: 'flex',
            gap: 3,
            paddingLeft: 10,
          }}
        >
          <TimelineIconButton
            aria-label="Split at playhead"
            title="Split selected item at playhead"
            disabled={!canEditSelected}
            onClick={onSplitSelected}
            style={editToolStyle(canEditSelected)}
          >
            <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10 2.5v15" />
              <path d="M7 3.5H4.5v13H7" />
              <path d="M13 3.5h2.5v13H13" />
            </svg>
          </TimelineIconButton>
          <TimelineIconButton
            aria-label="Trim start to playhead"
            title="Remove selected item before playhead"
            disabled={!canEditSelected}
            onClick={onTrimLeftSelected}
            style={editToolStyle(canEditSelected)}
          >
            <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 3v14" strokeDasharray="1.5 2" />
              <path d="M14.5 3.5H11v13h3.5" />
            </svg>
          </TimelineIconButton>
          <TimelineIconButton
            aria-label="Trim end to playhead"
            title="Remove selected item after playhead"
            disabled={!canEditSelected}
            onClick={onTrimRightSelected}
            style={editToolStyle(canEditSelected)}
          >
            <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 3v14" strokeDasharray="1.5 2" />
              <path d="M5.5 3.5H9v13H5.5" />
            </svg>
          </TimelineIconButton>
          <TimelineIconButton
            aria-label="Delete selected item"
            title="Delete selected item"
            disabled={!hasSelectedItem}
            onClick={onDeleteSelected}
            style={{
              ...editToolStyle(hasSelectedItem),
              color: hasSelectedItem ? colors.accent.danger : colors.text.secondary,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3.5 5.5h13" />
              <path d="M7.5 3.5h5" />
              <path d="M5.5 5.5l.8 11h7.4l.8-11" />
            </svg>
          </TimelineIconButton>
        </div>
      </div>

      {/* Timeline scale and snapping remain local to the Timeline. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ZoomControl
          zoom={zoom}
          min={limits.min}
          max={limits.max}
          onZoomChange={onZoomChange}
          onZoomIn={onZoomIn}
          onZoomOut={onZoomOut}
          onZoomToFit={onZoomToFit}
          onZoomReset={onZoomReset}
        />

        <SnapButton
          enabled={snapEnabled}
          onToggle={onToggleSnap}
        />
      </div>
    </div>
  );
};
