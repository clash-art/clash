import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeRuntimeDependencyIdentity } from "../../../scripts/runtime-dependency-identity.ts";

const execFileAsync = promisify(execFile);

async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  assert.fail("timed out waiting for plugin runtime cleanup");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isHealthy(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health", endpoint));
    const body = (await response.json()) as { ok?: unknown; mode?: unknown };
    return response.ok && body.ok === true && body.mode === "local";
  } catch {
    return false;
  }
}

test("bundled CLI and peer plugin MCP share one persistent Clash daemon", async () => {
  // CI can point at the unpacked, installed tarball, outside the checkout.
  const sourceRoot = process.env.CLASH_TEST_PACKAGE_ROOT
    ? resolve(process.env.CLASH_TEST_PACKAGE_ROOT)
    : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // Codex caches just the plugin directory. Parent npm node_modules must not
  // accidentally make an incomplete distributable pass this acceptance gate.
  const copiedPackage = process.env.CLASH_TEST_PACKAGE_ROOT
    ? await mkdtemp(join(tmpdir(), "clash-cached-plugin-")) : undefined;
  const pluginRoot = copiedPackage ? join(copiedPackage, "clash") : sourceRoot;
  if (copiedPackage) await cp(sourceRoot, pluginRoot, { recursive: true, dereference: true });
  const clashHome = await mkdtemp(join(tmpdir(), "clash-plugin-runtime-"));
  const workspace = await mkdtemp(join(tmpdir(), "clash-plugin-workspace-"));
  assert.equal(relative(clashHome, workspace).startsWith(".."), true);
  const env = {
    ...(Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) =>
          value !== undefined &&
          !key.startsWith("CLASH_") &&
          ![
            "NODE_OPTIONS",
            "NODE_PATH",
            "TSX_TSCONFIG_PATH",
            "CODEX_WORKSPACE_ROOT",
          ].includes(key),
      ),
    ) as Record<string, string>),
    CLASH_HOME: clashHome,
    CLASH_PROFILE: "prod",
    CLASH_LOCAL_DATA_DIR: join(clashHome, "local-api"),
  };
  let daemonPid: number | undefined;

  try {
    const firstCli = await execFileAsync(
      process.execPath,
      [join(pluginRoot, "runtime/dispatcher.js"), "projects", "list", "--json"],
      { cwd: workspace, env, timeout: 20_000 },
    );
    assert.doesNotThrow(() => JSON.parse(firstCli.stdout));
    const firstRecord = JSON.parse(
      await readFile(join(clashHome, "run", "host.json"), "utf8"),
    );
    daemonPid = firstRecord.pid;
    assert.equal(firstRecord.launchMode, "user-service");
    assert.equal(firstRecord.startedBy, "cli");
    assert.equal(firstRecord.profile, "prod");
    assert.equal(processExists(firstRecord.pid), true);
    assert.equal(await isHealthy(firstRecord.endpoint), true);
    const created = JSON.parse(
      (
        await execFileAsync(
          process.execPath,
          [
            join(pluginRoot, "runtime/dispatcher.js"),
            "projects",
            "create",
            "--name",
            "Installed agent project",
            "--json",
          ],
          {
            cwd: workspace,
            env: { ...env, CLASH_AGENT_MEMBER_ID: "acceptance-agent" },
            timeout: 20_000,
          },
        )
      ).stdout,
    ) as { id: string };
    assert.ok(
      created.id,
      "unbound agent creation must report its committed project identity",
    );

    const client = new Client({ name: "clash-runtime-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(pluginRoot, "runtime/dispatcher.js"), "mcp"],
      cwd: workspace,
      stderr: "pipe",
      env,
    });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      for (const name of [
        "clash",
        "clash_assets",
        "clash_canvas",
        "clash_composition",
        "clash_generators",
        "clash_plugin",
        "clash_project_open",
        "clash_workspace_init",
      ])
        assert.ok(
          tools.tools.some((tool) => tool.name === name),
          `missing ${name}`,
        );
      for (const name of [
        "clash_studio_open",
        "clash_canvas_open",
        "clash_canvas_snapshot",
        "clash_timeline_open",
        "clash_director_open",
      ])
        assert.equal(
          tools.tools.some((tool) => tool.name === name),
          false,
        );
      assert.equal(
        tools.tools.some((tool) => tool.name === "clash"),
        true,
      );
      assert.equal(
        tools.tools.some((tool) => tool.name === "clash_workspace_init"),
        true,
      );
      assert.equal(
        tools.tools.some((tool) => tool.name.startsWith("clash_cli_")),
        false,
      );
      const resources = await client.listResources();
      const projectApp = tools.tools.find(
        (tool) => tool.name === "clash_project_open",
      );
      const resourceUri = (projectApp?._meta?.ui as { resourceUri?: string })
        ?.resourceUri;
      assert.ok(resourceUri, "Project App must link its registered resource");
      assert.ok(
        resources.resources.some((resource) => resource.uri === resourceUri),
      );

      const initialized = await client.callTool({
        name: "clash_workspace_init",
        arguments: { cwd: workspace, projectId: created.id },
      });
      assert.notEqual(initialized.isError, true, JSON.stringify(initialized));
      assert.ok(
        (
          await readFile(join(workspace, ".clash", "project.toml"), "utf8")
        ).includes(`project_id = "${created.id}"`),
      );

      const selected = await client.callTool({
        name: "clash",
        arguments: { command: "canvas" },
      });
      assert.notEqual(selected.isError, true, JSON.stringify(selected));
      const listed = await client.callTool({
        name: "clash_canvas",
        arguments: {
          operation: "list",
          arguments: { cwd: workspace },
        },
      });
      assert.notEqual(listed.isError, true, JSON.stringify(listed));
      const timelineContracts = await client.callTool({
        name: "clash_composition",
        arguments: { kind: "timeline" },
      });
      assert.notEqual(
        timelineContracts.isError,
        true,
        JSON.stringify(timelineContracts),
      );
      for (const [name, contracts] of [
        ["clash_assets", ["content_list", "content_search", "content_read"]],
        ["clash_generators", ["actions_list", "action_invoke", "action_wait"]],
      ] as const) {
        const result = await client.callTool({
          name,
          arguments: { contracts },
        });
        assert.notEqual(result.isError, true, JSON.stringify(result));
      }
      const dispatcher = join(pluginRoot, "runtime/dispatcher.js");
      const builtinDraft = join(workspace, "builtin-checkout");
      await assert.rejects(execFileAsync(process.execPath,
        [dispatcher, "plugin", "checkout", "clash.asset-edit", builtinDraft, "--json"],
        { cwd: workspace, env, timeout: 20_000 },
      ), (error: unknown) => {
        const detail = error as Error & { stderr?: string };
        assert.match(detail.stderr ?? detail.message, /clash plugin create/);
        assert.doesNotMatch(detail.stderr ?? detail.message, /ENOENT/);
        return true;
      });
      const draft = JSON.parse((await execFileAsync(process.execPath,
        [dispatcher, "plugin", "create", join(workspace, "draft"), "--id", "project.smoke-action", "--json"],
        { cwd: workspace, env, timeout: 30_000 },
      )).stdout) as { created: boolean; manifest: string };
      assert.equal(draft.created, true, "installed CLI must support project custom Action authoring");
      // A real author follows the documented SDK API from an unrelated draft,
      // without repository node_modules or a separately published SDK package.
      await writeFile(join(workspace, "draft/src/stdio.ts"), `
        import { definePlugin } from '@clash/action-sdk';
        void definePlugin({ executors: { 'project.smoke-action': {
          async submit(invocation) { return { status: 'completed', outputs: [
            { slot: 'result', kind: 'value', value: { text: invocation.input.values.prompt } }
          ] }; }
        } } }).start();
      `);
      const validatedDraft = JSON.parse((await execFileAsync(process.execPath,
        [dispatcher, "plugin", "validate", join(workspace, "draft"), "--json"],
        { cwd: workspace, env, timeout: 20_000 },
      )).stdout);
      assert.equal(validatedDraft.valid, true, JSON.stringify(validatedDraft));
      assert.equal(JSON.parse(await readFile(draft.manifest, "utf8")).id, "project.smoke-action");
      // Initializing without a pre-created Host project must produce a usable
      // project, not an orphan marker that only Canvas operations recognize.
      const cliWorkspace = join(workspace, "cli-initialized");
      const mcpWorkspace = join(workspace, "mcp-initialized");
      await mkdir(cliWorkspace);
      const cliInitialized = JSON.parse((await execFileAsync(process.execPath,
        [dispatcher, "init", "--json"], { cwd: cliWorkspace, env, timeout: 20_000 },
      )).stdout) as { projectId: string };
      const mcpInitialized = await client.callTool({ name: "clash_workspace_init", arguments: { cwd: mcpWorkspace, projectId: "acceptance/project" } });
      assert.notEqual(mcpInitialized.isError, true, JSON.stringify(mcpInitialized));
      const mcpProjectId = (mcpInitialized.structuredContent as { projectId: string }).projectId;
      const projects = JSON.parse((await execFileAsync(process.execPath,
        [dispatcher, "projects", "list", "--json"], { cwd: workspace, env, timeout: 20_000 },
      )).stdout) as Array<{ id: string }>;
      for (const id of [cliInitialized.projectId, mcpProjectId])
        assert.ok(projects.some(project => project.id === id), `initialized project must be discoverable: ${id}`);
      await execFileAsync(process.execPath,
        [dispatcher, "plugin", "activate", join(workspace, "draft"), "--project", cliInitialized.projectId, "--json"],
        { cwd: cliWorkspace, env, timeout: 30_000 },
      );
      const relocatedDraft = join(workspace, "moved", "project", "draft");
      await cp(join(workspace, "draft"), relocatedDraft, { recursive: true });
      const reactivated = JSON.parse((await execFileAsync(process.execPath,
        [dispatcher, "plugin", "activate", relocatedDraft, "--project", cliInitialized.projectId, "--json"],
        { cwd: cliWorkspace, env, timeout: 30_000 },
      )).stdout);
      assert.equal(reactivated.activated, true, "moving an unchanged draft must not require a version bump");
      const mediaPath =
        process.env.CLASH_TEST_QUICKTIME_MP4 ?? join(workspace, "phone.MP4");
      if (!process.env.CLASH_TEST_QUICKTIME_MP4) {
        const installedRequire = createRequire(
          join(pluginRoot, "package.json"),
        );
        const ffmpeg = installedRequire("@ffmpeg-installer/ffmpeg") as {
          path: string;
        };
        await execFileAsync(ffmpeg.path, [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=blue:s=32x24:d=0.2",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-f",
          "mov",
          mediaPath,
        ]);
      }
      const imported = JSON.parse(
        (
          await execFileAsync(
            process.execPath,
            [dispatcher, "assets", "import", "--file", mediaPath, "--json"],
            { cwd: workspace, env, timeout: 30_000 },
          )
        ).stdout,
      ) as {
        assetId: string;
        linkPath: string;
        registration: { metadata: { contentType: string } };
      };
      assert.equal(
        imported.registration.metadata.contentType,
        "video/quicktime",
      );
      const digest = (bytes: Uint8Array) =>
        createHash("sha256").update(bytes).digest("hex");
      assert.equal(
        digest(await readFile(imported.linkPath)),
        digest(await readFile(mediaPath)),
        "installed CLI import and readback must preserve the original bytes",
      );
      const searched = await client.callTool({
        name: "clash_assets",
        arguments: { operation: "content_list", arguments: { kind: "video" } },
      });
      assert.notEqual(searched.isError, true, JSON.stringify(searched));
      assert.ok(
        JSON.stringify(searched.structuredContent).includes(imported.assetId),
        "MCP must discover the CLI-imported Asset in the same project",
      );
      await execFileAsync(
        process.execPath,
        [
          dispatcher,
          "timeline",
          "create",
          "--id",
          "smoke-cut",
          "--name",
          "Smoke cut",
          "--json",
        ],
        { cwd: workspace, env, timeout: 20_000 },
      );
      const listArgs = [dispatcher, "timeline", "list", "--json"];
      const compact = JSON.parse(
        (
          await execFileAsync(process.execPath, listArgs, {
            cwd: workspace,
            env,
            timeout: 20_000,
          })
        ).stdout,
      );
      assert.equal(compact[0]?.id, "smoke-cut");
      assert.equal(
        compact[0]?.state,
        undefined,
        "discovery must not expand clip bodies",
      );
      const full = JSON.parse(
        (
          await execFileAsync(process.execPath, [...listArgs, "--full"], {
            cwd: workspace,
            env,
            timeout: 20_000,
          })
        ).stdout,
      );
      assert.ok(
        full[0]?.state,
        "explicit full read must preserve Timeline state",
      );
      const runCli = async (...args: string[]) => JSON.parse((await execFileAsync(
        process.execPath, [dispatcher, ...args, "--json"], { cwd: workspace, env, timeout: 20_000 },
      )).stdout);
      const projection = await runCli("timeline", "pull", "--timeline", "smoke-cut");
      await writeFile(projection.filePath, JSON.stringify({
        compositionWidth: 1080, compositionHeight: 1920, fps: 30, durationInFrames: 1,
        tracks: [{ id: "main", items: [{ id: "shot", type: "video", assetId: imported.assetId, from: 0, durationInFrames: 1 }] }],
      }));
      await runCli("timeline", "apply", "--timeline", "smoke-cut");
      await runCli("timeline", "attach", "--timeline", "smoke-cut", "--canvas", "main", "--node", "smoke-editor");
      const placements = await runCli("canvas", "list") as Array<{ id: string; data: { assetId?: string } }>;
      const media = placements.find(node => node.data.assetId === imported.assetId);
      assert.ok(media, "attaching native Timeline must place its consumed media");
      const edges = await runCli("canvas", "edges") as Array<{ source: string; target: string }>;
      assert.ok(edges.some(edge => edge.source === media.id && edge.target === "smoke-editor"),
        "installed CLI must expose native media-to-Timeline references");
      const mcpList = await client.callTool({
        name: "clash_composition",
        arguments: { kind: "timeline", operation: "list", arguments: {} },
      });
      assert.notEqual(mcpList.isError, true, JSON.stringify(mcpList));
      const mcpItems = (
        mcpList.structuredContent as {
          items: Array<{ id: string; state?: unknown }>;
        }
      ).items;
      assert.equal(mcpItems[0]?.id, "smoke-cut");
      assert.equal(mcpItems[0]?.state, undefined);
      const record = JSON.parse(
        await readFile(join(clashHome, "run", "host.json"), "utf8"),
      );
      assert.equal(record.hostId, firstRecord.hostId);
      assert.equal(record.pid, firstRecord.pid);
      assert.equal(record.launchMode, "user-service");
      assert.equal(record.startedBy, "cli");
      assert.equal(record.profile, "prod");
      assert.match(record.agentCliPath, /agent-bin\/clash$/);

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      const stableRecord = JSON.parse(
        await readFile(join(clashHome, "run", "host.json"), "utf8"),
      );
      assert.equal(
        stableRecord.hostId,
        record.hostId,
        "plugin discovery must not be overwritten by a second bundled server",
      );
      assert.equal(stableRecord.launchMode, "user-service");
      assert.equal(stableRecord.startedBy, "cli");
    } finally {
      await client.close().catch(() => undefined);
    }

    const afterMcp = JSON.parse(
      await readFile(join(clashHome, "run", "host.json"), "utf8"),
    );
    assert.equal(afterMcp.hostId, firstRecord.hostId);
    assert.equal(afterMcp.pid, firstRecord.pid);
    assert.equal(processExists(afterMcp.pid), true);
    assert.equal(await isHealthy(afterMcp.endpoint), true);

    await execFileAsync(
      process.execPath,
      [join(pluginRoot, "runtime/dispatcher.js"), "host", "status", "--json"],
      { cwd: workspace, env, timeout: 20_000 },
    );
    const afterSecondCli = JSON.parse(
      await readFile(join(clashHome, "run", "host.json"), "utf8"),
    );
    assert.equal(afterSecondCli.hostId, firstRecord.hostId);
    assert.equal(afterSecondCli.pid, firstRecord.pid);
    if (copiedPackage) {
      // Simulate a dependency-only candidate update in the same installation.
      // Entry bytes stay identical; only the shipped dependency and its staged
      // content identity change, as in the observed Codex-cache upgrade failure.
      const hostEntry = join(pluginRoot, "runtime/local-api.cjs");
      const hostBytes = await readFile(hostEntry);
      const dependency = join(pluginRoot, "node_modules/esbuild/lib/main.js");
      await writeFile(dependency, (await readFile(dependency, "utf8")) + "\n// dependency-only upgrade acceptance\n");
      await writeRuntimeDependencyIdentity(join(pluginRoot, "node_modules"), join(pluginRoot, "runtime"));
      // A connected browser/partial request must not prevent the old Host
      // from relinquishing ownership during a real installed-package upgrade.
      const hostUrl = new URL(afterSecondCli.endpoint);
      const heldRequest = createConnection({ host: hostUrl.hostname, port: Number(hostUrl.port) });
      heldRequest.on("error", () => {});
      await new Promise<void>((resolve) => heldRequest.once("connect", () => {
        heldRequest.write("POST /api/v1/projects HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n", () => resolve());
      }));
      const syncUrl = new URL(`/sync/${created.id}`, hostUrl);
      syncUrl.protocol = "ws:";
      const heldSync = new WebSocket(syncUrl);
      await new Promise<void>((resolve, reject) => {
        heldSync.addEventListener("message", () => resolve(), { once: true });
        heldSync.addEventListener("error", () => reject(new Error("Project sync failed to connect")), { once: true });
      });
      let retainedProjects: Array<{ id: string }>;
      try {
        retainedProjects = JSON.parse((await execFileAsync(process.execPath,
          [join(pluginRoot, "runtime/dispatcher.js"), "projects", "list", "--json"],
          { cwd: workspace, env, timeout: 30_000 },
        )).stdout) as Array<{ id: string }>;
      } finally {
        heldRequest.destroy();
        heldSync.close();
      }
      const upgraded = JSON.parse(await readFile(join(clashHome, "run/host.json"), "utf8"));
      daemonPid = upgraded.pid;
      assert.notEqual(upgraded.pid, afterSecondCli.pid, "dependency-only upgrades must replace the cached Host");
      assert.notEqual(upgraded.runtimeFingerprint, afterSecondCli.runtimeFingerprint);
      assert.deepEqual(await readFile(hostEntry), hostBytes);
      await waitUntil(async () => !processExists(afterSecondCli.pid));
      assert.ok(retainedProjects.some(project => project.id === created.id));
      const retainedTimelines = JSON.parse((await execFileAsync(process.execPath,
        [join(pluginRoot, "runtime/dispatcher.js"), "timeline", "list", "--json"],
        { cwd: workspace, env, timeout: 20_000 },
      )).stdout) as Array<{ id: string }>;
      assert.ok(retainedTimelines.some(timeline => timeline.id === "smoke-cut"));
    }
  } finally {
    if (daemonPid && processExists(daemonPid))
      process.kill(daemonPid, "SIGTERM");
    await waitUntil(async () => !daemonPid || !processExists(daemonPid));
    await Promise.all([
      rm(clashHome, { recursive: true, force: true }),
      rm(workspace, { recursive: true, force: true }),
      ...(copiedPackage ? [rm(copiedPackage, { recursive: true, force: true })] : []),
    ]);
  }
});
