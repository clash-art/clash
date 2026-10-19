import type {
  ProjectCanvasPreview,
  ProjectCanvasThumbnail,
  ResolvedAsset,
} from "@clash/shared-types";

export interface ProjectCardError {
  code: "PROJECT_UPGRADE_FAILED";
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
