import { describe, expect, it } from "vitest";

import {
  effectiveMcpToolName,
  extractTrustedAssetOperationEvidence,
  importedProjectAssetIdFromCliOutput,
  matchRequiredProductOperations,
} from "./product-operations";

describe("transport-neutral product operation evidence", () => {
  it("retains the Project Asset identity from successful MCP and CLI operations", () => {
    expect(
      extractTrustedAssetOperationEvidence({
        successfulMcpCalls: [
          {
            tool: "clash_assets_import_file",
            arguments: {
              filePath: "inputs/source.svg",
              projectAssetId: "asset-benchmark-a",
            },
            result: {
              structured_content: {
                id: "asset-benchmark-a",
                kind: "image",
                status: "ready",
              },
            },
          },
          {
            tool: "clash_assets",
            arguments: {
              operation: "get",
              arguments: { assetId: "asset-benchmark-a" },
            },
            result: {
              structuredContent: {
                id: "asset-benchmark-a",
                kind: "image",
                status: "ready",
              },
            },
          },
        ],
        successfulCliCalls: [
          {
            argv: [
              "assets",
              "delete",
              "--asset",
              "asset-benchmark-a",
              "--yes",
              "--json",
            ],
          },
          {
            argv: ["assets", "restore", "--asset=asset-benchmark-a", "--json"],
          },
        ],
      }),
    ).toEqual([
      {
        operation: "asset.import",
        transport: "mcp",
        invocation: "clash_assets_import_file",
        projectAssetId: "asset-benchmark-a",
        sourcePath: "inputs/source.svg",
      },
      {
        operation: "asset.get",
        transport: "mcp",
        invocation: "clash_assets_get",
        projectAssetId: "asset-benchmark-a",
      },
      {
        operation: "asset.trash",
        transport: "cli",
        invocation: "assets delete --asset asset-benchmark-a --yes --json",
        projectAssetId: "asset-benchmark-a",
      },
      {
        operation: "asset.restore",
        transport: "cli",
        invocation: "assets restore --asset=asset-benchmark-a --json",
        projectAssetId: "asset-benchmark-a",
      },
    ]);
  });

  it("fails closed when a result identity disagrees or an import names no identity at all", () => {
    expect(
      extractTrustedAssetOperationEvidence({
        successfulMcpCalls: [
          {
            tool: "clash_assets_trash",
            arguments: { assetId: "asset-a" },
            result: { structured_content: { id: "asset-b" } },
          },
        ],
        successfulCliCalls: [
          {
            argv: ["assets", "import", "--file", "inputs/source.svg", "--json"],
          },
          {
            argv: [
              "assets",
              "import",
              "--file",
              "inputs/source.svg",
              "--asset-id",
              "asset-a",
            ],
            importedProjectAssetId: "asset-b",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("takes a minted import identity from the product result on either transport", () => {
    expect(
      extractTrustedAssetOperationEvidence({
        successfulMcpCalls: [
          {
            tool: "clash_assets_import_file",
            arguments: { filePath: "inputs/source.svg" },
            result: { structuredContent: { id: "asset:minted-mcp" } },
          },
        ],
        successfulCliCalls: [
          {
            argv: ["assets", "import", "--file", "inputs/source.svg"],
            importedProjectAssetId: "asset:minted-cli",
          },
        ],
      }).map(({ transport, projectAssetId }) => ({
        transport,
        projectAssetId,
      })),
    ).toEqual([
      { transport: "mcp", projectAssetId: "asset:minted-mcp" },
      { transport: "cli", projectAssetId: "asset:minted-cli" },
    ]);
  });

  it("reads the imported identity from the CLI import output only", () => {
    const importArgv = ["assets", "import", "--file", "inputs/source.svg"];
    expect(
      importedProjectAssetIdFromCliOutput(
        [...importArgv, "--json"],
        `${JSON.stringify({ assetId: "asset:from-json", kind: "image" })}\n`,
      ),
    ).toBe("asset:from-json");
    expect(
      importedProjectAssetIdFromCliOutput(
        importArgv,
        "imported Project Asset asset:from-text, link assets/links/source.svg\n",
      ),
    ).toBe("asset:from-text");
    expect(
      importedProjectAssetIdFromCliOutput(
        ["asset", "import", "--file", "inputs/source.svg"],
        "imported Project Asset asset:from-alias\n",
      ),
    ).toBe("asset:from-alias");
    expect(
      importedProjectAssetIdFromCliOutput(
        ["assets", "get", "--asset", "asset-a", "--json"],
        JSON.stringify({ assetId: "asset-a" }),
      ),
    ).toBeUndefined();
    expect(
      importedProjectAssetIdFromCliOutput(importArgv, "nothing imported\n"),
    ).toBeUndefined();
  });

  it("orders evidence across transports by the runner-sealed start time", () => {
    expect(
      extractTrustedAssetOperationEvidence({
        successfulMcpCalls: [
          {
            tool: "clash_assets_get",
            arguments: { assetId: "asset-a" },
            startedAt: "2026-08-14T00:00:02.000Z",
          },
        ],
        successfulCliCalls: [
          {
            argv: ["assets", "restore", "--asset", "asset-a"],
            startedAt: "2026-08-14T00:00:03.000Z",
          },
          {
            argv: ["assets", "delete", "--asset", "asset-a", "--yes"],
            startedAt: "2026-08-14T00:00:01.000Z",
          },
        ],
      }).map(({ operation }) => operation),
    ).toEqual(["asset.trash", "asset.get", "asset.restore"]);
  });

  it("attributes root-dispatched MCP calls to the selected leaf operation", () => {
    expect(
      effectiveMcpToolName({
        tool: "clash",
        arguments: {
          command: "timeline",
          operation: "clash_timeline_render",
          arguments: { timelineId: "main" },
        },
      }),
    ).toBe("clash_timeline_render");
    expect(
      effectiveMcpToolName({
        tool: "clash",
        arguments: { command: "timeline" },
      }),
    ).toBe("clash");
    expect(
      effectiveMcpToolName({
        tool: "clash",
        arguments: { operation: "timeline.render" },
      }),
    ).toBe("clash");
    expect(
      effectiveMcpToolName({
        tool: "clash",
        arguments: { operation: "clash_timeline_render" },
      }),
    ).toBe("clash_timeline_render");
    expect(
      effectiveMcpToolName({
        tool: "clash_timeline",
        arguments: {
          operation: "clash_timeline_render",
          arguments: { timelineId: "main" },
        },
      }),
    ).toBe("clash_timeline_render");
    expect(
      effectiveMcpToolName({
        tool: "clash_timeline",
        arguments: { operation: "clash_director_capture" },
      }),
    ).toBe("clash_timeline");
  });

  it("attributes fixed Canvas and Composition dispatcher short names to live leaves", () => {
    expect(
      effectiveMcpToolName({
        tool: "clash_canvas",
        arguments: { operation: "get", arguments: { nodeId: "node-1" } },
      }),
    ).toBe("clash_canvas_get");
    expect(
      effectiveMcpToolName({
        tool: "clash_composition",
        arguments: {
          kind: "timeline",
          operation: "render",
          arguments: { timelineId: "main" },
        },
      }),
    ).toBe("clash_timeline_render");
    expect(
      effectiveMcpToolName({
        tool: "clash_composition",
        arguments: {
          kind: "director-stage",
          operation: "capture",
          arguments: { stageId: "main" },
        },
      }),
    ).toBe("clash_director_capture");
    expect(
      effectiveMcpToolName({
        tool: "clash_composition",
        arguments: { operation: "clash_timeline_render" },
      }),
    ).toBe("clash_timeline_render");
    expect(
      effectiveMcpToolName({
        tool: "clash_composition",
        arguments: { operation: "render" },
      }),
    ).toBe("clash_composition");
    expect(
      effectiveMcpToolName({
        tool: "clash_composition",
        arguments: {
          kind: "timeline",
          operation: "clash_director_capture",
        },
      }),
    ).toBe("clash_composition");
  });

  it("attributes the fixed Assets dispatcher only to Assets leaves", () => {
    expect(
      effectiveMcpToolName({
        tool: "clash_assets",
        arguments: {
          operation: "import_file",
          arguments: { path: "frame.png", kind: "image" },
        },
      }),
    ).toBe("clash_assets_import_file");
    expect(
      effectiveMcpToolName({
        tool: "clash_assets",
        arguments: {
          operation: "clash_assets_restore",
          arguments: { assetId: "asset-1" },
        },
      }),
    ).toBe("clash_assets_restore");
    expect(
      effectiveMcpToolName({
        tool: "clash_assets",
        arguments: { operation: "clash_timeline_render" },
      }),
    ).toBe("clash_assets");
    expect(
      effectiveMcpToolName({
        tool: "clash_timeline",
        arguments: { operation: "clash_assets_get" },
      }),
    ).toBe("clash_timeline");
  });

  it("recognizes Project Asset operations over MCP and CLI peer transports", () => {
    expect(
      matchRequiredProductOperations({
        requiredProductOperations: [
          "asset.import",
          "asset.list",
          "asset.get",
          "asset.trash",
          "asset.restore",
        ],
        successfulMcpTools: [
          "clash_assets_import_file",
          "clash_assets_get",
          "clash_assets_restore",
        ],
        successfulCliArgv: [
          ["assets", "list", "--json"],
          ["assets", "delete", "--asset", "asset-1", "--yes", "--json"],
        ],
      }),
    ).toEqual({
      observedProductOperations: [
        {
          operation: "asset.import",
          transport: "mcp",
          invocation: "clash_assets_import_file",
        },
        {
          operation: "asset.list",
          transport: "cli",
          invocation: "assets list --json",
        },
        {
          operation: "asset.get",
          transport: "mcp",
          invocation: "clash_assets_get",
        },
        {
          operation: "asset.trash",
          transport: "cli",
          invocation: "assets delete --asset asset-1 --yes --json",
        },
        {
          operation: "asset.restore",
          transport: "mcp",
          invocation: "clash_assets_restore",
        },
      ],
      missingProductOperations: [],
    });
  });

  it("treats the CLI-advertised asset alias as the same trusted product surface", () => {
    const successfulCliArgv = [
      [
        "asset",
        "import",
        "--file",
        "inputs/source.svg",
        "--asset-id",
        "asset-1",
        "--json",
      ],
      ["asset", "list", "--json"],
      ["asset", "get", "--asset", "asset-1", "--json"],
    ];

    expect(
      matchRequiredProductOperations({
        requiredProductOperations: ["asset.import", "asset.list", "asset.get"],
        successfulMcpTools: [],
        successfulCliArgv,
      }),
    ).toMatchObject({
      missingProductOperations: [],
      observedProductOperations: [
        { operation: "asset.import", transport: "cli" },
        { operation: "asset.list", transport: "cli" },
        { operation: "asset.get", transport: "cli" },
      ],
    });
    expect(
      extractTrustedAssetOperationEvidence({
        successfulMcpCalls: [],
        successfulCliCalls: successfulCliArgv.map((argv) => ({ argv })),
      }),
    ).toContainEqual({
      operation: "asset.import",
      transport: "cli",
      invocation:
        "asset import --file inputs/source.svg --asset-id asset-1 --json",
      projectAssetId: "asset-1",
      sourcePath: "inputs/source.svg",
    });
  });

  it("accepts successful MCP and CLI invocations as peer transports", () => {
    expect(
      matchRequiredProductOperations({
        requiredProductOperations: ["canvas.add", "timeline.render"],
        successfulMcpTools: ["clash_canvas_add"],
        successfulCliArgv: [
          ["timeline", "render", "--timeline", "main", "--json"],
        ],
      }),
    ).toEqual({
      observedProductOperations: [
        {
          operation: "canvas.add",
          transport: "mcp",
          invocation: "clash_canvas_add",
        },
        {
          operation: "timeline.render",
          transport: "cli",
          invocation: "timeline render --timeline main --json",
        },
      ],
      missingProductOperations: [],
    });
  });

  it("records every transport that satisfies the same semantic operation", () => {
    expect(
      matchRequiredProductOperations({
        requiredProductOperations: ["timeline.render"],
        successfulMcpTools: ["clash_timeline_render"],
        successfulCliArgv: [["timeline", "render", "--timeline", "main"]],
      }).observedProductOperations,
    ).toEqual([
      {
        operation: "timeline.render",
        transport: "mcp",
        invocation: "clash_timeline_render",
      },
      {
        operation: "timeline.render",
        transport: "cli",
        invocation: "timeline render --timeline main",
      },
    ]);
  });

  it("does not report Timeline save when only creation was exercised", () => {
    expect(
      matchRequiredProductOperations({
        requiredProductOperations: ["timeline.create", "timeline.save"],
        successfulMcpTools: ["clash_timeline_create"],
        successfulCliArgv: [],
      }),
    ).toEqual({
      observedProductOperations: [
        {
          operation: "timeline.create",
          transport: "mcp",
          invocation: "clash_timeline_create",
        },
      ],
      missingProductOperations: ["timeline.save"],
    });
  });

  it("summarizes large CLI arguments in reports while retaining verifiable size and content identity", () => {
    expect(
      matchRequiredProductOperations({
        requiredProductOperations: ["canvas.update"],
        successfulMcpTools: [],
        successfulCliArgv: [
          [
            "canvas",
            "update",
            "--node",
            "node-1",
            "--content",
            "x".repeat(1024),
            "--json",
          ],
        ],
      }),
    ).toEqual({
      observedProductOperations: [
        {
          operation: "canvas.update",
          transport: "cli",
          invocation:
            "canvas update --node node-1 --content <arg:1024B sha256:49abd65bbf7f7e40c7055093ed2e3fd75f2f602f2c5fcf955c213e3135eb03f7> --json",
        },
      ],
      missingProductOperations: [],
    });
  });

  it("uses the canonical CLI pull/apply projections for get/save operations", () => {
    expect(
      matchRequiredProductOperations({
        requiredProductOperations: [
          "director.get",
          "director.mutate",
          "timeline.get",
          "timeline.save",
        ],
        successfulMcpTools: [],
        successfulCliArgv: [
          ["director", "pull", "--stage", "main", "--json"],
          ["director", "apply", "--stage", "main", "--json"],
          ["timeline", "pull", "--timeline", "main", "--json"],
          ["timeline", "apply", "--timeline", "main", "--json"],
        ],
      }).observedProductOperations,
    ).toEqual([
      expect.objectContaining({
        operation: "director.get",
        transport: "cli",
        invocation: "director pull --stage main --json",
      }),
      expect.objectContaining({
        operation: "director.mutate",
        transport: "cli",
        invocation: "director apply --stage main --json",
      }),
      expect.objectContaining({
        operation: "timeline.get",
        transport: "cli",
        invocation: "timeline pull --timeline main --json",
      }),
      expect.objectContaining({
        operation: "timeline.save",
        transport: "cli",
        invocation: "timeline apply --timeline main --json",
      }),
    ]);
  });

  it("treats whole-state and focused Director writes as the same mutate operation", () => {
    const mcp = matchRequiredProductOperations({
      requiredProductOperations: ["director.mutate"],
      successfulMcpTools: ["clash_director_camera_update"],
      successfulCliArgv: [],
    });
    const cli = matchRequiredProductOperations({
      requiredProductOperations: ["director.mutate"],
      successfulMcpTools: [],
      successfulCliArgv: [
        ["director", "keyframe", "upsert", "--stage", "main"],
      ],
    });

    expect(mcp).toEqual({
      observedProductOperations: [
        {
          operation: "director.mutate",
          transport: "mcp",
          invocation: "clash_director_camera_update",
        },
      ],
      missingProductOperations: [],
    });
    expect(cli).toEqual({
      observedProductOperations: [
        {
          operation: "director.mutate",
          transport: "cli",
          invocation: "director keyframe upsert --stage main",
        },
      ],
      missingProductOperations: [],
    });
  });

  it("does not count discovery, infrastructure init, help, or failed-call-shaped input", () => {
    expect(
      matchRequiredProductOperations({
        requiredProductOperations: ["timeline.create", "timeline.render"],
        successfulMcpTools: ["clash", "clash_workspace_init"],
        successfulCliArgv: [
          ["timeline", "render", "--help"],
          ["init", "--project", "old-project", "--json"],
        ],
      }),
    ).toEqual({
      observedProductOperations: [],
      missingProductOperations: ["timeline.create", "timeline.render"],
    });
  });

  it("fails closed for an operation outside the shared registry", () => {
    expect(() =>
      matchRequiredProductOperations({
        requiredProductOperations: ["timeline.lookalike"],
        successfulMcpTools: [],
        successfulCliArgv: [],
      }),
    ).toThrow(/Unknown Clash product operation/);
  });
});
