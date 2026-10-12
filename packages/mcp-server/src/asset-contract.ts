import type { AssetKind } from "@clash/shared-types";

export const ASSET_MCP_TOOL_NAMES = [
  "clash_assets_list",
  "clash_assets_get",
  "clash_assets_references",
  "clash_assets_import_file",
  "clash_assets_admit",
  "clash_assets_publish",
  "clash_assets_trash",
  "clash_assets_restore",
  "clash_assets_global_list",
  "clash_assets_global_get",
  "clash_assets_global_import_file",
  "clash_assets_global_trash",
  "clash_assets_global_restore",
] as const;

export type AssetMcpToolName = (typeof ASSET_MCP_TOOL_NAMES)[number];

export type AssetToolInput = {
  cwd?: string;
  projectId?: string;
  assetId?: string;
  projectAssetId?: string;
  globalAssetId?: string;
  filePath?: string;
  kind?: AssetKind;
  allowDuplicate?: boolean;
};
