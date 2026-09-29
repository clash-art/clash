import {
  AssetKindSchema,
  CopilotProjectAssetReferenceSchema,
  type CopilotProjectAssetReference,
} from "@clash/shared-types";

export interface CopilotAssetMentionCandidate {
  id: string;
  type: string;
  label: string;
  kind?: string;
}

export interface NormalizedCopilotAssetComposerValue {
  text: string;
  assets: CopilotProjectAssetReference[];
}

const PROJECT_ASSET_MARKER_PREFIX = "clash-project-asset:";

export function projectAssetComposerMarker(projectAssetId: string): string {
  return `${PROJECT_ASSET_MARKER_PREFIX}${encodeURIComponent(projectAssetId)}`;
}

function projectAssetIdFromMarker(value: string): string | null {
  try {
    return decodeURIComponent(value).trim() || null;
  } catch {
    return null;
  }
}

export function projectAssetMention(
  label: string,
  projectAssetId: string,
): string {
  const escaped = label.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
  return `@[${escaped}](project-asset:${encodeURIComponent(projectAssetId)})`;
}

/**
 * Converts the rich composer transport into the persistent Copilot contract.
 * Rich thumbnails may use Host URLs while editing; this boundary discards them
 * and emits only Project Asset identities plus ordinary Canvas node mentions.
 */
export function normalizeCopilotAssetComposerValue(
  markdown: string,
  candidates: readonly CopilotAssetMentionCandidate[],
): NormalizedCopilotAssetComposerValue {
  const byId = new Map(
    candidates.map((candidate) => [candidate.id, candidate]),
  );
  const assets: CopilotProjectAssetReference[] = [];
  const byProjectAssetId = new Map<string, CopilotProjectAssetReference>();

  const add = (
    projectAssetId: string,
    kind: string,
    label: string,
  ): CopilotProjectAssetReference => {
    const existing = byProjectAssetId.get(projectAssetId);
    if (existing) return existing;
    const reference = CopilotProjectAssetReferenceSchema.parse({
      projectAssetId,
      kind: AssetKindSchema.parse(kind),
      label: label.trim() || projectAssetId,
    });
    byProjectAssetId.set(projectAssetId, reference);
    assets.push(reference);
    return reference;
  };

  let text = markdown;
  text = text.replace(
    /!\[([^\]]*)\]\(([^)\s]+)\s+"clash-project-asset:([^"]+)"\)/g,
    (_match, label: string, _projection: string, encodedId: string) => {
      const projectAssetId = projectAssetIdFromMarker(encodedId);
      if (!projectAssetId) return "";
      add(projectAssetId, "image", label || "image");
      return projectAssetMention(label || "image", projectAssetId);
    },
  );
  text = text.replace(
    /\[(🎬|🔊)\s+([^\]]+)\]\(([^)\s]+)\s+"clash-project-asset:([^"]+)"\)/g,
    (
      _match,
      icon: string,
      label: string,
      _projection: string,
      encodedId: string,
    ) => {
      const projectAssetId = projectAssetIdFromMarker(encodedId);
      if (!projectAssetId) return "";
      add(projectAssetId, icon === "🎬" ? "video" : "audio", label);
      return projectAssetMention(label, projectAssetId);
    },
  );

  text = text.replace(
    /!\[mention:([^:]+):([^\]]*)\]\([^)]*\)/g,
    (_match, id: string, label: string) => {
      const candidate = byId.get(id);
      if (candidate?.kind === "asset") {
        add(id, candidate.type, label || candidate.label);
        return projectAssetMention(label || candidate.label, id);
      }
      return `@[${label || candidate?.label || id}](node:${id})`;
    },
  );

  for (const match of text.matchAll(
    /@\[((?:\\.|[^\]\\])*)\]\(project-asset:([^\s)]+)(?:\s+"[^"]*")?\)/g,
  )) {
    const projectAssetId = projectAssetIdFromMarker(match[2]);
    if (!projectAssetId || byProjectAssetId.has(projectAssetId)) continue;
    const candidate = byId.get(projectAssetId);
    if (candidate?.kind !== "asset") continue;
    add(
      projectAssetId,
      candidate.type,
      match[1].replace(/\\([\\\]])/g, "$1") || candidate.label,
    );
  }

  return { text: text.trim(), assets };
}
