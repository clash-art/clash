import type {
  ProjectCanvasPreview,
  ProjectCanvasThumbnail,
  ResolvedAsset,
} from "@clash/shared-types";

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
}

export interface ProjectWithAssets extends Project {
  assets: ResolvedAsset[];
}
