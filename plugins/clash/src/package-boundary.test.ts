import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { sourceMatches } from "../../../packages/gui/test-support/source-match.js";
import {
  BUNDLED_PLUGINS,
  bundledPluginPayloadFiles,
} from "../../../apps/local-api/src/bundled-plugins.js";

const pluginRoot = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function relativeFiles(root: URL, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(
        ...(await relativeFiles(new URL(`${entry.name}/`, root), relativePath)),
      );
    } else {
      files.push(relativePath);
    }
  }
  return files.sort();
}

test("plugin manifest starts one bundled MCP runtime and keeps product state in the shared local host", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../.codex-plugin/plugin.json", import.meta.url),
      "utf8",
    ),
  );
  const mcp = JSON.parse(
    await readFile(new URL("../.mcp.json", import.meta.url), "utf8"),
  );

  assert.equal(manifest.name, "clash");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(manifest.interface.capabilities.includes("Interactive"), false);
  assert.equal(
    manifest.interface.defaultPrompt.some((prompt: string) =>
      /\bopen\b/i.test(prompt),
    ),
    false,
  );
  assert.deepEqual(mcp.mcpServers.clash, {
    command: "node",
    args: ["./runtime/dispatcher.js", "mcp"],
    cwd: ".",
    env: { CLASH_PROFILE: "prod" },
  });
});

test("the public npm package is the single Clash distribution", async () => {
  const [packageJson, workspace, cliPackage, mcpPackage, localApiPackage] =
    await Promise.all([
      readFile(new URL("../package.json", import.meta.url), "utf8").then(
        JSON.parse,
      ),
      readFile(new URL("../../../package.json", import.meta.url), "utf8").then(
        JSON.parse,
      ),
      readFile(
        new URL("../../../packages/cli/package.json", import.meta.url),
        "utf8",
      ).then(JSON.parse),
      readFile(
        new URL("../../../packages/mcp-server/package.json", import.meta.url),
        "utf8",
      ).then(JSON.parse),
      readFile(
        new URL("../../../apps/local-api/package.json", import.meta.url),
        "utf8",
      ).then(JSON.parse),
    ]);

  assert.equal(packageJson.name, "clash");
  assert.deepEqual(packageJson.bin, { clash: "./runtime/dispatcher.js" });
  assert.deepEqual(packageJson.clashRuntime, {
    dispatcher: "./runtime/dispatcher.js",
    mcp: "./runtime/index.js",
    cli: "./runtime/clash-cli.cjs",
    localApi: "./runtime/local-api.cjs",
    agents: "./runtime/agents",
  });
  assert.equal(packageJson.publishConfig?.access, "public");
  assert.equal(workspace.name, "@clash/workspace");
  assert.equal(
    workspace.scripts?.dev,
    "turbo run dev --filter=@clash/web --filter=@clash/render-server",
  );
  assert.match(
    workspace.scripts?.["clash:dev"] ?? "",
    /tsx --tsconfig tsconfig\.dev\.json src\/dispatcher\.ts --profile dev$/,
  );
  assert.match(
    workspace.scripts?.["clash:prod"] ?? "",
    /plugins\/clash\/runtime\/dispatcher\.js --profile prod$/,
  );
  assert.match(
    workspace.scripts?.["mcp:dev"] ?? "",
    /tsx --tsconfig tsconfig\.dev\.json src\/dispatcher\.ts --profile dev mcp$/,
  );
  assert.equal(cliPackage.private, true);
  assert.equal(mcpPackage.private, true);
  assert.equal(localApiPackage.private, true);
  for (const internalName of [
    "@clash/cli",
    "@clash/mcp-server",
    "@clash/local-api",
  ]) {
    assert.equal(packageJson.dependencies?.[internalName], undefined);
    assert.equal(packageJson.devDependencies?.[internalName], "workspace:*");
  }
});

test("the real runtime smoke keeps workspace location independent from CLASH_HOME", async () => {
  const source = await readFile(
    new URL("./runtime-smoke.test.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /clash-plugin-workspace-/);
  assert.doesNotMatch(source, /join\(clashHome,\s*"workspace"\)/);
});

test("source CLI, MCP, and local Host share the Action SDK workspace entrypoints", async () => {
  const configUrls = [
    new URL("../tsconfig.dev.json", import.meta.url),
    new URL("../../../packages/cli/tsconfig.dev.json", import.meta.url),
    new URL("../../../apps/local-api/tsconfig.dev.json", import.meta.url),
  ];
  const expectedIndex = fileURLToPath(
    new URL("../../../packages/action-sdk/src/index.ts", import.meta.url),
  );
  const expectedBrowser = fileURLToPath(
    new URL("../../../packages/action-sdk/src/browser.ts", import.meta.url),
  );

  for (const configUrl of configUrls) {
    const configPath = fileURLToPath(configUrl);
    const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        assert.fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    });
    assert.ok(config, "development config must load with inherited source aliases");
    for (const [specifier, expected] of [
      ["@clash/action-sdk", expectedIndex],
      ["@clash/action-sdk/browser", expectedBrowser],
    ]) {
      const result = ts.resolveModuleName(specifier!, join(dirname(configPath), "src", "probe.ts"), config.options, ts.sys);
      assert.equal(result.resolvedModule?.resolvedFileName, expected);
    }
  }
});

test("the base skill's progressive-disclosure references are included and readable", async () => {
  const skillRoot = join(pluginRoot, "skills", "clash");
  const pending = [join(skillRoot, "SKILL.md")];
  const seen = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const markdown = await readFile(file, "utf8");
    for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1]!.split("#")[0]!;
      if (!target || /^[a-z]+:/i.test(target)) continue;
      const linked = resolve(dirname(file), target);
      assert.ok(linked.startsWith(skillRoot + "/"), "skill reference must travel with the packaged skill: " + target);
      await access(linked);
      if (linked.endsWith(".md")) pending.push(linked);
    }
  }
});

test("production skills pair creative judgment with the supported product path", async () => {
  const expectedSkills: Record<string, RegExp> = {
    "clash-director-production":
      /blocking|point of view|eyeline|screen direction/i,
    "clash-timeline-production": /rhythm|editorial|continuity|audio/i,
    "clash-mg-character": /silhouette|anticipation|arc|follow-through/i,
    "clash-video-finishing": /coherence|color|sound|typography/i,
  };

  for (const [skillName, creativeLanguage] of Object.entries(expectedSkills)) {
    const skillRoot = join(pluginRoot, "skills", skillName);
    const [markdown, metadata] = await Promise.all([
      readFile(join(skillRoot, "SKILL.md"), "utf8"),
      readFile(join(skillRoot, "agents", "openai.yaml"), "utf8"),
    ]);
    assert.match(markdown, new RegExp(`name: ${skillName}`));
    assert.match(
      markdown,
      creativeLanguage,
      `${skillName} needs domain craft guidance`,
    );
    assert.match(
      markdown,
      /base `clash` skill/i,
      `${skillName} should delegate mechanics to clash`,
    );
    assert.match(
      markdown,
      /ready\s+receipt[\s\S]*do not\s+(?:run\s+init|start\s+a\s+daemon)/i,
    );
    assert.doesNotMatch(
      markdown,
      /CLASH_BENCH|exact[- ]argv|\.clash\/project\.toml/i,
    );
    if (metadata) {
      assert.match(metadata, new RegExp(`\\$${skillName}`));
      assert.match(
        metadata,
        /story|dramatic|motion|coherent|creative|pacing|rhythm/i,
      );
    }
  }

  const mgSkill = await readFile(
    join(pluginRoot, "skills", "clash-mg-character", "SKILL.md"),
    "utf8",
  );
  assert.match(mgSkill, /default-exported, single-file Remotion TSX/i);
  assert.match(mgSkill, /clash canvas add --type remotion/);
  assert.match(mgSkill, /sourceNodeId/);
  assert.match(mgSkill, /clash timeline render --timeline/);
  assert.match(mgSkill, /clash_canvas_add/);
  assert.match(mgSkill, /clash_timeline_render/);
  assert.doesNotMatch(
    mgSkill,
    /render-mg|verify-mg-preview|export-mg|MgCompositionSpec|runtime:\s*html|rasterizer|spec\.json/i,
  );
});

test("every Clash MCP constructor uses the shared wire-compatibility server", async () => {
  for (const path of [
    "../../../packages/mcp-server/src/server.ts",
    "../../clash-timeline/src/server.ts",
    "../../clash-director/src/server.ts",
  ]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /new ClashMcpServer\(/, path);
    assert.doesNotMatch(source, /new McpServer\(/, path);
  }
});

test("bundled self-host entry derives discovery from the canonical Clash home", async () => {
  const source = await readFile(
    new URL("./local-api-entry.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /join\(clashHomeForLocalDataDir\(dataDir\), "run"\)/);
  assert.doesNotMatch(source, /join\(dataDir, "\.\.", "run"\)/);
});

test("bundled self-host agents do not recursively embed the Clash plugin", async () => {
  const runtime = JSON.parse(
    await readFile(
      new URL("../runtime/agents/clash/runtime.json", import.meta.url),
      "utf8",
    ),
  );

  assert.deepEqual(runtime.plugins, ["clash"]);
  await assert.rejects(
    access(
      new URL(
        "../runtime/agents/clash/plugins/clash/runtime/index.js",
        import.meta.url,
      ),
    ),
  );
});

test("plugin packaging consumes declared dependency outputs before creating the standalone bundle", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };
  const cliPackage = JSON.parse(
    await readFile(
      new URL("../../../packages/cli/package.json", import.meta.url),
      "utf8",
    ),
  ) as { scripts?: Record<string, string> };
  const localApiPackage = JSON.parse(
    await readFile(
      new URL("../../../apps/local-api/package.json", import.meta.url),
      "utf8",
    ),
  ) as { scripts?: Record<string, string> };
  const hostCore = await readFile(
    new URL("../scripts/build-host-runtime.ts", import.meta.url),
    "utf8",
  );
  const bundleAgents = await readFile(
    new URL("../scripts/bundle-agent-runtime.ts", import.meta.url),
    "utf8",
  );

  assert.match(packageJson.scripts?.build ?? "", /build:core.*bundle:agents/);
  assert.doesNotMatch(packageJson.scripts?.build ?? "", /--filter/);
  assert.match(cliPackage.scripts?.build ?? "", /\btsup\b/);
  assert.equal(localApiPackage.scripts?.["build:deps"], undefined);
  assert.match(localApiPackage.scripts?.build ?? "", /^tsc(?:\s|$)/);
  assert.equal(localApiPackage.scripts?.["build:with-deps"], undefined);
  assert.equal(packageJson.scripts?.["build:deps"], undefined);
  assert.doesNotMatch(hostCore, /sourceAgentsDir/);
  assert.match(hostCore, /rm\(resolve\(runtimeDir, "agents"\)/);
  assert.equal(
    sourceMatches(
      hostCore,
      /assertDependencyDistIsFresh\(.{0,700}\);\s*await mkdir\(runtimeDir/,
    ),
    true,
    "freshness must fail before the build mutates the tracked runtime tree",
  );
  assert.match(
    bundleAgents,
    /"packages",[\s\S]*"cli",[\s\S]*"assets",[\s\S]*"agents"/,
  );
  assert.doesNotMatch(bundleAgents, /recursivePluginDir/);
});

test("the packaged MCP entry has no unresolved workspace package imports", async () => {
  const runtime = await readFile(
    new URL("../runtime/index.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(runtime, /from\s+["']@clash\//);
});

test("the packaged host carries the exact current first-party plugin payloads", async () => {
  const packagedPluginsRoot = new URL(
    "../runtime/bundled-plugins/",
    import.meta.url,
  );
  assert.deepEqual(
    (await readdir(packagedPluginsRoot)).sort(),
    BUNDLED_PLUGINS.map((plugin) => plugin.workspaceDir).sort(),
    "packaged first-party plugin set differs from the Host catalog",
  );

  for (const { workspaceDir: directory } of BUNDLED_PLUGINS) {
    const sourceRoot = new URL(`../../${directory}/`, import.meta.url);
    const packagedRoot = new URL(
      `../runtime/bundled-plugins/${directory}/`,
      import.meta.url,
    );
    const declared = new Set(
      await bundledPluginPayloadFiles(
        JSON.parse(
          await readFile(new URL("manifest.json", sourceRoot), "utf8"),
        ),
        fileURLToPath(sourceRoot),
      ),
    );

    for (const path of declared) {
      assert.equal(
        sha256(await readFile(new URL(path, packagedRoot))),
        sha256(await readFile(new URL(path, sourceRoot))),
        `packaged ${directory}/${path} is stale`,
      );
    }
    assert.deepEqual(
      await relativeFiles(packagedRoot),
      [...declared].sort(),
      `packaged ${directory} contains undeclared or missing payload files`,
    );
  }
});

test("the packaged host carries Storyboard as an installable official payload outside the preload root", async () => {
  const sourceRoot = new URL("../../official/storyboard/", import.meta.url);
  const packagedRoot = new URL(
    "../runtime/official-plugins/storyboard/",
    import.meta.url,
  );
  await assert.doesNotReject(
    access(new URL("manifest.json", packagedRoot)),
    "packaged official Storyboard manifest is missing",
  );

  const declared = new Set(
    await bundledPluginPayloadFiles(
      JSON.parse(await readFile(new URL("manifest.json", sourceRoot), "utf8")),
      fileURLToPath(sourceRoot),
    ),
  );
  for (const path of declared) {
    assert.equal(
      sha256(await readFile(new URL(path, packagedRoot))),
      sha256(await readFile(new URL(path, sourceRoot))),
      `packaged official storyboard/${path} is stale`,
    );
  }
  assert.deepEqual(
    await relativeFiles(packagedRoot),
    [...declared].sort(),
    "packaged official Storyboard contains undeclared or missing payload files",
  );
});

test("the MCP host client uses the shared canonical Clash home helper, not the local-api server entry", async () => {
  const source = await readFile(
    new URL("./plugin-host.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /from "@clash\/shared-runtime\/local-paths"/);
  assert.match(source, /from "@clash\/shared-runtime\/local-daemon"/);
  assert.doesNotMatch(source, /from "@clash\/local-api"/);
});

test("the bundled host is a persistent user daemon rather than an MCP-owned child", async () => {
  const [entry, bootstrap, sharedBootstrap, localApiServer] = await Promise.all(
    [
      readFile(new URL("./local-api-entry.ts", import.meta.url), "utf8"),
      readFile(new URL("./plugin-host.ts", import.meta.url), "utf8"),
      readFile(
        new URL(
          "../../../packages/shared-runtime/src/local-daemon.ts",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL("../../../apps/local-api/src/server.ts", import.meta.url),
        "utf8",
      ),
    ],
  );

  assert.match(entry, /launchMode:\s*"user-service"/);
  assert.match(entry, /CLASH_DAEMON_STARTED_BY/);
  assert.match(entry, /startedBy,/);
  assert.doesNotMatch(entry, /CLASH_PLUGIN_OWNER_CLIENT_ID is required/);
  assert.match(bootstrap, /launchDetachedLocalDaemon/);
  assert.match(sharedBootstrap, /detached:\s*true/);
  assert.match(sharedBootstrap, /child\.unref\(\)/);
  assert.match(sharedBootstrap, /CLASH_LOCAL_API_WRAPPER_ENTRY/);
  assert.match(localApiServer, /!process\.env\.CLASH_LOCAL_API_WRAPPER_ENTRY/);
  assert.doesNotMatch(
    localApiServer,
    /!process\.env\.CLASH_PLUGIN_OWNER_CLIENT_ID/,
  );
});

test("the persistent daemon captures bounded structured logs before starting the host", async () => {
  const entry = await readFile(
    new URL("./local-api-entry.ts", import.meta.url),
    "utf8",
  );

  assert.equal(
    sourceMatches(
      entry,
      /createBoundedJsonlLogSink\(\{[\s\S]*?directory:\s*join\([\s\S]*?"logs"[\s\S]*?"local-api"[\s\S]*?filePrefix:\s*"local-api"[\s\S]*?\}\)/,
    ),
    true,
  );
  assert.equal(
    sourceMatches(
      entry,
      /installProcessStdioCapture\(\{[\s\S]*?component:\s*"local-api"[\s\S]*?sink:[\s\S]*?\}\)/,
    ),
    true,
  );
  assert.match(entry, /observability\.event\("info",\s*"process\.started"/);
  assert.match(entry, /observability\.event\("info",\s*"server\.ready"/);
  assert.match(entry, /observability\.event\("error",\s*"process\.failed"/);
  assert.match(entry, /observability\.close\(\)/);
});

test("the persistent daemon loads Remotion only through its bundled Action plugin", async () => {
  const [
    entry,
    hostBuild,
    developmentBrowserAssets,
    packageJson,
    rootPackageJson,
    remotionManifest,
  ] = await Promise.all([
    readFile(new URL("./local-api-entry.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../scripts/build-host-runtime.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("./development-browser-assets.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../package.json", import.meta.url), "utf8").then(
      JSON.parse,
    ),
    readFile(new URL("../../../package.json", import.meta.url), "utf8").then(
      JSON.parse,
    ),
    readFile(
      new URL("../../remotion/manifest.json", import.meta.url),
      "utf8",
    ).then(JSON.parse),
  ]);

  assert.equal(remotionManifest.id, "clash.remotion");
  assert.deepEqual(remotionManifest.runtime.resources, ["dist/browser-bundle"]);
  assert.doesNotMatch(entry, /createRemotionTimelineRenderer/);
  assert.doesNotMatch(entry, /timelineRenderer,/);
  assert.doesNotMatch(entry, /CLASH_REMOTION_BUNDLE_PATH|remotion-bundle/);
  assert.doesNotMatch(
    entry,
    /RENDER_SERVER_(?:PORT|URL)|child_process|spawn\(/,
  );
  assert.match(hostBuild, /bundledPluginPayloadFiles/);
  assert.doesNotMatch(
    hostBuild,
    /apps\/render-server\/\.remotion-bundle|const remotionBundleDir|removeSourceMapReferences/,
  );
  assert.doesNotMatch(
    developmentBrowserAssets,
    /resolveRemotionServeUrl|REMOTION_SOURCE_PACKAGES|@remotion\/bundler/,
  );
  assert.match(hostBuild, /external:\s*\[[^\]]*"@remotion\/renderer"[^\]]*\]/);
  assert.equal(packageJson.devDependencies?.["@remotion/bundler"], undefined);
  await assert.rejects(
    access(new URL("../runtime/remotion-bundle", import.meta.url)),
    { code: "ENOENT" },
  );
  assert.equal(
    packageJson.dependencies?.["@remotion/renderer"],
    rootPackageJson.pnpm?.overrides?.["@remotion/*"],
  );
});

test("the bundled Clash CLI and stdio MCP are peer clients of the same daemon bootstrap", async () => {
  const [cliEntry, cliProgram, hostRunner] = await Promise.all([
    readFile(
      new URL("../../../packages/cli/src/plugin.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../packages/cli/src/program.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("./host-runner.ts", import.meta.url), "utf8"),
  ]);

  assert.match(cliEntry, /ensureCliLocalDaemon/);
  assert.match(cliEntry, /runCli/);
  assert.match(cliProgram, /parseAsync/);
  assert.match(cliProgram, /registerProviderCommands/);
  assert.match(hostRunner, /ensureHost/);
  assert.match(hostRunner, /createProjectHostClient/);
  assert.match(hostRunner, /resolveConnection/);
  assert.match(hostRunner, /endpoint:\s*host\.endpoint/);
  assert.doesNotMatch(hostRunner, /@clash\/cli|child_process|spawn\(/);
});

test("the packaged MCP entry completes an initialize handshake in plain Node", async () => {
  const dispatcher = new URL("../runtime/dispatcher.js", import.meta.url);
  const child = spawn(process.execPath, [dispatcher.pathname, "mcp"], {
    cwd: new URL("../", import.meta.url),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "clash-package-boundary-test", version: "1" },
      },
    })}\n`,
  );

  try {
    const response = await new Promise<Record<string, unknown>>(
      (resolveResponse, rejectResponse) => {
        const timeout = setTimeout(() => {
          rejectResponse(
            new Error(
              `Timed out waiting for MCP initialize response.\n${stderr}`,
            ),
          );
        }, 10_000);
        const inspect = () => {
          const line = stdout.split("\n").find((candidate) => candidate.trim());
          if (!line) return;
          clearTimeout(timeout);
          try {
            resolveResponse(JSON.parse(line) as Record<string, unknown>);
          } catch (error) {
            rejectResponse(error);
          }
        };
        child.stdout.on("data", inspect);
        child.once("exit", (code) => {
          clearTimeout(timeout);
          rejectResponse(
            new Error(
              `MCP runtime exited with ${code} before initialize.\n${stderr}`,
            ),
          );
        });
        inspect();
      },
    );
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.id, 1);
    assert.ok(response.result && typeof response.result === "object");
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    assert.equal(
      (
        response.result as {
          serverInfo?: { name?: string; version?: string };
        }
      ).serverInfo?.version,
      packageJson.version,
    );
  } finally {
    child.kill("SIGTERM");
  }
});

test("the retired Claude-only plugin is not a second packaged skill source", async () => {
  const workspace = await readFile(
    new URL("../../../pnpm-workspace.yaml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(workspace, /packages\/claude-code-plugin/);
  await assert.rejects(
    access(
      new URL(
        "../../../packages/claude-code-plugin/package.json",
        import.meta.url,
      ),
    ),
  );
});
