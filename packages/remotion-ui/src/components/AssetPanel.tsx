import React, { useRef, useState } from 'react';
import {
  getEditorAssetKey,
  normalizeEditorAsset,
  useEditorDispatch,
  useEditorStaticState,
} from '@clash/remotion-core';
import type { Asset, EditorAssetInput } from '@clash/remotion-core';
import { RemotionButton, RemotionFileInput } from './ui/controls';

// Export for TimelineTracksContainer to use
export let currentDraggedAsset: any = null;
export let currentAssetDragOffset: number = 0; // 鼠标相对于 asset 卡片左边缘的偏移量（像素）

type AssetPanelProps = {
  onBack?: () => void;
  backLabel?: string;
  onAssetUpload?: (file: File, type: 'video' | 'image' | 'audio') => void;
  availableAssets?: EditorAssetInput[];
  onAssetPicked?: (asset: EditorAssetInput) => void;
  onRequestAsset?: () => void;
  onExport?: () => Promise<void>;
  headerTrailingAction?: React.ReactNode;
  showHeader?: boolean;
  compact?: boolean;
};

const editorTypeClassName = {
  caption: 'text-[length:var(--clash-editor-text-caption)] leading-[var(--clash-editor-leading-caption)]',
  control: 'text-[length:var(--clash-editor-text-control)] leading-[var(--clash-editor-leading-control)]',
  item: 'text-[length:var(--clash-editor-text-item)] leading-[var(--clash-editor-leading-item)]',
  heading: 'text-[length:var(--clash-editor-text-heading)] leading-[var(--clash-editor-leading-heading)]',
} as const;

function AssetThumbnail({ asset, compact }: { asset: Asset; compact: boolean }) {
  const [failed, setFailed] = useState(false);
  const sizeClass = compact ? 'h-10 w-10' : 'h-12 w-12';
  const mediaClassName = `${sizeClass} shrink-0 rounded border border-warm-border bg-warm-muted object-cover object-left-top`;

  if (failed || !asset.src) {
    return (
      <div className={`${sizeClass} flex shrink-0 items-center justify-center rounded border border-warm-border bg-warm-muted text-[9px] font-bold uppercase text-stone-400`}>
        {asset.type}
      </div>
    );
  }
  if (asset.type === 'video') {
    return asset.thumbnail ? (
      <img src={asset.thumbnail} alt="" className={mediaClassName} onError={() => setFailed(true)} />
    ) : (
      <div
        data-video-thumbnail-placeholder=""
        className={`${sizeClass} flex shrink-0 items-center justify-center rounded border border-warm-border bg-slate-950 text-white/70`}
        aria-hidden="true"
      >
        <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor">
          <path d="m7.25 5.5 7 4.5-7 4.5v-9Z" />
        </svg>
      </div>
    );
  }
  if (asset.type === 'image') {
    return <img src={asset.src} alt="" className={mediaClassName} onError={() => setFailed(true)} />;
  }
  return (
    <div className={`${sizeClass} ${editorTypeClassName.control} flex shrink-0 items-center justify-center rounded border border-warm-border bg-warm-muted font-bold text-stone-500 dark:text-stone-400`}>
      A
    </div>
  );
}

export const AssetPanel: React.FC<AssetPanelProps> = ({
  onBack,
  backLabel = '返回',
  onAssetUpload,
  availableAssets = [],
  onAssetPicked,
  onRequestAsset,
  onExport,
  headerTrailingAction,
  showHeader = true,
  compact = false,
}) => {
  const dispatch = useEditorDispatch();
  const { assets } = useEditorStaticState();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const showUploadControls = Boolean(onRequestAsset || onAssetUpload || availableAssets.length > 0);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    for (const file of Array.from(files)) {
      const type = file.type.startsWith('video')
        ? 'video'
        : file.type.startsWith('audio')
          ? 'audio'
          : file.type.startsWith('image')
            ? 'image'
            : null;

      if (!type) continue;
      if (!onAssetUpload) {
        console.warn('[AssetPanel] onAssetUpload not provided; skipping upload.');
        continue;
      }

      onAssetUpload(file, type);
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleAssetDragStart = (e: React.DragEvent, asset: Asset) => {
    currentDraggedAsset = asset; // Store globally

    // 计算鼠标相对于 asset 卡片左边缘的偏移量
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    currentAssetDragOffset = e.clientX - rect.left;

    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', asset.id); // Use text/plain for better compatibility
    e.dataTransfer.setData('assetId', asset.id);
    e.dataTransfer.setData('asset', JSON.stringify(asset));
  };

  const handlePickAsset = (asset: EditorAssetInput) => {
    const assetKey = getEditorAssetKey(asset);
    const exists = assets.some((a) =>
      getEditorAssetKey(a) === assetKey ||
      (!!asset.src && a.src === asset.src)
    );

    if (!exists) {
      dispatch({
        type: 'ADD_ASSET',
        payload: normalizeEditorAsset({
          ...asset,
          name: asset.name || 'Canvas Asset',
          readOnly: true,
        }),
      });
    }
    onAssetPicked?.(asset);
    setIsPickerOpen(false);
  };

  return (

    <div className="relative flex h-full min-w-0 flex-col overflow-hidden bg-warm-page">
      {showHeader && (
      <div className="flex h-10 shrink-0 items-center bg-warm-surface px-2">
        <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
          {onBack ? (
            <RemotionButton
              type="button"
              onClick={onBack}
              className="flex h-7 w-7 items-center justify-center rounded-md bg-transparent text-stone-600 transition-colors hover:bg-warm-muted hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:text-stone-400 dark:hover:text-stone-100"
              aria-label={backLabel}
            >
              <svg
                viewBox="0 0 24 24"
                className="h-5 w-5"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  d="M10.5 6.5L5 12l5.5 5.5M6 12h13"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </RemotionButton>
          ) : (
            <h2 className={`m-0 min-w-0 flex-1 truncate px-1 font-display font-semibold text-slate-950 dark:text-stone-100 ${editorTypeClassName.heading}`}>Assets</h2>
          )}
          {onExport && (
            <RemotionButton
              type="button"
              onClick={() => onExport()}
              className={`flex h-8 items-center justify-center rounded-md bg-brand px-3 font-semibold text-brand-foreground shadow-sm transition-colors hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${editorTypeClassName.control}`}
            >
              Export
            </RemotionButton>
          )}
          {headerTrailingAction}
        </div>
      </div>
      )}

      <div
        data-asset-panel-body=""
        className={compact
          ? 'clash-timeline-panel-surface rounded-matrix bg-warm-surface p-3 min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto'
          : 'min-h-0 min-w-0 flex-1 overflow-auto p-4'}
      >
        {/* Upload Section */}
        {showUploadControls && (
        <div className={compact ? 'mb-4' : 'mb-6'}>
          <div className={`flex items-center justify-between ${compact ? 'mb-1.5 min-h-7' : 'mb-3'}`}>
            <h3 className={`m-0 font-display font-semibold text-stone-500 ${editorTypeClassName.control}`}>
              Media files
            </h3>
            {compact ? headerTrailingAction : null}
          </div>
          {onRequestAsset ? (
            <RemotionButton
              onClick={onRequestAsset}
              className={`h-8 w-full rounded-md bg-brand px-3 font-semibold text-brand-foreground shadow-sm transition-colors hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${editorTypeClassName.control}`}
            >
              Add media
            </RemotionButton>
          ) : (
          <>
          <RemotionFileInput
            ref={fileInputRef}
            accept="image/*,video/*,audio/*"
            multiple
            className="hidden"
            onChange={handleFileUpload}
          />
          <RemotionButton
            onClick={() => fileInputRef.current?.click()}
            className={`h-8 w-full rounded-md bg-brand px-3 font-semibold text-brand-foreground shadow-sm transition-colors hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 ${editorTypeClassName.control}`}
            disabled={!onAssetUpload}
          >
            Upload Files
          </RemotionButton>
          <RemotionButton
            onClick={() => setIsPickerOpen(true)}
            className={`mt-2 h-8 w-full rounded-md border border-warm-border bg-warm-surface/55 px-3 font-semibold text-stone-600 transition-colors hover:bg-warm-muted hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-stone-300 dark:hover:text-stone-100 ${editorTypeClassName.control}`}
            disabled={availableAssets.length === 0}
          >
            Add From Canvas
          </RemotionButton>
          </>
          )}
        </div>
        )}

        {/* Assets List */}
        {compact ? (
          <div className="flex h-8 items-center justify-between">
            <h3 className={`m-0 font-display font-semibold text-stone-500 ${editorTypeClassName.control}`}>
              Timeline media
            </h3>
            <span className={`font-medium tabular-nums text-stone-400 ${editorTypeClassName.caption}`}>
              {assets.length}
            </span>
          </div>
        ) : null}
        <div data-asset-list="" className={`flex min-w-0 flex-col ${compact ? 'gap-0' : 'gap-2'}`}>
          {assets.length === 0 ? (
            <div className={compact ? 'py-7 text-left' : 'rounded-md border border-dashed border-warm-border bg-warm-surface/60 py-8 text-center'}>
              <p className={`${editorTypeClassName.item} ${compact ? 'font-semibold text-slate-700 dark:text-stone-300' : 'text-slate-400 dark:text-stone-500'}`}>
                No media in this edit
              </p>
              {compact ? (
                <p className={`mt-1 max-w-[220px] text-stone-400 ${editorTypeClassName.caption}`}>
                  Add media above, then drag it onto a compatible Timeline lane.
                </p>
              ) : null}
            </div>
          ) : (
            assets.map((asset) => (
              <div
                key={asset.id}
                draggable
                onDragStart={(e) => handleAssetDragStart(e, asset)}
                className={`group flex w-full min-w-0 cursor-move items-center overflow-hidden transition-colors ${compact ? 'gap-2 rounded-lg py-2 hover:bg-warm-muted/70' : 'gap-3 rounded-md border border-warm-border bg-warm-surface p-2 hover:border-brand/40 hover:bg-brand-light/35 hover:shadow-sm'}`}
              >
                <AssetThumbnail asset={asset} compact={compact} />
                <div className="flex-1 min-w-0 overflow-hidden">
                  <div className={`truncate font-medium text-slate-900 dark:text-stone-100 ${editorTypeClassName.item}`} title={asset.name}>
                    {asset.name}
                  </div>
                  <div className={`mt-0.5 capitalize text-slate-500 dark:text-stone-400 ${editorTypeClassName.caption}`}>{asset.type}</div>
                </div>
                <RemotionButton
                  type="button"
                  aria-label={`Remove ${asset.name} from Timeline media`}
                  title="Remove from Timeline media"
                  onClick={() => dispatch({ type: 'REMOVE_ASSET', payload: asset.id })}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 opacity-60 transition-[color,background-color,opacity] hover:bg-red-50 hover:text-red-600 hover:opacity-100 focus-visible:opacity-100 dark:text-stone-500 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                >
                  ×
                </RemotionButton>
              </div>
            ))
          )}
        </div>
      </div>

      {isPickerOpen && (
        <div className="absolute inset-0 z-20 bg-warm-surface/95">
          <div className="flex items-center justify-between border-b border-warm-border bg-warm-surface px-4 py-3">
            <div className={`font-bold text-slate-900 dark:text-stone-100 ${editorTypeClassName.heading}`}>Add From Canvas</div>
            <RemotionButton
              onClick={() => setIsPickerOpen(false)}
              className={`font-semibold text-slate-500 hover:text-slate-700 dark:text-stone-400 dark:hover:text-stone-100 ${editorTypeClassName.control}`}
            >
              Close
            </RemotionButton>
          </div>
          <div className="p-4 space-y-2 overflow-auto h-[calc(100%-52px)]">
            {availableAssets.length === 0 ? (
              <div className={`py-8 text-center text-slate-400 ${editorTypeClassName.item}`}>
                No available assets
              </div>
            ) : (
              availableAssets.map((asset) => (
                <RemotionButton
                  key={asset.id}
                  onClick={() => handlePickAsset(asset)}
                  className="flex w-full items-center gap-3 rounded-md border border-warm-border bg-warm-surface p-2 text-left transition-colors hover:border-brand/40 hover:bg-brand-light/40"
                >
                  {asset.type === 'image' ? (
                    <img
                      src={asset.src}
                      alt={asset.name || 'Image'}
                      className="h-12 w-12 rounded-md border border-warm-border bg-warm-muted object-cover"
                    />
                  ) : asset.type === 'video' ? (
                    asset.thumbnail ? (
                      <img
                        src={asset.thumbnail}
                        alt={asset.name || 'Video'}
                        className="h-12 w-12 rounded-md border border-warm-border bg-warm-muted object-cover"
                      />
                    ) : (
                      <div
                        data-video-thumbnail-placeholder=""
                        className="flex h-12 w-12 items-center justify-center rounded-md border border-slate-800 bg-slate-900 text-white/70"
                        aria-hidden="true"
                      >
                        <svg viewBox="0 0 20 20" className="h-5 w-5" fill="currentColor">
                          <path d="m7.25 5.5 7 4.5-7 4.5v-9Z" />
                        </svg>
                      </div>
                    )
                  ) : (
                    <div className={`flex h-12 w-12 items-center justify-center rounded-md border border-warm-border bg-warm-muted font-bold text-slate-500 dark:text-stone-400 ${editorTypeClassName.caption}`}>
                      {asset.type.toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className={`truncate font-semibold text-slate-900 dark:text-stone-100 ${editorTypeClassName.item}`}>
                      {asset.name || 'Untitled'}
                    </div>
                    <div className={`capitalize text-slate-500 dark:text-stone-400 ${editorTypeClassName.caption}`}>{asset.type}</div>
                  </div>
                </RemotionButton>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
