import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import piClashExtension, {
  type PiExtensionApi,
  type PiExtensionToolDefinition,
  projectStructuredContentForPi,
} from "./pi-clash-extension";

describe("Pi Clash extension", () => {
  it("projects verbose Clash contracts to the model-relevant schema", () => {
    expect(
      projectStructuredContentForPi({
        schemaVersion: 5,
        format: "clash.timeline.yaml",
        fieldCatalog: { root: { fields: { fps: { required: true } } } },
        operationCatalog: { redundantRuntimeMetadata: "x".repeat(10_000) },
        jsonSchema: { type: "object", required: ["tracks"] },
        features: { remotion: true },
      }),
    ).toEqual({
      schemaVersion: 5,
      format: "clash.timeline.yaml",
      fieldCatalog: { root: { fields: { fps: { required: true } } } },
      jsonSchema: { type: "object", required: ["tracks"] },
      features: { remotion: true },
    });
  });

  it("registers live Clash MCP tools and executes them over stdio", async () => {
    const sourceRoot = dirname(fileURLToPath(import.meta.url));
    const previousRuntime = process.env.CLASH_PI_MCP_RUNTIME_PATH;
    const previousPluginRoot = process.env.CLASH_PI_MCP_PLUGIN_ROOT;
    process.env.CLASH_PI_MCP_RUNTIME_PATH = join(
      sourceRoot,
      "pi-mcp-server.fixture.ts",
    );
    process.env.CLASH_PI_MCP_PLUGIN_ROOT = dirname(sourceRoot);

    const tools = new Map<string, PiExtensionToolDefinition>();
    let shutdown: (() => Promise<void> | void) | undefined;
    const pi: PiExtensionApi = {
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
      on(event, handler) {
        if (event === "session_shutdown") shutdown = handler;
      },
    };

    try {
      await piClashExtension(pi);
      expect([...tools.keys()]).toEqual([
        "clash",
        "clash_canvas",
        "clash_composition",
        "clash_workspace_init",
      ]);

      const result = await tools
        .get("clash_composition")!
        .execute(
          "pi-tool-call",
          { operation: "clash_timeline_create" },
          undefined,
        );
      expect(result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({
            tool: "clash_composition",
            arguments: { operation: "clash_timeline_create" },
          }),
        },
        {
          type: "text",
          text: `Structured result:\n${JSON.stringify({
            tool: "clash_composition",
            arguments: { operation: "clash_timeline_create" },
          })}`,
        },
      ]);
      expect(result.details).toMatchObject({
        structuredContent: {
          tool: "clash_composition",
          arguments: { operation: "clash_timeline_create" },
        },
      });
    } finally {
      await shutdown?.();
      if (previousRuntime === undefined) {
        delete process.env.CLASH_PI_MCP_RUNTIME_PATH;
      } else {
        process.env.CLASH_PI_MCP_RUNTIME_PATH = previousRuntime;
      }
      if (previousPluginRoot === undefined) {
        delete process.env.CLASH_PI_MCP_PLUGIN_ROOT;
      } else {
        process.env.CLASH_PI_MCP_PLUGIN_ROOT = previousPluginRoot;
      }
    }
  });

  it("launches the MCP runtime with the Node the runner names instead of its own executable", async () => {
    const sourceRoot = dirname(fileURLToPath(import.meta.url));
    const root = await mkdtemp(join(tmpdir(), "clash-pi-node-"));
    const marker = join(root, "launched");
    const node = join(root, "node");
    await writeFile(
      node,
      `#!/bin/sh\necho "$1" > ${JSON.stringify(marker)}\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
    );
    await chmod(node, 0o755);
    const environment = {
      CLASH_PI_MCP_RUNTIME_PATH: join(sourceRoot, "pi-mcp-server.fixture.ts"),
      CLASH_PI_MCP_PLUGIN_ROOT: dirname(sourceRoot),
      CLASH_PI_MCP_NODE_PATH: node,
    };
    const previous = Object.fromEntries(
      Object.keys(environment).map((name) => [name, process.env[name]]),
    );
    Object.assign(process.env, environment);
    let shutdown: (() => Promise<void> | void) | undefined;
    const names: string[] = [];
    try {
      await piClashExtension({
        registerTool: (tool) => void names.push(tool.name),
        on: (_event, handler) => void (shutdown = handler),
      });
      expect(names).toContain("clash");
      expect((await readFile(marker, "utf8")).trim()).toBe(
        environment.CLASH_PI_MCP_RUNTIME_PATH,
      );
    } finally {
      await shutdown?.();
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
