import type {
  ProjectCanvasPreview,
  ProjectCanvasThumbnail,
  ResolvedAsset,
} from "@clash/shared-types";

export interface ProjectCardError {
  /** PROJECT_UPGRADE_FAILED for a failed upgrade; otherwise the failure's own code. */
  code: string;
  message: string;
  nodeId?: string;
}

export interface Project {
  syncTransport?: "streams";
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  createdAt: Date | string | number | null;
  updatedAt: Date | string | number | null;
  assets?: ResolvedAsset[];
  canvasPreview?: ProjectCanvasPreview | null;
  canvasThumbnail?: ProjectCanvasThumbnail | null;
  assetCount?: number;
  error?: ProjectCardError;
}

export interface ProjectWithAssets extends Project {
  assets: ResolvedAsset[];
}
