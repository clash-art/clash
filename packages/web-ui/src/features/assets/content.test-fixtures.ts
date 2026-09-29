import type {
  ProjectContentMatch,
  ProjectContentResult,
} from "@clash/shared-types";

export function mediaContentResult(
  projectAssetId: string,
  matches: ProjectContentMatch[],
): ProjectContentResult {
  return {
    items: [
      {
        ref: { kind: "media", projectAssetId },
        name: projectAssetId,
        kind: "video",
        info: {},
        matches,
      },
    ],
    truncated: false,
    countsByKind: { image: 0, video: 1, audio: 0, model: 0, document: 0 },
    matchMode: "literal-text",
  };
}
