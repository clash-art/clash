import { describe, expect, it } from "vitest";

import {
  normalizeCopilotAssetComposerValue,
  projectAssetMention,
} from "./projectAssetReferences";

describe("normalizeCopilotAssetComposerValue", () => {
  it("round-trips file labels containing brackets and backslashes", () => {
    const label = "Portrait [final] \\ take 2";
    const normalized = normalizeCopilotAssetComposerValue(
      projectAssetMention(label, "asset/portrait"),
      [{ id: "asset/portrait", type: "image", kind: "asset", label }],
    );
    expect(normalized.assets).toEqual([
      { projectAssetId: "asset/portrait", kind: "image", label },
    ]);
  });
  it("replaces imported media projections with storage-neutral Project Asset mentions", () => {
    const result = normalizeCopilotAssetComposerValue(
      [
        'Review ![Logo](https://host.test/api/v1/projects/p/assets/url-id/media "clash-project-asset:asset%2Fstable")',
        'and [🎬 B-roll](file:///private/cas/video.mp4 "clash-project-asset:asset-video")',
      ].join(" "),
      [],
    );

    expect(result).toEqual({
      text: "Review @[Logo](project-asset:asset%2Fstable) and @[B-roll](project-asset:asset-video)",
      assets: [
        {
          projectAssetId: "asset/stable",
          kind: "image",
          label: "Logo",
        },
        {
          projectAssetId: "asset-video",
          kind: "video",
          label: "B-roll",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /host\.test|file:|\/private\/cas/,
    );
  });

  it("keeps Canvas node mentions distinct while typing Project Asset mentions", () => {
    const result = normalizeCopilotAssetComposerValue(
      "Use @[Logo master](project-asset:asset-logo) with @[Render variants](node:action-1)",
      [
        {
          id: "asset-logo",
          type: "image",
          label: "Logo master",
          kind: "asset",
        },
        {
          id: "action-1",
          type: "action",
          label: "Render variants",
          kind: "node",
        },
      ],
    );

    expect(result).toEqual({
      text: "Use @[Logo master](project-asset:asset-logo) with @[Render variants](node:action-1)",
      assets: [
        {
          projectAssetId: "asset-logo",
          kind: "image",
          label: "Logo master",
        },
      ],
    });
  });

  it("restores thumbnail-backed mentions without preserving their Host URL", () => {
    const result = normalizeCopilotAssetComposerValue(
      "Compare ![mention:asset-logo:Logo master](http://127.0.0.1:17879/assets/logo/thumbnail) and ![mention:node-image:Canvas image](blob:canvas-image)",
      [
        {
          id: "asset-logo",
          type: "image",
          label: "Logo master",
          kind: "asset",
        },
        {
          id: "node-image",
          type: "image",
          label: "Canvas image",
          kind: "node",
        },
      ],
    );

    expect(result.text).toBe(
      "Compare @[Logo master](project-asset:asset-logo) and @[Canvas image](node:node-image)",
    );
    expect(result.assets).toEqual([
      {
        projectAssetId: "asset-logo",
        kind: "image",
        label: "Logo master",
      },
    ]);
    expect(result.text).not.toMatch(/127\.0\.0\.1|blob:/);
  });

  it("deduplicates repeated references by Project Asset identity", () => {
    const result = normalizeCopilotAssetComposerValue(
      "@[Logo](project-asset:asset-logo) then @[Logo](project-asset:asset-logo)",
      [
        {
          id: "asset-logo",
          type: "image",
          label: "Logo",
          kind: "asset",
        },
      ],
    );

    expect(result.assets).toHaveLength(1);
  });
});
