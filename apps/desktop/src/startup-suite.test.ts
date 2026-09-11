import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  sourceContains,
  sourceMatches,
} from "../../../packages/gui/test-support/source-match.js";
import { describe, expect, it } from "vitest";

const desktopRoot = new URL("..", import.meta.url);
const desktopPath = desktopRoot.pathname;

function readText(relativePath: string) {
  return readFileSync(new URL(relativePath, desktopRoot), "utf8");
}

function readRootText(relativePath: string) {
  return readFileSync(new URL(`../../${relativePath}`, desktopRoot), "utf8");
}

describe("desktop startup test suite", () => {
  it("exposes startup scripts from the workspace root", () => {
    const rootPkg = JSON.parse(
      readFileSync(new URL("../../package.json", desktopRoot), "utf8"),
    ) as {
      scripts: Record<string, string>;
    };

    expect(rootPkg.scripts["test:startup"]).toBe(
      "turbo run build --filter=@clash/web --filter=@clash/desktop && pnpm test:startup:api && pnpm --filter @clash/desktop test:startup",
    );
    expect(rootPkg.scripts["test:agent:real-codex"]).toBe(
      "pnpm build:package @clash/desktop && pnpm --filter @clash/desktop test:agent:real-codex",
    );
    expect(rootPkg.scripts["test:startup:real-codex"]).toBe(
      "pnpm build:package @clash/desktop && pnpm --filter @clash/desktop test:startup:real-codex",
    );
    expect(rootPkg.scripts["test:startup:real-codex-resume"]).toBe(
      "pnpm build:package @clash/desktop && pnpm --filter @clash/desktop test:startup:real-codex-resume",
    );
    expect(rootPkg.scripts["test:startup:real-codex-cold"]).toBe(
      "pnpm build:package @clash/desktop && pnpm --filter @clash/desktop test:startup:real-codex-cold",
    );
    expect(rootPkg.scripts["test:e2e:qa-agent"]).toBe(
      "pnpm build:package @clash/desktop && pnpm --filter @clash/desktop test:e2e:qa-agent",
    );
    expect(rootPkg.scripts["test:e2e:agent-first-local-v1"]).toBe(
      "pnpm build:package @clash/desktop && pnpm --filter @clash/desktop test:e2e:agent-first-local-v1",
    );
    expect(rootPkg.scripts["test:e2e:agent-first-cas"]).toBe(
      "pnpm build:package @clash/desktop && pnpm --filter @clash/desktop test:e2e:agent-first-cas",
    );
    expect(rootPkg.scripts["build:package"]).toBe("turbo run build --filter");
  });

  it("exposes layered startup scripts", () => {
    const pkg = JSON.parse(readText("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts["test:startup"]).toBe(
      "pnpm test:startup:static && pnpm test:startup:ui",
    );
    expect(pkg.scripts["test:startup:static"]).toBe(
      "node scripts/prepare-clash-cli.ts && pnpm prepare:harnesses && tsx e2e/startup-static.ts",
    );
    expect(pkg.scripts["test:startup:api"]).toBeUndefined();
    expect(pkg.scripts["test:startup:ui"]).toContain("startup-ui-smoke.ts");
    expect(pkg.scripts["test:agent:real-codex"]).toContain(
      "real-codex-acp-backend.ts",
    );
    expect(pkg.scripts["test:startup:real-codex"]).not.toMatch(
      /pnpm --filter .* build/,
    );
    expect(pkg.scripts["test:startup:real-codex"]).toContain(
      "node scripts/prepare-clash-cli.ts",
    );
    expect(pkg.scripts["test:startup:real-codex"]).toContain(
      "pnpm prepare:harnesses",
    );
    expect(pkg.scripts["test:startup:real-codex"]).toContain(
      "real-codex-agent-browser.ts",
    );
    expect(pkg.scripts["test:startup:real-codex-resume"]).not.toMatch(
      /pnpm --filter .* build/,
    );
    expect(pkg.scripts["test:startup:real-codex-resume"]).toContain(
      "real-codex-resume-agent-browser.ts",
    );
    expect(pkg.scripts["test:startup:real-codex-cold"]).toContain(
      "real-codex-cold-start-agent-browser.ts",
    );
    expect(pkg.scripts["test:e2e:short-drama-timeline"]).toContain(
      "short-drama-timeline-smoke.ts",
    );
    expect(pkg.scripts["test:e2e:agent-first-cas"]).toContain(
      "agent-first-cas-smoke.ts",
    );
    expect(pkg.scripts["test:e2e:agent-first-local-v1"]).toContain(
      "agent-first-local-v1-gate.ts",
    );
    expect(pkg.scripts["test:e2e:qa-agent"]).toContain("qa-agent-codex.ts");
  });

  it("typechecks the desktop source graph without prebuilt workspace SDK artifacts", () => {
    const tsconfig = JSON.parse(readText("tsconfig.dev.json")) as {
      compilerOptions: { paths: Record<string, string[]> };
    };

    expect(tsconfig.compilerOptions.paths).toMatchObject({
      "@clash/action-sdk": ["../../packages/action-sdk/src/index.ts"],
      "@clash/action-sdk/*": ["../../packages/action-sdk/src/*.ts"],
      "@clash/asset-sdk": ["../../packages/asset-sdk/src/index.ts"],
    });
  });

  it("stages the root-built unified Clash runtime without nested workspace builds", () => {
    const source = readText("scripts/prepare-clash-cli.ts");

    expect(source).not.toContain("build:package");
    expect(source).not.toContain("pnpm deploy");
    expect(source).toContain('"--omit=dev"');
    expect(source).toContain("staging the prebuilt unified Clash runtime");
    expect(source).toContain('"clash-runtime"');
    expect(source).toContain("[prepare-clash-cli] failed");
  });

  it("lets Forge own the Desktop renderer lifecycle", () => {
    const pkg = JSON.parse(readText("package.json")) as {
      scripts: Record<string, string>;
    };
    const forgeConfig = readText("forge.config.ts");
    const rendererConfig = readText("vite.renderer.config.ts");
    const main = readText("src/main.ts");
    const hostController = readText("src/controller/host.ts");
    const runtimeController = readText("src/controller/runtime.ts");
    const windowsController = readText("src/controller/windows.ts");

    expect(pkg.scripts.dev).toBe("electron-forge start");
    expect(pkg.scripts.build).toContain("vite.main.config.ts");
    expect(pkg.scripts.build).toContain("vite.preload.config.ts");
    expect(runtimeController).toContain("MAIN_WINDOW_VITE_DEV_SERVER_URL");
    expect(hostController).toContain("app.setName(runtimeAppName)");
    expect(main).toContain("createDesktopRuntimeController");
    expect(main).toContain("createDesktopWindowController");
    expect(rendererConfig).toContain("../web/vite.config");
    expect(forgeConfig).toContain("CLASH_WEB_E2E_NO_CLOUDFLARE");
    expect(windowsController).toContain('join(moduleDir, "preload.cjs")');
  });

  it("keeps Director and Timeline rendering active while the desktop window is occluded", () => {
    const source = readText("src/controller/windows.ts");
    expect(source).toContain("backgroundThrottling: false");
  });

  it("leaves the detached shared daemon running when the desktop exits", () => {
    const source = readText("src/main.ts");
    const runtimeController = readText("src/controller/runtime.ts");

    expect(source).not.toContain('app.on("before-quit"');
    expect(runtimeController).not.toContain("startLocalApiServer");
    expect(runtimeController).not.toContain("closeLocalApiServer");
    expect(runtimeController).toContain("launchDetachedLocalDaemon");
    expect(runtimeController).toContain("electronRunAsNode: true");
  });

  it("offers native retry or quit when the Host cannot start", () => {
    const source = readText("src/main.ts");

    expect(source).toContain("startDesktopWithRecovery");
    expect(source).toContain("dialog.showMessageBox");
    expect(source).toContain('buttons: ["Retry", "Quit"]');
    expect(source).toContain('return response === 0 ? "retry" : "quit"');
    expect(
      sourceMatches(source, /app\s*\.whenReady\(\)[\s\S]*?\.catch\(/),
    ).toBe(true);
  });

  it("joins the shared local daemon or starts it once instead of creating a second writer", () => {
    const source = readText("src/controller/runtime.ts");
    const main = readText("src/main.ts");

    expect(source).toContain("createLocalDaemonBootstrap");
    expect(source).toContain("ensureDaemon()");
    expect(source).toContain('CLASH_DAEMON_STARTED_BY: "desktop"');
    expect(source).toContain("clashHomeForLocalDataDir(dataDir)");
    expect(source).toContain("diagnosticLogPath: hostDiagnosticLogPath");
    expect(main).toContain(
      'const hostDiagnosticLogPath = join(app.getPath("logs"), "host-startup.log")',
    );
  });

  it("runs TypeScript sources and enables Host watching in desktop development", () => {
    const paths = readText("src/paths.ts");
    const runtime = readText("src/controller/runtime.ts");
    const forge = readText("forge.config.ts");

    expect(paths).toContain('"../../../plugins/clash/src/local-api-entry.ts"');
    expect(paths).toContain('"../../../packages/cli/src/index.ts"');
    expect(paths).not.toContain(
      '"../../../plugins/clash/runtime/local-api.cjs"',
    );
    expect(paths).not.toContain(
      '"../../../plugins/clash/runtime/dispatcher.js"',
    );
    expect(runtime).toContain('require.resolve("tsx/cli")');
    expect(runtime).toContain("resolveDesktopSourceHostNodeArgs");
    expect(runtime).toContain("CLASH_DESKTOP_SOURCE_HOST_WATCH");
    expect(runtime).toContain("resolveClashDevTsconfigPath(moduleDir)");
    expect(forge).toContain(
      "process.env.CLASH_DESKTOP_SOURCE_HOST_WATCH ??=",
    );
  });

  it("injects the packaged Python SDK into local-model subprocess discovery", () => {
    const source = readText("src/controller/runtime.ts");

    expect(source).toContain("resolveClashSdkPythonPath");
    expect(source).toContain("prependPythonPath");
    expect(source).toMatch(/process\.env\.PYTHONPATH\s*=\s*prependPythonPath/);
  });

  it("exposes read-only NLE availability detection through the desktop bridge", () => {
    const main = readText("src/controller/windows.ts");
    const preload = readText("src/preload.ts");

    expect(main).toContain('ipcMain.handle("clash:get-nle-availability"');
    expect(main).toContain("detectNleAvailability()");
    expect(preload).toContain(
      'getNleAvailability: () => ipcRenderer.invoke("clash:get-nle-availability")',
    );
  });

  it("lets the renderer refresh a replaced local Host without restarting Desktop", () => {
    const main = readText("src/main.ts");
    const windows = readText("src/controller/windows.ts");
    const preload = readText("src/preload.ts");

    expect(main).toContain(
      "refreshRuntime: () => runtimeController.initialize(dataDir)",
    );
    expect(windows).toContain('ipcMain.handle("clash:refresh-runtime"');
    expect(preload).toContain(
      'refreshRuntime: () => ipcRenderer.invoke("clash:refresh-runtime")',
    );
  });

  it("provides Timeline rendering through the bundled Remotion generator without a renderer IPC", () => {
    const hostEntry = readRootText("plugins/clash/src/local-api-entry.ts");
    const remotionManifest = JSON.parse(
      readRootText("plugins/remotion/manifest.json"),
    ) as {
      contributes?: {
        functions?: Array<{ id: string; kind: string }>;
        generators?: Array<{ id: string; kind: string; path: string }>;
      };
    };
    const timelineContribution = remotionManifest.contributes?.generators?.find(
      ({ id, kind }) => id === "timeline" && kind === "generator",
    );
    expect(timelineContribution).toBeDefined();
    if (!timelineContribution) return;

    const timelineGenerator = JSON.parse(
      readRootText(`plugins/remotion/${timelineContribution.path}`),
    ) as {
      spec?: {
        actions?: Array<{ id: string; executorExportId: string }>;
        projectionSurface?: { primaryActionId: string };
      };
    };
    const primaryAction = timelineGenerator.spec?.actions?.find(
      ({ id }) =>
        id === timelineGenerator.spec?.projectionSurface?.primaryActionId,
    );
    const runtimeExport = remotionManifest.contributes?.functions?.find(
      ({ id, kind }) =>
        id === primaryAction?.executorExportId && kind === "action",
    );
    const remotionRuntime = readRootText("plugins/remotion/src/stdio.ts");
    const runtimeActionId = remotionRuntime.match(
      /export const REMOTION_RENDER_ACTION_ID\s*=\s*["']([^"']+)["']/,
    )?.[1];
    const windows = readText("src/controller/windows.ts");
    const preload = readText("src/preload.ts");

    expect(primaryAction).toBeDefined();
    expect(runtimeExport).toBeDefined();
    expect(runtimeActionId).toBe(runtimeExport?.id);
    expect(
      sourceContains(
        remotionRuntime,
        "[REMOTION_RENDER_ACTION_ID]: defineAction({",
      ),
    ).toBe(true);
    expect(
      sourceContains(hostEntry, "createHeadlessDirectorStageRenderer"),
    ).toBe(true);
    expect(sourceContains(hostEntry, "directorStageRenderer,")).toBe(true);
    expect(sourceContains(hostEntry, "createRemotionTimelineRenderer")).toBe(
      false,
    );
    expect(sourceContains(hostEntry, "timelineRenderer,")).toBe(false);
    expect(
      sourceContains(windows, 'ipcMain.handle("clash:export-timeline-video"'),
    ).toBe(false);
    expect(sourceContains(preload, "exportTimelineVideo")).toBe(false);
  });

  it("exports a recorded Director camera video through the desktop bridge", () => {
    const main = readText("src/controller/windows.ts");
    const preload = readText("src/preload.ts");

    expect(main).toContain('ipcMain.handle("clash:export-director-video"');
    expect(main).toContain("safeDirectorVideoExportName");
    expect(main).toContain(
      'filters: [{ name: "WebM video", extensions: ["webm"] }]',
    );
    expect(preload).toContain(
      'exportDirectorVideo: (request: unknown) => ipcRenderer.invoke("clash:export-director-video", request)',
    );
  });

  it("selects a Node runtime with the capabilities required by the renderer", () => {
    const rootPkg = JSON.parse(readRootText("package.json")) as {
      engines?: { node?: string };
    };

    expect(readRootText(".nvmrc").trim()).toBe("24.18.0");
    expect(rootPkg.engines?.node).toBe(">=24.18.0 <25");
  });

  it("keeps startup levels as checked-in runnable scripts", () => {
    for (const relativePath of [
      "e2e/startup-static.ts",
      "e2e/startup-ui-smoke.ts",
      "e2e/real-codex-acp-backend.ts",
      "e2e/real-codex-agent-browser.ts",
      "e2e/agent-first-local-v1-gate.ts",
      "e2e/short-drama-timeline-smoke.ts",
      "e2e/agent-first-cas-smoke.ts",
      "e2e/qa-agent-codex.ts",
      "e2e/qa-agent-report.schema.json",
    ]) {
      expect(statSync(join(desktopPath, relativePath)).isFile()).toBe(true);
    }
  });

  it("runs black-box QA through Codex CLI with a structured artifact contract", () => {
    const source = readText("e2e/qa-agent-codex.ts");
    const casSmokeSource = readText("e2e/agent-first-cas-smoke.ts");
    const schema = JSON.parse(readText("e2e/qa-agent-report.schema.json")) as {
      required: string[];
      properties: {
        cas: unknown;
        workspaceCli: unknown;
        paths: {
          required: string[];
          properties: Record<string, unknown>;
        };
      };
    };

    expect(source).toContain('"codex"');
    expect(source).toContain('"exec"');
    expect(source).toContain("--output-schema");
    expect(source).toContain("--output-last-message");
    expect(source).toContain("--cd");
    expect(source).toContain("artifactRoot");
    expect(source).toContain("createdProjects");
    expect(source).toContain("createdSessions");
    expect(source).toContain("createdTimelines");
    expect(source).toContain("projectStatuses");
    expect(source).toContain("restoredProjects");
    expect(source).toContain("restoredSessions");
    expect(source).toContain("restoredTimelines");
    expect(source).toContain("test:e2e:short-drama-timeline");
    expect(source).toContain("test:e2e:agent-first-cas");
    expect(source).toContain("test:e2e:project-workspace-cli");
    expect(source).toContain("agentFirstCasReportPath");
    expect(source).toContain("projectWorkspaceCliReportPath");
    expect(source).toContain("validateCasEvidence");
    expect(source).toContain("validateWorkspaceCliEvidence");
    expect(source).toContain("[desktop-agent-browser] history");
    expect(source).toContain("[desktop-agent-browser] project status");
    expect(source).toContain("Do not invent or normalize session IDs");
    expect(source).toContain("validateStubRuntimeReport");
    expect(source).toContain("smoke.booleans");
    expect(source).toContain('if (report.status !== "pass")');
    expect(source).toContain("QA report status");
    expect(casSmokeSource).toContain("runDirectCanvasCliImplicitCas");
    expect(casSmokeSource).toContain("runCanvas([");
    expect(casSmokeSource).toContain("CLASH_AGENT_MEMBER_ID");
    expect(casSmokeSource).toContain(
      "direct canvas CLI fresh implicit observation accepted",
    );
    expect(casSmokeSource).toContain(
      "local-api receipt mutation envelope recorded",
    );
    expect(casSmokeSource).toContain(
      "direct canvas CLI mutation envelope recorded",
    );

    expect(schema.required).toContain("cas");
    expect(schema.required).toContain("workspaceCli");
    expect(schema.properties.cas).toBeTruthy();
    expect(schema.properties.workspaceCli).toBeTruthy();
    expect(JSON.stringify(schema.properties.cas)).toContain(
      "missingReadProofRejected",
    );
    expect(JSON.stringify(schema.properties.cas)).toContain(
      "staleReadProofRejected",
    );
    expect(JSON.stringify(schema.properties.cas)).toContain(
      "copyOnWritePreservedSource",
    );
    expect(JSON.stringify(schema.properties.cas)).toContain(
      "directCanvasCliWriteBeforeReadRejected",
    );
    expect(JSON.stringify(schema.properties.cas)).toContain(
      "directCanvasCliStaleObservationRejected",
    );
    expect(JSON.stringify(schema.properties.cas)).toContain(
      "directCanvasCliFreshObservationAccepted",
    );
    expect(JSON.stringify(schema.properties.cas)).toContain(
      "directCanvasCliMutationEnvelopeRecorded",
    );
    expect(JSON.stringify(schema.properties.cas)).toContain(
      "directCanvasCliDeleteReadRequired",
    );
    expect(JSON.stringify(schema.properties.cas)).toContain(
      "textProjectionNoLockSidecar",
    );
    expect(JSON.stringify(schema.properties.cas)).toContain(
      "timelineProjectionNoLockSidecar",
    );
    expect(JSON.stringify(schema.properties.cas)).toContain(
      "timelineEntityApplyAdvancesRevision",
    );
    expect(JSON.stringify(schema.properties.cas)).toContain(
      "textHistoryReadsHostRevisionIndex",
    );
    expect(JSON.stringify(schema.properties.cas)).toContain(
      "textContentRestoresHostRevisionBody",
    );
    expect(JSON.stringify(schema.properties.workspaceCli)).toContain(
      "canvasScopesStayIsolated",
    );
    expect(JSON.stringify(schema.properties.workspaceCli)).toContain(
      "nativeTimelineApplyUsesEntityCas",
    );
    expect(JSON.stringify(schema.properties.workspaceCli)).toContain(
      "daemonRestartRecoversProjectState",
    );
    expect(JSON.stringify(schema.properties.workspaceCli)).toContain(
      "canonicalSqliteStore",
    );

    expect(schema.properties.paths.required).toEqual(
      expect.arrayContaining([
        "repoRoot",
        "artifactRoot",
        "createdProjects",
        "createdSessions",
        "createdTimelines",
        "projectStatuses",
        "restoredProjects",
        "restoredSessions",
        "restoredTimelines",
      ]),
    );
    for (const key of [
      "createdProjects",
      "createdSessions",
      "createdTimelines",
      "projectStatuses",
      "restoredProjects",
      "restoredSessions",
      "restoredTimelines",
    ]) {
      expect(schema.properties.paths.properties[key]).toBeTruthy();
    }
    expect(JSON.stringify(schema)).toContain('"timeline"');
    expect(JSON.stringify(schema)).toContain('"runtimeRoot"');
  });

  it("runs the agent-first local v1 release gate over required black-box reports", () => {
    const source = readText("e2e/agent-first-local-v1-gate.ts");

    expect(source).toContain("short-drama-timeline-smoke.ts");
    expect(source).toContain("agent-first-cas-smoke.ts");
    expect(source).toContain("storage-doctor-repair-smoke.ts");
    expect(source).toContain("requiredChecks");
    expect(source).toContain("requiredBooleans");
    expect(source).toContain("directCanvasCliFreshObservationAccepted");
    expect(source).toContain(
      "textRestoreCreatesCopyOnWriteRevisionFromHostContent",
    );
    expect(source).toContain("timelineEntityApplyAdvancesRevision");
    expect(source).toContain("project-workspace-cli");
    expect(source).not.toContain("roomSyncConflictResolutionAuditRecorded");
    expect(source).toContain(
      "doctor before repair does not expose obsolete marker compatibility",
    );
    expect(source).not.toContain(
      "doctor repair removes old broad app-state file",
    );
    expect(source).toContain(
      "cloud-sync pending action gates block web and sharing until required mirrors are ready",
    );
    expect(source).toContain("CLASH_AGENT_FIRST_LOCAL_V1_SUITES");
    expect(source).toContain("agent-first-local-v1-gate-report.json");
  });

  it("keeps automatic CI focused on the desktop runtime", () => {
    const ciWorkflow = readRootText(".github/workflows/ci.yml");
    const releaseWorkflow = readRootText(".github/workflows/release.yml");

    expect(ciWorkflow).toContain("desktop-checks:");
    expect(sourceContains(ciWorkflow, "make lint")).toBe(true);
    expect(ciWorkflow).toContain("pnpm --filter @clash/desktop test");
    expect(ciWorkflow).not.toContain("pnpm lint --concurrency=1");
    expect(ciWorkflow).not.toContain("pnpm typecheck --concurrency=1");
    expect(ciWorkflow).not.toContain("pnpm test --concurrency=1");
    expect(ciWorkflow).not.toContain("pnpm build --concurrency=1");
    expect(ciWorkflow).not.toContain("package-desktop:");

    expect(releaseWorkflow).toContain("package-desktop:");
    expect(releaseWorkflow).toContain("publish-desktop-preview:");
    expect(releaseWorkflow).not.toContain("agent-first-local-v1");
    expect(releaseWorkflow).not.toContain("changesets/action");
    expect(
      existsSync(
        new URL("../../.github/workflows/build-render-image.yml", desktopRoot),
      ),
    ).toBe(false);
  });

  it("keeps real Codex transport diagnostics out of assistant text", async () => {
    const helpers = (await import(
      new URL("../e2e/real-codex-transcript.ts", import.meta.url).href
    )) as {
      assistantTextFromEvents: (events: unknown[]) => string;
      diagnosticTextFromEvents: (events: unknown[]) => string;
    };
    const events = [
      {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Falling back from WebSockets to HTTPS transport. request timed out",
        },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Final answer" },
      },
    ];

    expect(helpers.assistantTextFromEvents(events)).toBe("Final answer");
    expect(helpers.diagnosticTextFromEvents(events)).toContain(
      "Falling back from WebSockets",
    );
  });

  it("reads terminal output and final answers from current Codex ACP events", async () => {
    const helpers = (await import(
      new URL("../e2e/real-codex-transcript.ts", import.meta.url).href
    )) as {
      terminalOutputsFromEvents: (events: unknown[]) => string[];
      finalAnswerTextFromEvents: (events: unknown[]) => string;
    };
    const cwd = "/Users/test/.clash/projects/project-1";
    const events = [
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Checking." },
        _meta: { codex: { phase: "commentary" } },
      },
      {
        sessionUpdate: "tool_call_update",
        rawOutput: { formatted_output: `${cwd}\n`, exit_code: 0 },
        _meta: { terminal_output: { data: `${cwd}\n`, terminal_id: "exec-1" } },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: cwd.slice(0, 20) },
        _meta: { codex: { phase: "final_answer" } },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: cwd.slice(20) },
        _meta: { codex: { phase: "final_answer" } },
      },
    ];

    expect(helpers.terminalOutputsFromEvents(events)).toEqual([`${cwd}\n`]);
    expect(helpers.finalAnswerTextFromEvents(events)).toBe(cwd);
    expect(
      helpers.terminalOutputsFromEvents([{ rawOutput: "/legacy/cwd\n" }]),
    ).toEqual(["/legacy/cwd\n"]);
    expect(
      helpers.finalAnswerTextFromEvents([
        { type: "text", text: "/legacy/cwd" },
      ]),
    ).toBe("/legacy/cwd");
  });

  it("keeps the real Codex E2E out of stub mode", () => {
    const source = readText("e2e/real-codex-agent-browser.ts");

    expect(source).toContain("CLASH_E2E_REAL_CODEX");
    expect(source).not.toContain("CLASH_E2E_STUB_ACP");
    expect(source).not.toContain("CLASH_LOCAL_ACP_MOCK");
    expect(source).not.toContain("sk-stub");
    expect(source).not.toContain("fake-codex");
    expect(source).not.toContain("OPENAI_BASE_URL");
  });

  it("checks the real cold-start product contract before the first Codex turn", () => {
    const source = readText("e2e/real-codex-agent-browser.ts");
    const helperSource = readText("e2e/product-cold-start-contract.ts");
    const contractCall = source.indexOf("assertColdStartProductContract");
    const prompt = source.indexOf('const prompt = "Run pwd');

    expect(helperSource).toContain("session-harness-config-trigger");
    expect(helperSource).toContain("session-permission-mode-trigger");
    expect(helperSource).toContain('command.name === "plan"');
    expect(helperSource).toContain("session-plan-tag");
    expect(helperSource).toContain("Exit Plan mode");
    expect(helperSource).not.toContain("session-collaboration-mode-trigger");
    expect(helperSource).not.toContain("codex-acp");
    expect(helperSource).not.toMatch(/GPT-\d/);
    expect(helperSource).toContain("currentValue");
    expect(helperSource).toContain("resolveHarnessProductProfile");
    expect(source).toContain('harnessId: "codex-acp"');
    expect(source).not.toMatch(/GPT-\d/);
    expect(helperSource).toContain("/api/v1/sessions?projectId=");
    expect(contractCall).toBeGreaterThanOrEqual(0);
    expect(prompt).toBeGreaterThan(contractCall);
  });

  it("requires a trusted bundled Clash MCP turn and rejects global skill or shell CLI fallback", () => {
    const source = readText("e2e/real-codex-agent-browser.ts");

    expect(source).toContain("clash_canvas_list");
    expect(source).toContain('"clash.host_trusted_mcp"');
    expect(source).toContain('"clash.renderer"');
    expect(source).toContain("waitForPersistedClashMcpOutput");
    expect(source).toContain("Do not use a shell or the Clash CLI");
    expect(source).toContain("fell back to a global skill or shell CLI");
    expect(source).toContain("Cannot connect to Clash server");
    expect(source).toContain("const calls = new Map()");
    expect(source).toContain("calls.get(toolCallId)");
  });

  it("derives selections from live harness values and ignores removed cached choices", async () => {
    const { chooseAlternateRunPreferences, resolveHarnessProductProfile } =
      (await import(
        new URL("../e2e/product-cold-start-contract.ts", import.meta.url).href
      )) as {
        chooseAlternateRunPreferences: (profile: unknown) => {
          configValues: Record<string, string | boolean>;
          selections: { model: { name: string; value: string } };
        };
        resolveHarnessProductProfile: (
          snapshot: unknown,
          options: { runtimeId: string; harnessId: string },
        ) => {
          selections: { model: { name: string; value: string } };
          configOptions: unknown[];
        };
      };

    const profile = resolveHarnessProductProfile(
      {
        runtimes: [
          {
            id: "desktop-local",
            preferences: {
              config_by_agent: {
                "future-harness": {
                  model: "removed-model",
                },
              },
              mode_by_agent: {},
            },
            agents: [
              {
                id: "future-harness",
                config_options: [
                  {
                    id: "model",
                    type: "select",
                    category: "model",
                    currentValue: "future-model",
                    options: [
                      { value: "previous-model", name: "Previous Model" },
                      { value: "future-model", name: "Future Model" },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        runtimeId: "desktop-local",
        harnessId: "future-harness",
      },
    );

    expect(profile.selections.model).toEqual({
      value: "future-model",
      name: "Future Model",
    });
    expect(chooseAlternateRunPreferences(profile)).toMatchObject({
      configValues: { model: "previous-model" },
      selections: {
        model: {
          value: "previous-model",
          name: "Previous Model",
        },
      },
    });

    const restoredProfile = resolveHarnessProductProfile(
      {
        runtimes: [
          {
            id: "desktop-local",
            preferences: {
              config_by_agent: {
                "future-harness": {
                  model: "previous-model",
                },
              },
              mode_by_agent: {},
            },
            agents: [
              {
                id: "future-harness",
                config_options: [
                  {
                    id: "model",
                    type: "select",
                    category: "model",
                    currentValue: "future-model",
                    options: [
                      { value: "previous-model", name: "Previous Model" },
                      { value: "future-model", name: "Future Model" },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        runtimeId: "desktop-local",
        harnessId: "future-harness",
      },
    );
    expect(restoredProfile.selections.model).toEqual({
      value: "previous-model",
      name: "Previous Model",
    });
  });

  it("does not hide a Codex-first provider priority in the generic selectors or local host", () => {
    const pickerSource = readRootText(
      "packages/web-ui/src/components/copilot/SessionStartPicker.tsx",
    );
    const hostSource = readRootText(
      "apps/local-api/src/runtime/host/lib/session-manager.ts",
    );

    expect(pickerSource).toContain("preferredAgentId");
    expect(pickerSource).not.toContain('["codex-acp"');
    expect(hostSource).toContain(
      "const resolvedAgentId = p.agent_id ?? tpl!.agent_id",
    );
    expect(hostSource).toContain("await detect(resolvedAgentId");
    expect(hostSource).not.toContain('resolvedAgentId = "codex-acp"');
  });

  it("cold-restarts the product and restores only the latest recorded run choices", () => {
    const source = readText("e2e/real-codex-cold-start-agent-browser.ts");
    const helperSource = readText("e2e/product-cold-start-contract.ts");

    expect(source).toContain("assertRecentRunPreferencesProductContract");
    expect(source).toContain("chooseAlternateRunPreferences");
    expect(source).toContain('harnessId: "codex-acp"');
    expect(source).not.toMatch(/GPT-\d/);
    expect(source.match(/startElectron\(\{/g)).toHaveLength(2);
    expect(helperSource).not.toMatch(/GPT-\d/);
    expect(helperSource).toContain("expectedPreferences");
    expect(helperSource).toContain("sessionsBeforeRestart");
    expect(helperSource).toContain("sessionsAfterRestart");
  });

  it("keeps the real Codex backend ACP smoke out of stub mode", () => {
    const source = readText("e2e/real-codex-acp-backend.ts");

    expect(source).toContain("CLASH_E2E_REAL_CODEX");
    expect(source).toContain("AcpRuntimeImpl");
    expect(source).toContain("NodeSpawner");
    expect(source).toContain("clash-real-codex-home");
    expect(source).toContain("copyCodexAuthContext");
    expect(source).toContain("redactForTranscript");
    expect(source).toContain("looksLikeNetworkFailure");
    expect(source).toContain("assistantTextFromEvents");
    expect(source).toContain("diagnosticTextFromEvents");
    expect(source).not.toContain("CLASH_E2E_STUB_ACP");
    expect(source).not.toContain("CLASH_LOCAL_ACP_MOCK");
    expect(source).not.toContain("sk-stub");
    expect(source).not.toContain("fake-codex");
    expect(source).not.toContain("OPENAI_BASE_URL");
  });

  it("keeps stub UI smoke explicitly marked as stub ACP only", () => {
    const source = readText("e2e/agent-browser-smoke.ts");

    expect(source).toContain("CLASH_E2E_STUB_ACP");
    expect(source).not.toContain("CLASH_LOCAL_ACP_MOCK");
  });

  it("retries attachment to the existing Electron page instead of requiring CDP target creation", () => {
    const source = readText("e2e/agent-browser-smoke.ts");
    const agentBrowserSource = source.slice(
      source.indexOf("function agentBrowser"),
      source.indexOf("function parseEvalOutput"),
    );
    const cdpReadyIndex = source.indexOf(
      "`http://127.0.0.1:${cdpPort}/json/version`",
    );
    const homeReadyIndex = source.indexOf(
      'await waitForEval(`document.body.innerText.includes("Home")`',
      cdpReadyIndex,
    );

    expect(cdpReadyIndex).toBeGreaterThanOrEqual(0);
    expect(homeReadyIndex).toBeGreaterThan(cdpReadyIndex);
    expect(
      sourceContains(agentBrowserSource, '"--cdp", String(electronCdpPort)'),
    ).toBe(true);
    const attachment = source.slice(cdpReadyIndex, homeReadyIndex);
    expect(
      sourceContains(
        attachment,
        "await waitForCdpPageTarget(cdpPort, electronTargetRecovery.expectedUrlPrefix)",
      ),
    ).toBe(true);
    expect(
      sourceContains(
        attachment,
        "recoverAgentBrowserTarget(agentBrowser, electronTargetRecovery)",
      ),
    ).toBe(true);
    expect(
      sourceContains(attachment, 'agentBrowser(["connect", String(cdpPort)])'),
    ).toBe(false);
  });

  it("selects seeded assets by a quoted id attribute when product ids contain colons", () => {
    const source = readText("e2e/agent-browser-smoke.ts");

    expect(source).toContain("seededAssetSelector");
    expect(source).toContain("JSON.stringify(seededAssetElementId)");
    expect(source).not.toContain("#project-asset-${seededAsset.id}");
  });

  it("starts every desktop UI smoke with an isolated local-only Vite shell", () => {
    const source = readText("e2e/agent-browser-smoke.ts");
    const helperSource = readText("e2e/startup-shared.ts");

    expect(source).toContain("startVite({ webPort, logs: webLogs })");
    expect(source).not.toContain(
      'spawn("pnpm", ["--dir", webDir, "exec", "vite"',
    );
    expect(helperSource).toContain('CLASH_WEB_E2E_NO_CLOUDFLARE: "1"');
    expect(helperSource).toContain(
      "CLASH_WEB_E2E_PERSIST_STATE: persistStateDir",
    );
    expect(helperSource).toContain(
      "rm(persistStateDir, { recursive: true, force: true })",
    );
  });

  it("can freeze the web UI to a static build snapshot for long real-agent E2E runs", () => {
    const helperSource = readText("e2e/startup-shared.ts");

    expect(helperSource).toContain('process.env.CLASH_E2E_STATIC_WEB === "1"');
    expect(helperSource).toContain('useStaticPreview ? ["preview"] : []');
  });

  it("keeps a dedicated Electron GUI E2E for harness update and session restart", () => {
    const source = readText("e2e/harness-update-agent-browser.ts");

    expect(source).toContain('CLASH_E2E_STUB_HARNESS_UPDATE: "1"');
    expect(source).toContain('CLASH_E2E_STUB_ACP_DELAY_MS: "20000"');
    expect(source).toContain('"01-active-turn-update-control.png"');
    expect(source).toContain('"02-expanded-updates.png"');
    expect(source).toContain('"03-restart-after-turn.png"');
    expect(source).toContain('"04-restart-queued.png"');
    expect(source).toContain('"05-session-restarted-fading.png"');
    expect(source).toContain('"06-update-notice-self-destructed.png"');
    expect(source).toContain(
      'clickButtonByLabel(agentBrowser, "1 ACP update available")',
    );
    expect(source).toContain(
      'clickButtonByLabel(agentBrowser, "Update Mock ACP")',
    );
    expect(source).toContain(
      'clickButtonByLabel(agentBrowser, "Restart after this turn")',
    );
  });

  it("keeps a permanent narrow-window project chrome check", () => {
    const source = readText("e2e/agent-browser-smoke.ts");
    const helperSource = readText("e2e/startup-shared.ts");

    expect(source).toContain('agentBrowser(["set", "viewport", "720", "900"])');
    expect(source).toContain("narrowLayoutScreenshot");
    expect(source).toContain("sidebarWidth");
    expect(source).toContain("selectedTabWidth");
    expect(source).toContain("toolbarRailWidth");
    expect(source).toContain("Canvas tools");
    expect(source).toContain("toolbarRailWidth < 46");
    expect(source).toContain("toolbarRailWidth > 50");
    expect(source).toContain("horizontalOverflow");
    expect(source).toContain("narrowComposerScreenshot");
    expect(source).toContain("assertComposerToolbarLayout");
    expect(source).toContain("observeComposerToolbarLayout");
    expect(helperSource).toContain(
      "controls overlap or escape the input surface",
    );
    expect(helperSource).toContain("toolbarOverflow");
    expect(helperSource).toContain("laneOverlap");
  });

  it("accepts any configured Codex auth method declared by the runtime", () => {
    const source = readText("e2e/real-codex-agent-browser.ts");

    expect(source).toContain(
      "supportedAuthMethods.includes(configuredAuthMethod)",
    );
    expect(source).not.toContain(
      "must use the configured ChatGPT subscription",
    );
  });

  it("exercises /plan as a closable tag in the real narrow composer", () => {
    const source = readText("e2e/real-codex-agent-browser.ts");

    expect(source).toContain('const command = "/plan"');
    expect(source).toContain("active Plan tag after /plan");
    expect(source).toContain("narrow-plan-composer.png");
    expect(source).toContain("assertComposerToolbarLayout");
    expect(source).toContain(
      'clickButtonByLabel(agentBrowser, "Exit Plan mode")',
    );
  });

  it("submits the real Codex prompt with a scoped composer submit helper", () => {
    const source = readText("e2e/real-codex-agent-browser.ts");
    const helperSource = readText("e2e/startup-shared.ts");

    expect(source).toContain("clickComposerSubmitButton");
    expect(helperSource).toContain("button.clash-chat-input-primary");
    expect(source).not.toContain("clickComposerSend");
  });

  it("recovers the real Codex Electron target before post-turn session controls", () => {
    const source = readText("e2e/real-codex-agent-browser.ts");
    const finalCapture = source.indexOf(
      'agentBrowser(["screenshot", finalScreenshot])',
    );
    const recovery = source.indexOf(
      "recoverAgentBrowserTarget(agentBrowser",
      finalCapture,
    );
    const newSession = source.indexOf(
      'clickButtonByLabel(agentBrowser, "New session")',
      recovery,
    );

    expect(finalCapture).toBeGreaterThanOrEqual(0);
    expect(recovery).toBeGreaterThan(finalCapture);
    expect(newSession).toBeGreaterThan(recovery);
  });

  it("types the real Codex prompt through agent-browser keyboard input", () => {
    const helperSource = readText("e2e/startup-shared.ts");

    expect(helperSource).toContain('"keyboard", "type"');
    expect(helperSource).not.toContain('execCommand("insertText"');
  });

  it("types the stub UI smoke prompts through the shared keyboard helper", () => {
    const source = readText("e2e/agent-browser-smoke.ts");

    expect(source).toContain("typeComposer(agentBrowser, text)");
    expect(source).toContain("clickComposerSubmitButton(agentBrowser)");
    expect(source).not.toContain('execCommand("insertText"');
  });

  it("creates projects through the named project dialog in every desktop UI E2E", () => {
    const helperSource = readText("e2e/startup-shared.ts");
    const sources = [
      readText("e2e/agent-browser-smoke.ts"),
      readText("e2e/real-codex-agent-browser.ts"),
      readText("e2e/real-codex-resume-agent-browser.ts"),
    ];

    expect(helperSource).toContain("submitProjectCreateDialog");
    expect(helperSource).toContain("input[placeholder='Untitled project']");
    expect(helperSource).toContain('["keyboard", "type", projectName]');
    for (const source of sources) {
      expect(source).toContain("submitProjectCreateDialog(agentBrowser");
    }
  });

  it("requires a visibly open history menu in every desktop UI E2E", () => {
    const helperSource = readText("e2e/startup-shared.ts");
    const sources = [
      readText("e2e/agent-browser-smoke.ts"),
      readText("e2e/real-codex-agent-browser.ts"),
      readText("e2e/real-codex-resume-agent-browser.ts"),
    ];

    expect(helperSource).toContain("openSessionHistoryMenu");
    expect(helperSource).toContain("rect.width > 0 && rect.height > 0");
    for (const source of sources) {
      expect(source).toContain("openSessionHistoryMenu(agentBrowser)");
    }
  });

  it("recovers an Electron agent-browser session that falls back to about:blank", async () => {
    const { recoverAgentBrowserTarget } = (await import(
      new URL("../e2e/startup-shared.ts", import.meta.url).href
    )) as {
      recoverAgentBrowserTarget: (
        agentBrowser: (
          args: string[],
          options?: { allowFailure?: boolean },
        ) => string,
        options: {
          cdpPort: number;
          expectedUrlPrefix: string;
          maxAttempts?: number;
        },
      ) => string;
    };
    const calls: string[][] = [];
    let href = "about:blank";
    const agentBrowser = (args: string[]) => {
      calls.push(args);
      if (args[0] === "close") return "";
      if (args[0] === "connect") {
        href = "http://127.0.0.1:49870/projects/project-one";
        return "";
      }
      if (args[0] === "eval") return JSON.stringify(href);
      throw new Error(`Unexpected agent-browser command: ${args.join(" ")}`);
    };

    expect(
      recoverAgentBrowserTarget(agentBrowser, {
        cdpPort: 49970,
        expectedUrlPrefix: "http://127.0.0.1:49870/",
        maxAttempts: 2,
      }),
    ).toBe("http://127.0.0.1:49870/projects/project-one");
    expect(calls).toEqual([
      ["close"],
      ["connect", "49970"],
      ["eval", "location.href"],
    ]);
  });

  it("reattaches the stub Electron target after a session-creating submit", () => {
    const source = readText("e2e/agent-browser-smoke.ts");
    const sendPromptSource = source.slice(
      source.indexOf("async function sendPrompt"),
      source.indexOf("async function fetchJson"),
    );
    const submitIndex = sendPromptSource.indexOf(
      "clickComposerSubmitButton(agentBrowser)",
    );
    const recoverIndex = sendPromptSource.indexOf(
      "recoverAgentBrowserTarget(agentBrowser",
    );
    const assertionIndex = sendPromptSource.indexOf("await waitForEval(");

    expect(submitIndex).toBeGreaterThanOrEqual(0);
    expect(recoverIndex).toBeGreaterThan(submitIndex);
    expect(assertionIndex).toBeGreaterThan(recoverIndex);
  });

  it("reports exact stub session ids and persistence provenance", async () => {
    const { runtimeSessionPathObservation } = (await import(
      new URL("../e2e/startup-shared.ts", import.meta.url).href
    )) as {
      runtimeSessionPathObservation: (input: {
        session: {
          id: string;
          threadId?: string;
          title?: string;
          projectId?: string;
        };
        projectId: string;
        apiOrigin: string;
        dataDir: string;
        messageCount: number;
      }) => Record<string, unknown>;
    };

    expect(
      runtimeSessionPathObservation({
        session: {
          id: "session-row-one",
          threadId: "thread-one",
          title: "Storyboard pass",
          projectId: "project-one",
        },
        projectId: "project-one",
        apiOrigin: "http://127.0.0.1:49920",
        dataDir: "/tmp/clash-e2e-data",
        messageCount: 2,
      }),
    ).toEqual({
      id: "thread-one",
      projectId: "project-one",
      title: "Storyboard pass",
      messageCount: 2,
      apiPath:
        "http://127.0.0.1:49920/api/v1/local-sessions/thread-one/messages",
      storagePath: "/tmp/clash-e2e-data/local.sqlite",
      cwdPath: null,
    });
  });

  it("rejects placeholder session paths in stub Codex QA reports", async () => {
    const { validateStubRuntimeReport } = (await import(
      new URL("../e2e/qa-agent-report-validation.ts", import.meta.url).href
    )) as {
      validateStubRuntimeReport: (report: Record<string, unknown>) => void;
    };
    const validSession = (id: string, phase: "created" | "history") => ({
      kind: "session",
      phase,
      id,
      apiPath: `http://127.0.0.1:49920/api/v1/local-sessions/${id}/messages`,
      storagePath: "/tmp/clash-e2e-data/local.sqlite",
      cwdPath: null,
    });
    const baseReport = {
      paths: {
        createdSessions: [
          validSession("session-one", "created"),
          validSession("session-two", "created"),
        ],
        restoredSessions: [validSession("session-one", "history")],
        projectStatuses: [
          {
            runtimeRoot: "/tmp/clash-e2e-data/projects/project-one/runtime",
            protectedPaths: [
              "/tmp/clash-e2e-data/projects/project-one/runtime",
            ],
          },
        ],
      },
    };

    expect(() => validateStubRuntimeReport(baseReport)).not.toThrow();
    expect(() =>
      validateStubRuntimeReport({
        paths: {
          ...baseReport.paths,
          createdSessions: [
            validSession("stub-acp-session-1", "created"),
            validSession("stub-acp-session-2", "created"),
          ],
        },
      }),
    ).toThrow(/placeholder session id/i);
  });

  it("opens stub session history with the shared visible-menu helper", () => {
    const source = readText("e2e/agent-browser-smoke.ts");

    expect(source).toContain("openSessionHistoryMenu(agentBrowser)");
    expect(source).toContain('[role="menu"][aria-label="Session history"]');
    expect(source).toContain("clickHistoryMenuItemByText(firstPrompt)");
    expect(source).toContain("restored first session transcript");
    expect(source).not.toContain("document.querySelector(\"[role='dialog']\")");
  });

  it("waits for the real Codex turn to finish before creating a fresh session", () => {
    const source = readText("e2e/real-codex-agent-browser.ts");

    expect(source).toContain("Codex turn idle after final answer");
    expect(source.indexOf("Codex turn idle after final answer")).toBeLessThan(
      source.indexOf("Could not create a fresh session"),
    );
  });

  it("accepts the current project-root cwd in the real Codex E2E", () => {
    const source = readText("e2e/real-codex-agent-browser.ts");

    expect(source).toContain("/.clash/projects/");
    expect(source).not.toContain("/.clash/agent/");
    expect(source).toContain("reply exactly DONE");
    expect(source).not.toContain("answer with only the path");
  });

  it("verifies real Codex project cwd materializes the v1 editable roots", () => {
    const realSource = readText("e2e/real-codex-agent-browser.ts");
    const resumeSource = readText("e2e/real-codex-resume-agent-browser.ts");

    for (const source of [realSource, resumeSource]) {
      expect(source).toContain("assertProjectWorkspaceLayout");
      expect(source).toContain('"drafts"');
      expect(source).toContain('"projections/text"');
      expect(source).toContain('"projections/timelines"');
      expect(source).toContain('"assets/links"');
      expect(source).toContain('"sessions"');
      expect(source).toContain('"runtime"');
      expect(source).toContain("/api/v1/projects/");
      expect(source).toContain("/status");
      expect(source).toContain("runtimeRoot");
    }
  });
});
